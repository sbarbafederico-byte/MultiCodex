import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Continuity, selectNextAccount, exhausted } from '../src/continuity.mjs';
import { DEFAULT_SETTINGS, validateSettings } from '../src/settings.mjs';

function account(id, fiveHour, weekly) {
  return { id, key: id, auth: {}, status: 'ok', updatedAt: new Date().toISOString(), lastAttemptAt: new Date().toISOString(), limits: { fiveHour: { remaining: fiveHour }, weekly: { remaining: weekly } } };
}
const active = () => ({ active: [{ threadId: 'thread', id: 'original' }], recent: [], updatedAt: new Date().toISOString() });
function fixture({ mode = 'automatic', activity = active, rejectStart = false } = {}) {
  const calls = [];
  const settings = { ...DEFAULT_SETTINGS, switchMode: mode };
  const accounts = [account('a', 0, 30), account('b', 70, 20), account('c', 30, 90)];
  const hub = {
    settings: () => settings, activeKey: 'a', desktopHome: 'desktop', runtime: { cliPath: 'fake' },
    vault: { data: { accounts }, save: async () => { calls.push('save'); } },
    exclusive: async (_, action) => action(), syncCurrent: async () => {},
    refreshAccount: async a => { calls.push('refresh:' + a.id); },
    performSwitch: async (id, { beforeStop } = {}) => { if (beforeStop && await beforeStop() === false) return false; calls.push('switch:' + id); hub.activeKey = id; },
    Rpc: class extends EventEmitter {
      async initialize() { calls.push('initialize'); }
      async request(method, params) {
        calls.push({ method, params });
        if (method === 'thread/resume') return { thread: { id: params.threadId, status: { type: 'idle' } } };
        if (rejectStart) throw new Error('Response lost');
        return { turn: { id: 'continued' } };
      }
      async close() { calls.push('close'); }
    },
  };
  const controller = new Continuity(hub, async () => activity());
  return { hub, controller, calls, settings, accounts };
}

