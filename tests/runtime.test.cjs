'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const {spawn,execFileSync}=require('node:child_process');
const wire=require('../desktop/wire.cjs');
const {allowed}=require('../desktop/runtime-guard.cjs');
// Unix socket paths have a short length limit, so these tests use the system temp folder directly.
const shortTemp=t=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ort-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return fs.realpathSync(dir);};

test('the web runtime guard lets only ssh start',()=>{
  assert.equal(allowed('ssh'),true);assert.equal(allowed('/usr/bin/ssh'),true);
  for(const c of ['sh','/bin/sh','bash','node','docker','tar','git','./ssh','ssh-keygen','sshd',''])assert.equal(allowed(c),false,c);
  // Installed in a child process with OPAYA_RUNTIME=web, before anything loads child_process.
  const out=execFileSync(process.execPath,['-e',`require(${JSON.stringify(path.join(__dirname,'../desktop/runtime-guard.cjs'))}).install();const cp=require('node:child_process');
    const r=[];for(const f of [()=>cp.spawn('/bin/sh',['-c','echo hi']),()=>cp.execFileSync('ls'),()=>cp.exec('ls'),()=>cp.spawnSync('node',['-v'])])try{f();r.push('ran');}catch(e){r.push(e.code);}
    try{cp.spawnSync('ssh',['-V']);r.push('ssh');}catch(e){r.push('ssh '+e.code);}process.stdout.write(r.join(','));`],{env:{...process.env,OPAYA_RUNTIME:'web'},encoding:'utf8'});
  assert.equal(out,'OPAYA_LOCAL_OFF,OPAYA_LOCAL_OFF,OPAYA_LOCAL_OFF,OPAYA_LOCAL_OFF,ssh');
  // The desktop app is not touched.
  const desktop=execFileSync(process.execPath,['-e',`require(${JSON.stringify(path.join(__dirname,'../desktop/runtime-guard.cjs'))}).install();process.stdout.write(require('node:child_process').execFileSync(process.execPath,['-e','process.stdout.write("ran")'],{encoding:'utf8'}))`],{env:{...process.env,OPAYA_RUNTIME:''},encoding:'utf8'});
  assert.equal(desktop,'ran');
});

test('the session service runs under plain Node as a web runtime, with the remote Vault and no local agents',{skip:process.platform==='win32'&&'web runtimes run on Linux'},async t=>{
  const dir=shortTemp(t),data=path.join(dir,'data'),home=path.join(dir,'home');fs.mkdirSync(data);fs.mkdirSync(home);
  // The web server's side of the Vault socket (web/src/runtime/vault-socket.ts), with a map for the KMS store.
  const values=new Map([['s_existing',JSON.stringify('value-1')]]),vaultToken='c'.repeat(64);
  const vault=wire.server({token:vaultToken,snapshot:()=>null,dispatch:async(m,x)=>{if(m==='vaultLoad')return Object.fromEntries(values);if(m==='vaultSet'){values.set(x.key,x.value);return;}if(m==='vaultRemove'){values.delete(x.key);return;}throw new Error('no');}});
  await new Promise(r=>vault.listen(path.join(data,'vault.sock'),r));t.after(()=>vault.close());
  const child=spawn(process.execPath,[path.join(__dirname,'../desktop/runtime.cjs')],{env:{...process.env,OPAYA_DATA:data,HOME:home,OPAYA_VAULT_TOKEN:vaultToken,OPAYA_HOST_LIMIT:'2',OPAYA_ACCOUNT_URL:'https://app.opaya.dev'},stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
  t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
  const descriptor=path.join(data,'session-service.json');
  for(let i=0;i<100&&!fs.existsSync(descriptor);i++)await new Promise(r=>setTimeout(r,100));
  assert.ok(fs.existsSync(descriptor),output);
  const client=await wire.connect(wire.endpoint(data),JSON.parse(fs.readFileSync(descriptor,'utf8')).token);
  const snapshot=await client.call('snapshot');
  assert.equal(snapshot.runtime,'web');assert.deepEqual(snapshot.account,{enabled:false},'no desktop account in a container');
  await assert.rejects(client.call('saveAgent',{agent:{name:'local',provider:'codex',protocol:'codex',transport:'local',command:'codex',args:[]}}),/only in the desktop app/);
  await assert.rejects(client.call('saveAgent',{agent:{name:'loop',provider:'custom',protocol:'openai',transport:'http',endpoint:'http://127.0.0.1:8642/v1'}}),/only in the desktop app/);
  const saved=await client.call('saveAgent',{agent:{name:'api',provider:'custom',protocol:'openai',transport:'http',endpoint:'https://api.example.com/v1'},token:'tok-123'});
  assert.equal(values.get(saved.id),'tok-123','the token went to the server Vault');
  for(const [method,input] of [['terminalOpen',{local:true}],['discover',{}],['installFramework',{id:'hermes'}],['opayaFreeModels',{}],['files',{path:'/'}]])await assert.rejects(client.call(method,input),/In the web app/,method);
  // The plan's limit comes from the web server: 2 machines.
  await client.call('saveHost',{name:'one',hostname:'203.0.113.1',username:'root',port:22});await client.call('saveHost',{name:'two',hostname:'203.0.113.2',username:'root',port:22});
  await assert.rejects(client.call('saveHost',{name:'three',hostname:'203.0.113.3',username:'root',port:22}),/Your plan allows 2 remote machines/);
  await client.call('shutdown').catch(()=>{});client.close();
  await new Promise(r=>child.exitCode!==null?r():child.once('exit',r));
});
