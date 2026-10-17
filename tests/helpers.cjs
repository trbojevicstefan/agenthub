'use strict';
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {EventEmitter}=require('node:events');
const {PassThrough}=require('node:stream');
// macOS tmpdir is behind the /var -> /private/var symlink; child processes report the resolved path.
async function temp(t){const made=await fs.mkdtemp(path.join(os.tmpdir(),'agenthub-test-')),dir=process.platform==='win32'?made:await fs.realpath(made);t.after(()=>fs.rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:50}));return dir;}
function childMock(handler=()=>{}){
  const child=new EventEmitter();Object.assign(child,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),exitCode:null,signalCode:null,frames:[]});
  child.kill=()=>{if(child.exitCode!==null)return;child.exitCode=0;queueMicrotask(()=>child.emit('close',0));};
  child.send=message=>child.stdout.write(JSON.stringify(message)+'\n');
  child.reply=(request,result)=>child.send({id:request.id,result});
  let pending='';child.stdin.on('data',chunk=>{pending+=chunk.toString();let i;while((i=pending.indexOf('\n'))>=0){const line=pending.slice(0,i);pending=pending.slice(i+1);if(!line.trim())continue;const message=JSON.parse(line);child.frames.push(message);handler(message,child);}});
  return child;
}
function context(overrides={}){return {text:'hello',messages:[{role:'user',content:'hello',status:'done'}],conversation:{id:'conversation-one',externalSessionId:''},signal:new AbortController().signal,onEvent:()=>{},onSession:async()=>{},...overrides};}
function secure(){return {isEncryptionAvailable:()=>true,getSelectedStorageBackend:()=> 'test-only',encryptString:s=>Buffer.from('test-encrypted:'+s),decryptString:b=>b.toString().replace(/^test-encrypted:/,'')};}
// OpenClaw's SQLite stores under `home`, made with python3: credentials (`secrets`) next to other state (`state`), and
// a leftover -wal file. Skip a test with `noPython` where python3 or its sqlite3 module is missing.
const {execFileSync}=require('node:child_process');
const noPython=(()=>{try{execFileSync('python3',['-c','import sqlite3'],{stdio:'ignore'});return false;}catch{return 'needs python3 with sqlite3';}})();
async function openclawStores(home){
  const make=async(file,sql)=>{await fs.mkdir(path.dirname(path.join(home,file)),{recursive:true});execFileSync('python3',['-c','import sqlite3,sys\nd=sqlite3.connect(sys.argv[1])\nd.executescript(sys.argv[2])\nd.commit()\nd.close()',path.join(home,file),sql]);};
  await make('.openclaw/state/openclaw.sqlite',`CREATE TABLE secret_store_entries(name TEXT,value TEXT);INSERT INTO secret_store_entries VALUES('OPENCLAW_GATEWAY_TOKEN','SECRET-STORE-VALUE');
    CREATE TABLE config_machine_state(state_key TEXT PRIMARY KEY,value_json TEXT);INSERT INTO config_machine_state VALUES('authProfiles.store','{"key":"sk-SHARED-AUTH"}'),('ui.theme','"dark-theme"');
    CREATE TABLE device_identities(identity_key TEXT,private_key_pem TEXT);INSERT INTO device_identities VALUES('cli','PRIVATE-PEM-VALUE');
    CREATE TABLE cron_jobs(id TEXT,name TEXT);INSERT INTO cron_jobs VALUES('j1','daily-brief');`);
  await make('.openclaw/agents/main/agent/openclaw-agent.sqlite',`CREATE TABLE auth_profile_store(store_key TEXT,store_json TEXT);INSERT INTO auth_profile_store VALUES('local','{"key":"sk-AGENT-AUTH"}');
    CREATE TABLE transcript_events(id TEXT,body TEXT);INSERT INTO transcript_events VALUES('e1','hello transcript');`);
  await fs.writeFile(path.join(home,'.openclaw/state/openclaw.sqlite-wal'),'WAL-SECRET-VALUE');
  return {secrets:['SECRET-STORE-VALUE','sk-SHARED-AUTH','PRIVATE-PEM-VALUE','sk-AGENT-AUTH'],state:{'.openclaw/state/openclaw.sqlite':['daily-brief','dark-theme'],'.openclaw/agents/main/agent/openclaw-agent.sqlite':['hello transcript']}};
}
module.exports={temp,childMock,context,secure,noPython,openclawStores};
