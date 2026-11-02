import fs from 'node:fs/promises';
import { existsSync, createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createInterface } from 'node:readline';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const messageTypes = new Set(['userMessage', 'agentMessage']);
const dbOptions = { readOnly: true };

export function canonicalPath(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  let p = value.trim().replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '');
  if (/^[a-z]:[\\/]|^\\\\/i.test(p)) {
    p = path.win32.normalize(p);
    return (p === path.win32.parse(p).root ? p : p.replace(/[\\/]+$/, '')).toLowerCase();
  }
  return path.resolve(p).replace(/[\\/]+$/, '') || path.parse(p).root;
}
function inside(child, root) { return child === root || child.startsWith(/[\\/]$/.test(root) ? root : root + (root.includes('\\') ? '\\' : '/')); }
function iso(value, milliseconds = false) {
  if (!Number.isFinite(value) || value <= 0) return null;
  return new Date(milliseconds || value > 1e12 ? value : value * 1000).toISOString();
}
function openDb(file) { const db = new DatabaseSync(file, dbOptions); db.exec('PRAGMA busy_timeout=1000'); return db; }
function columns(db, table) { return new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map(c => c.name)); }
function tableExists(db, table) { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table); }
function readColumns(db, table, requested) {
  if (!tableExists(db, table)) return [];
  const available = columns(db, table);
  const chosen = requested.filter(c => available.has(c));
  return chosen.length ? db.prepare(`SELECT ${chosen.map(c => '"' + c + '"').join(',')} FROM "${table}"`).all() : [];
}
function isAgent(thread) {
  if (thread.sourceKind === 'subagent') return true;
  try { return !!JSON.parse(thread.source || '{}')?.subagent; } catch { return false; }
}
function parentThread(thread) {
  try { return JSON.parse(thread.source || '{}')?.subagent?.thread_spawn?.parent_thread_id || null; } catch { return null; }
}

