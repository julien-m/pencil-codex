import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';

/** Exercise pointer, keyboard, Save and agent-to-view rendering through one live page. */
export async function runUIProbe(page, connection, probe, output) {
  const rpc = async (method, args) => {
    const response = await fetch(`${connection.origin}/rpc`, { method: 'POST', headers: { Authorization: `Bearer ${connection.token}` }, body: JSON.stringify({ method, args }), signal: AbortSignal.timeout(10_000) });
    const body = await response.json(); assert(!body.error, JSON.stringify(body.error)); return body.result;
  };
  const execute = async input => {
    const result = await rpc('call', { sessionId: probe.a.sessionId, lease: probe.agent1.lease, tool: 'execute', arguments: { input } });
    assert(!result.isError); return result;
  };
  const node = async () => {
    const result = await execute(`Print({node:Get(${JSON.stringify(probe.nodeA)},{depth:0})});`);
    return JSON.parse(result.content.find(item => item.type === 'text').text.split('\n').find(line => line.startsWith('{'))).node;
  };
  await page.reload();
  await page.waitForFunction(() => document.querySelector('img').dataset.rendererId, undefined, { timeout: 10_000 });
  const before = await node(), rgb = before.fill.slice(1).match(/../g).map(byte => parseInt(byte, 16));
  const target = await page.evaluate(rgb => {
    const image = document.querySelector('img'), canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let x = 0, y = 0, count = 0;
    for (let i = 0; i < pixels.length; i += 4) if (Math.abs(pixels[i] - rgb[0]) + Math.abs(pixels[i + 1] - rgb[1]) + Math.abs(pixels[i + 2] - rgb[2]) < 50) {
      x += (i / 4) % canvas.width; y += Math.floor(i / 4 / canvas.width); count++;
    }
    if (!count) throw new Error('The engine frame is not visible');
    const rect = image.getBoundingClientRect(), scale = Math.min(rect.width / canvas.width, rect.height / canvas.height);
    return { x: rect.left + (rect.width - canvas.width * scale) / 2 + x / count * scale, y: rect.top + (rect.height - canvas.height * scale) / 2 + y / count * scale };
  }, rgb);
  await page.mouse.click(target.x, target.y, { label: 'select the engine frame' });
  await page.press('img', 'ArrowRight');
  let after;
  const until = Date.now() + 5000;
  while (Date.now() < until) { after = await node(); if (after.x !== before.x) break; await new Promise(resolve => setTimeout(resolve, 100)); }
  assert(after.x > before.x, 'Remote keyboard input must move the same node seen by agents');
  const changedColor = '#4C9F74';
  await execute(`Update(${JSON.stringify(probe.nodeA)},{fill:${JSON.stringify(changedColor)}});`);
  const expected = changedColor.slice(1).match(/../g).map(byte => parseInt(byte, 16));
  await page.waitForFunction(rgb => {
    const image = document.querySelector('img'), canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0); const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let matched = 0;
    for (let i = 0; i < pixels.length; i += 4) if (Math.abs(pixels[i] - rgb[0]) + Math.abs(pixels[i + 1] - rgb[1]) + Math.abs(pixels[i + 2] - rgb[2]) < 35) matched++;
    return matched > 1000;
  }, expected, { timeout: 10_000 });
  await page.click('loc=role:button[name="Save document"]');
  await page.waitForFunction(() => document.querySelector('[role=status]').textContent === 'Document saved', undefined, { timeout: 10_000 });
  const state = await rpc('status', { sessionId: probe.a.sessionId });
  assert.equal(state.saveState, 'source-saved');
  assert.equal(state.renderer.rendererId, probe.a.renderer.rendererId);
  const receipt = { status: 'passed', rendererId: state.renderer.rendererId, nodeId: probe.nodeA, before: { x: before.x, y: before.y }, after: { x: after.x, y: after.y }, pointerTargetDerivedFromLivePixels: true, remoteSave: true, agentColorVisible: changedColor };
  await writeFile(output, JSON.stringify(receipt, null, 2));
  return receipt;
}
