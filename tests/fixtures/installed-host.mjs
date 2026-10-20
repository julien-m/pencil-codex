// Validation host only. The system under test is the installed dist/ server.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
const [installedRoot, outputDirectory, label] = process.argv.slice(2);
await fs.mkdir(outputDirectory,{recursive:true});
const data=path.join(outputDirectory,'private');await fs.mkdir(data,{mode:0o700,recursive:true});
const client=new Client({name:'installed-validation-host',version:'1'});
await client.connect(new StdioClientTransport({command:process.execPath,args:[path.join(installedRoot,'dist/server.mjs')],env:{...process.env,PLUGIN_DATA:data}}));
const opened=await client.callTool({name:'pencil_new',arguments:{path:path.join(outputDirectory,'document.pen'),scope:label}});
if(opened.isError)throw Error(JSON.stringify(opened));
const sessionId=opened.structuredContent.sessionId, openedAt=Date.now();
const resource=await client.readResource({uri:'ui://pencil-panel/editor-v2.html'});
const events=[];
if (process.env.PENCIL_PROBE_EMPTY === '1') {
 void (async()=>{
  const participant=await client.callTool({name:'pencil_begin',arguments:{sessionId,agent:'empty-document-check'}});
  const lease=participant.structuredContent.lease;
  const state=await client.callTool({name:'pencil_call',arguments:{sessionId,lease,tool:'get_app_state',arguments:{}}},undefined,{timeout:60000});
  await fs.writeFile(path.join(outputDirectory,'empty-document-probe.json'),JSON.stringify(state,null,2));
  await client.callTool({name:'pencil_end',arguments:{sessionId,lease}});
 })().catch(error=>console.error('Empty document probe:',error.message));
}
const observer=`const Socket=window.WebSocket;window.WebSocket=class extends Socket{constructor(...args){super(...args);this.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.kind==='request')fetch('/events',{method:'POST',body:JSON.stringify({at:Date.now(),method:m.method,tool:m.payload?.name,path:m.payload?.arguments?.path})});});}};`;
const html=resource.contents[0].text.replace('<script>',`<script>${observer}window.pencilPanelPreview=${JSON.stringify(opened._meta.editor)};</script><script>`);
const server=http.createServer(async(req,res)=>{
 try{
  if(req.method==='GET'&&req.url==='/'){res.setHeader('Content-Type','text/html');return res.end(html)}
  if(req.method==='GET'&&req.url==='/state'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({sessionId,openedAt,installedRoot}))}
  let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>1024*1024)throw Error('Request too large')}
  if(req.url==='/events'){events.push(JSON.parse(raw));await fs.writeFile(path.join(outputDirectory,'channel-events.json'),JSON.stringify(events,null,2));return res.end('{}')}
  if(req.url==='/tool'){
   const call=JSON.parse(raw), startedAt=Date.now();const result=await client.callTool(call,undefined,{timeout:60000});
   const record={startedAt,completedAt:Date.now(),name:call.name,tool:call.arguments?.tool,sessionId,isError:result.isError??false};
   await fs.appendFile(path.join(outputDirectory,'mcp-calls.jsonl'),JSON.stringify(record)+'\n');res.setHeader('Content-Type','application/json');return res.end(JSON.stringify(result));
  }
  res.writeHead(404).end();
 }catch(error){res.writeHead(500).end(JSON.stringify({error:error.message}))}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const info={url:`http://127.0.0.1:${server.address().port}/`,sessionId,openedAt,installedRoot};await fs.writeFile(path.join(outputDirectory,'host.json'),JSON.stringify(info,null,2));console.log(JSON.stringify(info));
async function stop(){server.closeAllConnections();server.close();await client.close();try{const c=JSON.parse(await fs.readFile(path.join(data,'connection.json')));process.kill(c.pid,'SIGTERM')}catch{}process.exit(0)}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