export async function loadProjectCatalog(home) {
  const warnings = [];
  let state = {};
  try { state = JSON.parse(await fs.readFile(path.join(home, '.codex-global-state.json'), 'utf8')); }
  catch { warnings.push('Le preferenze locali di Codex non sono disponibili.'); }
  const groups = new Map();
  const aliases = new Map();
  function addProject(record, priority = 0) {
    const roots = (record.roots || []).filter(p => typeof p === 'string' && p.trim());
    if (!roots.length) return;
    const normalized = [...new Set(roots.map(canonicalPath))].sort();
    const key = normalized.join('\n');
    let p = groups.get(key);
    if (!p) {
      p = { id: createHash('sha256').update(key).digest('hex').slice(0, 24), name: '', roots, priority: -1, aliases: [], threads: [], createdAt: null };
      groups.set(key, p);
    }
    if (priority >= p.priority) { p.name = record.name || path.basename(roots[0]); p.priority = priority; p.roots = roots; }
    if (record.createdAt && (!p.createdAt || record.createdAt < p.createdAt)) p.createdAt = record.createdAt;
    if (record.id) { aliases.set(record.id, p); p.aliases.push(record.id); }
  }
  const dbFiles = [path.join(home, 'state_5.sqlite'), path.join(home, 'sqlite', 'state_5.sqlite')].filter(existsSync);
  const threads = new Map();
  for (const file of dbFiles) {
    let db;
    try {
      db = openDb(file);
      const projects = readColumns(db, 'projects', ['id', 'name', 'created_at_ms']);
      const roots = readColumns(db, 'project_roots', ['project_id', 'path', 'position']);
      for (const p of projects) addProject({ id: p.id, name: p.name, createdAt: iso(p.created_at_ms, true), roots: roots.filter(r => r.project_id === p.id).sort((a, b) => a.position - b.position).map(r => r.path) }, 1);
      for (const row of readColumns(db, 'threads', ['id', 'cwd', 'title', 'name', 'source', 'created_at', 'updated_at', 'created_at_ms', 'updated_at_ms', 'archived', 'tokens_used', 'model', 'rollout_path', 'history_mode', 'project_id'])) {
        const t = { id: row.id, cwd: row.cwd || '', title: (row.name || row.title || 'Conversazione senza titolo').slice(0, 250), source: row.source, archived: !!row.archived, model: row.model || null, tokens: row.tokens_used ?? null, createdAt: iso(row.created_at_ms, true) || iso(row.created_at), updatedAt: iso(row.updated_at_ms, true) || iso(row.updated_at), rolloutPath: row.rollout_path, historyMode: row.history_mode, projectId: row.project_id, metrics: null };
        t.isAgent = isAgent(t); t.parentId = parentThread(t);
        const existing = threads.get(t.id);
        if (!existing || String(t.updatedAt) > String(existing.updatedAt)) threads.set(t.id, t);
      }
    } catch { warnings.push('Un indice delle conversazioni non è leggibile; il riepilogo può essere parziale.'); }
    finally { db?.close(); }
  }
  for (const p of Object.values(state['local-projects'] || {})) addProject({ id: p.id, name: p.name, roots: p.rootPaths, createdAt: iso(p.createdAt, true) }, 2);
  for (const root of state['electron-saved-workspace-roots'] || []) {
    if (typeof root === 'string' && ![...groups.values()].some(p => p.roots.some(r => canonicalPath(r) === canonicalPath(root)))) addProject({ roots: [root], name: path.win32.basename(root) }, 0);
  }
  for (const mapping of Object.values(state['app-server-project-id-by-legacy-project-id-by-host'] || {})) {
    for (const [legacy, native] of Object.entries(mapping || {})) {
      const p = aliases.get(legacy) || aliases.get(native);
      if (p) { aliases.set(legacy, p); aliases.set(native, p); }
    }
  }
  // The UI catalog carries current project assignments and titles, including older chat migrations.
  const uiDbFile = path.join(home, 'sqlite', 'codex.db');
  if (existsSync(uiDbFile)) {
    let db;
    try {
      db = openDb(uiDbFile);
      for (const row of readColumns(db, 'local_thread_catalog', ['host_id', 'thread_id', 'display_title', 'cwd', 'source_created_at', 'source_updated_at', 'project_id', 'source_kind', 'missing_candidate'])) {
        if (row.host_id !== 'local' || row.source_kind === 'chatgpt' || row.missing_candidate) continue;
        let t = threads.get(row.thread_id);
        if (!t) {
          t = { id: row.thread_id, cwd: row.cwd || '', source: row.source_kind, isAgent: row.source_kind === 'subagent', archived: false, tokens: null, metrics: null, createdAt: iso(row.source_created_at), updatedAt: iso(row.source_updated_at) };
          threads.set(t.id, t);
        }
        if (row.display_title) t.title = row.display_title.slice(0, 250);
        if (row.project_id) t.projectId = row.project_id;
      }
    } catch { warnings.push('Catalogo dei titoli Codex non disponibile.'); }
    finally { db?.close(); }
  }
  const projects = [...groups.values()];
  function resolveThread(t, seen = new Set()) {
    if (seen.has(t.id)) return null;
    seen.add(t.id);
    const assignment = state['thread-project-assignments']?.[t.id];
    let p = aliases.get(t.projectId) || aliases.get(assignment?.projectId);
    if (!p && t.cwd) {
      const cwd = canonicalPath(t.cwd);
      const candidates = projects.flatMap(p => p.roots.map(root => ({ p, root: canonicalPath(root) }))).filter(x => inside(cwd, x.root)).sort((a, b) => b.root.length - a.root.length);
      p = candidates[0]?.p;
    }
    if (!p && t.parentId && threads.has(t.parentId)) p = resolveThread(threads.get(t.parentId), seen);
    return p || null;
  }
  for (const t of threads.values()) { const p = resolveThread(t); if (p) p.threads.push(t); }
  const historyFile = path.join(home, 'thread_history_1.sqlite');
  if (existsSync(historyFile)) {
    let db;
    try {
      db = openDb(historyFile);
      if (tableExists(db, 'thread_items')) {
        const itemColumns = columns(db, 'thread_items');
        const timestamp = itemColumns.has('started_at_ms') ? 'COALESCE(started_at_ms,created_at_ms)' : 'created_at_ms';
        const metrics = db.prepare(`SELECT thread_id, SUM(item_type='userMessage') AS prompts, SUM(item_type='agentMessage') AS replies, SUM(item_type IN ('commandExecution','mcpToolCall','fileChange','webSearch','dynamicToolCall')) AS toolCalls, MIN(CASE WHEN item_type='userMessage' THEN ${timestamp} END) AS first_prompt_ms, MAX(CASE WHEN item_type IN ('userMessage','agentMessage') THEN ${timestamp} END) AS last_message_ms FROM thread_items GROUP BY thread_id`).all();
        for (const m of metrics) if (threads.has(m.thread_id)) threads.get(m.thread_id).metrics = { prompts: m.prompts, replies: m.replies, toolCalls: m.toolCalls, firstPromptAt: iso(m.first_prompt_ms, true), lastMessageAt: iso(m.last_message_ms, true), historySource: 'sqlite' };
      }
      if (tableExists(db, 'thread_turns')) {
        for (const m of db.prepare('SELECT thread_id, COUNT(*) AS turns, SUM(duration_ms) AS durationMs, SUM(status=\'failed\') AS failedTurns FROM thread_turns GROUP BY thread_id').all()) {
          const t = threads.get(m.thread_id);
          if (t?.metrics) Object.assign(t.metrics, { turns: m.turns, durationMs: m.durationMs, failedTurns: m.failedTurns });
        }
      }
    } catch { warnings.push('Una parte della cronologia locale non è disponibile.'); }
    finally { db?.close(); }
  }
  for (const p of projects) {
    p.threads.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    delete p.priority;
  }
  const order = new Map((state['project-order'] || []).map((id, i) => [aliases.get(id)?.id, i]));
  projects.sort((a, b) => (order.get(a.id) ?? 1000) - (order.get(b.id) ?? 1000) || a.name.localeCompare(b.name));
  return { projects, warnings, historyFile };
}

