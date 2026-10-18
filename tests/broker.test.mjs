import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { startBroker } from '../src/broker.mjs';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
test('real loopback transport authenticates and routes one editor without broadcasting to another', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pencil-ws-')); const b = await startBroker({ timeout: 1000 }); const peers = [];
  try {
    const rpc = async (method, args) => (await (await fetch(`http://127.0.0.1:${b.port}/rpc`, { method: 'POST', headers: { Authorization: `Bearer ${b.token}` }, body: JSON.stringify({ method, args }) })).json()).result;
    assert.equal((await fetch(`http://127.0.0.1:${b.port}/rpc`, { method: 'POST' })).status, 401);
    const sessions = [];
    for (const name of ['a', 'b']) {
      const file = path.join(dir, `${name}.pen`); await fs.writeFile(file, name); const s = await rpc('open', { path: file, scope: name }); sessions.push(s);
      const peer = new WebSocket(`ws://127.0.0.1:${b.port}/editor?session=${s.sessionId}&token=${s.editorToken}`); peers.push(peer);
      await new Promise((resolve, reject) => { peer.once('message', resolve); peer.once('error', reject); });
      peer.on('message', bytes => { const m = JSON.parse(bytes); if (m.kind === 'request') peer.send(JSON.stringify({ kind: 'response', id: m.id, payload: { content: [{ type: 'text', text: name }] } })); });
    }
    const leases = await Promise.all(sessions.map((s, i) => rpc('acquire', { sessionId: s.sessionId, agent: `agent-${i}` })));
    const results = await Promise.all(sessions.map((s, i) => rpc('call', { sessionId: s.sessionId, lease: leases[i].lease, tool: 'get_app_state', arguments: {} })));
    assert.deepEqual(results.map(x => x.content[0].text), ['a', 'b']);
  } finally { for (const p of peers) p.terminate(); await b.close(); await fs.rm(dir, { recursive: true, force: true }); }
});
