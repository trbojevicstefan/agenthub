'use strict';
const path=require('node:path');
const {execFile}=require('node:child_process');
const {findExecutable,environment}=require('./process.cjs');
const schema=require('./schema.cjs');
// System Node cannot load app.asar. Extract only runtime source modules, never the Vault or profile data.
function prepareRuntime(root){
  const fs=require('node:fs'),{createHash}=require('node:crypto');
  const source=path.resolve(__dirname,'..'),files=require('../scripts/cord/runtime-files.json');
  const contents=files.map(name=>({name,content:fs.readFileSync(path.join(source,name))}));
  const digest=createHash('sha256');for(const file of contents)digest.update(file.name).update(file.content);
  const destination=path.join(root,'cord-runtime',digest.digest('hex'));
  for(const {name,content} of contents){const file=path.join(destination,name);if(fs.existsSync(file))continue;fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});fs.writeFileSync(file,content,{mode:0o600});}
  return path.join(destination,'scripts/cord/runner.cjs');
}
function validate(input){
  const url=new URL(String(input.server||''));
  if(url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('Use your Cord server origin without a path.');
  if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)))throw new Error('Remote Cord connections require HTTPS.');
  if(!/^[a-f0-9]{48}$/.test(String(input.code||'')))throw new Error('Paste a current Cord connection prompt or its 48-character pairing code.');
  return {server:url.origin,code:input.code,agentId:schema.id(input.agentId)};
}
async function connect(input,{root,agents,exec=execFile}={}){
  const value=validate(input),agent=agents.find(a=>a.id===value.agentId);
  if(!agent||!['claude','codex','acp','openai'].includes(agent.protocol))throw new Error('Choose a compatible OPAYA chat agent.');
  const env={...environment(),ELECTRON_RUN_AS_NODE:'1'},node=findExecutable('node',env)||process.execPath;
  const args=[prepareRuntime(root),'--server',value.server,'--pair',value.code,'--runtime','opaya','--opaya-profile',root,'--opaya-agent',agent.id,'--cwd',require('node:os').homedir()];
  const output=await new Promise((resolve,reject)=>exec(node,args,{env,windowsHide:true,timeout:90000,maxBuffer:128*1024},(error,stdout,stderr)=>error?reject(new Error(String(stderr||error.message).slice(0,700))):resolve(stdout)));
  return {message:'Paired with Cord. The background bridge uses this OPAYA agent, its Vault, tools and native approvals.',status:output.trim()};
}
module.exports={connect,validate,prepareRuntime};
