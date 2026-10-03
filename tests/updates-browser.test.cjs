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
  await cli('codex','codex-cli 0.150.0');await cli('opencode','0.61.0');await cli('ollama','Warning: could not connect to a running Ollama instance\nollama version is 0.12.1');
  const env={HOME:process.env.HOME,PATH:process.env.PATH};process.env.HOME=home;process.env.PATH=`${bin}:/usr/bin:/bin`;t.after(()=>Object.assign(process.env,env));
  versions.cache.clear();
  const latest={'@openai%2Fcodex':'0.157.0','opencode-ai':'0.61.0'};
  const fetchImpl=async url=>{const npm=/registry\.npmjs\.org\/(.+)\/latest/.exec(url);if(npm&&latest[npm[1]])return {ok:true,json:async()=>({version:latest[npm[1]]})};if(url.includes('ollama/ollama'))return {ok:true,json:async()=>({tag_name:'v0.13.0'})};return {ok:false,status:404,json:async()=>({})};};
  const found=Object.fromEntries((await versions.check(null,{fetchImpl})).items.map(i=>[i.id,i]));
  assert.deepEqual([found.codex.installed,found.codex.latest,found.codex.outdated],['0.150.0','0.157.0',true]);
  assert.deepEqual([found.opencode.installed,found.opencode.outdated],['0.61.0',false]);
  assert.deepEqual([found.ollama.installed,found.ollama.latest,found.ollama.outdated],['0.12.1','0.13.0',true],'a warning line before the version is skipped');
  assert(!found.goose,'tools that are not installed are not listed');
});
test('the Opaya browser is only for models that can see images',()=>{
  assert.equal(visionOf({provider:'claude',command:'claude'}).vision,true);
  assert.equal(visionOf({provider:'custom',command:'/usr/local/bin/gemini'}).vision,null,'Gemini CLI is not a known agent');
  assert.equal(visionOf({provider:'hermes',model:'anthropic/claude-sonnet-4.6'}).vision,true);
  assert.equal(visionOf({provider:'hermes',activeModel:'deepseek-v4-pro'}).vision,false);
  for(const m of ['qwen3:4b','openai/gpt-oss-120b','codestral-latest','llama3.2:3b'])assert.equal(visionOf({provider:'ollama',model:m}).vision,false,m);
  for(const m of ['qwen2.5vl:7b','llama3.2-vision','gpt-5.6-sol','grok-4.7','gemini-3.8-flash','z-ai/glm-4.5v'])assert.equal(visionOf({provider:'openrouter',model:m}).vision,true,m);
  assert.equal(visionOf({provider:'hermes'}).vision,null,'an unknown model is unknown, not denied');
  // DeepSeek V4.1 Flash reads images: deepseek-flash on DeepSeek's API, deepseek/deepseek-v4.1-flash on OpenRouter.
  for(const m of ['deepseek-flash','deepseek:deepseek-flash','deepseek/deepseek-v4.1-flash','deepseek/deepseek-flash-latest','deepseek-v4-flash-vision-exp'])assert.equal(visionOf({provider:'hermes',model:m}).vision,true,m);
  for(const m of ['deepseek-v4-flash','deepseek-v4-pro','deepseek-chat'])assert.equal(visionOf({provider:'hermes',model:m}).vision,false,m);
});
test('every model gets the browser; a text-only model gets it without screenshots, Codex here too',async t=>{
  const {Broker}=require('../desktop/broker.cjs');const {Store,Vault}=require('../desktop/store.cjs');const {secure}=require('./helpers.cjs');
  const root=await temp(t),b=new Broker({store:new Store(root),vault:new Vault(root,secure()),emit:()=>{},approve:async()=>true});await b.init();
  b.browserBridge={command:'node',args:['bridge.cjs'],env:{}};
  const textOnly=s=>s.env.some(e=>e.name==='OPAYA_BROWSER_TEXT_ONLY'&&e.value==='1');
  const text=await b.saveAgent({agent:{name:'Deep',provider:'custom',protocol:'acp',transport:'local',command:'hermes',args:[],model:'deepseek-v4-pro'}});
  await b.updateAgentDisplay({id:text.id,browser:true});
  assert(textOnly(b.mcpFor(text.id).find(s=>s.name==='opaya-browser')),'a DeepSeek Hermes reads pages as text');
  const seeing=await b.saveAgent({agent:{name:'Claude',provider:'claude',protocol:'claude',transport:'local',command:'claude',args:[]}});
  await b.updateAgentDisplay({id:seeing.id,browser:true});
  assert(!textOnly(b.mcpFor(seeing.id).find(s=>s.name==='opaya-browser')));
  // The model changed to a text-only one after the browser was given: it keeps the browser, without screenshots.
  const i=b.data.agents.findIndex(a=>a.id===seeing.id);b.data.agents[i]={...b.data.agents[i],model:'qwen3:4b'};
  assert(textOnly(b.mcpFor(seeing.id).find(s=>s.name==='opaya-browser')));
  const codex=await b.saveAgent({agent:{name:'Codex',provider:'codex',protocol:'codex',transport:'local',command:'codex',args:[]}});
  await b.updateAgentDisplay({id:codex.id,browser:true});assert(b.mcpFor(codex.id).some(s=>s.name==='opaya-browser'));
  await b.close();
});
test('other agent errors get a first diagnosis for the Opaya Agent',()=>{
  const {classify}=require('../desktop/diagnostics.cjs');const kind=(e,provider='hermes')=>classify(e,{provider}).id;
  assert.equal(kind('connect ECONNREFUSED 127.0.0.1:8642'),'gateway');assert.match(classify('fetch failed',{provider:'hermes'}).hint,/hermes gateway status/);
  assert.equal(kind('API authentication failed. Edit this agent and add or import its gateway token.','openclaw'),'onboarding');assert.match(classify('not configured',{provider:'openclaw'}).hint,/openclaw onboard/);
  assert.equal(kind('Claude Code is not signed in yet.','claude'),'onboarding');
  assert.equal(kind('spawn hermes ENOENT'),'not-installed');assert.equal(kind('The gateway is rate limited or busy (HTTP 429).'),'rate-limit');
  assert.equal(kind('Host key verification failed'),'ssh');assert.equal(kind('something new'),'other');
});
test('an ACP agent on a machine or in a container gets the browser through a relay where it runs',async t=>{
  const {Broker}=require('../desktop/broker.cjs');const {Store,Vault}=require('../desktop/store.cjs');const {secure}=require('./helpers.cjs');
  const root=await temp(t),b=new Broker({store:new Store(root),vault:new Vault(root,secure()),emit:()=>{},approve:async()=>true,adapterFactory:()=>({connect:async()=>({}),close(){}})});await b.init();
  const started=[];b.remoteBrowser=async a=>{started.push(a.id);return {command:'python3',args:['-u','-c','client','4242'],env:[{name:'OPAYA_BRIDGE_TOKEN',value:'t'}]};};b.closeRemoteBrowser=()=>{};
  const box=await b.saveAgent({agent:{name:'Hermes Docker',provider:'hermes',protocol:'acp',transport:'local',command:'docker',args:['exec','-i','hermes','hermes','acp'],cwd:'/opt/data'}});
  await b.connect(box.id);assert.deepEqual(started,[box.id]);
  const s=b.mcpFor(box.id).find(x=>x.name==='opaya-browser');assert.equal(s.command,'python3');assert.equal(s.args.at(-1),'4242');
  await b.updateAgentDisplay({id:box.id,browser:false});assert(!b.mcpFor(box.id).some(x=>x.name==='opaya-browser'),'turned off: gone');
  // A relay that cannot start (no python3 or node there): the agent still connects.
  b.remoteBrowser=async()=>{throw new Error('Neither python3 nor node');};const other=await b.saveAgent({agent:{name:'H2',provider:'hermes',protocol:'acp',transport:'local',command:'docker',args:['exec','-i','h2','hermes','acp'],cwd:'/opt/data'}});
  await b.connect(other.id);assert.equal(b.runtimeFor(other.id).status,'connected');
  await b.close();
});
test('the relay works with node where there is no python3',async()=>{
  const {RemoteBridge,NODE_SERVER}=require('../desktop/remote-bridge.cjs');const {spawn}=require('node:child_process');
  const shell=()=>{const c=spawn(process.execPath,['-e',NODE_SERVER],{stdio:['pipe','pipe','pipe']});setImmediate(()=>c.stdout.unshift?.(Buffer.from('')));return c;};
  const relay=new RemoteBridge({where:{},shell:(w,_s)=>{const c=spawn(process.execPath,['-e',NODE_SERVER]);return c;},onConnection:conn=>conn.lines(line=>conn.send(JSON.stringify({echo:JSON.parse(line).n})))});
  relay.rt='node';const srv=await relay.start();assert.equal(srv.command,'node');
  const client=spawn(process.execPath,['-e',srv.args[1],srv.args[2]],{env:{...process.env,OPAYA_BRIDGE_TOKEN:srv.env[0].value}});let out='';client.stdout.on('data',d=>out+=d);
  client.stdin.write(JSON.stringify({n:7})+'\n');for(let i=0;i<50&&!out.includes('\n');i++)await new Promise(r=>setTimeout(r,50));
  assert.deepEqual(JSON.parse(out.trim()),{echo:7});client.kill();relay.close();
});
