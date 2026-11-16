import { build } from 'esbuild';
import { mkdir, readFile, writeFile, copyFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Local installation metadata contains paths, never connection credentials.
const [runtimeArgument, destinationArgument] = process.argv.slice(2);
if (!runtimeArgument || !destinationArgument) throw new Error('Pass the supervised runtime directory and an empty package destination');
const runtime = path.resolve(runtimeArgument), destination = path.resolve(destinationArgument);
const root = fileURLToPath(new URL('../', import.meta.url));
await stat(path.join(runtime, 'connection.json'));
await mkdir(destination, { recursive: false, mode: 0o700 });
const view = await build({ entryPoints: [path.join(root, 'experiments/remote-engine/view.mjs')], bundle: true, format: 'iife', platform: 'browser', write: false, minify: true });
const template = await readFile(path.join(root, 'experiments/remote-engine/view.html'), 'utf8');
const html = template.replace('<script type="module" src="/view.mjs"></script>', `<script>window.pencilRemoteApp=true;${view.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')}</script>`);
await writeFile(path.join(destination, 'view.html'), html);
await build({ entryPoints: [path.join(root, 'experiments/remote-engine/mcp.mjs')], bundle: true, platform: 'node', format: 'esm', target: 'node22', external: ['esbuild'], banner: { js: "import { createRequire as remoteCreateRequire } from 'node:module';const require=remoteCreateRequire(import.meta.url);" }, outfile: path.join(destination, 'server.mjs') });
const json = async (name: string, value: unknown): Promise<void> => { await writeFile(path.join(destination, name), JSON.stringify(value, null, 2) + '\n'); };
await json('plugin.json', {
  $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
  name: 'pen-remote', version: '0.1.0', description: 'Experimental Pen view of a persistent per-chat renderer.',
  author: { name: 'Julien M' }, license: 'MIT',
  extensions: { 'com.openai': { interface: { displayName: 'Pen Remote', shortDescription: 'Persistent Pen renderer experiment', developerName: 'Julien M', category: 'Productivity', capabilities: ['Interactive', 'Read', 'Write'], defaultPrompt: ['Open my session document in Pen Remote'] } } },
});
await json('mcp.json', { $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json', mcpServers: { 'pen-remote': { type: 'stdio', command: 'node', args: ['${PLUGIN_ROOT}/server.mjs'], env: { PENCIL_REMOTE_CONNECTION: path.join(runtime, 'connection.json'), PENCIL_REMOTE_VIEW: '${PLUGIN_ROOT}/view.html' } } } });
await mkdir(path.join(destination, '.agents/plugins'), { recursive: true });
await json('.agents/plugins/marketplace.json', { name: 'pen-remote-local', interface: { displayName: 'Pen Remote experiment' }, plugins: [{ name: 'pen-remote', source: { source: 'local', path: './' }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' }] });
await Promise.all(['LICENSE', 'THIRD-PARTY-NOTICES.md'].map(name => copyFile(path.join(root, name), path.join(destination, name))));
console.log(JSON.stringify({ package: destination, name: 'pen-remote', marketplace: 'pen-remote-local', requiresDevelopmentDependencies: false }));