function textOfItem(item) {
  if (item.type === 'agentMessage') return typeof item.text === 'string' ? item.text : '';
  return (item.content || []).filter(c => c.type === 'text').map(c => c.text || '').join('\n');
}
export function publicMessage(item, row = {}) {
  if (!messageTypes.has(item.type)) return null;
  if (item.type === 'agentMessage' && item.phase === 'analysis') return null;
  const raw = textOfItem(item);
  if (!raw.trim()) return null;
  const max = 32000;
  return { id: item.id || row.item_id, role: item.type === 'userMessage' ? 'user' : 'assistant', text: raw.slice(0, max), truncated: raw.length > max, createdAt: iso(row.started_at_ms || row.created_at_ms, true), phase: item.phase === 'commentary' ? 'commentary' : 'final' };
}

export async function scanRollout(file, { before = Number.MAX_SAFE_INTEGER, limit = 80, metricsOnly = false } = {}) {
  if (!file || !existsSync(file)) return { messages: [], nextBefore: null, metrics: null, unavailable: true };
  const stat = await fs.stat(file);
  if (stat.size > 80 * 1024 * 1024) return { messages: [], nextBefore: null, metrics: null, unavailable: true };
  const stream = createReadStream(file, { encoding: 'utf8' });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  const events = [], responses = [];
  let ordinal = 0, eventPrompts = 0, eventReplies = 0, responsePrompts = 0, responseReplies = 0, eventMode = false;
  const eventDates = [], responseDates = [];
  const add = (list, message) => { if (!metricsOnly && ordinal < before && message) { list.push({ ...message, ordinal }); if (list.length > limit + 1) list.shift(); } };
  try {
    for await (const line of reader) {
      ordinal++;
      let row; try { row = JSON.parse(line); } catch { continue; }
      const p = row.payload || {};
      if (row.type === 'event_msg' && ['user_message', 'agent_message'].includes(p.type)) {
        eventMode = true;
        const user = p.type === 'user_message';
        if (user) eventPrompts++; else eventReplies++;
        if (user && row.timestamp && Number.isFinite(Date.parse(row.timestamp))) eventDates.push(new Date(row.timestamp).toISOString());
        add(events, { id: String(ordinal), role: user ? 'user' : 'assistant', text: String(p.message || '').slice(0, 32000), createdAt: row.timestamp, phase: 'final' });
      } else if (row.type === 'response_item' && p.type === 'message' && ['user', 'assistant'].includes(p.role) && p.channel !== 'analysis') {
        const text = (p.content || []).filter(c => ['input_text', 'output_text'].includes(c.type)).map(c => c.text || '').join('\n');
        if (!text.trim()) continue;
        if (p.role === 'user') responsePrompts++; else responseReplies++;
        if (p.role === 'user' && row.timestamp && Number.isFinite(Date.parse(row.timestamp))) responseDates.push(new Date(row.timestamp).toISOString());
        add(responses, { id: String(ordinal), role: p.role, text: text.slice(0, 32000), createdAt: row.timestamp, phase: p.channel === 'commentary' ? 'commentary' : 'final' });
      }
    }
  } finally { reader.close(); stream.destroy(); }
  const selected = eventMode ? events : responses;
  const more = selected.length > limit;
  const messages = selected.slice(-limit);
  const hasHistory = eventPrompts + eventReplies + responsePrompts + responseReplies > 0;
  return { messages, nextBefore: more ? messages[0]?.ordinal : null, metrics: hasHistory ? { prompts: eventMode ? eventPrompts : responsePrompts, replies: eventMode ? eventReplies : responseReplies, firstPromptAt: (eventMode ? eventDates : responseDates).sort()[0] || null, toolCalls: null, historySource: 'rollout' } : null, unavailable: !hasHistory };
}

