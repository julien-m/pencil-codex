import { test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createDocument, writeNewFile } from '../src/artifacts.mjs';
import { Sessions } from '../src/sessions.mjs';
let directory;
beforeEach(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pencil-files-')); });
afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });
test('new document and Save As use the chosen directory without overwriting existing files', async () => {
  const original = path.join(directory, 'new.pen'); await createDocument(original);
  await expect(createDocument(original)).rejects.toMatchObject({ code: 'EEXIST' });
  const sessions = new Sessions({ draftRoot: path.join(directory, 'drafts') });
  const { sessionId } = await sessions.open(original, 's'); const { generation, fileURI } = sessions.attach(sessionId, () => {});
  await sessions.storage(sessionId, generation, 'storage-load');
  await sessions.storage(sessionId, generation, 'storage-write', { fileURI, content: 'opaque-saved-snapshot' });
  const { lease } = sessions.acquire(sessionId, 'agent');
  const target = path.join(directory, 'chosen-name.pen');
  expect((await sessions.saveAs(sessionId, lease, target)).path).toBe(await fs.realpath(target));
  expect(await fs.readFile(target, 'utf8')).toBe('opaque-saved-snapshot');
  await expect(sessions.saveAs(sessionId, lease, target)).rejects.toMatchObject({ code: 'EEXIST' });
});
test('captures persist engine PNG bytes at the chosen destination', async () => {
  const source = path.join(directory, 'test.pen'); await createDocument(source);
  const sessions = new Sessions(); const { sessionId } = await sessions.open(source, 's'); const { lease } = sessions.acquire(sessionId, 'agent');
  const png = Buffer.from([137,80,78,71,13,10,26,10,0]);
  sessions.call = async () => ({ content: [{ type: 'image', mimeType: 'image/png', data: png.toString('base64') }] });
  const result = await sessions.capture(sessionId, lease, ['document'], directory);
  expect(result.structuredContent.files).toHaveLength(1);
  expect(await fs.readFile(result.structuredContent.files[0])).toEqual(png);
});
test('exclusive file write does not replace a pre-existing destination', async () => {
  const target = path.join(directory, 'existing.png'); await fs.writeFile(target, 'original');
  await expect(writeNewFile(target, Buffer.from('replacement'))).rejects.toMatchObject({ code: 'EEXIST' });
  expect(await fs.readFile(target, 'utf8')).toBe('original');
});
test('Save flushes the engine, updates the opened file and keeps its previous bytes', async () => {
  const file = path.join(directory, 'edit.pen'); await fs.writeFile(file, 'original');
  const sessions = new Sessions({ draftRoot: path.join(directory, 'drafts') });
  const { sessionId } = await sessions.open(file, 's');
  let generation, fileURI, flushed;
  ({ generation, fileURI } = sessions.attach(sessionId, message => {
    flushed = (async () => {
      expect(message.method).toBe('save');
      await sessions.storage(sessionId, generation, 'storage-write', { fileURI, content: 'latest-unsaved-edit' });
      sessions.reply(sessionId, generation, { id: message.id, payload: 0 });
    })();
  }));
  await sessions.storage(sessionId, generation, 'storage-load');
  const { lease } = sessions.acquire(sessionId, 'agent');
  const saved = await sessions.save(sessionId, lease); await flushed;
  expect(await fs.readFile(file, 'utf8')).toBe('latest-unsaved-edit');
  expect(await fs.readFile(saved.backupPath, 'utf8')).toBe('original');
  expect(sessions.status(sessionId).saveState).toBe('source-saved');
  await sessions.storage(sessionId, generation, 'storage-write', { fileURI, content: 'next-edit' });
  sessions.detach(sessionId, generation);
  const reopened = new Sessions({ draftRoot: path.join(directory, 'drafts') });
  const other = await reopened.open(file, 's');
  const channel = reopened.attach(other.sessionId, () => {});
  expect((await reopened.storage(other.sessionId, channel.generation, 'storage-load')).content).toBe('next-edit');
  expect(reopened.status(other.sessionId).saveState).toBe('draft-saved');
});
test('external changes survive reload and the newest conflicted draft can be saved separately', async () => {
  const file = path.join(directory, 'conflict.pen'); await fs.writeFile(file, 'original');
  const options = { draftRoot: path.join(directory, 'drafts') };
  const first = new Sessions(options); const { sessionId } = await first.open(file, 's');
  const c = first.attach(sessionId, () => {}); await first.storage(sessionId, c.generation, 'storage-load');
  await first.storage(sessionId, c.generation, 'storage-write', { fileURI: c.fileURI, content: 'draft' });
  await fs.writeFile(file, 'external-change');
  const second = new Sessions(options); const opened = await second.open(file, 's');
  let channel; channel = second.attach(opened.sessionId, m => second.reply(opened.sessionId, channel.generation, { id: m.id, payload: 1 }));
  await second.storage(opened.sessionId, channel.generation, 'storage-load');
  expect(second.status(opened.sessionId).saveState).toBe('conflict');
  expect(await second.storage(opened.sessionId, channel.generation, 'storage-write', { fileURI: channel.fileURI, content: 'newest-draft' })).toBe(2);
  const { lease } = second.acquire(opened.sessionId, 'agent');
  await expect(second.save(opened.sessionId, lease)).rejects.toMatchObject({ code: 'SAVE_CONFLICT' });
  const copy = path.join(directory, 'recovered.pen'); await second.saveAs(opened.sessionId, lease, copy);
  expect(await fs.readFile(copy, 'utf8')).toBe('newest-draft');
  expect(await fs.readFile(file, 'utf8')).toBe('external-change');
});
test('Save detects a write during claiming and never overwrites a new competing file', async () => {
  const { replaceDocument } = await import('../src/artifacts.mjs');
  const { createHash } = await import('node:crypto');
  const hash = createHash('sha256').update('original').digest('hex');
  const file = path.join(directory, 'racing.pen'); await fs.writeFile(file, 'original');
  await expect(replaceDocument(file, Buffer.from('draft'), hash, { ...fs, rename: async (from, to) => {
    await fs.writeFile(from, 'changed-before-claim'); await fs.rename(from, to);
  } })).rejects.toMatchObject({ code: 'SAVE_CONFLICT' });
  expect(await fs.readFile(file, 'utf8')).toBe('changed-before-claim');
  await fs.writeFile(file, 'original');
  await expect(replaceDocument(file, Buffer.from('draft'), hash, { ...fs, link: async (from, to) => {
    if (from.endsWith('pending.pen')) await fs.writeFile(to, 'competing-new-file', { flag: 'wx' });
    return fs.link(from, to);
  } })).rejects.toMatchObject({ code: 'SAVE_CONFLICT' });
  expect(await fs.readFile(file, 'utf8')).toBe('competing-new-file');
});
