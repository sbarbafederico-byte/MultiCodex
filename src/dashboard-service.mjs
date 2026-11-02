import { Worker } from 'node:worker_threads';
export class DashboardService {
  constructor(home) { this.home = home; this.value = { active: [], recent: [], uncertain: [], updatedAt: null, error: null, warnings: [] }; this.lastRead = 0; this.loading = false; }
  snapshot() {
    if (!this.loading && Date.now() - this.lastRead >= 1500) {
      if (!this.worker) {
        const worker = this.worker = new Worker(new URL('./dashboard-worker.mjs', import.meta.url), { workerData: { home: this.home } });
        worker.on('message', value => { this.value = value; this.lastRead = Date.now(); this.loading = false; });
        worker.on('error', () => { this.loading = false; this.lastRead = Date.now(); this.value.error = 'Lettura Home interrotta. Nuovo tentativo automatico.'; });
        worker.on('exit', () => { if (this.worker === worker) this.worker = null; this.loading = false; });
      }
      this.loading = true; this.worker.postMessage('read');
    }
    return { ...this.value, loading: this.loading };
  }
  async close() { await this.worker?.terminate(); }
}