export async function readConversation(home, project, threadId, before, limit = 80) {
  const thread = project.threads.find(t => t.id === threadId && !t.isAgent);
  if (!thread) throw new Error('Conversazione non trovata in questo progetto.');
  const file = path.join(home, 'thread_history_1.sqlite');
  const pageLimit = Math.min(100, Math.max(1, Number(limit) || 80));
  const cursor = before == null ? Number.MAX_SAFE_INTEGER : Number(before);
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('Pagina della conversazione non valida.');
  if (thread.metrics?.historySource === 'sqlite' && existsSync(file)) {
    const db = openDb(file);
    try {
      const rows = db.prepare(`SELECT item_json,item_id,rollout_ordinal,created_at_ms,started_at_ms FROM thread_items WHERE thread_id=? AND item_type IN ('userMessage','agentMessage') AND rollout_ordinal<? ORDER BY rollout_ordinal DESC LIMIT ?`).all(threadId, cursor, pageLimit + 1);
      const more = rows.length > pageLimit;
      const page = rows.slice(0, pageLimit).reverse();
      return { threadId, title: thread.title, messages: page.map(row => { try { return publicMessage(JSON.parse(row.item_json), row); } catch { return null; } }).filter(Boolean), nextBefore: more ? page[0]?.rollout_ordinal : null, unavailable: false };
    } finally { db.close(); }
  }
  return { threadId, title: thread.title, ...await scanRollout(thread.rolloutPath, { before: cursor, limit: pageLimit }) };
}

function categoryFor(name, inherited) {
  if (inherited !== 'other') return inherited;
  if (name === '.git') return 'git';
  if (['node_modules', '.venv', 'venv', '.cache', 'dist', 'build', 'target', '__pycache__'].includes(name.toLowerCase())) return 'generated';
  return inherited;
}
export async function scanProjectFiles(roots, { maxFiles = 250000, maxMs = 120000 } = {}) {
  const started = Date.now();
  const result = { bytes: 0, files: 0, folders: 0, gitBytes: 0, generatedBytes: 0, skippedLinks: 0, unreadable: 0, partial: false, roots: [], largestFiles: [], extensions: [] };
  const ext = new Map();
  const unique = roots.filter((r, i) => !roots.some((other, j) => j !== i && inside(canonicalPath(r), canonicalPath(other)) && (canonicalPath(r) !== canonicalPath(other) || j < i)));
  const queue = [];
  for (const root of unique) {
    try {
      const stat = await fs.stat(root);
      if (!stat.isDirectory()) throw new Error('not-directory');
      result.roots.push({ path: root, available: true, createdAt: stat.birthtimeMs > 0 ? stat.birthtime.toISOString() : null });
      queue.push({ directory: root, root, category: 'other', depth: 0 });
    } catch { result.roots.push({ path: root, available: false, createdAt: null }); }
  }
  if (!queue.length) return { ...result, bytes: null, status: 'missing', durationMs: Date.now() - started };
  if (result.roots.some(r => !r.available)) result.partial = true;
  while (queue.length) {
    if (Date.now() - started > maxMs || result.files >= maxFiles) { result.partial = true; break; }
    const batch = queue.splice(0, 12);
    await Promise.all(batch.map(async dir => {
      let entries;
      try { entries = await fs.readdir(dir.directory, { withFileTypes: true }); result.folders++; }
      catch { result.unreadable++; result.partial = true; return; }
      for (let i = 0; i < entries.length; i += 24) {
        if (Date.now() - started > maxMs || result.files >= maxFiles) { result.partial = true; break; }
        await Promise.all(entries.slice(i, i + 24).map(async entry => {
          const absolute = path.join(dir.directory, entry.name);
          if (entry.isSymbolicLink()) { result.skippedLinks++; return; }
          if (entry.isDirectory()) {
            if (dir.depth >= 64) { result.partial = true; return; }
            queue.push({ ...dir, directory: absolute, depth: dir.depth + 1, category: categoryFor(entry.name, dir.category) }); return;
          }
          if (!entry.isFile()) return;
          try {
            const stat = await fs.lstat(absolute);
            if (!stat.isFile()) return;
            result.files++; result.bytes += stat.size;
            if (dir.category === 'git') result.gitBytes += stat.size;
            if (dir.category === 'generated') result.generatedBytes += stat.size;
            const extension = path.extname(entry.name).toLowerCase() || '(senza estensione)';
            const e = ext.get(extension) || { extension, files: 0, bytes: 0 }; e.files++; e.bytes += stat.size; ext.set(extension, e);
            result.largestFiles.push({ path: path.relative(dir.root, absolute), bytes: stat.size });
            result.largestFiles.sort((a, b) => b.bytes - a.bytes); result.largestFiles.length = Math.min(5, result.largestFiles.length);
          } catch { result.unreadable++; result.partial = true; }
        }));
      }
    }));
  }
  result.extensions = [...ext.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 8);
  return { ...result, status: result.partial ? 'partial' : 'complete', durationMs: Date.now() - started };
}

