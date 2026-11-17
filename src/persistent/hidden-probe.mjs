import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const [runtime, output, waitSeconds = '310'] = process.argv.slice(2);
const seconds = Number(waitSeconds);
assert(Number.isFinite(seconds) && seconds >= 0 && seconds <= 310);
const connection = JSON.parse(await readFile(path.join(runtime, 'connection.json'), 'utf8'));
const probe = JSON.parse(await readFile(path.join(runtime, 'probe.json'), 'utf8'));
const rpc = async (method, args) => {
  const body = await (await fetch(`${connection.origin}/rpc`, { method: 'POST', headers: { Authorization: `Bearer ${connection.token}` }, body: JSON.stringify({ method, args }), signal: AbortSignal.timeout(10_000) })).json();
  assert(!body.error, JSON.stringify(body.error)); return body.result;
};
const start = Date.now(), deadline = setTimeout(() => { console.error('Hidden-renderer probe exceeded 360 seconds'); process.exit(1); }, 360_000);
try {
  const before = await rpc('status', { sessionId: probe.b.sessionId });
  assert.equal(before.renderer.viewers, 0);
  await new Promise(resolve => setTimeout(resolve, seconds * 1000));
  const marker = randomUUID();
  const result = await rpc('call', { sessionId: probe.b.sessionId, lease: probe.agentB.lease, tool: 'execute', arguments: { input: `SetVariables({"hidden-probe":{type:"string",value:${JSON.stringify(marker)}}});Print(GetVariables());` } });
  assert(!result.isError && JSON.stringify(result).includes(marker));
  const after = await rpc('status', { sessionId: probe.b.sessionId });
  assert.equal(after.renderer.viewers, 0);
  assert.equal(after.renderer.rendererId, before.renderer.rendererId);
  await rpc('save', { sessionId: probe.b.sessionId, lease: probe.agentB.lease });
  const receipt = { status: 'passed', elapsedMs: Date.now() - start, rendererId: after.renderer.rendererId, viewersBefore: 0, viewersAfter: 0, modifiedAndSavedAfterWait: true };
  await writeFile(output, JSON.stringify(receipt, null, 2));
  console.log(receipt);
} finally { clearTimeout(deadline); }
