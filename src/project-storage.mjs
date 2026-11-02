import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canonicalPath, scanProjectFiles } from './projects.mjs';

const quote = value => '"' + value.replaceAll('"', '""') + '"';
const category = file => /logs?[_./\\-]/i.test(file) ? 'logs' : /thread_history|sessions|rollout/i.test(file) ? 'conversations' : 'data';
const labels = { conversations: 'Conversazioni', logs: 'Log', data: 'Dati, allegati e altri file' };
const within = (file, root) => { const rel = path.relative(root, file); return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep)); };

// Physical SQLite pages, indexes, WAL and free space cannot be split honestly by project.
// Attribute row payload lengths, and expose the shared physical store separately.
export async function scanCodexStorage(home, projects) {
  const byThread = new Map(), byProject = new Map();
  for (const p of projects) {
    p.codexStorage = { home, fileBytes: 0, databaseBytes: 0, attributedBytes: 0, partial: false, files: [], stores: [], categories: Object.entries(labels).map(([kind, label]) => ({ kind, label, fileBytes: 0, databaseBytes: 0, rows: 0 })), notes: [] };
    for (const t of p.threads) byThread.set(t.id, p);
    for (const id of p.aliases || []) byProject.set(id, p);
  }
  const getCategory = (p, kind) => p.codexStorage.categories.find(c => c.kind === kind);
  const found = new Map(projects.map(p => [p.id, new Map()]));
  async function addFile(p, file, kind, threadId = null, declared = false) {
    if (!file || typeof file !== 'string' || !path.isAbsolute(file)) return;
    const key = canonicalPath(file), known = found.get(p.id).get(key);
    if (known) { if (threadId && !known.threadIds.includes(threadId)) known.threadIds.push(threadId); return; }
    const item = { path: file, kind, threadIds: threadId ? [threadId] : [], available: false, bytes: null, directory: false };
    try {
      const stat = await fs.lstat(file);
      if (stat.isSymbolicLink()) { p.codexStorage.partial = true; return; }
      item.directory = stat.isDirectory();
      if (item.directory) {
        const scan = await scanProjectFiles([file], { maxFiles: 50000, maxMs: 30000 });
        item.bytes = scan.bytes; item.partial = scan.partial; item.available = scan.bytes != null;
        if (scan.partial) p.codexStorage.partial = true;
      } else if (stat.isFile()) { item.bytes = stat.size; item.available = true; }
    } catch (error) { if (error.code !== 'ENOENT') p.codexStorage.partial = true; }
    if (!item.available && !declared) return;
    found.get(p.id).set(key, item);
    if (item.available) { p.codexStorage.fileBytes += item.bytes; getCategory(p, kind).fileBytes += item.bytes; }
  }
  for (const p of projects) for (const t of p.threads) if (t.rolloutPath) await addFile(p, t.rolloutPath, 'conversations', t.id, true);
  for (const p of projects) for (const root of p.roots) for (const name of ['.codex', 'AGENTS.md', 'AGENTS.override.md']) await addFile(p, path.join(root, name), 'data');

  const dbFiles = ['state_5.sqlite', 'thread_history_1.sqlite', 'logs_2.sqlite', 'memories_1.sqlite', 'goals_1.sqlite', 'queue_1.sqlite', 'sqlite/state_5.sqlite', 'sqlite/logs_2.sqlite', 'sqlite/memories_1.sqlite', 'sqlite/goals_1.sqlite', 'sqlite/codex.db'];
  for (const relative of dbFiles) {
    const file = path.join(home, relative);
    if (!existsSync(file)) continue;
    let db;
    try {
      db = new DatabaseSync(file, { readOnly: true }); db.exec('PRAGMA busy_timeout=1000');
      const physical = [];
      for (const suffix of ['', '-wal', '-shm']) try { const stat = await fs.stat(file + suffix); physical.push({ path: file + suffix, bytes: stat.size }); } catch {}
      const stores = new Map();
      for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
        const cols = db.prepare(`PRAGMA table_info(${quote(name)})`).all().map(c => c.name);
        const key = ['threads', 'projects'].includes(name) ? 'id' : cols.includes('thread_id') ? 'thread_id' : cols.includes('project_id') ? 'project_id' : null;
        if (!key) continue;
        const lookup = key === 'project_id' || name === 'projects' ? byProject : byThread;
        const length = cols.map(c => `CASE WHEN ${quote(c)} IS NULL THEN 0 WHEN typeof(${quote(c)}) IN ('text','blob') THEN length(CAST(${quote(c)} AS BLOB)) ELSE 8 END`).join('+');
        const groups = db.prepare(`SELECT ${quote(key)} AS owner,COUNT(*) AS rows,SUM(${length}) AS bytes FROM ${quote(name)} WHERE ${quote(key)} IS NOT NULL ${cols.includes('host_id') ? "AND host_id='local'" : ''} GROUP BY ${quote(key)}`).all();
        for (const group of groups) {
          const p = lookup.get(group.owner); if (!p) continue;
          let store = stores.get(p.id);
          if (!store) { store = { path: file, kind: category(relative), shared: true, databaseBytes: 0, rows: 0, physicalBytes: physical.reduce((n, f) => n + f.bytes, 0), physicalFiles: physical, threadIds: [], tables: [] }; stores.set(p.id, store); }
          if (lookup === byThread && !store.threadIds.includes(group.owner)) store.threadIds.push(group.owner);
          store.databaseBytes += group.bytes || 0; store.rows += group.rows;
          let table = store.tables.find(t => t.name === name);
          if (!table) { table = { name, rows: 0, bytes: 0 }; store.tables.push(table); }
          table.rows += group.rows; table.bytes += group.bytes || 0;
        }
      }
      for (const [id, store] of stores) {
        const p = projects.find(p => p.id === id);
        p.codexStorage.stores.push(store); p.codexStorage.databaseBytes += store.databaseBytes;
        const c = getCategory(p, store.kind); c.databaseBytes += store.databaseBytes; c.rows += store.rows;
      }
    } catch { for (const p of projects) { p.codexStorage.partial = true; p.codexStorage.notes.push(`Archivio non leggibile: ${file}`); } }
    finally { db?.close(); }
  }

  // Discover renamed/compressed rollouts and per-thread artifacts using explicit IDs only.
  const ids = [...new Set([...byThread.keys(), ...byProject.keys()])].sort((a, b) => b.length - a.length);
  const idPattern = ids.length ? new RegExp('(^|[^a-zA-Z0-9])(' + ids.map(id => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')(?=$|[^a-zA-Z0-9])', 'i') : null;
  const lookup = new Map([...byProject, ...byThread].map(([id, p]) => [id.toLowerCase(), p]));
  const queue = ['sessions', 'archived_sessions', 'attachments', 'visualizations', 'memories', 'thread-writer-locks', 'project-metadata-locks', 'rollout-migrations', 'node_repl/active_execs'].map(relative => ({ file: path.join(home, relative), depth: 0 }));
  let entriesSeen = 0;
  const started = Date.now();
  while (queue.length && idPattern) {
    if (entriesSeen > 50000 || Date.now() - started > 30000) { for (const p of projects) p.codexStorage.partial = true; break; }
    const { file, depth } = queue.shift();
    let entries; try { entries = await fs.readdir(file, { withFileTypes: true }); } catch (error) { if (error.code !== 'ENOENT') for (const p of projects) p.codexStorage.partial = true; continue; }
    for (const entry of entries) {
      entriesSeen++;
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(file, entry.name), match = entry.name.match(idPattern);
      if (match) { const id = match[2].toLowerCase(), p = lookup.get(id); if (p) await addFile(p, absolute, category(absolute), byThread.has(match[2]) ? match[2] : null); }
      else if (entry.isDirectory() && depth < 8) queue.push({ file: absolute, depth: depth + 1 });
      else if (entry.isDirectory()) for (const p of projects) p.codexStorage.partial = true;
    }
  }
  for (const p of projects) {
    const s = p.codexStorage;
    // The global preferences file is shared: disclose its path, never charge its full size.
    const preferences = path.join(home, '.codex-global-state.json');
    if (existsSync(preferences)) s.references = [{ path: preferences, label: 'Preferenze e collegamenti dei progetti · condiviso' }];
    else s.references = [];
    s.files = [...found.get(p.id).values()].map(f => ({ ...f, insideProject: p.roots.some(root => within(f.path, root)) }));
    for (const f of s.files) f.counted = f.available && !s.files.some(other => other !== f && other.directory && other.available && within(f.path, other.path));
    s.fileBytes = s.files.filter(f => f.counted).reduce((n, f) => n + f.bytes, 0);
    for (const c of s.categories) c.fileBytes = s.files.filter(f => f.counted && f.kind === c.kind).reduce((n, f) => n + f.bytes, 0);
    s.attributedBytes = s.fileBytes + s.databaseBytes;
    s.notes.push('File dedicati: dimensione dei file. Database: contenuto logico delle righe associate al progetto, inclusi i sottoagenti; non è una quota fisica esatta del database.', 'Log generali, cache e impostazioni senza un collegamento certo al progetto non vengono attribuiti. I file Codex dentro la cartella del progetto sono già compresi anche nel suo peso: i due valori non vanno sommati.');
  }
}
