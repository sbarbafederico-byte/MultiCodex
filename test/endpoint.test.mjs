import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadEndpoint, listenLocal, saveEndpoint, validEndpoint } from '../src/endpoint.mjs';

async function directory(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'multicodex-endpoint-test-'));
  t.after(async () => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(root).startsWith('multicodex-endpoint-test-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}
async function close(server) {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

test('an open client keeps its origin and authorization after a full server restart', async t => {
  const root = await directory(t);
  const first = await loadEndpoint(root);
  const serve = endpoint => http.createServer((req, res) => {
    res.writeHead(req.headers.authorization === 'Bearer ' + endpoint.token ? 200 : 401);
    res.end('ok');
  });
  const firstServer = serve(first);
  const bound = await listenLocal(firstServer, first);
  await saveEndpoint(root, bound);
  const oldWindowUrl = `http://127.0.0.1:${bound.port}/api/login`;
  const headers = { Authorization: 'Bearer ' + bound.token };
  assert.equal((await fetch(oldWindowUrl, { method: 'POST', headers })).status, 200);
  await close(firstServer);
  const next = await loadEndpoint(root);
  assert.deepEqual(next, bound);
  const secondServer = serve(next);
  await listenLocal(secondServer, next);
  try {
    assert.equal((await fetch(oldWindowUrl, { method: 'POST', headers })).status, 200);
    assert.equal((await fetch(oldWindowUrl)).status, 401);
  } finally { await close(secondServer); }
});

test('the first upgrade preserves the previous runtime endpoint', async t => {
  const root = await directory(t);
  const previous = { port: 50001, token: 'a'.repeat(64), pid: 1234 };
  await fs.writeFile(path.join(root, 'runtime.json'), JSON.stringify(previous));
  assert.deepEqual(await loadEndpoint(root), { port: previous.port, token: previous.token });
});

test('stable endpoint takes precedence over a stale runtime record', async t => {
  const root = await directory(t);
  const stable = { port: 50002, token: 'b'.repeat(64) };
  await saveEndpoint(root, stable);
  await fs.writeFile(path.join(root, 'runtime.json'), JSON.stringify({ port: 50003, token: 'c'.repeat(64) }));
  assert.deepEqual(await loadEndpoint(root), stable);
});

test('occupied port rejects cleanly instead of crashing or silently changing origin', async () => {
  const endpoint = { port: 0, token: 'd'.repeat(64) };
  const first = http.createServer();
  const bound = await listenLocal(first, endpoint);
  const second = http.createServer();
  try { await assert.rejects(listenLocal(second, bound), { code: 'EADDRINUSE' }); }
  finally { await close(first); second.close(); }
});

test('invalid endpoints are rejected before credentials can be sent', async t => {
  const root = await directory(t);
  assert.equal(!!validEndpoint({ port: -1, token: 'a'.repeat(64) }), false);
  assert.equal(!!validEndpoint({ port: 50000, token: 'bad' }), false);
  await fs.writeFile(path.join(root, 'endpoint.json'), '{"port":-1,"token":"invalid"}');
  await assert.rejects(loadEndpoint(root), /non valido/);
});
