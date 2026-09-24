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
function shell(where,script,{compress=false}={}){
  const env=environment();
  if(where.host){
    const ssh=findExecutable('ssh',env);if(!ssh)throw new Error('OpenSSH client is not installed.');
    const remote=where.container?`docker exec -i ${quote(where.container)} sh -c ${quote(script)}`:script;
    return spawn(ssh,[...sshArgs(where.host),...(compress?['-C']:[]),'-T',target(where.host),remote],{env,windowsHide:true,stdio:['pipe','pipe','pipe']});
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
// Cron jobs (the cron folder) are a separate choice: by default only Everything copies them, since a cloned job also
// runs on the clone (for example posting to Slack twice).
const cronDefault=scope=>scope==='everything';
async function selection(where,home,scope,keys,cron=cronDefault(scope)){
  const def=SCOPES[scope];if(!def)throw new Error('Choose what to clone.');
  let wanted=def.all?null:[...def.paths,...(keys?['.env']:[]),...(cron?['cron']:[])];
  const keep=n=>!EXCLUDE.has(n)&&(keys||n!=='.env')&&(cron||n!=='cron');
  if(isLocal(where)){
    if(!wanted){const names=await fs.readdir(home);wanted=names.filter(keep);}
    const found=[];for(const p of wanted){try{await fs.access(path.join(home,p));found.push(p);}catch{}}return found;
  }
  const script=wanted?`cd ${quote(home)} && for p in ${wanted.map(quote).join(' ')}; do [ -e "$p" ] && printf '%s\\n' "$p"; done; true`:`cd ${quote(home)} && ls -A`;
  const names=(await run(where,script)).split('\n').map(x=>x.trim()).filter(Boolean);
  return wanted?names:names.filter(keep);
}
// Uncompressed tar, so bytes on the wire match file sizes and the percentage is real; ssh -C compresses on the network.
function producer(where,home,paths){
  if(isLocal(where)){const tar=findExecutable('tar',environment());if(!tar)throw new Error('tar is not available on this computer.');return spawn(tar,['-cf','-','-C',home,...paths],{windowsHide:true,stdio:['ignore','pipe','pipe']});}
  return shell(where,`cd ${quote(home)} && tar -cf - ${paths.map(quote).join(' ')}`,{compress:true});
}
async function consumer(where,dest){
  if(isLocal(where)){await fs.mkdir(dest,{recursive:true,mode:0o700});const tar=findExecutable('tar',environment());if(!tar)throw new Error('tar is not available on this computer.');return spawn(tar,['-xf','-','-C',dest],{windowsHide:true,stdio:['pipe','ignore','pipe']});}
  return shell(where,`mkdir -p ${quote(dest)} && chmod 700 ${quote(dest)} && tar -xf - -C ${quote(dest)}`,{compress:true});
}
// Total size of the selected paths, for the progress bar (an estimate: tar adds small headers).
async function measure(where,home,paths){
  if(isLocal(where)){
    let total=0,files=0;const walk=async p=>{let st;try{st=await fs.lstat(p);}catch{return;}if(st.isDirectory()){for(const n of await fs.readdir(p).catch(()=>[]))await walk(path.join(p,n));}else{total+=st.size;files++;}};
    for(const p of paths)await walk(path.join(home,p));return {bytes:total,files};
  }
  const out=await run(where,`cd ${quote(home)} && du -sk ${paths.map(quote).join(' ')} 2>/dev/null | awk '{s+=$1} END {print s*1024}'; find ${paths.map(quote).join(' ')} -type f 2>/dev/null | wc -l`,120000).catch(()=>'0\n0');
  const [bytes,files]=out.trim().split(/\s+/).map(Number);return {bytes:bytes||0,files:files||0};
}
// Pipe the archive from source to target; both sides must finish cleanly. Reports bytes as they pass.
async function transfer(from,home,paths,to,dest,{onBytes=()=>{},timeout=2*60*60*1000}={}){
  // Listen for exit as soon as each process exists, so a fast process cannot finish unnoticed.
  const done=child=>new Promise(resolve=>{child.on('error',e=>resolve(e.message));child.on('close',code=>resolve(code));});
  // The receiving side starts first; the sender starts only when it is ready and is connected in the same tick.
  const inp=await consumer(to,dest),inDone=done(inp);let errIn='',sent=0;inp.stderr?.on('data',d=>{errIn=(errIn+d).slice(-2000);});inp.stdin.on('error',()=>{});
  let out;try{out=producer(from,home,paths);}catch(error){inp.kill();throw error;}
  const outDone=done(out);let errOut='';out.stderr?.on('data',d=>{errOut=(errOut+d).slice(-2000);});
  out.stdout.on('data',chunk=>{sent+=chunk.length;onBytes(sent);});
  out.stdout.pipe(inp.stdin);
  const timer=setTimeout(()=>{out.kill();inp.kill();},timeout);
  const [a,b]=await Promise.all([outDone,inDone]);clearTimeout(timer);
  if(a!==0)throw new Error(`Reading the source failed: ${String(errOut||a).trim().slice(0,400)}`);
  if(b!==0)throw new Error(`Writing the clone failed: ${String(errIn||b).trim().slice(0,400)}`);
  return sent;
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
// Progress events: {step, state:'active'|'done', message} for stages and {bytes, total} while copying.
const where=w=>w.host?w.host.name+(w.container?` / container ${w.container}`:''):w.container?`container ${w.container}`:'this computer';
async function copyParts({agent,sourceHost,scope,keys,cron,to,dest,progress}){
  const from=place({agent,host:sourceHost});
  progress({step:'source',state:'active',message:`Finding ${agent.name}'s Hermes home on ${where(from)}`});
  const home=await sourceHome(agent,from);
  progress({step:'source',state:'done',message:`Source: ${home}`});
  progress({step:'select',state:'active',message:`Choosing what to copy (${SCOPES[scope]?.label||scope}${keys?', with API keys':', without API keys'}${cron?', with cron jobs':', without cron jobs'})`});
  const paths=await selection(from,home,scope,keys,cron);if(!paths.length)throw new Error('Nothing to copy: the source has none of the selected files.');
  const size=await measure(from,home,paths);
  progress({step:'select',state:'done',message:`${paths.length} item${paths.length===1?'':'s'}: ${paths.join(', ')} (${size.files} files, ${fmt(size.bytes)})`,total:size.bytes});
  progress({step:'copy',state:'active',message:`Copying to ${where(to)}: ${dest}`,bytes:0,total:size.bytes});
  let last=0;
  const sent=await transfer(from,home,paths,to,dest,{onBytes:n=>{const now=Date.now();if(now-last>200){last=now;progress({step:'copy',bytes:n,total:size.bytes});}}});
  progress({step:'copy',state:'done',message:`Copied ${fmt(sent)}`,bytes:sent,total:Math.max(size.bytes,sent)});
  return paths;
}
const fmt=n=>n<1024?`${n} B`:n<1048576?`${(n/1024).toFixed(1)} KB`:n<1073741824?`${(n/1048576).toFixed(1)} MB`:`${(n/1073741824).toFixed(2)} GB`;
// Clone `agent` (from `sourceHost`) to `host` (null = this computer). Returns the new agent connection to save.
async function clone({agent,sourceHost,host,runtime='regular',scope='everything',keys=true,cron=cronDefault(scope),name,progress=()=>{}}){
  cron=!!cron;
  if(agent.provider!=='hermes')throw new Error('Cloning is available for Hermes agents.');
  const id=slug(name);if(!id)throw new Error('Give the clone a name with letters or numbers.');
  progress({step:'target',state:'active',message:`Checking ${host?host.name:'this computer'} for ${runtime==='docker'?'Docker':'Hermes'}`});
  const t=await targetInfo({host,runtime,name:id}),container=runtime==='docker'?`opaya-hermes-${id}`:'';
  progress({step:'target',state:'done',message:`Target: ${t.dir}${container?` (container ${container})`:''}`});
  const paths=await copyParts({agent,sourceHost,scope,keys,cron,to:t.where,dest:t.dir,progress});
  if(container){progress({step:'start',state:'active',message:`Starting container ${container} (the first start downloads ${IMAGE}, which can take a few minutes)`});await startContainer(t.where,t.dir,container);progress({step:'start',state:'done',message:`Container ${container} is running`});}
  return {
    connection:{name:String(name).trim().slice(0,80),provider:'hermes',protocol:'acp',transport:host?'ssh':'local',hostId:host?.id||'',
      command:container?'docker':'hermes',args:container?['exec','-i',container,'hermes']:[],cwd:t.home,hermesHome:container?'/opt/data':t.dir,
      group:agent.group||'',tags:[...new Set([...(agent.tags||[]),'clone'])].slice(0,8),
      clone:{from:agent.id,scope,keys:!!keys,cron,runtime,dir:t.dir,container}},
    copied:paths
  };
}
// Copy the same parts again from the source into an existing clone; containers restart to pick them up.
async function redeploy({agent,source,sourceHost,host,progress=()=>{}}){
  const c=agent.clone;if(!c)throw new Error('This agent is not a clone.');
  const to={host:host||null,container:''};
  const paths=await copyParts({agent:source,sourceHost,scope:c.scope,keys:c.keys,cron:c.cron??cronDefault(c.scope),to,dest:c.dir,progress});
  if(c.container){progress({step:'start',state:'active',message:`Restarting container ${c.container}`});await startContainer(to,c.dir,c.container);progress({step:'start',state:'done',message:`Container ${c.container} restarted`});}
  return {copied:paths};
}
module.exports={clone,redeploy,SCOPES,EXCLUDE,slug,selection,transfer,measure,place,shell,run,sourceHome,isLocal};
