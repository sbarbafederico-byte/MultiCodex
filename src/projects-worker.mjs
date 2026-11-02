import { parentPort, workerData } from 'node:worker_threads';
import { loadProjectCatalog, scanProjectFiles, readGit, scanRollout } from './projects.mjs';
import { scanCodexStorage } from './project-storage.mjs';
try {
  const catalog = await loadProjectCatalog(workerData.home);
  for (const p of catalog.projects) {
    for (const thread of p.threads) if (!thread.metrics && thread.rolloutPath) {
      try { thread.metrics = (await scanRollout(thread.rolloutPath, { metricsOnly: true })).metrics; } catch {}
    }
  }
  await scanCodexStorage(workerData.home, catalog.projects);
  parentPort.postMessage({ type: 'catalog', projects: catalog.projects, warnings: catalog.warnings });
  for (let i = 0; i < catalog.projects.length; i++) {
    const p = catalog.projects[i];
    const [disk, git] = await Promise.all([scanProjectFiles(p.roots), readGit(p.roots[0])]);
    parentPort.postMessage({ type: 'scanned', id: p.id, disk, git, completed: i + 1, total: catalog.projects.length });
  }
  parentPort.postMessage({ type: 'complete' });
} catch { parentPort.postMessage({ type: 'error', message: 'Non è stato possibile leggere i progetti locali di Codex.' }); }
