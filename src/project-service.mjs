import { Worker } from 'node:worker_threads';
import { summarizeProject, readConversation } from './projects.mjs';

export class ProjectService {
  constructor(home) {
    this.home = home; this.projects = []; this.warnings = []; this.status = 'idle'; this.completed = 0; this.total = 0; this.updatedAt = null; this.error = null;
  }
  snapshot() {
    return { status: this.status, completed: this.completed, total: this.total, updatedAt: this.updatedAt, error: this.error, warnings: this.warnings, projects: this.projects.map(summarizeProject) };
  }
  scan() {
    if (this.status === 'scanning' || this.worker) return this.snapshot();
    this.status = 'scanning'; this.completed = 0; this.error = null;
    const worker = new Worker(new URL('./projects-worker.mjs', import.meta.url), { workerData: { home: this.home } });
    this.worker = worker;
    worker.on('message', msg => {
      if (msg.type === 'catalog') { this.projects = msg.projects; this.warnings = msg.warnings; this.total = msg.projects.length; }
      else if (msg.type === 'scanned') { const p = this.projects.find(p => p.id === msg.id); if (p) Object.assign(p, { disk: msg.disk, git: msg.git }); this.completed = msg.completed; }
      else if (msg.type === 'complete') { this.status = 'ready'; this.updatedAt = new Date().toISOString(); }
      else if (msg.type === 'error') { this.status = 'error'; this.error = msg.message; }
    });
    worker.on('error', () => { this.status = 'error'; this.error = 'Lettura progetti interrotta. Premi Aggiorna progetti per riprovare.'; });
    worker.on('exit', () => { if (this.worker === worker) this.worker = null; if (this.status === 'scanning') { this.status = 'error'; this.error = 'La scansione si è interrotta prima del completamento.'; } });
    return this.snapshot();
  }
  find(id) { const p = this.projects.find(p => p.id === id); if (!p) throw new Error('Progetto non trovato.'); return p; }
  detail(id) {
    const p = this.find(id);
    return { ...summarizeProject(p), threads: p.threads.filter(t => !t.isAgent).map(t => ({ id: t.id, title: t.title || 'Conversazione senza titolo', firstActivityAt: t.metrics?.firstPromptAt || null, updatedAt: t.updatedAt, archived: t.archived, model: t.model || null, tokens: t.tokens || 0, metrics: t.metrics, storage: { files: p.codexStorage?.files.filter(f => f.threadIds.includes(t.id)) || [], databases: p.codexStorage?.stores.filter(s => s.threadIds.includes(t.id)).map(s => ({ path: s.path, kind: s.kind })) || [] } } )) };
  }
  async conversation(projectId, threadId, before) { return readConversation(this.home, this.find(projectId), threadId, before); }
  async close() { await this.worker?.terminate(); }
}
