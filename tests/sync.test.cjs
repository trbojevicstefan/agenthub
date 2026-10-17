'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const {temp,secure}=require('./helpers.cjs');
const {Sync,mergeMessages,transcriptData}=require('../desktop/sync.cjs');
const {Store,Vault}=require('../desktop/store.cjs');
const {Broker}=require('../desktop/broker.cjs');
// The web server's sync (web/src/sync.ts) in memory: a change counter, the last version wins, tombstones.
function server(){
  let rev=0;const records=new Map(),secrets=new Map(),calls=[];
  return {records,secrets,calls,transport:{
    async pull(since){calls.push(['pull',since]);const list=[...records.values()].filter(r=>r.rev>since&&!(since===0&&r.deleted)).sort((a,b)=>a.rev-b.rev);return {records:list.map(r=>structuredClone(r)),rev:list.at(-1)?.rev??(since===0?rev:since),more:false,reset:false};},
    async push(list){calls.push(['push',list.length]);for(const r of list){rev++;records.set(`${r.kind}:${r.id}`,r.deleted?{kind:r.kind,id:r.id,rev,deleted:true}:{kind:r.kind,id:r.id,rev,deleted:false,data:structuredClone(r.data)});}return {rev};},
    async secret(key,value){calls.push(['secret',key]);if(value)secrets.set(key,value);else secrets.delete(key);return {ok:true};}
  }};
}
async function workspace(t){
  const root=await temp(t),broker=new Broker({store:new Store(root),vault:new Vault(root,secure()),emit:()=>{},approve:async()=>true});await broker.init();
  // The Opaya Agent's Vault entries, as far as sync uses them.
  const opaya={secrets:[],synced:new Map(),async syncedSecret(key,data){if(data)this.synced.set(key,data);else this.synced.delete(key);}};
  return {root,broker,opaya};
}
const KINDS=['host','agent','conversation','transcript','settings'];
const desktopSync=(w,transport)=>new Sync({root:w.root,broker:w.broker,opaya:w.opaya,vault:w.broker.vault,transport,sends:[...KINDS,'secret'],accepts:KINDS,account:'ana@example.com'});
const webSync=(w,transport)=>new Sync({root:w.root,broker:w.broker,opaya:w.opaya,vault:{refresh:async()=>{}},transport,sends:KINDS,accepts:[...KINDS,'secret'],account:'web',trustAgents:true});

