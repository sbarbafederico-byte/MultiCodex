import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';

export class CodexRpc extends EventEmitter {
  constructor(executable, home) {
    super();
    this.pending = new Map();
    this.counter = 0;
    this.closed = false;
    const env = { ...process.env, CODEX_HOME: home };
    for (const name of Object.keys(env)) {
      if (/^(OPENAI_API_KEY|CODEX_ACCESS_TOKEN|CODEX_SQLITE_HOME|CODEX_APP_SERVER_|CODEX_REFRESH_TOKEN_URL_OVERRIDE|CODEX_REVOKE_TOKEN_URL_OVERRIDE)/.test(name)) delete env[name];
    }
    this.child = spawn(executable, ['app-server', '--stdio', '-c', 'cli_auth_credentials_store="file"'], {
      env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    // stderr may contain private data; deliberately never persist or forward it.
    this.child.stderr.resume();
    this.child.stdin.on('error', () => {});
    this.child.on('error', () => this.fail(new Error('Impossibile avviare il motore Codex.')));
    this.child.on('exit', () => this.fail(new Error('Il motore Codex si è chiuso.')));
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', line => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.id !== undefined && msg.method) {
        this.emit('serverRequest', { method: msg.method, params: msg.params });
        this.send({ id: msg.id, error: { code: -32601, message: 'Unsupported request' } });
      } else if (msg.id !== undefined) {
        const pending = this.pending.get(msg.id);
        if (!pending) return;
        this.pending.delete(msg.id);
        clearTimeout(pending.timer);
        if (msg.error) {
          const err = new Error('Richiesta Codex non riuscita.');
          err.rpcCode = msg.error.code;
          // Keep upstream details in memory only, for classification, never send to browser.
          err.upstream = String(msg.error.message || '');
          pending.reject(err);
        } else pending.resolve(msg.result);
      } else if (msg.method) this.emit(msg.method, msg.params);
    });
  }
  send(message) {
    if (!this.closed && this.child.stdin.writable) this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  request(method, params = {}, timeout = 35000) {
    if (this.closed) return Promise.reject(new Error('Motore Codex non disponibile.'));
    const id = ++this.counter;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Codex non ha risposto in tempo. Riprova.'));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }
  async initialize() {
    const result = await this.request('initialize', {
      clientInfo: { name: 'multicodex', title: 'MultiCodex', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    this.send({ method: 'initialized', params: {} });
    return result;
  }
  fail(error) {
    this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
    this.emit('disconnected');
  }
  async close() {
    if (this.closed) return;
    this.child.stdin.end();
    await Promise.race([
      new Promise(resolve => this.child.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, 1500)),
    ]);
    if (!this.closed) this.child.kill();
    this.lines.close();
    this.fail(new Error('Connessione chiusa.'));
  }
}
