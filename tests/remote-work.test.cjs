'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');const {execSync}=require('node:child_process');
const {temp}=require('./helpers.cjs');const rw=require('../desktop/remote-work.cjs');const projects=require('../desktop/projects.cjs');
// No SSH here: with host null the "machine" is a second folder on this computer, through the same code paths.
const skip=process.platform==='win32'?'uses POSIX sh':false;
const quiet=()=>{};
async function repo(t){
  const root=await temp(t),local=path.join(root,'local'),remote=path.join(root,'machine','app');
  await fs.mkdir(local,{recursive:true});const sh=c=>execSync(c,{cwd:local,shell:'/bin/sh'}).toString().trim();
  sh('git init -q -b main && git config user.name me && git config user.email me@x');await fs.writeFile(path.join(local,'app.txt'),'hello\n');sh('git add . && git commit -qm app');
  return {root,local,remote,sh};
}
test('git: your branch and uncommitted work go over, the review shows only the agent, and nothing of yours is lost',{skip},async t=>{
  const {root,local,remote,sh}=await repo(t);await fs.writeFile(path.join(local,'wip.txt'),'mine, not committed\n');
  const link={branch:'opaya/tuco'};
  const sent=await rw.sendGit({folder:local,host:null,dir:remote,branch:link.branch,includeChanges:true,first:true,progress:quiet});
  assert.equal(sent.included,true);
  assert.deepEqual((await fs.readdir(remote)).filter(f=>f!=='.git').sort(),['app.txt','wip.txt']);
  assert.equal(sh('git status --porcelain'),'?? wip.txt','your folder and branch are untouched');
  // The agent edits and adds files without committing.
  await fs.writeFile(path.join(remote,'app.txt'),'hello from agent\n');await fs.writeFile(path.join(remote,'new.txt'),'agent\n');
  await assert.rejects(()=>rw.sendGit({folder:local,host:null,dir:remote,branch:link.branch,first:false,progress:quiet}),/Bring changes back first/);
  const back=await rw.bringBackGit({folder:local,host:null,dir:remote,branch:link.branch,agentName:'Tuco',base:sent.commit,progress:quiet});
  assert.deepEqual(back.files,['M\tapp.txt','A\tnew.txt'],'only the agent\'s work, not the wip that travelled along');
  assert.equal(back.canMerge,false,'its commits sit on top of your uncommitted work, so Apply, not Merge');
  for(const c of rw.applyCommands(back,'apply',{patchFile:path.join(root,'p.patch')}))sh(c);
  assert.equal(await fs.readFile(path.join(local,'app.txt'),'utf8'),'hello from agent\n');
  assert.equal(await fs.readFile(path.join(local,'wip.txt'),'utf8'),'mine, not committed\n');
  // You commit, keep going and send again: allowed, because the agent's tip is what you brought back.
  sh('git add -A && git commit -qm reviewed');await fs.writeFile(path.join(local,'app.txt'),'v3\n');sh('git commit -qam v3');
  const again=await rw.sendGit({folder:local,host:null,dir:remote,branch:link.branch,first:false,lease:back.tip,progress:quiet});
  assert.equal(await fs.readFile(path.join(remote,'app.txt'),'utf8'),'v3\n');
  // The agent commits more; an old lease cannot overwrite it.
  await fs.writeFile(path.join(remote,'more.txt'),'more\n');execSync('git add -A && git -c user.name=a -c user.email=a@x commit -qm more',{cwd:remote,shell:'/bin/sh'});
  await assert.rejects(()=>rw.sendGit({folder:local,host:null,dir:remote,branch:link.branch,first:false,lease:back.tip,progress:quiet}),/Bring changes back first/);
  const next=await rw.bringBackGit({folder:local,host:null,dir:remote,branch:link.branch,base:again.commit,progress:quiet});
  assert.deepEqual(next.files,['A\tmore.txt']);assert.equal(next.canMerge,true);
  for(const c of rw.applyCommands(next,'merge'))sh(c);
  assert.equal(sh('git log -1 --format=%s'),'more');
  assert((await rw.bringBackGit({folder:local,host:null,dir:remote,branch:link.branch,base:next.tip,progress:quiet})).upToDate);
});
test('plain copy: there and back, new and changed files only, with backups of what is replaced',{skip},async t=>{
  const root=await temp(t),local=path.join(root,'site'),remote=path.join(root,'machine','site'),backups=path.join(root,'backups');
  await fs.mkdir(path.join(local,'node_modules','x'),{recursive:true});await fs.writeFile(path.join(local,'index.html'),'v1');await fs.writeFile(path.join(local,'keep.txt'),'same');await fs.writeFile(path.join(local,'node_modules','x','big.js'),'skip me');
  await rw.sendCopy({folder:local,host:null,dir:remote,progress:quiet});
  assert.deepEqual((await fs.readdir(remote)).sort(),['index.html','keep.txt'],'node_modules stays home');
  await fs.writeFile(path.join(remote,'index.html'),'v2 by agent');await fs.mkdir(path.join(remote,'css'));await fs.writeFile(path.join(remote,'css','a.css'),'body{}');await fs.rm(path.join(remote,'keep.txt'));
  const r=await rw.bringBackCopy({folder:local,host:null,dir:remote,backupRoot:backups,name:'site',progress:quiet});
  assert.deepEqual(r.changed,['index.html']);assert.deepEqual(r.added,[path.join('css','a.css')]);
  assert.equal(await fs.readFile(path.join(local,'index.html'),'utf8'),'v2 by agent');
  assert.equal(await fs.readFile(path.join(r.backup,'index.html'),'utf8'),'v1','the replaced version is backed up');
  assert.equal(await fs.readFile(path.join(local,'keep.txt'),'utf8'),'same','nothing is deleted locally');
});
test('only known change sets and safe branch names reach the terminal; links validate',()=>{
  assert.throws(()=>rw.applyCommands({ref:'refs/heads/main;rm -rf /',base:'abc1234'},'merge'),/Unknown change set/);
  assert.throws(()=>rw.applyCommands({ref:'refs/opaya/h/opaya/x',base:'abc1234'},'branch',{branch:'--force'}),/branch name/);
  assert.deepEqual(rw.applyCommands({ref:'refs/opaya/h/opaya/x',base:'abc1234'},'merge'),["git merge --no-edit 'refs/opaya/h/opaya/x'"]);
  assert.equal(projects.project({name:'x',path:'/r/x',hostId:'h1',link:{from:'p1',mode:'ftp'}}).link,null);
  assert.equal(projects.project({name:'x',path:'/r/x',hostId:'h1',link:{from:'p1',mode:'git',branch:'opaya/a',lastSent:'nothex!'}}).link.lastSent,'');
});
test('through a shared remote (GitHub): your branch is pushed, the machine clones it and the agent pushes its own branch',{skip},async t=>{
  const root=await temp(t),origin=path.join(root,'origin.git'),local=path.join(root,'local'),remote=path.join(root,'machine','app');
  const run=(c,cwd=root)=>execSync(c,{cwd,shell:'/bin/sh'}).toString().trim();
  run(`git init -q --bare -b main ${origin} && git clone -q ${origin} ${local}`);
  run('git config user.name me && git config user.email me@x',local);await fs.writeFile(path.join(local,'a.txt'),'1\n');run('git add . && git commit -qm one',local);
  // One commit is not on the remote yet: Opaya pushes it before the machine clones.
  await rw.sendGithub({folder:local,host:null,dir:remote,branch:'opaya/claude',base:'main',origin,first:true,progress:quiet});
  assert.equal(run('git rev-parse origin/main',local),run('git rev-parse HEAD',local),'your branch was pushed');
  assert.equal(run('git branch --show-current',remote),'opaya/claude');
  await fs.writeFile(path.join(remote,'b.txt'),'agent\n');
  const back=await rw.bringBackGithub({folder:local,host:null,dir:remote,branch:'opaya/claude',agentName:'Claude',base:run('git rev-parse HEAD',local),progress:quiet});
  assert.equal(back.pushedBranch,'opaya/claude');assert.deepEqual(back.files,['A\tb.txt']);assert.equal(back.canMerge,true);
  assert(run(`git ls-remote ${origin}`).includes('refs/heads/opaya/claude'),'the agent branch is on the shared remote, ready for a pull request');
});
// A stand-in `docker` on PATH: `exec [-i] [-w dir] <container> cmd...` runs cmd here; `inspect` reports one bind mount.
async function fakeDocker(t,root,mountDest){
  const bin=path.join(root,'bin');await fs.mkdir(bin,{recursive:true});
  await fs.writeFile(path.join(bin,'docker'),`#!/bin/sh\nif [ "$1" = inspect ]; then echo '[{"Type":"volume","Destination":"/var/lib","RW":true},{"Type":"bind","Source":"/srv/box","Destination":"${mountDest}","RW":true}]'; exit 0; fi\nshift\nwhile [ $# -gt 0 ]; do case "$1" in -i|-t|-it) shift;; -w|-e) shift 2;; *) break;; esac; done\nshift\nexec "$@"\n`,{mode:0o755});
  const old=process.env.PATH;process.env.PATH=`${bin}:${old}`;t.after(()=>{process.env.PATH=old;});
}
test('an agent in a container: its copy goes in the container\'s data folder, and git runs inside it',{skip},async t=>{
  const {root,local,sh}=await repo(t),data=path.join(root,'box-data');await fakeDocker(t,root,data);
  const dir=await rw.placement({host:null,container:'opaya-box',project:'My App',agent:'Box Hermes'});
  assert.equal(dir,`${data}/opaya-projects/my-app`,'in the bind mount, so it survives the container being recreated');
  const sent=await rw.sendGit({folder:local,host:null,container:'opaya-box',dir,branch:'opaya/box-hermes',first:true,progress:quiet});
  assert.equal(await fs.readFile(path.join(dir,'app.txt'),'utf8'),'hello\n');
  await fs.writeFile(path.join(dir,'app.txt'),'from the box\n');
  const back=await rw.bringBackGit({folder:local,host:null,container:'opaya-box',dir,branch:'opaya/box-hermes',agentName:'Box',base:sent.commit,progress:quiet});
  assert.equal(back.ref,'refs/opaya/opaya-box/opaya/box-hermes');assert.deepEqual(back.files,['M\tapp.txt']);
  // Plain copy into a container too.
  await rw.sendCopy({folder:local,host:null,container:'opaya-box',dir:path.join(data,'opaya-projects','plain'),progress:quiet});
  assert.equal(await fs.readFile(path.join(data,'opaya-projects','plain','app.txt'),'utf8'),'hello\n');
  await assert.rejects(()=>rw.removeCopy({host:null,container:'opaya-box',dir:data}),/only deletes copies it made/);
  await rw.removeCopy({host:null,container:'opaya-box',dir:path.join(data,'opaya-projects','plain')});
  await assert.rejects(()=>fs.access(path.join(data,'opaya-projects','plain')));
  assert.equal(sh('git status --porcelain'),'','your folder is untouched');
});
test('one project: remote agents are listed on it with their own copy, and chats open in that copy',()=>{
  const {inFolder}=require('../desktop/process.cjs');
  const p=projects.project({name:'app',path:'/home/me/app',agentIds:['a1'],remotes:[{agentId:'a4',hostId:'h1',container:'opaya-box',dir:'/opt/data/opaya-projects/app',mode:'git',branch:'opaya/box'},{agentId:'a9',mode:'git',branch:'x',dir:'relative'},{agentId:'a8',mode:'copy',dir:'/r/c',container:'bad name;rm'}]});
  assert.deepEqual(p.remotes.map(r=>r.agentId),['a4'],'invalid copies are dropped');
  assert.deepEqual(p.agentIds,['a1','a4'],'a shared agent is one of the project\'s agents');
  const box={id:'a4',command:'docker',transport:'ssh',hostId:'h1',args:['exec','-i','-w','/root','opaya-box','claude']},vps={id:'a3',command:'claude',transport:'ssh',hostId:'h1'};
  assert.equal(projects.fits(box,p),true);assert.equal(projects.folderFor(box,p),'/opt/data/opaya-projects/app');
  assert.equal(projects.needsCopy(vps,p),true);assert.equal(projects.needsCopy({id:'a1',command:'hermes',transport:'local'},p),false);
  assert.equal(projects.needsCopy({id:'d',protocol:'openai',transport:'http'},p),false,'API connections have no files');
  assert.deepEqual(inFolder(box,'/opt/data/opaya-projects/app').args,['exec','-i','-w','/opt/data/opaya-projects/app','opaya-box','claude']);
  assert.deepEqual(inFolder({...box,args:['exec','-i','opaya-h','hermes','acp']},'/x').args,['exec','-i','-w','/x','opaya-h','hermes','acp']);
  assert.equal(inFolder(vps,'/root/opaya-projects/app').cwd,'/root/opaya-projects/app');
  assert.equal(projects.project({name:'r',path:'/srv/r',hostId:'h1',remotes:p.remotes}).remotes.length,0,'only local projects are shared');
});
test('0.16.0 copies ("<name> on <machine>") fold into the local project, with their chats',async t=>{
  const {Broker}=require('../desktop/broker.cjs');const {Store,Vault}=require('../desktop/store.cjs');const {secure}=require('./helpers.cjs');
  const root=await temp(t),store=new Store(root),data=await store.load();
  data.hosts=[{id:'h1',name:'vps',hostname:'vps.example',port:22,username:'root'}];
  data.agents=[{id:'a3',name:'Claude',provider:'claude',protocol:'claude',transport:'ssh',hostId:'h1',command:'claude',args:[]}];
  data.projects=[{id:'p1',name:'app',path:'/home/me/app',hostId:'',agentIds:[]},{id:'p2',name:'app on vps',path:'/root/opaya-projects/app',hostId:'h1',agentIds:['a3'],link:{from:'p1',mode:'git',branch:'opaya/claude',base:'main',lastSent:'abc1234'}},{id:'p3',name:'orphan copy',path:'/root/x',hostId:'h1',agentIds:[],link:{from:'p1',mode:'copy'}}];
  data.conversations=[{id:'c1',agentId:'a3',title:'work',projectId:'p2',createdAt:new Date().toISOString()}];
  await store.write(data);
  const b=new Broker({store,vault:new Vault(root,secure()),emit:()=>{},approve:async()=>true});await b.init();t.after(()=>b.close());
  assert.deepEqual(b.data.projects.map(p=>p.id),['p1','p3'],'the copy with an agent is gone; one without stays a plain project');
  const p=b.project('p1');assert.deepEqual(p.agentIds,['a3']);
  assert.deepEqual({agentId:p.remotes[0].agentId,hostId:p.remotes[0].hostId,dir:p.remotes[0].dir,branch:p.remotes[0].branch,lastSent:p.remotes[0].lastSent},{agentId:'a3',hostId:'h1',dir:'/root/opaya-projects/app',branch:'opaya/claude',lastSent:'abc1234'});
  assert.equal(b.data.conversations[0].projectId,'p1');
  assert.equal(b.conversationCwd(b.data.conversations[0],b.agent('a3')),'/root/opaya-projects/app');
  assert.equal(b.project('p3').link,null);
  // Removing the agent removes its copy from the project too.
  await b.removeAgent('a3');assert.deepEqual(b.project('p1').remotes,[]);
});
