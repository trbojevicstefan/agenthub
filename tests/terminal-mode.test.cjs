'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const {temp,secure}=require('./helpers.cjs');
const {Broker,CLIENT_REFUSED}=require('../desktop/broker.cjs');const {Store,Vault}=require('../desktop/store.cjs');const {Terminals}=require('../desktop/terminal.cjs');const schema=require('../desktop/schema.cjs');
async function fixture(t,reply){
  const root=await temp(t);
  const factory=()=>({connect:async()=>({description:'ok'}),close(){},run:async ctx=>{ctx.onEvent({type:'text',text:reply});return {};}});
  const b=new Broker({store:new Store(root),vault:new Vault(root,secure()),emit:()=>{},approve:async()=>true,adapterFactory:factory});await b.init();t.after(()=>b.close());return {b,root};
}
const gemini={name:'Gemini CLI',provider:'custom',protocol:'acp',transport:'local',command:'gemini',args:['--acp']};
const settle=async b=>{for(let i=0;i<50&&b.turns.size;i++)await new Promise(r=>setTimeout(r,10));};
test('an agent whose vendor refuses other apps switches to its terminal, once, and says so',async t=>{
  const {b}=await fixture(t,'This client is no longer supported for Gemini Code Assist for individuals. To continue using Gemini, please migrate to the Antigravity suite of products: https://antigravity.google');
  const a=await b.saveAgent({agent:gemini});const told=[];b.onClientRefused=(agent,text)=>told.push([agent.id,text]);
  await b.connect(a.id);await b.send({agentId:a.id,text:'hi'});await settle(b);
  assert.equal(b.agent(a.id).surface,'terminal');assert.equal(told.length,1);assert.match(told[0][1],/Antigravity/);
  // Reloaded from disk, the choice stays.
  const again=new Broker({store:b.store,vault:b.vault,emit:()=>{},approve:async()=>true});await again.init();assert.equal(again.agent(a.id).surface,'terminal');
});
test('normal answers do not switch anything',async t=>{
  const {b}=await fixture(t,'Here is the version history of the client library.');
  const a=await b.saveAgent({agent:gemini});await b.connect(a.id);await b.send({agentId:a.id,text:'hi'});await settle(b);
  assert.equal(b.agent(a.id).surface,'');
  for(const text of ['client is no longer supported','Please migrate to the Antigravity suite'])assert(CLIENT_REFUSED.test(text));
  assert(!CLIENT_REFUSED.test('The Gemini client supports streaming.'));
});
test('chat or terminal per agent and in Settings',async t=>{
  const {b}=await fixture(t,'');
  assert.equal(b.data.settings.interface,'','not chosen until the first launch asks');
  await b.saveSettings({interface:'terminal'});assert.equal(b.data.settings.interface,'terminal');
  await assert.rejects(()=>b.saveSettings({interface:'desktop'}),/chat or terminal/);
  const a=await b.saveAgent({agent:gemini});
  await b.updateAgentDisplay({id:a.id,surface:'chat'});assert.equal(b.agent(a.id).surface,'chat');
  await b.updateAgentDisplay({id:a.id,surface:'bogus'});assert.equal(b.agent(a.id).surface,'');
  assert.equal(schema.agent({...gemini,surface:'terminal'}).surface,'terminal');assert.equal(schema.agent({...gemini,surface:'x'}).surface,'');
});
test('split terminals are remembered with the view',async t=>{
  const {b}=await fixture(t,'');
  await b.saveView({panes:['t1','t2','bad id!'],paneSizes:[1.5,0.5,'x'],terminalId:'t2'});
  assert.deepEqual(b.data.view.panes,['t1','t2']);assert.deepEqual(b.data.view.paneSizes,[1.5,0.5]);
});
test('the native CLI is the agent command without its chat-server arguments',()=>{
  const t=Object.create(Terminals.prototype);
  assert.deepEqual(t.cliArgs({provider:'custom',protocol:'acp',command:'gemini',args:['--acp']}),[]);
  assert.deepEqual(t.cliArgs({provider:'custom',protocol:'acp',command:'opencode',args:['acp']}),[]);
  assert.deepEqual(t.cliArgs({provider:'custom',protocol:'acp',command:'gemini',args:['--experimental-acp','--yolo']}),['--yolo']);
  assert.deepEqual(t.cliArgs({provider:'custom',protocol:'acp',command:'docker',args:['exec','-i','-w','/root','opaya-g','gemini','--acp']}),['exec','-it','-w','/root','-e','TERM=xterm-256color','opaya-g','gemini']);
  assert.deepEqual(t.cliArgs({provider:'custom',protocol:'terminal',command:'aider',args:['--model','x']}),['--model','x'],'terminal agents keep their arguments');
});
