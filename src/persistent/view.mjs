import { imagePoint, panelViewport } from './point.mjs';
import { keyboardInput } from './keyboard.mjs';
import { viewMessage } from './view-messages.mjs';
const image = document.querySelector('img'), status = document.querySelector('[role=status]'), viewport = document.querySelector('main');
let saveReady = false, feedbackTimer, resizeTimer, lastViewport;
const setStatus = (text, quiet = false) => {
  clearTimeout(feedbackTimer); status.textContent = text;
  status.toggleAttribute('data-quiet', quiet);
};
const announceSize = () => {
  if (socket?.readyState !== 1 || sessionFinished) return;
  const rect = viewport.getBoundingClientRect();
  const size = panelViewport(rect, !document.hidden);
  const key = JSON.stringify(size);
  if (key !== lastViewport) { lastViewport = key; send({ kind: 'resize', viewport: size }); }
};
const scheduleSize = () => {
  if (resizeTimer) return;
  resizeTimer = setTimeout(() => { resizeTimer = undefined; announceSize(); }, 60);
};
const sizeObserver = new ResizeObserver(scheduleSize);
sizeObserver.observe(viewport);
document.addEventListener('visibilitychange', scheduleSize);
const config = new URLSearchParams(location.hash.slice(1));
let socket, currentEditor, viewEpoch = 0, renderEpoch = 0, tearingDown = false, sessionFinished = false;
let sequence = 0, remoteSize, pendingMove, pendingMoveRevision, activeButton;
const heldKeys = new Map();
const send = value => { if (socket?.readyState === 1) socket.send(JSON.stringify(value)); };
const input = (value, revision = remoteSize?.viewportRevision) => { send({ kind: 'input', id: ++sequence, viewportRevision: revision, input: value }); };
const point = event => remoteSize && imagePoint(image.getBoundingClientRect(), remoteSize, event.clientX, event.clientY);
const onmessage = async ({ data }, isCurrent = () => true) => {
  if (!isCurrent()) return;
  const message = JSON.parse(data);
  if (message.kind === 'session-closed') {
    sessionFinished = true;
    renderEpoch++; remoteSize = undefined; lastViewport = undefined; heldKeys.clear(); saveReady = false;
    image.removeAttribute('src'); setStatus(viewMessage('sessionClosed', document.documentElement?.lang)); return;
  }
  if (message.kind === 'frame') {
    image.src = `data:image/jpeg;base64,${message.data}`;
    try {
      await image.decode();
      if (!isCurrent()) return;
      if (remoteSize?.viewportRevision !== message.viewportRevision) heldKeys.clear();
      remoteSize = message;
      image.dataset.rendererId = message.rendererId;
      image.dataset.frameId = String(message.id);
      saveReady = true;
      if (status.textContent === 'Connecting…') setStatus('Connected', true);
      scheduleSize();
      send({ kind: 'frame-ack', id: message.id });
    } catch { if (isCurrent()) setStatus('Could not display the editor'); }
  } else if (message.kind === 'error') {
    if (message.message !== 'VIEWPORT_CHANGED') setStatus(message.message);
  } else if (message.kind === 'saved') {
    setStatus('Document saved');
    feedbackTimer = setTimeout(() => setStatus('Document saved', true), 2000);
  }
};
const onclose = () => { saveReady = false; setStatus(sessionFinished ? viewMessage('sessionClosed', document.documentElement?.lang) : 'Disconnected. The background document remains open.'); };
image.addEventListener('pointerdown', event => {
  const p = point(event); if (!p) return;
  pendingMove = p; activeButton = ['left', 'middle', 'right'][event.button];
  image.focus(); image.setPointerCapture(event.pointerId); event.preventDefault();
  input({ type: 'pointer', action: 'down', button: activeButton, ...p });
});
image.addEventListener('pointermove', event => {
  const p = point(event); if (!p) return;
  pendingMove = p; pendingMoveRevision = remoteSize?.viewportRevision;
  if (image.dataset.moveScheduled) return;
  image.dataset.moveScheduled = 'true';
  requestAnimationFrame(() => { delete image.dataset.moveScheduled; input({ type: 'pointer', action: 'move', ...pendingMove }, pendingMoveRevision); });
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
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's' && !event.altKey && !event.shiftKey) {
    if (action === 'down' && !event.repeat && saveReady) send({ kind: 'save' });
    return;
  }
  const value = keyboardInput(event, action, heldKeys);
  if (value) input(value);
});
image.addEventListener('paste', event => { event.preventDefault(); input({ type: 'text', text: event.clipboardData.getData('text/plain').slice(0, 4096) }); });
image.addEventListener('contextmenu', event => event.preventDefault());
image.addEventListener('blur', () => { heldKeys.clear(); send({ kind: 'cancel-input' }); });


