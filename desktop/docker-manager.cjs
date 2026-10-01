'use strict';
// Docker on one machine (this computer or an SSH server): its containers and images, start, stop, restart, pause,
// resume and remove for each, pulling a newer image, pruning unused images, live resource use and a safe summary of
// how a container runs. Everything runs as `docker` with fixed arguments; names and ids are validated first.
const {launch,collect,terminate}=require('./process.cjs');
const NAME=/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const IMAGE=/^[a-zA-Z0-9][a-zA-Z0-9_.\/:@-]{0,255}$/;
const ACTIONS={start:['start'],stop:['stop'],restart:['restart'],pause:['pause'],unpause:['unpause'],remove:['rm','-f'],'remove-image':['rmi'],pull:['pull'],prune:['image','prune','-f']};
// Actions on an image (validated as an image reference) and actions on the whole machine (no target).
const IMAGE_ACTIONS=new Set(['remove-image','pull']),MACHINE_ACTIONS=new Set(['prune']);
const run=(host,args,timeout=20000)=>collect(launch({transport:host?'ssh':'local',hostId:host?.id||'',command:'docker',args:[],cwd:''},args,host),{timeout,maxBytes:2*1024*1024});
const lines=raw=>String(raw||'').split(/\r?\n/).map(l=>l.trim()).filter(Boolean).slice(0,500).map(l=>{try{return JSON.parse(l);}catch{return null;}}).filter(Boolean);
// Plain words for the errors people hit: no Docker, Docker Desktop not started, the SSH user not in the docker group.
function explain(error){
  const text=String(error?.message||error);
  if(/not found|ENOENT|command not found|was not found/i.test(text))return {installed:false,running:false,error:'Docker is not installed on this machine.'};
  if(/permission denied.*docker\.sock/i.test(text))return {installed:true,running:false,error:'This user cannot use Docker. On the machine run: sudo usermod -aG docker $USER, then log in again.'};
  if(/Cannot connect to the Docker daemon|daemon.*running|docker_engine|dockerDesktopLinuxEngine|pipe/i.test(text))return {installed:true,running:false,error:'Docker is installed but not running. Start Docker (Docker Desktop on this computer), then refresh.'};
  return {installed:true,running:false,error:text.slice(0,400)};
}
async function list(host){
  let version='';
  try{version=String(await run(host,['version','--format','{{.Server.Version}}'],15000)).trim().slice(0,40);}
  catch(error){return explain(error);}
  const [containers,images]=await Promise.all([
    run(host,['ps','-a','--no-trunc','--format','{{json .}}']).then(lines),
    run(host,['images','--format','{{json .}}']).then(lines).catch(()=>[])
  ]);
  return {installed:true,running:true,version,
    containers:containers.map(c=>({id:String(c.ID||'').slice(0,64),name:String(c.Names||'').split(',')[0].slice(0,128),image:String(c.Image||'').slice(0,256),state:String(c.State||'').slice(0,20),status:String(c.Status||'').slice(0,80),ports:String(c.Ports||'').slice(0,300),created:String(c.RunningFor||c.CreatedAt||'').slice(0,60)})).filter(c=>NAME.test(c.name)),
    images:images.map(i=>({id:String(i.ID||'').slice(0,80),repository:String(i.Repository||'').slice(0,200),tag:String(i.Tag||'').slice(0,128),size:String(i.Size||'').slice(0,20),created:String(i.CreatedSince||'').slice(0,40)}))};
}
async function act(host,{container,action}){
  const args=ACTIONS[action];if(!args)throw new Error('Unknown Docker action.');
  const target=String(container||''),machine=MACHINE_ACTIONS.has(action);
  if(!machine&&(IMAGE_ACTIONS.has(action)?!IMAGE.test(target):!NAME.test(target)))throw new Error('Invalid container or image name.');
  // A pull downloads layers: it gets longer than the other actions.
  try{await run(host,machine?args:[...args,target],action==='pull'?600000:120000);}
  catch(error){const e=explain(error);throw new Error(e.error);}
  return {ok:true};
}
// CPU, memory, network and disk use of the running containers, one sample (docker stats --no-stream).
async function stats(host){
  let rows;
  try{rows=lines(await run(host,['stats','--no-stream','--format','{{json .}}'],30000));}
  catch(error){throw new Error(explain(error).error);}
  return {at:new Date().toISOString(),stats:rows.map(r=>({name:String(r.Name||'').slice(0,128),cpu:String(r.CPUPerc||'').slice(0,12),mem:String(r.MemUsage||'').slice(0,60),memPercent:String(r.MemPerc||'').slice(0,12),net:String(r.NetIO||'').slice(0,60),block:String(r.BlockIO||'').slice(0,60),pids:String(r.PIDs||'').slice(0,10)})).filter(r=>NAME.test(r.name))};
}
// How a container runs: image, restart policy, mounts, ports, networks and health. Environment variables are listed
// by name only, so values such as API keys never leave the machine.
async function inspect(host,container){
  if(!NAME.test(String(container||'')))throw new Error('Invalid container name.');
  let raw;
  try{raw=JSON.parse(String(await run(host,['inspect','--type','container',container],20000)))[0];}
  catch(error){throw new Error(error instanceof SyntaxError?'Docker returned something Opaya could not read.':explain(error).error);}
  if(!raw)throw new Error('Container not found.');
  const cfg=raw.Config||{},hc=raw.HostConfig||{},st=raw.State||{};
  const ports=Object.entries(raw.NetworkSettings?.Ports||{}).flatMap(([inside,out])=>(out||[]).map(o=>`${o.HostIp||'0.0.0.0'}:${o.HostPort} -> ${inside}`)).slice(0,40);
  return {name:String(raw.Name||container).replace(/^\//,'').slice(0,128),image:String(cfg.Image||'').slice(0,256),created:String(raw.Created||'').slice(0,40),
    state:String(st.Status||'').slice(0,20),startedAt:String(st.StartedAt||'').slice(0,40),restartCount:Number(raw.RestartCount)||0,health:String(st.Health?.Status||'').slice(0,20),
    restart:String(hc.RestartPolicy?.Name||'no').slice(0,30),command:[...(cfg.Entrypoint||[]),...(cfg.Cmd||[])].join(' ').slice(0,300),workdir:String(cfg.WorkingDir||'').slice(0,200),
    mounts:(raw.Mounts||[]).slice(0,30).map(m=>({type:String(m.Type||'').slice(0,20),source:String(m.Name||m.Source||'').slice(0,300),destination:String(m.Destination||'').slice(0,300),rw:m.RW!==false})),
    ports,networks:Object.keys(raw.NetworkSettings?.Networks||{}).slice(0,20),env:(cfg.Env||[]).map(e=>String(e).split('=')[0].slice(0,80)).filter(Boolean).slice(0,80)};
}
// The last lines a container printed (docker logs writes both streams), for the Opaya Agent to read.
function logs(host,container,tail=150){
  if(!NAME.test(String(container||'')))return Promise.reject(new Error('Invalid container name.'));
  const lines=Math.max(10,Math.min(1000,Number(tail)||150));
  const child=launch({transport:host?'ssh':'local',hostId:host?.id||'',command:'docker',args:[],cwd:''},['logs','--tail',String(lines),container],host);
  return new Promise((resolve,reject)=>{
    let text='',done=false;const add=d=>{text=(text+d).slice(-200000);};
    const finish=(error)=>{if(done)return;done=true;clearTimeout(timer);error?reject(error):resolve(text);};
    const timer=setTimeout(()=>{terminate(child);finish(null);},20000);
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',add);child.stderr.on('data',add);
    child.on('error',e=>finish(new Error(explain(e).error)));
    child.on('close',code=>code===0?finish(null):finish(new Error(explain(new Error(text.slice(-2000)||`docker logs exited with code ${code}`)).error)));
    child.stdin.end();
  });
}
// What a terminal types to follow a container's log or open a shell in it (works in sh, PowerShell and cmd).
function terminalCommand({container,kind}){
  if(!NAME.test(String(container||'')))throw new Error('Invalid container name.');
  return kind==='logs'?`docker logs --tail 200 -f ${container}`:`docker exec -it ${container} sh`;
}
module.exports={list,act,stats,inspect,logs,terminalCommand,explain,NAME,ACTIONS};
