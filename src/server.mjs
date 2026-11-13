import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { Vault, atomicWrite } from './vault.mjs';
import { Hub } from './hub.mjs';
import { ProjectService } from './project-service.mjs';
import { DashboardService } from './dashboard-service.mjs';
import { Continuity } from './continuity.mjs';
import { ActivityService } from './activity-service.mjs';
import { loadEndpoint, listenLocal, saveEndpoint } from './endpoint.mjs';

const root = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'MultiCodex');
const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const vault = new Vault(root);
const projects = new ProjectService(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
const dashboard = new DashboardService(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
const hub = new Hub(vault, { desktopHome: dashboard.home, requireIndependentHost: true, independentHost: process.env.MULTICODEX_HOST === 'windows-task' });
const activity = new ActivityService(dashboard.home);
hub.continuity = new Continuity(hub, () => activity.readFresh());
let token;
const lockPath = path.join(root, 'server.lock');
const runtimePath = path.join(root, 'runtime.json');
let server, lockHandle;

async function acquireLock() {
  await fs.mkdir(root, { recursive: true });
  try { lockHandle = await fs.open(lockPath, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let alive = false;
    try {
      const pid = Number(await fs.readFile(lockPath, 'utf8'));
      if (pid > 0) { process.kill(pid, 0); alive = true; }
    } catch (err) { if (err.code === 'EPERM') alive = true; }
    if (alive) throw new Error('MultiCodex è già in esecuzione. Apri il collegamento sul desktop.');
    await fs.unlink(lockPath);
    lockHandle = await fs.open(lockPath, 'wx');
  }
  await lockHandle.writeFile(String(process.pid));
}

function json(res, code, value) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
function authorized(req) {
  const value = req.headers.authorization || '';
  const expected = 'Bearer ' + token;
  return value.length === expected.length && timingSafeEqual(Buffer.from(value), Buffer.from(expected));
}
async function body(req) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw new Error('Formato della richiesta non valido.');
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 8192) throw new Error('Richiesta troppo grande.');
  }
  return text ? JSON.parse(text) : {};
}

async function request(req, res) {
  const origin = `http://127.0.0.1:${server.address().port}`;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin)) return json(res, 403, { error: 'Origine non consentita.' });
  const url = new URL(req.url, origin);
  try {
    if (url.pathname.startsWith('/api/')) {
      if (!authorized(req)) return json(res, 401, { error: 'Sessione hub non valida. Riapri MultiCodex dal desktop.' });
      if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { app: 'MultiCodex', pid: process.pid, version: '0.5.5', host: process.env.MULTICODEX_HOST || 'direct' });
      if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, hub.snapshot());
      if (req.method === 'GET' && url.pathname === '/api/dashboard') {
        const activity = dashboard.snapshot();
        const owned = activity.uncertain.filter(t => hub.continuity.owned.get(t.threadId)?.id === t.id);
        return json(res, 200, { ...activity, active: [...activity.active, ...owned.map(t => ({ ...t, status: 'inProgress' }))], uncertain: activity.uncertain.filter(t => !owned.includes(t)) });
      }
      if (req.method === 'GET' && url.pathname === '/api/projects') return json(res, 200, projects.status === 'idle' ? projects.scan() : projects.snapshot());
      const projectRoute = url.pathname.match(/^\/api\/projects\/([a-f0-9]{24})(?:\/conversations\/([a-zA-Z0-9_-]+))?$/);
      if (req.method === 'GET' && projectRoute) return json(res, 200, projectRoute[2] ? await projects.conversation(projectRoute[1], projectRoute[2], url.searchParams.get('before')) : projects.detail(projectRoute[1]));
      if (req.method !== 'POST') return json(res, 405, { error: 'Metodo non consentito.' });
      const input = await body(req);
      if (url.pathname === '/api/projects/refresh') return json(res, 202, projects.scan());
      if (url.pathname === '/api/presence') return json(res, 200, hub.updatePresence(input));
      // Avoid queued duplicate switches and actions that would race a pending restart.
      if (hub.switchJob?.status === 'running') return json(res, 409, { error: 'Attendi il completamento del cambio account.' });
      if (url.pathname === '/api/settings') return json(res, 200, await hub.saveSettings(input));
      if (url.pathname === '/api/continuity/acknowledge') return json(res, 200, await hub.exclusive('Conferma verifica conversazioni', async () => {
        delete vault.data.continuity;
        hub.continuityStatus = null;
        await vault.save();
        return { ok: true };
      }));
      if (url.pathname === '/api/refresh') {
        if (hub.busy) return json(res, 409, { error: 'Un’operazione è già in corso.' });
        hub.refresh(input.id || null).catch(error => { hub.notice = error.message; });
        return json(res, 202, { ok: true });
      }
      if (url.pathname === '/api/login') return json(res, 200, await hub.beginLogin(input));
      if (url.pathname === '/api/login/cancel') return json(res, 200, await hub.cancelLogin());
      if (url.pathname === '/api/import') return json(res, 200, await hub.importCurrent());
      if (url.pathname === '/api/account/edit') return json(res, 200, await hub.editAccount(input.id, input));
      if (url.pathname === '/api/account/remove') return json(res, 200, await hub.removeAccount(input.id));
      if (url.pathname === '/api/switch') {
        if (hub.busy) return json(res, 409, { error: 'Attendi il termine dell’operazione in corso.' });
        return json(res, 202, await hub.beginSwitch(input.id));
      }
      if (url.pathname === '/api/recover') return json(res, 200, await hub.recover());
      return json(res, 404, { error: 'Operazione non trovata.' });
    }
    if (req.method !== 'GET') return json(res, 405, { error: 'Metodo non consentito.' });
    const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/home.js': ['home.js', 'text/javascript'], '/projects.js': ['projects.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/icon.svg': ['icon.svg', 'image/svg+xml'] };
    const file = files[url.pathname];
    if (!file) return json(res, 404, { error: 'Pagina non trovata.' });
    res.writeHead(200, { 'Content-Type': file[1] + '; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(await fs.readFile(path.join(publicDir, file[0])));
  } catch (error) {
    json(res, 400, { error: error.rpcCode ? 'Codex non ha completato l’operazione. Riprova.' : error.message || 'Operazione non riuscita.' });
  }
}

