'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const bridge=require('../scripts/cord/runner.cjs');
test('desktop Cord action validates its destination and selected identity before invoking a fixed script',async()=>{
  const cord=require('../desktop/cord.cjs'),agentId='aa111111-1111-4111-8111-111111111111';let invoked;
  const output=await cord.connect({server:'http://127.0.0.1:3000',code:'a'.repeat(48),agentId},{root:os.tmpdir(),agents:[{id:agentId,protocol:'codex'}],exec:(command,args,options,cb)=>{invoked={command,args,options};cb(null,'Paired successfully','');}});
  assert.match(output.message,/Paired/);assert.ok(invoked.args.includes(agentId));assert.equal(invoked.options.windowsHide,true);assert.equal(invoked.options.shell,undefined);
  const staged=require('node:child_process').spawnSync(process.execPath,[invoked.args[0],'--help'],{encoding:'utf8',windowsHide:true});assert.equal(staged.status,0,staged.stderr);assert.match(staged.stdout,/Cord bridge/);
  assert.throws(()=>cord.validate({server:'http://remote.example',code:'a'.repeat(48),agentId}));
  await assert.rejects(cord.connect({server:'https://cord.example',code:'a'.repeat(48),agentId},{root:os.tmpdir(),agents:[]}),/compatible/);
});
test('native OPAYA service retains local credentials and reuses a separate conversation for each Cord session',async()=>{
  const wire=require('../desktop/wire.cjs'),{OpayaServiceAdapter}=require('../scripts/cord/opaya-service.cjs'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'opaya-cord-ipc-')),token='a'.repeat(64);let created=0,turn=0;
  const server=wire.server({token,snapshot:()=>({}),dispatch:async(method,input)=>{
    if(method==='snapshot')return {agents:[{id:'agent',status:'connected',busy:false}]};
    if(method==='newConversation'){created++;assert.equal(input.activate,false);return {id:'native-chat'};}
    if(method==='send'){turn++;assert.equal(input.conversationId,'native-chat');return {messageId:'reply-'+turn};}
    if(method==='transcript')return {messages:[{id:'reply-'+turn,role:'assistant',status:'done',content:'Native reply'}]};
    throw new Error('Unexpected method '+method);
  }});
  await new Promise(r=>server.listen(wire.endpoint(dir),r));fs.writeFileSync(path.join(dir,'session-service.json'),JSON.stringify({protocol:1,token}));
  const adapter=new OpayaServiceAdapter({serviceRoot:dir,agent:{id:'agent'}});let session,reply;
  try{await adapter.connect();for(let i=0;i<2;i++){await adapter.run({conversation:{externalSessionId:session},text:'Hello',signal:new AbortController().signal,onSession:async id=>session=id,onEvent:e=>reply=e.text});}assert.equal(created,1);assert.equal(turn,2);assert.equal(reply,'Native reply');}
  finally{adapter.close();await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});}
});
test('Cord transport accepts secure remote servers and loopback development only',()=>{
  assert.equal(bridge.serverURL('https://cord.example'),'https://cord.example');
  assert.equal(bridge.serverURL('http://127.0.0.1:3000'),'http://127.0.0.1:3000');
  for(const url of ['http://remote.example','https://user:secret@cord.example','https://cord.example/path','https://cord.example?token=secret'])assert.throws(()=>bridge.serverURL(url));
});
test('Cord CLI parses runtime, project and management options without evaluating commands',()=>{
  assert.deepEqual(bridge.args(['--runtime','codex','--cwd','C:\\My Project','--foreground']),{runtime:'codex',cwd:'C:\\My Project',foreground:true});
  assert.throws(()=>bridge.args(['--pair']));assert.throws(()=>bridge.args(['unexpected']));
});
test('pair an explicit OPAYA profile using the native adapter; store credentials only in a private local file',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'opaya-cord-')),previous=process.env.CORD_HOME;process.env.CORD_HOME=path.join(dir,'cord');
  const profile=path.join(dir,'profile');fs.mkdirSync(profile);
  fs.writeFileSync(path.join(profile,'workspace.json'),JSON.stringify({agents:[{id:'local-agent',name:'Local test runtime',provider:'claude',protocol:'claude',transport:'local',command:process.execPath,args:[],cwd:dir}],hosts:[]}));
  let enrollment;
  const server=http.createServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;enrollment=JSON.parse(raw);res.writeHead(201,{'content-type':'application/json'});res.end(JSON.stringify({ok:true,agentId:'paired-agent',deviceId:'device',token:'private-test-token'}));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try{
    const file=await bridge.pair({server:`http://127.0.0.1:${server.address().port}`,pair:'one-time-code',runtime:'opaya','opaya-profile':profile,'opaya-agent':'local-agent',cwd:dir});
    const config=JSON.parse(fs.readFileSync(file,'utf8'));assert.equal(config.local.agent.id,'local-agent');assert.equal(config.local.cwd,dir);assert.equal(config.token,'private-test-token');assert.equal(enrollment.runtime,'opaya');assert.equal(enrollment.code,'one-time-code');
    assert.ok(!JSON.stringify(enrollment).includes('private-test-token'));
  }finally{await new Promise(r=>server.close(r));if(previous===undefined)delete process.env.CORD_HOME;else process.env.CORD_HOME=previous;fs.rmSync(dir,{recursive:true,force:true});}
});
