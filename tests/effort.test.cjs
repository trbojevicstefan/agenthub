'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const http=require('node:http');const fs=require('node:fs/promises');const path=require('node:path');const {EventEmitter}=require('node:events');const {PassThrough}=require('node:stream');
const levels=require('../desktop/effort.cjs');const schema=require('../desktop/schema.cjs');const openclaw=require('../desktop/openclaw.cjs');
const {Broker}=require('../desktop/broker.cjs');const {Store,Vault}=require('../desktop/store.cjs');const {efforts}=require('../desktop/adapters/index.cjs');
const {HttpAdapter}=require('../desktop/adapters/http.cjs');const {ClaudeAdapter}=require('../desktop/adapters/claude.cjs');const {CodexAdapter}=require('../desktop/adapters/codex.cjs');const {AcpAdapter}=require('../desktop/adapters/acp.cjs');
const {childMock,context,temp,secure}=require('./helpers.cjs');
const skip=process.platform==='win32'?'uses a POSIX shell script as a fake CLI':false;
async function server(t,handler){const s=http.createServer(handler);await new Promise(r=>s.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{s.closeAllConnections();s.close(r);}));return `http://127.0.0.1:${s.address().port}/v1`;}
const body=async req=>{let raw='';for await(const c of req)raw+=c;return JSON.parse(raw);};
function sse(res,text){res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: '+JSON.stringify({choices:[{delta:{content:text}}]})+'\n\n');res.end('data: [DONE]\n\n');}
// A Claude CLI that answers once per spawn; `exit` makes one fail like an old CLI that does not know a flag.
function claudeChild({exit=0,stderr='',onInput}={}){const c=new EventEmitter();Object.assign(c,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),exitCode:null,signalCode:null});c.kill=()=>{};let input='';c.stdin.on('data',d=>input+=d.toString());c.stdin.on('finish',()=>{onInput?.(input);queueMicrotask(()=>{if(exit){c.stderr.write(stderr);}else{c.stdout.write(JSON.stringify({type:'stream_event',event:{delta:{type:'text_delta',text:'ok'}}})+'\n');c.stdout.write(JSON.stringify({type:'result',result:'ok',session_id:'s'})+'\n');}setTimeout(()=>{c.exitCode=exit;c.emit('close',exit);},5);});});return c;}

