import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createWindowsRunner } from '../src/windows.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';

const windowsEnvironment = { ...process.env };
delete windowsEnvironment.PSModulePath;

function processStub() {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => { child.killed = true; };
  return child;
}
test('Windows timeout identifies the operation without echoing private input or stderr', async () => {
  const child = processStub();
  const run = createWindowsRunner({ spawnProcess: () => child, timeoutMs: 20 });
  child.stderr.write('private-token');
  await assert.rejects(run('StopApp', { token: 'private-token' }), error => {
    assert.equal(error.windowsAction, 'StopApp');
    assert.match(error.message, /chiusura di Codex/);
    assert.ok(!error.message.includes('private-token'));
    return true;
  });
  assert.equal(child.killed, true);
});
test('Windows waits for drained output instead of resolving on process exit', async () => {
  const child = processStub();
  const run = createWindowsRunner({ spawnProcess: () => child, timeoutMs: 1000 });
  const result = run('Discover');
  child.emit('exit', 0);
  child.stdout.write('{"appRunning":true}');
  child.emit('close', 0);
  assert.equal(await result, '{"appRunning":true}');
});
test('timeout reports the last known Windows phase without including arbitrary stderr', async () => {
  const child = processStub();
  const run = createWindowsRunner({ spawnProcess: () => child, timeoutMs: 20 });
  const result = run('Restrict');
  child.stderr.write('MULTICODEX_STAGE=input\nMULTICODEX_STAGE=permissions\nprivate-token');
  await assert.rejects(result, error => {
    assert.match(error.message, /applicazione permessi/);
    assert.ok(!error.message.includes('private-token'));
    return true;
  });
});
test('credential operations do not expose upstream stderr on failure', async () => {
  const child = processStub();
  const run = createWindowsRunner({ spawnProcess: () => child, timeoutMs: 1000 });
  const result = run('Unprotect');
  child.stderr.write('private-token'); child.emit('close', 1);
  await assert.rejects(result, error => !error.message.includes('private-token'));
});

test('discovery timeout identifies its last reader phase and ignores unknown phases', async () => {
  const child = processStub();
  const run = createWindowsRunner({ spawnProcess: () => child, timeoutMs: 20 });
  const result = run('Discover');
  child.stderr.write('MULTICODEX_STAGE=execute\nMULTICODEX_STAGE=compile-process-reader\nMULTICODEX_STAGE=private-token\n');
  await assert.rejects(result, error => {
    assert.equal(error.windowsAction, 'Discover');
    assert.match(error.message, /compilazione lettore processi/);
    assert.ok(!error.message.includes('private-token'));
    return true;
  });
});

test('production Windows interop definitions compile in Windows PowerShell', { skip: process.platform !== 'win32' }, async () => {
  const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const script = fileURLToPath(new URL('../scripts/Test-WindowsInterop.ps1', import.meta.url));
  const result = await promisify(execFile)(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: true, env: windowsEnvironment, timeout: 60000 });
  assert.match(result.stdout, /Entrambi i blocchi C# compilati/);
});

test('production StopApp compiles and exits successfully when no process matches the verified path', { skip: process.platform !== 'win32' }, async () => {
  const run = createWindowsRunner();
  // A deliberately nonexistent package: this executes the production branch
  // and compiles its C# without closing the user's desktop.
  const result = await run('StopApp', { path: 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_MultiCodexDiagnostic_x64__test\\app\\ChatGPT.exe' });
  assert.equal(JSON.parse(result).ok, true);
});

test('Windows desktop shutdown follows replacement PIDs and waits for a real process to terminate', { skip: process.platform !== 'win32' }, async () => {
  const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const script = fileURLToPath(new URL('../scripts/Test-DesktopStop.ps1', import.meta.url));
  const result = await promisify(execFile)(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: true, env: windowsEnvironment, timeout: 60000 });
  assert.match(result.stdout, /Chiusura verificata/);
});

test('restricting an already private data directory leaves its ACL unchanged', { skip: process.platform !== 'win32' }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'multicodex-acl-'));
  t.after(async () => {
    const resolved = path.resolve(dir);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(resolved).startsWith('multicodex-acl-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const run = createWindowsRunner();
  assert.equal(JSON.parse(await run('Restrict', { path: dir })).ok, true);
  assert.equal(JSON.parse(await run('Restrict', { path: dir })).unchanged, true);
});

test('native snapshot detects real processes and distinguishes desktop roots from renderers', { skip: process.platform !== 'win32' }, async () => {
  const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const script = fileURLToPath(new URL('../scripts/Test-ProcessSnapshot.ps1', import.meta.url));
  const result = await promisify(execFile)(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: true, env: windowsEnvironment, timeout: 60000 });
  assert.match(result.stdout, /Snapshot nativo verificato/);
});