test('machines, agents, chats and settings go both ways; agents on this computer and desktop keys do not',async t=>{
  const s=server(),desk=await workspace(t),web=await workspace(t);
  const a=desktopSync(desk,s.transport),b=webSync(web,s.transport);await a.load();await b.load();
  const host=await desk.broker.saveHost({name:'prod',hostname:'203.0.113.5',username:'root',port:22,identityFile:'/Users/ana/.ssh/id_ed25519'});
  await desk.broker.saveHost({name:'alias only',alias:'staging'});
  const agent=await desk.broker.saveAgent({agent:{name:'hermes',provider:'hermes',protocol:'acp',transport:'ssh',hostId:host.id,command:'hermes',args:['acp']}});
  await desk.broker.saveAgent({agent:{name:'local codex',provider:'codex',protocol:'codex',transport:'local',command:'codex',args:[]}});
  const chat=await desk.broker.createConversation(agent.id,{activate:false,title:'Deploy'});
  const messages=[{id:'m1',role:'user',content:'Deploy it',status:'done',createdAt:'2026-10-17T10:00:00Z'},{id:'m2',role:'assistant',content:'Done.',status:'done',createdAt:'2026-10-17T10:00:05Z',attachments:[{path:'/x'}]}];
  desk.broker.histories.set(chat.id,messages);await desk.broker.store.writeTranscript(chat.id,messages);
  await desk.broker.saveSettings({sendKey:'mod-enter',itrustAll:true});
  await a.round();
  assert.ok(!s.records.has(`host:${desk.broker.data.hosts[1].id}`),'an alias-only machine stays on the desktop');
  assert.equal(s.records.get(`host:${host.id}`).data.identityFile,undefined,'the desktop key path never syncs');
  assert.equal([...s.records.values()].filter(r=>r.kind==='agent').length,1,'only the SSH agent');
  assert.deepEqual(s.records.get(`transcript:${chat.id}`).data.messages.map(m=>m.id),['m1','m2']);
  assert.equal(s.records.get(`transcript:${chat.id}`).data.messages[1].attachments,undefined);
  assert.deepEqual(s.records.get('settings:settings').data.sendKey,'mod-enter');assert.equal(s.records.get('settings:settings').data.itrustAll,undefined,'iTrust stays on each computer');

  await b.round();
  assert.deepEqual(web.broker.data.hosts.map(h=>[h.id,h.name,h.identityFile]),[[host.id,'prod','']]);
  assert.deepEqual(web.broker.data.agents.map(x=>x.id),[agent.id]);
  assert.equal(web.broker.data.conversations[0].title,'Deploy');
  assert.deepEqual((await web.broker.store.transcript(chat.id)).map(m=>m.content),['Deploy it','Done.']);
  assert.equal(web.broker.data.settings.sendKey,'mod-enter');
  const pushes=s.calls.filter(c=>c[0]==='push').length;await b.round();assert.equal(s.calls.filter(c=>c[0]==='push').length,pushes,'nothing changed: nothing is pushed back');

  // A chat goes on in the web app: the desktop gets the new message and keeps its own.
  const webMessages=[...await web.broker.store.transcript(chat.id),{id:'m3',role:'user',content:'Status?',status:'done',createdAt:'2026-10-17T11:00:00Z'}];
  await web.broker.store.writeTranscript(chat.id,webMessages);web.broker.histories.set(chat.id,webMessages);
  await web.broker.renameConversation({id:chat.id,title:'Deploy and status'});
  await b.round();await a.round();
  assert.deepEqual(desk.broker.histories.get(chat.id).map(m=>m.id),['m1','m2','m3']);
  assert.equal(desk.broker.data.conversations.find(c=>c.id===chat.id).title,'Deploy and status');

  // Removing the agent on the desktop removes it, and its chats, in the web app.
  await desk.broker.removeAgent(agent.id);await a.round();await b.round();
  assert.deepEqual(web.broker.data.agents,[]);assert.deepEqual(web.broker.data.conversations,[]);
  assert.equal(s.records.get(`agent:${agent.id}`).deleted,true);
});

test('a Vault key marked Sync to web goes to the web app with its value; unmarked keys and removed marks do not stay',async t=>{
  const s=server(),desk=await workspace(t),web=await workspace(t);
  const a=desktopSync(desk,s.transport),b=webSync(web,s.transport);await a.load();await b.load();
  const key='opaya-secret-0f8fad5b-d9cb-469f-a165-70867728950e',other='opaya-secret-1f8fad5b-d9cb-469f-a165-70867728950e';
  await desk.broker.vault.set(key,JSON.stringify('sk-synced'),true);await desk.broker.vault.set(other,JSON.stringify('sk-local'),true);
  desk.opaya.secrets.push({id:'S1',key,name:'OPENAI_API_KEY',mask:'sk-…ced',kept:true,sync:true},{id:'S2',key:other,name:'LOCAL_ONLY',mask:'sk-…cal',kept:true});
  await a.round();
  assert.equal(s.secrets.get(key),JSON.stringify('sk-synced'));assert.equal(s.secrets.has(other),false);
  assert.deepEqual(Object.keys(s.records.get(`secret:${key}`).data).sort(),['endpoint','global','mask','name'],'no value in the record');
  await b.round();
  assert.equal(web.opaya.synced.get(key).name,'OPENAI_API_KEY');
  // The web app never sends keys back.
  web.opaya.secrets.push({id:'S9',key:other,name:'WEB_KEY',kept:true,sync:true});await b.round();assert.equal(s.records.has(`secret:${other}`),false);
  // Sync to web turned off: the value and the web copy go.
  desk.opaya.secrets[0].sync=false;await a.round();await b.round();
  assert.equal(s.secrets.has(key),false);assert.equal(web.opaya.synced.has(key),false);
});

