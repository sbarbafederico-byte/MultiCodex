import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canonicalPath, loadProjectCatalog, summarizeProject, readConversation, scanRollout, scanProjectFiles, safeRemote, readGit } from '../src/projects.mjs';
import { ProjectService } from '../src/project-service.mjs';
import { scanCodexStorage } from '../src/project-storage.mjs';

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'multicodex-projects-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(home)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(home).startsWith('multicodex-projects-'));
    await fs.rm(home, { recursive: true, force: true });
  });
  const projectRoot = path.join(home, 'project');
  await fs.mkdir(projectRoot);
  const db = new DatabaseSync(path.join(home, 'state_5.sqlite'));
  db.exec(`CREATE TABLE projects(id TEXT,name TEXT,created_at_ms INTEGER);
    CREATE TABLE project_roots(project_id TEXT,path TEXT,position INTEGER);
    CREATE TABLE threads(id TEXT,cwd TEXT,title TEXT,source TEXT,created_at INTEGER,updated_at INTEGER,archived INTEGER,tokens_used INTEGER,project_id TEXT,rollout_path TEXT);`);
  db.prepare('INSERT INTO projects VALUES (?,?,?)').run('native', 'Old name', 1700000000000);
  db.prepare('INSERT INTO project_roots VALUES (?,?,0)').run('native', projectRoot);
  const insert = db.prepare('INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?,?)');
  insert.run('chat', projectRoot, 'User conversation', 'vscode', 1700000000, 1700000010, 0, 1234, 'native', null);
  insert.run('agent', projectRoot, 'Agent work', JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: 'chat' } } }), 1700000000, 1700000010, 0, 999999, null, null);
  insert.run('missing', projectRoot, 'Old missing conversation', 'vscode', 1600000000, 1600000010, 1, null, null, path.join(home, 'missing.jsonl'));
  db.close();
  await fs.writeFile(path.join(home, '.codex-global-state.json'), JSON.stringify({
    'local-projects': { legacy: { id: 'legacy', name: 'Current name', rootPaths: [projectRoot], createdAt: 1700000000000 } },
    'electron-saved-workspace-roots': [projectRoot], 'project-order': ['legacy'],
    'app-server-project-id-by-legacy-project-id-by-host': { local: { legacy: 'native' } },
  }));
  const history = new DatabaseSync(path.join(home, 'thread_history_1.sqlite'));
  history.exec(`CREATE TABLE thread_items(thread_id TEXT,item_id TEXT,rollout_ordinal INTEGER,created_at_ms INTEGER,started_at_ms INTEGER,item_json TEXT,item_type TEXT);
    CREATE TABLE thread_turns(thread_id TEXT,duration_ms INTEGER,status TEXT);`);
  const add = history.prepare('INSERT INTO thread_items VALUES (?,?,?,?,?,?,?)');
  const items = [
    { type: 'userMessage', content: [{ type: 'text', text: 'First prompt <script>' }] },
    { type: 'agentMessage', text: 'Progress', phase: 'commentary' },
    { type: 'reasoning', text: 'PRIVATE REASONING' },
    { type: 'commandExecution', text: 'PRIVATE TOOL OUTPUT' },
    { type: 'agentMessage', text: 'First answer', phase: 'final' },
    { type: 'userMessage', content: [{ type: 'text', text: 'Second prompt' }] },
    { type: 'agentMessage', text: 'Second answer', phase: 'final' },
  ];
  items.forEach((item, i) => add.run('chat', String(i), i + 1, 1700000000000 + i * 1000, null, JSON.stringify(item), item.type));
  add.run('agent', 'a', 1, 1700000000000, null, JSON.stringify({ type: 'userMessage', content: [] }), 'userMessage');
  history.prepare('INSERT INTO thread_turns VALUES (?,?,?)').run('chat', 5000, 'completed');
  history.close();
  return { home, projectRoot };
}

test('project migrations and saved roots merge without doubling user conversations or agent prompts', async t => {
  const { home } = await fixture(t);
  const catalog = await loadProjectCatalog(home);
  assert.equal(catalog.projects.length, 1);
  const p = summarizeProject(catalog.projects[0]);
  assert.equal(p.name, 'Current name');
  assert.equal(p.conversations, 2);
  assert.equal(p.archivedConversations, 1);
  assert.equal(p.subagentConversations, 1);
  assert.equal(p.prompts, 2);
  assert.equal(p.replies, 3);
  assert.equal(p.recordedTokens, 1234);
  assert.equal(p.incompleteHistory, 1);
  assert.equal(p.recordedDurationMs, 5000);
  assert.equal(p.firstActivityAt, '2023-11-14T22:13:20.000Z');
  assert.equal(p.firstActivitySource, 'prompt');
});

