'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {gatewayArgs}=require('../desktop/management.cjs');
const {HttpAdapter}=require('../desktop/adapters/http.cjs');
const {AcpAdapter}=require('../desktop/adapters/acp.cjs');
const {childMock,context}=require('./helpers.cjs');
test('gateway restart targets the configured Docker service and preserves container options',()=>{
  const agent={provider:'hermes',command:'docker',hermesHome:'/opt/data',args:['exec','-i','-u','hermes','leads','hermes']};
  const args=gatewayArgs(agent,'restart');assert.deepEqual(args.slice(0,5),['exec','-i','-u','hermes','leads']);assert(args.includes('/run/service/gateway-default'));assert(args.some(a=>a.includes('/command/s6-svc -t "$service"')));assert.throws(()=>gatewayArgs(agent,'delete'));
});
test('gateway management preserves custom executable paths, profiles and CLI flags',()=>{
  const agent={provider:'hermes',command:'docker',hermesHome:'/srv/config/profiles/editor',args:['exec','-i','example-runtime','/usr/local/agent/bin/hermes','--verbose','acp']};
  const args=gatewayArgs(agent,'restart');assert(args.includes('/run/service/gateway-editor'));assert.deepEqual(args.slice(-2),['/usr/local/agent/bin/hermes','--verbose']);
  assert.deepEqual(gatewayArgs({provider:'openclaw',command:'openclaw',args:['--profile','work']},'status'),['--profile','work','gateway','status']);
});
test('Docker shells preserve explicit container user and workspace options',()=>{
  const {dockerShellArgs,Terminals}=require('../desktop/terminal.cjs');
  const agent={command:'docker',provider:'openclaw',args:['exec','-i','--user','1001','--workdir','/workspace','example-runtime','openclaw']};
  assert.deepEqual(dockerShellArgs(agent),['exec','-it','--user','1001','--workdir','/workspace','example-runtime','sh','-l']);
  assert.equal(new Terminals(()=>{}).cliArgs(agent).at(-1),'tui');
});
test('Hermes model inventory excludes unauthenticated providers and sends explicit model choices',async()=>{
  let payload,headers;
  const adapter=new HttpAdapter({agent:{id:'agent',provider:'hermes',transport:'http',endpoint:'http://127.0.0.1:8642/v1',model:'deepseek:deepseek-v4-flash'},fetchImpl:async(url,options)=>{
    if(url.endsWith('/models'))return Response.json({data:[{id:'hermes-agent'}]});
    if(url.endsWith('/api/model/options'))return Response.json({providers:[{slug:'deepseek',authenticated:true,models:['deepseek-v4-flash']},{slug:'missing',authenticated:false,models:['unavailable']}]});
    payload=JSON.parse(options.body);headers=options.headers;return Response.json({choices:[{message:{content:'OK'}}]});
  }});
  await adapter.connect();assert.deepEqual(await adapter.listModels(),['hermes-agent','deepseek:deepseek-v4-flash']);
  await adapter.run(context());assert.equal(payload.provider,'deepseek');assert.equal(payload.model,'deepseek-v4-flash');assert.equal(headers['X-Hermes-Session-Key'],'agenthub:agent:conversation-one');
});
test('ACP applies a persisted model after loading an existing session',async()=>{
  const child=childMock((message,c)=>{
    if(message.method==='initialize')c.reply(message,{protocolVersion:1,agentCapabilities:{loadSession:true}});
    if(['session/load','session/set_model','session/prompt'].includes(message.method))c.reply(message,{});
  });
  const adapter=new AcpAdapter({agent:{args:[],cwd:process.cwd(),model:'deepseek:deepseek-v4-flash'},spawnAgent:()=>child});
  await adapter.connect();await adapter.run(context({conversation:{id:'local',externalSessionId:'saved'}}));
  const methods=child.frames.map(f=>f.method);assert(methods.indexOf('session/set_model')<methods.indexOf('session/prompt'));assert.equal(child.frames.find(f=>f.method==='session/set_model').params.sessionId,'saved');adapter.close();
});
test('ACP reads models from session config options and sets them through set_config_option',async()=>{
  const child=childMock((message,c)=>{
    if(message.method==='initialize')c.reply(message,{protocolVersion:1,agentCapabilities:{}});
    if(message.method==='session/new')c.reply(message,{sessionId:'s1',configOptions:[{id:'mode',category:'mode',options:[{value:'ask'}]},{id:'model_choice',category:'model',type:'select',currentValue:'a',options:[{value:'anthropic/claude-sonnet'},{group:'openrouter',name:'OpenRouter',options:[{value:'qwen/qwen3-coder'}]}]}]});
    if(['session/set_config_option','session/prompt'].includes(message.method))c.reply(message,{});
  });
  const adapter=new AcpAdapter({agent:{args:[],cwd:process.cwd(),model:'qwen/qwen3-coder'},spawnAgent:()=>child});
  await adapter.connect();assert.deepEqual(await adapter.listModels(),['anthropic/claude-sonnet','qwen/qwen3-coder']);
  await adapter.run(context());
  const set=child.frames.find(f=>f.method==='session/set_config_option');assert.deepEqual(set.params,{sessionId:'s1',configId:'model_choice',value:'qwen/qwen3-coder'});
  assert(!child.frames.some(f=>f.method==='session/set_model'));adapter.close();
});
test('ACP tries a typed model when the server lists none, and reports a refusal instead of failing',async()=>{
  const child=childMock((message,c)=>{
    if(message.method==='initialize')c.reply(message,{protocolVersion:1,agentCapabilities:{}});
    if(message.method==='session/new')c.reply(message,{sessionId:'s2'});
    if(message.method==='session/set_model')c.send({id:message.id,error:{code:-32601,message:'Method not found'}});
    if(message.method==='session/prompt')c.reply(message,{});
  });
  const adapter=new AcpAdapter({agent:{args:[],cwd:process.cwd(),model:'my-model'},spawnAgent:()=>child});
  await adapter.connect();assert.deepEqual(await adapter.listModels(),[]);
  const events=[];await adapter.run(context({onEvent:e=>events.push(e)}));
  assert(events.some(e=>/my-model was not applied/.test(e.text||'')));assert(child.frames.some(f=>f.method==='session/prompt'));adapter.close();
});
test('Claude Code offers its model aliases',async()=>{
  const {ClaudeAdapter}=require('../desktop/adapters/claude.cjs');
  const models=await new ClaudeAdapter({agent:{model:'claude-opus-4-1'}}).listModels();
  for(const m of ['sonnet','opus','haiku','claude-opus-4-1'])assert(models.includes(m),m);
});
