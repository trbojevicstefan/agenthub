'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');
const {temp}=require('./helpers.cjs');
const skip=process.platform==='win32'?'uses POSIX tar':false;
const write=async(file,text)=>{await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,text);};
const skill=(name,desc='')=>`---\nname: ${name}\ndescription: ${desc||name}\n---\nBody of ${name}`;
async function fixture(t){
  const root=await temp(t),a=path.join(root,'hermes-a'),b=path.join(root,'hermes-b');
  await write(path.join(a,'config.yaml'),'model: x');await write(path.join(b,'config.yaml'),'model: y');
  await write(path.join(a,'skills/research/arxiv/SKILL.md'),skill('arxiv'));await write(path.join(a,'skills/research/arxiv/scripts/run.sh'),'echo hi');
  await write(path.join(a,'skills/devops/deploy/SKILL.md'),skill('deploy'));
  await write(path.join(a,'.env'),'OPENAI_API_KEY=sk-a\nexport SLACK_BOT_TOKEN=xoxb-a\n# comment\nOTHER=1\n');
  await write(path.join(b,'.env'),'OPENAI_API_KEY=old\nKEEP=me\n');
  const home=process.env.HOME;process.env.HOME=root;t.after(()=>{if(home===undefined)delete process.env.HOME;else process.env.HOME=home;});
  const hermes=(id,home)=>({id,name:id,provider:'hermes',protocol:'acp',transport:'local',command:'hermes',args:[],hermesHome:home});
  return {root,a,b,src:hermes('tuco',a),dst:hermes('hector',b),claude:{id:'c',name:'claude',provider:'claude',protocol:'claude',transport:'local',command:'claude',args:[]}};
}
test('skills move between agents, all or selected, and across providers',{skip},async t=>{
  const {root,b,src,dst,claude}=await fixture(t);const {transferSkills}=require('../desktop/transfer.cjs');const events=[];
  const one=await transferSkills({source:src,target:dst,names:['arxiv'],progress:e=>events.push(e)});
  assert.deepEqual(one.skills,['arxiv']);
  assert.equal(await fs.readFile(path.join(b,'skills/arxiv/scripts/run.sh'),'utf8'),'echo hi');
  await assert.rejects(fs.access(path.join(b,'skills/deploy/SKILL.md')));
  assert.deepEqual([...new Set(events.filter(e=>e.state==='done').map(e=>e.step))],['source','target','copy']);
  const all=await transferSkills({source:src,target:claude,names:'all'});
  assert.deepEqual(all.skills.sort(),['arxiv','deploy']);
  assert.match(await fs.readFile(path.join(root,'.claude/skills/deploy/SKILL.md'),'utf8'),/name: deploy/);
  await assert.rejects(()=>transferSkills({source:src,target:dst,names:['nope']}),/No matching skills/);
});
test('API keys merge into the target .env by name, private, Hermes only',{skip},async t=>{
  const {b,src,dst,claude}=await fixture(t);const {transferEnv,envKeys}=require('../desktop/transfer.cjs');
  assert.deepEqual(await envKeys(src),['OPENAI_API_KEY','SLACK_BOT_TOKEN','OTHER']);assert.deepEqual(await envKeys(claude),[]);
  const r=await transferEnv({source:src,target:dst,keys:['OPENAI_API_KEY','SLACK_BOT_TOKEN','BAD KEY']});
  assert.deepEqual(r.keys,['OPENAI_API_KEY','SLACK_BOT_TOKEN']);
  assert.equal(await fs.readFile(path.join(b,'.env'),'utf8'),'OPENAI_API_KEY=sk-a\nKEEP=me\nSLACK_BOT_TOKEN=xoxb-a\n');
  assert.equal((await fs.stat(path.join(b,'.env'))).mode&0o777,0o600);
  await assert.rejects(()=>transferEnv({source:src,target:claude,keys:'all'}),/Hermes/);
  await assert.rejects(()=>transferEnv({source:src,target:dst,keys:['MISSING']}),/No matching/);
});
test('the skills library imports from agents and folders, installs anywhere and removes',{skip},async t=>{
  const {root,b,src,dst,claude}=await fixture(t);const {SkillLibrary}=require('../desktop/transfer.cjs');const lib=new SkillLibrary(path.join(root,'opaya'));
  assert.deepEqual(await lib.list(),[]);
  await lib.importFrom({agent:src,names:['deploy']});
  const extra=path.join(root,'extra');await write(path.join(extra,'writing/tone/SKILL.md'),skill('tone','Write well'));
  assert.deepEqual((await lib.addFolder(extra)).skills,['tone']);
  await assert.rejects(()=>lib.addFolder(path.join(root,'hermes-b')),/SKILL\.md/);
  assert.deepEqual((await lib.list()).map(s=>[s.name,s.description]),[['deploy','deploy'],['tone','Write well']]);
  const r=await lib.installTo({agents:[{agent:dst},{agent:claude}],names:['tone']});assert.deepEqual(r.agents,['hector','claude']);
  await fs.access(path.join(b,'skills/tone/SKILL.md'));await fs.access(path.join(root,'.claude/skills/tone/SKILL.md'));
  await lib.remove('tone');assert.deepEqual((await lib.list()).map(s=>s.name),['deploy']);
  await assert.rejects(()=>lib.remove('tone'),/not found/);
});
