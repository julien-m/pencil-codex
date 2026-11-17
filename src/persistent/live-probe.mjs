import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { WebSocket } from 'ws';

const [connectionPath, output] = process.argv.slice(2);
assert(connectionPath && output, 'Pass connection.json and an output receipt path');
const connection = JSON.parse(await readFile(connectionPath, 'utf8'));
const root = path.join(path.dirname(path.resolve(connectionPath)), 'documents');
await mkdir(root, { recursive: true });
const receipts = [], sockets = new Set();
const deadline = setTimeout(() => { for (const socket of sockets) socket.terminate(); console.error('Live probe exceeded 180 seconds'); process.exitCode = 1; }, 180_000);
async function rpc(method, args = {}) {
  const response = await fetch(`${connection.origin}/rpc`, { method: 'POST', headers: { Authorization: `Bearer ${connection.token}` }, body: JSON.stringify({ method, args }), signal: AbortSignal.timeout(85_000) });
  const body = await response.json();
  assert(!body.error, JSON.stringify(body.error));
  receipts.push({ method, time: new Date().toISOString(), status: response.status });
  return body.result;
}
const text = result => result.content?.filter(item => item.type === 'text').map(item => item.text).join('\n') ?? '';
const parsedOutput = result => JSON.parse(text(result).split('\n').find(line => line.startsWith('{')));
async function execute(session, participant, input) {
  const result = await rpc('call', { sessionId: session.sessionId, lease: participant.lease, tool: 'execute', arguments: { input } });
  assert(!result.isError, text(result));
  return result;
}
async function view(session) {
  const params = new URLSearchParams(new URL(session.viewURL).hash.slice(1));
  const url = new URL('/view', connection.origin); url.protocol = 'ws:'; url.search = params.toString();
  const socket = new WebSocket(url, { origin: connection.origin }); sockets.add(socket);
  const frame = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('No remote frame within 10 seconds')), 10_000);
    socket.on('error', error => { clearTimeout(timer); reject(error); });
    socket.on('message', bytes => {
      const message = JSON.parse(bytes.toString());
      if (message.kind === 'frame') { clearTimeout(timer); resolve(message); }
    });
  });
  return { frame, close: async () => { const closed = new Promise(resolve => socket.once('close', resolve)); socket.close(); await closed; sockets.delete(socket); } };
}
try {
  const scopes = [randomUUID(), randomUUID()];
  const [a, b] = await Promise.all(scopes.map((scope, index) => rpc('new', { scope, path: path.join(root, `${scope}-${index}.pen`) })));
  const [agent1, agent2, agentB] = await Promise.all([
    rpc('acquire', { sessionId: a.sessionId, agent: 'A-one' }), rpc('acquire', { sessionId: a.sessionId, agent: 'A-two' }), rpc('acquire', { sessionId: b.sessionId, agent: 'B-one' }),
  ]);
  const markerA = randomUUID(), markerB = randomUUID();
  const [nodeAResult, nodeBResult] = await Promise.all([
    execute(a, agent1, `const p=FindEmptySpace({width:320,height:180});const id=Insert(p.parentId??document,{type:"frame",name:${JSON.stringify(markerA)},x:p.x,y:p.y,width:320,height:180,layout:"vertical",gap:8,alignItems:"start",fill:"#315d8c"});Print({id});`),
    execute(b, agentB, `const p=FindEmptySpace({width:240,height:160});const id=Insert(p.parentId??document,{type:"frame",name:${JSON.stringify(markerB)},x:p.x,y:p.y,width:240,height:160,layout:"vertical",gap:8,alignItems:"start",fill:"#6c4530"});Print({id});`),
  ]);
  const nodeA = parsedOutput(nodeAResult).id, nodeB = parsedOutput(nodeBResult).id;
  const readA = await execute(a, agent2, `Print({node:Get(${JSON.stringify(nodeA)},{depth:0})});`);
  assert(text(readA).includes(markerA) && !text(readA).includes(markerB));
  const firstView = await view(a);
  assert.equal(firstView.frame.rendererId, a.renderer.rendererId);
  assert(Buffer.from(firstView.frame.data, 'base64').length > 1000, 'The view must receive an actual rendered editor image');
  await firstView.close();
  await execute(a, agent2, `Update(${JSON.stringify(nodeA)},{name:${JSON.stringify(markerA + '-background')}});Print({node:Get(${JSON.stringify(nodeA)},{depth:0})});`);
  const hidden = await rpc('status', { sessionId: a.sessionId });
  assert.equal(hidden.renderer.viewers, 0);
  assert.equal(hidden.renderer.rendererId, a.renderer.rendererId);
  const secondView = await view(a);
  assert.equal(secondView.frame.rendererId, firstView.frame.rendererId, 'Reconnecting the view must retain the renderer');
  const bView = await view(b);
  assert.notEqual(bView.frame.rendererId, secondView.frame.rendererId, 'Each session must own a separate renderer');
  const [finalA, finalB] = await Promise.all([
    execute(a, agent1, 'Print({nodes:Get(n=>({id:n.id,name:n.name}))});'),
    execute(b, agentB, 'Print({nodes:Get(n=>({id:n.id,name:n.name}))});'),
  ]);
  assert(text(finalA).includes(nodeA) && !text(finalA).includes(nodeB));
  assert(text(finalB).includes(nodeB) && !text(finalB).includes(nodeA));
  const reopened = await rpc('open', { path: path.join(root, `${scopes[0]}-0.pen`), scope: scopes[0] });
  assert.equal(reopened.renderer.rendererId, a.renderer.rendererId, 'Reopening one session must not create another engine');
  await Promise.all([rpc('save', { sessionId: a.sessionId, lease: agent1.lease }), rpc('save', { sessionId: b.sessionId, lease: agentB.lease })]);
  const screenshotHash = createHash('sha256').update(secondView.frame.data).digest('hex');
  await Promise.all([secondView.close(), bView.close()]);
  await writeFile(path.join(path.dirname(connectionPath), 'probe.json'), JSON.stringify({ a, b, agent1, agent2, agentB, nodeA, nodeB }), { mode: 0o600 });
  await writeFile(output, JSON.stringify({ status: 'passed', a: { sessionId: a.sessionId, rendererId: a.renderer.rendererId, nodeId: nodeA }, b: { sessionId: b.sessionId, rendererId: b.renderer.rendererId, nodeId: nodeB }, screenshotHash, receipts }, null, 2));
  console.log('PASS: isolated persistent renderers, shared agents, real images, hidden edits and same-renderer reconnect');
} finally { for (const socket of sockets) socket.terminate(); clearTimeout(deadline); }
