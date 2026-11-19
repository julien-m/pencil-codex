// Exercise the real view entrypoint against a host/DOM boundary, without another editor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, webcrypto } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { Script, createContext } from 'node:vm';
import { build } from 'esbuild';
import { encodeMessage } from '../shared/bridge-wire.mjs';

const bundle = await build({
  entryPoints: ['src/persistent/view.mjs'], bundle: true, format: 'iife', platform: 'browser', write: false,
  plugins: [{ name: 'host-boundary', setup(builder) {
    builder.onResolve({ filter: /^@modelcontextprotocol\/ext-apps$/ }, () => ({ path: 'host', namespace: 'test' }));
    builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export const App = globalThis.HostApp;' }));
  } }],
});

test('a new open result and automatic service recovery each display the replacement renderer', async () => {
  const connected = [], closed = [], channels = new Map();
  const renderedRecovery = Promise.withResolvers(), recoveryToken = randomUUID();
  let frameSequence = 0;
  let recoveryEditor;
  const image = { dataset: new Proxy({}, { set(target, key, value) {
    target[key] = value;
    if (key === 'rendererId' && value === recoveryEditor?.sessionId) renderedRecovery.resolve();
    return true;
  } }), setAttribute() {}, addEventListener() {}, async decode() {}, removeAttribute(name) { delete this[name]; } };
  const status = { textContent: 'Connecting…', toggleAttribute() {} };
  const viewport = { toggleAttribute() {}, getBoundingClientRect: () => ({ width: 800, height: 900 }) };
  const controls = ['hand', 'edit', 'zoomOut', 'zoomIn', 'openNative'].map(control => ({ dataset: { control }, setAttribute() {}, addEventListener() {} }));
  let app;
  class HostApp {
    constructor() { app = this; }
    async connect() {}
    async callServerTool({ arguments: args }) {
      if (args.action === 'recover') {
        assert.equal(args.recoveryToken, recoveryToken);
        return { structuredContent: recoveryEditor };
      }
      if (args.action === 'connect') {
        const connectionId = randomUUID(); connected.push(args.sessionId);
        channels.set(connectionId, { editor: args.sessionId, first: true, pending: Promise.withResolvers() });
        return { structuredContent: { connectionId } };
      }
      const channel = channels.get(args.connectionId);
      if (args.action === 'exchange') {
        if (channel.first) {
          channel.first = false;
          return { structuredContent: { messages: encodeMessage({ kind: 'frame', rendererId: channel.editor, id: ++frameSequence, width: 1, height: 1, data: '' }) } };
        }
        const pending = channel.pending;
        const result = await pending.promise;
        if (channel.pending === pending) channel.pending = Promise.withResolvers();
        return result;
      }
      if (args.action === 'close') {
        closed.push(args.connectionId); channel.pending.resolve({ structuredContent: { messages: [] } });
      }
      return { structuredContent: { accepted: 0 } };
    }
  }
  new Script(bundle.outputFiles[0].text).runInContext(createContext({
    HostApp, crypto: webcrypto, window: { pencilRemoteApp: true }, location: { hash: '' }, URLSearchParams, setTimeout, clearTimeout, AbortController, AbortSignal,
    ResizeObserver: class { observe() {} disconnect() {} },
    navigator: { language: 'en' },
    document: { documentElement: { lang: 'en' }, querySelectorAll: selector => selector === '[data-control]' ? controls : [], querySelector: selector => selector === 'img' ? image : selector === 'main' ? viewport : status, addEventListener() {}, removeEventListener() {} },
  }));
  try {
    await setImmediate();
    const editors = Array.from({ length: 2 }, () => ({ sessionId: randomUUID(), editorToken: randomUUID(), recoveryToken }));
    for (const editor of editors) { app.ontoolresult({ _meta: { editor } }); await setImmediate(); }
    assert.deepEqual(connected, editors.map(editor => editor.sessionId));
    assert.equal(image.dataset.rendererId, editors.at(-1).sessionId);
    assert.equal(closed.length, editors.length - 1);
    recoveryEditor = { sessionId: randomUUID(), editorToken: randomUUID(), recoveryToken };
    const current = [...channels.values()].at(-1);
    const staleDecode = Promise.withResolvers(), decodeStarted = Promise.withResolvers();
    image.decode = () => { image.decode = async () => {}; decodeStarted.resolve(); return staleDecode.promise; };
    current.pending.resolve({ structuredContent: { messages: encodeMessage({ kind: 'frame', rendererId: current.editor, id: ++frameSequence, width: 1, height: 1, data: '' }) } });
    await decodeStarted.promise;
    current.pending.resolve({ isError: true, content: [{ type: 'text', text: 'service restarted' }] });
    await renderedRecovery.promise;
    staleDecode.reject(new Error('late decode failure')); await setImmediate();
    assert.equal(image.dataset.rendererId, recoveryEditor.sessionId);
    assert.deepEqual(connected, [...editors, recoveryEditor].map(editor => editor.sessionId));
    assert.equal(status.textContent, 'Connected');
    const ended = [...channels.values()].at(-1);
    ended.pending.resolve({ structuredContent: { messages: encodeMessage({ kind: 'session-closed' }) } });
    await setImmediate();
    assert.equal(status.textContent, 'Session closed');
    assert.equal(image.src, undefined);
  } finally { await app.onteardown(); }
});
