'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const {temp,secure}=require('./helpers.cjs');
const autofix=require('../desktop/autofix.cjs');
const {Broker}=require('../desktop/broker.cjs');const {Store,Vault}=require('../desktop/store.cjs');
const hermes={name:'Hermes',provider:'hermes',protocol:'openai',transport:'http',endpoint:'http://127.0.0.1:8642/v1',model:'hermes-agent',command:'hermes',args:[],hermesHome:'/home/me/.hermes/profiles/work'};
test('agent errors are sorted into the fixes Opaya knows',()=>{
  assert.deepEqual(autofix.classify(hermes,'fetch failed: connect ECONNREFUSED 127.0.0.1:8642'),{kind:'gateway'});
  assert.deepEqual(autofix.classify(hermes,'The gateway answered 502 Bad Gateway'),{kind:'gateway'});
  assert.equal(autofix.classify({...hermes,protocol:'acp'},'ECONNREFUSED').kind,'other','only gateway connections have a gateway to start');
  assert.deepEqual(autofix.classify({provider:'codex',protocol:'codex',command:'codex',args:[]},'unknown argument: app-server'),{kind:'outdated',target:'agent'});
  assert.deepEqual(autofix.classify({provider:'codex',protocol:'codex',command:'codex',args:[]},'Not logged in. Run codex login.'),{kind:'onboarding',program:'codex'});
  assert.equal(autofix.classify({provider:'claude',protocol:'claude',command:'claude',args:[]},'Invalid API key · Please run /login').kind,'onboarding');
  assert.equal(autofix.classify({provider:'openclaw',protocol:'openai',command:'openclaw',args:[]},'Run openclaw onboard first').kind,'onboarding');
  assert.equal(autofix.classify({provider:'claude',protocol:'claude',command:'claude',args:[]},'spawn claude ENOENT').kind,'missing');
  assert.equal(autofix.classify({provider:'custom',protocol:'acp',command:'docker',args:['exec','-i','box','opencode','acp']},'opencode auth login required').kind,'onboarding');
  assert.equal(autofix.classify({provider:'deepseek',protocol:'openai',transport:'http'},'Rate limit reached').kind,'other');
});
test('first-time setup and sign-in commands run where the agent runs',()=>{
  assert.equal(autofix.signIn({provider:'codex',protocol:'codex',transport:'local',command:'codex',args:[]}).command,'codex login');
  assert.equal(autofix.signIn({provider:'codex',protocol:'codex',transport:'ssh',command:'codex',args:[]}).command,'codex login --device-auth','a server gets the device code');
  assert.equal(autofix.signIn(hermes).command,"HERMES_HOME='/home/me/.hermes/profiles/work' hermes setup");
  assert.equal(autofix.signIn(hermes,{windows:true}).command,"$env:HERMES_HOME='/home/me/.hermes/profiles/work'; hermes setup");
  assert.equal(autofix.signIn({provider:'custom',protocol:'acp',transport:'ssh',command:'docker',args:['exec','-i','-w','/root','opaya-oc','opencode','acp']}).command,"docker exec -it 'opaya-oc' opencode auth login");
  assert.equal(autofix.signIn({provider:'custom',protocol:'terminal',command:'aider',args:[]}),null,'unknown agents are left to the Opaya Agent');
});
async function fixture(t,run){
  const root=await temp(t);let closed=null;
  const factory=()=>({connect:async()=>({}),close(){},rpc:{on:(event,fn)=>{if(event==='closed')closed=fn;}},run});
  const b=new Broker({store:new Store(root),vault:new Vault(root,secure()),emit:()=>{},approve:async()=>true,adapterFactory:factory});await b.init();t.after(()=>b.close());
  return {b,drop:error=>closed(error)};
}
const settle=async b=>{for(let i=0;i<100&&b.turns.size;i++)await new Promise(r=>setTimeout(r,10));};
test('the broker reports failed turns and dropped connections, but not the user\'s own Stop',async t=>{
  const {b,drop}=await fixture(t,async ctx=>{if(ctx.text==='fail')throw new Error('model overloaded');await new Promise((r,j)=>ctx.signal.addEventListener('abort',()=>j(new Error('aborted'))));});
  const seen=[];b.onTurnError=(a,error)=>seen.push(['turn',a.name,error]);b.onConnectionLost=(a,error)=>seen.push(['lost',a.name,error]);
  const a=await b.saveAgent({agent:{name:'Codex',provider:'codex',protocol:'codex',transport:'local',command:'codex',args:[]}});await b.connect(a.id);
  await b.send({agentId:a.id,text:'fail'});await settle(b);
  await b.send({agentId:a.id,text:'wait'});b.stop(a.id);await settle(b);
  drop(new Error('socket closed'));
  assert.deepEqual(seen,[['turn','Codex','model overloaded'],['lost','Codex','socket closed']]);
});
test('a quiet connect does not report its error again',async t=>{
  const root=await temp(t);
  const b=new Broker({store:new Store(root),vault:new Vault(root,secure()),emit:()=>{},approve:async()=>true,adapterFactory:()=>({connect:async()=>{throw new Error('ECONNREFUSED');},close(){}})});await b.init();t.after(()=>b.close());
  const seen=[];b.onConnectError=(_a,error)=>seen.push(error);
  const a=await b.saveAgent({agent:hermes});
  await assert.rejects(()=>b.connect(a.id,{quiet:true}),/ECONNREFUSED/);assert.equal(seen.length,0);
  await assert.rejects(()=>b.connect(a.id),/ECONNREFUSED/);assert.deepEqual(seen,['ECONNREFUSED']);
});
