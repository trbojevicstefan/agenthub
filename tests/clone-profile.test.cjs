'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const profiles=require('../desktop/profiles.cjs');const maintenance=require('../desktop/maintenance.cjs');const {place,execHome}=require('../desktop/clone.cjs');const schema=require('../desktop/schema.cjs');
const hermesBox={id:'h1',name:'Hermes box',provider:'hermes',protocol:'acp',transport:'ssh',hostId:'vps',command:'docker',args:['exec','-i','opaya-hermes','hermes'],hermesHome:'/opt/data'};
const codexBox={id:'c1',name:'Codex box',provider:'codex',protocol:'codex',transport:'ssh',hostId:'vps',command:'docker',args:['exec','-i','-w','/root','opaya-codex','codex'],cwd:'/root'};
const clawBox={id:'o1',name:'Claw box',provider:'openclaw',protocol:'openai',transport:'ssh',hostId:'vps',endpoint:'http://127.0.0.1:18801/v1',model:'openclaw',command:'docker',args:['exec','-i','opaya-claw','openclaw'],cwd:''};
test('a Hermes clone becomes a profile in the container\'s Hermes home, also next to another profile',()=>{
  const p=profiles.plan({from:'hermes',into:hermesBox,name:'Work Bot'});
  assert.equal(p.dir,'/opt/data/profiles/work-bot');assert.equal(p.container,'opaya-hermes');
  assert.deepEqual(p.connection,{provider:'hermes',protocol:'acp',command:'docker',args:['exec','-i','opaya-hermes','hermes'],hermesHome:'/opt/data/profiles/work-bot',cwd:''});
  assert.equal(profiles.plan({from:'hermes',into:{...hermesBox,hermesHome:'/opt/data/profiles/other'},name:'x'}).dir,'/opt/data/profiles/x');
  // Opaya starts it with HERMES_HOME (and HOME) set to the profile inside the container.
  const {dockerExecArgs}=require('../desktop/process.cjs');
  assert.deepEqual(dockerExecArgs(p.connection,p.connection.args),['exec','-i','-e','HOME=/opt/data/profiles/work-bot','-e','HERMES_HOME=/opt/data/profiles/work-bot','-w','/opt/data/profiles/work-bot','opaya-hermes','hermes']);
});
test('npm CLIs get their own home folder in an Opaya Node.js container, installed there when missing',()=>{
  const p=profiles.plan({from:'claude',into:codexBox,name:'reviewer',home:'/root'});
  assert.equal(p.dir,'/root/opaya-profiles/reviewer');
  assert.deepEqual(p.connection.args,['exec','-i','-e','HOME=/root/opaya-profiles/reviewer','-w','/root/opaya-profiles/reviewer','opaya-codex','claude']);
  assert.match(p.check,/command -v claude .*\|\| npm install -g @anthropic-ai\/claude-code@latest/);
  // Files for this agent (skills, keys, backups) are read in its own home folder.
  const where=place({agent:{...p.connection,transport:'ssh'},host:{id:'vps'}});assert.equal(where.home,'/root/opaya-profiles/reviewer');assert.equal(where.container,'opaya-codex');
  assert.equal(execHome(['exec','-i','--env=HOME=/x/y','c','claude']),'/x/y');assert.equal(execHome(['exec','-i','c','claude','-e','HOME=/no']),'');
  assert.equal(profiles.plan({from:'opencode',into:codexBox,name:'oc'}).connection.args.slice(-3).join(' '),'opaya-codex opencode acp');
});
test('an OpenClaw clone joins the same gateway as another agent, reached as openclaw/<name>',()=>{
  const p=profiles.plan({from:'openclaw',into:clawBox,name:'research',state:'/home/node/.openclaw'});
  assert.equal(p.dir,'/home/node/.openclaw/workspace-research');
  assert.equal(p.finish,"openclaw agents add 'research' --workspace '/home/node/.openclaw/workspace-research' --non-interactive --json");
  assert.equal(p.connection.model,'openclaw/research');assert.equal(p.connection.endpoint,clawBox.endpoint);assert.deepEqual(p.connection.args,clawBox.args);
  assert.throws(()=>profiles.plan({from:'openclaw',into:clawBox,name:'main'}),/OpenClaw's own/);
});
test('frameworks never move into another framework\'s image, and the reason is said',()=>{
  assert.match(profiles.fit('hermes','codex'),/Hermes/);assert.match(profiles.fit('claude','hermes'),/Node\.js containers/);
  assert.match(profiles.fit('goose','claude'),/cannot live as a profile/);assert.equal(profiles.fit('codex','claude'),'');
  assert.throws(()=>profiles.plan({from:'hermes',into:codexBox,name:'x'}),/needs a container that runs Hermes/);
  assert.throws(()=>profiles.plan({from:'claude',into:codexBox,name:'!!'}),/letters or numbers/);
  // One entry per machine and container, named after the agent that runs it rather than a profile in it.
  const profile={...codexBox,id:'c2',name:'p',clone:{runtime:'profile'}};
  assert.deepEqual(profiles.targets([profile,codexBox,{id:'l',name:'local',provider:'claude',protocol:'claude',transport:'local',command:'claude',args:[]}]),[{hostId:'vps',container:'opaya-codex',framework:'codex',agentId:'c1',agentName:'Codex box'}]);
});
test('a profile in a container is removed alone and updated with its container',()=>{
  const agent=schema.agent({name:'reviewer',provider:'claude',protocol:'claude',transport:'ssh',hostId:'vps',command:'docker',args:['exec','-i','-e','HOME=/root/opaya-profiles/reviewer','-w','/root/opaya-profiles/reviewer','opaya-codex','claude'],cwd:'/root/opaya-profiles/reviewer',
    clone:{from:'c1',framework:'claude',scope:'everything',keys:true,runtime:'profile',dir:'/root/opaya-profiles/reviewer',container:'opaya-codex',profile:'reviewer'}});
  assert.equal(agent.clone.profile,'reviewer');assert.equal(agent.clone.runtime,'profile');
  const k=maintenance.kindOf(agent);assert.equal(k.kind,'container-profile');assert.equal(k.container,'opaya-codex');
  const u=maintenance.uninstallCommand(agent,{remote:true});
  assert.match(u.preview,/docker exec 'opaya-codex' sh -c 'rm -rf '\\''\/root\/opaya-profiles\/reviewer'\\'''/);assert.doesNotMatch(u.preview,/docker rm/);
  assert.throws(()=>maintenance.updateCommand(agent,{remote:true}),/Update the agent that runs the container/);
  assert.equal(maintenance.capabilities(agent).update,false);assert.deepEqual(maintenance.sharing(agent,[agent,codexBox]),[]);
  const claw={...agent,clone:{...agent.clone,framework:'openclaw',dir:'/home/node/.openclaw/workspace-research',container:'opaya-claw',profile:'research'}};
  assert.match(profiles.removeCommand(claw),/openclaw agents delete '\\''research'\\'' --force/);
  assert.throws(()=>profiles.removeCommand({...agent,clone:{...agent.clone,dir:'/root'}}),/not a profile/);
  assert.throws(()=>profiles.removeCommand({...agent,clone:{...agent.clone,dir:'/root/../etc'}}),/not a profile/);
});
