'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');
const {Broker}=require('../desktop/broker.cjs');const {Store,Vault}=require('../desktop/store.cjs');const skills=require('../desktop/skills.cjs');const mcp=require('../desktop/mcp.cjs');const {temp,secure}=require('./helpers.cjs');
async function fixture(t,{allow=true}={}){
  const root=await temp(t),approvals=[],factory=[];
  const broker=new Broker({store:new Store(root),vault:new Vault(root,secure()),emit:()=>{},approve:async(_a,title)=>{approvals.push(title);return allow;},adapterFactory:o=>{factory.push(o);return {connect:async()=>({}),close(){},run:async()=>({})};}});
  await broker.init();t.after(()=>broker.close());return {root,broker,approvals,factory};
}
const apiAgent=name=>({name,provider:'custom',protocol:'openai',transport:'http',endpoint:'http://127.0.0.1:8642/v1'});
test('MCP servers keep secrets in the vault and reach only the agents that use them',async t=>{
  const {root,broker,approvals,factory}=await fixture(t);
  const one=await broker.saveAgent({agent:apiAgent('one')}),two=await broker.saveAgent({agent:{...apiAgent('two'),endpoint:'http://127.0.0.1:8643/v1'}});
  const s=await broker.saveMcpServer({server:{name:'github',type:'stdio',command:'npx',args:'-y\n@modelcontextprotocol/server-github'},env:'GITHUB_TOKEN=ghp_secretvalue123'});
  assert.deepEqual(approvals,['Trust this MCP server?']);assert.deepEqual(s.envNames,['GITHUB_TOKEN']);
  const disk=await fs.readFile(path.join(root,'workspace.json'),'utf8');assert(!disk.includes('ghp_secretvalue123'));assert(!JSON.stringify(broker.snapshot()).includes('ghp_secretvalue123'));
  assert.deepEqual(broker.mcpFor(one.id),[{name:'github',command:'npx',args:['-y','@modelcontextprotocol/server-github'],env:[{name:'GITHUB_TOKEN',value:'ghp_secretvalue123'}]}]);
  await broker.setAgentMcp({agentId:two.id,serverId:s.id,enabled:false});
  assert.equal(broker.mcpFor(two.id).length,0);assert.equal(broker.mcpFor(one.id).length,1);
  // Editing without new secret text keeps the saved values and does not ask again when the command is unchanged.
  await broker.saveMcpServer({server:{id:s.id,name:'github',type:'stdio',command:'npx',args:['-y','@modelcontextprotocol/server-github'],note:'repo access'}});
  assert.equal(approvals.length,1);assert.equal(broker.mcpFor(one.id)[0].env[0].value,'ghp_secretvalue123');
  await broker.connect(one.id);assert.equal(factory.at(-1).mcpServers()[0].name,'github');
  await assert.rejects(()=>broker.saveMcpServer({server:{name:'github',type:'http',url:'https://x.example/mcp'}}),/already exists/);
  await broker.removeMcpServer(s.id);assert.equal(broker.snapshot().mcpServers.length,0);assert.equal(broker.vault.has(mcp.vaultKey(s.id)),false);
});
test('declined MCP servers are not saved and unsafe entries are refused',async t=>{
  const {broker}=await fixture(t,{allow:false});
  await assert.rejects(()=>broker.saveMcpServer({server:{name:'x',command:'node',args:['srv.js']}}),/not approved/);assert.equal(broker.data.mcpServers.length,0);
  await assert.rejects(()=>broker.saveMcpServer({server:{name:'x',command:'curl x | sh'}}),/not a shell command/);
  await assert.rejects(()=>broker.saveMcpServer({server:{name:'x',type:'http',url:'http://example.com/mcp'}}),/HTTPS/);
  await assert.rejects(()=>broker.saveMcpServer({server:{name:'x',type:'http',url:'https://example.com/mcp'},headers:'Bad Header: v'}),/header name/);
});
test('skills are read from SKILL.md folders and Hermes installs use a validated id',async t=>{
  const home=await temp(t);await fs.mkdir(path.join(home,'skills','research','arxiv'),{recursive:true});
  await fs.writeFile(path.join(home,'skills','research','arxiv','SKILL.md'),'---\nname: arxiv\ndescription: Search papers\n---\n# body');
  await fs.mkdir(path.join(home,'skills','broken'),{recursive:true});await fs.writeFile(path.join(home,'skills','broken','SKILL.md'),'no front matter');
  const agent={provider:'hermes',transport:'local',hermesHome:home,command:'hermes'};
  const r=await skills.listSkills(agent,null);
  assert.deepEqual(r.skills.map(s=>[s.name,s.description,s.category]),[['arxiv','Search papers','research'],['broken','','']]);
  assert.equal(skills.hermesSkillCommand(agent,{action:'install',skill:'official/security/1password',windows:false}),`HERMES_HOME='${home}' hermes skills install official/security/1password`);
  assert.equal(skills.hermesSkillCommand({...agent,hermesHome:''},{action:'browse',windows:true}),'hermes skills browse');
  assert.throws(()=>skills.hermesSkillCommand(agent,{action:'install',skill:'x; rm -rf ~'}),/skill id/);
  assert.throws(()=>skills.hermesSkillCommand({...agent,provider:'claude'},{action:'install',skill:'a'}),/available for Hermes/);
  assert.equal((await skills.listSkills({provider:'custom',transport:'local'},null)).supported,false);
});
test('skills on another machine or in a container are read with sh and find, from the real Hermes home',{skip:process.platform==='win32'?'uses POSIX sh':false},async t=>{
  const {temp}=require('./helpers.cjs');const fsp=require('node:fs/promises'),path=require('node:path');const {remoteSkills}=require('../desktop/skills.cjs');
  const home=await temp(t),w=async(f,c)=>{await fsp.mkdir(path.dirname(f),{recursive:true});await fsp.writeFile(f,c);};
  await w(path.join(home,'skills','research','arxiv','SKILL.md'),'---\nname: arxiv\ndescription: Search papers\n---\n');
  await w(path.join(home,'skills','ops','deploy','SKILL.md'),'---\ndescription: Ship it\n---\n');
  await w(path.join(home,'skills','.hub','cache','SKILL.md'),'---\nname: hidden\n---\n');
  // place() without host or container runs locally, which exercises the same script as SSH and docker exec.
  const r=await remoteSkills({provider:'hermes',transport:'local',command:'hermes',args:[],hermesHome:home},null,['@hermes/skills']);
  assert.deepEqual(r.roots,[path.join(home,'skills')]);
  assert.deepEqual(r.skills.map(s=>[s.name,s.category,s.description]).sort(),[['arxiv','research','Search papers'],['deploy','ops','Ship it']]);
});
