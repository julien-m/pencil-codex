import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Script } from 'node:vm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('installed manifest selects the self-contained persistent Pencil adapter', async () => {
  const manifest = JSON.parse(await readFile('mcp.json', 'utf8'));
  const configured = manifest.mcpServers.pencil;
  assert(configured);
  const args = configured.args.map(value => value.replaceAll('${PLUGIN_ROOT}', process.cwd()));
  const transport = new StdioClientTransport({ command: configured.command, args, env: { ...process.env, PENCIL_CONNECTION: '/nonexistent/pencil-package-test/connection.json' }, stderr: 'pipe' });
  transport.stderr.on('data', () => {});
  const client = new Client({ name: 'persistent-package-test', version: '1.0.0' });
  try {
    await client.connect(transport, { timeout: 1000 });
    const tools = (await client.listTools({}, { timeout: 1000 })).tools;
    assert(tools.some(tool => tool.name === 'pencil_close'));
    const open = tools.find(tool => tool.name === 'pencil_open');
    const resource = await client.readResource({ uri: open._meta.ui.resourceUri }, { timeout: 1000 });
    const html = resource.contents[0].text;
    assert(!html.includes('<iframe'));
    const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script\s*>/gi)];
    assert(scripts.length); for (const script of scripts) new Script(script[1]);
    const unavailable = await client.callTool({ name: 'pencil_open', arguments: { path: '/nonexistent/document.pen', scope: 'package-test' } }, undefined, { timeout: 1000 });
    assert(unavailable.isError);
  } finally { await client.close(); }
});
