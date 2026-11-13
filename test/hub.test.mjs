import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Hub } from '../src/hub.mjs';
import { identityFromAuth, normalizeLimits } from '../src/model.mjs';
import { Vault } from '../src/vault.mjs';

function auth(user, workspace = 'workspace') {
  const jwt = payload => 'header.' + Buffer.from(JSON.stringify(payload)).toString('base64url') + '.signature';
  return { auth_mode: 'chatgpt', tokens: {
    id_token: jwt({ sub: user, name: 'Name ' + user, email: user + '@example.com' }),
    access_token: jwt({ sub: user }), refresh_token: 'refresh-' + user, account_id: workspace,
  } };
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'multicodex-test-'));
  t.after(async () => {
    const resolved = path.resolve(root);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(resolved).startsWith('multicodex-test-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(root, 'work'));
  const desktopHome = path.join(root, 'desktop');
  await fs.mkdir(desktopHome);
  const vault = new Vault(root);
  vault.saves = 0;
  vault.save = async () => { vault.saves++; };
  const calls = [];
  class Rpc extends EventEmitter {
    constructor(exe, home) { super(); this.home = home; }
    async initialize() {}
    async request(method, params) {
      const file = path.join(this.home, 'auth.json');
      const a = JSON.parse(await fs.readFile(file, 'utf8'));
      if (method === 'account/read') {
        if (params.refreshToken) {
          a.tokens.refresh_token += '-rotated';
          await fs.writeFile(file, JSON.stringify(a));
        }
        return { account: { type: 'chatgpt', email: identityFromAuth(a).accountEmail } };
      }
      if (method === 'account/rateLimits/read') {
        if (a.tokens.refresh_token) { a.tokens.refresh_token += '-rotated'; await fs.writeFile(file, JSON.stringify(a)); }
        return {};
      }
      return {};
    }
    async close() { this.closed = true; }
  }
  const hub = new Hub(vault, {
    desktopHome, Rpc, sleep: async () => {}, profileReader: async () => null,
    discover: async () => ({ appPath: 'fake-app', cliPath: 'fake-cli', appRunning: true }),
    windows: async (action, args) => { calls.push({ action, args }); return '{"ok":true}'; },
  });
  hub.runtime = await hub.discover();
  return { root, hub, vault, calls };
}

test('remaining percentages follow window duration even when reversed', () => {
  const result = normalizeLimits({ rateLimits: { primary: { windowDurationMins: 10080, usedPercent: 15, resetsAt: 200 }, secondary: { windowDurationMins: 300, usedPercent: 80, resetsAt: 100 } } });
  assert.equal(result.fiveHour.remaining, 20);
  assert.equal(result.weekly.remaining, 85);
  assert.equal(result.weekly.resetsAt, 200);
});

test('missing quotas and reset count stay unknown, distinct from zero', () => {
  assert.equal(normalizeLimits({}).resets, null);
  assert.equal(normalizeLimits({}).fiveHour, null);
  assert.equal(normalizeLimits({ rateLimitResetCredits: { availableCount: 0, credits: [] } }).resets.count, 0);
});

test('unusual windows are preserved without falsely labeling them as 5 hours', () => {
  const r = normalizeLimits({ rateLimits: { primary: { usedPercent: 70, windowDurationMins: 15 } } });
  assert.equal(r.fiveHour, null);
  assert.equal(r.otherWindows[0].remaining, 30);
});

test('reset count is authoritative even with partial expiry details', () => {
  const r = normalizeLimits({ rateLimitResetCredits: { availableCount: 5, credits: [{ status: 'available' }, { status: 'available', expiresAt: null }] } });
  assert.equal(r.resets.count, 5);
  assert.equal(r.resets.credits[0].expiryProvided, false);
  assert.equal(r.resets.credits[1].expiryProvided, true);
});

test('users sharing a workspace remain distinct identities', () => {
  assert.notEqual(identityFromAuth(auth('one')).key, identityFromAuth(auth('two')).key);
});

test('metadata edits survive reconnect and account name/email stay independent', async t => {
  const { hub } = await fixture(t);
  const a = auth('one');
  const profile = hub.upsert(a, identityFromAuth(a), { label: 'Main', personalEmail: 'private@example.com' });
  hub.upsert(a, identityFromAuth(a));
  assert.equal(hub.vault.data.accounts.length, 1);
  assert.equal(profile.personalEmail, 'private@example.com');
  await hub.editAccount(profile.id, { label: 'New label', personalEmail: 'changed@example.com' });
  assert.equal(profile.accountEmail, 'one@example.com');
  assert.equal(profile.accountName, 'Name one');
});

test('snapshot never exposes credentials or recovery credentials', async t => {
  const { hub } = await fixture(t);
  const a = auth('one');
  hub.upsert(a, identityFromAuth(a));
  hub.vault.data.switchJournal = { previousAuth: a };
  const json = JSON.stringify(hub.snapshot());
  for (const secret of ['refresh-one', a.tokens.id_token, a.tokens.access_token, 'previousAuth', 'accountId']) assert.ok(!json.includes(secret));
});

test('active reporting strips the refresh token and leaves desktop auth unchanged', async t => {
  const { hub } = await fixture(t);
  const a = auth('one');
  const text = JSON.stringify(a);
  await fs.writeFile(hub.authPath, text);
  const account = hub.upsert(a, identityFromAuth(a));
  await hub.withAccount(account, async rpc => {
    const staged = JSON.parse(await fs.readFile(path.join(rpc.home, 'auth.json'), 'utf8'));
    assert.equal(staged.tokens.refresh_token, '');
  });
  assert.equal(await fs.readFile(hub.authPath, 'utf8'), text);
  assert.equal(account.auth.tokens.refresh_token, 'refresh-one');
});

test('inactive rotation is saved even if the subsequent quota read fails', async t => {
  const { hub } = await fixture(t);
  const a = auth('two');
  const account = hub.upsert(a, identityFromAuth(a));
  await assert.rejects(hub.withAccount(account, async rpc => {
    await rpc.request('account/read', { refreshToken: true });
    throw new Error('network failure');
  }), /network failure/);
  assert.equal(account.auth.tokens.refresh_token, 'refresh-two-rotated');
  assert.equal((await fs.readdir(path.join(hub.vault.root, 'work'))).length, 0);
});

test('switch saves the current session and installs refreshed target credentials', async t => {
  const { hub, calls, vault } = await fixture(t);
  const first = auth('one'), second = auth('two');
  await fs.writeFile(hub.authPath, JSON.stringify(first));
  const old = hub.upsert(first, identityFromAuth(first));
  const target = hub.upsert(second, identityFromAuth(second));
  await hub.performSwitch(target.id);
  assert.equal(hub.switchJob.status, 'success');
  assert.equal(identityFromAuth(JSON.parse(await fs.readFile(hub.authPath))).key, target.key);
  assert.equal(target.auth.tokens.refresh_token, 'refresh-two-rotated');
  assert.equal(old.auth.tokens.refresh_token, 'refresh-one');
  assert.deepEqual(calls.map(x => x.action), ['LaunchApp', 'StopApp', 'LaunchApp']);
  assert.equal(vault.data.switchJournal, undefined);
});

test('switch preflight uses normal identity read plus a remote quota check, without forced refresh', async t => {
  const { hub } = await fixture(t);
  const targetAuth = auth('two');
  const target = hub.upsert(targetAuth, identityFromAuth(targetAuth));
  const requests = [];
  hub.withAccount = async (_, fn) => fn({ request: async (method, params) => {
    requests.push({ method, params });
    if (method === 'account/read') return { account: params.refreshToken ? null : { type: 'chatgpt' } };
    return { accountId: target.accountId };
  } });
  await hub.validateSwitchTarget(target);
  assert.deepEqual(requests, [{ method: 'account/read', params: { refreshToken: false } }, { method: 'account/rateLimits/read', params: undefined }]);
});

test('network and timeout failures during preflight never ask the user to reconnect', async t => {
  const { hub, calls } = await fixture(t);
  const targetAuth = auth('two');
  const target = hub.upsert(targetAuth, identityFromAuth(targetAuth));
  target.status = 'ok';
  for (const message of ['refresh request failed: network unreachable', 'Codex non ha risposto in tempo. Riprova.']) {
    hub.withAccount = async () => { const error = new Error(message); error.upstream = message; throw error; };
    await assert.rejects(hub.validateSwitchTarget(target), error => !error.message.includes('Ricollega'));
    assert.equal(target.status, 'ok');
  }
  assert.deepEqual(calls, []);
});

test('confirmed unauthorized access marks only the selected account as needing login', async t => {
  const { hub } = await fixture(t);
  const targetAuth = auth('two');
  const target = hub.upsert(targetAuth, identityFromAuth(targetAuth));
  hub.withAccount = async () => { const error = new Error('RPC failure'); error.upstream = '401 Unauthorized'; throw error; };
  await assert.rejects(hub.validateSwitchTarget(target), /Ricollega/);
  assert.equal(target.status, 'reauth');
});

test('failed relaunch restores the previous account and retains encrypted recovery data', async t => {
  const { hub, calls, vault } = await fixture(t);
  const first = auth('one'), second = auth('two');
  await fs.writeFile(hub.authPath, JSON.stringify(first));
  hub.upsert(first, identityFromAuth(first));
  const target = hub.upsert(second, identityFromAuth(second));
  let launches = 0;
  hub.windows = async action => { calls.push({ action }); if (action === 'LaunchApp' && ++launches > 1) throw new Error('failed'); };
  await assert.rejects(hub.performSwitch(target.id), /Cambio non completato/);
  assert.deepEqual(calls.map(x => x.action), ['LaunchApp', 'StopApp', 'LaunchApp', 'StopApp', 'LaunchApp']);
  assert.equal(identityFromAuth(JSON.parse(await fs.readFile(hub.authPath))).key, identityFromAuth(first).key);
  assert.deepEqual(vault.data.switchJournal.previousAuth, first);
});

test('selecting the current account opens the app without closing it', async t => {
  const { hub, calls } = await fixture(t);
  const a = auth('one');
  await fs.writeFile(hub.authPath, JSON.stringify(a));
  const account = hub.upsert(a, identityFromAuth(a));
  await hub.performSwitch(account.id);
  assert.deepEqual(calls.map(x => x.action), ['LaunchApp']);
});

test('a failed real-launch preflight leaves the app open and the current credentials unchanged', async t => {
  const { hub, calls } = await fixture(t);
  const current = auth('one'), targetAuth = auth('two');
  const original = JSON.stringify(current);
  await fs.writeFile(hub.authPath, original);
  hub.upsert(current, identityFromAuth(current));
  const target = hub.upsert(targetAuth, identityFromAuth(targetAuth));
  hub.windows = async action => { calls.push({ action }); throw new Error('Access denied'); };
  await assert.rejects(hub.performSwitch(target.id), /Codex non è stato chiuso/);
  assert.deepEqual(calls.map(c => c.action), ['LaunchApp']);
  assert.equal(await fs.readFile(hub.authPath, 'utf8'), original);
});

test('a hub still owned by Codex cannot close the desktop', async t => {
  const { hub, calls } = await fixture(t);
  const current = auth('one'), targetAuth = auth('two');
  const original = JSON.stringify(current);
  await fs.writeFile(hub.authPath, original);
  hub.upsert(current, identityFromAuth(current));
  const target = hub.upsert(targetAuth, identityFromAuth(targetAuth));
  hub.requireIndependentHost = true;
  hub.independentHost = true;
  hub.windows = async action => { calls.push({ action }); return JSON.stringify({ codexAncestor: true, taskSchedulerAncestor: false }); };
  await assert.rejects(hub.performSwitch(target.id), /Codex non è stato chiuso/);
  assert.deepEqual(calls.map(c => c.action), ['HostStatus']);
  assert.equal(await fs.readFile(hub.authPath, 'utf8'), original);
});

test('claiming an independent host is insufficient without the Windows scheduler ancestry', async t => {
  const { hub } = await fixture(t);
  hub.requireIndependentHost = true;
  hub.independentHost = true;
  hub.windows = async () => JSON.stringify({ codexAncestor: false, taskSchedulerAncestor: false });
  await assert.rejects(hub.verifyIndependentHost(), /processo indipendente/);
});

test('an independently scheduled host is allowed to perform the desktop restart', async t => {
  const { hub } = await fixture(t);
  hub.requireIndependentHost = true;
  hub.independentHost = true;
  hub.windows = async () => JSON.stringify({ codexAncestor: false, taskSchedulerAncestor: true });
  await hub.verifyIndependentHost();
});

test('startup waits for both the window and engine instead of rolling back after 3 seconds', async t => {
  const { hub, calls } = await fixture(t);
  const current = auth('one'), targetAuth = auth('two');
  await fs.writeFile(hub.authPath, JSON.stringify(current));
  hub.upsert(current, identityFromAuth(current));
  const target = hub.upsert(targetAuth, identityFromAuth(targetAuth));
  let checks = 0;
  hub.discover = async () => ({ appPath: 'fake-app', cliPath: 'fake-cli', appRunning: true, windowReady: ++checks > 4, agentReady: checks > 6 });
  await hub.performSwitch(target.id);
  assert.equal(hub.switchJob.status, 'success');
  assert.ok(checks >= 7);
  assert.deepEqual(calls.map(c => c.action), ['LaunchApp', 'StopApp', 'LaunchApp']);
});

test('failed target activation verifies a successful recovery before reporting it', async t => {
  const { hub, vault } = await fixture(t);
  const current = auth('one'), targetAuth = auth('two');
  await fs.writeFile(hub.authPath, JSON.stringify(current));
  hub.upsert(current, identityFromAuth(current));
  const target = hub.upsert(targetAuth, identityFromAuth(targetAuth));
  let launches = 0;
  hub.windows = async action => { if (action === 'LaunchApp' && ++launches === 2) throw new Error('activation failed'); };
  await assert.rejects(hub.performSwitch(target.id), /riaperto con l’account precedente/);
  assert.equal(vault.data.switchJournal.previousAppRestored, true);
  assert.equal(vault.data.switchJournal.failureStage, 'riapertura tramite Windows');
});

test('a close timeout still reopens and verifies the previous desktop before reporting failure', async t => {
  const { hub, calls } = await fixture(t);
  const current = auth('one'), targetAuth = auth('two');
  await fs.writeFile(hub.authPath, JSON.stringify(current));
  hub.upsert(current, identityFromAuth(current));
  const target = hub.upsert(targetAuth, identityFromAuth(targetAuth));
  hub.windows = async action => {
    calls.push({ action });
    if (action === 'StopApp') throw new Error('Tempo scaduto durante chiusura di Codex.');
  };
  await assert.rejects(hub.performSwitch(target.id), /riaperto con l’account precedente/);
  assert.deepEqual(calls.map(c => c.action), ['LaunchApp', 'StopApp', 'LaunchApp']);
  assert.equal(hub.vault.data.switchJournal.previousAppRestored, true);
  assert.deepEqual(JSON.parse(await fs.readFile(hub.authPath, 'utf8')), current);
});

test('a stale close failure is cleared only when the previous identity and a ready desktop are verified', async t => {
  const { hub } = await fixture(t);
  const previous = auth('one');
  hub.vault.data.switchJournal = { failureStage: 'chiusura', previousAuth: previous };
  hub.activeKey = identityFromAuth(previous).key;
  hub.runtime.agentReady = false;
  assert.equal(await hub.reconcileInterruptedClose(), false);
  hub.runtime.agentReady = true;
  hub.activeKey = 'different-account';
  assert.equal(await hub.reconcileInterruptedClose(), false);
  hub.activeKey = identityFromAuth(previous).key;
  assert.equal(await hub.reconcileInterruptedClose(), true);
  assert.equal(hub.vault.data.switchJournal, undefined);
});

test('recovery refuses to delete outside the dedicated work directory', async t => {
  const { vault, root } = await fixture(t);
  await assert.rejects(vault.removeWork(root), /Cartella temporanea non valida/);
});

test('a failed close does not leave an unused continuation checkpoint blocking an already running chat', async t => {
  const { hub } = await fixture(t);
  const previous = auth('one');
  hub.activeKey = identityFromAuth(previous).key;
  const journal = { failureStage: 'chiusura', previousAuth: previous };
  hub.vault.data.switchJournal = journal;
  hub.vault.data.continuity = { tasks: [{ threadId: 'chat', originalTurnId: 'old-turn', state: 'pending' }] };
  hub.continuity = { readActivity: async () => ({ active: [{ threadId: 'chat', id: 'new-turn' }], recent: [], updatedAt: new Date().toISOString() }) };
  assert.equal(await hub.reconcileInterruptedClose(), true);
  assert.equal(hub.vault.data.continuity, undefined);
  hub.vault.data.switchJournal = journal;
  hub.vault.data.continuity = { tasks: [{ threadId: 'chat', state: 'submitting' }] };
  await hub.reconcileInterruptedClose();
  assert.equal(hub.vault.data.continuity.tasks[0].state, 'submitting');
});

test('after a crash, rotated inactive credentials are recovered before cleanup', async t => {
  const { hub, vault } = await fixture(t);
  const a = auth('two');
  const account = hub.upsert(a, identityFromAuth(a));
  const home = await vault.createWork();
  const updated = structuredClone(a); updated.tokens.refresh_token += '-recovered';
  await fs.writeFile(path.join(home, 'owner.json'), JSON.stringify({ managed: true, key: account.key }));
  await fs.writeFile(path.join(home, 'auth.json'), JSON.stringify(updated));
  await hub.recoverWork();
  assert.equal(account.auth.tokens.refresh_token, 'refresh-two-recovered');
  assert.equal((await fs.readdir(path.join(rootOf(vault), 'work'))).length, 0);
});
function rootOf(vault) { return vault.root; }

test('manual settings are the default and custom intervals persist independently of account data', async t => {
  const { hub, vault } = await fixture(t);
  assert.deepEqual(hub.settings(), { refreshMode: 'manual', activeIntervalSeconds: 60, inactiveIntervalSeconds: 300, switchMode: 'manual', switchStrategy: 'fiveHour', accountOrder: [] });
  const a = auth('one'); hub.upsert(a, identityFromAuth(a), { personalEmail: 'personal@example.com' });
  await hub.saveSettings({ refreshMode: 'automatic', activeIntervalSeconds: 90, inactiveIntervalSeconds: 600 });
  const reloaded = new Hub(vault);
  assert.equal(reloaded.settings().activeIntervalSeconds, 90);
  assert.equal(reloaded.settings().inactiveIntervalSeconds, 600);
  assert.equal(vault.data.accounts[0].personalEmail, 'personal@example.com');
  await assert.rejects(hub.saveSettings({ refreshMode: 'automatic', activeIntervalSeconds: 0, inactiveIntervalSeconds: 300 }));
  assert.equal(hub.settings().activeIntervalSeconds, 90);
});

test('continuity captures only after switch preflight and can cancel before closing the desktop', async t => {
  const { hub, calls } = await fixture(t);
  const previous = auth('one');
  await fs.writeFile(hub.authPath, JSON.stringify(previous));
  hub.upsert(previous, identityFromAuth(previous));
  const targetAuth = auth('two');
  const target = hub.upsert(targetAuth, identityFromAuth(targetAuth));
  let captured = false;
  const result = await hub.performSwitch(target.id, { beforeStop: async () => {
    captured = true;
    assert.ok(calls.some(c => c.action === 'LaunchApp'));
    assert.ok(!calls.some(c => c.action === 'StopApp'));
    return false;
  } });
  assert.equal(result, false);
  assert.equal(captured, true);
  assert.ok(!calls.some(c => c.action === 'StopApp'));
  assert.equal(hub.vault.data.switchJournal, undefined);
  assert.deepEqual(JSON.parse(await fs.readFile(hub.authPath, 'utf8')), previous);
});

test('automatic refresh uses the active and inactive intervals separately', async t => {
  const { hub } = await fixture(t);
  const now = Date.now(), a = auth('one'), b = auth('two');
  await fs.writeFile(hub.authPath, JSON.stringify(a));
  const active = hub.upsert(a, identityFromAuth(a)), inactive = hub.upsert(b, identityFromAuth(b));
  active.updatedAt = new Date(now - 61000).toISOString();
  inactive.updatedAt = new Date(now - 240000).toISOString();
  hub.activeKey = active.key;
  await hub.saveSettings({ refreshMode: 'automatic', activeIntervalSeconds: 60, inactiveIntervalSeconds: 300 });
  hub.updatePresence({ clientId: 'test-window-visible', visible: true });
  const refreshed = [];
  hub.refreshAccount = async account => { refreshed.push(account.id); account.updatedAt = new Date().toISOString(); };
  await hub.autoTick(now);
  assert.deepEqual(refreshed, [active.id]);
  inactive.updatedAt = new Date(now - 301000).toISOString();
  refreshed.length = 0;
  await hub.autoTick(now);
  assert.deepEqual(refreshed, [inactive.id]);
});

test('manual mode, a hidden window, a pending login and a switch all suppress automatic requests', async t => {
  const { hub } = await fixture(t);
  const a = auth('one'); hub.upsert(a, identityFromAuth(a));
  hub.updatePresence({ clientId: 'test-window-visible', visible: true });
  let requests = 0; hub.refreshAccount = async () => { requests++; };
  await hub.autoTick(); assert.equal(requests, 0);
  await hub.saveSettings({ refreshMode: 'automatic', activeIntervalSeconds: 60, inactiveIntervalSeconds: 300 });
  hub.updatePresence({ clientId: 'test-window-visible', visible: false });
  await hub.autoTick(); assert.equal(requests, 0);
  hub.updatePresence({ clientId: 'test-window-visible', visible: true });
  hub.login = { status: 'pending' }; await hub.autoTick(); assert.equal(requests, 0);
  hub.login = null; hub.switchJob = { status: 'running' }; await hub.autoTick(); assert.equal(requests, 0);
});

test('a second timer tick cannot overlap an ongoing automatic refresh', async t => {
  const { hub } = await fixture(t);
  const a = auth('one'); hub.upsert(a, identityFromAuth(a));
  await hub.saveSettings({ refreshMode: 'automatic', activeIntervalSeconds: 60, inactiveIntervalSeconds: 300 });
  hub.updatePresence({ clientId: 'test-window-visible', visible: true });
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let requests = 0;
  hub.refreshAccount = async () => { requests++; entered(); await gate; };
  const first = hub.autoTick();
  await started;
  await hub.autoTick();
  assert.equal(requests, 1);
  release(); await first;
});

test('live display name and username are preserved alongside the token name', async t => {
  const { hub } = await fixture(t);
  const a = auth('one'), account = hub.upsert(a, identityFromAuth(a));
  hub.profileReader = async () => ({ profileDisplayName: 'ale89089', profileUsername: 'ale89089' });
  await hub.refreshAccount(account);
  assert.equal(account.accountName, 'Name one');
  assert.equal(account.profileDisplayName, 'ale89089');
  assert.equal(account.profileUsername, 'ale89089');
  hub.upsert(a, identityFromAuth(a));
  assert.equal(account.profileDisplayName, 'ale89089');
  assert.equal(account.authName, 'Name one');
});

test('optional profile failure preserves successful quota data and old profile names', async t => {
  const { hub } = await fixture(t);
  const a = auth('one'), account = hub.upsert(a, identityFromAuth(a));
  account.profileDisplayName = 'Existing profile';
  hub.profileReader = async () => null;
  await hub.refreshAccount(account);
  assert.equal(account.status, 'ok');
  assert.equal(account.profileDisplayName, 'Existing profile');
  assert.equal(account.profileStatus, 'unavailable');
});
