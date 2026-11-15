import { imagePoint } from './point.mjs';
import { keyboardInput } from './keyboard.mjs';
const image = document.querySelector('img'), status = document.querySelector('[role=status]');
const config = new URLSearchParams(location.hash.slice(1));
let socket;
let sequence = 0, remoteSize, pendingMove, activeButton;
const heldKeys = new Map();
const send = value => { if (socket?.readyState === 1) socket.send(JSON.stringify(value)); };
const input = value => { status.textContent = 'Connected'; send({ kind: 'input', id: ++sequence, input: value }); };
const point = event => remoteSize && imagePoint(image.getBoundingClientRect(), remoteSize, event.clientX, event.clientY);
const onmessage = async ({ data }) => {
  const message = JSON.parse(data);
  if (message.kind === 'frame') {
    image.src = `data:image/jpeg;base64,${message.data}`;
    try {
      await image.decode();
      remoteSize = message;
      image.dataset.rendererId = message.rendererId;
      image.dataset.frameId = String(message.id);
      if (status.textContent === 'Connecting…') status.textContent = 'Connected';
      send({ kind: 'frame-ack', id: message.id });
    } catch { status.textContent = 'Could not display the editor'; }
  } else if (message.kind === 'error') status.textContent = message.message;
  else if (message.kind === 'saved') status.textContent = 'Document saved';
};
const onclose = () => { status.textContent = 'Disconnected. The background document remains open.'; };
image.addEventListener('pointerdown', event => {
  const p = point(event); if (!p) return;
  pendingMove = p; activeButton = ['left', 'middle', 'right'][event.button];
  image.focus(); image.setPointerCapture(event.pointerId); event.preventDefault();
  input({ type: 'pointer', action: 'down', button: activeButton, ...p });
});
image.addEventListener('pointermove', event => {
  const p = point(event); if (!p) return;
  pendingMove = p;
  if (image.dataset.moveScheduled) return;
  image.dataset.moveScheduled = 'true';
  requestAnimationFrame(() => { delete image.dataset.moveScheduled; input({ type: 'pointer', action: 'move', ...pendingMove }); });
});
const release = event => {
  if (!image.hasPointerCapture(event.pointerId)) return;
  const p = point(event) ?? pendingMove;
  if (p) input({ type: 'pointer', action: 'up', button: activeButton, ...p });
  image.releasePointerCapture(event.pointerId);
};
image.addEventListener('pointerup', release);
image.addEventListener('pointercancel', release);
image.addEventListener('wheel', event => {
  const p = point(event); if (!p) return;
  event.preventDefault(); input({ type: 'wheel', deltaX: Math.max(-2000, Math.min(2000, event.deltaX)), deltaY: Math.max(-2000, Math.min(2000, event.deltaY)), ...p });
}, { passive: false });
for (const [eventName, action] of [['keydown', 'down'], ['keyup', 'up']]) image.addEventListener(eventName, event => {
  event.preventDefault();
  const value = keyboardInput(event, action, heldKeys);
  if (value) input(value);
});
image.addEventListener('paste', event => { event.preventDefault(); input({ type: 'text', text: event.clipboardData.getData('text/plain').slice(0, 4096) }); });
image.addEventListener('contextmenu', event => event.preventDefault());
image.addEventListener('blur', () => { heldKeys.clear(); send({ kind: 'cancel-input' }); });
document.querySelector('button').addEventListener('click', () => send({ kind: 'save' }));

async function boot() {
  if (window.pencilRemoteApp) {
    const [{ App }, { createMcpTransport }] = await Promise.all([import('@modelcontextprotocol/ext-apps'), import('../../web/mcp-transport.mjs')]);
    const app = new App({ name: 'Pencil persistent renderer experiment', version: '0.6.0-experiment' }, { availableDisplayModes: ['fullscreen'] });
    app.ontoolresult = result => {
      if (!socket && result._meta?.editor) socket = createMcpTransport(app, result._meta.editor, { onmessage, onclose, onerror: () => { status.textContent = 'View transport unavailable'; } });
    };
    app.onteardown = async () => { await socket?.close(); return {}; };
    await app.connect();
  } else {
    const url = new URL('/view', location.href); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('session', config.get('session')); url.searchParams.set('token', config.get('token'));
    socket = new WebSocket(url); socket.onmessage = onmessage; socket.onclose = onclose;
  }
}
void boot().catch(() => { status.textContent = 'Could not initialize the view'; });
