import { test, expect } from 'bun:test';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Sessions } from '../src/sessions.mjs';

const counts = [...new Set([6, Number(process.env.PENCIL_TEST_AGENTS ?? 9)])];
for (const count of counts) test(`${count} agents coalesce metadata, clone cached values and invalidate on reconnect`, async () => {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'pencil-cache-'));
  try {
    const file=path.join(directory,'document.pen');await fs.writeFile(file,'opaque');
    const sessions=new Sessions({editorWaitTimeout:100});const{sessionId}=await sessions.open(file,'scope');
    let generation;const messages=[];
    const attach=()=>{({generation}=sessions.attach(sessionId,m=>{messages.push(m);queueMicrotask(()=>sessions.reply(sessionId,generation,{id:m.id,payload:{content:[{type:'text',text:'instructions'}]}}))}));};attach();
    const agents=await Promise.all(Array.from({length:count},(_,i)=>sessions.begin(sessionId,`agent-${i}`)));
    const results=await Promise.all(agents.map(a=>sessions.call(sessionId,a.lease,'read_skill',{path:'execute.md'})));
    expect(messages).toHaveLength(1);results[0].content[0].text='changed';
    expect((await sessions.call(sessionId,agents.at(-1).lease,'read_skill',{path:'execute.md'})).content[0].text).toBe('instructions');
    await Promise.all(agents.map(()=>sessions.schema(sessionId)));expect(messages).toHaveLength(2);
    await sessions.call(sessionId,agents[0].lease,'read_skill',{});expect(messages).toHaveLength(3);
    sessions.detach(sessionId,generation);attach();
    await Promise.all(agents.map(a=>sessions.call(sessionId,a.lease,'read_skill',{path:'execute.md'})));await sessions.schema(sessionId);expect(messages).toHaveLength(5);
  }finally{await fs.rm(directory,{recursive:true,force:true})}
});
test('begin responds immediately while only calls wait for readiness or timeout', async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'pencil-wait-'));
 try{
  const file=path.join(directory,'document.pen');await fs.writeFile(file,'opaque');const sessions=new Sessions({editorWaitTimeout:30});const{sessionId}=await sessions.open(file,'scope');
  const early=sessions.acquire(sessionId,'early');const messages=[];const call=sessions.call(sessionId,early.lease,'get_app_state');const begin=sessions.begin(sessionId,'new');expect(begin.lease).toBeString();
  const{generation}=sessions.attach(sessionId,m=>messages.push(m),{ready:false});await new Promise(r=>setTimeout(r,5));expect(messages).toHaveLength(0);
  sessions.ready(sessionId,generation);await begin;await new Promise(r=>setTimeout(r,0));expect(messages).toHaveLength(1);sessions.reply(sessionId,generation,{id:messages[0].id,payload:{}});await call;
  sessions.detach(sessionId,generation);
  expect(sessions.begin(sessionId,'late').lease).toBeString();
  await expect(sessions.call(sessionId,early.lease,'get_app_state')).rejects.toMatchObject({code:'EDITOR_OFFLINE'});
  expect(messages).toHaveLength(1);expect(sessions.status(sessionId).blocked).toBe(false);expect(sessions.status(sessionId).activeCalls).toBe(0);
 }finally{await fs.rm(directory,{recursive:true,force:true})}
});
test('repeated ready-detach races cannot reset the connection deadline',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pencil-deadline-'));
 try{
  const file=path.join(dir,'document.pen');await fs.writeFile(file,'opaque');const s=new Sessions({editorWaitTimeout:20});const{sessionId:id}=await s.open(file,'s');const{lease}=s.acquire(id,'agent');const sent=[];
  const result=s.call(id,lease,'execute',{input:'Print(1)'}).catch(e=>e);
  for(const delay of [5,5,5]){await new Promise(r=>setTimeout(r,delay));const{generation}=s.attach(id,m=>sent.push(m),{ready:false});s.ready(id,generation);s.detach(id,generation)}
  expect((await result).code).toBe('EDITOR_OFFLINE');expect(sent).toHaveLength(0);
 }finally{await fs.rm(dir,{recursive:true,force:true})}
});
test('editor wait configuration rejects fractional or unsupported timer values',async()=>{
 const {editorWaitTimeout}=await import('../src/config.mjs');const original=process.env.PENCIL_EDITOR_WAIT_MS;
 try{
  for(const value of ['0.5','-1','Infinity','2147483647']){process.env.PENCIL_EDITOR_WAIT_MS=value;expect(()=>editorWaitTimeout()).toThrow('supported timer range')}
  for(const value of ['0','20000']){process.env.PENCIL_EDITOR_WAIT_MS=value;expect(editorWaitTimeout()).toBe(Number(value))}
 }finally{if(original===undefined)delete process.env.PENCIL_EDITOR_WAIT_MS;else process.env.PENCIL_EDITOR_WAIT_MS=original}
});