async function boot() {
  if (window.pencilRemoteApp) {
    const [{ App }, { createMcpTransport }] = await Promise.all([import('@modelcontextprotocol/ext-apps'), import('../../web/mcp-transport.mjs')]);
    const app = new App({ name: 'Pencil', version: '0.7.1' }, { availableDisplayModes: ['fullscreen'] });
    const showEditor = async editor => {
      if (tearingDown || (socket && socket.readyState !== 3 && currentEditor?.sessionId === editor.sessionId && currentEditor?.editorToken === editor.editorToken)) return;
      // Close the previous channel before replacement; ignore its late frames/errors.
      const epoch = ++viewEpoch, previous = socket;
      socket = undefined; currentEditor = editor; remoteSize = undefined; lastViewport = undefined; heldKeys.clear(); sessionFinished = false;
      image.dataset.sessionId = editor.sessionId; saveReady = false;
      await previous?.close();
      if (tearingDown || epoch !== viewEpoch) return;
      setStatus('Connecting…');
      const isCurrent = () => !tearingDown && epoch === viewEpoch;
      socket = createMcpTransport(app, editor, {
        onmessage: event => {
          const frameEpoch = renderEpoch;
          if (isCurrent()) void onmessage(event, () => isCurrent() && frameEpoch === renderEpoch);
        },
        onclose: () => { if (isCurrent()) onclose(); },
        onerror: () => { if (isCurrent()) setStatus('View transport unavailable'); },
        recovery: editor.recoveryToken ? {
          // Three 1-second-spaced attempts cover a supervised restart without endless polling.
          attempts: 3, delayMs: 1000,
          isReady: message => message.kind === 'frame',
          onreconnect: () => { if (isCurrent()) { renderEpoch++; remoteSize = undefined; lastViewport = undefined; heldKeys.clear(); saveReady = false; setStatus('Connecting…'); } },
          oneditor: next => { if (isCurrent()) { currentEditor = next; image.dataset.sessionId = next.sessionId; } },
          reopen: async (previousEditor, signal) => {
            const result = await app.callServerTool({ name: 'pencil_editor_bridge', arguments: { action: 'recover', recoveryToken: previousEditor.recoveryToken } }, { signal, timeout: 10_000 });
            if (result.isError || !result.structuredContent) throw new Error('VIEW_RECOVERY_FAILED');
            return result.structuredContent;
          },
        } : undefined,
      });
    };
    app.ontoolresult = result => { if (result._meta?.editor) void showEditor(result._meta.editor); };
    app.onteardown = async () => { sizeObserver.disconnect(); document.removeEventListener('visibilitychange', scheduleSize); clearTimeout(resizeTimer); clearTimeout(feedbackTimer); tearingDown = true; viewEpoch++; await socket?.close(); return {}; };
    await app.connect();
  } else {
    const url = new URL('/view', location.href); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('session', config.get('session')); url.searchParams.set('token', config.get('token'));
    socket = new WebSocket(url); socket.onmessage = onmessage; socket.onclose = onclose;
  }
}
void boot().catch(() => { setStatus('Could not initialize the view'); });
