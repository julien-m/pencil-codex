// Verify that view recovery can reopen only the document authorized by its original grant.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, unlink, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { ViewRecovery } from '../experiments/remote-engine/view-recovery.mjs';

test('recovery grants retain canonical document/scope authority and coalesce concurrent reopen requests', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pen-recovery-'));
  try {
    const files = Array.from({ length: 2 }, () => path.join(directory, `${randomUUID()}.pen`));
    await Promise.all(files.map(file => writeFile(file, randomUUID())));
    const alias = path.join(directory, 'alias.pen'); await symlink(files[0], alias);
    const opened = [], response = Promise.withResolvers();
    const recovery = new ViewRecovery(async document => { opened.push(document); return response.promise; });
    const document = { path: alias, scope: randomUUID() };
    const first = await recovery.remember(document, { sessionId: randomUUID(), editorToken: randomUUID() });
    const again = await recovery.remember(document, { sessionId: randomUUID(), editorToken: randomUUID() });
    const other = await recovery.remember({ path: files[1], scope: randomUUID() }, { sessionId: randomUUID(), editorToken: randomUUID() });
    assert.equal(first.recoveryToken, again.recoveryToken);
    assert.notEqual(first.recoveryToken, other.recoveryToken);
    await assert.rejects(recovery.recover(randomUUID()), /VIEW_RECOVERY_NOT_FOUND/);
    await unlink(alias); await symlink(files[1], alias);
    const requests = Array.from({ length: 4 }, () => recovery.recover(first.recoveryToken));
    const next = { sessionId: randomUUID(), editorToken: randomUUID() }; response.resolve(next);
    const results = await Promise.all(requests);
    assert.deepEqual(opened, [{ path: await realpath(files[0]), scope: document.scope }]);
    for (const result of results) assert.deepEqual(result, { ...next, recoveryToken: first.recoveryToken });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a failed reopen releases its single-flight slot so a later service recovery can succeed', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pen-recovery-failure-'));
  try {
    const file = path.join(directory, `${randomUUID()}.pen`); await writeFile(file, randomUUID());
    let available = false;
    const next = { sessionId: randomUUID(), editorToken: randomUUID() };
    const recovery = new ViewRecovery(async () => { if (!available) throw new Error('service offline'); return next; });
    const grant = await recovery.remember({ path: file, scope: randomUUID() }, { sessionId: randomUUID(), editorToken: randomUUID() });
    await assert.rejects(recovery.recover(grant.recoveryToken), /service offline/);
    available = true;
    assert.deepEqual(await recovery.recover(grant.recoveryToken), { ...next, recoveryToken: grant.recoveryToken });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('closing a session revokes its recovery grant until a new explicit open issues another', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'pen-recovery-close-'));
  try {
    const file = path.join(directory, `${randomUUID()}.pen`); await writeFile(file, randomUUID());
    const editor = { sessionId: randomUUID(), editorToken: randomUUID() }, document = { path: file, scope: randomUUID() };
    const recovery = new ViewRecovery(async () => editor);
    const first = await recovery.remember(document, editor);
    recovery.invalidate(editor.sessionId);
    await assert.rejects(recovery.recover(first.recoveryToken), /VIEW_RECOVERY_NOT_FOUND/);
    const next = await recovery.remember(document, { sessionId: randomUUID(), editorToken: randomUUID() });
    assert.notEqual(next.recoveryToken, first.recoveryToken);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
