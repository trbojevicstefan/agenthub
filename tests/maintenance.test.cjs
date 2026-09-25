'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');const {execFileSync}=require('node:child_process');
const {temp}=require('./helpers.cjs');
const m=require('../desktop/maintenance.cjs');
const skip=process.platform==='win32'?'uses POSIX sh and tar':false;
const hermes={id:'h1',name:'Tuco',provider:'hermes',protocol:'acp',transport:'local',command:'hermes',args:[]};
const profile={...hermes,id:'h2',name:'Writer',hermesHome:'/home/me/.hermes/profiles/writer'};
const container={...hermes,id:'h3',name:'Box',transport:'ssh',hostId:'s1',command:'docker',args:['exec','-i','opaya-hermes-box','hermes'],hermesHome:'/opt/data',clone:{from:'h1',scope:'everything',keys:true,runtime:'docker',dir:'/root/opaya-hermes/box',container:'opaya-hermes-box'}};
const claude={id:'c1',name:'Claude',provider:'claude',protocol:'claude',transport:'ssh',hostId:'s1',command:'claude',args:[]};
const api={id:'d1',name:'DeepSeek',provider:'deepseek',protocol:'openai',transport:'http',endpoint:'https://api.deepseek.com/v1',command:'',args:[]};

test('installation kind follows how the agent runs',()=>{
  assert.equal(m.kindOf(hermes).kind,'cli');
  assert.deepEqual([m.kindOf(profile).kind,m.kindOf(profile).profile],['hermes-profile','writer']);
  const d=m.kindOf(container);assert.deepEqual([d.kind,d.container,d.managed],['docker','opaya-hermes-box',true]);
  assert.equal(m.kindOf(api).kind,'remote-api');
  assert.equal(m.kindOf({provider:'custom',command:'/usr/local/bin/gemini',args:[],transport:'local'}).framework,'gemini-cli');
  assert.deepEqual(m.capabilities(api),{kind:'remote-api',label:'API connection',framework:'',update:false,uninstall:false,backup:false});
  assert.equal(m.capabilities(claude).backup,true);
  // Hermes profiles share one installation; containers do not.
  assert.deepEqual(m.sharing(hermes,[hermes,profile,container,claude]),['h2']);
  assert.deepEqual(m.sharing(container,[hermes,profile,container]),[]);
});
test('update and uninstall commands are valid sh and pick the installer on the machine',{skip},()=>{
  for(const a of [hermes,profile,container,claude,{provider:'custom',command:'aider',args:[],transport:'local'},{provider:'custom',command:'ollama',args:[],transport:'local'}]){
    for(const c of [m.updateCommand(a,{remote:true}),m.uninstallCommand(a,{remote:true}),m.uninstallCommand(a,{remote:true,data:true})]){
      execFileSync('sh',['-n','-c',c.command]);assert(c.preview&&!c.preview.includes("'\\''"),'the preview is the readable script');
    }
  }
  const un=m.uninstallCommand(claude,{remote:true}).preview;
  for(const way of ['npm uninstall -g @anthropic-ai/claude-code','brew uninstall claude-code','.local/share/claude'])assert(un.includes(way),way);
  assert(!un.includes('.claude.json'),'data stays unless asked');
  assert(m.uninstallCommand(claude,{remote:true,data:true}).preview.includes('.claude.json'));
  assert.match(m.uninstallCommand(profile,{remote:true}).preview,/hermes profile delete 'writer'/);
  assert.match(m.updateCommand(container,{remote:true}).preview,/docker pull nousresearch\/hermes-agent[\s\S]*docker run -d --name 'opaya-hermes-box'[\s\S]*'\/root\/opaya-hermes\/box:\/opt\/data'/);
  assert.match(m.uninstallCommand(container,{remote:true,data:true}).preview,/rm -rf '\/root\/opaya-hermes\/box'/);
  assert.throws(()=>m.updateCommand(api,{remote:false}),/API connection/);
  assert.throws(()=>m.uninstallCommand(api,{remote:false}),/API connection/);
  // Windows gets PowerShell, not sh.
  assert.match(m.uninstallCommand({...claude,transport:'local',hostId:''},{remote:false,windows:true,data:true}).command,/Remove-Item -Recurse -Force/);
});
test('uninstall never deletes a home folder or a shallow path',()=>{
  const bad={...container,clone:{...container.clone,dir:'/root'}};
  assert.throws(()=>m.uninstallCommand(bad,{remote:true,data:true}),/will not delete/);
  assert.throws(()=>m.uninstallCommand({...profile,hermesHome:'/profiles/writer'},{remote:true}),/will not delete/);
  assert.doesNotThrow(()=>m.uninstallCommand(bad,{remote:true,data:false}),'keeping the data needs no check');
});
async function unpack(file,dir){await fs.mkdir(dir,{recursive:true});execFileSync('tar',['-xzf',file,'-C',dir]);const out=[];const walk=async(d)=>{for(const e of await fs.readdir(d,{withFileTypes:true})){const p=path.join(d,e.name);if(e.isDirectory())await walk(p);else out.push(path.relative(dir,p).split(path.sep).join('/'));}};await walk(dir);return out.sort();}
test('a local backup copies the Hermes home without the installation, and leaves out history and keys on request',{skip},async t=>{
  const root=await temp(t),home=path.join(root,'hermes'),dest=path.join(root,'backups');
  const files={'config.yaml':'model: x','.env':'KEY=secret','SOUL.md':'soul','skills/a/SKILL.md':'---\nname: a\n---','memories/USER.md':'me','state.db':'db','sessions/s.json':'{}','logs/x.log':'l','hermes-agent/run.py':'code','profiles/other/config.yaml':'o','cron/jobs.json':'[]'};
  for(const [f,c] of Object.entries(files)){await fs.mkdir(path.dirname(path.join(home,f)),{recursive:true});await fs.writeFile(path.join(home,f),c);}
  const agent={...hermes,hermesHome:home},steps=[];
  const full=await m.backup({agent,host:null,dest,progress:e=>e.step&&steps.push(`${e.step}:${e.state||''}`)});
  assert(full.file.startsWith(path.join(dest,'tuco')+path.sep)&&full.file.endsWith('.tar.gz'));
  assert.equal((await fs.stat(full.file)).mode&0o777,0o600);
  assert.deepEqual(await unpack(full.file,path.join(root,'x1')),['.env','SOUL.md','config.yaml','cron/jobs.json','logs/x.log','memories/USER.md','sessions/s.json','skills/a/SKILL.md','state.db']);
  assert(steps.includes('copy:done'));
  const manifest=JSON.parse(await fs.readFile(full.file.replace(/\.tar\.gz$/,'.json'),'utf8'));
  assert.equal(manifest.agent.name,'Tuco');assert.equal(manifest.contents.keys,true);
  await new Promise(r=>setTimeout(r,1100));
  const slim=await m.backup({agent,host:null,dest,keys:false,history:false});
  assert.deepEqual(await unpack(slim.file,path.join(root,'x2')),['SOUL.md','config.yaml','cron/jobs.json','memories/USER.md','skills/a/SKILL.md']);
  const settings={backupDir:dest},list=await m.listBackups(agent,settings);
  assert.deepEqual(list.backups.map(b=>b.file),[slim.file,full.file]);assert.equal(list.backups[0].history,false);
  await assert.rejects(()=>m.removeBackup(path.join(root,'hermes','config.yaml'),settings),/not in the Opaya backup folder/);
  await m.removeBackup(slim.file,settings);
  assert.deepEqual((await m.listBackups(agent,settings)).backups.map(b=>b.file),[full.file]);
});
test('a Claude Code backup reads ~/.claude and ~/.claude.json and can leave out the login',{skip},async t=>{
  const root=await temp(t),old=process.env.HOME;process.env.HOME=root;t.after(()=>{process.env.HOME=old;});
  for(const [f,c] of Object.entries({'.claude/settings.json':'{}','.claude/.credentials.json':'secret','.claude/projects/p/1.jsonl':'x','.claude/skills/s/SKILL.md':'s','.claude.json':'{}','other.txt':'no'})){await fs.mkdir(path.dirname(path.join(root,f)),{recursive:true});await fs.writeFile(path.join(root,f),c);}
  const r=await m.backup({agent:{...claude,transport:'local',hostId:''},host:null,dest:path.join(root,'b'),keys:false,history:false});
  assert.deepEqual(await unpack(r.file,path.join(root,'x')),['.claude.json','.claude/settings.json','.claude/skills/s/SKILL.md']);
});
test('detection reports the installer, path and version',{skip},async t=>{
  // An empty npm prefix, so a Claude Code installed with npm on the test machine does not count.
  const root=await temp(t),old={HOME:process.env.HOME,npm_config_prefix:process.env.npm_config_prefix};process.env.HOME=root;process.env.npm_config_prefix=path.join(root,'npm');
  t.after(()=>{for(const [k,v] of Object.entries(old)){if(v===undefined)delete process.env[k];else process.env[k]=v;}});
  await fs.mkdir(path.join(root,'.local/bin'),{recursive:true});await fs.writeFile(path.join(root,'.local/bin/claude'),'#!/bin/sh\necho "2.1.0 (Claude Code)"\n',{mode:0o755});
  const info=await m.detect({...claude,transport:'local',hostId:''},null);
  assert.equal(info.path,path.join(root,'.local/bin/claude'));assert.equal(info.version,'2.1.0 (Claude Code)');assert.deepEqual(info.methodLabels,['Official installer']);
});
test('this computer keeps its Opaya name, note and backup folder across restarts',async t=>{
  const {Broker}=require('../desktop/broker.cjs');const {Store,Vault}=require('../desktop/store.cjs');const {secure}=require('./helpers.cjs');
  const root=await temp(t),make=async()=>{const b=new Broker({store:new Store(root),vault:new Vault(root,secure()),emit:()=>{},approve:async()=>true});await b.init();return b;};
  const b=await make(),dir=path.join(root,'My Backups');
  await b.saveSettings({machineName:'  Studio Mac ',machineNote:'Office',backupDir:dir});
  await assert.rejects(()=>b.saveSettings({backupDir:'relative/folder'}),/absolute folder/);
  await assert.rejects(()=>b.saveSettings({machineName:'x'.repeat(61)}),/machine name/);
  await b.close();
  const again=await make();
  assert.deepEqual({...again.data.settings},{itrustAll:false,itrustOpaya:false,machineName:'Studio Mac',machineNote:'Office',backupDir:dir,updateChecks:true,autoFix:true});
  assert.equal(m.backupDir(again.data.settings),dir);await again.close();
});
