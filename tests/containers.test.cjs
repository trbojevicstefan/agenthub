'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');const {spawnSync}=require('node:child_process');
const {temp}=require('./helpers.cjs');const containers=require('../desktop/containers.cjs');const catalog=require('../desktop/catalog.cjs');
const skip=process.platform==='win32'?'runs the POSIX install script':false;
// A fake docker that logs its arguments; `inspect` fails unless the container "exists".
async function fakeDocker(dir,{info=true,exists=false}={}){
  await fs.mkdir(dir,{recursive:true});
  await fs.writeFile(path.join(dir,'docker'),`#!/bin/sh\necho "$*" >> "${path.join(dir,'calls.log')}"\ncase "$1" in info) ${info?'exit 0':'exit 1'};; inspect) ${exists?'exit 0':'exit 1'};; esac\nexit 0\n`,{mode:0o755});
}
const runPlan=(plan,home,bin,withDocker=true)=>spawnSync('sh',['-c',plan.command],{env:{HOME:home,PATH:withDocker?`${bin}:/usr/bin:/bin`:'/usr/bin:/bin'},encoding:'utf8',input:''});
test('agents that can be installed as a container, and their connections',()=>{
  assert.deepEqual(catalog.list().filter(f=>f.docker).map(f=>f.id).sort(),['claude','codex','gemini-cli','hermes','opencode']);
  const codex=containers.plan('codex',{name:'Work Bot'});
  assert.equal(codex.container,'opaya-work-bot');
  assert.deepEqual(codex.connection,{name:'Codex CLI (Docker)',transport:'ssh',tags:['docker'],provider:'codex',protocol:'codex',command:'docker',args:['exec','-i','-w','/root','opaya-work-bot','codex'],cwd:'/root'});
  assert.deepEqual(containers.plan('hermes',{name:'h'}).connection.args,['exec','-i','opaya-h','hermes']);
  assert.equal(containers.plan('hermes',{name:'h'}).connection.hermesHome,'/opt/data');
  assert.throws(()=>containers.plan('goose'),/no Docker install/);
  assert.throws(()=>containers.plan('codex',{name:'!!!'}),/letters or numbers/);
  // Only quoted, validated values reach the script.
  assert(!containers.plan('codex',{name:"x'; rm -rf / #"}).command.includes("rm -rf / #'"));
});
test('the install script stops clearly without Docker or without permission',{skip},async t=>{
  const home=await temp(t),bin=path.join(home,'bin'),plan=containers.plan('codex',{name:'work'});
  if(spawnSync('sh',['-c','command -v docker'],{env:{PATH:'/usr/bin:/bin'}}).status!==0)assert.equal(runPlan(plan,home,bin,false).status,3);
  await fakeDocker(bin,{info:false});
  assert.equal(runPlan(plan,home,bin).status,4);
  assert.match(containers.EXIT[3],/Docker is not installed/);assert.match(containers.EXIT[4],/usermod -aG docker/);
});
test('the install script pulls, starts, installs and signs in, and reuses an existing container',{skip},async t=>{
  const home=await temp(t),bin=path.join(home,'bin');await fakeDocker(bin);
  const plan=containers.plan('codex',{name:'work'}),r=runPlan(plan,home,bin);
  assert.equal(r.status,0,r.stderr+r.stdout);
  const calls=(await fs.readFile(path.join(bin,'calls.log'),'utf8')).trim().split('\n');
  assert.deepEqual(calls.map(c=>c.split(' ')[0]),['info','inspect','image','run','exec','exec'],'an image already on the machine is not pulled again');
  assert.match(calls[3],new RegExp(`run -d --name opaya-work --restart unless-stopped -v ${home}/opaya-agents/work:/root -w /root node:22-bookworm sleep infinity`));
  assert.match(calls[4],/exec opaya-work npm install -g @openai\/codex@latest/);
  assert.match(calls[5],/exec -e HOME=\/root -i opaya-work sh -c codex login --device-auth/);assert(!/\|\| codex login( |$)/.test(calls[5]),'no browser login on a server');
  await fs.stat(path.join(home,'opaya-agents','work'));
  const again=path.join(home,'again');await fakeDocker(again,{exists:true});
  runPlan(containers.plan('hermes',{name:'h'}),home,again);
  const second=(await fs.readFile(path.join(again,'calls.log'),'utf8')).trim().split('\n').map(c=>c.split(' ')[0]);
  assert.deepEqual(second,['info','inspect','start','exec'],'an existing container is started, not pulled or created again');
});
