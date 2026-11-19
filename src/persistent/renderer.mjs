import { chromium } from 'playwright-core';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { inputSchema, navigationSchema } from './input.mjs';
import { z } from 'zod';
import { MAX_VIEWPORT_EDGE, MAX_VIEWPORT_PIXELS } from './point.mjs';

// CSS pixels, bounded to keep an untrusted panel from allocating an enormous surface.
const FALLBACK_CAPTURE_INTERVAL_MS = 100;
const viewportSchema = z.discriminatedUnion('visible', [
  z.object({ visible: z.literal(false) }).strict(),
  z.object({ visible: z.literal(true), width: z.number().int().min(1).max(MAX_VIEWPORT_EDGE), height: z.number().int().min(1).max(MAX_VIEWPORT_EDGE) }).strict()
    .refine(size => size.width * size.height <= MAX_VIEWPORT_PIXELS, 'Viewport exceeds pixel budget'),
]);

// Serialized by Playwright and run inside the hosted editor, where Pencil handles canvas navigation.
function updateCanvasView({ navigation, clearHover }) {
  const surface = document.querySelector('[data-pencil-canvas-container="true"]');
  if (navigation) {
    if (!surface?.querySelector('canvas')) throw new Error('CANVAS_UNAVAILABLE');
    const { x, y, deltaX, deltaY, zoom } = navigation;
    const rect = surface.getBoundingClientRect();
    surface.dispatchEvent(new WheelEvent('wheel', {
      bubbles: true, cancelable: true, deltaX, deltaY, ctrlKey: zoom,
      clientX: rect.left + x * rect.width, clientY: rect.top + y * rect.height,
    }));
  }
  if (!clearHover || !surface || !document.body) return;
  // Pencil only clears its highlight on a canvas-to-outside transition. Some editor controls can highlight
  // a node without a canvas entry, so give it a complete transition outside the visible viewport.
  const outsideMove = () => new PointerEvent('pointermove', {
    bubbles: true, pointerType: 'mouse', clientX: -1, clientY: -1,
  });
  surface.dispatchEvent(outsideMove());
  document.body.dispatchEvent(outsideMove());
}

