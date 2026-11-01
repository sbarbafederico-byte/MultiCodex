import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { protect, unprotect, windows } from './windows.mjs';

export async function atomicWrite(file, text) {
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    await fs.writeFile(temporary, text, { mode: 0o600 });
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
}

export class Vault {
  constructor(root) {
    this.root = root;
    this.file = path.join(root, 'accounts.dpapi');
    this.data = { version: 1, accounts: [] };
  }
  async load() {
    await fs.mkdir(this.root, { recursive: true });
    await windows('Restrict', { path: this.root });
    try { this.data = await unprotect(await fs.readFile(this.file, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Archivio account non leggibile. Non è stato sovrascritto. Conserva accounts.dpapi e accounts.dpapi.bak.');
    }
    if (this.data.version !== 1 || !Array.isArray(this.data.accounts)) throw new Error('Formato archivio non supportato.');
    await fs.mkdir(path.join(this.root, 'work'), { recursive: true });
    await fs.mkdir(path.join(this.root, 'browser'), { recursive: true });
  }
  async save() {
    const cipher = await protect(this.data);
    await fs.copyFile(this.file, this.file + '.bak').catch(error => { if (error.code !== 'ENOENT') throw error; });
    await atomicWrite(this.file, cipher);
  }
  find(id) {
    const account = this.data.accounts.find(a => a.id === id);
    if (!account) throw new Error('Account non trovato.');
    return account;
  }
  async createWork() { return fs.mkdtemp(path.join(this.root, 'work', 'session-')); }
  async removeWork(directory) {
    const root = path.resolve(this.root, 'work') + path.sep;
    const resolved = path.resolve(directory);
    if (!resolved.startsWith(root) || resolved === root.slice(0, -1)) throw new Error('Cartella temporanea non valida.');
    await fs.rm(resolved, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 });
  }
  async cleanWork() {
    for (const item of await fs.readdir(path.join(this.root, 'work'), { withFileTypes: true })) {
      if (item.isDirectory() && item.name.startsWith('session-')) await this.removeWork(path.join(this.root, 'work', item.name));
    }
  }
}
