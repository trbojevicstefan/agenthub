'use strict';
// Clone a Hermes agent to this computer or a saved machine, as a Hermes profile or a Docker container, and redeploy it
// later with the same recipe. Files move as a tar stream: source (local folder, SSH, or a container) -> target folder.
// Like `hermes profile create --clone-all`, history (state.db, sessions), logs and OAuth logins are never copied.
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {findExecutable,environment,sshArgs,target,quote,collect,dockerExecContainerIndex}=require('./process.cjs');
const {hermesHomes}=require('./diagnostics.cjs');
const SCOPES={
  skills:{label:'Skills',paths:['config.yaml','skills']},
  memory:{label:'Memory',paths:['config.yaml','memories']},
  personality:{label:'Skills + personality',paths:['config.yaml','skills','SOUL.md','memories/USER.md']},
  everything:{label:'Everything',all:true}
};
// Never copied: conversation history and runtime state, logs, OAuth logins (single-use refresh tokens), other profiles,
// and the Hermes installation itself (on Windows HERMES_HOME also holds the venv, portable Git and launchers).
const EXCLUDE=new Set(['state.db','state.db-wal','state.db-shm','sessions','logs','backups','checkpoints','state-snapshots','auth.json','profiles','hermes-agent','git','bin','venv','cache','node','.install','python']);
const IMAGE='nousresearch/hermes-agent';
const slug=value=>String(value||'').toLowerCase().replace(/[^a-z0-9_-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,40);
// Where files are read or written: this computer, an SSH machine, or a container on either.
function place({agent,host}){
  const i=agent.command==='docker'?dockerExecContainerIndex(agent.args||[]):-1;
  return {host:agent.transport==='ssh'?host:null,container:i>=0?agent.args[i]:''};
}
function shell(where,script,{input}={}){
  const env=environment();
  if(where.host){
    const ssh=findExecutable('ssh',env);if(!ssh)throw new Error('OpenSSH client is not installed.');
    const remote=where.container?`docker exec -i ${quote(where.container)} sh -c ${quote(script)}`:script;
    return spawn(ssh,[...sshArgs(where.host),'-T',target(where.host),remote],{env,windowsHide:true,stdio:['pipe','pipe','pipe']});
  }
  if(where.container){const docker=findExecutable('docker',env);if(!docker)throw new Error('Docker is not installed on this computer.');return spawn(docker,['exec','-i',where.container,'sh','-c',script],{env,windowsHide:true,stdio:['pipe','pipe','pipe']});}
  if(process.platform==='win32')throw new Error('Internal: no POSIX shell on Windows.');
  return spawn('/bin/sh',['-c',script],{env,windowsHide:true,stdio:['pipe','pipe','pipe']});
}
const run=(where,script,timeout=30000)=>collect(shell(where,script),{timeout,maxBytes:1024*1024});
const isLocal=where=>!where.host&&!where.container;
async function sourceHome(agent,where){
  if(where.container)return agent.hermesHome||'/opt/data';
  if(agent.hermesHome)return agent.hermesHome;
  if(isLocal(where)){for(const h of hermesHomes(agent)){try{await fs.access(path.join(h,'config.yaml'));return h;}catch{}}throw new Error('Could not find this agent\'s Hermes home. Set it in Connection settings.');}
  return (await run(where,'printf %s "${HERMES_HOME:-$HOME/.hermes}"')).trim();
}
// The paths to copy that exist in the source home.
async function selection(where,home,scope,keys){
  const def=SCOPES[scope];if(!def)throw new Error('Choose what to clone.');
  let wanted=def.all?null:[...def.paths,...(keys?['.env']:[])];
  if(isLocal(where)){
    if(!wanted){const names=await fs.readdir(home);wanted=names.filter(n=>!EXCLUDE.has(n)&&(keys||n!=='.env'));}
    const found=[];for(const p of wanted){try{await fs.access(path.join(home,p));found.push(p);}catch{}}return found;
  }
  const script=wanted?`cd ${quote(home)} && for p in ${wanted.map(quote).join(' ')}; do [ -e "$p" ] && printf '%s\\n' "$p"; done; true`:`cd ${quote(home)} && ls -A`;
  const names=(await run(where,script)).split('\n').map(x=>x.trim()).filter(Boolean);
  return wanted?names:names.filter(n=>!EXCLUDE.has(n)&&(keys||n!=='.env'));
}
function producer(where,home,paths){
  if(isLocal(where)){const tar=findExecutable('tar',environment());if(!tar)throw new Error('tar is not available on this computer.');return spawn(tar,['-czf','-','-C',home,...paths],{windowsHide:true,stdio:['ignore','pipe','pipe']});}
  return shell(where,`cd ${quote(home)} && tar -czf - ${paths.map(quote).join(' ')}`);
}
async function consumer(where,dest){
  if(isLocal(where)){await fs.mkdir(dest,{recursive:true,mode:0o700});const tar=findExecutable('tar',environment());if(!tar)throw new Error('tar is not available on this computer.');return spawn(tar,['-xzf','-','-C',dest],{windowsHide:true,stdio:['pipe','ignore','pipe']});}
  return shell(where,`mkdir -p ${quote(dest)} && chmod 700 ${quote(dest)} && tar -xzf - -C ${quote(dest)}`);
}
// Pipe the archive from source to target; both sides must finish cleanly.
async function transfer(from,home,paths,to,dest){
  const out=producer(from,home,paths),inp=await consumer(to,dest);
  let errOut='',errIn='';out.stderr?.on('data',d=>{errOut=(errOut+d).slice(-2000);});inp.stderr?.on('data',d=>{errIn=(errIn+d).slice(-2000);});
  out.stdout.pipe(inp.stdin);inp.stdin.on('error',()=>{});
  const done=child=>new Promise(resolve=>{child.on('error',e=>resolve(e.message));child.on('close',code=>resolve(code));});
  const timer=setTimeout(()=>{out.kill();inp.kill();},15*60*1000);
  const [a,b]=await Promise.all([done(out),done(inp)]);clearTimeout(timer);
  if(a!==0)throw new Error(`Reading the source failed: ${String(errOut||a).trim().slice(0,400)}`);
  if(b!==0)throw new Error(`Writing the clone failed: ${String(errIn||b).trim().slice(0,400)}`);
}
async function targetInfo({host,runtime,name}){
  const where={host:host||null,container:''};
  if(runtime==='docker'){
    if(isLocal(where)){if(!findExecutable('docker',environment()))throw new Error('Docker is not installed on this computer.');return {where,dir:path.join(os.homedir(),'opaya-hermes',name),home:os.homedir()};}
    const out=(await run(where,'command -v docker >/dev/null 2>&1 || echo NO_DOCKER; printf %s "$HOME"')).trim();
    if(out.startsWith('NO_DOCKER'))throw new Error(`Docker is not installed on ${host.name}.`);
    return {where,dir:`${out}/opaya-hermes/${name}`,home:out};
  }
  if(isLocal(where)){
    if(!findExecutable('hermes',environment()))throw new Error('Hermes is not installed on this computer. Install it (Install agents > Hermes Agent), then clone.');
    let root=hermesHomes({})[0];for(const h of hermesHomes({})){try{await fs.access(path.join(h,'config.yaml'));root=h;break;}catch{}}
    return {where,dir:path.join(root,'profiles',name),home:os.homedir()};
  }
  const out=(await run(where,'export PATH="$HOME/.local/bin:$PATH"; command -v hermes >/dev/null 2>&1 || echo NO_HERMES; printf "%s\\n%s" "${HERMES_HOME:-$HOME/.hermes}" "$HOME"')).trim().split('\n');
  if(out[0]==='NO_HERMES')throw new Error(`Hermes is not installed on ${host.name}. Install it there first (Install agents > Hermes Agent > on ${host.name}), then clone.`);
  return {where,dir:`${out.at(-2)}/profiles/${name}`,home:out.at(-1)};
}
async function startContainer(where,dir,container){
  const script=`if docker inspect ${quote(container)} >/dev/null 2>&1; then docker restart ${quote(container)} >/dev/null; else docker run -d --name ${quote(container)} --restart unless-stopped -v ${quote(dir+':/opt/data')} ${IMAGE} gateway run >/dev/null; fi && echo started`;
  if(isLocal(where)){
    const docker=findExecutable('docker',environment());
    const exists=await collect(spawn(docker,['inspect',container],{windowsHide:true,stdio:['ignore','pipe','pipe']}),{timeout:20000}).then(()=>true,()=>false);
    await collect(spawn(docker,exists?['restart',container]:['run','-d','--name',container,'--restart','unless-stopped','-v',`${dir}:/opt/data`,IMAGE,'gateway','run'],{windowsHide:true,stdio:['ignore','pipe','pipe']}),{timeout:10*60*1000});
    return;
  }
  await run(where,script,10*60*1000);
}
// Clone `agent` (from `sourceHost`) to `host` (null = this computer). Returns the new agent connection to save.
async function clone({agent,sourceHost,host,runtime='regular',scope='everything',keys=true,name}){
  if(agent.provider!=='hermes')throw new Error('Cloning is available for Hermes agents.');
  const id=slug(name);if(!id)throw new Error('Give the clone a name with letters or numbers.');
  const from=place({agent,host:sourceHost}),home=await sourceHome(agent,from);
  const paths=await selection(from,home,scope,keys);if(!paths.length)throw new Error('Nothing to copy: the source has none of the selected files.');
  const t=await targetInfo({host,runtime,name:id}),container=runtime==='docker'?`opaya-hermes-${id}`:'';
  await transfer(from,home,paths,t.where,t.dir);
  if(container)await startContainer(t.where,t.dir,container);
  return {
    connection:{name:String(name).trim().slice(0,80),provider:'hermes',protocol:'acp',transport:host?'ssh':'local',hostId:host?.id||'',
      command:container?'docker':'hermes',args:container?['exec','-i',container,'hermes']:[],cwd:t.home,hermesHome:container?'/opt/data':t.dir,
      group:agent.group||'',tags:[...new Set([...(agent.tags||[]),'clone'])].slice(0,8),
      clone:{from:agent.id,scope,keys:!!keys,runtime,dir:t.dir,container}},
    copied:paths
  };
}
// Copy the same parts again from the source into an existing clone; containers restart to pick them up.
async function redeploy({agent,source,sourceHost,host}){
  const c=agent.clone;if(!c)throw new Error('This agent is not a clone.');
  const from=place({agent:source,host:sourceHost}),home=await sourceHome(source,from);
  const paths=await selection(from,home,c.scope,c.keys);
  const where={host:host||null,container:''};
  await transfer(from,home,paths,where,c.dir);
  if(c.container)await startContainer(where,c.dir,c.container);
  return {copied:paths};
}
module.exports={clone,redeploy,SCOPES,EXCLUDE,slug,selection,transfer};
