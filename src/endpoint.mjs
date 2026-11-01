import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { atomicWrite } from './vault.mjs';

export function validEndpoint(value) {
  return value && Number.isInteger(value.port) && value.port > 0 && value.port <= 65535 &&
    typeof value.token === 'string' && /^[a-f0-9]{64}$/.test(value.token);
}

export async function loadEndpoint(root) {
  // Keep the same origin and secret across restarts, so open windows stay connected.
  for (const filename of ['endpoint.json', 'runtime.json']) {
    try {
      const value = JSON.parse((await fs.readFile(path.join(root, filename), 'utf8')).replace(/^\uFEFF/, ''));
      if (!validEndpoint(value)) throw new Error('Indirizzo locale MultiCodex non valido.');
      return { port: value.port, token: value.token };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return { port: 0, token: randomBytes(32).toString('hex') };
}

export async function listenLocal(server, endpoint) {
  await new Promise((resolve, reject) => {
    const error = err => { server.off('listening', ready); reject(err); };
    const ready = () => { server.off('error', error); resolve(); };
    server.once('error', error);
    server.once('listening', ready);
    server.listen(endpoint.port, '127.0.0.1');
  });
  return { port: server.address().port, token: endpoint.token };
}

export async function saveEndpoint(root, endpoint) {
  if (!validEndpoint(endpoint)) throw new Error('Indirizzo locale MultiCodex non valido.');
  await atomicWrite(path.join(root, 'endpoint.json'), JSON.stringify(endpoint));
}