test('a change to an agent in a turn waits for the next round',async t=>{
  const s=server(),desk=await workspace(t),web=await workspace(t);
  const a=desktopSync(desk,s.transport),b=webSync(web,s.transport);await a.load();await b.load();
  const host=await desk.broker.saveHost({name:'prod',hostname:'203.0.113.5',username:'root'});
  const agent=await desk.broker.saveAgent({agent:{name:'hermes',provider:'hermes',protocol:'acp',transport:'ssh',hostId:host.id,command:'hermes',args:['acp']}});
  await a.round();await b.round();
  await desk.broker.saveAgent({agent:{...desk.broker.agent(agent.id),name:'hermes-prod'}});await a.round();
  web.broker.turns.set(agent.id,{conversationId:'x'});await b.round();
  assert.equal(web.broker.agent(agent.id).name,'hermes','not while it answers');
  web.broker.turns.delete(agent.id);await b.round();
  assert.equal(web.broker.agent(agent.id).name,'hermes-prod');
});

test('transcripts merge by message and keep a message that is still being written',()=>{
  const merged=mergeMessages([{id:'a',content:'x',status:'done',createdAt:'1'},{id:'c',content:'part',status:'streaming',createdAt:'3'}],[{id:'b',content:'y',status:'done',createdAt:'2'},{id:'c',content:'whole',status:'done',createdAt:'3'}]);
  assert.deepEqual(merged.map(m=>[m.id,m.content]),[['a','x'],['b','y'],['c','part']]);
  const big=Array.from({length:3000},(_,i)=>({id:`m${i}`,role:'user',content:'x'.repeat(500),status:'done',createdAt:String(i).padStart(5,'0')}));
  const synced=transcriptData(big).messages;assert.ok(synced.length<3000&&synced.at(-1).id==='m2999','the newest messages, up to the limit');
});

test('an agent from the other app runs only after the user trusts it here; iTrust stays on each computer',async t=>{
  const s=server(),desk=await workspace(t),web=await workspace(t);
  const asked=[];let answer=false;desk.broker.approve=async(a,title)=>{asked.push(title);return answer;};
  const a=desktopSync(desk,s.transport),b=webSync(web,s.transport);await a.load();await b.load();
  const host=await web.broker.saveHost({name:'prod',hostname:'203.0.113.5',username:'root'});
  const agent=await web.broker.saveAgent({agent:{name:'from web',provider:'hermes',protocol:'acp',transport:'ssh',hostId:host.id,command:'hermes',args:['acp'],itrust:true}},{preapproved:true});
  await b.round();
  assert.equal(s.records.get(`agent:${agent.id}`).data.itrust,undefined,'iTrust is not synced');
  await a.round();
  const here=desk.broker.agent(agent.id);assert.equal(here.trustPending,true);assert.equal(here.itrust,false);assert.deepEqual(asked,[],'sync itself asks nothing');
  await assert.rejects(desk.broker.ensureTrusted(here),/not approved/);assert.equal(desk.broker.agent(agent.id).trustPending,true);
  answer=true;await desk.broker.ensureTrusted(desk.broker.agent(agent.id));assert.equal(desk.broker.agent(agent.id).trustPending,undefined);
  assert.equal(asked.length,2);
  // A new name keeps the trust; a new executable needs it again.
  await web.broker.saveAgent({agent:{...web.broker.agent(agent.id),name:'renamed'}},{preapproved:true});await b.round();await a.round();
  assert.equal(desk.broker.agent(agent.id).trustPending,undefined);assert.equal(desk.broker.agent(agent.id).name,'renamed');
  await web.broker.saveAgent({agent:{...web.broker.agent(agent.id),args:['acp','--profile','work']}},{preapproved:true});await b.round();await a.round();
  assert.equal(desk.broker.agent(agent.id).trustPending,true);
  assert.equal((await a.round()).pushed,0,'the local mark is not pushed back');
});