test('effort levels are ordered low to high and a missing level maps to the nearest one',()=>{
  assert.deepEqual(levels.order(['high','low','think_hard','xhigh','medium','High','low','constructor']),['low','medium','high','xhigh','think_hard','constructor']);
  assert.equal(levels.nearest('max',levels.CODEX),'xhigh');assert.equal(levels.nearest('minimal',['low','medium','high','xhigh']),'low');
  assert.equal(levels.nearest('medium',['low','high']),'high','a tie goes to the higher level');assert.equal(levels.nearest('none',['off','low']),'off');
  assert.equal(levels.nearest('high',['high']),'high');assert.equal(levels.nearest('think_hard',['low']),'');assert.equal(levels.nearest('high',[]),'');assert.equal(levels.nearest('',levels.API),'');
});
test('agents keep a validated reasoning effort and a message with files may have no text',()=>{
  const base={name:'x',provider:'claude',protocol:'claude',command:'claude'};
  assert.equal(schema.agent({...base,effort:' High '}).effort,'high');assert.equal(schema.agent(base).effort,'');
  assert.throws(()=>schema.agent({...base,effort:'high; rm -rf /'}),/reasoning effort/);assert.throws(()=>schema.effort('x'.repeat(40)),/reasoning effort/);
  assert.equal(schema.prompt('',{empty:true}),'');assert.throws(()=>schema.prompt('  '),/Enter a message/);assert.throws(()=>schema.prompt(undefined,{empty:true}),/Enter a message/);
});
test('every snapshot agent lists the efforts it takes now, and the choice is saved per agent or per chat',async t=>{
  const root=await temp(t),runs=[];const adapters={};
  const b=new Broker({store:new Store(root),vault:new Vault(root,secure()),emit:()=>{},approve:async()=>true,adapterFactory:o=>{const a={connect:async()=>({}),close(){},run:async ctx=>{runs.push(ctx);return {};}};if(o.agent.name==='acp')a.efforts=['low','high'];adapters[o.agent.name]=a;return a;}});
  await b.init();t.after(()=>b.close());
  const add=agent=>b.saveAgent({agent});
  const claude=await add({name:'claude',provider:'claude',protocol:'claude',command:'claude'}),codex=await add({name:'codex',provider:'codex',protocol:'codex',command:'codex'});
  const api=await add({name:'api',provider:'openai',protocol:'openai',endpoint:'https://api.openai.com/v1',model:'gpt-5.5'}),hermes=await add({name:'hermes',provider:'hermes',protocol:'openai',endpoint:'http://127.0.0.1:8642/v1'});
  const acp=await add({name:'acp',provider:'custom',protocol:'acp',command:'opencode',args:['acp'],cwd:root}),term=await add({name:'term',provider:'custom',protocol:'terminal',command:'bash'});
  const shown=()=>Object.fromEntries(b.snapshot().agents.map(a=>[a.name,a.efforts]));
  assert.deepEqual(shown(),{claude:levels.CLAUDE,codex:levels.CODEX,api:['low','medium','high'],hermes:[],acp:[],term:[]});
  await b.connect(acp.id);assert.deepEqual(shown().acp,['low','high'],'a connected agent reports its own levels');
  await b.selectEffort({id:claude.id,effort:'xhigh'});assert.equal(b.snapshot().agents.find(a=>a.id===claude.id).effort,'xhigh');
  await assert.rejects(()=>b.selectEffort({id:claude.id,effort:'ultra'}),/takes these reasoning efforts: low, medium, high, xhigh, max/);
  await assert.rejects(()=>b.selectEffort({id:hermes.id,effort:'high'}),/has no reasoning effort setting/);
  await assert.rejects(()=>b.selectEffort({id:term.id,effort:'low'}),/no reasoning effort/);await b.selectEffort({id:term.id,effort:''});
  await assert.rejects(()=>b.selectEffort({id:claude.id,effort:'high',scope:'conversation',conversationId:'missing'}),/Start a conversation/);
  await assert.rejects(()=>b.selectEffort({id:claude.id,effort:'high',scope:'everywhere'}),/default or conversation/);
  const c1=await b.newConversation(claude.id),c2=await b.newConversation(claude.id);
  await b.selectEffort({id:claude.id,effort:'low',scope:'conversation',conversationId:c1.id});
  await b.connect(claude.id);
  await b.send({agentId:claude.id,conversationId:c1.id,text:'one'});await b.turns.get(claude.id)?.done;
  await b.send({agentId:claude.id,conversationId:c2.id,text:'two'});await b.turns.get(claude.id)?.done;
  assert.deepEqual(runs.map(r=>r.effort),['low','xhigh'],'a chat override wins, other chats use the agent default');
  await b.selectEffort({id:claude.id,effort:'',scope:'conversation',conversationId:c1.id});await b.send({agentId:claude.id,conversationId:c1.id,text:'three'});await b.turns.get(claude.id)?.done;assert.equal(runs[2].effort,'xhigh');
  await b.close();const fresh=new Broker({store:new Store(root),vault:new Vault(root,secure()),emit:()=>{},approve:async()=>true});await fresh.init();
  assert.equal(fresh.agent(claude.id).effort,'xhigh','the agent default survives a restart');assert.equal(fresh.snapshot().agents.find(a=>a.id===codex.id).effort,'');assert.equal(fresh.agent(api.id).effort,'');await fresh.close();
});
test('Claude gets --effort (the nearest level it takes) and an old CLI without the flag answers without it',async()=>{
  const argvs=[],events=[];let changes=0;
  const a=new ClaudeAdapter({agent:{args:[]},onChange:()=>changes++,spawnAgent:(_a,args)=>{argvs.push(args);return claudeChild();}});
  await a.run(context({effort:'high'}));assert.equal(argvs[0][argvs[0].indexOf('--effort')+1],'high');
  await a.run(context({effort:'minimal'}));assert.equal(argvs[1][argvs[1].indexOf('--effort')+1],'low');
  await a.run(context({effort:''}));assert.equal(argvs[2].includes('--effort'),false);
  const old=new ClaudeAdapter({agent:{args:[]},onChange:()=>changes++,spawnAgent:(_a,args)=>{argvs.push([...args]);return args.includes('--effort')?claudeChild({exit:1,stderr:"error: unknown option '--effort'\n"}):claudeChild();}});
  assert.deepEqual(old.efforts,levels.CLAUDE);
  await old.run(context({effort:'max',onEvent:e=>events.push(e)}));
  assert.equal(argvs.at(-1).includes('--effort'),false,'asked again without the flag');assert.equal(events.filter(e=>e.type==='text').map(e=>e.text).join(''),'ok');
  assert(events.some(e=>e.type==='activity'&&/no reasoning effort setting/.test(e.text)));assert.deepEqual(old.efforts,[]);assert.equal(changes,1);
  const count=argvs.length;await old.run(context({effort:'max'}));assert.equal(argvs.length,count+1,'later turns do not try the flag again');
  await assert.rejects(()=>new ClaudeAdapter({agent:{args:[]},spawnAgent:()=>claudeChild({exit:1,stderr:'Not logged in'})}).run(context({effort:'high'})),/Not logged in/);
});
function codexServer({refuse=false}={}){
  return childMock((m,c)=>{
    if(m.method==='initialize')c.reply(m,{});
    if(m.method==='model/list')c.reply(m,{data:[{id:'gpt-5.5-codex',model:'gpt-5.5-codex',isDefault:true,supportedReasoningEfforts:[{reasoningEffort:'xhigh',description:''},{reasoningEffort:'low',description:''},{reasoningEffort:'medium',description:''},{reasoningEffort:'high',description:''}],inputModalities:['text','image']},{id:'mini',model:'mini',isDefault:false,supportedReasoningEfforts:[],inputModalities:['text']},{id:'legacy',model:'legacy'}]});
    if(m.method==='thread/start')c.reply(m,{thread:{id:'t1'},model:m.params.model||'gpt-5.5-codex'});
    if(m.method==='turn/start'){if(refuse&&m.params.effort){c.send({id:m.id,error:{code:-32600,message:`reasoning effort ${m.params.effort} is not supported`}});return;}c.reply(m,{turn:{id:'u1'}});c.send({method:'turn/completed',params:{threadId:'t1',turn:{id:'u1',status:'completed'}}});}
  });
}
test('Codex sends the effort per turn, reads each model\'s levels and maps or drops what a model does not offer',async()=>{
  const child=codexServer();let changes=0;const a=new CodexAdapter({agent:{args:[],cwd:path.resolve('.')},approve:async()=>false,spawnAgent:()=>child,onChange:()=>changes++});
  assert.deepEqual(a.efforts,levels.CODEX,'before model/list answers');
  await a.connect();await new Promise(r=>setTimeout(r,20));
  assert.deepEqual(a.efforts,['low','medium','high','xhigh'],'the default model\'s levels, low to high');assert(changes>0);
  const events=[];await a.run(context({effort:'minimal',onEvent:e=>events.push(e)}));
  const starts=()=>child.frames.filter(f=>f.method==='turn/start');
  assert.equal(starts()[0].params.effort,'low');assert(events.some(e=>/Using low reasoning effort: gpt-5.5-codex does not offer minimal/.test(e.text)));
  await a.run(context({effort:'high',conversation:{id:'c2',externalSessionId:'',model:'mini'}}));assert.equal(starts()[1].params.effort,undefined,'a model without levels gets none');
  await a.run(context({effort:'max',conversation:{id:'c3',externalSessionId:'',model:'legacy'}}));assert.equal(starts()[2].params.effort,'max','an older app-server that lists no levels gets the choice as is');
  a.agent.model='mini';assert.deepEqual(a.efforts,[]);a.close();
  const strict=codexServer({refuse:true}),b=new CodexAdapter({agent:{args:[],cwd:path.resolve('.')},approve:async()=>false,spawnAgent:()=>strict});await b.connect();
  const out=[];await b.run(context({effort:'xhigh',onEvent:e=>out.push(e)}));
  assert.deepEqual(strict.frames.filter(f=>f.method==='turn/start').map(f=>f.params.effort),['xhigh',undefined]);assert(out.some(e=>/did not take xhigh reasoning effort/.test(e.text)));b.close();
});
test('model APIs get reasoning_effort (OpenRouter: reasoning.effort); a model that refuses it is asked again without it',async t=>{
  const seen=[];const endpoint=await server(t,async(req,res)=>{const b=await body(req);seen.push(b);if(b.model==='plain'&&(b.reasoning_effort||b.reasoning)){res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:"Unsupported parameter: 'reasoning_effort' is not supported with this model."}}));return;}sse(res,'ok');});
  let changes=0;const a=new HttpAdapter({agent:{provider:'openai',endpoint,model:'thinker'},onChange:()=>changes++});
  await a.run(context({effort:'xhigh'}));assert.equal(seen[0].reasoning_effort,'high','the nearest of low, medium and high');
  await a.run(context({effort:''}));assert.equal('reasoning_effort' in seen[1],false);
  const events=[];await a.run(context({effort:'low',conversation:{id:'c',model:'plain'},onEvent:e=>events.push(e)}));
  assert.equal(seen[2].reasoning_effort,'low');assert.equal('reasoning_effort' in seen[3],false);assert.equal(events.at(-1).text,'ok');
  assert(events.some(e=>e.type==='activity'&&/plain ignored the low reasoning effort/.test(e.text)));assert(changes>0);
  await a.run(context({effort:'low',conversation:{id:'c',model:'plain'}}));assert.equal(seen.length,5,'remembered: no second refusal');assert.equal('reasoning_effort' in seen[4],false);
  assert.deepEqual(a.efforts,['low','medium','high']);a.agent.model='plain';assert.deepEqual(a.efforts,[]);
  const hermes=new HttpAdapter({agent:{provider:'hermes',endpoint,model:'hermes-agent'}});await hermes.run(context({effort:'high'}));assert.equal('reasoning_effort' in seen.at(-1),false);assert.deepEqual(hermes.efforts,[]);
  let routed;const router=new HttpAdapter({agent:{provider:'openrouter',endpoint:'https://openrouter.ai/api/v1',model:'x/y'},fetchImpl:async(_u,init)=>{routed=JSON.parse(init.body);return new Response('data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});}});
  await router.run(context({effort:'medium'}));assert.deepEqual(routed.reasoning,{effort:'medium'});assert.equal('reasoning_effort' in routed,false);
});
test('OpenClaw thinking is set on the chat\'s session through its CLI, once, the nearest level when refused, and cleared again',async t=>{
  const calls=[];const cli={...openclaw,call:async(_agent,_host,method,params,opts)=>{calls.push({method,params,opts});
    if(method==='sessions.list')return {defaults:{thinkingLevels:[{id:'off'},{id:'minimal'},{id:'low'},{id:'medium'},{id:'high'}],thinkingDefault:'medium'}};
    if(params.thinkingLevel==='xhigh')throw new Error('thinkingLevel "xhigh" is not supported for fake/thinker (use off|minimal|low|medium|high)');return {ok:true};}};
  const endpoint=await server(t,async(req,res)=>{if(req.url.endsWith('/models')){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'openclaw/default'}]}));return;}await body(req);sse(res,'ok');});
  let changes=0;const a=new HttpAdapter({agent:{provider:'openclaw',transport:'http',endpoint,model:'openclaw/default'},openclawCli:cli,onChange:()=>changes++});
  assert.deepEqual(a.efforts,[]);await a.connect();await new Promise(r=>setTimeout(r,20));
  assert.deepEqual(a.efforts,['off','minimal','low','medium','high']);assert(changes>0);assert.equal(calls[0].opts.port,new URL(endpoint).port,'the CLI talks to the gateway on this connection\'s port');
  const conversation={id:'conv-1',externalSessionId:''},events=[];
  await a.run(context({conversation,effort:'high',onEvent:e=>events.push(e)}));
  assert.deepEqual(calls[1],{method:'sessions.patch',params:{key:'openai-user:agenthub:conv-1',thinkingLevel:'high'},opts:{port:new URL(endpoint).port}});assert.equal(conversation.effortApplied,'high');
  await a.run(context({conversation,effort:'high'}));assert.equal(calls.length,2,'already set for this chat');
  await a.run(context({conversation,effort:'xhigh',onEvent:e=>events.push(e)}));
  assert.deepEqual(calls.slice(2).map(c=>c.params.thinkingLevel),['xhigh','high']);assert(events.some(e=>/Using high reasoning effort: this model does not offer xhigh/.test(e.text)));assert.equal(conversation.effortApplied,'xhigh');
  await a.run(context({conversation,effort:''}));assert.deepEqual(calls.at(-1).params,{key:'openai-user:agenthub:conv-1',thinkingLevel:null});assert.equal(conversation.effortApplied,'');
  const agentRoute=new HttpAdapter({agent:{provider:'openclaw',transport:'http',endpoint,model:'openclaw/research'},openclawCli:cli});await agentRoute.run(context({conversation:{id:'conv-2'},effort:'low'}));
  assert.equal(calls.at(-1).params.key,'agent:research:openai-user:agenthub:conv-2');
  const fresh=new HttpAdapter({agent:{provider:'openclaw',transport:'http',endpoint,model:'openclaw/default'},openclawCli:cli}),saved={id:'conv-9',effortApplied:'low'},before=calls.length;
  await fresh.run(context({conversation:saved,effort:'low'}));await fresh.run(context({conversation:saved,effort:'low'}));
  assert.equal(calls.length,before+1,'a new connection sets a saved level again once, in case OpenClaw reset the session');
  const failing={...cli,call:async()=>{throw new Error('gateway closed (1006)');}},out=[];
  await new HttpAdapter({agent:{provider:'openclaw',transport:'http',endpoint,model:'openclaw/default'},openclawCli:failing}).run(context({conversation:{id:'conv-3'},effort:'low',onEvent:e=>out.push(e)}));
  assert(out.some(e=>/Reasoning effort was not applied: gateway closed/.test(e.text)));assert.equal(out.at(-1).text,'ok','the answer still comes');
  const remote=[];await new HttpAdapter({agent:{provider:'openclaw',transport:'http',endpoint:'https://claw.example.com/v1',model:'openclaw'},openclawCli:cli,fetchImpl:async()=>new Response('data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}})}).run(context({conversation:{id:'conv-4'},effort:'low',onEvent:e=>remote.push(e)}));
  assert(remote.some(e=>/cannot run for a gateway it reaches only over HTTPS/.test(e.text)));
});
test('the OpenClaw CLI call keeps the JSON a refusal prints with exit code 1 and puts no secret on its command line',{skip},async t=>{
  const dir=await temp(t),log=path.join(dir,'argv.txt');
  await fs.writeFile(path.join(dir,'openclaw'),`#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(log)}\ncase "$*" in *xhigh*) echo 'Config warnings: none'; echo '{"ok":false,"error":{"message":"thinkingLevel \\"xhigh\\" is not supported for fake/thinker (use off|minimal|low|medium|high)"}}'; exit 1;; *broken*) echo 'gateway unreachable' >&2; exit 1;; esac\necho '{"ok":true,"defaults":{"thinkingLevels":[{"id":"off"},{"id":"low"},{"id":"high"}],"thinkingDefault":"low"}}'\n`,{mode:0o755});
  const saved=process.env.PATH;process.env.PATH=`${dir}${path.delimiter}${saved}`;t.after(()=>{process.env.PATH=saved;});
  const agent={provider:'openclaw',protocol:'openai',transport:'http',endpoint:'http://127.0.0.1:18789/v1',args:[]};
  assert.deepEqual(await openclaw.thinking(agent,null),{levels:['off','low','high'],default:'low'});
  assert.deepEqual((await fs.readFile(log,'utf8')).trim().split('\n'),['gateway','call','sessions.list','--json','--params','{"limit":1}','--port','18789']);
  await assert.rejects(()=>openclaw.call(agent,null,'sessions.patch',{key:'k',thinkingLevel:'xhigh'}),e=>{assert.deepEqual(openclaw.offered(e.message),['off','minimal','low','medium','high']);return true;});
  await assert.rejects(()=>openclaw.call(agent,null,'sessions.patch',{key:'broken'}),/gateway unreachable/);
  assert.equal(openclaw.cliPort({command:'docker',args:['exec','-i','c','openclaw'],endpoint:'http://127.0.0.1:18790/v1'}),'','a container has its own port inside');
});
test('ACP applies effort through the session\'s thought_level option and follows its updates',async()=>{
  const option=(current,values=['low','medium','high'])=>({id:'effort',name:'Reasoning',category:'thought_level',type:'select',currentValue:current,options:[{group:'g',name:'All',options:values.map(value=>({value,name:value}))}]});
  const child=childMock((m,c)=>{
    if(m.method==='initialize')c.reply(m,{protocolVersion:1,agentCapabilities:{}});
    if(m.method==='session/new')c.reply(m,{sessionId:'s-'+c.frames.filter(f=>f.method==='session/new').length,configOptions:[{id:'model',category:'model',type:'select',currentValue:'m',options:[{value:'m',name:'m'}]},option('medium')]});
    if(m.method==='session/set_config_option')c.reply(m,{configOptions:[option(m.params.value)]});
    if(m.method==='session/prompt'){if(c.frames.filter(f=>f.method==='session/prompt').length===1)c.send({method:'session/update',params:{sessionId:m.params.sessionId,update:{sessionUpdate:'config_option_update',configOptions:[option('high',['low','medium','high','xhigh'])]}}});c.reply(m,{stopReason:'end_turn'});}
  });
  let changes=0;const a=new AcpAdapter({agent:{provider:'custom',args:[],cwd:path.resolve('.')},approve:async()=>false,spawnAgent:()=>child,onChange:()=>changes++});
  await a.connect();assert.deepEqual(a.efforts,[]);
  const conversation={id:'c1',externalSessionId:''},events=[];
  await a.run(context({conversation,effort:'high',onEvent:e=>events.push(e)}));
  const sets=()=>child.frames.filter(f=>f.method==='session/set_config_option').map(f=>f.params);
  assert.deepEqual(sets(),[{sessionId:'s-1',configId:'effort',value:'high'}]);assert(changes>0);
  assert.deepEqual(a.efforts,['low','medium','high','xhigh'],'levels follow config_option_update');
  await a.run(context({conversation,effort:'max',onEvent:e=>events.push(e)}));assert.equal(sets().at(-1).value,'xhigh');assert(events.some(e=>/Using xhigh reasoning effort: this agent does not offer max/.test(e.text)));
  await a.run(context({conversation,effort:''}));assert.equal(sets().at(-1).value,'medium','the agent\'s own setting is the level the session started with');
  const count=sets().length;await a.run(context({conversation,effort:''}));assert.equal(sets().length,count);a.close();
  const plain=childMock((m,c)=>{if(m.method==='initialize')c.reply(m,{protocolVersion:1,agentCapabilities:{}});if(m.method==='session/new')c.reply(m,{sessionId:'p1'});if(m.method==='session/prompt')c.reply(m,{stopReason:'end_turn'});});
  const b=new AcpAdapter({agent:{provider:'custom',name:'Goose',args:[],cwd:path.resolve('.')},approve:async()=>false,spawnAgent:()=>plain});await b.connect();
  const out=[];await b.run(context({effort:'high',onEvent:e=>out.push(e)}));await b.run(context({effort:'high',onEvent:e=>out.push(e)}));
  assert.equal(out.filter(e=>/has no reasoning effort setting/.test(e.text)).length,1,'said once per chat');assert.equal(plain.frames.some(f=>f.method==='session/set_config_option'),false);b.close();
});
test('the adapter index falls back to what a protocol takes until an agent connects',()=>{
  assert.deepEqual(efforts({protocol:'openai',provider:'openclaw'}),[]);assert.deepEqual(efforts({protocol:'openai',provider:'ollama'}),levels.API);
  assert.deepEqual(efforts({protocol:'claude'},{efforts:[]}),[]);assert.deepEqual(efforts({protocol:'acp'}),[]);
});
