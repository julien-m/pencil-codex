import { imagePoint, panelViewport } from './point.mjs';
import { keyboardInput } from './keyboard.mjs';
import { viewMessage } from './view-messages.mjs';
const image = document.querySelector('img'), status = document.querySelector('[role=status]'), viewport = document.querySelector('main');
const controls = Object.fromEntries([...document.querySelectorAll('[data-control]')].map(button => [button.dataset.control, button]));
const language = navigator.language || document.documentElement.lang;
document.documentElement.lang = language;
const label = key => viewMessage(key, language);
for (const group of document.querySelectorAll('[data-label]')) group.setAttribute('aria-label', label(group.dataset.label));
for (const key of ['hand', 'edit']) controls[key].textContent = label(key);
for (const key of ['zoomOut', 'zoomIn', 'openNative']) controls[key].setAttribute('aria-label', label(key));

let saveReady = false, viewControls = false, editing = false, openingNative = false, drag;
let feedbackTimer, resizeTimer, lastViewport;
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
const updateControls = () => {
  viewport.toggleAttribute('data-editing', editing);
  image.alt = label(editing ? 'editHelp' : 'readHelp');
  image.setAttribute('aria-keyshortcuts', editing ? 'Meta+S Control+S' : 'ArrowUp ArrowDown ArrowLeft ArrowRight + -');
  controls.hand.setAttribute('aria-pressed', String(!editing));
  controls.edit.setAttribute('aria-pressed', String(editing));
  controls.edit.disabled = !saveReady || openingNative;
  controls.openNative.disabled = !viewControls || openingNative;
  controls.openNative.title = label(saveReady && !viewControls ? 'updateService' : 'openHint');
  controls.zoomOut.disabled = controls.zoomIn.disabled = !viewControls || editing || openingNative;
};
const setEditing = value => {
  if (value === editing) return;
  editing = value;
  heldKeys.clear();
  pendingMove = pendingNavigation = activeButton = undefined;
  drag = undefined;
  delete image.dataset.dragging;
  if (viewControls) send({ kind: 'mode', editing });
  updateControls();
};
const resetControls = () => {
  saveReady = viewControls = openingNative = false;
  pendingMove = pendingNavigation = activeButton = drag = undefined;
  delete image.dataset.dragging;
  setEditing(false);
  updateControls();
};
const boundDelta = value => Math.max(-2000, Math.min(2000, value));
let pendingNavigation, navigationFrame;
const navigate = (deltaX, deltaY, zoom = false, anchor = { x: 0.5, y: 0.5 }) => {
  if (!viewControls || editing || openingNative || !remoteSize) return;
  const revision = remoteSize.viewportRevision;
  const previous = pendingNavigation;
  const merge = previous?.revision === revision && previous?.zoom === zoom;
  pendingNavigation = { ...anchor, deltaX: boundDelta(deltaX + (merge ? previous.deltaX : 0)),
    deltaY: boundDelta(deltaY + (merge ? previous.deltaY : 0)), zoom, revision };
  if (navigationFrame) return;
  navigationFrame = requestAnimationFrame(() => {
    navigationFrame = undefined;
    if (!pendingNavigation) return;
    const { revision, ...navigation } = pendingNavigation;
    pendingNavigation = undefined;
    send({ kind: 'navigate', navigation, viewportRevision: revision });
  });
};
controls.hand.addEventListener('click', () => setEditing(false));
controls.edit.addEventListener('click', () => setEditing(true));
controls.zoomIn.addEventListener('click', () => navigate(0, -100, true));
controls.zoomOut.addEventListener('click', () => navigate(0, 100, true));
controls.openNative.addEventListener('click', () => {
  if (!viewControls || openingNative) return;
  openingNative = true;
  setEditing(false);
  pendingNavigation = undefined;
  updateControls();
  setStatus(label('opening'));
  send({ kind: 'open-native' });
});
updateControls();

