import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { UiRelay } from '../../src/ui-relay.mjs';
import { BRIDGE_BATCH_CHUNKS } from '../../shared/bridge-wire.mjs';

const connectionPath = process.env.PENCIL_REMOTE_CONNECTION ?? fileURLToPath(new URL('../../.runtime/remote-engine/connection.json', import.meta.url));
async function readConnection() {
  let bytes;
  try { bytes = await readFile(connectionPath, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error('The supervised Pen engine is unavailable. Start its service and retry; no engine call was sent.');
    throw error;
  }
  const connection = z.object({ origin: z.string().url(), token: z.string().uuid() }).parse(JSON.parse(bytes));
  const origin = new URL(connection.origin);
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port || origin.username || origin.password) throw new Error('The experiment requires a local supervised service');
  return { origin: origin.origin, token: connection.token };
}
const server = new McpServer({ name: 'pencil-persistent-renderer', version: '0.6.0-experiment' });
const resource = 'ui://pencil-remote/editor.html';
let relay;
const object = result => ({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result });
const wrap = fn => async args => {
  try { return await fn(args); } catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
};
async function rpc(method, args) {
  const connection = await readConnection();
  const response = await fetch(`${connection.origin}/rpc`, { method: 'POST', headers: { Authorization: `Bearer ${connection.token}` }, body: JSON.stringify({ method, args }), signal: AbortSignal.timeout(85_000) });
  const body = await response.json();
  if (body.error) throw new Error(typeof body.error === 'string' ? body.error : body.error.message);
  return body.result;
}
let resourceHTML;
server.registerResource('persistent-pen-view', resource, {}, async () => {
  if (!resourceHTML) {
    if (process.env.PENCIL_REMOTE_VIEW) resourceHTML = await readFile(process.env.PENCIL_REMOTE_VIEW, 'utf8');
    else {
      // Source-checkout mode only; installed packages use a prebuilt resource.
      const { build } = await import('esbuild');
      const built = await build({ entryPoints: [fileURLToPath(new URL('view.mjs', import.meta.url))], bundle: true, format: 'iife', platform: 'browser', write: false, minify: true });
      const html = await readFile(new URL('view.html', import.meta.url), 'utf8');
      resourceHTML = html.replace('<script type="module" src="/view.mjs"></script>', `<script>window.pencilRemoteApp=true;${built.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')}</script>`);
    }
  }
  return { contents: [{ uri: resource, mimeType: 'text/html;profile=mcp-app', text: resourceHTML, _meta: { ui: { csp: { connectDomains: [], frameDomains: [] } }, 'openai/ui': { availableDisplayModes: ['fullscreen'], preferredDisplayMode: 'fullscreen' } } }] };
});
for (const [name, method] of [['pencil_open', 'open'], ['pencil_new', 'new']]) server.registerTool(name, {
  description: 'Open this chat’s persistent renderer. Pass the current chat ID as scope, or a unique scope allocated once for this chat. Reuse its returned sessionId for collaborating agents. A global MCP process is never used as a chat identity. Other chats must use distinct scopes and documents.',
  inputSchema: { path: z.string().min(1), scope: z.string().min(1).max(200) }, _meta: { ui: { resourceUri: resource } },
}, wrap(async args => {
  const { viewURL, ...session } = await rpc(method, args);
  const grant = new URLSearchParams(new URL(viewURL).hash.slice(1));
  return { ...object(session), _meta: { editor: { sessionId: session.sessionId, editorToken: grant.get('token') } } };
}));
const id = z.string().uuid(), member = { sessionId: id, lease: id };
const definitions = [
  ['pencil_begin', 'acquire', { sessionId: id, agent: z.string().min(1).max(200) }],
  ['pencil_end', 'release', member], ['pencil_status', 'status', { sessionId: id }], ['pencil_tools', 'schema', { sessionId: id }], ['pencil_save', 'save', member],
  ['pencil_call', 'call', { ...member, tool: z.enum(['execute', 'get_app_state', 'get_style', 'read_skill']), arguments: z.record(z.string(), z.unknown()).default({}) }],
  ['pencil_save_as', 'save-as', { ...member, path: z.string().min(1) }],
  ['pencil_capture', 'capture', { ...member, nodeIds: z.array(z.string()).min(1).max(20), directory: z.string().min(1) }],
  ['pencil_export', 'export', { ...member, nodeIds: z.array(z.string()).min(1).max(20), directory: z.string().min(1), format: z.enum(['png', 'jpeg', 'webp', 'pdf', 'html-css', 'html-tailwind']) }],
];
for (const [name, method, inputSchema] of definitions) server.registerTool(name, { description: `Persistent session ${method}. Keep the returned sessionId and one participation lease per agent; never send another chat’s document URI.`, inputSchema }, wrap(async args => {
  const result = await rpc(method, args);
  return ['call', 'capture', 'export'].includes(method) ? result : object(result);
}));
server.registerTool('pencil_editor_bridge', {
  description: 'Internal remote-view transport; this view does not create an editor engine.',
  inputSchema: { action: z.enum(['connect', 'exchange', 'send', 'close']), sessionId: id.optional(), editorToken: id.optional(), connectionId: id.optional(), messages: z.array(z.record(z.string(), z.unknown())).max(BRIDGE_BATCH_CHUNKS).optional() },
  _meta: { ui: { visibility: ['app'] } },
}, wrap(async args => {
  if (args.action === 'connect') {
    if (!args.sessionId || !args.editorToken) throw new Error('A view grant is required');
    const connection = await readConnection();
    // Replace only the view relay if the supervised endpoint itself changes.
    if (relay?.origin !== connection.origin) {
      relay?.closeAll();
      relay = new UiRelay({ endpoint: '/view', origin: connection.origin });
    }
    return object(await relay.connect({ port: Number(new URL(connection.origin).port), sessionId: args.sessionId, editorToken: args.editorToken }));
  }
  if (!args.connectionId) throw new Error('A view connection is required');
  if (!relay) throw new Error('A view connection must be established first');
  if (args.action === 'send') return object(relay.send(args.connectionId, args.messages));
  if (args.action === 'close') { relay.close(args.connectionId); return object({ closed: true }); }
  return object(await relay.exchange(args.connectionId, args.messages));
}));
process.on('SIGTERM', () => { relay?.closeAll(); process.exit(0); });
await server.connect(new StdioServerTransport());