test('history pages contain only user and assistant messages, stay ordered and cannot cross projects', async t => {
  const { home } = await fixture(t);
  const { projects: [p] } = await loadProjectCatalog(home);
  const latest = await readConversation(home, p, 'chat', null, 3);
  assert.deepEqual(latest.messages.map(m => m.text), ['First answer', 'Second prompt', 'Second answer']);
  const older = await readConversation(home, p, 'chat', latest.nextBefore, 3);
  assert.deepEqual(older.messages.map(m => m.text), ['First prompt <script>', 'Progress']);
  assert.equal(older.nextBefore, null);
  assert.equal(older.messages[1].phase, 'commentary');
  assert.ok(!JSON.stringify([latest, older]).includes('PRIVATE'));
  await assert.rejects(readConversation(home, { threads: [] }, 'chat'), /non trovata/);
  await assert.rejects(readConversation(home, p, 'agent'), /non trovata/);
  await assert.rejects(readConversation(home, p, 'chat', '../invalid'), /non valida/);
  const missing = await readConversation(home, p, 'missing');
  assert.equal(missing.unavailable, true);
});

test('legacy rollout fallback avoids duplicate message representations and excludes reasoning', async t => {
  const { home } = await fixture(t);
  const file = path.join(home, 'history.jsonl');
  const rows = [
    { type: 'event_msg', payload: { type: 'user_message', message: 'Hello' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hello' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', channel: 'analysis', content: [{ type: 'output_text', text: 'PRIVATE' }] } },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'Answer' } },
  ];
  await fs.writeFile(file, rows.map(r => JSON.stringify(r)).join('\n'));
  const result = await scanRollout(file, { limit: 1 });
  assert.equal(result.metrics.prompts, 1);
  assert.equal(result.metrics.replies, 1);
  assert.deepEqual(result.messages.map(m => m.text), ['Answer']);
  const previous = await scanRollout(file, { limit: 1, before: result.nextBefore });
  assert.deepEqual(previous.messages.map(m => m.text), ['Hello']);
  assert.equal(previous.nextBefore, null);
});

