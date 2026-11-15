import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { installEmbedProbe } from './embed-engine-probe.mjs';

/** Characterize live synchronization using the hosted editor's public protocol. */
export async function runEmbedFeasibility(task, output) {
  const config = { uri: `file:///feasibility/${randomUUID()}/shared.pen`, content: JSON.stringify({ version: '2.22', children: [] }) };
  const pages = [await task.newPage(), await task.newPage()];
  for (const page of pages) {
    await page.cdp('Page.addScriptToEvaluateOnNewDocument', { source: `(${installEmbedProbe.toString()})(${JSON.stringify(config)})` });
    await page.goto('https://app.pen.dev/new?embed');
    await page.waitForFunction(() => window.penProbe?.ready, undefined, { timeout: 20_000 });
  }
  const text = result => result.content?.filter(item => item.type === 'text').map(item => item.text).join('\n') ?? '';
  const execute = async (page, input) => {
    const result = await page.evaluate(input => window.penProbe.request('mcp-tool-call', { name: 'execute', arguments: { input } }), input);
    assert(!result.isError, text(result));
    return result;
  };
  const evidence = [], challenges = pages.map(() => randomUUID());
  for (let index = 0; index < pages.length; index++) {
    const writer = pages[index], reader = pages[1 - index];
    const write = await execute(writer, `SetVariables({"view-${index}":{type:"string",value:${JSON.stringify(challenges[index])}}});Print(GetVariables());`);
    assert(text(write).includes(challenges[index]));
    await writer.evaluate(() => window.penProbe.request('save'));
    const snapshot = await writer.evaluate(() => window.penProbe.content);
    assert(snapshot.length > config.content.length, 'The engine must have saved a real document');
    // Model one shared backing store without decoding proprietary document data.
    await reader.evaluate(content => { window.penProbe.content = content; }, snapshot);
    const read = await execute(reader, 'Print(GetVariables());');
    evidence.push({ direction: `${index}->${1 - index}`, synchronized: text(read).includes(challenges[index]), write, read });
  }
  const requirementPassed = evidence.every(item => item.synchronized);
  const receipt = { time: new Date().toISOString(), uri: config.uri, requirementPassed, evidence, labels: pages.map(page => page.label) };
  await writeFile(output, JSON.stringify(receipt, null, 2));
  console.log({ requirementPassed, directions: evidence.map(({ direction, synchronized }) => ({ direction, synchronized })) });
  return receipt;
}
