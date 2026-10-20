import * as fs from 'node:fs/promises';
import path from 'node:path';
export async function runInstalledAgent({hostFile,agent,input}){
 const host=JSON.parse(await fs.readFile(hostFile));const sessionId=host.sessionId;
 const tool=async(name,args)=>{
  const result=await(await fetch(host.url+'tool',{method:'POST',body:JSON.stringify({name,arguments:{sessionId,...args}}),signal:AbortSignal.timeout(60000)})).json();
  if(result.isError||result.error)throw Error(result.error??result.content?.filter(c=>c.type==='text').map(c=>c.text).join('\n'));
  return result;
 };
 const began=await tool('pencil_begin',{agent}),lease=began.structuredContent.lease;
 try{
  const started=Date.now();
  for(;;){try{await tool('pencil_tools',{});await tool('pencil_call',{lease,tool:'read_skill',arguments:{path:'execute.md'}});break}catch(e){if(!/EDITOR_OFFLINE|Moteur Pencil non connecté/.test(e.message)||Date.now()-started>20000)throw e;await new Promise(r=>setTimeout(r,250))}}
  const result=await tool('pencil_call',{lease,tool:'execute',arguments:{filePath:'',description:`Create frame for ${agent}`,input}});
  const completedAt=Date.now(),status=await tool('pencil_status',{});
  const receipt={agent,sessionId,openedAt:host.openedAt,firstModificationCompletedAt:completedAt,openToModificationMs:completedAt-host.openedAt,status:status.structuredContent,result};
  await fs.writeFile(path.join(path.dirname(hostFile),agent+'-receipt.json'),JSON.stringify(receipt,null,2));return receipt;
 }finally{await tool('pencil_end',{lease})}
}
