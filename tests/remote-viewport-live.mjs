// Explicit opt-in: real hosted editor, disposable service/browser/documents only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { chromium } from 'playwright-core';
import { startRemoteExperiment } from '../src/persistent/server.mjs';

test('hosted editor fills its panel, saves through the view and preserves shared/isolated documents', { timeout: 120_000 }, async () => {
  const runtime = await mkdtemp(path.join(os.tmpdir(), 'pencil-viewport-'));
  const output = path.resolve(process.env.PENCIL_VIEWPORT_EVIDENCE ?? '.runtime/viewport-evidence');
  await mkdir(output, { recursive: true });
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const executablePath = process.env.PENCIL_TEST_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  let service, browser;
  try {
    service = await startRemoteExperiment({ port, executablePath, runtimeDirectory: runtime });
    browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: true });
    const rpc = async (method, args = {}) => {
      const response = await fetch(`${service.origin}/rpc`, { method: 'POST', headers: { authorization: `Bearer ${service.token}` }, body: JSON.stringify({ method, args }), signal: AbortSignal.timeout(65_000) });
      const body = await response.json();
      if (body.error) throw Object.assign(new Error(body.error.message), { code: body.error.code });
      return body.result;
    };
    const files = ['shared.pen', 'isolated.pen'].map(name => path.join(runtime, name));
    const [a, b] = await Promise.all(files.map(file => rpc('new', { path: file, scope: randomUUID() })));
    const [one, two, other] = await Promise.all([
      rpc('acquire', { sessionId: a.sessionId, agent: 'one' }), rpc('acquire', { sessionId: a.sessionId, agent: 'two' }), rpc('acquire', { sessionId: b.sessionId, agent: 'other' }),
    ]);
    assert.notEqual(one.lease, two.lease);
    const execute = async (session, participant, input) => {
      const result = await rpc('call', { sessionId: session.sessionId, lease: participant.lease, tool: 'execute', arguments: { input } });
      assert(!result.isError, JSON.stringify(result.content));
      return result.content?.filter(item => item.type === 'text').map(item => item.text).join('\n') ?? '';
    };
    const challenges = Array.from({ length: 3 }, () => randomUUID());
    for (const [session, participant, value, index] of [[a, one, challenges[0], 0], [a, two, challenges[1], 1], [b, other, challenges[2], 2]]) {
      await execute(session, participant, `SetVariables({"viewport-test-${index}":{type:"string",value:${JSON.stringify(value)}}});`);
    }
    const shared = await execute(a, one, 'Print(GetVariables());'), isolated = await execute(b, other, 'Print(GetVariables());');
    assert(challenges.slice(0, 2).every(value => shared.includes(value)) && !shared.includes(challenges[2]));
    assert(isolated.includes(challenges[2]) && challenges.slice(0, 2).every(value => !isolated.includes(value)));
    const view = await browser.newPage({ viewport: { width: 806, height: 939 } });
    view.setDefaultTimeout(10_000);
    const errors = []; view.on('pageerror', error => errors.push(error.message));
    await view.goto(a.viewURL);
    const state = await service.renderer.sessions.get(a.sessionId), otherState = await service.renderer.sessions.get(b.sessionId);
    const rendererId = state.id, otherSize = { ...otherState.viewport };
    const waitSize = async size => {
      await view.waitForFunction(size => {
        const image = document.querySelector('img'), rect = image.getBoundingClientRect();
        return image.naturalWidth === size.width && image.naturalHeight === size.height && rect.x === 0 && rect.y === 0 && rect.width === size.width && rect.height === size.height;
      }, size);
      assert.deepEqual(state.page.viewportSize(), size);
      assert.equal(state.id, rendererId);
      assert.equal(await view.locator('header,button[data-testid="remote-save-document"]').count(), 0);
    };
    await waitSize({ width: 806, height: 939 });
    await view.screenshot({ path: path.join(output, 'portrait.png') });
    await view.setViewportSize({ width: 1440, height: 720 });
    await waitSize({ width: 1440, height: 720 });
    assert.deepEqual(otherState.viewport, otherSize);
    // Derive the pointer position from the rendered surface rather than canvas node fixtures.
    const box = await view.getByTestId('remote-editor-image').boundingBox();
    await view.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await view.keyboard.press('Control+s');
    await view.waitForFunction(() => document.querySelector('[role=status]').textContent === 'Document saved');
    assert.equal((await rpc('status', { sessionId: a.sessionId })).saveState, 'source-saved');
    const saved = await readFile(files[0]);
    assert(saved.length > 0);
    await view.keyboard.press('Meta+s');
    await view.waitForFunction(() => document.querySelector('[role=status]').textContent === 'Document saved');
    await view.screenshot({ path: path.join(output, 'landscape.png') });
    // Zero-size embedding (hidden Codex panel) keeps the last valid geometry and engine.
    await view.locator('main').evaluate(main => { main.style.display = 'none'; });
    await view.waitForFunction(() => document.querySelector('main').getBoundingClientRect().width === 0);
    const background = randomUUID();
    await execute(a, two, `SetVariables({"background-test":{type:"string",value:${JSON.stringify(background)}}});`);
    await view.locator('main').evaluate(main => { main.style.removeProperty('display'); });
    await view.setViewportSize({ width: 806, height: 939 }); await waitSize({ width: 806, height: 939 });
    assert((await execute(a, one, 'Print(GetVariables());')).includes(background));
    await view.close();
    const reopened = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    await reopened.goto(a.viewURL);
    await reopened.waitForFunction(() => document.querySelector('img').naturalWidth === 1000 && document.querySelector('img').naturalHeight === 800);
    assert.equal(state.id, rendererId);
    assert.deepEqual(otherState.viewport, otherSize);
    assert(!(await execute(b, other, 'Print(GetVariables());')).includes(background));
    assert.deepEqual(errors, []);
    // Restore and publish the genuine engine content after the conflict test.
    await rpc('save', { sessionId: a.sessionId, lease: one.lease });
    await rpc('release', { sessionId: a.sessionId, lease: two.lease });
    await rpc('close', { sessionId: a.sessionId, lease: one.lease });
    const restored = await rpc('open', { path: files[0], scope: a.scope, intent: 'explicit' });
    const restoredAgent = await rpc('acquire', { sessionId: restored.sessionId, agent: 'restored' });
    const restoredVariables = await execute(restored, restoredAgent, 'Print(GetVariables());');
    assert([...challenges.slice(0, 2), background].every(value => restoredVariables.includes(value)));
    const conflictView = await browser.newPage({ viewport: { width: 806, height: 939 } });
    await conflictView.goto(restored.viewURL);
    await conflictView.waitForFunction(() => !!document.querySelector('img').dataset.frameId);
    await conflictView.getByTestId('remote-editor-image').focus();
    const external = await readFile(files[1]);
    await writeFile(files[0], external);
    await conflictView.keyboard.press('Meta+s');
    await conflictView.waitForFunction(() => {
      const status = document.querySelector('[role=status]');
      return !status.hasAttribute('data-quiet') && status.textContent.includes('chang');
    });
    assert.deepEqual(await readFile(files[0]), external);
    // The intentionally conflicted disposable editor is retained until service teardown.
    await rpc('close', { sessionId: b.sessionId, lease: other.lease });
    await writeFile(path.join(output, 'receipt.json'), JSON.stringify({ status: 'passed', portrait: [806, 939], landscape: [1440, 720], sameRendererAfterResizeAndReopen: true, savedSourceAndRestoredContent: true, conflictPreservedExternalBytes: true, agentsShareDocument: true, sessionsIsolated: true, activePluginTouched: false, surface: 'isolated standalone view using the same view entrypoint; not a native Codex panel' }, null, 2));
  } finally {
    await browser?.close(); await service?.close();
    await rm(runtime, { recursive: true, force: true });
  }
});
