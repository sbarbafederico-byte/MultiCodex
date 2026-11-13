import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/windows.ps1', import.meta.url));
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

const actionLabels = { Discover: 'rilevamento di Codex', HostStatus: 'verifica del processo indipendente', StopApp: 'chiusura di Codex', LaunchApp: 'apertura di Codex', Protect: 'salvataggio cifrato', Unprotect: 'lettura archivio cifrato', Restrict: 'protezione cartella', OpenLogin: 'apertura accesso' };
export function createWindowsRunner({ spawnProcess = spawn, timeoutMs = 60000 } = {}) {
return function windows(action, input = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    // pwsh's module path is incompatible with Windows PowerShell 5.1.
    delete env.PSModulePath;
    const child = spawnProcess(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Action', action], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      const stage = [...stderr.matchAll(/MULTICODEX_STAGE=(input|execute|permissions|complete)/g)].at(-1)?.[1];
      const stageLabels = { input: 'lettura comando', execute: 'esecuzione comando', permissions: 'applicazione permessi', complete: 'chiusura processo' };
      const error = new Error(`Tempo scaduto durante ${actionLabels[action] || action} (${timeoutMs / 1000} secondi${stage ? '; ' + stageLabels[stage] : '; avvio PowerShell'}).`);
      error.windowsAction = action;
      reject(error);
    }, timeoutMs);
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdin.on('error', () => {});
    child.on('error', () => { clearTimeout(timer); reject(new Error('PowerShell non disponibile.')); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) {
        const error = new Error('Operazione Windows non riuscita (' + action + ').');
        error.windowsAction = action;
        // Launch/stop errors contain OS diagnostics only, never auth material.
        if (action === 'LaunchApp' || action === 'StopApp') error.message += ' ' + stderr.replace(/^MULTICODEX_STAGE=.*\r?\n?/gm, '').trim().slice(0, 500);
        return reject(error);
      }
      resolve(output.replace(/^\uFEFF/, '').trim());
    });
    child.stdin.end(JSON.stringify(input));
  });
};
}
export const windows = createWindowsRunner();

export async function protect(value) {
  return windows('Protect', { data: Buffer.from(JSON.stringify(value)).toString('base64') });
}
export async function unprotect(cipher) {
  const plain = await windows('Unprotect', { data: cipher });
  return JSON.parse(Buffer.from(plain, 'base64').toString('utf8'));
}
const discoveryWindows = createWindowsRunner({ timeoutMs: 15000 });
export async function discover() { return JSON.parse(await discoveryWindows('Discover')); }
