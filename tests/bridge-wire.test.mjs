import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeMessage, MessageDecoder, BRIDGE_CHUNK_CHARS } from '../shared/bridge-wire.mjs';
for (const length of [17, BRIDGE_CHUNK_CHARS + 3, 3 * 1024 * 1024]) test(`bridge round-trips ${length} characters without oversized tool messages`, () => {
  const message = { kind: 'storage-response', payload: { content: 'é🙂\\"'.repeat(Math.ceil(length / 5)).slice(0, length) } };
  const chunks = encodeMessage(message), decoder = new MessageDecoder(); let decoded;
  for (const chunk of chunks) {
    assert(chunk.data.length <= BRIDGE_CHUNK_CHARS);
    const value = decoder.accept(chunk); if (value !== undefined) decoded = value;
  }
  assert.deepEqual(decoded, message);
});
test('missing, reordered and malformed chunks fail rather than replaying an operation', () => {
  const chunks = encodeMessage({ content: 'x'.repeat(BRIDGE_CHUNK_CHARS * 2) });
  assert.throws(() => new MessageDecoder().accept(chunks[1]), /OUT_OF_ORDER/);
  const decoder = new MessageDecoder(); decoder.accept(chunks[0]);
  assert.throws(() => decoder.accept(chunks[0]), /OUT_OF_ORDER/);
  assert.throws(() => new MessageDecoder().accept({}), /INVALID_EDITOR_CHUNK/);
});
