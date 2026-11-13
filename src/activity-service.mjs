import { Worker } from 'node:worker_threads';

export class ActivityService {
  constructor(home, { WorkerClass = Worker, timeoutMs = 30000 } = {}) {
    this.home = home; this.Worker = WorkerClass; this.timeoutMs = timeoutMs;
    this.inFlight = null;
  }
  readFresh() {
    if (this.inFlight) return this.inFlight;
    const operation = new Promise((resolve, reject) => {
      const worker = this.worker = new this.Worker(new URL('./activity-worker.mjs', import.meta.url), {
        workerData: { home: this.home }, execArgv: [],
      });
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (this.worker === worker) this.worker = null;
        worker.terminate().catch(() => {});
        if (error) reject(error); else resolve(value);
      };
      const timer = setTimeout(() => finish(new Error('Lettura dei turni attivi scaduta. Codex non è stato chiuso. Riprova il cambio.')), this.timeoutMs);
      worker.once('message', result => finish(result.ok ? null : new Error('Catalogo dei turni Codex non leggibile. Codex non è stato chiuso. Riprova il cambio.'), result.value));
      worker.once('error', () => finish(new Error('Il lettore dei turni Codex si è interrotto. Codex non è stato chiuso. Riprova il cambio.')));
      worker.once('exit', () => finish(new Error('Il lettore dei turni Codex si è chiuso prima della risposta. Riprova il cambio.')));
    });
    const pending = operation.finally(() => { if (this.inFlight === pending) this.inFlight = null; });
    this.inFlight = pending;
    return pending;
  }
  async close() { await this.worker?.terminate(); }
}
