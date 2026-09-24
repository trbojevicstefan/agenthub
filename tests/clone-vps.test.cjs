'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');
const {temp,secure}=require('./helpers.cjs');
const skip=process.platform==='win32'?'uses POSIX sh and tar':false;
async function tree(dir,base=dir){const out=[];for(const e of await fs.readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())out.push(...await tree(p,base));else out.push(path.relative(base,p).split(path.sep).join('/'));}return out.sort();}
async function fixture(t){
  const root=await temp(t),src=path.join(root,'src'),home=path.join(root,'hermes-root'),bin=path.join(root,'bin');
  const files={'config.yaml':'model: x','.env':'OPENAI_API_KEY=secret','SOUL.md':'I am Tuco','skills/research/arxiv/SKILL.md':'---\nname: arxiv\n---','memories/USER.md':'Stefan','memories/MEMORY.md':'notes','sessions/s1.json':'{}','state.db':'db','logs/agent.log':'log','auth.json':'{}','profiles/other/config.yaml':'x','cron/jobs.json':'[]'};
  for(const [f,c] of Object.entries(files)){await fs.mkdir(path.dirname(path.join(src,f)),{recursive:true});await fs.writeFile(path.join(src,f),c);}
  await fs.mkdir(home,{recursive:true});await fs.writeFile(path.join(home,'config.yaml'),'root');
  await fs.mkdir(bin);for(const tool of ['hermes','ssh-keygen'])await fs.writeFile(path.join(bin,tool),tool==='ssh-keygen'?'#!/bin/sh\nwhile [ $# -gt 0 ]; do [ "$1" = "-f" ] && f=$2; shift; done\necho PRIVATE > "$f"; echo "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKeyForTests opaya-test" > "$f.pub"\n':'#!/bin/sh\necho hermes\n',{mode:0o755});
  const env={PATH:process.env.PATH,HERMES_HOME:process.env.HERMES_HOME,HOME:process.env.HOME};
  process.env.PATH=`${bin}:${process.env.PATH}`;process.env.HERMES_HOME=home;process.env.HOME=root;
  t.after(()=>{for(const [k,v] of Object.entries(env)){if(v===undefined)delete process.env[k];else process.env[k]=v;}});
  return {root,src,home};
}
test('clone copies exactly the chosen parts and never history, logs, OAuth logins or other profiles',{skip},async t=>{
  const {src,home}=await fixture(t);const {clone}=require('../desktop/clone.cjs');
  const agent={id:'a1',name:'tuco',provider:'hermes',protocol:'acp',transport:'local',command:'hermes',args:[],hermesHome:src,tags:['main']};
  const all=await clone({agent,host:null,runtime:'regular',scope:'everything',keys:true,name:'Tuco Copy'});
  assert.equal(all.connection.hermesHome,path.join(home,'profiles','tuco-copy'));assert.equal(all.connection.command,'hermes');assert.deepEqual(all.connection.clone.scope,'everything');assert(all.connection.tags.includes('clone'));
  assert.deepEqual(await tree(all.connection.hermesHome),['.env','SOUL.md','config.yaml','cron/jobs.json','memories/MEMORY.md','memories/USER.md','skills/research/arxiv/SKILL.md']);
  const persona=await clone({agent,host:null,runtime:'regular',scope:'personality',keys:false,name:'persona'});
  assert.deepEqual(await tree(persona.connection.hermesHome),['SOUL.md','config.yaml','memories/USER.md','skills/research/arxiv/SKILL.md']);
  const mem=await clone({agent,host:null,runtime:'regular',scope:'memory',keys:false,name:'mem'});
  assert.deepEqual(await tree(mem.connection.hermesHome),['config.yaml','memories/MEMORY.md','memories/USER.md']);
  const noCron=await clone({agent,host:null,runtime:'regular',scope:'everything',keys:false,cron:false,name:'no-cron'});
  assert(!(await tree(noCron.connection.hermesHome)).some(f=>f.startsWith('cron/')),'Everything without cron jobs leaves them out');assert.equal(noCron.connection.clone.cron,false);
  const skillsCron=await clone({agent,host:null,runtime:'regular',scope:'skills',keys:false,cron:true,name:'skills-cron'});
  assert.deepEqual(await tree(skillsCron.connection.hermesHome),['config.yaml','cron/jobs.json','skills/research/arxiv/SKILL.md']);
  assert.equal(all.connection.clone.cron,true,'Everything copies cron jobs by default');
  await assert.rejects(()=>clone({agent:{...agent,provider:'claude'},host:null,scope:'skills',name:'x'}),/Hermes agents/);
  await assert.rejects(()=>clone({agent,host:null,scope:'skills',name:'***'}),/name/);
});
test('broker clones, saves the connection with its recipe, and redeploys from the source',{skip},async t=>{
  const {src}=await fixture(t);const {Broker}=require('../desktop/broker.cjs');const {Store,Vault}=require('../desktop/store.cjs');const root=await temp(t);
  const broker=new Broker({store:new Store(root),vault:new Vault(root,secure()),emit:()=>{},approve:async()=>true,adapterFactory:()=>({connect:async()=>({}),close(){},run:async()=>({})})});
  await broker.init();t.after(()=>broker.close());
  const source=await broker.saveAgent({agent:{name:'tuco',provider:'hermes',protocol:'acp',transport:'local',command:'hermes',cwd:root,hermesHome:src}});
  const events=[],approvals0=[];broker.approve=async(_a,title)=>{approvals0.push(title);return true;};
  const r=await broker.cloneAgent({id:source.id,name:'tuco-2',scope:'skills',keys:false},e=>events.push(e));
  assert.deepEqual(approvals0,[],'a confirmed clone does not ask to trust its executable again');
  assert.deepEqual([...new Set(events.filter(e=>e.state==='done').map(e=>e.step))],['target','source','select','copy','save','connect']);
  const copy=events.filter(e=>e.step==='copy'&&Number.isFinite(e.bytes));assert(copy.at(-1).bytes>0&&copy.at(-1).total>0,'copy reports bytes and total');
  const c=broker.agent(r.agent.id);assert.equal(c.clone.from,source.id);assert.equal(c.clone.scope,'skills');
  await fs.mkdir(path.join(src,'skills','new-one'),{recursive:true});await fs.writeFile(path.join(src,'skills','new-one','SKILL.md'),'---\nname: new-one\n---');
  const again=await broker.redeployAgent(c.id);assert.deepEqual(again.copied,['config.yaml','skills']);
  assert.equal(await fs.readFile(path.join(c.hermesHome,'skills','new-one','SKILL.md'),'utf8'),'---\nname: new-one\n---');
  const withCron=await broker.cloneAgent({id:source.id,name:'tuco-cron',scope:'skills',keys:false,cron:true});
  assert.equal(broker.agent(withCron.agent.id).clone.cron,true,'the cron choice is saved with the recipe');
  assert.deepEqual((await broker.redeployAgent(withCron.agent.id)).copied.sort(),['config.yaml','cron','skills']);
  await assert.rejects(()=>broker.redeployAgent(source.id),/not a clone/);
});
test('a new VPS key is created once in ~/.ssh and reused',{skip},async t=>{
  const {root}=await fixture(t);const vps=require('../desktop/vps.cjs');
  const a=await vps.createKey('My VPS 1');assert.equal(a.name,'my-vps-1');assert.equal(a.identityFile,path.join(root,'.ssh','opaya_my-vps-1'));assert.match(a.publicKey,/^ssh-ed25519 /);assert.equal(a.created,true);
  const b=await vps.createKey('my-vps-1');assert.equal(b.created,false);assert.equal(b.publicKey,a.publicKey);
  assert.throws(()=>vps.keyName('***'),/Name the VPS/);
});
test('the Opaya Agent keeps separate chat sessions and migrates the old single history',async t=>{
  const root=await temp(t);const {OpayaAgent}=require('../desktop/opaya-agent.cjs');
  await fs.mkdir(path.join(root,'opaya-agent'),{recursive:true});await fs.writeFile(path.join(root,'opaya-agent','history.json'),JSON.stringify([{id:'m1',role:'user',content:'Install Hermes on my VPS',createdAt:new Date().toISOString()}]));
  const agent=new OpayaAgent({root,vault:{has:()=>false},broker:null,terminals:null,approve:async()=>true,emit:()=>{}});await agent.init();
  let d=agent.describe();assert.equal(d.sessions.length,1);assert.equal(d.sessions[0].title,'Install Hermes on my VPS');assert.equal(agent.messages.length,1);
  const first=agent.sessionId;await agent.newSession();assert.notEqual(agent.sessionId,first);assert.equal(agent.messages.length,0);
  agent.messages.push({id:'m2',role:'user',content:'Second chat',createdAt:new Date().toISOString()});await agent.persist();
  await agent.selectSession(first);assert.equal(agent.messages[0].content,'Install Hermes on my VPS');
  d=agent.describe();assert.deepEqual(d.sessions.map(s=>s.title).sort(),['Install Hermes on my VPS','Second chat']);
  await agent.deleteSession(first);assert.equal(agent.describe().sessions.length,1);assert.equal(agent.messages[0].content,'Second chat');
  const again=new OpayaAgent({root,vault:{has:()=>false},broker:null,terminals:null,approve:async()=>true,emit:()=>{}});await again.init();assert.equal(again.messages[0].content,'Second chat');
});
