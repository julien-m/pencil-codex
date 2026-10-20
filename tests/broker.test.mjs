import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { startBroker } from '../src/broker.mjs';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
test('real loopback transport authenticates and routes one editor without broadcasting to another', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pencil-ws-')); const b = await startBroker({ timeout: 1000 }); const peers = [];
  try {
    const rpc = async (method, args) => (await (await fetch(`http://127.0.0.1:${b.port}/rpc`, { method: 'POST', headers: { Authorization: `Bearer ${b.token}` }, body: JSON.stringify({ method, args }) })).json()).result;
    assert.equal((await fetch(`http://127.0.0.1:${b.port}/rpc`, { method: 'POST' })).status, 401);
    const sessions = [];
    for (const name of ['a', 'b']) {
      const file = path.join(dir, `${name}.pen`); await fs.writeFile(file, name); const s = await rpc('open', { path: file, scope: name }); sessions.push(s);
      const peer = new WebSocket(`ws://127.0.0.1:${b.port}/editor?session=${s.sessionId}&token=${s.editorToken}`); peers.push(peer); peer.once('open',()=>peer.send(JSON.stringify({kind:'ready'})));
      await new Promise((resolve, reject) => { peer.once('message', resolve); peer.once('error', reject); });
      peer.on('message', bytes => { const m = JSON.parse(bytes); if (m.kind === 'request') peer.send(JSON.stringify({ kind: 'response', id: m.id, payload: { content: [{ type: 'text', text: name }] } })); });
    }
    const leases = await Promise.all(sessions.map((s, i) => rpc('acquire', { sessionId: s.sessionId, agent: `agent-${i}` })));
    const results = await Promise.all(sessions.map((s, i) => rpc('call', { sessionId: s.sessionId, lease: leases[i].lease, tool: 'get_app_state', arguments: {} })));
    assert.deepEqual(results.map(x => x.content[0].text), ['a', 'b']);
  } finally { for (const p of peers) p.terminate(); await b.close(); await fs.rm(dir, { recursive: true, force: true }); }
});
test('the editor Save button flushes over WebSocket and publishes the opened file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pencil-save-ui-'));
  const b = await startBroker({ timeout: 500, draftRoot: path.join(dir, 'drafts') }); let peer;
  try {
    const file = path.join(dir, 'design.pen'); await fs.writeFile(file, 'before');
    const response = await fetch(`http://127.0.0.1:${b.port}/rpc`, { method: 'POST', headers: { Authorization: `Bearer ${b.token}` }, body: JSON.stringify({ method: 'open', args: { path: file, scope: 'ui-save' } }) });
    const { result: session } = await response.json();
    b.sessions.acquire(session.sessionId, 'Idle collaborator');
    peer = new WebSocket(`ws://127.0.0.1:${b.port}/editor?session=${session.sessionId}&token=${session.editorToken}`);
    peer.once('open',()=>peer.send(JSON.stringify({kind:'ready'})));
    let saveRequest, schemaResult; let sawSchema = false;
    const saved = new Promise((resolve, reject) => {
      peer.on('error', reject);
      peer.on('message', raw => {
        const m = JSON.parse(raw);
        if (m.kind === 'config') peer.send(JSON.stringify({ kind: 'storage', id: 'load', method: 'storage-load' }));
        if (m.kind === 'storage-response' && m.id === 'load') peer.send(JSON.stringify({ kind: 'save' }));
        if (m.kind === 'request' && m.method === 'save') {
          saveRequest = m.id;
          peer.send(JSON.stringify({ kind: 'storage', id: 'flush', method: 'storage-write', payload: { fileURI: `file:///pencil/${session.sessionId}/design.pen`, content: 'after' } }));
        }
        if (m.kind === 'request' && m.method === 'get-mcp-schema') {
          sawSchema = true;
          assert.equal(b.sessions.status(session.sessionId).saving,false);
          peer.send(JSON.stringify({kind:'response',id:m.id,payload:{tools:[]}}));
        }
        if (m.kind === 'storage-response' && m.id === 'flush') {
          void (async () => {
            schemaResult = fetch(`http://127.0.0.1:${b.port}/rpc`, { method: 'POST', headers: { Authorization: `Bearer ${b.token}` }, body: JSON.stringify({ method: 'schema', args: { sessionId: session.sessionId } }) }).then(r=>r.json());
            peer.send(JSON.stringify({ kind: 'response', id: saveRequest, payload: m.payload }));
          })();
        }
        if (m.kind === 'save-result') resolve(m);
      });
    });
    const result = await saved;
    assert(!result.error, JSON.stringify(result));
    assert.equal(await fs.readFile(file, 'utf8'), 'after');
    assert.equal(await fs.readFile(result.result.backupPath, 'utf8'), 'before');
    assert.deepEqual((await schemaResult).result,{tools:[]});
    assert.equal(sawSchema,true);
    assert.deepEqual(b.sessions.status(session.sessionId).agents,[{agent:'Idle collaborator',activeCalls:0}]);
  } finally { peer?.terminate(); await b.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('one editor receives concurrent calls from two agents and routes out-of-order responses', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pencil-shared-ws-'));
  const b = await startBroker({timeout:500}); let peer;
  try {
    const rpc = async (method,args) => {
      const body = await (await fetch(`http://127.0.0.1:${b.port}/rpc`, {method:'POST',headers:{Authorization:`Bearer ${b.token}`},body:JSON.stringify({method,args})})).json();
      if(body.error) throw Object.assign(new Error(body.error.message),body.error);
      return body.result;
    };
    const file=path.join(dir,'shared.pen'); await fs.writeFile(file,'opaque');
    const session=await rpc('open',{path:file,scope:'shared'});
    await assert.rejects(rpc('open',{path:file,scope:'other'}),{code:'DOCUMENT_BUSY'});
    const requests=[], activity=[];
    peer=new WebSocket(`ws://127.0.0.1:${b.port}/editor?session=${session.sessionId}&token=${session.editorToken}`);
    peer.once('open',()=>peer.send(JSON.stringify({kind:'ready'})));
    await new Promise((resolve,reject)=>{peer.once('message',resolve);peer.once('error',reject)});
    peer.on('message',raw=>{
      const m=JSON.parse(raw);
      if(m.kind==='activity') activity.push(m.status);
      if(m.kind!=='request')return;
      requests.push(m);
      // Reply only after BOTH requests arrive. A serial broker would time out.
      if(requests.length===2) for(const request of [...requests].reverse()) peer.send(JSON.stringify({kind:'response',id:request.id,payload:request.payload.arguments}));
    });
    const [a,c]=await Promise.all(['A','B'].map(agent=>rpc('acquire',{sessionId:session.sessionId,agent})));
    const results=await Promise.all([a,c].map((participant,i)=>rpc('call',{sessionId:session.sessionId,lease:participant.lease,tool:'execute',arguments:{input:`Print(${i})`,marker:i}})));
    assert.deepEqual(results.map(r=>r.marker),[0,1]);
    assert(activity.some(s=>s.agents.length===2 && s.activeCalls===2));
    await Promise.all([a,c].map(p=>rpc('release',{sessionId:session.sessionId,lease:p.lease})));
    assert.deepEqual(b.sessions.status(session.sessionId).agents,[]);
  } finally {peer?.terminate();await b.close();await fs.rm(dir,{recursive:true,force:true})}
});

