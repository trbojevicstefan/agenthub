'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {temp,secure}=require('./helpers.cjs');
const {Broker}=require('../desktop/broker.cjs'),{Store,Vault}=require('../desktop/store.cjs');
const {Terminals,tmuxName,tmuxCommand,dockerShellArgs}=require('../desktop/terminal.cjs');
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
  let disk=[];for(let i=0;i<100&&disk[1]?.content!=='already generated';i++){await delay(100);disk=await b.store.transcript(c.conversationId);}assert.equal(disk[1].content,'already generated');assert.equal(disk[1].status,'streaming');
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
  const newCommand=tmuxCommand('session-one',"printf '%s' hello");assert(newCommand.includes('new-session -A'));assert(newCommand.includes('TERM="${TERM:-xterm-256color}"'));const existing=tmuxCommand('session-one','',{existing:true});assert(existing.includes('attach-session'));assert(!existing.includes('new-session'));
});
test('terminal scrollback survives service restart and is explicitly marked archived, not falsely live',async t=>{
  const root=await temp(t);let data;const terminals=new Terminals(()=>{},{root,ptyFactory:{spawn:()=>({onData(fn){data=fn;},onExit(){},write(){},resize(){},kill(){}})}});
  const item=terminals.open({id:'local-shell',name:'Local',provider:'custom',transport:'local',command:'',args:[],cwd:root},null,'shell',{cols:100,rows:24});data('retained terminal output');await terminals.shutdown();
  const next=new Terminals(()=>{},{root});await next.init();const restored=next.attach(item.id);assert(restored.buffer.includes('retained terminal output'));assert.equal(restored.exited,true);assert.equal(next.describe()[0].restored,true);await next.shutdown();
});
test('remote Docker shell opens inside the container with terminal capabilities',()=>{
  const spawned=[],terminals=new Terminals(()=>{},{ptyFactory:{spawn:(command,args,options)=>{const p={onData(){},onExit(){},write(){},resize(){},kill(){}};spawned.push({command,args,options});return p;}}});
  const agent={id:'docker-agent',name:'Hermes Docker',provider:'hermes',transport:'ssh',command:'docker',args:['exec','-i','a2a-hermes-leads','hermes'],cwd:'/opt/data',hermesHome:'/opt/data'};
  assert.deepEqual(dockerShellArgs(agent),['exec','-it','a2a-hermes-leads','sh','-l']);
  terminals.open(agent,{alias:'hostinger'},'shell');
  assert.equal(spawned[0].options.env.TERM,'xterm-256color');
  const remote=spawned[0].args.at(-1);
  assert(remote.includes('docker'));
  assert(remote.includes('exec'));
  assert(remote.includes('-it'));
  assert(remote.includes('a2a-hermes-leads'));
  assert(remote.includes('sh'));
  assert(!remote.includes("cd '/opt/data'"));
});
test('remote terminal detach closes only the local PTY and keeps scrollback',()=>{
  const events=[],spawned=[],terminals=new Terminals(e=>events.push(e),{ptyFactory:{spawn:(command,args,options)=>{const p={onData(){},onExit(fn){p.exit=fn;},write(){},resize(){},kill(){p.killed=true;}};spawned.push(p);return p;}}});
  const item=terminals.open({id:'remote-agent',name:'Remote',provider:'custom',transport:'ssh',hostId:'h',command:'',args:[],cwd:''},{alias:'hostinger'},'shell');
  assert.equal(terminals.detach(item.id),true);
  assert.equal(spawned[0].killed,true);
  assert.equal(terminals.attach(item.id).exited,true);
  assert.equal(events.at(-1).exitCode,'detached');
  assert.throws(()=>terminals.detach(terminals.open({id:'local-agent',name:'Local',provider:'custom',transport:'local',command:'',args:[],cwd:process.cwd()},null,'shell').id),/Only remote/);
});
test('service install terminals over SSH pass the command to ssh and do not require tmux',()=>{
  const spawned=[],terminals=new Terminals(()=>{},{ptyFactory:{spawn:(command,args)=>{spawned.push(args);return {onData(){},onExit(){},write(){},resize(){},kill(){}};}}});
  terminals.open({id:'svc_install_codex_h',name:'Install Codex',provider:'custom',transport:'ssh',hostId:'h',command:'',args:[],cwd:'',ephemeral:true,run:'npm install -g @openai/codex'},{alias:'vps'},'shell');
  const remote=spawned[0].at(-1);
  assert.match(remote,/^npm install -g @openai\/codex; /);assert.doesNotMatch(remote,/tmux/);
  terminals.open({id:'regular',name:'Regular',provider:'custom',transport:'ssh',hostId:'h',command:'',args:[],cwd:''},{alias:'vps'},'shell');
  assert.match(spawned[1].at(-1),/tmux/);
});
test('a terminal can start an agent CLI in a project folder, one session per folder, and remembers its size',async t=>{
  const {withWorkdir}=require('../desktop/terminal.cjs');
  const one=await temp(t),two=await temp(t),spawned=[];
  const terminals=new Terminals(()=>{},{ptyFactory:{spawn:(command,args,options)=>{spawned.push({command,args,options});return {onData(){},onExit(){},write(){},resize(){},kill(){}};}}});
  const agent={id:'cli',name:'Node CLI',provider:'custom',protocol:'acp',transport:'local',command:'node',args:[]};
  const a=terminals.open(agent,null,'agent',{cols:90,rows:20},{cwd:one,title:'Node CLI · Site'});
  assert.equal(spawned[0].options.cwd,one);assert.equal(a.title,'Node CLI · Site');assert.equal(a.cwd,one);assert.deepEqual([a.cols,a.rows],[90,20]);
  assert.equal(terminals.open(agent,null,'agent',{cols:90,rows:20},{cwd:one}).id,a.id,'the same folder reuses its session');
  terminals.open(agent,null,'agent',{cols:90,rows:20},{cwd:two});assert.equal(spawned.length,2);assert.equal(spawned[1].options.cwd,two);
  assert.throws(()=>terminals.open(agent,null,'agent',{cols:90,rows:20},{cwd:path.join(one,'missing')}),/does not exist/);
  terminals.resize(a.id,120,40);assert.deepEqual([terminals.attach(a.id).cols,terminals.attach(a.id).rows],[120,40]);
  assert.deepEqual(withWorkdir(['exec','-it','-e','TERM=xterm-256color','box','codex'],'/root/site'),['exec','-it','-e','TERM=xterm-256color','-w','/root/site','box','codex']);
  assert.deepEqual(withWorkdir(['exec','-it','box','sh'],''),['exec','-it','box','sh']);
});
// A fake node-pty that remembers each process, so a test can end it or send output from it.
function fakePty(){const spawned=[];return {spawned,ptyFactory:{spawn:(command,args,options)=>{const p={command,args,options,writes:[],onData(fn){p.data=fn;},onExit(fn){p.exit=fn;},write(s){p.writes.push(s);},resize(){},kill(){p.killed=true;}};spawned.push(p);return p;}}};}
test('an ended terminal starts again in its tab: same id, output kept, the old process ignored, input works again',async t=>{
  const root=await temp(t),events=[],{spawned,ptyFactory}=fakePty(),terminals=new Terminals(e=>events.push(e),{root,ptyFactory});
  const shell={id:'local-shell',name:'This computer',provider:'custom',transport:'local',command:'',args:[],cwd:root};
  const item=terminals.open(shell,null,'shell',{cols:100,rows:24});spawned[0].data('first run\r\n');spawned[0].exit({exitCode:0});
  assert.equal(terminals.attach(item.id).exited,true);assert.throws(()=>terminals.write(item.id,'ls\r'),/Press Enter/);
  const again=terminals.restart(item.id,shell,null,{cols:90,rows:20});
  assert.equal(again.id,item.id);assert.equal(again.exited,false);assert.equal(spawned.length,2);assert.deepEqual([spawned[1].command,spawned[1].args,spawned[1].options.cwd],[spawned[0].command,spawned[0].args,spawned[0].options.cwd]);
  assert.deepEqual([again.cols,again.rows],[90,20]);assert.match(again.buffer,/first run[\s\S]*Started again/);
  const exit=events.find(e=>e.type==='exit'),restarted=events.find(e=>e.type==='restarted');assert(restarted.seq>exit.seq,'windows see the restart after the exit');assert.equal(events.at(-1).type,'data');assert.equal(events.at(-1).seq,again.seq);
  // The old process's late output and exit do not end or pollute the new session.
  spawned[0].data('late');spawned[0].exit({exitCode:1});assert.equal(terminals.attach(item.id).exited,false);assert(!terminals.attach(item.id).buffer.includes('late'));
  terminals.write(item.id,'ls\r');assert.deepEqual(spawned[1].writes,['ls\r']);assert.deepEqual(spawned[0].writes,[]);
  assert.equal(terminals.restart(item.id,shell,null,{cols:90,rows:20}).id,item.id);assert.equal(spawned.length,2,'a live session is not started twice');
  // Restart keeps this session even when another session has the same agent, mode and folder.
  spawned[1].exit({exitCode:0});const twin=terminals.open(shell,null,'shell',{cols:100,rows:24});assert.notEqual(twin.id,item.id);
  assert.notEqual(item.id,twin.id);assert.equal(terminals.restart(item.id,shell,null,{cols:90,rows:20}).id,item.id);assert.equal(spawned.length,4);
  assert.throws(()=>terminals.restart('missing',shell,null,{cols:90,rows:20}),/not found/);
  await terminals.shutdown();
});
test('saved output from before an Opaya restart can be started again in the same tab',async t=>{
  const root=await temp(t),{spawned,ptyFactory}=fakePty(),first=new Terminals(()=>{},{root,ptyFactory});
  const shell={id:'local-shell',name:'This computer',provider:'custom',transport:'local',command:'',args:[],cwd:root};
  const item=first.open(shell,null,'shell',{cols:100,rows:24},{cwd:root,title:'Work'});spawned[0].data('before the restart');await first.shutdown();
  const next=new Terminals(()=>{},{root,ptyFactory});await next.init();assert.equal(next.attach(item.id).restored,true);
  const again=next.restart(item.id,shell,null,{cols:100,rows:24});
  assert.equal(again.id,item.id);assert.equal(again.restored,false);assert.equal(again.exited,false);assert.equal(again.title,'Work');assert.equal(spawned.at(-1).options.cwd,root);assert.match(again.buffer,/before the restart/);
  await next.shutdown();
});
test('a remote terminal whose SSH connection dropped reattaches to the same tmux session',async t=>{
  // A stand-in ssh on PATH: the terminal only needs to find the client, the fake PTY never runs it.
  const bin=await temp(t);await fs.writeFile(path.join(bin,'ssh'),'#!/bin/sh\nexit 0\n',{mode:0o755});const old=process.env.PATH;process.env.PATH=bin+path.delimiter+old;t.after(()=>{process.env.PATH=old;});
  const events=[],{spawned,ptyFactory}=fakePty(),terminals=new Terminals(e=>events.push(e),{ptyFactory});
  const agent={id:'remote-agent',name:'Remote',provider:'custom',transport:'ssh',hostId:'h1',command:'',args:[],cwd:''},host={id:'h1',alias:'vps'};
  const item=terminals.open(agent,host,'shell');assert.equal(terminals.describe()[0].hostId,'h1');
  spawned[0].exit({exitCode:255});assert.equal(terminals.attach(item.id).exited,true);
  const again=terminals.restart(item.id,agent,host,{cols:100,rows:28});
  assert.equal(again.id,item.id);assert.deepEqual(spawned[1].args,spawned[0].args);assert.match(spawned[1].args.at(-1),/tmux new-session -A -s/);assert.equal(again.tmuxSession,item.tmuxSession);assert.match(again.buffer,/Reconnecting/);
  // Detached on purpose, then reattached.
  terminals.detach(item.id);assert.equal(terminals.attach(item.id).detached,true);
  const back=terminals.restart(item.id,agent,host,{cols:100,rows:28});assert.equal(back.detached,false);assert.equal(back.exited,false);assert.equal(spawned.length,3);
  spawned[1].exit({exitCode:0});assert.equal(terminals.attach(item.id).exited,false,'the process killed by detach does not end the reattached session');
});
test('independent remote sessions keep distinct tmux identities through reconnect and service restart',async t=>{
  const root=await temp(t),bin=await temp(t);await fs.writeFile(path.join(bin,'ssh'),'#!/bin/sh\nexit 0\n',{mode:0o755});
  const old=process.env.PATH;process.env.PATH=bin+path.delimiter+old;t.after(()=>{process.env.PATH=old;});
  const {spawned,ptyFactory}=fakePty(),terminals=new Terminals(()=>{},{root,ptyFactory});
  const agent={id:'remote-agent',name:'Remote',transport:'ssh',hostId:'h1',command:'',args:[],cwd:'/workspace'},host={id:'h1',alias:'vps'};
  const first=terminals.open(agent,host,'shell',undefined,{newSession:true}),second=terminals.open(agent,host,'shell',undefined,{newSession:true});
  assert.notEqual(first.tmuxSession,second.tmuxSession);assert.notEqual(first.id,second.id);
  spawned[0].exit({exitCode:255});const restarted=terminals.restart(first.id,agent,host,{cols:100,rows:28});
  assert.equal(restarted.id,first.id);assert.equal(restarted.tmuxSession,first.tmuxSession);assert.equal(spawned.at(-1).args.at(-1),spawned[0].args.at(-1));
  const discovered=terminals.open({...agent,id:'discovered',tmuxSession:'existing-session'},host);
  assert.equal(discovered.tmuxSession,'existing-session');assert.match(spawned.at(-1).args.at(-1),/attach-session/);
  const independent=terminals.open({...agent,id:'discovered',tmuxSession:'existing-session'},host,'shell',undefined,{newSession:true});
  assert.notEqual(independent.tmuxSession,'existing-session');assert.match(spawned.at(-1).args.at(-1),/new-session/);
  await terminals.shutdown();const next=new Terminals(()=>{},{root,ptyFactory});await next.init();
  assert.equal(next.restart(second.id,agent,host,{cols:100,rows:28}).tmuxSession,second.tmuxSession);await next.shutdown();
});
