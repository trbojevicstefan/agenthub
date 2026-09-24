'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const path=require('node:path');const os=require('node:os');const {spawn}=require('node:child_process');const {randomBytes}=require('node:crypto');
const {AcpAdapter}=require('../desktop/adapters/acp.cjs');const {CodexAdapter}=require('../desktop/adapters/codex.cjs');
const {Broker}=require('../desktop/broker.cjs');const {Store,Vault}=require('../desktop/store.cjs');const {server,connect}=require('../desktop/wire.cjs');
const {childMock,context,temp,secure}=require('./helpers.cjs');
test('iTrust approves ACP and Codex tool requests without asking, and says so',async()=>{
  const child=childMock((m,c)=>{
    if(m.method==='initialize')c.reply(m,{protocolVersion:1,agentCapabilities:{}});
    if(m.method==='session/new')c.reply(m,{sessionId:'s1'});
    if(m.method==='session/prompt'){c.prompt=m;c.send({id:991,method:'session/request_permission',params:{sessionId:'s1',toolCall:{title:'terminal: rm build'},options:[{kind:'allow_once',optionId:'once'},{kind:'allow_always',optionId:'always'}]}});}
    if(m.id===991&&!m.method)c.reply(c.prompt,{stopReason:'end_turn'});
  });
  let asked=0;const events=[];
  const a=new AcpAdapter({agent:{provider:'hermes',args:[],cwd:path.resolve('.')},approve:async()=>{asked++;return false;},spawnAgent:()=>child,trusted:()=>true});
  await a.connect();await a.run(context({onEvent:e=>events.push(e)}));
  assert.equal(asked,0);assert.equal(child.frames.find(f=>f.id===991).result.outcome.optionId,'always');
  assert(events.some(e=>e.text==='iTrust approved: terminal: rm build'));a.close();
  const codex=childMock((m,c)=>{
    if(m.method==='initialize')c.reply(m,{});
    if(m.method==='thread/start')c.reply(m,{thread:{id:'t1'}});
    if(m.method==='turn/start'){c.reply(m,{turn:{id:'u1'}});c.send({id:55,method:'item/commandExecution/requestApproval',params:{threadId:'t1',turnId:'u1',command:'npm test'}});}
    if(m.id===55&&!m.method){c.decision=m.result.decision;c.send({method:'turn/completed',params:{threadId:'t1',turn:{id:'u1',status:'completed'}}});}
  });
  const x=new CodexAdapter({agent:{provider:'codex',args:[],cwd:path.resolve('.')},approve:async()=>{asked++;return false;},spawnAgent:()=>codex,trusted:()=>true});
  await x.connect();await x.run(context());assert.equal(codex.decision,'accept');assert.equal(asked,0);x.close();
});
test('iTrust is per agent or for all agents, and only local ACP/Claude agents get the Opaya browser',async t=>{
  const root=await temp(t),factory=[];
  const broker=new Broker({store:new Store(root),vault:new Vault(root,secure()),emit:()=>{},approve:async()=>true,adapterFactory:o=>{factory.push(o);return {connect:async()=>({}),close(){},run:async()=>({})};}});
  await broker.init();t.after(()=>broker.close());
  broker.browserBridge={command:'/opt/Opaya',args:['browser-mcp.cjs'],env:{ELECTRON_RUN_AS_NODE:'1',OPAYA_BROWSER_TOKEN:'x'}};
  const acp=await broker.saveAgent({agent:{name:'tuco',provider:'hermes',protocol:'acp',transport:'local',command:'hermes',cwd:root}});
  const api=await broker.saveAgent({agent:{name:'gw',provider:'custom',protocol:'openai',transport:'http',endpoint:'http://127.0.0.1:8642/v1'}});
  assert.equal(broker.isTrusted(acp.id),false);
  await broker.updateAgentDisplay({id:acp.id,itrust:true});assert.equal(broker.isTrusted(acp.id),true);assert.equal(broker.isTrusted(api.id),false);
  await broker.saveSettings({itrustAll:true});assert.equal(broker.isTrusted(api.id),true);
  await broker.connect(acp.id);assert.equal(factory.at(-1).trusted(),true);
  assert.equal(broker.mcpFor(acp.id).some(s=>s.name==='opaya-browser'),false);
  await broker.updateAgentDisplay({id:acp.id,browser:true});await broker.updateAgentDisplay({id:api.id,browser:true});
  const server=broker.mcpFor(acp.id).find(s=>s.name==='opaya-browser');assert.equal(server.command,'/opt/Opaya');assert.deepEqual(server.env[0],{name:'ELECTRON_RUN_AS_NODE',value:'1'});
  assert.equal(broker.mcpFor(api.id).some(s=>s.name==='opaya-browser'),false,'gateway agents cannot start a local MCP bridge');
  assert.equal(broker.snapshot().settings.itrustAll,true);
});
test('the browser MCP bridge speaks MCP and its token can only call browserTool',async t=>{
  const token=randomBytes(32).toString('hex'),scoped=randomBytes(32).toString('hex'),calls=[];
  const endpoint=process.platform==='win32'?`\\\\.\\pipe\\opaya-test-${process.pid}`:path.join(await temp(t),'s.sock');
  const listener=server({token,snapshot:()=>({}),scopes:()=>new Map([[scoped,new Set(['browserTool'])]]),dispatch:async(method,input)=>{calls.push(method);if(method==='browserTool')return {url:'https://example.com/',title:'Example',text:'Hello page',links:[{text:'More',href:'https://example.com/more'}],image:input.op==='screenshot'?'iVBORw0KGgo=':undefined};return 'secret';}});
  await new Promise(r=>listener.listen(endpoint,r));t.after(()=>listener.close());
  const direct=await connect(endpoint,scoped);await assert.rejects(()=>direct.call('snapshot'),/Not allowed/);direct.close();
  const child=spawn(process.execPath,[path.join(__dirname,'../desktop/browser-mcp.cjs')],{env:{...process.env,OPAYA_BROWSER_ENDPOINT:endpoint,OPAYA_BROWSER_TOKEN:scoped},stdio:['pipe','pipe','inherit']});
  t.after(()=>child.kill());
  const replies=new Map();let buf='';child.stdout.on('data',d=>{buf+=d;let i;while((i=buf.indexOf('\n'))>=0){const m=JSON.parse(buf.slice(0,i));buf=buf.slice(i+1);replies.get(m.id)?.(m);}});
  const rpc=(id,method,params)=>new Promise(r=>{replies.set(id,r);child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
  const init=await rpc(1,'initialize',{protocolVersion:'2025-06-18',capabilities:{}});assert.equal(init.result.serverInfo.name,'opaya-browser');
  const list=await rpc(2,'tools/list',{});assert(list.result.tools.some(x=>x.name==='browser_open'));
  const open=await rpc(3,'tools/call',{name:'browser_open',arguments:{url:'example.com'}});assert.match(open.result.content[0].text,/Hello page[\s\S]*More: https:\/\/example.com\/more/);
  const shot=await rpc(4,'tools/call',{name:'browser_screenshot',arguments:{}});assert.equal(shot.result.content[1].type,'image');
  assert.deepEqual(calls,['browserTool','browserTool']);
});
test('rich messages render Markdown safely',()=>{
  global.window={};require('../ui/markdown.js');const r=window.OpayaMarkdown.render;
  const html=r('## Plan\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- [x] done\n\n```html\n<b>x</b>\n```\n\n[ok](https://opaya.dev) [bad](javascript:alert(1)) <img src=x onerror=alert(1)>');
  assert.match(html,/<h3>Plan<\/h3>/);assert.match(html,/<table>/);assert.match(html,/task-box done/);assert.match(html,/data-action="md-preview"/);
  assert.match(html,/data-url="https:\/\/opaya.dev\/"/);assert(!html.includes('javascript:alert(1)"'));assert(!/<img src=x/.test(html));assert.match(html,/&lt;img src=x onerror=alert\(1\)&gt;/);
});
