import { parentPort, workerData } from 'node:worker_threads';
import { DashboardReader } from './dashboard.mjs';
const reader = new DashboardReader(workerData.home);
parentPort.on('message', async () => {
  try { parentPort.postMessage(await reader.read()); }
  catch { parentPort.postMessage({ active: [], recent: [], uncertain: [], updatedAt: null, error: 'Aggiornamento Home non riuscito. Riprova tra qualche secondo.', warnings: [] }); }
});
