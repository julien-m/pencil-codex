import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeNewFile } from '../src/artifacts.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export async function launchLiveDemo(filename, { stateDirectory = path.join(root, '.runtime', 'live-demo', randomUUID()) } = {}) {
  filename = path.resolve(filename);
  if (path.extname(filename).toLowerCase() !== '.pen') throw new Error('Choose a new .pen file');
  const frames = { light: randomUUID(), dark: randomUUID() };
  // Seed the same document format as pencil_new, with both screen frames ready.
  // Agents know their IDs before the editor loads; no canvas query is needed.
  await writeNewFile(filename, Buffer.from(JSON.stringify({ version: '2.6', children: [
    { type: 'frame', id: frames.light, name: 'Agent A — Login clair', x: 0, y: 0, width: 1000, height: 760, layout: 'vertical', gap: 24, alignItems: 'start', fill: '#F6F4EF' },
    { type: 'frame', id: frames.dark, name: 'Agent B — Login sombre', x: 1120, y: 0, width: 1000, height: 760, layout: 'vertical', gap: 24, alignItems: 'start', fill: '#10131D' }
  ] })));
  await fs.mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const statePath = path.join(stateDirectory, 'session.json');
  const child = spawn(process.execPath, [path.join(root, 'src/preview.mjs'), filename], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] });
  const metadata = { documentPath: filename, frames, statePath };
  const ready = new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Preview startup timeout')); }, 10000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Preview exited before ready: ${code}`)); });
    child.stdout.on('data', bytes => {
      buffer += bytes.toString();
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      void (async () => {
        try {
          const info = JSON.parse(line);
          await fs.writeFile(statePath, JSON.stringify({ ...info, ...metadata }), { flag: 'wx', mode: 0o600 });
          clearTimeout(timer);
          resolve({ ...metadata, url: info.url, sessionId: info.sessionId });
        } catch (error) { clearTimeout(timer); child.kill('SIGTERM'); reject(error); }
      })();
    });
  });
  return { ...metadata, child, ready };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const demo = await launchLiveDemo(process.argv[2] ?? 'live-login-demo.pen');
    // Only public routing metadata goes to stdout; connection tokens stay private.
    console.log(JSON.stringify({ event: 'prepared', documentPath: demo.documentPath, frames: demo.frames, statePath: demo.statePath }));
    let stopping = false, started = false;
    const stop = () => { stopping = true; demo.child.kill('SIGTERM'); };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    demo.child.on('exit', code => {
      process.exitCode ??= stopping ? 0 : code ?? 1;
      if (started || stopping) process.exit(process.exitCode);
    });
    const ready = await demo.ready; started = true;
    console.log(JSON.stringify({ event: 'preview-ready', ...ready }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
