import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { WebSocket } from 'ws';

const [runtime, output] = process.argv.slice(2);
const connection = JSON.parse(await readFile(path.join(runtime, 'connection.json'), 'utf8'));
const probe = JSON.parse(await readFile(path.join(runtime, 'probe.json'), 'utf8'));
const request = async (method, args, token = connection.token) => {
  const response = await fetch(`${connection.origin}/rpc`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ method, args }), signal: AbortSignal.timeout(10_000) });
  return { status: response.status, body: await response.json() };
};
assert.equal((await request('status', { sessionId: probe.a.sessionId }, 'invalid')).status, 401);
const crossLease = await request('call', { sessionId: probe.b.sessionId, lease: probe.agent1.lease, tool: 'execute', arguments: { input: 'Print(GetVariables());' } });
assert(crossLease.body.error, 'A session A participation token must not authorize a session B call');
const scopeConflict = await request('open', { path: path.join(runtime, 'documents', `${probe.a.scope}-0.pen`), scope: probe.b.scope });
assert.equal(scopeConflict.body.error.code, 'DOCUMENT_BUSY');
const params = new URLSearchParams(new URL(probe.a.viewURL).hash.slice(1));
params.set('session', probe.b.sessionId);
const url = new URL('/view', connection.origin); url.protocol = 'ws:'; url.search = params.toString();
const socket = new WebSocket(url, { origin: connection.origin });
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => { socket.terminate(); reject(new Error('Cross-session view rejection did not complete')); }, 2000);
  socket.once('open', () => { clearTimeout(timer); socket.terminate(); reject(new Error('A view grant authorized another session')); });
  socket.once('error', () => { clearTimeout(timer); resolve(); });
});
await writeFile(output, JSON.stringify({ status: 'passed', badAdminTokenRejected: true, crossSessionLeaseRejected: true, duplicateDocumentOwnerRejected: true, crossSessionViewGrantRejected: true }, null, 2));
console.log('PASS: admin authentication, document ownership, participation and view grants remain isolated');
