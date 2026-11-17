import { build } from 'esbuild';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
const result = await build({ entryPoints: ['web/editor.mjs'], bundle: true, format: 'iife', platform: 'browser', write: false, minify: true, metafile: true });
const builds = [result];
const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
await mkdir('dist', { recursive: true });
for (const name of ['server', 'daemon']) builds.push(await build({ entryPoints: [`src/${name}.mjs`], outfile: `dist/${name}.mjs`, bundle: true, format: 'esm', platform: 'node', target: 'node22', metafile: true, banner: { js: 'import { createRequire as createPluginRequire } from "node:module"; const require = createPluginRequire(import.meta.url);' } }));
await writeFile('dist/editor.html', `<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pencil</title><style>html,body{margin:0;height:100%;background:#161616;color:#ddd;font:13px system-ui}body{display:flex;flex-direction:column}header{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:8px 12px;min-height:18px;border-bottom:1px solid #333}button{font:inherit;color:#fff;background:#3F634B;border:1px solid #6d8b74;border-radius:6px;padding:6px 12px;cursor:pointer}button:disabled{opacity:.45;cursor:default}#activity{color:#8edab1}iframe{flex:1;border:0;width:100%;background:#161616}</style><header><span id="status" role="status">Ouverture de Pencil…</span><button id="save" disabled>Enregistrer</button></header><header id="activity" aria-live="polite">Session partagée · aucun agent connecté</header><iframe title="Éditeur Pencil" allow="clipboard-read; clipboard-write"></iframe><script>${js}</script></html>`);
// The installed Pencil entrypoint and supervised service use the persistent engine.
for (const [source, destination] of [['mcp','pencil'],['server','persistent-service']]) builds.push(await build({ entryPoints: [`src/persistent/${source}.mjs`], outfile: `dist/${destination}.mjs`, bundle: true, format: 'esm', platform: 'node', target: 'node22', external: ['esbuild', 'playwright-core'], metafile: true, banner: { js: 'import { createRequire as createPersistentRequire } from "node:module"; const require = createPersistentRequire(import.meta.url);' } }));
await mkdir('dist/persistent', { recursive: true });
const persistentView = await build({ entryPoints: ['src/persistent/view.mjs'], bundle: true, format: 'iife', platform: 'browser', write: false, minify: true, metafile: true });
builds.push(persistentView);
const template = await readFile('src/persistent/view.html', 'utf8');
const viewHTML = template.replace('<script type="module" src="/view.mjs"></script>', () => `<script>window.pencilRemoteApp=true;${persistentView.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')}</script>`);
await writeFile('dist/persistent/app.html', viewHTML);
await writeFile('dist/persistent/view.html', template);
for (const asset of ['engine.html','engine.mjs','point.mjs','keyboard.mjs','view-messages.mjs']) await writeFile(`dist/persistent/${asset}`, await readFile(`src/persistent/${asset}`));
const standaloneView = await build({ entryPoints: ['src/persistent/view.mjs'], bundle: true, format: 'esm', platform: 'browser', write: false, minify: true, metafile: true });
builds.push(standaloneView); await writeFile('dist/persistent/view.mjs', standaloneView.outputFiles[0].text);
// Serve standalone assets from the service bundle's neighboring persistent directory.
// Preserve the licenses of the packages actually included in the bundles.
const packages = new Map();
for (const bundle of builds) for (const input of Object.keys(bundle.metafile.inputs)) {
  if (!input.startsWith('node_modules/')) continue;
  let directory = path.dirname(input);
  while (directory !== 'node_modules' && directory !== '.') {
    try {
      const pkg = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
      if (pkg.name && pkg.version) { packages.set(`${pkg.name}@${pkg.version}`, { directory, pkg }); break; }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    directory = path.dirname(directory);
  }
}
let notices = '# Third-party notices\n\nGenerated from the dependencies included in the distributed bundles. The hosted Pencil engine is not included.\n';
for (const [name, { directory, pkg }] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
  notices += `\n## ${name}\n\nLicense: ${pkg.license ?? 'See package license below'}.\n`;
  for (const filename of (await readdir(directory)).sort()) {
    if (/^(license|licence|notice)([.-]|$)/i.test(filename)) notices += `\n### ${filename}\n\n${await readFile(path.join(directory, filename), 'utf8')}\n`;
  }
}
await writeFile('THIRD-PARTY-NOTICES.md', notices.split('\n').map(line => line.trimEnd()).join('\n').trimEnd() + '\n');
console.log('Pencil bundles and third-party notices built');