test('storage messages retain their arrival revision across the broker persistence queue', async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pencil-snapshot-order-'));
  const b=await startBroker({timeout:500,draftRoot:path.join(dir,'drafts')});let peer,finishWrite;
  try{
    const file=path.join(dir,'design.pen');await fs.writeFile(file,'before');
    const session=await b.sessions.open(file,'s');
    // Allocate a normal editor grant over authenticated RPC.
    const opened=await (await fetch(`http://127.0.0.1:${b.port}/rpc`,{method:'POST',headers:{Authorization:`Bearer ${b.token}`},body:JSON.stringify({method:'open',args:{path:file,scope:'s'}})})).json();
    peer=new WebSocket(`ws://127.0.0.1:${b.port}/editor?session=${session.sessionId}&token=${opened.result.editorToken}`);
    peer.once('open',()=>peer.send(JSON.stringify({kind:'ready'})));
    let generation;await new Promise((resolve,reject)=>{peer.once('error',reject);peer.once('message',raw=>{generation=JSON.parse(raw).generation;resolve()})});
    await b.sessions.storage(session.sessionId,generation,'storage-load');
    let entered;const writing=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>finishWrite=resolve);
    const atomic=b.sessions.atomicWrite.bind(b.sessions);b.sessions.atomicWrite=async(...args)=>{entered();await gate;return atomic(...args)};
    let replies=0,resolveStored;const stored=new Promise(resolve=>resolveStored=resolve);
    peer.on('message',raw=>{
      const m=JSON.parse(raw);
      if(m.kind==='request'){
        for(const id of ['early-a','early-b'])peer.send(JSON.stringify({kind:'storage',id,method:'storage-write',payload:{fileURI:`file:///pencil/${session.sessionId}/design.pen`,content:id}}));
        peer.send(JSON.stringify({kind:'response',id:m.id,payload:{}}));
      }
      if(m.kind==='storage-response'&&++replies===2)resolveStored();
    });
    const{lease}=b.sessions.acquire(session.sessionId,'A');
    const edit=b.sessions.call(session.sessionId,lease,'execute',{input:'Insert A'});
    await writing;await edit;finishWrite();await stored;
    assert.equal(b.sessions.status(session.sessionId).saveState,'check-required');
    assert.equal(await fs.readFile(b.sessions.get(session.sessionId).draft,'utf8'),'early-b');
  }finally{finishWrite?.();peer?.terminate();await b.close();await fs.rm(dir,{recursive:true,force:true})}
});
