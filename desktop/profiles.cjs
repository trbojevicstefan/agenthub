'use strict';
// Clone an agent into a Docker container Opaya already runs (on this computer or a machine), as a profile next to the
// agent that lives there. Each framework uses its own way to keep several setups in one installation: Hermes a profile
// (HERMES_HOME=<home>/profiles/<name>), OpenClaw another agent of the same gateway (openclaw agents add, reached as model
// openclaw/<name>), and the npm CLIs (Claude Code, Codex, OpenCode) their own home folder in the container (docker exec
// -e HOME=...). The profile sits inside the container's data folder, so it survives an image update. A framework never
// moves into another framework's image, and Goose has no container install, so those are refused with the reason.
const path=require('node:path');
const {quote}=require('./process.cjs');
const {run,transfer,measure,place,copyParts,slug,fmt,cronDefault}=require('./clone.cjs');
const containers=require('./containers.cjs');
const NPM=['claude','codex','opencode'];
const NAMES={hermes:'Hermes',openclaw:'OpenClaw',claude:'Claude Code',codex:'Codex CLI',opencode:'OpenCode',goose:'Goose',aider:'Aider'};
const BIN={claude:'claude',codex:'codex',opencode:'opencode'};
const frameworkOf=agent=>require('./maintenance.cjs').frameworkOf(agent);
const containerOf=agent=>require('./maintenance.cjs').containerOf(agent);
// Why `from` cannot live in a container that runs `into` ('' when it can).
function fit(from,into){
  const n=NAMES[from]||'This agent';
  if(from==='hermes')return into==='hermes'?'':'A Hermes profile needs a container that runs Hermes (the nousresearch/hermes-agent image).';
  if(from==='openclaw')return into==='openclaw'?'':'An OpenClaw agent joins a container that runs the OpenClaw gateway.';
  if(NPM.includes(from))return NPM.includes(into)?'':`${n} needs one of Opaya's Node.js containers (a Claude Code, Codex or OpenCode container).`;
  return `${n} cannot live as a profile in a container. Clone it to a machine instead.`;
}
// Containers Opaya knows: one entry per machine and container, with the agent that runs there (not a profile).
function targets(agents){
  const out=new Map();
  for(const a of agents){
    const c=containerOf(a);if(!c)continue;
    const key=`${a.transport==='ssh'?a.hostId:''}|${c}`,base=a.clone?.runtime!=='profile',seen=out.get(key);
    if(!seen||base&&!seen.base)out.set(key,{hostId:a.transport==='ssh'?a.hostId:'',container:c,framework:frameworkOf(a),agentId:a.id,agentName:a.name,base});
  }
  return [...out.values()].map(({base,...t})=>t);
}
// Where the profile goes and how Opaya runs it. `home` and `state` are the container's $HOME and OpenClaw state folder.
function plan({from,into,name,home='/root',state='/home/node/.openclaw'}){
  const container=containerOf(into),to=frameworkOf(into),why=fit(from,to);if(why)throw new Error(why);
  const n=slug(name);if(!n)throw new Error('Give the clone a name with letters or numbers.');
  if(!container)throw new Error('Choose a container Opaya runs an agent in.');
  const abs=p=>{if(!path.posix.isAbsolute(p)||/[\0\n]/.test(p))throw new Error('Could not find the home folder in the container.');return p.replace(/\/+$/,'');};
  if(from==='hermes'){
    // The root Hermes home of the container (the agent there may itself be a profile).
    const h=abs(into.hermesHome||'/opt/data'),root=path.posix.basename(path.posix.dirname(h))==='profiles'?path.posix.dirname(path.posix.dirname(h)):h,dir=`${root}/profiles/${n}`;
    return {framework:from,container,name:n,dir,check:'command -v hermes >/dev/null 2>&1',finish:'',
      connection:{provider:'hermes',protocol:'acp',command:'docker',args:['exec','-i',container,'hermes'],hermesHome:dir,cwd:''},
      summary:`a Hermes profile in ${dir} (HERMES_HOME), next to ${into.name}`};
  }
  if(from==='openclaw'){
    if(n==='main'||n==='default')throw new Error('main and default are OpenClaw\'s own agents. Choose another name.');
    const dir=`${abs(state)}/workspace-${n}`;
    return {framework:from,container,name:n,dir,check:'command -v openclaw >/dev/null 2>&1',
      finish:`openclaw agents add ${quote(n)} --workspace ${quote(dir)} --non-interactive --json`,
      connection:{provider:'openclaw',protocol:into.protocol,transport:into.transport,endpoint:into.endpoint,command:'docker',args:[...into.args],cwd:into.cwd||'',model:`openclaw/${n}`},
      summary:`OpenClaw agent ${n} in the same gateway as ${into.name} (workspace ${dir}), reached as model openclaw/${n}`};
  }
  const dir=`${abs(home)}/opaya-profiles/${n}`,base=containers.PLANS[from].connection(container),at=base.args.indexOf(container);
  return {framework:from,container,name:n,dir,check:`command -v ${BIN[from]} >/dev/null 2>&1 || npm install -g ${containers.PLANS[from].npm}@latest >/dev/null`,finish:'',
    connection:{...base,args:['exec','-i','-e',`HOME=${dir}`,'-w',dir,...base.args.slice(at)],cwd:dir},
    summary:`${NAMES[from]} with its own home folder ${dir} (HOME), next to ${into.name}${from===to?'':`; ${NAMES[from]} is installed in the container if it is missing`}`};
}
// OpenClaw keeps an agent's personality, memory and skills in its workspace folder; the scopes pick from it.
const OPENCLAW_PARTS={everything:null,personality:['SOUL.md','AGENTS.md','USER.md','IDENTITY.md','TOOLS.md','skills'],skills:['skills'],memory:['MEMORY.md','memory','USER.md']};
const OPENCLAW_SKIP=['.git','sessions','logs','media'];
async function openclawWorkspace(agent,from){
  const state=(await run(from,'printf %s "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"')).trim();if(!state.startsWith('/'))throw new Error('Could not find OpenClaw\'s state folder.');
  const id=/^openclaw\/([a-z0-9][a-z0-9_-]{0,63})$/.exec(agent.model||'')?.[1];
  return id&&!['default','main'].includes(id)?`${state}/workspace-${id}`:`${state}/workspace`;
}
async function copyOpenclaw({agent,sourceHost,scope,to,dest,progress}){
  const from=place({agent,host:sourceHost});
  progress({step:'source',state:'active',message:`Finding ${agent.name}'s OpenClaw workspace`});
  const ws=await openclawWorkspace(agent,from),want=OPENCLAW_PARTS[scope];if(want===undefined)throw new Error('Choose what to clone.');
  const script=want?`cd ${quote(ws)} && for p in ${want.map(quote).join(' ')}; do [ -e "$p" ] && printf '%s\\n' "$p"; done; true`:`cd ${quote(ws)} && ls -A`;
  const paths=(await run(from,script)).split('\n').map(x=>x.trim()).filter(p=>p&&!OPENCLAW_SKIP.includes(p));
  if(!paths.length)throw new Error(`Nothing to copy: ${ws} has none of the chosen files.`);
  progress({step:'source',state:'done',message:`Source: ${ws}`});
  const size=await measure(from,ws,paths);
  progress({step:'select',state:'done',message:`${paths.join(', ')} (${size.files} files, ${fmt(size.bytes)})`,total:size.bytes});
  progress({step:'copy',state:'active',message:`Copying to ${dest}`,bytes:0,total:size.bytes});
  const sent=await transfer(from,ws,paths,to,dest,{onBytes:b=>progress({step:'copy',bytes:b,total:size.bytes})});
  progress({step:'copy',state:'done',message:`Copied ${fmt(sent)}`,bytes:sent,total:Math.max(size.bytes,sent)});
  return paths;
}
// The chosen parts of `agent` into `dest` in the container.
function copyInto({framework,agent,sourceHost,scope,keys,cron,to,dest,progress}){
  if(framework==='hermes')return copyParts({agent,sourceHost,scope,keys,cron,to,dest,progress});
  if(framework==='openclaw')return copyOpenclaw({agent,sourceHost,scope,to,dest,progress});
  return require('./clone-cli.cjs').copy({agent,sourceHost,id:framework,scope,keys,to,dest,backup:false,progress});
}
// Clone `agent` into the container `into` runs in (`host`: its machine, null for this computer). `confirm(title,detail)`
// is asked once, after the container is checked and before anything in it changes.
async function clone({agent,sourceHost,into,host,scope='everything',keys=true,cron=cronDefault(scope),name,confirm=async()=>true,progress=()=>{}}){
  const from=frameworkOf(agent),container=containerOf(into);
  const why=fit(from,frameworkOf(into));if(why)throw new Error(why);
  const where={host:host||null,container};
  progress({step:'target',state:'active',message:`Checking container ${container}${host?` on ${host.name}`:''}`});
  const probe=(await run(where,'printf "%s\\n%s\\n" "$HOME" "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"',60000).catch(error=>{throw new Error(`Container ${container} does not answer: ${String(error.message||error).slice(0,200)}. Start it, then clone again.`);})).split('\n');
  const p=plan({from,into,name,home:probe[0]?.trim()||'/root',state:probe[1]?.trim()||'/home/node/.openclaw'});
  if((await run(where,`[ -e ${quote(p.dir)} ] && echo taken; true`)).trim()==='taken')throw new Error(`${p.dir} already exists in container ${container}. Choose another name.`);
  if(!await confirm(`Add ${agent.name} to container ${container}${host?` on ${host.name}`:''}?`,`As ${p.summary}.\n\nOpaya copies ${scope==='everything'?'everything except chat history':scope} from ${agent.name}${keys&&from!=='openclaw'?', with API keys and logins':''} into ${p.dir}. The container and its agent keep running; nothing of theirs is changed.${p.finish?`\n\nThen runs in the container:\n${p.finish}`:''}${from!==frameworkOf(into)&&NPM.includes(from)?`\n\nFirst, if it is missing: npm install -g ${containers.PLANS[from].npm}@latest`:''}`))throw new Error('Clone cancelled.');
  await run(where,p.check,15*60*1000).catch(()=>{throw new Error(`${NAMES[from]} is not available in container ${container}${NPM.includes(from)?' and could not be installed there':''}.`);});
  progress({step:'target',state:'done',message:`Target: ${p.dir} in container ${container}`});
  const copied=await copyInto({framework:from,agent,sourceHost,scope,keys,cron,to:where,dest:p.dir,progress});
  if(p.finish){progress({step:'start',state:'active',message:`Adding agent ${p.name} to OpenClaw`});await run(where,p.finish,120000);progress({step:'start',state:'done',message:`OpenClaw agent ${p.name} added. If it does not answer yet, restart the container's gateway.`});}
  return {
    connection:{...p.connection,name:String(name).trim().slice(0,80),transport:p.connection.transport||(host?'ssh':'local'),hostId:host?.id||'',
      group:agent.group||'',tags:[...new Set([...(agent.tags||[]),'clone','profile'])].slice(0,8),
      clone:{from:agent.id,framework:from,scope,keys:!!keys,cron:!!cron,runtime:'profile',dir:p.dir,container,profile:p.name}},
    copied,copyToken:from==='openclaw'
  };
}
// Copy the same parts again into the profile; its chat history stays.
async function redeploy({agent,source,sourceHost,host,progress=()=>{}}){
  const c=agent.clone,to={host:host||null,container:c.container};
  return {copied:await copyInto({framework:c.framework||'hermes',agent:source,sourceHost,scope:c.scope,keys:c.keys,cron:c.cron??cronDefault(c.scope),to,dest:c.dir,progress})};
}
// Removing a profile: only its folder (and OpenClaw's agent entry) in the container; the container and its agent stay.
function removeCommand(agent){
  const c=agent.clone,dir=String(c?.dir||'');
  if(c?.runtime!=='profile'||!c.container||!/^\/[^/]+\/.+/.test(dir)||/(^|\/)\.\.(\/|$)/.test(dir))throw new Error('This agent is not a profile Opaya added to a container.');
  const inside=c.framework==='openclaw'?`openclaw agents delete ${quote(c.profile||path.posix.basename(dir).replace(/^workspace-/,''))} --force; rm -rf ${quote(dir)}`:`rm -rf ${quote(dir)}`;
  return `docker exec ${quote(c.container)} sh -c ${quote(inside)} && echo ${quote(`Removed ${dir} from container ${c.container}.`)}`;
}
module.exports={fit,targets,plan,clone,redeploy,removeCommand,NAMES};
