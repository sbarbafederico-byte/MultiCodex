// Quotas are usable only until their reset; an expired sample is never a new allowance.
function freshSample(account, now) {
  return account?.status === 'ok' && Number.isFinite(Date.parse(account.updatedAt)) &&
    now >= Date.parse(account.updatedAt) && now - Date.parse(account.updatedAt) < 120000;
}
export function freshLimits(account, now = Date.now()) {
  return freshSample(account, now) && ['fiveHour', 'weekly'].every(key => {
      const w = account.limits?.[key];
      return Number.isFinite(w?.remaining) && (!w.resetsAt || w.resetsAt * 1000 > now);
    });
}
export function exhausted(account, now = Date.now()) {
  return freshSample(account, now) && ['fiveHour', 'weekly'].some(key => {
    const w = account.limits?.[key];
    return Number.isFinite(w?.remaining) && w.remaining <= 0 && (!w.resetsAt || w.resetsAt * 1000 > now);
  });
}
export function selectNextAccount(accounts, activeKey, settings, now = Date.now()) {
  let ordered = [...accounts];
  if (settings.switchStrategy === 'custom') {
    const ids = [...settings.accountOrder, ...accounts.map(a => a.id).filter(id => !settings.accountOrder.includes(id))];
    ordered.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
  }
  if (['ordered', 'custom'].includes(settings.switchStrategy)) {
    const index = ordered.findIndex(a => a.key === activeKey);
    ordered = [...ordered.slice(index + 1), ...ordered.slice(0, index + 1)];
  }
  const candidates = ordered.filter(a => a.key !== activeKey && a.auth && freshLimits(a, now) && !exhausted(a, now));
  if (['fiveHour', 'weekly'].includes(settings.switchStrategy)) candidates.sort((a, b) => b.limits[settings.switchStrategy].remaining - a.limits[settings.switchStrategy].remaining);
  return candidates[0] || null;
}