test('an item that stops syncing stays here and is not deleted on the other side',async t=>{
  const s=server(),desk=await workspace(t),web=await workspace(t);
  const a=desktopSync(desk,s.transport),b=webSync(web,s.transport);await a.load();await b.load();
  const host=await desk.broker.saveHost({name:'prod',hostname:'203.0.113.5',username:'root'});
  const agent=await desk.broker.saveAgent({agent:{name:'hermes',provider:'hermes',protocol:'acp',transport:'ssh',hostId:host.id,command:'hermes',args:['acp']}});
  const chat=await desk.broker.createConversation(agent.id,{activate:false,title:'Deploy'});
  await a.round();await b.round();
  // The machine now has only its OpenSSH alias here.
  await desk.broker.saveHost({...desk.broker.host(host.id),hostname:'',alias:'prod'});
  await a.round();await a.round();await b.round();
  assert.equal([...s.records.values()].filter(r=>r.deleted).length,0,'no deletes on the server');
  assert.deepEqual([desk.broker.data.agents.length,desk.broker.data.conversations.length],[1,1],'the desktop keeps them');
  assert.ok(desk.broker.data.conversations.some(c=>c.id===chat.id));
  assert.deepEqual([web.broker.data.agents.length,web.broker.data.conversations.length],[1,1],'the web app keeps its copy');
  // A change on the other side leaves the local-only item as it is.
  await web.broker.saveHost({...web.broker.host(host.id),name:'prod-web'});await b.round();await a.round();
  assert.equal(desk.broker.host(host.id).name,'prod');assert.equal(desk.broker.host(host.id).alias,'prod');
});

test('a record that cannot be applied does not stop the records after it, and the status shows it',async t=>{
  const s=server(),desk=await workspace(t);
  const a=desktopSync(desk,s.transport);await a.load();
  const agentId='1f8fad5b-d9cb-469f-a165-70867728950e',chatId='2f8fad5b-d9cb-469f-a165-70867728950e',hostId='3f8fad5b-d9cb-469f-a165-70867728950e';
  // A newer app's agent (an unknown provider), its chat and a local agent; then a machine.
  await s.transport.push([{kind:'agent',id:agentId,data:{id:agentId,name:'future',provider:'future',protocol:'acp',transport:'http',endpoint:'https://api.example.com',command:'',args:[]}},{kind:'conversation',id:chatId,data:{agentId,title:'Old chat',createdAt:'2026-10-17T10:00:00Z'}}]);
  await s.transport.push([{kind:'agent',id:'4f8fad5b-d9cb-469f-a165-70867728950e',data:{name:'here',provider:'codex',protocol:'codex',transport:'local',command:'codex',args:[]}}]);
  await s.transport.push([{kind:'host',id:hostId,data:{name:'later',hostname:'203.0.113.9',username:'root',port:22}}]);
  const result=await a.round();
  assert.deepEqual(desk.broker.data.hosts.map(h=>h.name),['later'],'the machine after them arrives');
  assert.deepEqual(desk.broker.data.agents,[],'not the unknown agent, not an agent on this computer');
  assert.equal(result.failed,3);assert.match(a.describe().error,/^3 synced items could not be applied here/);
  assert.equal(result.pushed,1,'only the machine it applied');assert.equal([...s.records.values()].filter(r=>r.deleted).length,0);
});

test('records come in any order: a machine, agent or chat changed after its children still applies',async t=>{
  const s=server(),desk=await workspace(t),web=await workspace(t);
  const a=desktopSync(desk,s.transport),b=webSync(web,s.transport);await a.load();await b.load();
  const host=await desk.broker.saveHost({name:'prod',hostname:'203.0.113.5',username:'root'});
  const agent=await desk.broker.saveAgent({agent:{name:'hermes',provider:'hermes',protocol:'acp',transport:'ssh',hostId:host.id,command:'hermes',args:['acp']}});
  const chat=await desk.broker.createConversation(agent.id,{activate:false,title:'Deploy'});
  await a.round();
  // The parents change after the chat: on the server they come after it.
  await desk.broker.saveAgent({agent:{...desk.broker.agent(agent.id),name:'hermes-2'}});await desk.broker.saveHost({...desk.broker.host(host.id),name:'prod-2'});await a.round();
  const result=await b.round();
  assert.equal(result.failed,0);
  assert.deepEqual([web.broker.data.hosts[0].name,web.broker.data.agents[0].name,web.broker.data.conversations[0].id],['prod-2','hermes-2',chat.id]);
});

