import { startBroker } from './broker.mjs';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { root } from './client.mjs';
import path from 'node:path';
const broker = await startBroker();
const session = await broker.sessions.open(process.argv[2], 'preview');
// Use the authenticated RPC to allocate the per-view grant as in the real MCP server.
const response = await fetch(`http://127.0.0.1:${broker.port}/rpc`, { method: 'POST', headers: { Authorization: `Bearer ${broker.token}` }, body: JSON.stringify({ method: 'open', args: { path: process.argv[2], scope: 'preview' } }) });
const { result } = await response.json();
const grant = randomUUID();
const html = (await readFile(path.join(root, 'dist/editor.html'), 'utf8')).replace('<script>', `<script>window.pencilPanelPreview=${JSON.stringify({ sessionId: session.sessionId, editorToken: result.editorToken, port: broker.port })};</script><script>`);
const server = http.createServer((req, res) => { if (req.url !== `/${grant}`) return res.writeHead(404).end(); res.setHeader('Content-Type', 'text/html'); res.end(html); });
await new Promise(r => server.listen(0, '127.0.0.1', r));
console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/${grant}`, sessionId: session.sessionId, brokerPort: broker.port, brokerToken: broker.token }));
async function shutdown() { server.close(); await broker.close(); process.exit(0); }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
