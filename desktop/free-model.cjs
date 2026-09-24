'use strict';
// Free models for the Opaya Agent, out of the box: a local Ollama model that Opaya installs, starts and downloads by
// itself (no account, no key, nothing to type), or picks up automatically when Ollama already runs with a model that
// can call tools. The Opaya Agent cannot do this for itself: it has no model until this is done.
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {findExecutable,environment}=require('./process.cjs');
const OLLAMA='http://127.0.0.1:11434';
// Small open models with tool calling, largest first by quality. Sizes are the download.
const FREE_MODELS=[
  {id:'qwen3:4b',label:'Qwen3 4B',size:'2.5 GB',bytes:2.5e9,note:'Recommended. Good with tools, runs on most computers with 8 GB RAM.'},
  {id:'llama3.2:3b',label:'Llama 3.2 3B',size:'2.0 GB',bytes:2.0e9,note:'Smallest and fastest. For older or low-memory computers.'},
  {id:'qwen3:8b',label:'Qwen3 8B',size:'5.2 GB',bytes:5.2e9,note:'Smarter. Needs 16 GB RAM or a GPU.'}
];
const recommended=()=>os.totalmem()<7.5e9?'llama3.2:3b':'qwen3:4b';
async function ollamaModels(fetchImpl=globalThis.fetch){
  try{const r=await fetchImpl(`${OLLAMA}/api/tags`,{signal:AbortSignal.timeout(2500)});if(!r.ok)return null;const d=await r.json();return (d.models||[]).map(m=>m.name||m.model).filter(Boolean);}catch{return null;}
}
// Models that report tool support (Ollama's /api/show capabilities), known free models first.
async function toolModels(names,fetchImpl=globalThis.fetch){
  const ranked=[...names].sort((a,b)=>rank(a)-rank(b)),out=[];
  for(const name of ranked){
    try{const r=await fetchImpl(`${OLLAMA}/api/show`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:name}),signal:AbortSignal.timeout(4000)});
      const d=r.ok?await r.json():{};if(Array.isArray(d.capabilities)?d.capabilities.includes('tools'):FREE_MODELS.some(f=>f.id===name))out.push(name);}catch{}
  }
  return out;
}
const rank=name=>{const i=FREE_MODELS.findIndex(f=>f.id===name);return i<0?99:i;};
function ollamaBinary(){
  const home=os.homedir(),candidates=process.platform==='win32'?[path.join(process.env.LOCALAPPDATA||path.join(home,'AppData','Local'),'Programs','Ollama','ollama.exe')]
    :process.platform==='darwin'?['/Applications/Ollama.app/Contents/Resources/ollama',path.join(home,'Applications','Ollama.app','Contents','Resources','ollama'),'/opt/homebrew/bin/ollama','/usr/local/bin/ollama']:['/usr/local/bin/ollama','/usr/bin/ollama'];
  return candidates.find(p=>fs.existsSync(p))||findExecutable(process.platform==='win32'?'ollama.exe':'ollama',environment())||'';
}
// Runs a command without a terminal and streams its output lines into the job log.
function exec(command,args,progress,{timeout=20*60*1000}={}){
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{env:environment(),windowsHide:true,stdio:['ignore','pipe','pipe']});let tail='';
    const line=d=>{for(const l of String(d).split(/\r?\n|\r/).map(x=>x.replace(/\x1b\[[0-9;?]*[A-Za-z]/g,'').trim()).filter(Boolean)){tail=(tail+'\n'+l).slice(-1500);progress({message:l.slice(0,300)});}};
    child.stdout.on('data',line);child.stderr.on('data',line);
    const timer=setTimeout(()=>{child.kill();reject(new Error('The install took too long.'));},timeout);
    child.on('error',e=>{clearTimeout(timer);reject(e);});
    child.on('close',code=>{clearTimeout(timer);code===0?resolve(tail):reject(new Error(`${path.basename(command)} exited with ${code}. ${tail.split('\n').slice(-3).join(' ')}`.trim()));});
  });
}
async function installOllama(progress){
  if(process.platform==='win32'){
    const winget=findExecutable('winget.exe',environment());if(!winget)throw new Error('winget is not available. Install Ollama from https://ollama.com/download, then try again.');
    await exec(winget,['install','--id','Ollama.Ollama','-e','--silent','--accept-source-agreements','--accept-package-agreements'],progress);return;
  }
  if(process.platform==='darwin'){
    const brew=findExecutable('brew',environment());
    if(brew){await exec(brew,['install','ollama'],progress);return;}
    // No Homebrew: the official app, unpacked into ~/Applications (no administrator rights needed).
    const dir=path.join(os.homedir(),'Applications'),zip=path.join(os.tmpdir(),`Ollama-darwin-${Date.now()}.zip`);await fsp.mkdir(dir,{recursive:true});
    progress({message:'Downloading Ollama for macOS'});
    const r=await fetch('https://ollama.com/download/Ollama-darwin.zip');if(!r.ok)throw new Error(`Downloading Ollama failed (${r.status}).`);
    await fsp.writeFile(zip,Buffer.from(await r.arrayBuffer()));await exec('/usr/bin/ditto',['-x','-k',zip,dir],progress);await fsp.rm(zip,{force:true});return;
  }
  throw new Error('On Linux, install Ollama with its official script (curl -fsSL https://ollama.com/install.sh | sh), then try again.');
}
async function startOllama(binary,progress,fetchImpl){
  progress({message:'Starting Ollama'});
  if(process.platform==='darwin'&&binary.includes('Ollama.app')){spawn('/usr/bin/open',['-a',binary.slice(0,binary.indexOf('Ollama.app')+10)],{detached:true,stdio:'ignore'}).unref();}
  else spawn(binary,['serve'],{detached:true,stdio:'ignore',windowsHide:true,env:environment()}).unref();
  for(let i=0;i<40;i++){if(await ollamaModels(fetchImpl))return;await new Promise(r=>setTimeout(r,500));}
  throw new Error('Ollama did not start. Open the Ollama app once, then try again.');
}
async function pullModel(model,progress,fetchImpl=globalThis.fetch){
  const r=await fetchImpl(`${OLLAMA}/api/pull`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model,stream:true})});
  if(!r.ok||!r.body)throw new Error(`Ollama could not download ${model} (${r.status}).`);
  const decoder=new TextDecoder();let buf='',last='',layers=new Map();
  for await(const chunk of r.body){
    buf+=decoder.decode(chunk,{stream:true});let i;
    while((i=buf.indexOf('\n'))>=0){
      const line=buf.slice(0,i).trim();buf=buf.slice(i+1);if(!line)continue;let e;try{e=JSON.parse(line);}catch{continue;}
      if(e.error)throw new Error(`Ollama: ${e.error}`);
      if(e.digest&&e.total){layers.set(e.digest,{total:e.total,completed:e.completed||0});const t=[...layers.values()].reduce((a,l)=>a+l.total,0),c=[...layers.values()].reduce((a,l)=>a+l.completed,0);progress({step:'download',bytes:c,total:t});}
      if(e.status&&e.status!==last&&!/^pulling [0-9a-f]{6,}/.test(e.status)){last=e.status;progress({message:e.status});}
    }
  }
}
// The whole setup, as a background job: Ollama installed and running, the model downloaded, the Opaya Agent connected.
async function setupFree({opaya,model=recommended(),progress=()=>{},fetchImpl=globalThis.fetch}){
  if(!FREE_MODELS.some(f=>f.id===model))throw new Error('Choose one of the free models.');
  progress({step:'ollama',state:'active',message:'Looking for Ollama on this computer'});
  let models=await ollamaModels(fetchImpl);
  if(!models){
    let binary=ollamaBinary();
    if(!binary){progress({message:'Installing Ollama (free, open source)'});await installOllama(progress);binary=ollamaBinary();if(!binary)throw new Error('Ollama was installed but Opaya cannot find it yet. Restart Opaya and try again.');}
    await startOllama(binary,progress,fetchImpl);models=await ollamaModels(fetchImpl)||[];
  }
  progress({step:'ollama',state:'done',message:'Ollama is running'});
  progress({step:'download',state:'active',message:models.includes(model)?`${model} is already downloaded`:`Downloading ${model}`});
  if(!models.includes(model))await pullModel(model,progress,fetchImpl);
  progress({step:'download',state:'done',message:`${model} is ready`});
  progress({step:'connect',state:'active',message:'Connecting the Opaya Agent'});
  await opaya.saveConfig({preset:'ollama',baseUrl:`${OLLAMA}/v1`,model});
  progress({step:'connect',state:'done',message:`The Opaya Agent now runs on ${model}, free and on this computer`});
  return {model};
}
// First launch without a model: if Ollama already runs with a model that can use tools, connect to it silently.
async function autoConnect({opaya,fetchImpl=globalThis.fetch}){
  if(opaya.configured())return null;
  const models=await ollamaModels(fetchImpl);if(!models?.length)return null;
  const [model]=await toolModels(models,fetchImpl);if(!model)return null;
  await opaya.saveConfig({preset:'ollama',baseUrl:`${OLLAMA}/v1`,model});
  return model;
}
module.exports={FREE_MODELS,OLLAMA,recommended,ollamaModels,toolModels,setupFree,autoConnect,pullModel};
