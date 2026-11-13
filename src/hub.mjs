import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { CodexRpc } from './rpc.mjs';
import { identityFromAuth, normalizeLimits, classifyError } from './model.mjs';
import { discover, windows } from './windows.mjs';
import { atomicWrite } from './vault.mjs';
import { DEFAULT_SETTINGS, validateSettings, accountDue, Presence } from './settings.mjs';
import { readAccountProfile } from './profile.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export class Hub {
  constructor(vault, options = {}) {
    this.vault = vault;
    this.desktopHome = options.desktopHome || path.join(os.homedir(), '.codex');
    this.authPath = path.join(this.desktopHome, 'auth.json');
    this.queue = Promise.resolve();
    this.busy = null;
    this.login = null;
    this.switchJob = null;
    this.notice = null;
    this.runtime = null;
    this.activeKey = null;
    this.startupWarning = null;
    this.windows = options.windows || windows;
    this.discover = options.discover || discover;
    this.Rpc = options.Rpc || CodexRpc;
    this.sleep = options.sleep || sleep;
    this.readinessAttempts = options.readinessAttempts || 25;
    this.readinessTimeoutMs = options.readinessTimeoutMs || 90000;
    this.requireIndependentHost = options.requireIndependentHost || false;
    this.independentHost = options.independentHost || false;
    this.presence = new Presence();
    this.profileReader = options.profileReader || readAccountProfile;
    this.autoInFlight = false;
  }
  exclusive(label, action) {
    const operation = this.queue.then(async () => {
      this.busy = label;
      try { return await action(); } finally { this.busy = null; }
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
  async init() {
    await this.vault.load();
    this.vault.data.settings = validateSettings({ ...DEFAULT_SETTINGS, ...this.vault.data.settings });
    await this.recoverWork();
    this.runtime = await this.discover();
    if (!this.runtime.cliPath) throw new Error('Motore Codex non trovato. Apri Codex e riavvia MultiCodex.');
    await this.syncCurrent(true);
    await this.reconcileInterruptedClose();
    if (this.vault.data.switchJournal) {
      const journal = this.vault.data.switchJournal;
      this.startupWarning = 'Il precedente cambio è stato interrotto. Controlla l’account attivo in Codex; il salvataggio di recupero è disponibile.';
      // Never guess that the target was activated after an interrupted transaction.
      this.switchJob = { status: 'interrupted', message: this.startupWarning, targetId: journal.targetId };
    }
  }
  async reconcileInterruptedClose() {
    const journal = this.vault.data.switchJournal;
    if (!journal?.previousAuth || !this.runtime?.appRunning || this.runtime.agentReady === false || this.runtime.windowReady === false) return false;
    let previousKey;
    try { previousKey = identityFromAuth(journal.previousAuth).key; } catch { return false; }
    if (this.activeKey !== previousKey) return false;
    const tasks = this.vault.data.continuity?.tasks;
    if (tasks?.length && tasks.every(t => t.state === 'pending') && this.continuity) {
      try {
        const activity = await this.continuity.readActivity();
        // Nothing was submitted. Discard the old checkpoint only if a fresh
        // read confirms those chats are already running or finished normally.
        if (!activity.error && Date.now() - Date.parse(activity.updatedAt) < 10000 && tasks.every(t =>
          activity.active.some(a => a.threadId === t.threadId) ||
          activity.recent.some(a => a.id === t.originalTurnId && ['completed', 'cancelled'].includes(a.status)))) {
          delete this.vault.data.continuity;
        }
      } catch { /* Keep an unverified checkpoint for manual recovery. */ }
    }
    delete this.vault.data.switchJournal;
    await this.vault.save();
    this.notice = 'Recupero verificato: Codex è aperto con l’account precedente. Puoi riprovare il cambio.';
    return true;
  }
  async recoverWork() {
    const root = path.join(this.vault.root, 'work');
    for (const item of await fs.readdir(root, { withFileTypes: true })) {
      if (!item.isDirectory() || !item.name.startsWith('session-')) continue;
      const home = path.join(root, item.name);
      try {
        const owner = JSON.parse(await fs.readFile(path.join(home, 'owner.json'), 'utf8'));
        const account = this.vault.data.accounts.find(a => a.key === owner.key);
        if (owner.managed && account) {
          const auth = JSON.parse(await fs.readFile(path.join(home, 'auth.json'), 'utf8'));
          if (identityFromAuth(auth).key !== account.key) throw new Error('Account di recupero diverso.');
          // Rotation after a crash is recovered before any new requests are made.
          account.auth = auth;
          await this.vault.save();
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw new Error('Recupero della sessione interrotta non riuscito. I file temporanei sono stati conservati.');
      }
      await this.vault.removeWork(home);
    }
  }
  async currentAuth() {
    try { return JSON.parse(await fs.readFile(this.authPath, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw new Error('Autenticazione Codex non leggibile.'); }
  }
  upsert(auth, identity, { label, personalEmail, browserId } = {}) {
    let account = this.vault.data.accounts.find(a => a.key === identity.key);
    if (!account) {
      account = { id: randomUUID(), label: '', personalEmail: '', createdAt: new Date().toISOString() };
      this.vault.data.accounts.push(account);
    }
    Object.assign(account, identity, { auth, connected: true });
    if (label !== undefined) account.label = label;
    if (personalEmail !== undefined) account.personalEmail = personalEmail;
    if (browserId) account.browserId = browserId;
    return account;
  }
  async syncCurrent(importNew = false) {
    const auth = await this.currentAuth();
    if (!auth?.tokens?.access_token) { this.activeKey = null; return null; }
    let identity;
    try { identity = identityFromAuth(auth); }
    catch { this.activeKey = null; return null; }
    this.activeKey = identity.key;
    const saved = this.vault.data.accounts.find(a => a.key === identity.key);
    if (saved || importNew) {
      const changed = !saved || JSON.stringify(saved.auth) !== JSON.stringify(auth);
      const account = this.upsert(auth, identity);
      if (changed && account.status === 'reauth') { account.status = 'connected'; account.error = null; }
      if (changed) await this.vault.save();
      return account;
    }
    return null;
  }
  snapshot() {
    return {
      version: '0.5.7', busy: this.busy, notice: this.notice,
      settings: this.settings(), automaticRefreshActive: this.settings().refreshMode === 'automatic' && this.presence.visible(),
      login: this.publicLogin(), switchJob: this.switchJob,
      startupWarning: this.startupWarning,
      continuity: this.continuityStatus || (this.vault.data.continuity?.tasks.some(t => ['pending', 'submitting', 'error'].includes(t.state)) ? { status: 'error', message: 'Ripresa precedente da verificare. Apri la conversazione in Codex per continuare.' } : null),
      accounts: this.vault.data.accounts.map(({ auth, key, accountId, browserId, ...a }) => ({
        ...a, active: key === this.activeKey,
      })),
    };
  }
  publicLogin() {
    if (!this.login) return null;
    const { id, status, message, targetId, resultId, startedAt } = this.login;
    return { id, status, message, targetId, resultId, startedAt };
  }
  settings() { return { ...DEFAULT_SETTINGS, ...this.vault.data.settings }; }
  async saveSettings(value) {
    const settings = validateSettings(value);
    return this.exclusive('Salvataggio impostazioni', async () => {
      this.vault.data.settings = settings;
      await this.vault.save();
      return { ok: true, settings };
    });
  }
  updatePresence(value) {
    this.presence.update(value.clientId, value.visible);
    return { ok: true };
  }
  async autoTick(now = Date.now()) {
    if (this.autoInFlight || this.busy || this.login?.status === 'pending' || this.switchJob?.status === 'running' || this.settings().refreshMode !== 'automatic' || !this.presence.visible(now)) return;
    if (!this.vault.data.accounts.some(a => accountDue(a, this.activeKey, this.settings(), now))) return;
    this.autoInFlight = true;
    try {
      await this.exclusive('Aggiornamento automatico', async () => {
        if (this.login?.status === 'pending' || this.switchJob?.status === 'running' || this.settings().refreshMode !== 'automatic' || !this.presence.visible()) return;
        await this.syncCurrent(false);
        const accounts = this.vault.data.accounts.filter(a => accountDue(a, this.activeKey, this.settings(), now));
        let touched = false;
        for (const account of accounts) {
          // Recheck between accounts: a closed window or pending switch pauses the batch.
          if (!this.presence.visible() || this.switchJob?.status === 'running') break;
          await this.refreshAccount(account, { forceProfile: false });
          touched = true;
        }
        if (touched) await this.vault.save();
      });
    } finally { this.autoInFlight = false; }
  }
  async importCurrent() {
    return this.exclusive('Importazione account attuale', async () => {
      const account = await this.syncCurrent(true);
      if (!account) throw new Error('Apri Codex ed effettua l’accesso con ChatGPT prima di importare.');
      return { id: account.id };
    });
  }
  async editAccount(id, changes) {
    return this.exclusive('Salvataggio informazioni', async () => {
      const account = this.vault.find(id);
      for (const field of ['label', 'personalEmail']) {
        if (typeof changes[field] !== 'string' || changes[field].length > 254) throw new Error('Campi non validi (massimo 254 caratteri).');
        account[field] = changes[field].trim();
      }
      await this.vault.save();
      return { ok: true };
    });
  }
  async removeAccount(id) {
    return this.exclusive('Rimozione account', async () => {
      if (this.login?.status === 'pending') throw new Error('Completa o annulla prima l’accesso in corso.');
      this.vault.find(id);
      this.vault.data.accounts = this.vault.data.accounts.filter(a => a.id !== id);
      await this.vault.save();
      return { ok: true };
    });
  }
  async withAccount(account, fn) {
    const current = await this.currentAuth();
    let isActive = false;
    try { isActive = !!current && identityFromAuth(current).key === account.key; } catch {}
    const auth = structuredClone(isActive ? current : account.auth);
    if (!auth) throw new Error('Accesso mancante. Ricollega questo account.');
    // Reporting must never rotate credentials owned by the running desktop.
    if (isActive) auth.tokens.refresh_token = '';
    const home = await this.vault.createWork();
    let rpc;
    try {
      await fs.writeFile(path.join(home, 'config.toml'), 'cli_auth_credentials_store = "file"\n[analytics]\nenabled = false\n');
      await fs.writeFile(path.join(home, 'auth.json'), JSON.stringify(auth), { mode: 0o600 });
      await fs.writeFile(path.join(home, 'owner.json'), JSON.stringify({ key: account.key, managed: !isActive }));
      rpc = new this.Rpc(this.runtime.cliPath, home);
      await rpc.initialize();
      return await fn(rpc, home);
    } finally {
      if (rpc) await rpc.close();
      if (!isActive) {
        // Persist rotated refresh tokens before deleting the temporary work directory.
        try {
          const latest = JSON.parse(await fs.readFile(path.join(home, 'auth.json'), 'utf8'));
          if (identityFromAuth(latest).key !== account.key) throw new Error('Identità dell’account cambiata.');
          if (account.sessionSavePending || JSON.stringify(latest) !== JSON.stringify(account.auth)) {
            account.auth = latest;
            delete account.sessionSavePending;
            try { await this.vault.save(); }
            catch (error) { account.sessionSavePending = true; throw error; }
          }
        } catch (error) {
          // A lost rotated token would require a new login; retain the protected workdir for recovery.
          if (error.code !== 'ENOENT') {
            account.status = 'error';
            account.error = 'Salvataggio della sessione non riuscito. Riprova prima di cambiare account.';
            const failure = new Error(account.error, { cause: error });
            failure.code = 'SESSION_SAVE_FAILED';
            throw failure;
          }
        }
      }
      await this.vault.removeWork(home);
    }
  }
  async refreshAccount(account, { forceProfile = true } = {}) {
    account.lastAttemptAt = new Date().toISOString();
    try {
      const result = await this.withAccount(account, async (rpc, home) => {
        const info = await rpc.request('account/read', { refreshToken: false });
        if (!info.account || info.account.type !== 'chatgpt') throw new Error('Not logged in');
        const limits = await rpc.request('account/rateLimits/read');
        let profile = null, profileChecked = false;
        if (forceProfile || !account.profileCheckedAt || Date.now() - Date.parse(account.profileCheckedAt) >= 15 * 60 * 1000) {
          profileChecked = true;
          const auth = JSON.parse(await fs.readFile(path.join(home, 'auth.json'), 'utf8'));
          if (identityFromAuth(auth).key === account.key) profile = await this.profileReader(auth);
        }
        return { info: info.account, limits: normalizeLimits(limits), profile, profileChecked };
      });
      account.limits = result.limits;
      if (result.info.email) account.accountEmail = result.info.email;
      if (result.info.planType) account.plan = result.info.planType;
      account.updatedAt = new Date().toISOString();
      if (result.profileChecked) account.profileCheckedAt = account.updatedAt;
      if (result.profile) { Object.assign(account, result.profile); account.profileUpdatedAt = account.updatedAt; account.profileStatus = 'ok'; }
      else if (result.profileChecked) account.profileStatus = 'unavailable';
      account.status = 'ok';
      account.error = null;
      account.refreshFailures = 0;
      account.retryAfterAt = 0;
    } catch (error) {
      const failure = classifyError(error);
      account.status = failure.status;
      account.error = failure.message;
      account.attemptedAt = new Date().toISOString();
      account.refreshFailures = (account.refreshFailures || 0) + 1;
      const interval = account.key === this.activeKey ? this.settings().activeIntervalSeconds : this.settings().inactiveIntervalSeconds;
      account.retryAfterAt = Date.now() + Math.min(interval * 1000 * 2 ** Math.min(account.refreshFailures, 6), 30 * 60 * 1000);
    }
  }
  async refresh(id = null) {
    return this.exclusive('Aggiornamento disponibilità', async () => {
      this.notice = null;
      if (this.login?.status === 'pending') throw new Error('Completa o annulla prima l’accesso in corso.');
      await this.syncCurrent(false);
      const accounts = id ? [this.vault.find(id)] : [...this.vault.data.accounts];
      for (const account of accounts) await this.refreshAccount(account);
      await this.vault.save();
      return { ok: true };
    });
  }
  async beginLogin({ targetId = null, label = '', personalEmail = '' } = {}) {
    return this.exclusive('Preparazione accesso', async () => {
      if (this.login?.status === 'pending') throw new Error('Un accesso è già in corso.');
      if (typeof label !== 'string' || label.length > 254 || typeof personalEmail !== 'string' || personalEmail.length > 254) throw new Error('Informazioni non valide.');
      const target = targetId ? this.vault.find(targetId) : null;
      const home = await this.vault.createWork();
      const browserId = target?.browserId || randomUUID();
      const rpc = new this.Rpc(this.runtime.cliPath, home);
      const flow = {
        id: randomUUID(), status: 'pending', message: 'Completa l’accesso nella finestra del browser dedicata.',
        home, rpc, browserId, targetId, label: label.trim(), personalEmail: personalEmail.trim(), startedAt: new Date().toISOString(),
      };
      this.login = flow;
      try {
        await fs.writeFile(path.join(home, 'config.toml'), 'cli_auth_credentials_store = "file"\n[analytics]\nenabled = false\n');
        await rpc.initialize();
        rpc.once('account/login/completed', params => {
          if (flow.status !== 'pending') return;
          this.exclusive('Salvataggio nuovo accesso', () => this.finishLogin(flow, params)).catch(() => {});
        });
        rpc.once('disconnected', () => {
          if (flow.status === 'pending') this.exclusive('Chiusura accesso', () => this.failLogin(flow, 'Il collegamento con Codex si è interrotto. Riprova.')).catch(() => {});
        });
        const result = await rpc.request('account/login/start', { type: 'chatgpt', useHostedLoginSuccessPage: true, appBrand: 'codex' });
        flow.loginId = result.loginId;
        await this.windows('OpenLogin', { url: result.authUrl, profile: path.join(this.vault.root, 'browser', browserId) });
        flow.timer = setTimeout(() => {
          this.exclusive('Accesso scaduto', () => this.failLogin(flow, 'Tempo per l’accesso terminato. Premi Aggiungi account o Ricollega per riprovare.')).catch(() => {});
        }, 10 * 60 * 1000);
        return this.publicLogin();
      } catch {
        await this.failLogin(flow, 'Impossibile aprire l’accesso. Verifica che Edge o Chrome e Codex siano installati.');
        throw new Error(flow.message);
      }
    });
  }
  async finishLogin(flow, params) {
    if (flow.status !== 'pending') return;
    if (!params.success) return this.failLogin(flow, 'Accesso non completato. Riprova.');
    try {
      const auth = JSON.parse(await fs.readFile(path.join(flow.home, 'auth.json'), 'utf8'));
      const identity = identityFromAuth(auth);
      if (flow.targetId && this.vault.find(flow.targetId).key !== identity.key) {
        return this.failLogin(flow, 'Hai effettuato l’accesso con un account diverso. L’account da ricollegare non è stato modificato.');
      }
      const existing = this.vault.data.accounts.find(a => a.key === identity.key);
      const account = this.upsert(auth, identity, {
        label: flow.targetId || existing ? undefined : flow.label,
        personalEmail: flow.targetId || existing ? undefined : flow.personalEmail,
        browserId: flow.browserId,
      });
      account.status = 'connected';
      account.error = null;
      await this.vault.save();
      flow.resultId = account.id;
      flow.status = 'success';
      flow.message = existing ? 'Accesso aggiornato per l’account già presente.' : 'Account aggiunto. Puoi selezionarlo nell’hub.';
    } catch { flow.status = 'error'; flow.message = 'Impossibile salvare l’accesso. Riprova.'; }
    finally {
      clearTimeout(flow.timer);
      await flow.rpc.close();
      await this.vault.removeWork(flow.home);
    }
    if (flow.resultId) {
      await this.refreshAccount(this.vault.find(flow.resultId));
      await this.vault.save();
    }
  }
  async failLogin(flow, message) {
    flow.status = 'error'; flow.message = message;
    clearTimeout(flow.timer);
    if (flow.loginId && !flow.rpc.closed) await flow.rpc.request('account/login/cancel', { loginId: flow.loginId }, 3000).catch(() => {});
    await flow.rpc.close();
    await this.vault.removeWork(flow.home);
  }
  async cancelLogin() {
    return this.exclusive('Annullamento accesso', async () => {
      if (this.login?.status === 'pending') await this.failLogin(this.login, 'Accesso annullato.');
      return { ok: true };
    });
  }
  async beginSwitch(id) {
    if (this.switchJob?.status === 'running') throw new Error('Cambio account già in corso.');
    if (this.login?.status === 'pending') throw new Error('Completa o annulla prima l’accesso in corso.');
    this.vault.find(id);
    this.switchJob = { targetId: id, status: 'running', message: 'Verifica dell’account selezionato…' };
    // Return immediately; the hub must survive closing the Codex window hosting this chat.
    setTimeout(() => {
      this.exclusive('Cambio account', async () => {
        await this.syncCurrent(false);
        const changing = this.vault.find(id).key !== this.activeKey;
        await this.performSwitch(id, { beforeStop: this.continuity && changing ? async () => this.continuity.prepare(await this.continuity.capture()) : null });
        if (this.continuity && changing) await this.continuity.resume();
      }).catch(error => {
        const recoveryAvailable = !!this.vault.data.switchJournal?.previousAuth;
        this.switchJob = { targetId: id, status: 'error', recoveryAvailable, message: error.message || 'Cambio account non riuscito.' };
        if (this.continuity) this.continuityStatus = { status: 'error', message: recoveryAvailable || this.vault.data.continuity?.tasks.some(t => ['pending', 'submitting', 'error'].includes(t.state)) ? 'Cambio o ripresa interrotti. Controlla lo stato del cambio e le conversazioni in Codex.' : 'Il cambio non è stato avviato. Codex è ancora con l’account precedente. ' + this.switchJob.message };
      });
    }, 200);
    return { ok: true };
  }
  async waitForDesktop(expectedKey) {
    const deadline = Date.now() + this.readinessTimeoutMs;
    let readFailed = false;
    for (let attempt = 0; attempt < this.readinessAttempts; attempt++) {
      if (Date.now() >= deadline) break;
      let runtime;
      try { runtime = await this.discover(); }
      catch (error) {
        if (error.windowsAction !== 'Discover') throw error;
        readFailed = true;
        await this.sleep(1000);
        continue;
      }
      const auth = await this.currentAuth();
      let matches = false;
      try { matches = !!auth && identityFromAuth(auth).key === expectedKey; } catch {}
      if (runtime.appRunning && runtime.agentReady !== false && runtime.windowReady !== false && matches) return runtime;
      await this.sleep(1000);
    }
    throw new Error(readFailed ? 'Avvio non verificato: il rilevamento di Codex è stato temporaneamente indisponibile. Controlla il profilo aperto nell’app.' : 'Codex non ha completato l’avvio con l’account atteso.');
  }
  async verifyIndependentHost() {
    if (!this.requireIndependentHost) return;
    const status = JSON.parse(await this.windows('HostStatus', { pid: process.pid }));
    if (!this.independentHost || status.codexAncestor || !status.taskSchedulerAncestor) {
      throw new Error('Codex non è stato chiuso: l’hub deve essere avviato dal collegamento desktop aggiornato, come processo indipendente.');
    }
  }
  async recordSwitchStage(stage, targetId) {
    await atomicWrite(path.join(this.vault.root, 'switch-status.json'), JSON.stringify({ stage, targetId, pid: process.pid, at: new Date().toISOString() }));
  }
  async validateSwitchTarget(target) {
    let stage = 'lettura account';
    try {
      await this.withAccount(target, async rpc => {
        // A forced refresh can clear otherwise usable auth in the installed engine.
        // Read the identity and prove access with a remote request; the engine
        // renews inactive credentials when necessary and withAccount persists them.
        const result = await rpc.request('account/read', { refreshToken: false });
        if (result.account?.type !== 'chatgpt') throw new Error('Not logged in');
        stage = 'verifica limiti';
        const limits = await rpc.request('account/rateLimits/read');
        if (limits.accountId && limits.accountId !== target.accountId) throw new Error('Identità account diversa durante la verifica.');
      });
    } catch (error) {
      const failure = classifyError(error);
      if (failure.status === 'reauth') {
        target.status = 'reauth'; target.error = failure.message;
        await this.vault.save();
        throw new Error('Accesso scaduto o revocato per questo account. Premi «Ricollega» e riprova.');
      }
      if (error.windowsAction || /Salvataggio della sessione/.test(error.message)) throw error;
      throw new Error(`Verifica dell’account non completata durante ${stage}. ${/tempo|timeout/i.test(error.message) ? 'Il motore Codex non ha risposto in tempo.' : /429|rate.?limit/i.test(error.upstream || '') ? 'Il servizio ha limitato temporaneamente le richieste.' : 'Controlla la connessione e riprova.'} Codex non è stato chiuso.`);
    }
  }
  async performSwitch(id, { beforeStop = null } = {}) {
    this.switchJob = { targetId: id, status: 'running', message: 'Verifica dell’account selezionato…' };
    const target = this.vault.find(id);
    await this.syncCurrent(true);
    this.runtime = await this.discover();
    if (!this.runtime.appPath) throw new Error('Installazione dell’app Codex non trovata.');
    if (target.key === this.activeKey) {
      await this.windows('LaunchApp', { path: this.runtime.appPath });
      this.runtime = await this.waitForDesktop(target.key);
      this.switchJob = { targetId: id, status: 'success', message: 'Questo account è già attivo. Codex è stato aperto.' };
      return;
    }
    await this.verifyIndependentHost();
    await this.validateSwitchTarget(target);
    // Verify the real Windows activation path while the current app can remain open.
    this.switchJob.message = 'Verifica dell’avvio di Codex tramite Windows…';
    await this.windows('LaunchApp', { path: this.runtime.appPath }).catch(error => {
      throw new Error('Codex non è stato chiuso: la verifica di avvio Windows è fallita. ' + error.message);
    });
    if (beforeStop && await beforeStop() === false) {
      this.switchJob = { targetId: id, status: 'success', message: 'Le attività sono già terminate. Cambio automatico annullato.' };
      return false;
    }
    const previous = await this.currentAuth();
    this.vault.data.switchJournal = { previousAuth: previous, targetId: id, startedAt: new Date().toISOString() };
    await this.vault.save();
    let written = false;
    let stopped = false;
    let stage = 'chiusura';
    try {
      this.switchJob.message = 'Chiusura di Codex e salvataggio della sessione attuale…';
      await this.recordSwitchStage('before-close', id);
      // Even a timed-out close may have already stopped the desktop. Recovery
      // must reopen it before reporting failure, without assuming no side effect.
      stopped = true;
      await this.windows('StopApp', { path: this.runtime.appPath });
      await this.recordSwitchStage('after-close', id);
      // Capture the last token refresh performed while the desktop was closing.
      await this.syncCurrent(true);
      const finalPrevious = await this.currentAuth();
      this.vault.data.switchJournal.previousAuth = finalPrevious;
      await this.vault.save();
      this.switchJob.message = 'Apertura di Codex con l’account selezionato…';
      stage = 'salvataggio accesso';
      await atomicWrite(this.authPath, JSON.stringify(target.auth, null, 2) + '\n');
      written = true;
      stage = 'riapertura tramite Windows';
      await this.recordSwitchStage('before-launch', id);
      await this.windows('LaunchApp', { path: this.runtime.appPath });
      await this.recordSwitchStage('after-launch', id);
      stage = 'attesa avvio';
      const runtime = await this.waitForDesktop(target.key);
      this.activeKey = target.key;
      delete this.vault.data.switchJournal;
      this.startupWarning = null;
      await this.syncCurrent(false);
      await this.vault.save();
      this.runtime = runtime;
      this.switchJob = { targetId: id, status: 'success', message: 'Codex riaperto con l’account selezionato. Verifica il profilo nell’app al primo cambio.' };
      await this.recordSwitchStage('complete', id);
    } catch (error) {
      this.vault.data.switchJournal ||= { previousAuth: previous, targetId: id, startedAt: new Date().toISOString() };
      let restored = false;
      if (stopped || written) {
        try {
          if (written) await this.windows('StopApp', { path: this.runtime.appPath });
          const restore = this.vault.data.switchJournal?.previousAuth;
          if (restore && written) await atomicWrite(this.authPath, JSON.stringify(restore, null, 2) + '\n');
          await this.windows('LaunchApp', { path: this.runtime.appPath });
          if (restore) await this.waitForDesktop(identityFromAuth(restore).key);
          restored = true;
        } catch {}
      }
      // Preserve a diagnostic that cannot contain auth tokens or upstream RPC text.
      this.vault.data.switchJournal.failureStage = stage;
      this.vault.data.switchJournal.previousAppRestored = restored;
      await this.recordSwitchStage(restored ? 'error-restored' : 'error', id).catch(() => {});
      await this.vault.save().catch(() => {});
      await this.syncCurrent(false).catch(() => {});
      const recovery = restored ? 'Codex è stato riaperto con l’account precedente.' : 'Il recupero automatico non è riuscito. Usa «Ripristina account precedente».';
      throw new Error(`Cambio non completato durante ${stage}. ${error.message} ${recovery}`);
    }
  }
  async recover() {
    return this.exclusive('Ripristino account precedente', async () => {
      const journal = this.vault.data.switchJournal;
      if (!journal?.previousAuth) throw new Error('Nessun account precedente da ripristinare.');
      await this.verifyIndependentHost();
      this.runtime = await this.discover();
      if (!this.runtime.appPath) throw new Error('App Codex non trovata.');
      await this.windows('StopApp', { path: this.runtime.appPath });
      await atomicWrite(this.authPath, JSON.stringify(journal.previousAuth, null, 2) + '\n');
      await this.windows('LaunchApp', { path: this.runtime.appPath });
      this.runtime = await this.waitForDesktop(identityFromAuth(journal.previousAuth).key);
      await this.syncCurrent(true);
      delete this.vault.data.switchJournal;
      await this.vault.save();
      this.startupWarning = null;
      this.switchJob = { status: 'success', message: 'Account precedente ripristinato.' };
      return { ok: true };
    });
  }
}
