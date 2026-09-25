'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');const {execFileSync}=require('node:child_process');
const {temp}=require('./helpers.cjs');
const versions=require('../desktop/versions.cjs');const {visionOf}=require('../desktop/vision.cjs');
const skip=process.platform==='win32'?'uses POSIX shell scripts as fake CLIs':false;

test('version parsing and comparison',()=>{
  assert.deepEqual(versions.parse('codex-cli 0.157.0'),[0,157,0]);
  assert.deepEqual(versions.parse('2.1.0 (Claude Code)'),[2,1,0]);
  assert.deepEqual(versions.parse('OpenSSH_9.6p1, OpenSSL 3.0.13'),[9,6,0]);
  assert.deepEqual(versions.parse('v22.11.0'),[22,11,0]);
  assert.equal(versions.parse('not installed'),null);
  assert.equal(versions.compare([0,150,0],[0,157,0]),-1);assert.equal(versions.compare([1,2,0],[1,2,0]),0);assert.equal(versions.compare([2,0,0],[1,9,9]),1);
});
test('the machine script is valid sh and PowerShell-shaped',{skip},()=>{
  execFileSync('sh',['-n','-c',versions.script({windows:false})]);
  const ps=versions.script({windows:true});assert.match(ps,/Get-Command codex/);assert(!ps.includes('tmux'),'no tmux on Windows');
});
test('"too old" connection errors say what to update',()=>{
  assert.equal(versions.fixTarget("error: unrecognized subcommand 'app-server'"),'agent');
  assert.equal(versions.fixTarget('Unknown argument: acp'),'agent');
  assert.equal(versions.fixTarget('This version of Claude Code is no longer supported. Please update.'),'agent');
  assert.equal(versions.fixTarget('Codex requires Node.js >= 20. You are running 18.2'),'node');
  assert.equal(versions.fixTarget('Python 3.11 or newer is required'),'python');
  for(const e of ['ECONNREFUSED 127.0.0.1:8642','Invalid API key','Host key verification failed'])assert.equal(versions.fixTarget(e),null,e);
});
test('a machine report lists installed tools and marks the outdated ones',{skip},async t=>{
  const home=await temp(t),bin=path.join(home,'.local','bin');await fs.mkdir(bin,{recursive:true});
  const cli=async(name,out)=>fs.writeFile(path.join(bin,name),`#!/bin/sh\necho "${out}"\n`,{mode:0o755});
  await cli('codex','codex-cli 0.150.0');await cli('gemini','0.61.0');await cli('ollama','Warning: could not connect to a running Ollama instance\nollama version is 0.12.1');
  const env={HOME:process.env.HOME,PATH:process.env.PATH};process.env.HOME=home;process.env.PATH=`${bin}:/usr/bin:/bin`;t.after(()=>Object.assign(process.env,env));
  versions.cache.clear();
  const latest={'@openai%2Fcodex':'0.157.0','@google%2Fgemini-cli':'0.61.0'};
  const fetchImpl=async url=>{const npm=/registry\.npmjs\.org\/(.+)\/latest/.exec(url);if(npm&&latest[npm[1]])return {ok:true,json:async()=>({version:latest[npm[1]]})};if(url.includes('ollama/ollama'))return {ok:true,json:async()=>({tag_name:'v0.13.0'})};return {ok:false,status:404,json:async()=>({})};};
  const found=Object.fromEntries((await versions.check(null,{fetchImpl})).items.map(i=>[i.id,i]));
  assert.deepEqual([found.codex.installed,found.codex.latest,found.codex.outdated],['0.150.0','0.157.0',true]);
  assert.deepEqual([found['gemini-cli'].installed,found['gemini-cli'].outdated],['0.61.0',false]);
  assert.deepEqual([found.ollama.installed,found.ollama.latest,found.ollama.outdated],['0.12.1','0.13.0',true],'a warning line before the version is skipped');
  assert(!found.opencode,'tools that are not installed are not listed');
});
test('the Opaya browser is only for models that can see images',()=>{
  assert.equal(visionOf({provider:'claude',command:'claude'}).vision,true);
  assert.equal(visionOf({provider:'custom',command:'/usr/local/bin/gemini'}).vision,true);
  assert.equal(visionOf({provider:'hermes',model:'anthropic/claude-sonnet-4.6'}).vision,true);
  assert.equal(visionOf({provider:'hermes',activeModel:'deepseek-v4-pro'}).vision,false);
  for(const m of ['qwen3:4b','openai/gpt-oss-120b','codestral-latest','llama3.2:3b'])assert.equal(visionOf({provider:'ollama',model:m}).vision,false,m);
  for(const m of ['qwen2.5vl:7b','llama3.2-vision','gpt-5.6-sol','grok-4.7','gemini-3.8-flash','z-ai/glm-4.5v'])assert.equal(visionOf({provider:'openrouter',model:m}).vision,true,m);
  assert.equal(visionOf({provider:'hermes'}).vision,null,'an unknown model is unknown, not denied');
});
test('broker refuses the browser for a text-only model and leaves it out of the MCP list',async t=>{
  const {Broker}=require('../desktop/broker.cjs');const {Store,Vault}=require('../desktop/store.cjs');const {secure}=require('./helpers.cjs');
  const root=await temp(t),b=new Broker({store:new Store(root),vault:new Vault(root,secure()),emit:()=>{},approve:async()=>true});await b.init();
  b.browserBridge={command:'node',args:['bridge.cjs'],env:{}};
  const text=await b.saveAgent({agent:{name:'Deep',provider:'custom',protocol:'acp',transport:'local',command:'hermes',args:[],model:'deepseek-v4-pro'}});
  await assert.rejects(()=>b.updateAgentDisplay({id:text.id,browser:true}),/cannot use the Opaya browser/);
  const seeing=await b.saveAgent({agent:{name:'Claude',provider:'claude',protocol:'claude',transport:'local',command:'claude',args:[]}});
  await b.updateAgentDisplay({id:seeing.id,browser:true});
  assert(b.mcpFor(seeing.id).some(s=>s.name==='opaya-browser'));
  // The model changed to a text-only one after the browser was given: it is left out.
  const i=b.data.agents.findIndex(a=>a.id===seeing.id);b.data.agents[i]={...b.data.agents[i],model:'qwen3:4b'};
  assert(!b.mcpFor(seeing.id).some(s=>s.name==='opaya-browser'));
  await b.close();
});
