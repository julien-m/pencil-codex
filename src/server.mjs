import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { connectBroker, root } from './client.mjs';
import { UiRelay } from './ui-relay.mjs';

const server = new McpServer({ name: 'pencil-panel', version: '0.5.0' });
const resource = 'ui://pencil-panel/editor-v2.html';
const uiRelay = new UiRelay();
const defaultScope = process.env.CODEX_THREAD_ID ?? `client-${randomUUID()}`;
let broker;
const backend = async () => broker ??= await connectBroker();
const object = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
const wrap = fn => async (args, extra) => {
  try { return await fn(args, extra); }
  catch (e) { return { isError: true, content: [{ type: 'text', text: `${e.code ?? 'ERROR'}: ${e.message}` }] }; }
};
async function open(filename, scope, method = 'open') {
  const b = await backend();
  const { editorToken, ...session } = await b.rpc(method, { path: filename, scope: scope ?? defaultScope });
  return { ...object(session), _meta: { editor: { sessionId: session.sessionId, port: b.port, editorToken } } };
}
server.registerResource('pencil-editor', resource, {}, async () => {
  return { contents: [{ uri: resource, mimeType: 'text/html;profile=mcp-app', text: await readFile(path.join(root, 'dist/editor.html'), 'utf8'), _meta: { ui: { csp: { connectDomains: [], frameDomains: ['https://app.pen.dev'] } }, 'openai/ui': { availableDisplayModes: ['fullscreen'], preferredDisplayMode: 'fullscreen' } } }] };
});
server.registerTool('pencil_editor_bridge', {
  description: 'Internal editor transport for the Pencil MCP App.',
  inputSchema: { action: z.enum(['connect', 'exchange', 'close']), sessionId: z.string().uuid().optional(), editorToken: z.string().uuid().optional(), connectionId: z.string().uuid().optional(), messages: z.array(z.record(z.string(), z.unknown())).optional() },
  _meta: { ui: { visibility: ['app'] } }
}, wrap(async args => {
  if (args.action === 'connect') {
    if (!args.sessionId || !args.editorToken) throw new Error('Editor grant required');
    const b = await backend();
    return object(await uiRelay.connect({ port: b.port, sessionId: args.sessionId, editorToken: args.editorToken }));
  }
  if (!args.connectionId) throw new Error('Editor connection required');
  if (args.action === 'close') { uiRelay.close(args.connectionId); return object({ closed: true }); }
  return object(await uiRelay.exchange(args.connectionId, args.messages));
}));
server.registerTool('pencil_open', {
  title: 'Ouvrir Pencil', description: 'Ouvrir un fichier .pen dans le panneau Pencil sans chat. scope identifie la session de design ; transmettre le sessionId aux autres agents pour partager le document. Les agents peuvent rejoindre la session pendant le chargement : begin rejoint immédiatement la session ; seuls les appels au moteur attendent sa disponibilité.',
  inputSchema: { path: z.string().min(1), scope: z.string().max(200).optional() },
  _meta: { ui: { resourceUri: resource } },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
}, wrap(args => open(args.path, args.scope)));
const id = z.string().uuid();
server.registerTool('pencil_new', { description: 'Créer un nouveau fichier .pen au chemin absolu choisi, sans écraser de fichier existant, puis ouvrir sa vue Pencil.', inputSchema: { path: z.string(), scope: z.string().optional() }, _meta: { ui: { resourceUri: resource } } }, wrap(args => open(args.path, args.scope, 'new')));
const selection = { sessionId: id, lease: id, nodeIds: z.array(z.string().min(1)).min(1).max(20), directory: z.string().min(1) };
server.registerTool('pencil_save', { description: 'Enregistrer les modifications dans le fichier .pen ouvert. Demande au moteur de vider ses changements, conserve une version de récupération et refuse un conflit externe. Participation à la session requise.', inputSchema: { sessionId: id, lease: id }, annotations: { readOnlyHint: false, destructiveHint: true } }, wrap(async args => object(await (await backend()).rpc('save', args))));
server.registerTool('pencil_capture', { description: 'Capturer des composants ou vues par ID natif, ou ["document"] pour tout le projet. Produit des images PNG et les enregistre dans le dossier absolu choisi. Aucun écrasement.', inputSchema: selection }, wrap(async args => (await backend()).rpc('capture', args)));
server.registerTool('pencil_export', { description: 'Exporter les nœuds sélectionnés vers PNG/JPEG/WEBP/PDF/HTML dans le dossier absolu choisi. Le résultat contient les fichiers réellement écrits. Participation à la session requise ; aucun écrasement.', inputSchema: { ...selection, format: z.enum(['png', 'jpeg', 'webp', 'pdf', 'html-css', 'html-tailwind']) } }, wrap(async args => (await backend()).rpc('export', args)));
server.registerTool('pencil_save_as', { description: 'Enregistrer le dernier snapshot acquitté dans un NOUVEAU fichier .pen au chemin choisi. Utiliser un snapshot acquitté (draft-saved, source-saved ou conflict) dans pencil_status ; aucun écrasement ni basculement implicite de document.', inputSchema: { sessionId: id, lease: id, path: z.string() } }, wrap(async args => object(await (await backend()).rpc('save-as', args))));
server.registerTool('pencil_tools', { description: 'Découvrir les schémas natifs publiés par le moteur de cette session ; respecter ces schémas avant pencil_call.', inputSchema: { sessionId: id }, annotations: { readOnlyHint: true } }, wrap(async args => object(await (await backend()).rpc('schema', args))));
server.registerTool('pencil_status', { description: 'Vérifier le document, le canal, la sauvegarde et les agents de cette session Pencil.', inputSchema: { sessionId: id }, annotations: { readOnlyHint: true } }, wrap(async args => object(await (await backend()).rpc('status', args))));
server.registerTool('pencil_begin', { description: 'Rejoindre immédiatement la session comme agent, même si le moteur est hors ligne. pencil_call attendra le moteur dans le délai annoncé par le service. Retourne lease, un jeton de participation NON exclusif : plusieurs agents peuvent travailler simultanément dans le même sessionId. Chaque agent modifie sa propre frame pour éviter les conflits. Une autre session ne peut pas ouvrir le même document.', inputSchema: { sessionId: id, agent: z.string().min(1).max(200) } }, wrap(async args => object(await (await backend()).rpc('acquire', args))));
server.registerTool('pencil_call', {
  description: 'Appeler les outils natifs Pencil via le canal de la session partagée. Commencer par read_skill puis get_app_state. read_skill est mutualisé par chemin dans cette génération du moteur. Chaque agent crée sa propre frame dans son premier execute ; aucune frame préparée. Partager sessionId et utiliser son propre lease de participation. Les appels sont transmis immédiatement sans file globale ; ne pas modifier les nœuds d’un autre agent. Les générations asynchrones ne sont pas supportées dans v0.1 ; un OUTCOME_UNKNOWN interdit de rejouer la mutation.',
  inputSchema: { sessionId: id, lease: id, tool: z.enum(['execute', 'get_app_state', 'get_style', 'read_skill']), arguments: z.record(z.string(), z.unknown()).default({}) }
}, wrap(async args => (await backend()).rpc('call', args)));
server.registerTool('pencil_end', { description: 'Terminer sa participation après la fin de ses appels, sans interrompre les autres agents. Ne prouve pas la sauvegarde ; vérifier pencil_status et le fichier via le moteur.', inputSchema: { sessionId: id, lease: id } }, wrap(async args => object(await (await backend()).rpc('release', args))));
await server.connect(new StdioServerTransport());
