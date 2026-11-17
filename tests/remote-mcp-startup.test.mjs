import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Script } from 'node:vm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('MCP tools survive an absent engine and read its connection when it becomes available', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'remote-mcp-startup-'));
  const connection = path.join(directory, 'connection.json');
  const transport = new StdioClientTransport({ command: process.execPath, args: ['experiments/remote-engine/mcp.mjs'], env: { ...process.env, PENCIL_REMOTE_CONNECTION: connection }, stderr: 'pipe' });
  transport.stderr.on('data', () => {});
  const client = new Client({ name: 'offline-startup-test', version: '1.0.0' });
  try {
    await client.connect(transport, { timeout: 1000 });
    const tools = (await client.listTools({}, { timeout: 1000 })).tools;
    const open = tools.find(tool => tool.name === 'pencil_open');
    assert(open);
    const resource = await client.readResource({ uri: open._meta.ui.resourceUri }, { timeout: 1000 });
    const scripts = [...resource.contents[0].text.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script\s*>/gi)];
    assert(scripts.length > 0, 'The MCP App must contain its bundled script');
    for (const script of scripts) new Script(script[1]);
    const args = { name: 'pencil_status', arguments: { sessionId: randomUUID() } };
    const missing = await client.callTool(args, undefined, { timeout: 1000 });
    assert(missing.isError);
    // A changed on-disk configuration must be validated without restarting MCP.
    await writeFile(connection, JSON.stringify({ origin: 'https://example.invalid', token: randomUUID() }));
    const invalid = await client.callTool(args, undefined, { timeout: 1000 });
    assert(invalid.isError);
    assert.match(JSON.stringify(invalid.content), /local supervised service/);
    assert((await client.listTools({}, { timeout: 1000 })).tools.some(tool => tool.name === 'pencil_open'));
  } finally { await client.close(); await rm(directory, { recursive: true, force: true }); }
});
