'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');
const {temp,noPython,openclawStores}=require('./helpers.cjs');
const cli=require('../desktop/clone-cli.cjs');
const skip=process.platform==='win32'?'uses HOME and tar the POSIX way':false;
const write=async(file,text='x')=>{await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,text);};
const exists=file=>fs.stat(file).then(()=>true,()=>false);

test('a CLI clone copies settings, skills and memory but never chat history, and logins only when asked',{skip},async t=>{
  const src=await temp(t),dst=await temp(t),home=process.env.HOME;t.after(()=>{process.env.HOME=home;});
  for(const f of ['.claude/settings.json','.claude/CLAUDE.md','.claude/skills/deploy/SKILL.md','.claude/projects/p1/chat.jsonl','.claude/.credentials.json','.claude.json'])await write(path.join(src,f));
  await write(path.join(dst,'.claude/settings.json'),'old');
  process.env.HOME=src;
  const agent={id:'a1',name:'Claude',provider:'claude',protocol:'claude',transport:'local',command:'claude',args:[]};
  const copied=await cli.copy({agent,sourceHost:null,id:'claude',scope:'everything',keys:false,to:{host:null,container:''},dest:dst,backup:true,progress:()=>{}});
  assert.deepEqual(copied,['.claude']);
  assert.equal(await exists(path.join(dst,'.claude/skills/deploy/SKILL.md')),true);
  assert.equal(await exists(path.join(dst,'.claude/CLAUDE.md')),true);
  assert.equal(await exists(path.join(dst,'.claude/projects')),false,'chat history stays behind');
  assert.equal(await exists(path.join(dst,'.claude/.credentials.json')),false,'logins stay behind');
  assert.equal(await exists(path.join(dst,'.claude.json')),false);
  const kept=(await fs.readdir(dst)).find(n=>n.startsWith('.claude.before-clone-'));assert(kept,'what was there is kept');
  assert.equal(await fs.readFile(path.join(dst,kept,'settings.json'),'utf8'),'old');
});
test('a CLI agent cannot be cloned over itself, and API connections are not clones',()=>{
  assert.equal(cli.sameAccount({transport:'local',command:'claude'},null),true);
  assert.equal(cli.sameAccount({transport:'local',command:'claude'},{id:'vps'}),false);
  assert.equal(cli.sameAccount({transport:'ssh',hostId:'vps',command:'codex'},{id:'vps'}),true);
  return assert.rejects(cli.clone({agent:{id:'x',name:'DeepSeek',provider:'custom',protocol:'openai',transport:'http',endpoint:'https://api.deepseek.com/v1',command:'',args:[]},host:null,name:'c'}),/Opaya can clone Hermes/);
});
test('clone scopes pick only their parts',()=>{
  const p=cli.plan('codex','skills',false);
  assert.deepEqual(p.wanted,['.codex/config.toml','.codex/skills','.codex/prompts']);
  assert(p.excludes.includes('.codex/auth.json')&&p.excludes.includes('.codex/sessions'));
  assert(cli.plan('codex','memory',true).wanted.includes('.codex/auth.json'));
});
// Runs the generated remote command locally, like tests/tar-safety.test.cjs. No SSH connection is made.
async function sshHost(t,root){
  const {findExecutable,environment}=require('../desktop/process.cjs');
  const bin=path.join(root,'bin');await write(path.join(bin,'ssh'),'#!/bin/sh\nfor last; do :; done\nexec /bin/sh -c "$last"\n');await fs.chmod(path.join(bin,'ssh'),0o755);
  const oldPath=process.env.PATH;process.env.PATH=`${bin}:${oldPath}`;t.after(()=>{process.env.PATH=oldPath;});
  assert.equal(findExecutable('ssh',environment()),path.join(bin,'ssh'));
  return {id:'s1',name:'Fixture',hostname:'fixture.invalid',username:'fixture',port:22};
}
for(const remote of [false,true])test(`an OpenClaw clone without keys leaves its config's credentials behind (${remote?'machine':'this computer'})`,{skip},async t=>{
  const src=await temp(t),dst=await temp(t),home=process.env.HOME;t.after(()=>{process.env.HOME=home;});
  const host=remote?await sshHost(t,await temp(t)):null,to={host,container:''};
  const config={gateway:{auth:{mode:'token',token:'SOURCE-TOKEN'}},models:{providers:{openai:{apiKey:'sk-source'}}},agents:{defaults:{model:'openai/gpt'}}};
  await write(path.join(src,'.openclaw/openclaw.json'),JSON.stringify(config));
  for(const f of ['.openclaw/skills/a/SKILL.md','.openclaw/credentials/oauth.json'])await write(path.join(src,f));
  process.env.HOME=src;
  const agent={id:'o1',name:'Claw',provider:'openclaw',protocol:'openai',transport:'http',command:'openclaw',args:[],endpoint:'http://127.0.0.1:18789/v1'},messages=[];
  const copy=(keys,backup)=>cli.copy({agent,sourceHost:null,id:'openclaw',scope:'everything',keys,to,dest:dst,backup,progress:e=>e.message&&messages.push(e.message)});
  assert.deepEqual(await copy(false,true),['.openclaw']);
  const file=path.join(dst,'.openclaw/openclaw.json'),copied=await fs.readFile(file,'utf8');
  assert(!copied.includes('SOURCE-TOKEN')&&!copied.includes('sk-source'),'credentials stay behind');
  assert.deepEqual(JSON.parse(copied),{gateway:{auth:{mode:'token'}},models:{providers:{openai:{}}},agents:{defaults:{model:'openai/gpt'}}});
  assert.equal((await fs.stat(file)).mode&0o777,0o600);
  assert.equal(await exists(path.join(dst,'.openclaw/skills/a/SKILL.md')),true);
  assert.equal(await exists(path.join(dst,'.openclaw/credentials')),false);
  assert(messages.some(m=>/generate-gateway-token/.test(m)));
  // A redeploy replaces the settings and keeps the clone's own token.
  await fs.writeFile(file,JSON.stringify({gateway:{auth:{mode:'token',token:'CLONE-TOKEN'}}}));
  config.agents.defaults.model='openai/next';await fs.writeFile(path.join(src,'.openclaw/openclaw.json'),JSON.stringify(config));
  await copy(false,false);
  const redeployed=JSON.parse(await fs.readFile(file,'utf8'));
  assert.equal(redeployed.gateway.auth.token,'CLONE-TOKEN');assert.equal(redeployed.agents.defaults.model,'openai/next');assert.equal(redeployed.models.providers.openai.apiKey,undefined);
  // A config that is not plain JSON is left out instead of copied with its credentials.
  await fs.writeFile(path.join(src,'.openclaw/openclaw.json'),'{gateway:{auth:{token:"SOURCE-TOKEN"}}}');await fs.rm(file);
  await copy(false,false);
  assert.equal(await exists(file),false);assert(messages.some(m=>/not plain JSON/.test(m)));
  await copy(true,false);
  assert.match(await fs.readFile(file,'utf8'),/SOURCE-TOKEN/,'with keys the config is copied as it is');
});
test('an OpenClaw clone of skills copies the config even without skill folders',{skip},async t=>{
  const src=await temp(t),dst=await temp(t),home=process.env.HOME;t.after(()=>{process.env.HOME=home;});
  await write(path.join(src,'.openclaw/openclaw.json'),JSON.stringify({gateway:{auth:{token:'SOURCE-TOKEN'}},agents:{defaults:{model:'m'}}}));
  await write(path.join(dst,'.openclaw/openclaw.json'),'old');
  process.env.HOME=src;
  const p=cli.plan('openclaw','skills',false);
  assert.equal(p.config,'.openclaw/openclaw.json');assert(!p.wanted.includes(p.config)&&p.excludes.includes(p.config));
  assert(cli.plan('openclaw','skills',true).wanted.includes('.openclaw/openclaw.json'));
  const agent={id:'o1',name:'Claw',provider:'openclaw',protocol:'openai',transport:'http',command:'openclaw',args:[]};
  assert.deepEqual(await cli.copy({agent,sourceHost:null,id:'openclaw',scope:'skills',keys:false,to:{host:null,container:''},dest:dst,backup:true,progress:()=>{}}),['.openclaw/openclaw.json']);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dst,'.openclaw/openclaw.json'),'utf8')),{gateway:{auth:{}},agents:{defaults:{model:'m'}}});
  const kept=(await fs.readdir(path.join(dst,'.openclaw'))).find(n=>n.startsWith('openclaw.json.before-clone-'));
  assert.equal(await fs.readFile(path.join(dst,'.openclaw',kept),'utf8'),'old','what was there is kept');
});
for(const remote of [false,true])test(`an OpenClaw clone without keys copies its SQLite stores without logins, and a redeploy keeps the clone's own (${remote?'machine':'this computer'})`,{skip:skip||noPython},async t=>{
  const src=await temp(t),dst=await temp(t),tmp=await temp(t),old={HOME:process.env.HOME,TMPDIR:process.env.TMPDIR};
  t.after(()=>{for(const [k,v] of Object.entries(old)){if(v===undefined)delete process.env[k];else process.env[k]=v;}});
  const fixture=await openclawStores(src);await write(path.join(src,'.openclaw/skills/a/SKILL.md'));
  const host=remote?await sshHost(t,await temp(t)):null,messages=[];
  process.env.HOME=src;process.env.TMPDIR=tmp;
  const agent={id:'o1',name:'Claw',provider:'openclaw',protocol:'openai',transport:'http',command:'openclaw',args:[],endpoint:'http://127.0.0.1:18789/v1'};
  const copy=(keys,backup)=>cli.copy({agent,sourceHost:null,id:'openclaw',scope:'everything',keys,to:{host,container:''},dest:dst,backup,progress:e=>e.message&&messages.push(e.message)});
  await copy(false,true);
  for(const [f,kept] of Object.entries(fixture.state)){
    const raw=await fs.readFile(path.join(dst,f));
    for(const x of fixture.secrets)assert(!raw.includes(x),`${f} still holds ${x}`);
    for(const x of kept)assert(raw.includes(x),`${f} keeps ${x}`);
  }
  assert.deepEqual(await fs.readdir(path.join(dst,'.openclaw/state')),['openclaw.sqlite'],'no WAL from the source');
  assert.equal(await exists(path.join(dst,'.openclaw/skills/a/SKILL.md')),true);
  assert(messages.some(m=>/without auth profiles, the secret store and device tokens/.test(m)));
  // A redeploy keeps the clone's own stores and logins.
  const store=path.join(dst,'.openclaw/state/openclaw.sqlite');await fs.writeFile(store,'CLONE-OWN-STORE');
  await copy(false,false);
  assert.equal(await fs.readFile(store,'utf8'),'CLONE-OWN-STORE');assert(messages.some(m=>/keeps its own/.test(m)));
  // With keys, the stores are copied as they are.
  await fs.rm(path.join(dst,'.openclaw'),{recursive:true});await copy(true,false);
  assert((await fs.readFile(store)).includes('SECRET-STORE-VALUE'));assert.equal(await exists(store+'-wal'),true);
  assert.deepEqual(await fs.readdir(tmp),[],'the temporary copies are removed');
});
