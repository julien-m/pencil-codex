import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Sessions } from '../src/sessions.mjs';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
let dir;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pencil-test-')); await fs.writeFile(path.join(dir, 'a.pen'), 'opaque-original'); await fs.writeFile(path.join(dir, 'b.pen'), 'opaque-b'); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });
describe('session routing and reservations', () => {
  test('same scope shares the document; another session cannot attach a second writer', async () => {
    const r = new Sessions({draftRoot: path.join(dir, 'drafts')}); const a = await r.open(path.join(dir, 'a.pen'), 'thread-a');
    expect((await r.open(path.join(dir, 'a.pen'), 'thread-a')).sessionId).toBe(a.sessionId);
    expect((await r.open(path.join(dir, 'b.pen'), 'thread-b')).sessionId).not.toBe(a.sessionId);
    await expect(r.open(path.join(dir, 'a.pen'), 'thread-b')).rejects.toMatchObject({ code: 'DOCUMENT_BUSY' });
  });
  test('two agents join one document without excluding each other', async () => {
    const r = new Sessions({draftRoot: path.join(dir, 'drafts')}); const { sessionId: id } = await r.open(path.join(dir, 'a.pen'), 's');
    const first = r.acquire(id, 'A'); const second = r.acquire(id, 'B');
    expect(first.lease).not.toBe(second.lease);
    expect(r.status(id).agents.map(x => x.agent)).toEqual(['A', 'B']);
    r.release(id, first.lease); expect(r.status(id).agents.map(x => x.agent)).toEqual(['B']);
    expect(() => r.call(id, first.lease, 'execute', { input: '' })).toThrow('Participation');
    r.release(id, second.lease);
  });
  test('dispatches both agent calls before either reply and correlates reversed replies', async () => {
    const r = new Sessions({draftRoot: path.join(dir, 'drafts')}); const { sessionId: id } = await r.open(path.join(dir, 'a.pen'), 's'); const requests = [];
    const { generation } = r.attach(id, m => requests.push(m));
    const a = r.acquire(id, 'A'); const b = r.acquire(id, 'B');
    const first = r.call(id, a.lease, 'execute', {input: 'Print("A")'});
    const second = r.call(id, b.lease, 'execute', {input: 'Print("B")'});
    expect(requests).toHaveLength(2);
    expect(r.status(id).activeCalls).toBe(2);
    expect(() => r.release(id, a.lease)).toThrow('cours');
    await expect(r.save(id, a.lease)).rejects.toMatchObject({code:'SAVE_NOT_READY'});
    r.reply(id, generation, {id:requests[1].id, payload:{content:[{type:'text',text:'B'}]}});
    expect((await second).content[0].text).toBe('B');
    r.release(id, b.lease);
    expect(r.status(id).agents.map(x => x.agent)).toEqual(['A']);
    r.reply(id, generation, {id:requests[0].id,payload:{content:[{type:'text',text:'A'}]}});
    expect((await first).content[0].text).toBe('A');
    r.release(id, a.lease);
    expect(r.status(id).activeCalls).toBe(0);
  });
  test('one agent snapshot cannot acknowledge another concurrent mutation', async () => {
    const r = new Sessions({draftRoot:path.join(dir,'drafts')}); const {sessionId:id}=await r.open(path.join(dir,'a.pen'),'s'); const requests=[];
    const {generation,fileURI}=r.attach(id,m=>requests.push(m)); await r.storage(id,generation,'storage-load');
    const a=r.acquire(id,'A'), b=r.acquire(id,'B');
    const first=r.call(id,a.lease,'execute',{input:'Insert A'}), second=r.call(id,b.lease,'execute',{input:'Insert B'});
    await r.storage(id,generation,'storage-write',{fileURI,content:'only-A'});
    r.reply(id,generation,{id:requests[0].id,payload:{}}); await first;
    r.reply(id,generation,{id:requests[1].id,payload:{}}); await second;
    expect(r.status(id).saveState).toBe('check-required');
    await expect(r.saveAs(id,b.lease,path.join(dir,'stale.pen'))).rejects.toMatchObject({code:'SAVE_NOT_READY'});
    await r.storage(id,generation,'storage-write',{fileURI,content:'both-A-and-B'});
    await r.saveAs(id,b.lease,path.join(dir,'fresh.pen'));
    expect(await fs.readFile(path.join(dir,'fresh.pen'),'utf8')).toBe('both-A-and-B');
  });
  test('an autosave received before a single mutation response does not acknowledge it', async () => {
    const r=new Sessions({draftRoot:path.join(dir,'drafts')});const {sessionId:id}=await r.open(path.join(dir,'a.pen'),'s');const messages=[];
    const {generation,fileURI}=r.attach(id,m=>messages.push(m));await r.storage(id,generation,'storage-load');const {lease}=r.acquire(id,'A');
    const edit=r.call(id,lease,'execute',{input:'Insert A'});
    await r.storage(id,generation,'storage-write',{fileURI,content:'snapshot-before-reply'});
    r.reply(id,generation,{id:messages[0].id,payload:{}});await edit;
    expect(r.status(id).saveState).toBe('check-required');
    await expect(r.saveAs(id,lease,path.join(dir,'stale.pen'))).rejects.toMatchObject({code:'SAVE_NOT_READY'});
    await r.storage(id,generation,'storage-write',{fileURI,content:'snapshot-after-reply'});
    expect(r.status(id).saveState).toBe('draft-saved');
  });
  test('a snapshot queued before a response stays unconfirmed when its disk write finishes later', async () => {
    const r=new Sessions({draftRoot:path.join(dir,'drafts')});const {sessionId:id}=await r.open(path.join(dir,'a.pen'),'s');const messages=[];
    const {generation,fileURI}=r.attach(id,m=>messages.push(m));await r.storage(id,generation,'storage-load');const {lease}=r.acquire(id,'A');
    const edit=r.call(id,lease,'execute',{input:'Insert A'});
    let finishWrite, entered;const writing=new Promise(resolve=>entered=resolve);const gate=new Promise(resolve=>finishWrite=resolve);const atomic=r.atomicWrite.bind(r);
    r.atomicWrite=async(...args)=>{entered();await gate;return atomic(...args)};
    const storage=r.storage(id,generation,'storage-write',{fileURI,content:'snapshot-before-reply'});await writing;
    r.reply(id,generation,{id:messages[0].id,payload:{}});await edit;finishWrite();await storage;
    expect(r.status(id).saveState).toBe('check-required');
  });
  test('calls wait through Save then dispatch concurrently, including schema discovery', async () => {
    const r=new Sessions({timeout:200,draftRoot:path.join(dir,'drafts')});const {sessionId:id}=await r.open(path.join(dir,'a.pen'),'s');const messages=[];
    const {generation}=r.attach(id,m=>messages.push(m));await r.storage(id,generation,'storage-load');const a=r.acquire(id,'A'),b=r.acquire(id,'B');
    const save=r.save(id,a.lease);
    const first=r.call(id,a.lease,'get_app_state'),second=r.call(id,b.lease,'get_app_state');const schema=r.request(id,'get-mcp-schema');
    expect(messages).toHaveLength(1);expect(messages[0].method).toBe('save');
    expect(()=>r.release(id,b.lease)).toThrow('cours');
    r.reply(id,generation,{id:messages[0].id,payload:1});await save;
    await new Promise(resolve=>setTimeout(resolve,0));expect(messages).toHaveLength(4);
    for(const m of messages.slice(1))r.reply(id,generation,{id:m.id,payload:m.id});
    const results=await Promise.all([first,second,schema]);expect(new Set(results).size).toBe(3);expect(r.status(id).activeCalls).toBe(0);
  });
  test('a failed Save rejects waiting calls without sending them to the editor', async () => {
    const r=new Sessions({timeout:100,draftRoot:path.join(dir,'drafts')});const {sessionId:id}=await r.open(path.join(dir,'a.pen'),'s');const messages=[];
    const {generation}=r.attach(id,m=>messages.push(m));await r.storage(id,generation,'storage-load');const a=r.acquire(id,'A'),b=r.acquire(id,'B');
    const save=r.save(id,a.lease);const waiting=r.call(id,b.lease,'execute',{input:'Insert B'});
    const checkedSave=save.catch(e=>e),checkedCall=waiting.catch(e=>e);
    r.reply(id,generation,{id:messages[0].id,error:{message:'flush failed'}});for(const error of await Promise.all([checkedSave,checkedCall]))expect(error.code).toBe('EDITOR_ERROR');
    expect(messages).toHaveLength(1);expect(r.status(id).activeCalls).toBe(0);expect(r.status(id).saving).toBe(false);
  });
  test('Save wait is bounded and a timed-out waiter never dispatches later', async () => {
    const r=new Sessions({timeout:200,saveWaitTimeout:10,draftRoot:path.join(dir,'drafts')});const {sessionId:id}=await r.open(path.join(dir,'a.pen'),'s');const messages=[];
    const {generation}=r.attach(id,m=>messages.push(m));await r.storage(id,generation,'storage-load');const a=r.acquire(id,'A'),b=r.acquire(id,'B');
    const save=r.save(id,a.lease);const waiting=r.call(id,b.lease,'execute',{input:'Insert B'});
    await expect(waiting).rejects.toMatchObject({code:'SAVE_WAIT_TIMEOUT'});
    expect(r.status(id).activeCalls).toBe(0);expect(r.status(id).blocked).toBe(false);
    r.reply(id,generation,{id:messages[0].id,payload:1});await save;
    expect(messages).toHaveLength(1);
  });
  test('Save engine timeout propagates to waiting calls and blocks subsequent writes', async () => {
    const r=new Sessions({timeout:15,saveWaitTimeout:100,draftRoot:path.join(dir,'drafts')});const {sessionId:id}=await r.open(path.join(dir,'a.pen'),'s');const messages=[];
    const {generation}=r.attach(id,m=>messages.push(m));await r.storage(id,generation,'storage-load');const a=r.acquire(id,'A'),b=r.acquire(id,'B');
    const save=r.save(id,a.lease).catch(e=>e);const waiting=r.call(id,b.lease,'execute',{input:'Insert B'}).catch(e=>e);
    for(const error of await Promise.all([save,waiting]))expect(error.code).toBe('OUTCOME_UNKNOWN');
    expect(r.status(id).blocked).toBe(true);expect(r.status(id).activeCalls).toBe(0);expect(messages).toHaveLength(1);
  });
  test('timeout blocks writes and lease release instead of retrying', async () => {
    const r = new Sessions({ timeout: 15, draftRoot: path.join(dir, 'drafts') }); const { sessionId: id } = await r.open(path.join(dir, 'a.pen'), 's');
    r.attach(id, () => {}); const { lease } = r.acquire(id, 'A');
    await expect(r.call(id, lease, 'execute', { input: 'Print(1)' })).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    expect(r.status(id).blocked).toBe(true); expect(() => r.release(id, lease)).toThrow('inconnue');
  });
});
describe('opaque storage', () => {
  test('saves without decoding the document and refuses changed disk contents', async () => {
    const r = new Sessions({draftRoot: path.join(dir, 'drafts')}); const file = path.join(dir, 'a.pen'); const { sessionId: id } = await r.open(file, 's'); const { generation, fileURI } = r.attach(id, () => {});
    expect((await r.storage(id, generation, 'storage-load')).content).toBe('opaque-original');
    expect(await r.storage(id, generation, 'storage-write', { fileURI, content: 'opaque-new' })).toBe(0);
    await fs.writeFile(file, 'human-edit');
    expect(await r.storage(id, generation, 'storage-write', { fileURI, content: 'stale' })).toBe(2);
    expect(await fs.readFile(file, 'utf8')).toBe('human-edit');
    expect(await fs.readFile(r.get(id).draft, 'utf8')).toBe('stale');
  });
  test('asset writes cannot replace another session document', async () => {
    const r = new Sessions({draftRoot: path.join(dir, 'drafts')}); const { sessionId: id } = await r.open(path.join(dir, 'a.pen'), 'a'); await r.open(path.join(dir, 'b.pen'), 'b'); const { generation } = r.attach(id, () => {});
    await expect(r.storage(id, generation, 'storage-write-asset', { path: `pencil/${id}/b.pen`, data: [65] })).rejects.toMatchObject({code:'ASSET_OUTSIDE_ROOT'});
    expect(await fs.readFile(path.join(dir,'b.pen'),'utf8')).toBe('opaque-b');
  });
  test('an external write during draft save is preserved', async () => {
    const r = new Sessions({draftRoot: path.join(dir, 'drafts')}); const file = path.join(dir,'a.pen'); const {sessionId:id} = await r.open(file,'s'); const {generation,fileURI} = r.attach(id,()=>{}); await r.storage(id,generation,'storage-load');
    const atomic = r.atomicWrite.bind(r); r.atomicWrite = async (target,bytes) => { await fs.writeFile(file,'external-after-check'); await atomic(target,bytes); };
    expect(await r.storage(id,generation,'storage-write',{fileURI,content:'draft'})).toBe(0); expect(await fs.readFile(file,'utf8')).toBe('external-after-check');
  });
  test('rejects stale channels, other URIs, traversal and symlink assets', async () => {
    const r = new Sessions({draftRoot: path.join(dir, 'drafts')}); const { sessionId: id } = await r.open(path.join(dir, 'a.pen'), 's'); const { generation } = r.attach(id, () => {});
    await expect(r.storage(id, generation + 1, 'storage-load')).rejects.toMatchObject({ code: 'STALE_CHANNEL' });
    await expect(r.storage(id, generation, 'storage-write', { fileURI: 'file:///other.pen', content: 'bad' })).rejects.toMatchObject({ code: 'WRONG_DOCUMENT' });
    await expect(r.storage(id, generation, 'storage-read-asset', { path: `pencil/${id}/../escape` })).rejects.toMatchObject({ code: 'ASSET_OUTSIDE_ROOT' });
    await fs.mkdir(path.join(dir, 'images')); await fs.symlink(os.tmpdir(), path.join(dir, 'images/link'));
    await expect(r.storage(id, generation, 'storage-read-asset', { path: `pencil/${id}/images/link/x` })).rejects.toMatchObject({ code: 'ASSET_SYMLINK' });
  });
});
