import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inputSchema } from '../experiments/remote-engine/input.mjs';
import { imagePoint } from '../experiments/remote-engine/point.mjs';
import { keyboardInput } from '../experiments/remote-engine/keyboard.mjs';
import { RendererHost } from '../experiments/remote-engine/renderer.mjs';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { attachViewChannel } from '../experiments/remote-engine/view-channel.mjs';

test('pointer mapping accounts for letterboxing and rejects the surrounding area', () => {
  const images = [{ width: 1200, height: 800 }, { width: 800, height: 1200 }];
  const rect = { left: 13, top: 29, width: 1000, height: 1000 };
  for (const image of images) {
    assert.deepEqual(imagePoint(rect, image, rect.left + rect.width / 2, rect.top + rect.height / 2), { x: 0.5, y: 0.5 });
    assert.equal(imagePoint(rect, image, rect.left - 1, rect.top), null);
    assert.equal(imagePoint({ ...rect, width: 0 }, image, rect.left, rect.top), null);
  }
});
test('disconnect cancels held input without letting another viewer release its keys', async () => {
  const host = new RendererHost({ viewport: { width: 1000, height: 600 } }), session = randomUUID();
  const calls = [], owner = { id: randomUUID() }, other = { id: randomUUID() };
  const state = { inputTail: Promise.resolve(), pendingInputs: 0, controller: null, keys: new Set(), buttons: new Set(), page: { keyboard: { down: async key => calls.push(['down', key]), up: async key => calls.push(['up', key]) } } };
  host.sessions.set(session, Promise.resolve(state));
  await host.input(session, { type: 'key', action: 'down', key: 'Shift' }, owner);
  await host.cancelInput(session, other);
  assert.equal(state.keys.size, 1);
  await assert.rejects(host.input(session, { type: 'key', action: 'down', key: 'a' }, other), /Another view/);
  owner.closed = true;
  await host.cancelInput(session, owner);
  assert.deepEqual(calls, [['down', 'Shift'], ['up', 'Shift']]);
  await assert.rejects(host.input(session, { type: 'key', action: 'down', key: 'b' }, owner), /disconnected/);
  await host.input(session, { type: 'key', action: 'down', key: 'c' }, other);
  assert.equal(state.controller, other.id);
});
test('remote inputs cannot carry script execution or target another document', () => {
  assert(inputSchema.safeParse({ type: 'text', text: 'Hello' }).success);
  assert(!inputSchema.safeParse({ type: 'pointer', action: 'down', x: -1, y: 0.5 }).success);
  assert(!inputSchema.safeParse({ type: 'key', action: 'evaluate', key: 'x' }).success);
  assert(!inputSchema.safeParse({ type: 'text', text: 'Hello', sessionId: 'another-session' }).success);
  assert(!inputSchema.safeParse({ type: 'text', text: 'x'.repeat(4097) }).success);
});
test('releasing Shift before a letter leaves no held key or blocked second view', async () => {
  const host = new RendererHost({}), session = randomUUID(), held = new Map();
  const state = { inputTail: Promise.resolve(), pendingInputs: 0, controller: null, keys: new Set(), buttons: new Set(), page: { keyboard: { down: async () => {}, up: async () => {} } } };
  host.sessions.set(session, Promise.resolve(state));
  const owner = { id: randomUUID() }, other = { id: randomUUID() };
  for (const [action, code, key] of [['down', 'ShiftLeft', 'Shift'], ['down', 'KeyA', 'A'], ['up', 'ShiftLeft', 'Shift'], ['up', 'KeyA', 'a']]) {
    await host.input(session, keyboardInput({ code, key }, action, held), owner);
  }
  assert.equal(state.keys.size, 0);
  assert.equal(held.size, 0);
  await host.input(session, { type: 'key', action: 'down', key: 'ArrowRight' }, other);
  await host.cancelInput(session, other);
  assert.equal(state.keys.size, 0);
});
test('an image acknowledgement arriving before attachment is retained', async () => {
  const peer = new EventEmitter(); peer.readyState = 1; peer.send = () => {}; peer.close = () => {};
  let attached;
  const pending = new Promise(resolve => { attached = resolve; });
  const acknowledgements = [];
  attachViewChannel(peer, pending, async () => {});
  const frameId = Math.floor(Math.random() * 10000);
  peer.emit('message', Buffer.from(JSON.stringify({ kind: 'frame-ack', id: frameId })));
  assert.deepEqual(acknowledgements, []);
  attached({ acknowledge: id => acknowledgements.push(id), close: async () => {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(acknowledgements, [frameId]);
});
test('closing one renderer context releases its cached frame and viewers without closing the shared browser', async () => {
  const { RendererHost } = await import('../experiments/remote-engine/renderer.mjs');
  const host = new RendererHost({}); let contextClosed = false, viewerClosed = false;
  const first = crypto.randomUUID(), other = crypto.randomUUID();
  const state = { pendingInputs: 0, keys: new Set(), buttons: new Set(), inputTail: Promise.resolve(), frame: { data: 'cached' }, context: { async close() { contextClosed = true; } }, viewers: new Set([{ socket: { readyState: 1, send(data, done) { assert.equal(JSON.parse(data).kind, 'session-closed'); done(); }, close() { viewerClosed = true; } } }]) };
  host.sessions.set(first, Promise.resolve(state)); host.sessions.set(other, Promise.resolve({}));
  host.browserPromise = Promise.resolve({ close() { assert.fail('Shared browser must remain open'); } });
  state.keys.add('Shift'); await assert.rejects(host.prepareClose(first), /RENDERER_BUSY/); state.keys.clear();
  await host.prepareClose(first); await host.closeSession(first);
  assert(contextClosed && viewerClosed); assert.equal(state.frame, null); assert.equal(state.viewers.size, 0);
  assert(!host.sessions.has(first)); assert(host.sessions.has(other));
});