test('a synced change keeps the open agent and chat, and a new name does not disconnect',async t=>{
  const s=server(),desk=await workspace(t),web=await workspace(t);
  const a=desktopSync(desk,s.transport),b=webSync(web,s.transport);await a.load();await b.load();
  const host=await desk.broker.saveHost({name:'prod',hostname:'203.0.113.5',username:'root'});
  const one=await desk.broker.saveAgent({agent:{name:'one',provider:'hermes',protocol:'acp',transport:'ssh',hostId:host.id,command:'hermes',args:['acp']}});
  const chat=await desk.broker.createConversation(one.id,{title:'Open'});
  await a.round();await b.round();
  const disconnected=[],original=desk.broker.disconnect.bind(desk.broker);desk.broker.disconnect=id=>{disconnected.push(id);return original(id);};
  await web.broker.saveAgent({agent:{name:'two',provider:'hermes',protocol:'acp',transport:'ssh',hostId:host.id,command:'hermes',args:['acp','--profile','b']}},{preapproved:true});
  await web.broker.saveAgent({agent:{...web.broker.agent(one.id),name:'one renamed'}},{preapproved:true});
  await web.broker.saveHost({...web.broker.host(host.id),name:'prod renamed'});
  // A turn on the machine: the new names apply.
  desk.broker.turns.set(one.id,{conversationId:chat.id});
  await b.round();await a.round();
  assert.deepEqual([desk.broker.data.activeAgentId,desk.broker.data.activeConversationId],[one.id,chat.id]);
  assert.deepEqual(disconnected,[]);
  assert.equal(desk.broker.host(host.id).name,'prod renamed');
  // A new address waits for the turn.
  await web.broker.saveHost({...web.broker.host(host.id),hostname:'203.0.113.6'});await b.round();await a.round();
  assert.equal(desk.broker.host(host.id).hostname,'203.0.113.5');
  desk.broker.turns.delete(one.id);await a.round();
  assert.equal(desk.broker.host(host.id).hostname,'203.0.113.6');
  assert.equal(desk.broker.agent(one.id).name,'one renamed');
});

test('at the chat limit a new chat is not taken and not deleted on the other side; a moved agent needs trust again',async t=>{
  const s=server(),desk=await workspace(t),web=await workspace(t);
  const a=desktopSync(desk,s.transport),b=webSync(web,s.transport);await a.load();await b.load();
  const host=await web.broker.saveHost({name:'prod',hostname:'203.0.113.5',username:'root'}),other=await web.broker.saveHost({name:'other',hostname:'203.0.113.7',username:'root'});
  const agent=await web.broker.saveAgent({agent:{name:'hermes',provider:'hermes',protocol:'acp',transport:'ssh',hostId:host.id,command:'hermes',args:['acp']}},{preapproved:true});
  await b.round();await a.round();await desk.broker.ensureTrusted(desk.broker.agent(agent.id));
  for(let i=0;i<2000;i++)desk.broker.data.conversations.push({id:`c${i}`,agentId:'none',title:'x',createdAt:''});
  const chat=await web.broker.createConversation(agent.id,{activate:false,title:'New'});await b.round();
  const result=await a.round();
  assert.equal(desk.broker.data.conversations.some(c=>c.id===chat.id),false);assert.ok(result.failed>=1);
  await b.round();assert.equal(s.records.get(`conversation:${chat.id}`).deleted,false,'the web app keeps it');
  // The same executable on another machine.
  await web.broker.saveAgent({agent:{...web.broker.agent(agent.id),hostId:other.id}},{preapproved:true});await b.round();await a.round();
  assert.equal(desk.broker.agent(agent.id).trustPending,true);
});

test('a push is split by size',async t=>{
  const s=server(),desk=await workspace(t);
  const sizes=[],push=s.transport.push;s.transport.push=async list=>{sizes.push(Buffer.byteLength(JSON.stringify(list)));return push(list);};
  const a=desktopSync(desk,s.transport);await a.load();
  const host=await desk.broker.saveHost({name:'prod',hostname:'203.0.113.5',username:'root'});
  const agent=await desk.broker.saveAgent({agent:{name:'hermes',provider:'hermes',protocol:'acp',transport:'ssh',hostId:host.id,command:'hermes',args:['acp']}});
  for(let i=0;i<20;i++){const c=await desk.broker.createConversation(agent.id,{activate:false,title:`c${i}`});const m=[{id:`m${i}`,role:'user',content:'x'.repeat(900*1024),status:'done',createdAt:'1'}];desk.broker.histories.set(c.id,m);await desk.broker.store.writeTranscript(c.id,m);}
  await a.round();
  assert.ok(sizes.length>=3,`pushes: ${sizes.length}`);assert.ok(sizes.every(n=>n<9*1024*1024));
  assert.equal([...s.records.values()].filter(r=>r.kind==='transcript').length,20);
});
