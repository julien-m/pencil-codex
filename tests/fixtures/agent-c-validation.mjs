import {runInstalledAgent} from './installed-agent.mjs';

const input=String.raw`
function frame(parent,name,props={}){return Insert(parent,{type:'frame',name,layout:'vertical',gap:16,alignItems:'start',width:'fill_container',height:'fit_content',...props})}
function text(parent,name,content,size=14,color='#30483D',props={}){return Insert(parent,{type:'text',name,content,fontFamily:'Inter',fontSize:size,fill:color,textGrowth:'auto',...props})}
let screen=frame(document,'Agent C — Activity dashboard',{x:2200,y:1100,width:900,height:650,padding:32,gap:24,fill:'#F5F7F0',clip:true});
let header=frame(screen,'Activity header',{gap:8});text(header,'Page title','Your workspace, in motion',30,'#243E31',{fontWeight:'600'});text(header,'Page subtitle','A clear view of this week’s progress and recent updates.',14,'#7D8F73');
let metrics=frame(screen,'Weekly metrics',{layout:'horizontal',gap:16,alignItems:'center'});
for(let [value,label]of[['18','Tasks completed'],['06','Projects active'],['92%','Weekly goal']]){let card=frame(metrics,label+' card',{padding:24,gap:8,fill:'#E4ECD9',cornerRadius:16});text(card,label+' value',value,28,'#527044',{fontWeight:'600'});text(card,label+' label',label,13,'#7A8D70')}
let activity=frame(screen,'Recent activity section',{padding:24,gap:16,fill:'#FFFFFF',cornerRadius:16});text(activity,'Recent activity title','Recent activity',20,'#30483D',{fontWeight:'600'});
for(let [title,detail,time]of[['Design system updated','Maya added 12 new components','12 min ago'],['Website launch approved','The team completed the final review','48 min ago'],['Research notes shared','Jordan published customer interview insights','2 hours ago']]){let row=frame(activity,title+' row',{layout:'horizontal',gap:16,alignItems:'center'});let mark=frame(row,title+' marker',{width:12,height:12,gap:8,fill:'#A6B68C',cornerRadius:6});let copy=frame(row,title+' copy',{gap:8});text(copy,title+' title',title,14,'#30483D',{fontWeight:'600'});text(copy,title+' detail',detail,12,'#849477');text(row,title+' timestamp',time,12,'#97A189')}
let footer=frame(screen,'Dashboard footer',{layout:'horizontal',gap:16,alignItems:'center'});text(footer,'Sync status','All changes saved',12,'#819271');text(footer,'Week label','October 19–25',12,'#9AA58E');Print('FRAME:'+screen);
`;

const receipt=await runInstalledAgent({hostFile:process.argv[2],agent:'agent-c',input});
console.log(JSON.stringify({agent:receipt.agent,sessionId:receipt.sessionId,openToModificationMs:receipt.openToModificationMs,result:receipt.result.content?.filter(c=>c.type==='text').map(c=>c.text).join('\n').slice(0,500)}));
