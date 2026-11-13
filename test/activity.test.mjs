import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import { readActivity } from '../src/activity.mjs';
import { ActivityService } from '../src/activity-service.mjs';

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'multicodex-activity-'));
  t.after(async () => {
    const resolved = path.resolve(home);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(resolved).startsWith('multicodex-activity-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(home, 'sqlite'));
  const ui = new DatabaseSync(path.join(home, 'sqlite/codex.db'));
  ui.exec('CREATE TABLE active_chat_turns(thread_id TEXT); INSERT INTO active_chat_turns VALUES (\'main\'),(\'agent\'),(\'stale\')'); ui.close();
  const state = new DatabaseSync(path.join(home, 'state_5.sqlite'));
  state.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,source TEXT)');
  for (const [id, source] of [['main', 'vscode'], ['agent', '{"subagent":{}}'], ['stale', 'vscode']]) state.prepare('INSERT INTO threads VALUES (?,?)').run(id, source);
  state.close();
  const history = new DatabaseSync(path.join(home, 'thread_history_1.sqlite'));
  history.exec('CREATE TABLE thread_turns(thread_id TEXT,turn_id TEXT,status TEXT,started_at INTEGER,completed_at INTEGER,rollout_ordinal INTEGER,error_json TEXT)');
  const now = Math.floor(Date.now() / 1000);
  const insert = history.prepare('INSERT INTO thread_turns VALUES (?,?,?,?,?,?,?)');
  insert.run('main', 'active', 'inProgress', now, null, 5, null);
  insert.run('main', 'old-open', 'inProgress', now - 100, null, 2, null);
  insert.run('main', 'failed', 'failed', now - 10, now - 5, 4, '{"codexErrorInfo":"usageLimitExceeded","message":"PRIVATE"}');
  insert.run('agent', 'agent-active', 'inProgress', now, null, 1, null);
  insert.run('stale', 'done', 'completed', now - 5, now - 1, 1, null);
  history.close();
  return home;
}

test('switch activity reads identities without project catalogs or messages and excludes subagents and old open turns', async t => {
  const home = await fixture(t);
  const result = readActivity(home);
  assert.deepEqual(result.active.map(t => t.id), ['active']);
  assert.deepEqual(result.recent.map(t => t.id), ['done', 'failed']);
  assert.equal(result.recent[1].limitReached, true);
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  assert.ok(result.updatedAt);
});
test('missing activity databases fail without creating files or claiming there are no tasks', async t => {
  const home = await fixture(t);
  await fs.unlink(path.join(home, 'thread_history_1.sqlite'));
  assert.throws(() => readActivity(home));
  await assert.rejects(fs.stat(path.join(home, 'thread_history_1.sqlite')), { code: 'ENOENT' });
});
test('activity worker serves concurrent switch reads with one request and remains usable on the next read', async t => {
  const home = await fixture(t);
  const service = new ActivityService(home);
  t.after(() => service.close());
  const first = service.readFresh();
  assert.equal(service.readFresh(), first);
  assert.equal((await first).active[0].id, 'active');
  assert.equal((await service.readFresh()).active[0].id, 'active');
});
test('a timed out activity worker is terminated and the next read uses a fresh worker', async () => {
  let count = 0, terminated = 0;
  class Worker extends EventEmitter {
    constructor() {
      super();
      if (++count > 1) setTimeout(() => this.emit('message', { ok: true, value: { active: [], updatedAt: new Date().toISOString() } }), 1);
    }
    async terminate() { terminated++; }
  }
  const service = new ActivityService('unused', { WorkerClass: Worker, timeoutMs: 20 });
  await assert.rejects(service.readFresh(), /scaduta/);
  assert.deepEqual((await service.readFresh()).active, []);
  assert.equal(count, 2);
  assert.equal(terminated, 2);
});
