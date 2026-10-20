import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { launchLiveDemo } from '../scripts/live-demo.mjs';

test('live demo exposes fresh frame IDs before preview startup without a canvas preparation call', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pencil-fast-demo-'));
  let demo;
  try {
    const filename = path.join(directory, 'demo.pen');
    const started = Date.now();
    demo = await launchLiveDemo(filename, { stateDirectory: path.join(directory, 'private') });
    assert.notEqual(demo.frames.light, demo.frames.dark);
    assert.equal(typeof demo.frames.light, 'string');
    const ready = await demo.ready;
    const privateState = JSON.parse(await fs.readFile(ready.statePath, 'utf8'));
    assert.equal((await fs.stat(ready.statePath)).mode & 0o777, 0o600);
    assert.deepEqual(privateState.frames, demo.frames);
    assert.equal(privateState.sessionId, ready.sessionId);
    assert(!JSON.stringify(ready).includes(privateState.brokerToken));
    assert.equal((await fetch(ready.url)).status, 200);
    await assert.rejects(launchLiveDemo(filename), { code: 'EEXIST' });
    console.log(`Prepared frames and local preview ready in ${Date.now() - started} ms (hosted engine loads separately)`);
  } finally {
    if (demo?.child.exitCode === null) { const stopped = once(demo.child, 'exit'); demo.child.kill('SIGTERM'); await stopped; }
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('CLI reports startup failure even when the terminated preview exits successfully', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pencil-demo-failure-'));
  const preload = `import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';const original=fs.writeFile;fs.writeFile=async(file,...args)=>{if(String(file).endsWith('/session.json'))throw Object.assign(new Error('injected ENOSPC session.json'),{code:'ENOSPC'});return original(file,...args)};syncBuiltinESMExports();`;
  try {
    let failure;
    try { await promisify(execFile)(process.execPath,['--import','data:text/javascript,'+encodeURIComponent(preload),'scripts/live-demo.mjs',path.join(directory,'demo.pen')],{timeout:1500}); }
    catch(error) { failure=error; }
    assert.equal(failure?.code,1);
    assert(failure.stderr.includes('injected ENOSPC session.json'));
    assert(!failure.stdout.includes('preview-ready'));
  } finally { await fs.rm(directory,{recursive:true,force:true}); }
});
