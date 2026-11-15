import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createDocument } from '../src/artifacts.mjs';

const [binary, output] = process.argv.slice(2);
assert(binary && output, 'Usage: node tests/native-engine-feasibility.mjs <native MCP binary> <receipt.json>');
const clients = [], evidence = [];
const root = path.resolve('.runtime/feasibility');
await mkdir(root, { recursive: true });
const directory = await mkdtemp(path.join(root, 'native-'));
const files = await Promise.all(['a', 'b'].map(name => createDocument(path.join(directory, `${name}.pen`))));
const uris = files.map(file => pathToFileURL(file).href);
const scopes = uris.map(() => randomUUID());
const challenges = Array.from({ length: 3 }, () => randomUUID());
const deadline = setTimeout(() => {
  for (const { transport } of clients) void transport.close();
  console.error('Native feasibility command exceeded 120 seconds');
  process.exitCode = 1;
}, 120_000);

async function connect(scope) {
  const transport = new StdioClientTransport({ command: binary, args: ['--app', 'desktop', '--conversation_id', scope], stderr: 'pipe' });
  let registered;
  const registration = new Promise(resolve => { registered = resolve; });
  let diagnostic = '';
  transport.stderr.on('data', bytes => {
    diagnostic = (diagnostic + bytes.toString()).slice(-4000);
    if (diagnostic.includes('received client ID:')) registered();
  });
  const client = new Client({ name: 'persistent-engine-feasibility', version: '1.0.0' });
  clients.push({ client, transport });
  await client.connect(transport, { timeout: 10_000 });
  let timer;
  try {
    await Promise.race([registration, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Native transport did not register within 10 seconds')), 10_000);
    })]);
  } finally { clearTimeout(timer); }
  return client;
}

async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 10_000 });
  const text = result.content?.filter(item => item.type === 'text').map(item => item.text).join('\n') ?? '';
  assert(!result.isError, text);
  evidence.push({ name, time: new Date().toISOString(), result });
  return text;
}

try {
  const [a1, a2, b] = await Promise.all([connect(scopes[0]), connect(scopes[0]), connect(scopes[1])]);
  const execute = (client, uri, input) => call(client, 'execute', { uri, input });
  await Promise.all([
    execute(a1, uris[0], `SetVariables({"agent-one":{type:"string",value:${JSON.stringify(challenges[0])}}});`),
    execute(b, uris[1], `SetVariables({"agent-other-session":{type:"string",value:${JSON.stringify(challenges[2])}}});`),
  ]);
  await execute(a2, uris[0], `SetVariables({"agent-two":{type:"string",value:${JSON.stringify(challenges[1])}}});`);
  const [shared, isolated] = await Promise.all([
    execute(a1, uris[0], 'Print(GetVariables());'),
    execute(b, uris[1], 'Print(GetVariables());'),
  ]);
  assert(challenges.slice(0, 2).every(value => shared.includes(value)), 'Agents in one session must see both changes');
  assert(!shared.includes(challenges[2]), 'Session B must not contaminate A');
  assert(isolated.includes(challenges[2]) && challenges.slice(0, 2).every(value => !isolated.includes(value)), 'Session A must not contaminate B');
  await Promise.all([call(a1, 'save', { uri: uris[0] }), call(b, 'save', { uri: uris[1] })]);
  const documentA = await execute(a1, uris[0], 'Print(Get(n=>({id:n.id,name:n.name,type:n.type})));');
  const receipt = { status: 'passed', documents: files, uris, scopes, challenges, documentA, evidence };
  await writeFile(output, JSON.stringify(receipt, null, 2));
  console.log('PASS: two isolated documents, two agents sharing A, concurrent A/B operations and saves');
} finally {
  await Promise.all(clients.map(({ client }) => client.close()));
  clearTimeout(deadline);
}
