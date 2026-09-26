'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const {PassThrough}=require('node:stream');const {EventEmitter}=require('node:events');
const {Broker}=require('../desktop/broker.cjs');const {Store,Vault}=require('../desktop/store.cjs');const {OpayaAgent}=require('../desktop/opaya-agent.cjs');const {temp,secure}=require('./helpers.cjs');
// A stand-in for `claude -p --output-format stream-json`: reads the prompt, may call Opaya tools (as the MCP bridge
// would), then prints stream-json lines and exits.
function fakeClaude(script){
  const spawns=[];
  const spawn=(agent,args,host,options)=>{
    const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();child.exitCode=null;child.kill=()=>{};
    let prompt='';child.stdin.on('data',d=>{prompt+=d;});
    child.stdin.on('end',async()=>{spawns.push({agent,args,options,prompt});const lines=await script({args,prompt});for(const l of lines)child.stdout.write(JSON.stringify(l)+'\n');child.stdout.end();setImmediate(()=>{child.exitCode=0;child.emit('close',0);});});
    return child;
  };
  return {spawns,spawn};
}
async function fixture(t,script){
  const root=await temp(t),approvals=[];
  const broker=new Broker({store:new Store(root),vault:new Vault(root,secure()),emit:()=>{},approve:async()=>true,adapterFactory:()=>({connect:async()=>({}),close(){},run:async()=>({})})});await broker.init();t.after(()=>broker.close());
  const fake=fakeClaude(script);let agent;
  agent=new OpayaAgent({root,vault:broker.vault,broker,terminals:{describe:()=>[]},approve:async(_a,title)=>{approvals.push(title);return true;},emit:()=>{},runInTerminal:async()=>({id:'x'}),spawnAgent:fake.spawn});
  agent.toolBridge={command:'/opaya/Opaya',args:['/opaya/desktop/opaya-tools-mcp.cjs'],env:{ELECTRON_RUN_AS_NODE:'1',OPAYA_TOOLS_ENDPOINT:'e',OPAYA_TOOLS_TOKEN:'t'}};
  await agent.init();return {agent,broker,fake,approvals};
}
const settle=async agent=>{for(let i=0;i<2000&&agent.busy;i++)await new Promise(r=>setTimeout(r,5));assert.equal(agent.busy,false);};
test('Claude Code can be the Opaya Agent\'s model: it reaches the Opaya tools through the MCP bridge only',async t=>{
  let agentRef;
  const {agent,fake}=await fixture(t,async({args,prompt})=>{
    if(args.includes('json'))return [{type:'result',is_error:false,result:'OK',session_id:'s0'}];
    const ws=await agentRef.bridgeCall('get_workspace',{});
    return [{type:'system',subtype:'init',session_id:'sess-1'},{type:'assistant',message:{content:[{type:'tool_use',name:'mcp__opaya__get_workspace'}]}},{type:'assistant',message:{content:[{type:'text',text:`You have ${ws.agents.length} agents. (${prompt})`}]}},{type:'result',is_error:false,result:'done'}];
  });agentRef=agent;
  assert.equal((await agent.test({preset:'claude'})).message,'Claude Code is signed in and answering.');
  await agent.saveConfig({preset:'claude',model:''});assert.equal(agent.configured(),true);assert.equal(agent.describe().hasKey,false);
  await assert.rejects(()=>agent.bridgeCall('get_workspace',{}),/not working on a request/,'the bridge only works during a turn');
  agent.begin('What do I have?');await settle(agent);
  const reply=agent.describe().messages.at(-1);assert.equal(reply.content,'You have 0 agents. (What do I have?)');assert.deepEqual(reply.activity,['Using get workspace']);
  const run=fake.spawns.at(-1);
  assert.equal(run.agent.command,'claude');assert.equal(run.options.cwd,agent.home);
  for(const flag of ['--strict-mcp-config','--mcp-config','--append-system-prompt'])assert(run.args.includes(flag),flag);
  assert.equal(run.args[run.args.indexOf('--allowedTools')+1],'mcp__opaya');
  for(const tool of ['Bash','Edit','Write','WebFetch'])assert(run.args.slice(run.args.indexOf('--disallowedTools')).includes(tool),`${tool} is off`);
  assert.equal(run.prompt,'What do I have?','the request goes through stdin, not the command line');
  agent.begin('And now?');await settle(agent);
  assert.deepEqual(fake.spawns.at(-1).args.slice(fake.spawns.at(-1).args.indexOf('--resume'),fake.spawns.at(-1).args.indexOf('--resume')+2),['--resume','sess-1'],'the same Claude session continues');
  await agent.newSession();agent.begin('Fresh');await settle(agent);assert.equal(fake.spawns.at(-1).args.includes('--resume'),false);
});
test('a Claude Code that is not signed in says so plainly',async t=>{
  const {agent}=await fixture(t,async()=>[{type:'result',is_error:true,result:'Invalid API key · Please run /login'}]);
  await assert.rejects(()=>agent.test({preset:'claude'}),/not signed in yet/);
});
const guide=require('../desktop/guide.cjs');const fsp=require('node:fs/promises');const path=require('node:path');const {execFileSync}=require('node:child_process');
test('the guide gets a model first, then hands the rest to the Opaya Agent; nothing already installed is installed again',()=>{
  const facts=guide.describe({installed:{git:'2.44'},platform:'darwin',arch:'arm64',memory:16e9,home:'/nonexistent'});
  assert.equal(facts.system,'Mac (Apple silicon)');assert.equal(facts.localModelOk,true);assert.equal(facts.signedIn.codex,false);
  const steps=guide.plan({way:'chatgpt',goals:['web','python'],agents:['claude'],facts,platform:'darwin'});
  assert.deepEqual(steps.map(s=>s.id),['install-node','install-codex','signin-codex','brain','install-gh','install-python','install-uv','install-claude','add']);
  assert.deepEqual(steps.filter(s=>s.phase==='model').map(s=>s.kind),['install','install','signin','brain'],'the model comes first');
  assert.match(guide.handoff({steps,facts,goals:['web']}),/Install what is still missing, in this order.*GitHub CLI, Python, uv, Claude Code/);
  // Claude Code on Windows needs Git first; already signed in means no sign-in step.
  const win=guide.plan({way:'claude',goals:[],agents:[],facts:{tools:{},signedIn:{claude:true}},platform:'win32'});
  assert.deepEqual(win.map(s=>s.id),['install-git','install-claude','brain','add']);
  // No account: everything by script, no model steps.
  assert.deepEqual(guide.plan({way:'none',goals:['agents'],agents:['gemini-cli'],facts:{tools:{}},platform:'linux'}).map(s=>s.id),['install-git','install-node','install-gemini-cli','add']);
  assert.throws(()=>guide.plan({way:'hack',facts}),/Choose what you have/);
});
test('sign-in is read from the files each CLI writes',async t=>{
  const home=path.join(await require('./helpers.cjs').temp(t),'home');await fsp.mkdir(path.join(home,'.codex'),{recursive:true});
  assert.equal(guide.signedIn('codex',home,{}),false);await fsp.writeFile(path.join(home,'.codex','auth.json'),'{}');assert.equal(guide.signedIn('codex',home,{}),true);
  await fsp.writeFile(path.join(home,'.claude.json'),'{"numStartups":1}');assert.equal(guide.signedIn('claude',home,{}),false);
  await fsp.writeFile(path.join(home,'.claude.json'),'{"oauthAccount": {"emailAddress":"a@b"}}');assert.equal(guide.signedIn('claude',home,{}),true,'macOS keeps the token in the keychain; the account is recorded here');
});
test('setup commands end with a line the guide can find, and the echoed command itself never matches',{skip:process.platform==='win32'?'POSIX shell':false},()=>{
  const cmd=guide.marked('install-node-1',guide.withPath("echo hi",{windows:false}),{windows:false});
  assert.equal(guide.markOf(cmd,'install-node-1'),null,'the typed command echoes $?, not a number');
  const out=execFileSync('sh',['-c',cmd]).toString();assert.equal(guide.markOf(out,'install-node-1'),0);assert.equal(guide.markOf(out,'install-node'),null,'ids do not match by prefix');
  assert.equal(guide.markOf('\x1b[32m[opaya-setup] x exit 3\x1b[0m','x'),3);
});
test('API keys: a wrong key is explained, services without a model list still connect, Anthropic gets its headers',async t=>{
  const root=await require('./helpers.cjs').temp(t),calls=[];let mode='401';
  const fetchImpl=async(url,init)=>{calls.push({url,headers:init.headers});if(mode==='401')return {ok:false,status:401,json:async()=>({})};if(url.endsWith('/models'))return {ok:false,status:404,json:async()=>({})};return {ok:true,status:200,json:async()=>({choices:[{message:{content:'OK'}}]})};};
  const agent=new OpayaAgent({root,vault:{has:()=>false,get:()=>''},broker:null,terminals:null,approve:async()=>true,emit:()=>{},fetchImpl});await agent.init();
  await assert.rejects(()=>agent.test({preset:'openai',apiKey:'sk-wrong'}),/key was not accepted/);
  mode='no-list';const r=await agent.test({preset:'anthropic',apiKey:'sk-ant'});
  assert.equal(r.ok,true);assert.deepEqual(r.models,['claude-sonnet-5','claude-opus-5-5','claude-haiku-4-5']);
  assert.equal(calls.at(-1).url,'https://api.anthropic.com/v1/chat/completions');assert.equal(calls.at(-1).headers['x-api-key'],'sk-ant');
});
