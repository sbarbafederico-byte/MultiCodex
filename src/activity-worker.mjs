import { parentPort, workerData } from 'node:worker_threads';
import { readActivity } from './activity.mjs';
try {
  parentPort.postMessage({ ok: true, value: readActivity(workerData.home) });
} catch (error) {
  // Report only a stable diagnostic code, never database contents or raw errors.
  parentPort.postMessage({ ok: false, reason: error.code === 'ERR_SQLITE_ERROR' ? 'database' : 'read' });
}