test('settings migrate to manual switching and reject invalid modes, strategies and duplicate order', () => {
  const legacy = { refreshMode: 'manual', activeIntervalSeconds: 60, inactiveIntervalSeconds: 300 };
  assert.deepEqual(validateSettings(legacy), DEFAULT_SETTINGS);
  for (const invalid of [{ switchMode: 'unknown' }, { switchStrategy: 'unknown' }, { accountOrder: ['a', 'a'] }, { accountOrder: [1] }]) assert.throws(() => validateSettings({ ...legacy, ...invalid }));
});
test('selection ranks independent quotas, rotates both orders and appends new accounts', () => {
  const accounts = [account('a', 0, 40), account('b', 80, 10), account('c', 30, 90), account('d', 20, 20)];
  const choose = (switchStrategy, accountOrder = [], key = 'a') => selectNextAccount(accounts, key, { switchStrategy, accountOrder })?.id;
  assert.equal(choose('fiveHour'), 'b');
  assert.equal(choose('weekly'), 'c');
  assert.equal(choose('ordered', [], 'c'), 'd');
  assert.equal(choose('ordered', [], 'd'), 'b');
  assert.equal(choose('custom', ['a', 'c', 'b']), 'c');
  assert.equal(choose('custom', ['a', 'c', 'b'], 'b'), 'd');
  accounts[2].limits.fiveHour.remaining = 80;
  assert.equal(choose('fiveHour'), 'b');
});
test('selection excludes exhausted, failed, unknown, stale and reset samples', () => {
  const accounts = [account('a', 0, 70), account('b', 100, 0), account('c', null, 100), account('d', 90, 90), account('e', 90, 90), account('f', 80, 80)];
  accounts[3].updatedAt = new Date(Date.now() - 180000).toISOString();
  accounts[4].limits.fiveHour.resetsAt = Date.now() / 1000 - 1;
  accounts[5].status = 'reauth';
  assert.equal(selectNextAccount(accounts, 'a', DEFAULT_SETTINGS), null);
  assert.equal(exhausted(accounts[0]), true);
  accounts[0].limits.weekly.remaining = null;
  assert.equal(exhausted(accounts[0]), true);
});
test('automatic switching works independently of manual refresh and resumes the same thread exactly once', async () => {
  const { controller, hub, calls } = fixture();
  await controller.tick();
  assert.ok(calls.includes('switch:b'));
  assert.ok(calls.indexOf('refresh:b') < calls.indexOf('switch:b'));
  const requests = calls.filter(c => c.method);
  assert.deepEqual(requests.map(c => c.method), ['thread/resume', 'turn/start']);
  assert.ok(requests.every(c => c.params.threadId === 'thread'));
  assert.equal(hub.vault.data.continuity.tasks[0].state, 'submitted');
  assert.ok(controller.owned.has('thread'));
  await controller.tick();
  assert.equal(calls.filter(c => c.method === 'turn/start').length, 1);
  await controller.close();
});
test('manual switching default, login, journal and busy states prevent an automatic switch', async () => {
  for (const state of ['manual', 'login', 'journal', 'busy']) {
    const { hub, controller, calls } = fixture({ mode: state === 'manual' ? 'manual' : 'automatic' });
    if (state === 'login') hub.login = { status: 'pending' };
    if (state === 'journal') hub.vault.data.switchJournal = {};
    if (state === 'busy') hub.busy = 'refresh';
    await controller.tick();
    assert.ok(!calls.some(c => typeof c === 'string' && c.startsWith('switch:')));
  }
});
test('no candidate preserves the running task; completion during refresh prevents replay', async () => {
  const empty = fixture();
  empty.accounts[1].limits.weekly.remaining = 0; empty.accounts[2].status = 'reauth';
  await empty.controller.tick();
  assert.equal(empty.hub.continuityStatus.status, 'waiting');
  assert.ok(!empty.calls.includes('close'));
  let reads = 0;
  const done = fixture({ activity: () => ++reads === 1 ? active() : { ...active(), active: [], recent: [{ threadId: 'thread', id: 'original', status: 'completed' }] } });
  await done.controller.tick();
  assert.ok(!done.calls.includes('switch:b'));
});
test('a lost turn/start response is fenced durably and cannot be automatically replayed', async () => {
  const { controller, hub, calls } = fixture({ rejectStart: true });
  await controller.tick();
  assert.equal(hub.vault.data.continuity.tasks[0].state, 'submitting');
  assert.equal(hub.continuityStatus.status, 'error');
  await controller.resume();
  assert.equal(calls.filter(c => c.method === 'turn/start').length, 1);
  await assert.rejects(controller.prepare([{ threadId: 'thread', state: 'pending' }]));
  await controller.close();
});
test('only quota failures are captured for continuation; user cancellations stay stopped', async () => {
  const { controller } = fixture({ activity: () => ({ ...active(), active: [], recent: [
    { threadId: 'limit', id: '1', status: 'failed', limitReached: true, completedAt: new Date().toISOString() },
    { threadId: 'cancelled', id: '2', status: 'interrupted', completedAt: new Date().toISOString() },
    { threadId: 'error', id: '3', status: 'failed', completedAt: new Date().toISOString() },
  ] }) });
  assert.deepEqual((await controller.capture()).map(t => t.threadId), ['limit']);
});
test('overlapping ticks do not duplicate account switches', async () => {
  const { controller, calls } = fixture();
  await Promise.all([controller.tick(), controller.tick(), controller.tick()]);
  assert.equal(calls.filter(c => c === 'switch:b').length, 1);
  await controller.close();
});

test('a completion during Windows preflight cancels the switch, and shutdown completion skips continuation', async () => {
  let reads = 0;
  const finished = () => ({ ...active(), active: [], recent: [{ threadId: 'thread', id: 'original', status: 'completed' }] });
  const preflight = fixture({ activity: () => ++reads < 3 ? active() : finished() });
  await preflight.controller.tick();
  assert.ok(!preflight.calls.includes('switch:b'));
  reads = 0;
  const shutdown = fixture({ activity: () => ++reads < 4 ? active() : finished() });
  await shutdown.controller.tick();
  assert.ok(shutdown.calls.includes('switch:b'));
  assert.ok(!shutdown.calls.some(c => c.method === 'turn/start'));
  assert.equal(shutdown.hub.vault.data.continuity.tasks[0].state, 'skipped');
});

test('an already continued quota failure is not replayed from a stale activity snapshot', async () => {
  const { hub, controller } = fixture({ activity: () => ({ ...active(), active: [], recent: [{ threadId: 'thread', id: 'original', status: 'failed', limitReached: true, completedAt: new Date().toISOString() }] }) });
  hub.vault.data.continuity = { tasks: [{ originalTurnId: 'original', state: 'submitted' }] };
  assert.deepEqual(await controller.capture(), []);
});