export class Continuity {
  constructor(hub, readActivity) {
    this.hub = hub; this.readActivity = readActivity; this.running = false; this.lastCheck = 0;
    this.connections = new Set(); this.owned = new Map(); this.nextSelectionAt = 0;
  }
  status(status, message) { this.hub.continuityStatus = { status, message }; }
  async capture() {
    const activity = await this.readActivity();
    if (activity.error || !activity.updatedAt || Date.now() - Date.parse(activity.updatedAt) > 10000) throw new Error('Attività Codex non verificabile: cambio sospeso.');
    const tasks = new Map(activity.active.map(t => [t.threadId, t]));
    for (const t of this.owned.values()) tasks.set(t.threadId, t);
    const seen = new Set(tasks.keys());
    for (const t of activity.recent) {
      if (seen.has(t.threadId)) continue;
      seen.add(t.threadId);
      if (this.hub.vault.data.continuity?.tasks.some(saved => saved.originalTurnId === t.id && saved.state === 'submitted')) continue;
      if (['failed', 'interrupted'].includes(t.status) && t.limitReached && Date.now() - Date.parse(t.completedAt || t.startedAt) < 120000) tasks.set(t.threadId, t);
    }
    return [...tasks.values()].map(t => ({ threadId: t.threadId, originalTurnId: t.id, state: 'pending' }));
  }
  async prepare(tasks) {
    if (this.hub.vault.data.continuity?.tasks.some(t => ['pending', 'submitting', 'error'].includes(t.state))) throw new Error('Una ripresa precedente richiede verifica nella conversazione.');
    this.hub.vault.data.continuity = { tasks, createdAt: new Date().toISOString() };
    await this.hub.vault.save();
    await this.close();
    if (tasks.length) this.status('running', 'Cambio account e ripresa delle attività in corso…');
  }
  async resume() {
    const job = this.hub.vault.data.continuity;
    if (!job?.tasks.length) return;
    // Desktop shutdown may have raced with a final response. Do not continue finished work.
    try {
      const activity = await this.readActivity();
      if (activity.error || !activity.updatedAt || Date.now() - Date.parse(activity.updatedAt) > 10000) throw new Error();
      for (const task of job.tasks) if (task.state === 'pending' && activity.recent.some(t => t.id === task.originalTurnId && ['completed', 'cancelled'].includes(t.status))) task.state = 'skipped';
      await this.hub.vault.save();
    } catch {
      this.status('error', 'Account cambiato; verifica finale delle attività non disponibile. Continua dalle conversazioni in Codex.');
      return;
    }
    if (!job.tasks.some(t => t.state === 'pending')) return;
    const rpc = new this.hub.Rpc(this.hub.runtime.cliPath, this.hub.desktopHome);
    let starting = true;
    let interactionRequired = false;
    const completed = new Map();
    this.connections.add(rpc);
    rpc.on('disconnected', () => {
      this.connections.delete(rpc);
      for (const [id, task] of this.owned) if (task.owner === rpc) {
        this.owned.delete(id);
        this.status('error', 'Collegamento della ripresa interrotto. Controlla la conversazione in Codex.');
      }
    });
    rpc.on('serverRequest', () => {
      interactionRequired = true;
      this.status('error', 'La ripresa richiede un’interazione in Codex. Apri la conversazione per continuare.');
    });
    rpc.on('turn/completed', ({ threadId, turn }) => {
      completed.set(turn.id, /usageLimitExceeded|rateLimitExceeded/.test(JSON.stringify(turn.error || {})));
      if (!/usageLimitExceeded|rateLimitExceeded/.test(JSON.stringify(turn.error || {}))) this.owned.delete(threadId);
      if (turn.status === 'failed' && !/usageLimitExceeded|rateLimitExceeded/.test(JSON.stringify(turn.error || {}))) {
        interactionRequired = true;
        this.status('error', 'La continuazione si è fermata con un errore. Controlla la conversazione in Codex.');
      }
      if (!starting && !this.owned.size) { this.connections.delete(rpc); rpc.close().catch(() => {}); }
    });
    try {
      await rpc.initialize();
      for (const task of job.tasks) {
        if (task.state !== 'pending') continue;
        try {
          const result = await rpc.request('thread/resume', { threadId: task.threadId, excludeTurns: true });
          if (result.thread?.id !== task.threadId) throw new Error('Conversazione non confermata.');
          if (result.thread.status?.type === 'active') { task.state = 'submitted'; await this.hub.vault.save(); continue; }
          // Durable fence: a lost response must never replay a possibly accepted prompt.
          task.state = 'submitting'; await this.hub.vault.save();
          const started = await rpc.request('turn/start', { threadId: task.threadId, rootTurnId: task.originalTurnId, input: [{ type: 'text', text: 'Continua la task precedente dal punto in cui si è interrotta per il cambio account. Usa il contesto della conversazione e verifica il lavoro già svolto prima di riprendere. Mantieni le istruzioni e i vincoli già concordati.' }] });
          if (!started.turn?.id) throw new Error('Ripresa non confermata.');
          task.state = 'submitted'; task.resumedTurnId = started.turn.id;
          if (!completed.has(started.turn.id) || completed.get(started.turn.id)) this.owned.set(task.threadId, { threadId: task.threadId, id: started.turn.id, owner: rpc });
          await this.hub.vault.save();
        } catch {
          if (task.state === 'pending') task.state = 'error';
          await this.hub.vault.save();
          this.status('error', 'Account cambiato; una ripresa non è confermata. Controlla la conversazione in Codex prima di continuare.');
          return;
        }
      }
      if (!interactionRequired) this.status('success', 'Account cambiato e attività riprese nelle conversazioni originali.');
    } catch {
      this.status('error', 'Account cambiato, collegamento per la ripresa non disponibile. Continua dalla conversazione in Codex.');
    } finally {
      starting = false;
      if (!this.owned.size) { this.connections.delete(rpc); await rpc.close(); }
    }
  }
  async tick(now = Date.now()) {
    const hub = this.hub;
    if (this.running || hub.busy || hub.settings().switchMode !== 'automatic' || hub.login?.status === 'pending' || hub.switchJob?.status === 'running' || hub.vault.data.switchJournal || now - this.lastCheck < 10000) return;
    this.running = true; this.lastCheck = now;
    try {
      await hub.exclusive('Verifica continuità', async () => {
        const tasks = await this.capture();
        if (hub.settings().switchMode !== 'automatic') return;
        await hub.syncCurrent(false);
        const current = hub.vault.data.accounts.find(a => a.key === hub.activeKey);
        if (!current || (!tasks.length && !this.connections.size)) return;
        if (!current.lastAttemptAt || now - Date.parse(current.lastAttemptAt) >= hub.settings().activeIntervalSeconds * 1000) {
          await hub.refreshAccount(current, { forceProfile: false }); await hub.vault.save();
        }
        if (!exhausted(current)) return;
        if (now < this.nextSelectionAt) return;
        this.nextSelectionAt = now + 60000;
        for (const a of hub.vault.data.accounts) if (a !== current && a.status !== 'reauth' && now >= (a.retryAfterAt || 0)) await hub.refreshAccount(a, { forceProfile: false });
        await hub.vault.save();
        const next = selectNextAccount(hub.vault.data.accounts, hub.activeKey, hub.settings());
        if (!next) { this.status('waiting', 'Limite raggiunto: nessun altro account con disponibilità verificata.'); return; }
        // Capture again after remote reads, so work completed meanwhile is not replayed.
        const latest = await this.capture();
        if (!latest.length) return;
        if (hub.settings().switchMode !== 'automatic') return;
        try {
          const switched = await hub.performSwitch(next.id, { beforeStop: async () => {
            const finalTasks = await this.capture();
            if (!finalTasks.length) return false;
            await this.prepare(finalTasks);
          } });
          if (switched !== false) await this.resume();
        }
        catch (error) { hub.switchJob = { status: 'error', targetId: next.id, message: error.message }; this.status('error', 'Cambio automatico interrotto. Controlla lo stato del cambio account.'); }
      });
    } catch (error) { this.status('error', error.message); }
    finally { this.running = false; }
  }
  async close() { this.owned.clear(); await Promise.all([...this.connections].map(rpc => rpc.close())); this.connections.clear(); }
}