const onmessage = async ({ data }, isCurrent = () => true) => {
  if (!isCurrent()) return;
  const message = JSON.parse(data);
  if (message.kind === 'session-closed') {
    sessionFinished = true;
    renderEpoch++; remoteSize = undefined; lastViewport = undefined; heldKeys.clear(); resetControls();
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
      if (!saveReady) {
        viewControls = message.viewControls === true;
        if (viewControls) send({ kind: 'mode', editing: false });
        saveReady = true;
        updateControls();
      }
      if (status.textContent === 'Connecting…') setStatus('Connected', true);
      scheduleSize();
      send({ kind: 'frame-ack', id: message.id });
    } catch { if (isCurrent()) setStatus('Could not display the editor'); }
  } else if (message.kind === 'native-opened' || message.kind === 'native-open-failed') {
    openingNative = false;
    updateControls();
    if (message.kind === 'native-opened') {
      setStatus(label('opened'));
      feedbackTimer = setTimeout(() => setStatus(label('opened'), true), 2000);
    } else {
      const key = {
        NATIVE_UNAVAILABLE: 'nativeUnavailable',
        NATIVE_LAUNCH_FAILED: 'launchFailed',
        NATIVE_SOURCE_UNAVAILABLE: 'nativeSourceUnavailable',
      }[message.code];
      setStatus(key ? label(key) : message.message);
    }
  } else if (message.kind === 'error') {
    if (message.message !== 'VIEWPORT_CHANGED') setStatus(message.message);
  } else if (message.kind === 'saved') {
    setStatus('Document saved');
    feedbackTimer = setTimeout(() => setStatus('Document saved', true), 2000);
  }
};
const onclose = () => { resetControls(); setStatus(sessionFinished ? viewMessage('sessionClosed', document.documentElement?.lang) : 'Disconnected. The background document remains open.'); };
image.addEventListener('pointerdown', event => {
  const p = point(event); if (!p || event.button > 2 || openingNative || !saveReady) return;
  if (!editing) {
    if (drag || event.button !== 0) return;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
    image.dataset.dragging = '';
    image.focus();
    image.setPointerCapture(event.pointerId);
    event.preventDefault();
    return;
  }
  pendingMove = p; activeButton = ['left', 'middle', 'right'][event.button];
  image.focus(); image.setPointerCapture(event.pointerId); event.preventDefault();
  input({ type: 'pointer', action: 'down', button: activeButton, ...p });
});
image.addEventListener('pointermove', event => {
  if (openingNative || !saveReady) return;
  if (!editing) {
    if (drag?.id !== event.pointerId) return;
    const rect = image.getBoundingClientRect();
    navigate((drag.x - event.clientX) * remoteSize.width / rect.width, (drag.y - event.clientY) * remoteSize.height / rect.height);
    drag.x = event.clientX; drag.y = event.clientY;
    return;
  }
  const p = point(event); if (!p) return;
  pendingMove = p; pendingMoveRevision = remoteSize?.viewportRevision;
  if (image.dataset.moveScheduled) return;
  image.dataset.moveScheduled = 'true';
  requestAnimationFrame(() => { delete image.dataset.moveScheduled; if (editing && pendingMove && !openingNative) input({ type: 'pointer', action: 'move', ...pendingMove }, pendingMoveRevision); });
});
const release = event => {
  if (!image.hasPointerCapture(event.pointerId)) return;
  if (drag?.id === event.pointerId) { drag = undefined; delete image.dataset.dragging; }
  const p = point(event) ?? pendingMove;
  if (editing && !openingNative && p && activeButton) input({ type: 'pointer', action: 'up', button: activeButton, ...p });
  activeButton = undefined;
  image.releasePointerCapture(event.pointerId);
};
image.addEventListener('pointerup', release);
image.addEventListener('pointercancel', release);
image.addEventListener('lostpointercapture', event => {
  if (drag?.id === event.pointerId) { drag = undefined; delete image.dataset.dragging; }
});
image.addEventListener('wheel', event => {
  const p = point(event); if (!p) return;
  event.preventDefault();
  if (openingNative || !saveReady) return;
  if (!editing) {
    const scale = [1, 16, remoteSize.height][event.deltaMode] ?? 1;
    const zoom = event.ctrlKey || event.metaKey;
    navigate(zoom ? 0 : event.deltaX * scale, event.deltaY * scale, zoom, p);
    return;
  }
  input({ type: 'wheel', deltaX: boundDelta(event.deltaX), deltaY: boundDelta(event.deltaY), ...p });
}, { passive: false });
for (const [eventName, action] of [['keydown', 'down'], ['keyup', 'up']]) image.addEventListener(eventName, event => {
  if (event.key === 'Tab') return;
  if (!editing) {
    if (action !== 'down' || event.altKey || event.metaKey || event.ctrlKey) return;
    const step = 64;
    const movements = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step],
      '+': [0, -100, true], '=': [0, -100, true], '-': [0, 100, true] };
    if (Object.hasOwn(movements, event.key)) { event.preventDefault(); navigate(...movements[event.key]); }
    return;
  }
  event.preventDefault();
  if (!saveReady || openingNative) return;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's' && !event.altKey && !event.shiftKey) {
    if (action === 'down' && !event.repeat && saveReady) send({ kind: 'save' });
    return;
  }
  const value = keyboardInput(event, action, heldKeys);
  if (value) input(value);
});
image.addEventListener('paste', event => { event.preventDefault(); if (editing && saveReady && !openingNative) input({ type: 'text', text: event.clipboardData.getData('text/plain').slice(0, 4096) }); });
image.addEventListener('contextmenu', event => event.preventDefault());
image.addEventListener('blur', () => { heldKeys.clear(); if (editing) send({ kind: 'cancel-input' }); });


async function boot() {
  if (window.pencilRemoteApp) {
    const [{ App }, { createMcpTransport }] = await Promise.all([import('@modelcontextprotocol/ext-apps'), import('../../web/mcp-transport.mjs')]);
    const app = new App({ name: 'Pencil', version: '0.7.3' }, { availableDisplayModes: ['fullscreen'] });
    const showEditor = async editor => {
      if (tearingDown || (socket && socket.readyState !== 3 && currentEditor?.sessionId === editor.sessionId && currentEditor?.editorToken === editor.editorToken)) return;
      // Close the previous channel before replacement; ignore its late frames/errors.
      const epoch = ++viewEpoch, previous = socket;
      socket = undefined; currentEditor = editor; remoteSize = undefined; lastViewport = undefined; heldKeys.clear(); sessionFinished = false;
      image.dataset.sessionId = editor.sessionId; resetControls();
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
          onreconnect: () => { if (isCurrent()) { renderEpoch++; remoteSize = undefined; lastViewport = undefined; heldKeys.clear(); resetControls(); setStatus('Connecting…'); } },
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
