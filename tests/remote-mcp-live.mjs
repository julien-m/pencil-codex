import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Script } from 'node:vm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { MessageDecoder } from '../shared/bridge-wire.mjs';

const [runtimeArgument, output, packageDirectory, mode] = process.argv.slice(2), runtime = path.resolve(runtimeArgument);
const probe = JSON.parse(await readFile(path.join(runtime, 'probe.json'), 'utf8'));
const configuration = packageDirectory ? JSON.parse(await readFile(path.join(packageDirectory, 'mcp.json'), 'utf8')).mcpServers['pen-remote'] : null;
const expand = value => value.replaceAll('${PLUGIN_ROOT}', path.resolve(packageDirectory));
const entrypoint = configuration ? expand(configuration.args[0]) : 'experiments/remote-engine/mcp.mjs';
const environment = configuration ? Object.fromEntries(Object.entries(configuration.env).map(([key, value]) => [key, expand(value)])) : { PENCIL_REMOTE_CONNECTION: path.join(runtime, 'connection.json') };
const delayed = mode === '--delayed-connection' ? await mkdtemp(path.join(os.tmpdir(), 'remote-live-startup-')) : null;
if (delayed) environment.PENCIL_REMOTE_CONNECTION = path.join(delayed, 'connection.json');
const transport = new StdioClientTransport({ command: process.execPath, args: [entrypoint], env: { ...process.env, ...environment }, stderr: 'pipe' });
transport.stderr.on('data', () => {});
const client = new Client({ name: 'remote-mcp-live-probe', version: '1.0.0' });
const call = async (name, args) => { const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 10_000 }); assert(!result.isError, JSON.stringify(result.content)); return result; };
try {
  await client.connect(transport, { timeout: 10_000 });
  if (delayed) {
    assert((await client.listTools({}, { timeout: 2000 })).tools.some(tool => tool.name === 'pencil_open'));
    const offline = await client.callTool({ name: 'pencil_status', arguments: { sessionId: probe.a.sessionId } }, undefined, { timeout: 2000 });
    assert(offline.isError, 'An unavailable engine must be reported by the tool without killing MCP');
    await writeFile(environment.PENCIL_REMOTE_CONNECTION, await readFile(path.join(runtime, 'connection.json')), { mode: 0o600 });
  }
  const missingScope = await client.callTool({ name: 'pencil_open', arguments: { path: path.join(runtime, 'documents', `${probe.a.scope}-0.pen`) } }, undefined, { timeout: 2000 });
  assert(missingScope.isError, 'A global MCP process must not silently identify every chat as one scope');
  const result = await call('pencil_open', { path: path.join(runtime, 'documents', `${probe.a.scope}-0.pen`), scope: probe.a.scope });
  assert.equal(result.structuredContent.renderer.rendererId, probe.a.renderer.rendererId);
  assert(!JSON.stringify(result.structuredContent).includes('viewURL'), 'The model result must not expose the view grant');
  const openTool = (await client.listTools({}, { timeout: 2000 })).tools.find(tool => tool.name === 'pencil_open');
  const resource = await client.readResource({ uri: openTool._meta.ui.resourceUri }, { timeout: 10_000 });
  const html = resource.contents[0];
  const scripts = [...html.text.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script\s*>/gi)];
  assert(scripts.length > 0, 'The installed MCP App must contain executable script');
  for (const script of scripts) new Script(script[1]);
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
  await writeFile(output, JSON.stringify({ status: 'passed', rendererId: frame.rendererId, frameBytes: Buffer.from(frame.data, 'base64').length, independentEditorCreated: false, frontendDirectConnections: false, startedOfflineAndRecoveredWithoutMcpRestart: !!delayed }, null, 2));
  console.log('PASS: MCP App resource and chunked frames refer to the existing persistent renderer');
} finally { await client.close(); if (delayed) await rm(delayed, { recursive: true, force: true }); }
