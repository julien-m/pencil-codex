import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { MessageDecoder } from '../shared/bridge-wire.mjs';

const [runtime, output] = process.argv.slice(2), probe = JSON.parse(await readFile(path.join(runtime, 'probe.json'), 'utf8'));
const transport = new StdioClientTransport({ command: process.execPath, args: ['experiments/remote-engine/mcp.mjs'], env: { ...process.env, PENCIL_REMOTE_CONNECTION: path.join(runtime, 'connection.json') }, stderr: 'pipe' });
transport.stderr.on('data', () => {});
const client = new Client({ name: 'remote-mcp-live-probe', version: '1.0.0' });
const call = async (name, args) => { const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 10_000 }); assert(!result.isError, JSON.stringify(result.content)); return result; };
try {
  await client.connect(transport, { timeout: 10_000 });
  const result = await call('pencil_open', { path: path.join(runtime, 'documents', `${probe.a.scope}-0.pen`), scope: probe.a.scope });
  assert.equal(result.structuredContent.renderer.rendererId, probe.a.renderer.rendererId);
  assert(!JSON.stringify(result.structuredContent).includes('viewURL'), 'The model result must not expose the view grant');
  const resource = await client.readResource({ uri: 'ui://pencil-remote/editor.html' }, { timeout: 10_000 });
  const html = resource.contents[0];
  assert(!html.text.includes('<iframe'), 'The MCP App must not instantiate another Pen editor');
  assert.equal(html._meta.ui.csp.connectDomains.length, 0);
  const connected = await call('pencil_editor_bridge', { action: 'connect', ...result._meta.editor });
  const connectionId = connected.structuredContent.connectionId, decoder = new MessageDecoder();
  let frame;
  const deadline = Date.now() + 10_000;
  while (!frame && Date.now() < deadline) {
    const exchange = await call('pencil_editor_bridge', { action: 'exchange', connectionId });
    for (const chunk of exchange.structuredContent.messages) { const message = decoder.accept(chunk); if (message?.kind === 'frame') frame = message; }
  }
  assert(frame, 'A real frame must cross the chunked MCP App transport');
  assert.equal(frame.rendererId, probe.a.renderer.rendererId);
  await call('pencil_editor_bridge', { action: 'close', connectionId });
  await writeFile(output, JSON.stringify({ status: 'passed', rendererId: frame.rendererId, frameBytes: Buffer.from(frame.data, 'base64').length, independentEditorCreated: false, frontendDirectConnections: false }, null, 2));
  console.log('PASS: MCP App resource and chunked frames refer to the existing persistent renderer');
} finally { await client.close(); }
