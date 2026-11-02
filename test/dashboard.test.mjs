import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { DashboardReader, UsageSampler, observedUsage } from '../src/dashboard.mjs';

const limits = (used, reset = 2000) => ({ primary: { used_percent: used, window_minutes: 300, resets_at: reset }, secondary: { used_percent: used * 2, window_minutes: 10080, resets_at: 9000 } });
async function temp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'multicodex-home-'));
  t.after(async () => { assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir())); assert.ok(path.basename(dir).startsWith('multicodex-home-')); await fs.rm(dir, { recursive: true, force: true }); });
  return dir;
}
test('quota deltas reject resets, decreases and missing windows instead of inventing prompt costs', () => {
  assert.deepEqual(observedUsage(limits(1), limits(3)), { fiveHour: 2, weekly: 4, method: 'observed_account_delta' });
  assert.equal(observedUsage(limits(3), limits(1)).fiveHour, null);
  assert.equal(observedUsage(limits(1), limits(2, 6000)).fiveHour, null);
  assert.equal(observedUsage(null, null).weekly, null);
});
test('incremental usage samples do not duplicate counts and wait for complete lines and two samples', async t => {
  const dir = await temp(t), file = path.join(dir, 'rollout.jsonl'), sampler = new UsageSampler();
  const row = payload => JSON.stringify({ type: 'event_msg', timestamp: '2026-01-01T00:00:00Z', payload }) + '\n';
  await fs.writeFile(file, row({ type: 'task_started', turn_id: 'turn' }) + row({ type: 'token_count', rate_limits: limits(2) }));
  await sampler.update(file);
  assert.equal(sampler.forTurn(file, 'turn').fiveHour, null);
  await fs.appendFile(file, row({ type: 'token_count', rate_limits: limits(4) }).slice(0, -1));
  await sampler.update(file); assert.equal(sampler.forTurn(file, 'turn').samples, 1);
  await fs.appendFile(file, '\n'); await sampler.update(file); await sampler.update(file);
  assert.equal(sampler.forTurn(file, 'turn').samples, 2);
  assert.equal(sampler.forTurn(file, 'turn').fiveHour, 2);
  await fs.appendFile(file, row({ type: 'task_complete', turn_id: 'turn' }) + row({ type: 'token_count', rate_limits: limits(99) }));
  await sampler.update(file); assert.equal(sampler.forTurn(file, 'turn').fiveHour, 2);
});
test('Home separates confirmed activity and stale turns, selects last five finished prompts and excludes internal reasoning', async t => {
  const home = await temp(t); await fs.mkdir(path.join(home, 'sqlite'));
  const root = path.join(home, 'project'); await fs.mkdir(root);
  await fs.writeFile(path.join(home, '.codex-global-state.json'), JSON.stringify({ 'local-projects': { p: { id: 'p', name: 'Project', rootPaths: [root] } } }));
  const state = new DatabaseSync(path.join(home, 'state_5.sqlite'));
  state.exec('CREATE TABLE threads(id TEXT,cwd TEXT,title TEXT,source TEXT,created_at INTEGER,updated_at INTEGER)');
  state.prepare('INSERT INTO threads VALUES (?,?,?,?,?,?)').run('chat', root, 'Chat', 'vscode', 1000, 3000);
  state.prepare('INSERT INTO threads VALUES (?,?,?,?,?,?)').run('stale', root, 'Stale', 'vscode', 1000, 3000);
  state.prepare('INSERT INTO threads VALUES (?,?,?,?,?,?)').run('agent', root, 'Agent', JSON.stringify({subagent:{}}), 1000, 3000); state.close();
  const ui = new DatabaseSync(path.join(home, 'sqlite', 'codex.db')); ui.exec('CREATE TABLE active_chat_turns(thread_id TEXT)'); ui.prepare('INSERT INTO active_chat_turns VALUES (?)').run('chat'); ui.close();
  const db = new DatabaseSync(path.join(home, 'thread_history_1.sqlite'));
  db.exec('CREATE TABLE thread_turns(thread_id TEXT,turn_id TEXT,status TEXT,started_at INTEGER,completed_at INTEGER,duration_ms INTEGER); CREATE TABLE thread_items(thread_id TEXT,turn_id TEXT,item_id TEXT,item_json TEXT,item_type TEXT,rollout_ordinal INTEGER,created_at_ms INTEGER,started_at_ms INTEGER)');
  const add = (thread, turn, status, n) => {
    db.prepare('INSERT INTO thread_turns VALUES (?,?,?,?,?,?)').run(thread, turn, status, 1000+n, status==='inProgress'?null:1001+n, status==='inProgress'?null:1000);
    const insert = db.prepare('INSERT INTO thread_items VALUES (?,?,?,?,?,?,?,?)');
    insert.run(thread,turn,turn+'user',JSON.stringify({type:'userMessage',id:turn+'user',content:[{type:'text',text:'Prompt '+turn}]}),'userMessage',n*4,1000000+n*1000,null);
    insert.run(thread,turn,turn+'reply',JSON.stringify({type:'agentMessage',id:turn+'reply',text:'Public progress',phase:'commentary'}),'agentMessage',n*4+1,1000000+n*1000,null);
    insert.run(thread,turn,turn+'reason',JSON.stringify({type:'reasoning',text:'PRIVATE REASONING'}),'reasoning',n*4+2,1000000+n*1000,null);
    insert.run(thread,turn,turn+'hidden',JSON.stringify({type:'agentMessage',text:'PRIVATE ANALYSIS',phase:'analysis'}),'agentMessage',n*4+3,1000000+n*1000,null);
  };
  for(let i=1;i<=7;i++) add('chat','done'+i,i===7?'failed':'completed',i);
  add('chat','active','inProgress',20); add('stale','uncertain','inProgress',21); add('agent','agent-turn','inProgress',22); db.close();
  const result = await new DashboardReader(home).read();
  assert.equal(result.error,null);
  assert.deepEqual(result.active.map(t=>t.id),['active']);
  assert.deepEqual(result.uncertain.map(t=>t.id),['uncertain']);
  assert.deepEqual(result.recent.map(t=>t.id),['done7','done6','done5','done4','done3']);
  assert.equal(result.active[0].project.name,'Project');
  assert.equal(result.active[0].messages[0].text,'Public progress');
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
});
