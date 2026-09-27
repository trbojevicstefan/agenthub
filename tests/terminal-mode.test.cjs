'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const {temp,secure}=require('./helpers.cjs');
const {Broker,CLIENT_REFUSED}=require('../desktop/broker.cjs');const {Store,Vault}=require('../desktop/store.cjs');const {Terminals}=require('../desktop/terminal.cjs');const schema=require('../desktop/schema.cjs');
async function fixture(t,reply){
  const root=await temp(t);
  const factory=()=>({connect:async()=>({description:'ok'}),close(){},run:async ctx=>{ctx.onEvent({type:'text',text:reply});return {};}});
  const b=new Broker({store:new Store(root),vault:new Vault(root,secure()),emit:()=>{},approve:async()=>true,adapterFactory:factory});await b.init();t.after(()=>b.close());return {b,root};
}
const acpAgent={name:'OpenCode',provider:'custom',protocol:'acp',transport:'local',command:'opencode',args:['acp']};
const settle=async b=>{for(let i=0;i<50&&b.turns.size;i++)await new Promise(r=>setTimeout(r,10));};
test('an agent whose vendor refuses other apps switches to its terminal, once, and says so',async t=>{
  const {b}=await fixture(t,'This client is no longer supported. Please use the official app.');
  const a=await b.saveAgent({agent:acpAgent});const told=[];b.onClientRefused=(agent,text)=>told.push([agent.id,text]);
  await b.connect(a.id);await b.send({agentId:a.id,text:'hi'});await settle(b);
  assert.equal(b.agent(a.id).surface,'terminal');assert.equal(told.length,1);assert.match(told[0][1],/no longer supported/);
  // Reloaded from disk, the choice stays.
  const again=new Broker({store:b.store,vault:b.vault,emit:()=>{},approve:async()=>true});await again.init();assert.equal(again.agent(a.id).surface,'terminal');
});
test('normal answers do not switch anything',async t=>{
  const {b}=await fixture(t,'Here is the version history of the client library.');
  const a=await b.saveAgent({agent:acpAgent});await b.connect(a.id);await b.send({agentId:a.id,text:'hi'});await settle(b);
  assert.equal(b.agent(a.id).surface,'');
  assert(CLIENT_REFUSED.test('This client is no longer supported'));
  assert(!CLIENT_REFUSED.test('The client supports streaming.'));
});
test('chat or terminal per agent and in Settings',async t=>{
  const {b}=await fixture(t,'');
  assert.equal(b.data.settings.interface,'','not chosen until the first launch asks');
  await b.saveSettings({interface:'terminal'});assert.equal(b.data.settings.interface,'terminal');
  await assert.rejects(()=>b.saveSettings({interface:'desktop'}),/chat or terminal/);
  const a=await b.saveAgent({agent:acpAgent});
  await b.updateAgentDisplay({id:a.id,surface:'chat'});assert.equal(b.agent(a.id).surface,'chat');
  await b.updateAgentDisplay({id:a.id,surface:'bogus'});assert.equal(b.agent(a.id).surface,'');
  assert.equal(schema.agent({...acpAgent,surface:'terminal'}).surface,'terminal');assert.equal(schema.agent({...acpAgent,surface:'x'}).surface,'');
});
test('split terminals are remembered with the view',async t=>{
  const {b}=await fixture(t,'');
  await b.saveView({panes:['t1','t2','bad id!'],paneSizes:[1.5,0.5,'x'],terminalId:'t2'});
  assert.deepEqual(b.data.view.panes,['t1','t2']);assert.deepEqual(b.data.view.paneSizes,[1.5,0.5]);
});
test('the native CLI is the agent command without its chat-server arguments',()=>{
  const t=Object.create(Terminals.prototype);
  assert.deepEqual(t.cliArgs({provider:'custom',protocol:'acp',command:'goose',args:['--acp']}),[]);
  assert.deepEqual(t.cliArgs({provider:'custom',protocol:'acp',command:'opencode',args:['acp']}),[]);
  assert.deepEqual(t.cliArgs({provider:'custom',protocol:'acp',command:'opencode',args:['acp','--yolo']}),['--yolo']);
  assert.deepEqual(t.cliArgs({provider:'custom',protocol:'acp',command:'docker',args:['exec','-i','-w','/root','opaya-o','opencode','acp']}),['exec','-it','-w','/root','-e','TERM=xterm-256color','opaya-o','opencode']);
  assert.deepEqual(t.cliArgs({provider:'custom',protocol:'terminal',command:'aider',args:['--model','x']}),['--model','x'],'terminal agents keep their arguments');
});
test('terminal input reaches the service in pieces it accepts, and an ended session says how to get a prompt back',()=>{
  // terminal-core.js is browser code; its helpers need no DOM.
  const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');const box={navigator:{platform:'Linux x86_64'}};box.window=box;vm.createContext(box);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../ui/terminal-core.js'),'utf8'),box);const {chunks,endedNote}=box.OpayaTerminal;
  const paste='a'.repeat(16383)+'\u{1F600}'+'b'.repeat(200000),parts=chunks(paste);
  assert.equal(parts.join(''),paste);assert(parts.every(p=>p.length<=65536),'the service refuses writes over 65536 characters');assert(!parts.some(p=>/[\ud800-\udbff]$/.test(p)),'an emoji is never split');
  assert.deepEqual([...chunks('ls\r')],['ls\r']);assert.deepEqual([...chunks('')],[]);
  assert.match(endedNote({agentId:'local-shell'},0),/Session ended: 0\. Press Enter to start it again\./);
  assert.match(endedNote({agentId:'agent-1',remote:true},255),/Press Enter to connect again\./);
  assert.match(endedNote({agentId:'svc_install_codex_local'},0),/Press Enter for a new shell here\./);
  assert.match(endedNote({agentId:'local-shell'}),/Saved output from an ended session\./);assert.match(endedNote({remote:true},'detached'),/Session detached\. Press Enter to connect again\./);
});
