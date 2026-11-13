import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const iso = seconds => Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null;
// The switch needs turn identities, not project scans, messages or rollout samples.
export function readActivity(home, now = Date.now()) {
  const databases = [];
  const open = relative => {
    const db = new DatabaseSync(path.join(home, relative), { readOnly: true });
    databases.push(db); db.exec('PRAGMA busy_timeout=1000'); return db;
  };
  try {
    const ui = open('sqlite/codex.db');
    const history = open('thread_history_1.sqlite');
    const state = open('state_5.sqlite');
    const metadata = state.prepare('SELECT source FROM threads WHERE id=?');
    const main = id => {
      const thread = metadata.get(id);
      if (!thread) throw new Error('Identità della conversazione attiva non verificabile.');
      if (thread.source === 'subagent') return false;
      try { if (JSON.parse(thread.source || '{}')?.subagent) return false; } catch {}
      return true;
    };
    const value = t => ({ threadId: t.thread_id, id: t.turn_id, status: t.status, startedAt: iso(t.started_at), completedAt: iso(t.completed_at), limitReached: /usageLimitExceeded|rateLimitExceeded/.test(t.error_json || '') });
    const live = ui.prepare('SELECT DISTINCT thread_id FROM active_chat_turns').all();
    const latestTurn = history.prepare('SELECT * FROM thread_turns WHERE thread_id=? ORDER BY started_at DESC, rollout_ordinal DESC LIMIT 1');
    const active = [];
    for (const { thread_id: id } of live) {
      const t = latestTurn.get(id);
      if (!t || t.status !== 'inProgress' || t.completed_at != null) continue;
      if (main(id)) active.push(value(t));
    }
    const recent = [];
    // Fetch only recent completions. Read no message payloads or rollout files.
    const finished = history.prepare("SELECT * FROM thread_turns WHERE completed_at>=? AND status IN ('completed','failed','interrupted','cancelled') ORDER BY completed_at DESC LIMIT 100").all(now / 1000 - 120);
    for (const t of finished) {
      if (!metadata.get(t.thread_id)) continue;
      if (main(t.thread_id)) recent.push(value(t));
    }
    return { active, recent, uncertain: [], updatedAt: new Date(now).toISOString(), error: null };
  } finally { for (const db of databases.reverse()) db.close(); }
}
