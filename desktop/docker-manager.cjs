'use strict';
// Docker on one machine (this computer or an SSH server): its containers and images, and start, stop, restart and
// remove for each. Everything runs as `docker` with fixed arguments; names and ids are validated first.
const {launch,collect}=require('./process.cjs');
const NAME=/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const IMAGE=/^[a-zA-Z0-9][a-zA-Z0-9_.\/:@-]{0,255}$/;
const ACTIONS={start:['start'],stop:['stop'],restart:['restart'],remove:['rm','-f'],'remove-image':['rmi']};
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
  const target=String(container||'');
  if(action==='remove-image'?!IMAGE.test(target):!NAME.test(target))throw new Error('Invalid container or image name.');
  try{await run(host,[...args,target],120000);}
  catch(error){const e=explain(error);throw new Error(e.error);}
  return {ok:true};
}
// What a terminal types to follow a container's log or open a shell in it (works in sh, PowerShell and cmd).
function terminalCommand({container,kind}){
  if(!NAME.test(String(container||'')))throw new Error('Invalid container name.');
  return kind==='logs'?`docker logs --tail 200 -f ${container}`:`docker exec -it ${container} sh`;
}
module.exports={list,act,terminalCommand,explain,NAME};
