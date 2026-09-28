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
// Keys land where each agent reads them; the environment variables that move those places are cleared for the test.
function cleanEnv(t){const saved={};for(const k of ['CLAUDE_CONFIG_DIR','CODEX_HOME','XDG_DATA_HOME','OPENCLAW_STATE_DIR']){saved[k]=process.env[k];delete process.env[k];}t.after(()=>{for(const [k,v] of Object.entries(saved))if(v!==undefined)process.env[k]=v;});}
test('API keys merge into the target .env by name, private, and only key-like names are offered',{skip},async t=>{
  const {b,src,dst}=await fixture(t);const {transferEnv,envKeys}=require('../desktop/transfer.cjs');
  assert.deepEqual(await envKeys(src),[{name:'OPENAI_API_KEY',from:'.env'},{name:'SLACK_BOT_TOKEN',from:'.env'}]);
  const r=await transferEnv({source:src,target:dst,keys:['OPENAI_API_KEY','SLACK_BOT_TOKEN','BAD KEY']});
  assert.deepEqual(r.keys,['OPENAI_API_KEY','SLACK_BOT_TOKEN']);
  assert.equal(await fs.readFile(path.join(b,'.env'),'utf8'),'OPENAI_API_KEY=sk-a\nKEEP=me\nSLACK_BOT_TOKEN=xoxb-a\n');
  assert.equal((await fs.stat(path.join(b,'.env'))).mode&0o777,0o600);
  await assert.rejects(()=>transferEnv({source:src,target:dst,keys:['MISSING']}),/No matching/);
});
test('API keys move from any agent to any agent, each to where the target reads it',{skip},async t=>{
  cleanEnv(t);const {root,src,claude}=await fixture(t);const {transferKeys,envKeys,readKeys}=require('../desktop/transfer.cjs');const {EventEmitter}=require('node:events');const {PassThrough}=require('node:stream');
  const opencode={id:'o',name:'opencode',provider:'custom',protocol:'acp',transport:'local',command:'opencode',args:['acp']};
  const codex={id:'x',name:'codex',provider:'codex',protocol:'codex',transport:'local',command:'codex',args:['app-server']};
  const openclaw={id:'w',name:'claw',provider:'openclaw',protocol:'openai',transport:'http',endpoint:'http://127.0.0.1:18789/v1',command:'openclaw',args:[]};
  const api={id:'p',name:'openai api',provider:'custom',protocol:'openai',transport:'http',endpoint:'https://api.openai.com/v1'};
  const vaultData=new Map(),vault={get:id=>vaultData.get(id),set:async(id,v)=>{vaultData.set(id,v);},has:id=>vaultData.has(id)};
  // Hermes -> Claude Code: settings.json env, other settings kept.
  await write(path.join(root,'.claude/settings.json'),'{"model":"opus"}');
  const c=await transferKeys({source:src,target:claude,keys:'all'});assert.deepEqual(c.keys,['OPENAI_API_KEY','SLACK_BOT_TOKEN']);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root,'.claude/settings.json'),'utf8')),{model:'opus',env:{OPENAI_API_KEY:'sk-a',SLACK_BOT_TOKEN:'xoxb-a'}});
  // Hermes -> OpenCode: provider entries in auth.json; a key OpenCode has no provider for is left out and reported.
  const o=await transferKeys({source:src,target:opencode,keys:'all'});
  assert.deepEqual(o.keys,['OPENAI_API_KEY']);assert.deepEqual(o.skipped,[{name:'SLACK_BOT_TOKEN',why:'OpenCode has no provider for this key'}]);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root,'.local/share/opencode/auth.json'),'utf8')),{openai:{type:'api',key:'sk-a'}});
  assert.deepEqual(await envKeys(opencode),[{name:'OPENAI_API_KEY',from:'auth.json'}]);
  // OpenCode -> OpenClaw: its .env, quoted when needed. Claude Code -> an API connection: the token in the vault.
  await transferKeys({source:opencode,target:openclaw,keys:['OPENAI_API_KEY']});
  assert.equal(await fs.readFile(path.join(root,'.openclaw/.env'),'utf8'),'OPENAI_API_KEY=sk-a\n');
  const p=await transferKeys({source:claude,target:api,keys:'all',vault});assert.deepEqual(p.keys,['OPENAI_API_KEY']);assert.equal(vaultData.get('p'),'sk-a');
  assert.deepEqual([...(await readKeys(api,null,{vault})).values.keys()],['OPENAI_API_KEY']);
  // -> Codex: codex login --with-api-key with the key on its input, never on the command line.
  const calls=[];const launch=(agent,args)=>{const child=new EventEmitter();Object.assign(child,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough()});let input='';child.stdin.on('data',d=>{input+=d;});child.stdin.on('finish',()=>{calls.push({command:agent.command,args,input});setImmediate(()=>child.emit('close',0));});return child;};
  // Other keys go into Codex's .env, which Opaya loads into the Codex it starts.
  const x=await transferKeys({source:src,target:codex,keys:'all',launch});assert.deepEqual(x.keys,['OPENAI_API_KEY','SLACK_BOT_TOKEN']);
  assert.deepEqual(calls,[{command:'codex',args:['login','--with-api-key'],input:'sk-a\n'}]);assert(!JSON.stringify(x).includes('sk-a'));
  assert.match(await fs.readFile(path.join(root,'.codex','.env'),'utf8'),/^SLACK_BOT_TOKEN=/m);
  assert.deepEqual((await envKeys(codex)).map(k=>k.name).sort(),['SLACK_BOT_TOKEN']);
  await assert.rejects(()=>transferKeys({source:src,target:{id:'z',name:'aider',provider:'custom',protocol:'terminal',transport:'local',command:'aider',args:[]}}),/does not know where aider/);
});
test('key plans map provider keys to each kind of agent',()=>{
  const {planKeys,keyKind,endpointKey}=require('../desktop/transfer.cjs');
  assert.deepEqual(planKeys('opencode',['GOOGLE_API_KEY','GROQ_API_KEY']).map(p=>p.provider),['google','groq']);
  assert.deepEqual(planKeys('token',['ANTHROPIC_API_KEY','OPENAI_API_KEY'],{endpoint:'https://openrouter.ai/api/v1'}).map(p=>p.why),['This connection takes OPENROUTER_API_KEY','This connection takes OPENROUTER_API_KEY']);
  assert.equal(planKeys('token',['X_API_KEY'],{endpoint:'http://127.0.0.1:1234/v1'})[0].to,'its connection token (Opaya vault)');
  assert.equal(planKeys('claude',['DEEPSEEK_API_KEY'])[0].to,'settings.json env DEEPSEEK_API_KEY');
  assert.equal(endpointKey('https://generativelanguage.googleapis.com/v1beta/openai'),'GEMINI_API_KEY');
  assert.equal(keyKind({provider:'hermes',protocol:'openai',transport:'http',endpoint:'http://127.0.0.1:8642/v1'}),'hermes');
  assert.equal(keyKind({provider:'custom',protocol:'acp',command:'docker',args:['exec','-i','-e','HOME=/root/p','-w','/root/p','opaya-x','opencode','acp']}),'opencode');
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
