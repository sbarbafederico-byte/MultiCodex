import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadProjectCatalog, publicMessage } from './projects.mjs';

export function observedUsage(first, last) {
  const window = minutes => {
    const a = [first?.primary, first?.secondary].find(w => w?.window_minutes === minutes);
    const b = [last?.primary, last?.secondary].find(w => w?.window_minutes === minutes);
    if (!a || !b || !Number.isFinite(a.used_percent) || !Number.isFinite(b.used_percent) || !Number.isFinite(a.resets_at) || !Number.isFinite(b.resets_at) || Math.abs(a.resets_at - b.resets_at) > 120 || b.used_percent < a.used_percent) return null;
    return Math.round((b.used_percent - a.used_percent) * 10) / 10;
  };
  return { fiveHour: window(300), weekly: window(10080), method: 'observed_account_delta' };
}

// Incremental local event reader: reasoning, tool contents and credentials never leave this reader.
export class UsageSampler {
  constructor() { this.files = new Map(); this.turns = new Map(); }
  async update(file) {
    if (!file) return;
    let handle;
    try {
      const stat = await fs.stat(file);
      let state = this.files.get(file);
      if (!state || stat.size < state.offset) { state = { offset: 0, remainder: '', current: null }; this.files.set(file, state); }
      if (state.offset === stat.size) return;
      // Bound cold reads; without the first sample, report only the observed interval.
      if (stat.size - state.offset > 16 * 1024 * 1024) { state.offset = stat.size - 16 * 1024 * 1024; state.remainder = ''; state.current = null; state.skipFirst = true; }
      handle = await fs.open(file, 'r');
      const buffer = Buffer.alloc(Math.min(16 * 1024 * 1024, stat.size - state.offset));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, state.offset);
      state.offset += bytesRead;
      const lines = (state.remainder + buffer.subarray(0, bytesRead).toString('utf8')).split('\n');
      state.remainder = lines.pop() || '';
      if (state.skipFirst) { lines.shift(); state.skipFirst = false; }
      for (const line of lines) {
        let row; try { row = JSON.parse(line); } catch { continue; }
        if (row.type !== 'event_msg') continue;
        const p = row.payload || {};
        if (p.type === 'task_started') state.current = p.turn_id || p.turn_attribution?.turn_id || null;
        if (p.type === 'token_count' && state.current && p.rate_limits) {
          const key = file + ':' + state.current;
          const value = this.turns.get(key) || { first: p.rate_limits, firstAt: row.timestamp, samples: 0 };
          value.last = p.rate_limits; value.lastAt = row.timestamp; value.samples++;
          this.turns.set(key, value);
        }
        if (['task_complete', 'turn_aborted'].includes(p.type)) state.current = null;
      }
    } catch {} finally { await handle?.close(); }
  }
  forTurn(file, id) {
    const samples = this.turns.get(file + ':' + id);
    return samples && samples.samples >= 2 ? { ...observedUsage(samples.first, samples.last), from: samples.firstAt, to: samples.lastAt, samples: samples.samples } : { fiveHour: null, weekly: null, method: 'observed_account_delta', samples: samples?.samples || 0 };
  }
}

const time = value => Number.isFinite(value) && value > 0 ? new Date(value > 1e12 ? value : value * 1000).toISOString() : null;
function rows(db, table, sql, ...args) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) return [];
  return db.prepare(sql).all(...args);
}

export class DashboardReader {
  constructor(home) { this.home = home; this.sampler = new UsageSampler(); this.catalogAt = 0; }
  async read() {
    const now = Date.now();
    if (!this.catalog || now - this.catalogAt > 30000) { this.catalog = await loadProjectCatalog(this.home); this.catalogAt = now; }
    const threads = new Map();
    for (const p of this.catalog.projects) for (const t of p.threads) if (!t.isAgent) threads.set(t.id, { ...t, project: { id: p.id, name: p.name, roots: p.roots } });
    let db, ui;
    try {
      db = new DatabaseSync(path.join(this.home, 'thread_history_1.sqlite'), { readOnly: true }); db.exec('PRAGMA busy_timeout=1000');
      let live = null;
      try {
        ui = new DatabaseSync(path.join(this.home, 'sqlite', 'codex.db'), { readOnly: true });
        if (ui.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='active_chat_turns'").get()) live = new Set(ui.prepare('SELECT thread_id FROM active_chat_turns').all().map(r => r.thread_id));
      } catch {}
      const pending = rows(db, 'thread_turns', "SELECT * FROM thread_turns WHERE status='inProgress' AND completed_at IS NULL ORDER BY started_at DESC").filter(t => threads.has(t.thread_id));
      const latest = rows(db, 'thread_turns', "SELECT * FROM thread_turns WHERE status IN ('completed','failed','interrupted','cancelled') ORDER BY COALESCE(completed_at,started_at) DESC LIMIT 100").filter(t => threads.has(t.thread_id));
      const active = [], uncertain = [], recent = [];
      for (const turn of [...pending, ...latest]) {
        if (turn.status !== 'inProgress' && recent.length >= 5) break;
        const thread = threads.get(turn.thread_id);
        const isPending = turn.status === 'inProgress';
        const items = rows(db, 'thread_items', "SELECT item_json,item_id,created_at_ms,started_at_ms,rollout_ordinal FROM thread_items WHERE thread_id=? AND turn_id=? AND item_type IN ('userMessage','agentMessage') ORDER BY rollout_ordinal", turn.thread_id, turn.turn_id);
        const realtime = rows(db, 'thread_realtime_items', "SELECT item_json,item_id,created_at_ms,rollout_ordinal FROM thread_realtime_items WHERE thread_id=? AND item_type IN ('userMessage','agentMessage') AND created_at_ms>=? ORDER BY rollout_ordinal", turn.thread_id, (turn.started_at || 0) * 1000);
        const messages = new Map();
        for (const row of [...items, ...(isPending ? realtime : [])]) try { const m = publicMessage(JSON.parse(row.item_json), row); if (m) messages.set(m.id, m); } catch {}
        const all = [...messages.values()];
        const prompt = all.filter(m => m.role === 'user').map(m => m.text).join('\n\n').slice(0, 24000);
        if (!prompt) continue;
        await this.sampler.update(thread.rolloutPath);
        const replies = all.filter(m => m.role === 'assistant').slice(-12);
        let budget = 48000;
        for (const m of replies) { m.text = m.text.slice(0, Math.min(12000, budget)); budget -= m.text.length; }
        const value = { id: turn.turn_id, threadId: thread.id, title: thread.title, project: thread.project, prompt, startedAt: time(turn.started_at), completedAt: time(turn.completed_at), durationMs: turn.duration_ms ?? null, status: turn.status, messages: replies.filter(m => m.text), usage: this.sampler.forTurn(thread.rolloutPath, turn.turn_id) };
        if (!isPending) recent.push(value);
        else if (live?.has(turn.thread_id) && pending.find(t => t.thread_id === turn.thread_id)?.turn_id === turn.turn_id) active.push(value);
        else { value.status = 'unconfirmed'; uncertain.push(value); }
      }
      return { active, recent, uncertain, updatedAt: new Date().toISOString(), error: null, warnings: this.catalog.warnings };
    } catch { return { active: [], recent: [], uncertain: [], updatedAt: null, error: 'Cronologia locale non leggibile. La Home riproverà automaticamente.', warnings: [] }; }
    finally { db?.close(); ui?.close(); }
  }
}
