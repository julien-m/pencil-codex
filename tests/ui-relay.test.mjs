import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { startBroker } from '../src/broker.mjs';
import { UiRelay } from '../src/ui-relay.mjs';
import { WebSocketServer } from 'ws';
import { createMcpTransport } from '../web/mcp-transport.mjs';

test('native MCP transport routes concurrent agents, storage and Save through the existing broker', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pencil-relay-'));
  const broker = await startBroker({ timeout: 500, draftRoot: path.join(directory, 'drafts') });
  const relay = new UiRelay({ pollTimeout: 5 });
  let transport, pumpError;
  try {
    const file = path.join(directory, 'native.pen'); await fs.writeFile(file, 'original');
    const { result: opened } = await (await fetch(`http://127.0.0.1:${broker.port}/rpc`, {
      method: 'POST', headers: { Authorization: `Bearer ${broker.token}` },
      body: JSON.stringify({ method: 'open', args: { path: file, scope: 'native' } })
    })).json();
    // Model the documented host proxy; the web adapter never receives a network URL.
    const app = { async callServerTool({ name, arguments: args }) {
      assert.equal(name, 'pencil_editor_bridge');
      let result;
      if (args.action === 'connect') result = await relay.connect({ port: broker.port, ...args });
      else if (args.action === 'exchange') result = await relay.exchange(args.connectionId, args.messages);
      else if (args.action === 'send') result = relay.send(args.connectionId, args.messages);
      else { relay.close(args.connectionId); result = { closed: true }; }
      return { structuredContent: result };
    } };
    const requests = [];
    const count = Number(process.env.PENCIL_TEST_AGENTS ?? 6);
    let saved, generation;
    transport = createMcpTransport(app, opened, {
      onerror: error => { pumpError = error; }, onclose() {},
      onmessage({ data }) {
        const message = JSON.parse(data);
        const send = value => transport.send(JSON.stringify(value));
        if (message.kind === 'config') {
          generation = message.generation;
          send({ kind: 'ready' });
          send({ kind: 'storage', id: 'load', method: 'storage-load' });
        }
        if (message.kind === 'request' && message.method === 'mcp-tool-call') {
          requests.push(message);
          // All requests must reach the editor before any model gets its response.
          if (requests.length === count) for (const request of [...requests].reverse())
            send({ kind: 'response', id: request.id, payload: request.payload.arguments });
        }
        if (message.kind === 'request' && message.method === 'save') {
          saved = message.id;
          send({ kind: 'storage', id: 'flush', method: 'storage-write', payload: { fileURI: `file:///pencil/${opened.sessionId}/native.pen`, content: 'modified' } });
        }
        if (message.kind === 'storage-response' && message.id === 'flush') send({ kind: 'response', id: saved, payload: message.payload });
        if (message.kind === 'save-result') saveResultResolve(message);
      }
    });
    let saveResultResolve;
    const completedSave = new Promise(resolve => saveResultResolve = resolve);
    const participants = Array.from({ length: count }, (_, i) => broker.sessions.acquire(opened.sessionId, `model-${i}`));
    const results = await Promise.all(participants.map((p, marker) => broker.sessions.call(opened.sessionId, p.lease, 'execute', { marker })));
    assert.deepEqual(results.map(r => r.marker), participants.map((_, i) => i));
    assert.equal(generation, 1);
    transport.send(JSON.stringify({ kind: 'save' }));
    assert(!((await completedSave).error));
    assert.equal(await fs.readFile(file, 'utf8'), 'modified');
    assert.equal(broker.sessions.status(opened.sessionId).saveState, 'source-saved');
    assert.equal(pumpError, undefined);
    await transport.close();
    // Connection ID capabilities are revoked at close.
    assert.equal(relay.connections.size, 0);
  } finally { await transport?.close(); relay.closeAll(); await broker.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('relay rejects another session grant and expires disconnected views', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pencil-relay-auth-'));
  const broker = await startBroker(); const relay = new UiRelay({ idleTimeout: 35, pollTimeout: 5 });
  try {
    const file = path.join(directory, 'test.pen'); await fs.writeFile(file, 'opaque');
    const { result: opened } = await (await fetch(`http://127.0.0.1:${broker.port}/rpc`, {
      method: 'POST', headers: { Authorization: `Bearer ${broker.token}` }, body: JSON.stringify({ method: 'open', args: { path: file, scope: 'a' } })
    })).json();
    await assert.rejects(relay.connect({ port: broker.port, sessionId: opened.sessionId, editorToken: 'wrong-grant' }));
    const { connectionId } = await relay.connect({ port: broker.port, ...opened });
    await relay.exchange(connectionId);
    await new Promise(resolve => setTimeout(resolve, 60));
    await assert.rejects(relay.exchange(connectionId), /EDITOR_CHANNEL_CLOSED/);
    assert.equal(broker.sessions.status(opened.sessionId).connected, false);
  } finally { relay.closeAll(); await broker.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('host bridge errors stop the web transport without replaying messages', async () => {
  const calls = []; let finished;
  const failed = new Promise(resolve => finished = resolve);
  const transport = createMcpTransport({ async callServerTool({ arguments: args }) {
    calls.push(args.action);
    if (args.action === 'connect') return { structuredContent: { connectionId: 'test-connection' } };
    if (args.action === 'exchange') return { isError: true, content: [{ type: 'text', text: 'Host rejected exchange' }] };
    return { structuredContent: { closed: true } };
  } }, { sessionId: 'test-session', editorToken: 'test-grant' }, {
    onmessage() { assert.fail('No message expected'); }, onerror: error => assert.match(error.message, /Host rejected/), onclose: () => finished()
  });
  await failed; await transport.close();
  assert.equal(calls.filter(action => action === 'exchange').length, 1);
  assert.equal(transport.readyState, 3);
});

test('draining chunks releases queue capacity before the next message arrives', async () => {
  const server=new WebSocketServer({port:0,host:'127.0.0.1'});await new Promise(resolve=>server.once('listening',resolve));
  let peer;const attached=new Promise(resolve=>server.once('connection',p=>{peer=p;resolve()}));
  const relay=new UiRelay({maxBytes:220000,pollTimeout:5});
  try {
    const{connectionId}=await relay.connect({port:server.address().port,sessionId:'queue',editorToken:'grant'});await attached;
    peer.send(JSON.stringify({payload:'a'.repeat(200000)}));
    const first=await relay.exchange(connectionId);assert.equal(first.messages.length,4);
    peer.send(JSON.stringify({payload:'b'.repeat(100000)}));
    await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal(relay.status('queue')[0].connected,true);
    assert(relay.connections.get(connectionId).bytes<220000);
    const rest=await relay.exchange(connectionId);assert(rest.messages.length>0);
  } finally {relay.closeAll();await new Promise(resolve=>server.close(resolve));}
});
