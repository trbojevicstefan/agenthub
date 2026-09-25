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