/** One invisible browser hosts an independent renderer for every broker session. */
export class RendererHost {
  constructor({ executablePath, origin, brokerPort, viewport = { width: 1280, height: 800 } }) {
    this.options = { executablePath, origin, brokerPort, viewport };
    this.sessions = new Map();
  }
  async browser() {
    if (!this.browserPromise) {
      this.browserPromise = chromium.launch({ executablePath: this.options.executablePath, headless: true, chromiumSandbox: true,
        args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
    }
    return this.browserPromise;
  }
  async ensure(sessionId, engineToken) {
    if (!this.sessions.has(sessionId)) {
      const pending = this.create(sessionId, engineToken);
      this.sessions.set(sessionId, pending);
      pending.catch(() => { if (this.sessions.get(sessionId) === pending) this.sessions.delete(sessionId); });
    }
    return this.sessions.get(sessionId);
  }
  async create(sessionId, token) {
    const browser = await this.browser();
    const context = await browser.newContext({ viewport: this.options.viewport });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const state = { id: randomUUID(), sessionId, context, page, viewport: { ...this.options.viewport }, viewportRevision: 0, viewportOwner: null, resizing: false, viewers: new Set(), frame: null, frameNumber: 0, inputTail: Promise.resolve(), pendingInputs: 0, streaming: false, controller: null, keys: new Set(), buttons: new Set() };
    try {
      // Each document has a fresh context. Apply the embed's own refusal before its scripts initialize.
      await context.addInitScript(() => {
        if (location.origin !== 'https://app.pen.dev' || location.pathname !== '/new' ||
            !new URLSearchParams(location.search).has('embed')) return;
        try { localStorage.setItem('pencil-cookie-consent', 'declined'); }
        catch { /* The editor's consent UI handles blocked browser storage. */ }
      });
      const hash = new URLSearchParams({ session: sessionId, token, brokerPort: String(this.options.brokerPort) });
      await page.goto(`${this.options.origin}/engine#${hash}`, { timeout: 30_000 });
      await page.waitForFunction(() => window.engineState === 'ready', undefined, { timeout: 30_000 });
      const cdp = await context.newCDPSession(page);
      state.cdp = cdp;
      await cdp.send('Page.enable');
      cdp.on('Page.screencastFrame', event => {
        void cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {});
        void this.receiveFrame(state, event);
      });
      return state;
    } catch (error) { await context.close(); throw error; }
  }
  /** Keep accurate pointer geometry even when Chrome's compositor reports a different surface size. */
  async receiveFrame(state, event, followup = false) {
    const { metadata, data } = event;
    if (state.resizing || state.closing) return;
    const { width, height } = state.viewport;
    if (metadata.deviceWidth === width && metadata.deviceHeight === height) {
      this.publish(state, data);
      return;
    }
    const active = state.fallbackCapture;
    if (active) {
      if (data !== active.event.data) {
        active.event = event;
        if (active.capturing) active.dirty = true;
      }
      return;
    }
    const capture = { event, capturing: false, dirty: false };
    state.fallbackCapture = capture;
    let repeat = false;
    const revision = state.viewportRevision, frame = state.frame;
    const needsCapture = () => state.streaming && !state.closing && !state.resizing &&
      state.viewportRevision === revision && state.frame === frame &&
      [...state.viewers].some(viewer => !viewer.closed && viewer.viewport?.visible !== false);
    try {
      // First allow a matching compositor frame to arrive. Coalesce mismatches into one exact viewport capture.
      await delay(FALLBACK_CAPTURE_INTERVAL_MS);
      if (!needsCapture()) return;
      capture.capturing = true;
      const pixels = await state.page.screenshot({ type: 'jpeg', quality: 75, timeout: 2000 });
      if (!needsCapture()) return;
      const exactFrame = pixels.toString('base64'), changed = frame?.data !== exactFrame;
      // Changes sampled too late get another capture. Identical follow-ups stop screenshot-driven updates.
      repeat = capture.dirty && (!followup || changed);
      if (changed) this.publish(state, exactFrame);
    } catch {
      // The temporary capture can race view teardown or a browser failure; the stream remains active.
    } finally { state.fallbackCapture = null; }
    if (repeat) void this.receiveFrame(state, capture.event, true);
  }
  publish(state, data) {
    state.frame = { kind: 'frame', rendererId: state.id, id: ++state.frameNumber, ...state.viewport, viewportRevision: state.viewportRevision, viewControls: true, data };
    for (const viewer of state.viewers) this.sendFrame(state, viewer);
  }
  sendFrame(state, viewer) {
    if (!state.frame || viewer.pendingFrame || viewer.lastFrame === state.frame.id || viewer.socket.readyState !== 1) return;
    viewer.pendingFrame = state.frame.id;
    viewer.pendingRevision = state.frame.viewportRevision;
    viewer.socket.send(JSON.stringify(state.frame));
  }
  async watch(sessionId, socket) {
    const state = await this.sessions.get(sessionId);
    if (!state) throw new Error('Renderer not found');
    if (state.closing) throw new Error('SESSION_CLOSING');
    const viewer = { id: randomUUID(), socket, pendingFrame: 0, lastFrame: 0, closed: false };
    state.viewers.add(viewer);
    if (!state.streaming) {
      state.streaming = true;
      await state.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 75, maxWidth: state.viewport.width, maxHeight: state.viewport.height });
    }
    this.publish(state, (await state.page.screenshot({ type: 'jpeg', quality: 75, timeout: 10_000 })).toString('base64'));
    return {
      input: (value, revision) => this.input(sessionId, value, viewer, revision),
      navigate: (value, revision) => this.navigate(sessionId, value, viewer, revision),
      resize: value => this.resize(sessionId, value, viewer),
      cancelInput: options => this.cancelInput(sessionId, viewer, options),
      acknowledge: id => {
        if (viewer.pendingFrame !== id) return;
        viewer.lastFrame = id; viewer.pendingFrame = 0; viewer.viewportRevision = viewer.pendingRevision;
        this.sendFrame(state, viewer);
      },
      close: async () => {
        viewer.closed = true;
        state.viewers.delete(viewer);
        await this.cancelInput(sessionId, viewer);
        await this.resize(sessionId, { visible: false }, viewer);
        if (!state.viewers.size && state.streaming) {
          state.streaming = false;
          await state.cdp.send('Page.stopScreencast').catch(() => {});
        }
      },
    };
  }
  async navigate(sessionId, value, viewer, revision) {
    const navigation = navigationSchema.parse(value);
    return this.withInput(sessionId, viewer, revision, async state => {
      if (state.keys.size || state.buttons.size) return;
      const frame = state.page.frames().find(candidate => candidate.url().startsWith('https://app.pen.dev/'));
      if (!frame) throw new Error('CANVAS_UNAVAILABLE');
      // A wheel event sent at browser level could be intercepted by a floating editor control.
      await frame.evaluate(updateCanvasView, { navigation, clearHover: state.controller === null });
    });
  }
  async input(sessionId, value, viewer, revision) {
    const input = inputSchema.parse(value);
    return this.withInput(sessionId, viewer, revision, async state => {
      state.controller = viewer.id;
      const page = state.page, viewport = state.viewport ?? this.options.viewport;
      if (input.type === 'pointer' || input.type === 'wheel') {
        await page.mouse.move(input.x * viewport.width, input.y * viewport.height);
        state.hasEditorPointer = true;
        if (input.type === 'wheel') await page.mouse.wheel(input.deltaX, input.deltaY);
        else if (input.action !== 'move') {
          await page.mouse[input.action]({ button: input.button });
          if (input.action === 'down') state.buttons.add(input.button); else state.buttons.delete(input.button);
        }
      } else if (input.type === 'key') {
        await page.keyboard[input.action](input.key);
        if (input.action === 'down') state.keys.add(input.key); else state.keys.delete(input.key);
      }
      else await page.keyboard.insertText(input.text);
    });
  }
  async withInput(sessionId, viewer, revision, dispatch) {
    const state = await this.sessions.get(sessionId);
    if (!state) throw new Error('Renderer not found');
    if (state.closing) throw new Error('SESSION_CLOSING');
    if (state.pendingInputs >= 100) throw new Error('Input queue full');
    state.pendingInputs++;
    const run = state.inputTail.then(async () => {
      if (viewer.closed) throw new Error('View disconnected before input dispatch');
      // Older views do not send revisions; their acknowledged frame still identifies geometry.
      if (state.viewportRevision !== undefined && (revision ?? viewer.viewportRevision ?? 0) !== state.viewportRevision) throw new Error('VIEWPORT_CHANGED');
      if (state.controller !== viewer.id && (state.keys.size || state.buttons.size)) throw new Error('Another view is completing an interaction');
      await dispatch(state);
    });
    state.inputTail = run.catch(() => {});
    try { await run; } finally { state.pendingInputs--; }
  }
  /** The first visible view owns geometry until it hides or disconnects; mirrors never fight it. */
  async resize(sessionId, value, viewer) {
    const size = viewportSchema.parse(value);
    const state = await this.sessions.get(sessionId);
    if (!state) throw new Error('SESSION_CLOSING');
    if (viewer.closed && size.visible) return;
    viewer.viewport = size;
    const run = state.inputTail.then(async () => {
      // Save/close freezes geometry. Retain the latest request for resume after a failed Save.
      if (state.closing) return;
      let owner = [...state.viewers].find(candidate => candidate.id === state.viewportOwner && !candidate.closed && candidate.viewport?.visible);
      owner ??= [...state.viewers].find(candidate => !candidate.closed && candidate.viewport?.visible);
      state.viewportOwner = owner?.id ?? null;
      if (!owner) return;
      const { width, height } = owner.viewport;
      if (state.viewport.width === width && state.viewport.height === height) return;
      // Resize is serialized with input. Release held keys/buttons rather than drag at stale coordinates.
      for (const key of state.keys) await state.page.keyboard.up(key);
      for (const button of state.buttons) await state.page.mouse.up({ button });
      state.keys.clear(); state.buttons.clear(); state.controller = null;
      await this.clearHover(state);
      state.resizing = true;
      try {
        if (state.streaming) await state.cdp.send('Page.stopScreencast');
        await state.page.setViewportSize({ width, height });
        state.viewport = { width, height }; state.viewportRevision++;
        state.frame = null;
        this.publish(state, (await state.page.screenshot({ type: 'jpeg', quality: 75, timeout: 10_000 })).toString('base64'));
      } finally {
        state.resizing = false;
        if (state.streaming) await state.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 75, maxWidth: state.viewport.width, maxHeight: state.viewport.height });
      }
    });
    state.inputTail = run.catch(() => {});
    return run;
  }
  async cancelInput(sessionId, viewer, { enteringHand = false } = {}) {
    const state = await this.sessions.get(sessionId);
    if (!state) return;
    const run = state.inputTail.then(async () => {
      if (state.controller === viewer.id) {
        for (const key of state.keys) await state.page.keyboard.up(key);
        for (const button of state.buttons) await state.page.mouse.up({ button });
        state.keys.clear(); state.buttons.clear(); state.controller = null;
        await this.clearHover(state, enteringHand);
      } else if (enteringHand && state.controller === null) {
        await this.clearHover(state, true);
      }
    });
    state.inputTail = run.catch(() => {});
    return run;
  }
  async clearHover(state, force = false) {
    if (!force && !state.hasEditorPointer) return;
    state.hasEditorPointer = false;
    const frame = state.page.frames().find(candidate => candidate.url().startsWith('https://app.pen.dev/'));
    await frame?.evaluate(updateCanvasView, { clearHover: true }).catch(() => {}); // The frame may be closing.
  }
  async status(sessionId) {
    const state = await this.sessions.get(sessionId);
    return state ? { rendererId: state.id, viewers: state.viewers.size, pendingInputs: state.pendingInputs, closed: state.page.isClosed() } : null;
  }
  async close() {
    const browser = await this.browserPromise;
    await browser?.close();
    this.sessions.clear();
  }
  /** Freeze input before Save; do not interrupt pending interactions. */
  async prepareClose(sessionId) {
    const state = await this.sessions.get(sessionId);
    if (!state || state.pendingInputs || state.keys.size || state.buttons.size) throw new Error('RENDERER_BUSY');
    state.closing = true; await state.inputTail;
  }
  async resume(sessionId) {
    const state = await this.sessions.get(sessionId);
    if (!state) return;
    state.closing = false;
    const viewer = [...state.viewers].find(candidate => !candidate.closed && candidate.viewport?.visible);
    if (viewer) await this.resize(sessionId, viewer.viewport, viewer);
  }
  /** Release one context and its viewers, retaining the shared browser and other contexts. */
  async closeSession(sessionId) {
    const state = await this.sessions.get(sessionId);
    if (!state) throw new Error('Renderer not found');
    for (const viewer of state.viewers) {
      const socket = viewer.socket;
      // A stale viewer must not prevent disposal of its editor.
      try {
        if (socket.readyState === 1) socket.send(JSON.stringify({ kind: 'session-closed' }), () => socket.close());
        else socket.terminate();
      } catch { socket.terminate(); }
    }
    let timer;
    try {
      // An uncertain close must never kill the shared browser or another document.
      await Promise.race([state.context.close(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('EDITOR_CLOSE_TIMEOUT')), 10_000); })]);
    } finally { clearTimeout(timer); }
    state.viewers.clear(); state.frame = null; this.sessions.delete(sessionId);
  }
}
