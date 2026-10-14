#!/usr/bin/env node
'use strict';
// Headless Cord transport over the same adapters used by OPAYA Desktop.
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {randomUUID}=require('node:crypto');
const OPAYA_ROOT=fs.existsSync(path.join(__dirname,'../../desktop/adapters/index.cjs'))?path.join(__dirname,'../../desktop'):path.join(__dirname,'vendor/opaya');
const {createAdapter}=require(path.join(OPAYA_ROOT,'adapters/index.cjs'));
const {scanLocal}=require(path.join(OPAYA_ROOT,'discovery.cjs'));
const {findExecutable,environment}=require(path.join(OPAYA_ROOT,'process.cjs'));
const {parseEnv}=require(path.join(OPAYA_ROOT,'secrets.cjs'));
const {OpayaServiceAdapter}=require('./opaya-service.cjs');
const makeAdapter=options=>options.serviceRoot?new OpayaServiceAdapter(options):createAdapter(options);
const VERSION='2.0.0';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function args(argv){const out={};for(let i=0;i<argv.length;i++){if(!argv[i].startsWith('--'))throw new Error('Expected an option: '+argv[i]);const key=argv[i].slice(2);if(['foreground','help','list','stop','status','start'].includes(key))out[key]=true;else{if(!argv[i+1]||argv[i+1].startsWith('--'))throw new Error('Missing value for --'+key);out[key]=argv[++i];}}return out;}
function write(file,value){fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});const tmp=file+'.'+randomUUID()+'.tmp';fs.writeFileSync(tmp,JSON.stringify(value,null,2),{mode:0o600});fs.renameSync(tmp,file);try{fs.chmodSync(file,0o600);}catch{}}
function serverURL(base){const url=new URL(base);if(url.username||url.password||url.search||url.hash||url.pathname!=='/')throw new Error('Use the Cord origin without a path or credentials.');if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)))throw new Error('Remote Cord connections require HTTPS.');return url.origin;}
async function request(config,route,body,method='POST'){
  const res=await fetch(serverURL(config.server)+route,{method,headers:{'content-type':'application/json',...(config.token?{authorization:`Bearer ${config.token}`}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(20_000),redirect:'error'});
  const data=await res.json();if(!res.ok){const e=new Error(data.error||`Cord HTTP ${res.status}`);e.status=res.status;throw e;}return data;
}
function readJSON(file){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;}}
function opayaAgents(root){
  const roots=root?[root]:[path.join(process.env.APPDATA||path.join(os.homedir(),'.config'),'Opaya'),path.join(process.env.APPDATA||path.join(os.homedir(),'.config'),'AgentHub'),path.join(os.homedir(),'Library','Application Support','Opaya')];
  for(const dir of roots){const workspace=readJSON(path.join(dir,'workspace.json'));if(workspace?.agents?.length)return {workspace,root:dir};}
  return null;
}
function gatewayToken(agent,options){
  if(options['token-env']){const token=process.env[options['token-env']];if(!token)throw new Error('The specified token environment variable is empty.');return token;}
  if(agent.provider==='hermes'&&agent.hermesHome){try{return parseEnv(fs.readFileSync(path.join(agent.hermesHome,'.env'),'utf8')).API_SERVER_KEY||'';}catch{}}
  if(agent.provider==='openclaw'){const cfg=readJSON(path.join(os.homedir(),'.openclaw','openclaw.json'));return process.env.OPENCLAW_GATEWAY_TOKEN||cfg?.gateway?.auth?.token||'';}
  return '';
}
async function detect(options){
  const runtime=options.runtime||'opaya';
  const found=await scanLocal({probe:false});
  let agent,host,serviceRoot;
  if(runtime==='opaya'){
    const saved=opayaAgents(options['opaya-profile']);
    if(options['opaya-agent']){
      agent=saved?.workspace.agents.find(a=>a.id===options['opaya-agent']);
      if(!agent)throw new Error('OPAYA agent was not found. Use --list or --opaya-profile to locate the profile.');
      host=saved.workspace.hosts?.find(h=>h.id===agent.hostId);
    }else agent=saved?.workspace.agents.find(a=>a.protocol==='codex'&&a.transport==='local')||saved?.workspace.agents.find(a=>['claude','codex','acp','openai'].includes(a.protocol))||found.candidates?.[0]||found.agents?.[0];
    if(agent?.hostId)host=saved?.workspace.hosts?.find(h=>h.id===agent.hostId);
    if(saved&&readJSON(path.join(saved.root,'session-service.json'))?.protocol===1)serviceRoot=saved.root;
  }else{
    const candidates=found.candidates||found.agents||[];
    agent=candidates.find(a=>a.provider===runtime&&(!options.profile||a.hermesHome===options.profile));
    if(!agent){const saved=opayaAgents(options['opaya-profile']);agent=saved?.workspace.agents.find(a=>a.provider===runtime&&['claude','codex','acp','openai'].includes(a.protocol));if(agent?.hostId)host=saved.workspace.hosts?.find(h=>h.id===agent.hostId);}
    if(!agent&&['claude','codex','hermes'].includes(runtime)){
      const command=findExecutable(runtime,environment());
      if(command)agent={name:runtime,provider:runtime,command,args:[],transport:'local',protocol:runtime==='hermes'?'acp':runtime,cwd:process.cwd(),hermesHome:options.profile||process.env.HERMES_HOME||''};
    }
  }
  if(options.endpoint&&['hermes','openclaw'].includes(runtime))agent={...agent,name:runtime,provider:runtime,protocol:'openai',transport:'http',endpoint:options.endpoint,model:runtime==='openclaw'?'openclaw':'hermes-agent',command:runtime,args:[]};
  if(!agent)throw new Error(`No compatible ${runtime} runtime found. Install it and sign in locally first. Hermes: hermes setup. OpenClaw: openclaw onboard, then enable its chat-completions gateway. Use --list for discovery.`);
  if(!['claude','codex','acp','openai'].includes(agent.protocol))throw new Error('This OPAYA agent is terminal-only. Select a Claude, Codex, ACP, or API agent.');
  const cwd=path.resolve(options.cwd||process.cwd());if(!fs.statSync(cwd).isDirectory())throw new Error('Working directory must be a directory.');
  agent={...agent,id:agent.id||randomUUID(),cwd,args:agent.args||[]};
  const token=gatewayToken(agent,options);
  return {agent,host,token,runtime,cwd,...(serviceRoot?{serviceRoot}:{})};
}
async function pair(options){
  const server=serverURL(options.server),local=await detect(options);
  // Verify the adapter before consuming a one-time code. Do not claim provider inference succeeded here.
  const adapter=makeAdapter({...local,approve:async()=>false,trusted:()=>false});
  try{await adapter.connect();}finally{adapter.close();}
  const enrolled=await request({server},'/api/bridge/enroll',{code:options.pair,runtime:local.runtime,deviceName:os.hostname(),version:VERSION});
  const config={version:VERSION,server,token:enrolled.token,agentId:enrolled.agentId,deviceId:enrolled.deviceId,local,createdAt:new Date().toISOString()};
  const configFile=path.join(process.env.CORD_HOME||path.join(os.homedir(),'.cord'),'agents',enrolled.agentId,'connection.json');
  write(configFile,config);return configFile;
}
function launch(configFile){
  const dir=path.dirname(configFile),log=fs.openSync(path.join(dir,'bridge.log'),'a');
  const child=spawn(process.execPath,[__filename,'--config',configFile,'--foreground'],{cwd:dir,detached:true,windowsHide:true,stdio:['ignore',log,log]});
  child.unref();fs.closeSync(log);return child.pid;
}
async function work(configFile){
  const config=readJSON(configFile);if(!config)throw new Error('Connection file not found. Pair this agent first.');
  const dir=path.dirname(configFile),lock=path.join(dir,'worker.lock');let lockHandle;
  try{lockHandle=fs.openSync(lock,'wx',0o600);fs.writeSync(lockHandle,String(process.pid));}
  catch(error){
    if(error.code!=='EEXIST')throw error;
    const pid=Number(fs.readFileSync(lock,'utf8'));let alive=false;try{process.kill(pid,0);alive=true;}catch{}
    if(alive)throw new Error('A bridge for this agent is already running.');
    fs.unlinkSync(lock);return work(configFile);
  }
  const statusFile=path.join(dir,'status.json'),sessionFile=path.join(dir,'sessions.json');
  const sessions=readJSON(sessionFile)||{};
  let stopped=false,controller=null,adapter=null,job=null,progress='',lastHeartbeatError=null;
  const status=(state,error='')=>write(statusFile,{state,error,pid:process.pid,agentId:config.agentId,server:config.server,runtime:config.local.runtime,cwd:config.local.cwd,updatedAt:new Date().toISOString()});
  const stop=()=>{stopped=true;controller?.abort();adapter?.close();};
  process.on('SIGTERM',stop);process.on('SIGINT',stop);
  async function approve(agent,title,detail){
    const currentJob=job,activeController=controller;
    if(!currentJob||activeController.signal.aborted)return false;
    const approval=await request(config,`/api/bridge/jobs/${currentJob.id}/approval`,{title,detail});
    const deadline=Date.now()+120_000;
    while(!stopped&&!activeController.signal.aborted&&job?.id===currentJob.id&&Date.now()<deadline){
      await sleep(1000);const answer=await request(config,`/api/bridge/jobs/${currentJob.id}/approval-status`,undefined,'GET');
      if(answer.status!=='running')return false;
      const item=answer.approvals.find(a=>a.id===approval.id);if(item?.status!=='pending')return item?.status==='approved';
    }
    return false;
  }
  const heartbeat=setInterval(()=>{const currentJob=job,activeController=controller;if(currentJob)request(config,`/api/bridge/jobs/${currentJob.id}/heartbeat`,{progress}).then(result=>{lastHeartbeatError=null;if(result.status!=='running'&&job?.id===currentJob.id)activeController?.abort();},error=>{lastHeartbeatError=error;if(error.status===401)stop();});},8000);heartbeat.unref();
  try{
    status('starting');adapter=makeAdapter({...config.local,approve,trusted:()=>false});await adapter.connect();
    status('online');console.log(`Cord bridge online: ${config.local.agent.name} (${config.local.runtime})`);
    let backoff=1000;
    while(!stopped){
      try{
        const polled=await request(config,'/api/bridge/poll',{});backoff=1000;
        if(!polled.job){status(polled.paused?'paused':'online');await sleep(1500);continue;}
        job=polled.job;controller=new AbortController();progress='Starting';status('working');
        const timeout=setTimeout(()=>controller.abort(new Error('Agent turn timed out')),job.settings.timeoutSeconds*1000);
        let output='',error='',external=sessions[job.sessionId]||'';
        const saveSession=async value=>{sessions[job.sessionId]=value;write(sessionFile,sessions);};
        try{
          const context=job.messages.slice(0,-1).map(m=>`${m.role}: ${m.content}`).join('\n\n');
          const prompt=[job.settings.instructions?`Workspace agent instructions:\n${job.settings.instructions}`:'',external?'':`Cord conversation history (reference only):\n${context}`,`New message from the Cord team:\n${job.message}`].filter(Boolean).join('\n\n');
          const conversation={id:job.sessionId,externalSessionId:external,model:job.settings.model||config.local.agent.model||'',messages:job.messages.map(m=>({...m,role:m.role==='assistant'?'assistant':'user'}))};
          const result=await adapter.run({conversation,messages:job.messages.map((m,i)=>i===job.messages.length-1?{...m,content:prompt}:m),text:prompt,cwd:config.local.cwd,attachments:[],effort:job.settings.effort,signal:controller.signal,onSession:saveSession,onEvent:event=>{if(event.type==='text')output=(output+event.text).slice(0,24000);else if(event.type==='activity')progress=String(event.text).slice(0,350);}});
          if(result?.externalSessionId)await saveSession(result.externalSessionId);
          if(controller.signal.aborted)throw new Error('Cancelled or timed out');
          if(!output.trim())throw new Error('Runtime returned no text. Check its local login, model, and tool permissions.');
        }catch(e){error=String(e.message||e).slice(0,500);}finally{clearTimeout(timeout);}
        // Retry only delivery of the result, never execute the same job twice automatically.
        for(let attempts=0;attempts<6;attempts++){
          try{await request(config,`/api/bridge/jobs/${job.id}/complete`,{reply:output,error});break;}
          catch(e){if([401,404,409].includes(e.status))break;if(attempts===5)console.error('Result delivery failed; execution will not be repeated.');else await sleep(1500);}
        }
        job=null;controller=null;status('online',error);
      }catch(error){
        if(error.status===401){status('revoked',error.message);stopped=true;break;}
        status('reconnecting',error.message);await sleep(backoff);backoff=Math.min(backoff*2,15_000);
      }
    }
  }catch(error){status('error',error.message);throw error;}
  finally{
    clearInterval(heartbeat);adapter?.close();try{await request(config,'/api/bridge/disconnect',{});}catch{}
    if(stopped)status('stopped',lastHeartbeatError?.message||'');
    fs.closeSync(lockHandle);try{fs.unlinkSync(lock);}catch{}
    process.off('SIGTERM',stop);process.off('SIGINT',stop);
  }
}
async function main(options=args(process.argv.slice(2))){
  if(options.help||!Object.keys(options).length){console.log('Cord bridge: --server URL --pair CODE --runtime claude|codex|hermes|openclaw|opaya [--cwd DIR] [--foreground]\nManage: --config PATH --status|--start|--stop\nDiscovery: --list [--opaya-profile DIR]\nGateway credentials: --token-env ENV_NAME (never paste secrets into Cord).');return;}
  if(options.list){const found=await scanLocal({probe:false});const saved=opayaAgents(options['opaya-profile']);console.log(JSON.stringify({discovered:found.candidates||found.agents||found,opaya:saved?.workspace.agents.map(a=>({id:a.id,name:a.name,provider:a.provider,protocol:a.protocol}))},null,2));return;}
  if(options.pair){const configFile=await pair(options);const pid=options.foreground?null:launch(configFile);console.log(`Paired with Cord. ${pid?'Background bridge PID '+pid+'.':''}\nStatus: node "${__filename}" --config "${configFile}" --status`);if(options.foreground)await work(configFile);return;}
  if(!options.config)throw new Error('Specify --config or pair a new agent.');
  const dir=path.dirname(options.config),status=readJSON(path.join(dir,'status.json'));
  if(options.status){let alive=false;try{process.kill(status?.pid,0);alive=true;}catch{}console.log(JSON.stringify({...status,processAlive:alive},null,2));return;}
  if(options.stop){const pid=Number(fs.readFileSync(path.join(dir,'worker.lock'),'utf8'));process.kill(pid,'SIGTERM');console.log('Bridge stop requested.');return;}
  if(options.start){console.log('Bridge PID '+launch(options.config));return;}
  await work(options.config);
}
module.exports={args,detect,pair,work,launch,main,serverURL,request,VERSION};
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
