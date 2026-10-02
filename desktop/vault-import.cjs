'use strict';
// Import into the Opaya Vault: secrets found in a .env, a JSON or YAML settings file or any text file, in pasted text,
// or in the tools on this computer (the agents' own key files, shell profiles, the environment Opaya started with, the
// GitHub CLI, npm, AWS and Hugging Face). A scan returns names, masks and where each was found; values stay in the
// session service until the user picks what to keep (see OpayaAgent.vaultImportScan / vaultImportCommit).
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const secrets=require('./secrets.cjs');
const MAX_BYTES=1048576;
// Secrets in text: NAME=value lines (export, quotes and comments as dotenv reads them) with names that say "key",
// "token", "secret" or "password", then every known key format, NAME: value and "name": "value" pairs and private keys.
// Unknown random-looking runs only with `long` (pasted text), where the user chose what to paste. Each value once.
function scanText(text,{long=false,rename={}}={}){
  text=String(text??'').replace(/^﻿/,'');const out=[],seen=new Set();
  const add=(name,value)=>{value=String(value??'').trim();if(!value||seen.has(value)||!secrets.plausible(value)&&!/^-----BEGIN /.test(value))return;seen.add(value);
    // Names as tools write them (aws_secret_access_key, apiKey) become the usual UPPER_SNAKE variable.
    let n=rename[name]||name;if(/[a-z]/.test(n))n=n.replace(/([a-z0-9])([A-Z])/g,'$1_$2').toUpperCase();try{n=secrets.envName(n,'API_KEY');}catch{n='API_KEY';}out.push({name:n,value});};
  for(const [name,value] of Object.entries(secrets.parseEnv(text)))if(secrets.secretName(name))add(name,value);
  for(const s of secrets.detect(text,{long,phrase:false}))add(s.name,s.value);
  return out;
}
// A file the user chose: text up to 1 MB. Binary files (a NUL byte) are refused.
async function readTextFile(file){
  file=String(file||'');if(!path.isAbsolute(file))throw new Error('Choose a file.');
  const info=await fs.stat(file).catch(error=>{throw new Error(error.code==='ENOENT'?`${file} does not exist.`:error.message);});
  if(!info.isFile())throw new Error(`${file} is not a file.`);if(info.size>MAX_BYTES)throw new Error(`${path.basename(file)} is larger than 1 MB. Choose a .env or settings file.`);
  const text=await fs.readFile(file,'utf8');if(text.includes('\0'))throw new Error(`${path.basename(file)} is not a text file.`);
  return text;
}
// Files of tools on this computer that keep keys, with the names their own settings use renamed to the usual variables.
function toolFiles({home=os.homedir(),platform=process.platform,env=process.env}={}){
  const appData=env.APPDATA||path.join(home,'AppData','Roaming'),config=env.XDG_CONFIG_HOME||path.join(home,'.config');
  return [
    {id:'env-file',label:'.env in your home folder',file:path.join(home,'.env')},
    ...['.bashrc','.bash_profile','.profile','.zshrc','.zprofile','.zshenv'].map(f=>({id:'shell'+f,label:`Shell profile ${f}`,file:path.join(home,f)})),
    {id:'gh',label:'GitHub CLI',file:platform==='win32'?path.join(appData,'GitHub CLI','hosts.yml'):path.join(config,'gh','hosts.yml')},
    {id:'npm',label:'npm',file:path.join(home,'.npmrc'),rename:{AUTH_TOKEN:'NPM_TOKEN',_authToken:'NPM_TOKEN'}},
    {id:'aws',label:'AWS CLI',file:path.join(home,'.aws','credentials')},
    {id:'hf',label:'Hugging Face',file:path.join(env.HF_HOME||path.join(home,'.cache','huggingface'),'token')}
  ];
}
// The environment Opaya's session service started with: variables named like keys.
function environmentSecrets(env=process.env){
  const text=Object.entries(env).filter(([k,v])=>secrets.secretName(k)&&typeof v==='string'&&v).map(([k,v])=>`${k}=${JSON.stringify(v)}`).join('\n');
  return scanText(text);
}
// Each source with what it holds: tools' files, the environment and every agent's own key file (read with
// transfer.readKeys, the same reader Share and the key button use). An agent that cannot be read in time is listed
// with the reason; files that do not exist are left out.
async function scanTools({agents=[],hostOf=()=>null,readKeys,vault,home,platform,env,timeout=12000}={}){
  const sources=[];
  for(const t of toolFiles({home,platform,env})){
    let text;try{text=await readTextFile(t.file);}catch{continue;}
    const items=scanText(text,{rename:t.rename});if(items.length)sources.push({id:t.id,label:t.label,path:t.file,items});
  }
  const fromEnv=environmentSecrets(env);if(fromEnv.length)sources.push({id:'environment',label:'Opaya\'s environment',path:'Variables Opaya was started with',items:fromEnv});
  if(readKeys){
    const within=(promise,label)=>Promise.race([promise,new Promise((_,reject)=>setTimeout(()=>reject(new Error(`${label} did not answer in time.`)),timeout).unref?.())]);
    const results=await Promise.all(agents.filter(a=>!a.ephemeral).map(async a=>{
      try{const r=await within(readKeys(a,hostOf(a),{vault}),a.name);const items=[...r.values].map(([name,value])=>({name,value})).filter(x=>secrets.plausible(x.value));return {id:`agent:${a.id}`,agentId:a.id,label:a.name,path:r.file||'',items};}
      catch(error){return {id:`agent:${a.id}`,agentId:a.id,label:a.name,path:'',items:[],error:String(error?.message||error).slice(0,200)};}
    }));
    sources.push(...results.filter(r=>r.items.length||r.error&&!/does not know where|only over HTTP/.test(r.error)));
  }
  return sources;
}
module.exports={scanText,readTextFile,toolFiles,environmentSecrets,scanTools,MAX_BYTES};