export function safeRemote(value) {
  try { const u = new URL(value); if (!['https:', 'http:', 'ssh:'].includes(u.protocol)) return null; u.username = ''; u.password = ''; u.search = ''; u.hash = ''; return u.toString(); }
  catch { const match = String(value || '').match(/^[^@\s]+@([a-zA-Z0-9.-]+):([a-zA-Z0-9_./-]+)$/); return match ? `https://${match[1]}/${match[2]}` : null; }
}
export async function readGit(root) {
  if (!existsSync(path.join(root, '.git'))) return { repository: false };
  const options = { windowsHide: true, timeout: 6000, maxBuffer: 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } };
  try {
    const [status, remote] = await Promise.all([
      exec('git', ['-c', 'core.fsmonitor=false', '-C', root, 'status', '--porcelain=v1', '--branch', '--untracked-files=all'], options),
      exec('git', ['-C', root, 'config', '--get', 'remote.origin.url'], options).catch(() => ({ stdout: '' })),
    ]);
    const lines = status.stdout.trimEnd().split('\n');
    const header = lines.shift()?.replace(/^## /, '') || '';
    const branch = header.split('...')[0].replace(/^No commits yet on /, '').replace(/^Initial commit on /, '');
    const changes = lines.filter(Boolean);
    return { repository: true, branch, modifiedFiles: changes.filter(l => !l.startsWith('??')).length, untrackedFiles: changes.filter(l => l.startsWith('??')).length, clean: changes.length === 0, ahead: Number(header.match(/ahead (\d+)/)?.[1] || 0), behind: Number(header.match(/behind (\d+)/)?.[1] || 0), remote: safeRemote(remote.stdout.trim()) };
  } catch { return { repository: true, unavailable: true }; }
}

export function summarizeProject(p) {
  const userThreads = p.threads.filter(t => !t.isAgent);
  const available = userThreads.filter(t => t.metrics);
  const sum = field => available.reduce((n, t) => n + (t.metrics[field] || 0), 0);
  const dates = userThreads.flatMap(t => [t.updatedAt, t.metrics?.lastMessageAt]).filter(Boolean).sort();
  const firstPromptAt = userThreads.map(t => t.metrics?.firstPromptAt).filter(Boolean).sort()[0] || null;
  return { id: p.id, name: p.name, roots: p.roots, firstActivityAt: firstPromptAt || p.createdAt || null, firstActivitySource: firstPromptAt ? 'prompt' : p.createdAt ? 'project' : 'unavailable', lastActivityAt: dates.at(-1) || firstPromptAt || p.createdAt || null,
    conversations: userThreads.length, archivedConversations: userThreads.filter(t => t.archived).length, subagentConversations: p.threads.filter(t => t.isAgent).length,
    prompts: available.length || !userThreads.length ? sum('prompts') : null, replies: available.length || !userThreads.length ? sum('replies') : null,
    toolCalls: sum('toolCalls'), recordedDurationMs: sum('durationMs'), recordedTokens: userThreads.reduce((n, t) => n + (t.tokens || 0), 0),
    incompleteHistory: userThreads.length - available.length, disk: p.disk || null, git: p.git || null, codexStorage: p.codexStorage || null };
}
