'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {temp,secure}=require('./helpers.cjs');
const {Broker}=require('../desktop/broker.cjs'),{Store,Vault}=require('../desktop/store.cjs');
const {Terminals,tmuxName,tmuxCommand}=require('../desktop/terminal.cjs');
const wire=require('../desktop/wire.cjs'),schema=require('../desktop/schema.cjs');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function broker(root,adapterFactory){const b=new Broker({store:new Store(root),vault:new Vault(root,secure()),emit:()=>{},approve:async()=>true,adapterFactory});await b.init();return b;}
const agent=(id,port=8642)=>({id,name:id,provider:'hermes',protocol:'openai',transport:'http',endpoint:`http://127.0.0.1:${port}/v1`});
test('conversation drafts, native session IDs and selected conversations survive service restart',async t=>{
  const root=await temp(t),b=await broker(root);const a=await b.saveAgent({agent:agent('one')}),d=await b.saveAgent({agent:agent('two',8643)});
  const first=await b.newConversation(a.id),second=await b.newConversation(a.id),other=await b.newConversation(d.id);
  first.externalSessionId='actual-provider-session';await b.saveDraft({agentId:a.id,conversationId:first.id,text:'first draft'});await b.saveDraft({agentId:a.id,conversationId:second.id,text:'second draft'});
  await b.selectConversation(first.id);await b.select(d.id);await b.select(a.id);assert.equal(b.data.activeConversationId,first.id);
  await b.saveView({overview:false,terminalVisible:true,terminalId:'terminal-one'});await b.close();
  const restored=await broker(root);assert.equal(restored.data.activeConversationId,first.id);assert.equal(restored.data.drafts[first.id],'first draft');assert.equal(restored.data.drafts[second.id],'second draft');assert.equal(restored.data.conversations[0].externalSessionId,'actual-provider-session');assert.equal(restored.data.view.terminalVisible,true);
  await assert.rejects(()=>restored.saveDraft({agentId:a.id,conversationId:other.id,text:'cross-agent leak'}),/does not belong/);await restored.close();
});
test('partial output is checkpointed before completion and is recovered without silently retrying a task',async t=>{
  const root=await temp(t);let context;
  const b=await broker(root,()=>({connect:async()=>({}),close(){},run:ctx=>{context=ctx;return new Promise((resolve,reject)=>ctx.signal.addEventListener('abort',()=>reject(new Error('stopped')),{once:true}));}}));
  t.after(()=>b.close());const a=await b.saveAgent({agent:agent('one')});await b.connect(a.id);const c=await b.send({agentId:a.id,text:'work'});context.onEvent({type:'text',text:'already generated'});
  await delay(1000);const disk=await b.store.transcript(c.conversationId);assert.equal(disk[1].content,'already generated');assert.equal(disk[1].status,'streaming');
  const recoveryRoot=path.join(root,'crash-copy');await fs.mkdir(recoveryRoot);await fs.cp(path.join(root,'workspace.json'),path.join(recoveryRoot,'workspace.json'));await fs.cp(path.join(root,'conversations'),path.join(recoveryRoot,'conversations'),{recursive:true});
  const restored=await broker(recoveryRoot);const recovered=restored.histories.get(c.conversationId)[1];assert.equal(recovered.status,'error');assert.equal(recovered.content,'already generated');assert.equal(restored.turns.size,0);assert.equal((await restored.store.transcript(c.conversationId))[1].status,'error');await restored.close();
});
test('corrupt workspace is preserved and the last valid backup is loaded',async t=>{
  const root=await temp(t),store=new Store(root);await store.write({version:1,agents:[],hosts:[],conversations:[],label:'backup'});await store.write({version:1,agents:[],hosts:[],conversations:[],label:'latest'});await fs.writeFile(path.join(root,'workspace.json'),'{broken');const data=await store.load();assert.equal(data.label,'backup');assert(data.recoveryNotice);assert((await fs.readdir(root)).some(f=>f.includes('.corrupt.json')));
});
test('IPC rejects bad credentials and a window disconnect does not stop the session host',async t=>{
  const root=await temp(t),token='a'.repeat(64);let counter=0;const server=wire.server({token,snapshot:()=>({counter}),dispatch:async method=>{if(method!=='increment')throw new Error('Unsupported');return ++counter;}});
  const address=wire.endpoint(root);await new Promise((r,j)=>{server.once('error',j);server.listen(address,r);});t.after(()=>{for(const socket of server.clients)socket.destroy();return new Promise(r=>server.close(r));});
  await assert.rejects(()=>wire.connect(address,'b'.repeat(64),1000),/rejected/);const first=await wire.connect(address,token);assert.equal(await first.call('increment'),1);first.close();await delay(20);assert(server.listening);
  const second=await wire.connect(address,token);assert.equal(await second.call('increment'),2);await assert.rejects(()=>second.call('eval'),/Unsupported/);second.close();
});
test('IPC tokens reject multibyte text without throwing',()=>{assert.equal(wire.sameToken('a'.repeat(64),'\u00e9'.repeat(64)),false);assert.equal(wire.sameToken('a'.repeat(64),'a'.repeat(64)),true);});
test('quick SSH address parser handles aliases, users, custom ports and IPv6 without shell interpolation',()=>{
  assert.equal(schema.host({address:'production'}).alias,'production');const a=schema.host({address:'ssh ops@example.org:2222'});assert.equal(a.username,'ops');assert.equal(a.hostname,'example.org');assert.equal(a.port,2222);
  assert.equal(schema.host({address:'ssh://root@[2001:db8::1]:2200'}).hostname,'2001:db8::1');
  for(const address of ['ssh://user:password@host','user@host/path','user@host;echo pwn','-oProxyCommand=bad','ssh://host?command=bad'])assert.throws(()=>schema.host({address}));
});
test('tmux session names are deterministic and existing sessions attach rather than duplicate',()=>{
  assert.equal(tmuxName({id:'same-agent'},'shell'),tmuxName({id:'same-agent'},'shell'));assert.notEqual(tmuxName({id:'same-agent'},'shell'),tmuxName({id:'same-agent'},'agent'));
  const newCommand=tmuxCommand('session-one',"printf '%s' hello");assert(newCommand.includes('new-session -A'));const existing=tmuxCommand('session-one','',{existing:true});assert(existing.includes('attach-session'));assert(!existing.includes('new-session'));
});
test('terminal scrollback survives service restart and is explicitly marked archived, not falsely live',async t=>{
  const root=await temp(t);let data;const terminals=new Terminals(()=>{},{root,ptyFactory:{spawn:()=>({onData(fn){data=fn;},onExit(){},write(){},resize(){},kill(){}})}});
  const item=terminals.open({id:'local-shell',name:'Local',provider:'custom',transport:'local',command:'',args:[],cwd:root},null,'shell',{cols:100,rows:24});data('retained terminal output');await terminals.shutdown();
  const next=new Terminals(()=>{},{root});await next.init();const restored=next.attach(item.id);assert(restored.buffer.includes('retained terminal output'));assert.equal(restored.exited,true);assert.equal(next.describe()[0].restored,true);await next.shutdown();
});
