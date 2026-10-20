import http from 'node:http';
import { WebSocketServer } from 'ws';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { Sessions } from './sessions.mjs';
import { createDocument } from './artifacts.mjs';

const same = (a, b) => {
  if (typeof a !== 'string') return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
export async function startBroker({ token = randomUUID(), timeout, editorWaitTimeout, draftRoot } = {}) {
  const sessions = new Sessions({ timeout, editorWaitTimeout, draftRoot }), views = new Map();
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (!same(req.headers.authorization, `Bearer ${token}`)) { res.writeHead(401).end('{}'); return; }
    try {
      if (req.method !== 'POST' || req.url !== '/rpc') { res.writeHead(404).end('{}'); return; }
      let raw = '';
      for await (const chunk of req) { raw += chunk; if (raw.length > 40 * 1024 * 1024) throw new Error('Request too large'); }
      const { method, args = {} } = JSON.parse(raw);
      let result;
      if (method === 'ping') result = { version: '0.5.1', editorWaitTimeout: sessions.editorWaitTimeout, rpcTimeoutMs: sessions.editorWaitTimeout + sessions.timeout + sessions.saveWaitTimeout + 2000 };
      else if (method === 'open' || method === 'new') {
        const filename = method === 'new' ? await createDocument(args.path) : args.path;
        result = await sessions.open(filename, args.scope);
        if (!views.has(result.sessionId)) views.set(result.sessionId, randomUUID());
        result = { ...result, editorToken: views.get(result.sessionId) };
      } else if (method === 'schema') result = await sessions.schema(args.sessionId);
      else if (method === 'status') result = sessions.status(args.sessionId);
      else if (method === 'acquire') { result = await sessions.begin(args.sessionId, args.agent); broadcast(args.sessionId); }
      else if (method === 'release') { result = sessions.release(args.sessionId, args.lease); broadcast(args.sessionId); }
      else if (method === 'call') result = await sessions.call(args.sessionId, args.lease, args.tool, args.arguments);
      else if (method === 'capture') result = await sessions.capture(args.sessionId, args.lease, args.nodeIds, args.directory);
      else if (method === 'export') result = await sessions.exportNodes(args.sessionId, args.lease, args.nodeIds, args.format, args.directory);
      else if (method === 'save') { result = await sessions.save(args.sessionId, args.lease); broadcast(args.sessionId); }
      else if (method === 'save-as') result = await sessions.saveAs(args.sessionId, args.lease, args.path);
      else throw new Error('Unknown broker method');
      res.end(JSON.stringify({ result }));
    } catch (e) { res.end(JSON.stringify({ error: { code: e.code ?? 'BROKER_ERROR', message: e.message } })); }
  });
  const ws = new WebSocketServer({ noServer: true, maxPayload: 40 * 1024 * 1024 });
  const broadcast = id => { for (const peer of ws.clients) if (peer.sessionId === id && peer.readyState === 1) peer.send(JSON.stringify({ kind: 'activity', status: sessions.status(id) })); };
  sessions.onActivity = broadcast;
  server.on('upgrade', (req, socket, head) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { socket.destroy(); return; }
    const id = url.searchParams.get('session'), grant = views.get(id);
    if (url.pathname !== '/editor' || !grant || !same(url.searchParams.get('token'), grant)) { socket.destroy(); return; }
    ws.handleUpgrade(req, socket, head, peer => {
      let generation;
      peer.sessionId = id;
      try {
        const config = sessions.attach(id, message => peer.send(JSON.stringify(message)), { ready: false });
        generation = config.generation;
        peer.send(JSON.stringify({ kind: 'config', ...config }));
      } catch (e) { peer.send(JSON.stringify({ kind: 'fatal', message: e.message })); peer.close(); return; }
      peer.on('message', bytes => {
        try {
          const message = JSON.parse(bytes.toString());
          if (message.kind === 'ready') { sessions.ready(id, generation); broadcast(id); }
          else if (message.kind === 'response') sessions.reply(id, generation, message);
          else if (message.kind === 'save') {
            void (async () => {
              let lease;
              try {
                lease = sessions.acquire(id, 'Vous · Enregistrer').lease; broadcast(id);
                const result = await sessions.save(id, lease);
                if (peer.readyState === 1) peer.send(JSON.stringify({ kind: 'save-result', result }));
              } catch (error) {
                if (peer.readyState === 1) peer.send(JSON.stringify({ kind: 'save-result', error: { code: error.code ?? 'SAVE_FAILED', message: error.message } }));
              } finally {
                if (lease && !sessions.get(id).blocked) {
                  try { sessions.release(id, lease); }
                  catch (error) {
                    sessions.get(id).blocked = true;
                    if (peer.readyState === 1) peer.send(JSON.stringify({ kind: 'fatal', message: `Enregistrement terminé ; session à réconcilier : ${error.message}` }));
                  }
                }
                broadcast(id);
              }
            })();
          }
          else if (message.kind === 'storage') {
            void (async () => {
              try {
                const payload = await sessions.storage(id, generation, message.method, message.payload);
                peer.send(JSON.stringify({ kind: 'storage-response', id: message.id, payload })); broadcast(id);
              } catch (e) { if (peer.readyState === 1) peer.send(JSON.stringify({ kind: 'storage-response', id: message.id, error: { code: e.code ?? 'STORAGE_ERROR', message: e.message } })); }
            })().catch(() => {});
          }
        } catch { peer.close(1008, 'Invalid message'); }
      });
      peer.on('error', () => {});
      peer.on('close', () => sessions.detach(id, generation));
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { port: server.address().port, token, sessions, close: async () => {
    for (const peer of ws.clients) peer.terminate();
    const closed = new Promise(r => server.close(r));
    server.closeAllConnections();
    await closed;
  } };
}
