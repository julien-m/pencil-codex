import { App } from '@modelcontextprotocol/ext-apps';
const status = document.querySelector('#status');
const frame = document.querySelector('iframe');
let socket, port, connected = false, frameLoaded = false, config, timer, started = false;
let app;
const show = message => { status.textContent = message; };
function connectEditor() {
  if (!config || !frameLoaded || !socket || socket.readyState !== 1 || connected) return;
  port?.close();
  const channel = new MessageChannel(); port = channel.port1;
  port.onmessage = event => {
    const m = event.data;
    if (m.kind === 'ready') { connected = true; clearInterval(timer); show('Canal connecté · chargement du moteur'); window.pencilPanelState = 'bridge-ready'; return; }
    if (m.kind === 'error') { show(`Pencil : ${m.message}`); return; }
    if (m.kind === 'request') {
      const payload = m.payload;
      if (payload?.data instanceof Uint8Array) payload.data = [...payload.data];
      socket.send(JSON.stringify({ ...m, kind: 'storage' }));
    } else if (m.kind === 'response') socket.send(JSON.stringify(m));
  };
  port.start();
  frame.contentWindow.postMessage({ type: 'pen:connect', theme: 'dark', fileURI: config.fileURI }, 'https://app.pen.dev', [channel.port2]);
}
function start(editor) {
  if (started) return; started = true;
  show('Connexion au canal de la session…');
  socket = new WebSocket(`ws://127.0.0.1:${editor.port}/editor?session=${encodeURIComponent(editor.sessionId)}&token=${encodeURIComponent(editor.editorToken)}`);
  socket.onmessage = event => {
    const m = JSON.parse(event.data);
    if (m.kind === 'activity') {
      document.querySelector('#activity').textContent = m.status.leaseOwner ? `● ${m.status.leaseOwner} travaille sur ce document` : 'Agents disponibles · document libre';
      return;
    }
    if (m.kind === 'fatal') { show(m.message); return; }
    if (m.kind === 'config') {
      config = m; connectEditor(); timer = setInterval(connectEditor, 500);
      setTimeout(() => { if (!connected) { clearInterval(timer); show('Le pont Pencil ne répond pas. Vérifier sa disponibilité et l’authentification.'); window.pencilPanelState = 'bridge-timeout'; } }, 15000);
    } else if (m.kind === 'request') {
      if (!port || !connected) { socket.send(JSON.stringify({ kind: 'response', id: m.id, error: { message: 'Moteur Pencil non connecté' } })); return; }
      port.postMessage(m);
    } else if (m.kind === 'storage-response') {
      if (typeof m.id === 'string' && m.id.startsWith('draft-')) { if (m.error) show(`Copie locale : ${m.error.message}`); return; }
      if (Array.isArray(m.payload)) m.payload = new Uint8Array(m.payload);
      if (m.error) show(`Stockage : ${m.error.message}`);
      else if (m.payload === 2) show('Conflit externe : sauvegarde refusée, garder cette vue ouverte');
      else show('Pencil · session connectée');
      port?.postMessage({ ...m, kind: 'response' });
    }
  };
  socket.onclose = () => { clearInterval(timer); port?.close(); show('Canal déconnecté · ne pas rejouer les modifications'); };
  socket.onerror = () => show('Canal local inaccessible dans cet hôte');
}
frame.addEventListener('load', () => { frameLoaded = true; connectEditor(); });
frame.src = 'https://app.pen.dev/new?embed';
window.pencilPanelState = 'loading';
if (window.pencilPanelPreview) start(window.pencilPanelPreview);
else {
  app = new App({ name: 'Pencil', version: '0.1.2' }, { availableDisplayModes: ['fullscreen'] });
  app.ontoolresult = result => { if (result._meta?.editor) start(result._meta.editor); };
  app.connect().catch(e => show(`Hôte MCP Apps : ${e.message}`));
}
