import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startBroker } from '../src/broker.mjs';
import { connectBroker } from '../src/client.mjs';
test('client uses the service-advertised deadline rather than its own environment',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'pencil-advertised-'));
 const broker=await startBroker({editorWaitTimeout:123});const old=process.env.PENCIL_EDITOR_WAIT_MS;
 try{
  await fs.writeFile(path.join(directory,'connection.json'),JSON.stringify({port:broker.port,token:broker.token}));
  process.env.PENCIL_EDITOR_WAIT_MS='0.5';
  const client=await connectBroker(directory),announcement=await client.rpc('ping');
  assert.equal(client.editorWaitTimeout,announcement.editorWaitTimeout);assert.equal(client.editorWaitTimeout,123);
  assert.equal(client.rpcTimeoutMs,announcement.rpcTimeoutMs);assert(client.rpcTimeoutMs>client.editorWaitTimeout);
 }finally{if(old===undefined)delete process.env.PENCIL_EDITOR_WAIT_MS;else process.env.PENCIL_EDITOR_WAIT_MS=old;await broker.close();await fs.rm(directory,{recursive:true,force:true})}
});