test('disk reporting includes hidden and generated files, deduplicates nested roots and skips junctions', async t => {
  const { home, projectRoot } = await fixture(t);
  await fs.mkdir(path.join(projectRoot, '.git'));
  await fs.mkdir(path.join(projectRoot, 'node_modules'));
  await fs.writeFile(path.join(projectRoot, 'app.js'), '12345');
  await fs.writeFile(path.join(projectRoot, '.git', 'index'), '123');
  await fs.writeFile(path.join(projectRoot, 'node_modules', 'lib.js'), '1234567');
  await fs.symlink(projectRoot, path.join(projectRoot, 'cycle'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = await scanProjectFiles([projectRoot, path.join(projectRoot, 'node_modules'), projectRoot]);
  assert.equal(result.bytes, 15);
  assert.equal(result.files, 3);
  assert.equal(result.gitBytes, 3);
  assert.equal(result.generatedBytes, 7);
  assert.equal(result.skippedLinks, 1);
  assert.equal(result.status, 'complete');
  const missing = await scanProjectFiles([path.join(home, 'not-there')]);
  assert.equal(missing.bytes, null);
  assert.equal(missing.status, 'missing');
  const limited = await scanProjectFiles([projectRoot], { maxFiles: 0 });
  assert.equal(limited.partial, true);
});

test('missing databases are never created and absent history stays unknown', async t => {
  const { home } = await fixture(t);
  const emptyHome = path.join(home, 'empty');
  await fs.mkdir(emptyHome);
  const catalog = await loadProjectCatalog(emptyHome);
  assert.deepEqual(catalog.projects, []);
  assert.deepEqual(await fs.readdir(emptyHome), []);
  assert.equal(summarizeProject({ id: 'x', threads: [{ metrics: null }], roots: [] }).prompts, null);
  assert.equal(summarizeProject({ id: 'x', threads: [], roots: [] }).prompts, 0);
});

test('Windows extended paths match normal roots and remote URLs never expose credentials', () => {
  assert.equal(canonicalPath('\\\\?\\C:\\Work\\Project\\'), canonicalPath('c:/work/project'));
  assert.equal(canonicalPath('C:\\'), 'c:\\');
  assert.equal(safeRemote('https://token:secret@github.com/owner/repo.git?token=private#secret'), 'https://github.com/owner/repo.git');
  assert.equal(safeRemote('git@github.com:owner/repo.git'), 'https://github.com/owner/repo.git');
  assert.equal(safeRemote('file:///secret'), null);
});

test('project worker exposes requested storage paths without exposing message or log content', async t => {
  const { home } = await fixture(t);
  const service = new ProjectService(home);
  t.after(() => service.close());
  assert.equal(service.scan().status, 'scanning');
  const started = Date.now();
  while (service.status === 'scanning' && Date.now() - started < 10000) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(service.status, 'ready', service.error);
  assert.equal(service.snapshot().projects.length, 1);
  const detail = service.detail(service.projects[0].id);
  assert.equal(detail.threads.length, 2);
  assert.ok(!JSON.stringify(detail).includes('rolloutPath'));
  assert.ok(JSON.stringify(service.snapshot()).includes('missing.jsonl'));
  assert.ok(!JSON.stringify(service.snapshot()).includes('PRIVATE'));
  assert.ok(detail.threads.find(t => t.id === 'chat').storage.databases.some(d => d.path.endsWith('thread_history_1.sqlite')));
  assert.equal((await readGit(service.projects[0].roots[0])).repository, false);
});

test('first activity falls back to project registration only when no actual user prompt is available', () => {
  const p = { id: 'x', roots: [], createdAt: '2024-01-01T00:00:00.000Z', threads: [{ createdAt: '2020-01-01T00:00:00.000Z', metrics: null }, { isAgent: true, metrics: { firstPromptAt: '2010-01-01T00:00:00.000Z' } }] };
  const summary = summarizeProject(p);
  assert.equal(summary.firstActivityAt, p.createdAt);
  assert.equal(summary.firstActivitySource, 'project');
  assert.equal(summary.lastActivityAt, p.createdAt);
});

test('storage attributes only project rows, counts compressed archives and artifacts, and separates shared physical bytes', async t => {
  const { home } = await fixture(t);
  const { projects } = await loadProjectCatalog(home);
  await fs.mkdir(path.join(home, 'archived_sessions'));
  const archive = path.join(home, 'archived_sessions', 'rollout-2023-missing.jsonl.zst');
  await fs.writeFile(archive, '1234567');
  const artifacts = path.join(home, 'visualizations', 'chat');
  await fs.mkdir(artifacts, { recursive: true });
  await fs.writeFile(path.join(artifacts, 'index.html'), '12345678');
  await fs.writeFile(path.join(home, 'auth.json'), 'DO NOT READ CREDENTIALS');
  const logs = new DatabaseSync(path.join(home, 'logs_2.sqlite'));
  logs.exec('CREATE TABLE logs(id INTEGER,thread_id TEXT,feedback_log_body TEXT,ts INTEGER)');
  const insert = logs.prepare('INSERT INTO logs VALUES (?,?,?,?)');
  insert.run(1, 'chat', 'PRIVATE PROJECT LOG', 1700000000);
  insert.run(2, 'other-project-thread', 'UNRELATED'.repeat(10000), 1700000000);
  logs.close();
  await scanCodexStorage(home, projects);
  const storage = projects[0].codexStorage;
  assert.equal(storage.stores.find(s => s.path.endsWith('state_5.sqlite')).tables.find(t => t.name === 'threads').rows, 3);
  assert.equal(storage.partial, false);
  assert.equal(storage.fileBytes, 15);
  assert.equal(storage.files.filter(f => f.available).length, 2);
  assert.ok(storage.files.some(f => f.path === archive && f.kind === 'conversations' && f.threadIds.includes('missing')));
  assert.ok(storage.files.some(f => f.path === artifacts && f.directory && f.kind === 'data'));
  const store = storage.stores.find(s => s.path.endsWith('logs_2.sqlite'));
  assert.equal(store.rows, 1);
  assert.equal(store.databaseBytes, 8 + 4 + Buffer.byteLength('PRIVATE PROJECT LOG') + 8);
  assert.ok(store.physicalBytes > store.databaseBytes);
  assert.equal(storage.categories.find(c => c.kind === 'logs').databaseBytes, store.databaseBytes);
  assert.equal(storage.attributedBytes, storage.fileBytes + storage.databaseBytes);
  assert.ok(!JSON.stringify(storage).includes('PRIVATE PROJECT LOG'));
  assert.ok(!JSON.stringify(storage).includes('UNRELATED'));
  assert.ok(!JSON.stringify(storage).includes('auth.json'));
});
