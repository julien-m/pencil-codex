import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
export const root = fileURLToPath(new URL('../', import.meta.url));
export async function connectBroker(directory = process.env.PLUGIN_DATA ?? path.join(root, '.runtime')) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const connection = path.join(directory, 'connection.json');
  const read = async () => {
    try {
      const info = JSON.parse(await fs.readFile(connection, 'utf8'));
      const response = await fetch(`http://127.0.0.1:${info.port}/rpc`, { method: 'POST', headers: { Authorization: `Bearer ${info.token}` }, body: JSON.stringify({ method: 'ping' }), signal: AbortSignal.timeout(1000) });
      if (!response.ok || (await response.json()).result?.version !== '0.2.0') return null;
      return info;
    } catch { return null; }
  };
  let info = await read();
  if (!info) {
    const lock = path.join(directory, 'starting');
    let ownLock = false;
    try { await fs.mkdir(lock); ownLock = true; } catch (e) { if (e.code !== 'EEXIST') throw e; }
    if (ownLock) {
      const child = spawn(process.execPath, [path.join(root, 'dist/daemon.mjs'), directory], { detached: true, stdio: 'ignore' }); child.unref();
    }
    try {
      const deadline = Date.now() + 7000;
      while (!info && Date.now() < deadline) { await new Promise(r => setTimeout(r, 50)); info = await read(); }
      if (!info) throw new Error(`Broker indisponible. Vérifier le runtime ; verrou éventuel : ${lock}`);
    } finally { if (ownLock) await fs.rmdir(lock).catch(() => {}); }
  }
  return {
    ...info,
    async rpc(method, args = {}) {
      const response = await fetch(`http://127.0.0.1:${info.port}/rpc`, { method: 'POST', headers: { Authorization: `Bearer ${info.token}` }, body: JSON.stringify({ method, args }), signal: AbortSignal.timeout(22000) });
      if (!response.ok) throw new Error(`Broker HTTP ${response.status}`);
      const data = await response.json();
      if (data.error) throw Object.assign(new Error(data.error.message), { code: data.error.code });
      return data.result;
    }
  };
}
