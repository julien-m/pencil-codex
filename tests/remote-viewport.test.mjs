import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { RendererHost } from '../src/persistent/renderer.mjs';
import { panelViewport, MAX_VIEWPORT_EDGE, MAX_VIEWPORT_PIXELS } from '../src/persistent/point.mjs';

test('large and hidden panels stay inside the capture budget without stretching', () => {
  // Regression: rounding both axes up exceeded the budget for this actual counterexample.
  const panel = { width: 3001, height: 3000 }, size = panelViewport(panel, true);
  assert(size.width * size.height <= MAX_VIEWPORT_PIXELS);
  assert(size.width <= MAX_VIEWPORT_EDGE && size.height <= MAX_VIEWPORT_EDGE);
  assert(Math.abs(size.width - size.height * panel.width / panel.height) <= 1);
  assert.deepEqual(panelViewport({ width: 0, height: panel.height }, true), { visible: false });
  assert.deepEqual(panelViewport(panel, false), { visible: false });
});

test('resize retains the renderer, isolates other sessions and rejects stale pointer coordinates', async () => {
  const host = new RendererHost({}), session = randomUUID(), other = randomUUID();
  const moves = [], state = {
    id: randomUUID(), viewport: { width: 1280, height: 800 }, viewportRevision: 0,
    viewers: new Set(), inputTail: Promise.resolve(), pendingInputs: 0, keys: new Set(), buttons: new Set(),
    frameNumber: 0, cdp: { async send() {} },
    page: { async setViewportSize(size) { this.size = size; }, async screenshot() { return Buffer.from('image'); }, mouse: { async move(...point) { moves.push(point); } } },
  };
  const owner = { id: randomUUID(), socket: { readyState: 1, send() {} } }, mirror = { id: randomUUID(), socket: { readyState: 1, send() {} } };
  state.viewers.add(owner); state.viewers.add(mirror);
  host.sessions.set(session, Promise.resolve(state));
  const untouched = { viewport: { width: 1280, height: 800 } };
  host.sessions.set(other, Promise.resolve(untouched));
  const id = state.id, portrait = { width: 806, height: 939, visible: true };
  await host.resize(session, portrait, owner);
  assert.deepEqual(state.page.size, { width: portrait.width, height: portrait.height });
  assert.equal(state.id, id);
  assert.deepEqual(untouched.viewport, { width: 1280, height: 800 });
  await host.resize(session, { width: 1400, height: 650, visible: true }, mirror);
  assert.equal(state.viewport.width, portrait.width, 'a mirror cannot fight the visible owner');
  await assert.rejects(host.input(session, { type: 'pointer', action: 'move', x: .5, y: .5 }, owner, 0), /VIEWPORT_CHANGED/);
  await host.input(session, { type: 'pointer', action: 'move', x: .5, y: .5 }, owner, state.viewportRevision);
  assert.deepEqual(moves.at(-1), [portrait.width / 2, portrait.height / 2]);
  await host.resize(session, { visible: false }, owner);
  assert.equal(state.viewport.width, 1400, 'the remaining visible mirror takes ownership');
  await host.resize(session, { visible: false }, mirror);
  assert.equal(state.viewport.width, 1400, 'no zero viewport when all views hide');
  await assert.rejects(host.resize(session, { width: 1e9, height: 1e9, visible: true }, owner), /viewport|Viewport/);
  await host.prepareClose(session);
  await host.resize(session, portrait, owner);
  assert.equal(state.viewport.width, 1400, 'Save freezes geometry until its result is known');
  await host.resume(session);
  assert.equal(state.viewport.width, portrait.width, 'a failed Save applies the latest requested size on resume');
  await host.resize(session, panelViewport({ width: 3001, height: 3000 }, true), owner);
  assert(state.viewport.width * state.viewport.height <= MAX_VIEWPORT_PIXELS);
});
