'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const {Broker}=require('../desktop/broker.cjs');const {Store,Vault}=require('../desktop/store.cjs');const {temp,secure}=require('./helpers.cjs');
const {condense,transcriptText,AGENT_PROMPT}=require('../desktop/condense.cjs');
async function fixture(t,reply='## Goal\nShip it'){
  const root=await temp(t),prompts=[];
  const factory=()=>({connect:async()=>({description:'ok'}),close(){},run:async ctx=>{prompts.push(ctx.text);ctx.onEvent({type:'text',text:ctx.text===AGENT_PROMPT?reply:`echo ${ctx.text}`});return {};}});
  const b=new Broker({store:new Store(root),vault:new Vault(root,secure()),emit:()=>{},approve:async()=>true,adapterFactory:factory});await b.init();t.after(()=>b.close());
  const a=await b.saveAgent({agent:{name:'Tuco',provider:'hermes',protocol:'openai',transport:'http',endpoint:'http://127.0.0.1:8642/v1',model:'hermes-agent'}});await b.connect(a.id);
  const chat=async(text,c)=>{const r=await b.send({agentId:a.id,conversationId:c?.id||'',text});await b.turns.get(a.id)?.done;return b.conversation(r.conversationId);};
  return {b,a,prompts,chat};
}
test('chats can be renamed and deleted with their transcript; the snapshot hides essence text',async t=>{
  const {b,a,chat}=await fixture(t);
  const one=await chat('first question'),two=await b.createConversation(a.id,{kind:'playground',title:'Playground: x'});
  assert.equal(two.kind,'playground');
  await b.renameConversation({id:one.id,title:'  Launch   plan '});assert.equal(b.conversation(one.id).title,'Launch plan');
  await b.setEssence(one.id,{text:'SECRET ESSENCE TEXT',by:'model'});
  const snap=b.snapshot().conversations.find(c=>c.id===one.id);assert.equal(snap.essence.by,'model');assert(!JSON.stringify(b.snapshot()).includes('SECRET ESSENCE TEXT'));
  b.data.activeConversationId=two.id;await b.deleteConversation(two.id);
  assert.equal(b.data.activeConversationId,one.id);assert(!b.data.conversations.some(c=>c.id===two.id));
  await b.deleteConversation(one.id);assert.deepEqual(await b.store.transcript(one.id),[]);
  await assert.rejects(()=>b.deleteConversation(one.id),/not found/);
});
test('condense uses the Opaya model API when it has a key, without touching the agent',async t=>{
  const {b,prompts,chat}=await fixture(t);const c=await chat('plan the launch');await chat('add a rollback step',c);
  let sent=null;const opaya={summarizer:()=>'DeepSeek / deepseek-v4-pro',summarize:async m=>{sent=m;return {text:'## Goal\nLaunch',usage:{total_tokens:321}};}};
  const events=[];const r=await condense({broker:b,opaya,id:c.id,progress:e=>events.push(e)});
  assert.equal(r.essence.text,'## Goal\nLaunch');assert.equal(r.essence.by,'DeepSeek / deepseek-v4-pro');
  assert.match(sent[1].content,/User:\nplan the launch/);assert.match(sent[1].content,/Tuco:\necho add a rollback step/);
  assert.equal(prompts.length,2,'the agent was not asked');assert(events.some(e=>/321 tokens/.test(e.message||'')));
  assert.deepEqual([...new Set(events.filter(e=>e.state==='done').map(e=>e.step))],['read','condense','save']);
});
test('without a model key the agent condenses its own chat',async t=>{
  const {b,prompts,chat}=await fixture(t,'## Goal\nFrom the agent');const c=await chat('hello');
  const r=await condense({broker:b,opaya:{summarizer:()=>null},id:c.id});
  assert.equal(prompts.at(-1),AGENT_PROMPT);assert.equal(r.essence.text,'## Goal\nFrom the agent');assert.equal(r.essence.by,'Tuco');
  assert.equal(b.conversation(c.id).essence.text,'## Goal\nFrom the agent');
});
test('long transcripts keep the start and the latest part',()=>{
  const msgs=[{role:'user',content:'START '+'a'.repeat(5000)},{role:'assistant',content:'b'.repeat(5000)+' END'}];
  const text=transcriptText(msgs,'Agent',2000);assert(text.length<2100);assert(text.startsWith('User:\nSTART'));assert(text.endsWith(' END'));assert.match(text,/characters left out/);
});
