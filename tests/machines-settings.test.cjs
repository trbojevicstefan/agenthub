'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const {execFileSync}=require('node:child_process');
const {Broker}=require('../desktop/broker.cjs');const {Store,Vault}=require('../desktop/store.cjs');const {temp,secure}=require('./helpers.cjs');
const vps=require('../desktop/vps.cjs');

test('the machine probe reads the system, tools and free space, and leaves out what a server lacks',()=>{
  const r=vps.parseProbe('OPAYA_OK\nLinux x86_64\nhost=vps-1\nos=Ubuntu 24.04.1 LTS\nuptime=3 days, 4 hours\ndisk=38G free of 50G\nmemory=1.2Gi free of 3.8Gi\ntool=docker\ntool=git\ntool=hermes\ntool=hermes\ntool=rm -rf\n');
  assert.deepEqual(r,{ok:true,system:'Linux x86_64',host:'vps-1',os:'Ubuntu 24.04.1 LTS',uptime:'3 days, 4 hours',disk:'38G free of 50G',memory:'1.2Gi free of 3.8Gi',tools:['docker','git','hermes'],docker:true,hermes:true});
  // macOS has no free and no uptime -p: those lines come back empty and the rest still reads.
  const mac=vps.parseProbe('OPAYA_OK\r\nDarwin arm64\r\nhost=mini\r\nuptime=\r\ndisk=200Gi free of 460Gi\r\nmemory=\r\n');
  assert.deepEqual([mac.system,mac.os,mac.uptime,mac.memory,mac.disk,mac.tools,mac.docker],['Darwin arm64','','','','200Gi free of 460Gi',[],false]);
  assert.throws(()=>vps.parseProbe('Permission denied (publickey).'),/Unexpected answer/);
});

test('the machine probe is valid sh and succeeds on a machine without Docker or Hermes',{skip:process.platform==='win32'?'uses POSIX sh':false},()=>{
  const r=vps.parseProbe(execFileSync('sh',['-c',vps.PROBE],{encoding:'utf8',timeout:20000}));
  assert.equal(r.ok,true);assert(r.system.length>0);assert(Array.isArray(r.tools));
});

test('notification, tips, start-up and send-key settings default sensibly and survive a restart',async t=>{
  const root=await temp(t),make=async()=>{const b=new Broker({store:new Store(root),vault:new Vault(root,secure()),emit:()=>{},approve:async()=>true});await b.init();return b;};
  const pick=s=>['notifyReplies','notifyApprovals','notifyJobs','notifySound','tips','autoConnect','sendKey'].map(k=>s[k]);
  const b=await make();
  // Notifications and tips are on, connecting at start is off, and Enter sends until the user says otherwise.
  assert.deepEqual(pick(b.data.settings),[true,true,true,true,true,false,'enter']);
  await b.saveSettings({notifyReplies:false,notifySound:0,tips:false,autoConnect:true,sendKey:'mod-enter'});
  await assert.rejects(()=>b.saveSettings({sendKey:'space'}),/Enter or Ctrl\+Enter/);
  await b.close();
  const again=await make();
  assert.deepEqual(pick(again.data.settings),[false,true,true,false,false,true,'mod-enter']);
  await again.close();
});

test('a finished reply is reported once for notifications, with the agent and the chat it belongs to',async t=>{
  const root=await temp(t),runs=[];
  const factory=options=>({connect:async()=>({description:'Fixture connected'}),close:()=>{},run:ctx=>new Promise((resolve,reject)=>{runs.push({ctx,resolve,reject});ctx.signal.addEventListener('abort',()=>reject(new Error('Cancelled')),{once:true});})});
  const b=new Broker({store:new Store(root),vault:new Vault(root,secure()),emit:()=>{},approve:async()=>true,adapterFactory:factory});await b.init();t.after(()=>b.close());
  const replies=[];b.onReply=(a,c,m)=>replies.push({agent:a.name,conversationId:c.id,status:m.status,content:m.content});
  const a=await b.saveAgent({agent:{name:'Writer',provider:'hermes',protocol:'openai',transport:'http',endpoint:'http://127.0.0.1:8642/v1',model:'hermes-agent'}});
  await b.connect(a.id);
  const sent=await b.send({agentId:a.id,text:'hello'});let done=b.turns.get(a.id).done;
  runs[0].ctx.onEvent({type:'text',text:'Hi there'});runs[0].resolve({});await done;
  assert.deepEqual(replies,[{agent:'Writer',conversationId:sent.conversationId,status:'done',content:'Hi there'}]);
  // A turn the user stops is not a reply worth a notification.
  await b.send({agentId:a.id,conversationId:sent.conversationId,text:'again'});done=b.turns.get(a.id).done;b.stop(a.id);await done;
  assert.equal(replies.length,1);
});
