'use strict';
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {EventEmitter}=require('node:events');
const {PassThrough}=require('node:stream');
async function temp(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'agenthub-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}
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
module.exports={temp,childMock,context,secure};