async function stop() {
  clearInterval(syncTimer);
  clearInterval(autoTimer);
  clearInterval(continuityTimer);
  await projects.close();
  await dashboard.close();
  await activity.close();
  await hub.continuity.close();
  if (hub.login?.status === 'pending') await hub.cancelLogin().catch(() => {});
  server?.close();
  await lockHandle?.close();
  await fs.unlink(lockPath).catch(() => {});
  await fs.unlink(runtimePath).catch(() => {});
  process.exit(0);
}
let syncTimer, autoTimer, continuityTimer;
try {
  await acquireLock();
  await hub.init();
  const endpoint = await loadEndpoint(root);
  token = endpoint.token;
  server = http.createServer((req, res) => { request(req, res).catch(() => { if (!res.headersSent) json(res, 500, { error: 'Errore interno.' }); else res.end(); }); });
  server.requestTimeout = 60000;
  const bound = await listenLocal(server, endpoint);
  await saveEndpoint(root, bound);
  await atomicWrite(runtimePath, JSON.stringify({ port: server.address().port, token, pid: process.pid, host: process.env.MULTICODEX_HOST || 'direct', startedAt: new Date().toISOString() }));
  console.log('MultiCodex pronto. Usa Avvia-MultiCodex.ps1 per aprire la finestra.');
  await fs.unlink(path.join(root, 'startup-error.txt')).catch(() => {});
  hub.refresh().catch(error => { hub.notice = error.message; });
  syncTimer = setInterval(() => {
    if (!hub.busy && hub.login?.status !== 'pending' && hub.switchJob?.status !== 'running') hub.exclusive('Sincronizzazione accesso attuale', () => hub.syncCurrent(false)).catch(() => {});
  }, 30000);
  autoTimer = setInterval(() => { hub.autoTick().catch(() => { hub.notice = 'Aggiornamento automatico non riuscito. I dati precedenti sono conservati.'; }); }, 1000);
  continuityTimer = setInterval(() => { hub.continuity.tick().catch(() => {}); }, 2000);
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
} catch (error) {
  console.error(error.message);
  await fs.writeFile(path.join(root, 'startup-error.txt'), error.message, { mode: 0o600 }).catch(() => {});
  await lockHandle?.close();
  if (lockHandle) await fs.unlink(lockPath).catch(() => {});
  process.exitCode = 1;
}
