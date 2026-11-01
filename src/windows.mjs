import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/windows.ps1', import.meta.url));
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

export function windows(action, input = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    // pwsh's module path is incompatible with Windows PowerShell 5.1.
    delete env.PSModulePath;
    const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Action', action], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Operazione Windows scaduta.')); }, 30000);
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdin.on('error', () => {});
    child.on('error', () => { clearTimeout(timer); reject(new Error('PowerShell non disponibile.')); });
    child.on('exit', code => {
      clearTimeout(timer);
      if (code !== 0) {
        const error = new Error('Operazione Windows non riuscita (' + action + ').');
        // Launch/stop errors contain OS diagnostics only, never auth material.
        if (action === 'LaunchApp' || action === 'StopApp') error.message += ' ' + stderr.trim().slice(0, 500);
        return reject(error);
      }
      resolve(output.replace(/^\uFEFF/, '').trim());
    });
    child.stdin.end(JSON.stringify(input));
  });
}

export async function protect(value) {
  return windows('Protect', { data: Buffer.from(JSON.stringify(value)).toString('base64') });
}
export async function unprotect(cipher) {
  const plain = await windows('Unprotect', { data: cipher });
  return JSON.parse(Buffer.from(plain, 'base64').toString('utf8'));
}
export async function discover() { return JSON.parse(await windows('Discover')); }
