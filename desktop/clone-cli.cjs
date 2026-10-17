'use strict';
// Clone a CLI agent (Claude Code, Codex, OpenCode, OpenClaw, Goose) to another machine or into a Docker container, and
// redeploy it later. A CLI agent is its program plus its folders in the home folder, so a clone installs the program
// where it is missing and copies the chosen folders over the same tar stream as a Hermes clone. Chat history is never
// copied; logins and API keys only when asked. Existing folders on the target are renamed, never overwritten.
const os=require('node:os');
const path=require('node:path');
const fs=require('node:fs/promises');
const {findExecutable,environment,quote,collect,REMOTE_PATH}=require('./process.cjs');
const {transfer,measure,run,shell,isLocal,place,slug,fmt}=require('./clone.cjs');
const catalog=require('./catalog.cjs');
const containers=require('./containers.cjs');
const {openclawWithoutSecrets}=require('./credentials.cjs');
// Paths are relative to the home folder. `top` is what a clone of everything copies; the scopes pick from the rest.
// `config` is a settings file that also holds credentials: a clone without keys copies it without them.
const CLI={
  claude:{name:'Claude Code',bin:'claude',top:['.claude','.claude.json'],
    skills:['.claude/skills','.claude/commands','.claude/agents','.claude/plugins'],memory:['.claude/CLAUDE.md'],personality:['.claude/output-styles'],settings:['.claude/settings.json'],
    history:['.claude/projects','.claude/todos','.claude/shell-snapshots','.claude/statsig','.claude/ide','.claude/logs','.claude/file-history','.claude/session-env'],secrets:['.claude/.credentials.json','.claude.json'],
    connection:()=>({provider:'claude',protocol:'claude',command:'claude',args:[]})},
  codex:{name:'Codex CLI',bin:'codex',top:['.codex'],
    skills:['.codex/skills','.codex/prompts'],memory:['.codex/AGENTS.md','.codex/memories'],personality:[],settings:['.codex/config.toml'],
    history:['.codex/sessions','.codex/archived_sessions','.codex/history.jsonl','.codex/log','.codex/shell_snapshots'],secrets:['.codex/auth.json'],
    connection:()=>({provider:'codex',protocol:'codex',command:'codex',args:[]})},
  opencode:{name:'OpenCode',bin:'opencode',top:['.config/opencode','.local/share/opencode'],
    skills:['.config/opencode/agent','.config/opencode/agents','.config/opencode/command','.config/opencode/commands','.config/opencode/skills'],memory:['.config/opencode/AGENTS.md'],personality:[],settings:['.config/opencode/opencode.json','.config/opencode/opencode.jsonc'],
    history:['.local/share/opencode/log','.local/share/opencode/snapshot','.local/share/opencode/storage'],secrets:['.local/share/opencode/auth.json'],
    connection:()=>({provider:'custom',protocol:'acp',command:'opencode',args:['acp'],avatar:'lib:opencode'})},
  dsh:{name:'DeepSeek Harness',bin:'dsh',top:['.dsh'],
    skills:['.dsh/skills','.agents/skills'],memory:['.dsh/AGENTS.md'],personality:['.dsh/.agent-presets'],settings:['.dsh/cordis.patch.yml','.dsh/profiles'],
    history:['.dsh/sessions','.dsh/logs','.dsh/cache','.dsh/attachments'],secrets:['.dsh/.credentials.yaml','.dsh/.env'],
    connection:()=>({provider:'custom',protocol:'acp',command:'dsh',args:['--profile','acp'],avatar:'lib:deepseek'})},
  openclaw:{name:'OpenClaw',bin:'openclaw',top:['.openclaw'],
    skills:['.openclaw/skills','.openclaw/workspace/skills'],memory:['.openclaw/workspace/MEMORY.md','.openclaw/workspace/memory'],personality:['.openclaw/workspace/SOUL.md','.openclaw/workspace/AGENTS.md','.openclaw/workspace/USER.md','.openclaw/workspace/IDENTITY.md'],settings:['.openclaw/openclaw.json'],
    history:['.openclaw/sessions','.openclaw/logs','.openclaw/agents/*/sessions','.openclaw/media'],secrets:['.openclaw/credentials','.openclaw/.env'],config:'.openclaw/openclaw.json',
    connection:()=>({provider:'openclaw',protocol:'openai',command:'openclaw',args:[],endpoint:'http://127.0.0.1:18789/v1',model:'openclaw/default'})},
  goose:{name:'Goose',bin:'goose',top:['.config/goose'],skills:['.config/goose/recipes'],memory:['.config/goose/memory','.config/goose/.goosehints'],personality:[],settings:['.config/goose/config.yaml'],
    history:['.local/share/goose/sessions'],secrets:['.config/goose/secrets.yaml'],
    connection:()=>({provider:'custom',protocol:'terminal',command:'goose',args:[]})}
};
function frameworkOf(agent){
  const f=require('./maintenance.cjs').frameworkOf(agent);
  if(!CLI[f])throw new Error(`Opaya can clone Hermes, ${Object.values(CLI).map(c=>c.name).join(', ')}. This agent is ${agent.name}.`);
  return f;
}
// What to copy: top-level paths (or the scope's paths) and what to leave out below them.
function plan(id,scope,keys){
  const c=CLI[id];if(!['everything','personality','skills','memory'].includes(scope))throw new Error('Choose what to clone.');
  const secrets=keys?[]:c.secrets,config=keys?'':c.config||'';
  const wanted=scope==='everything'?c.top:[...new Set([...c.settings,...c.skills,...(scope==='memory'||scope==='personality'?c.memory:[]),...(scope==='personality'?c.personality:[]),...(keys?c.secrets:[])])];
  return {wanted:wanted.filter(p=>!secrets.includes(p)&&p!==config),excludes:[...c.history,...secrets,...(config?[config]:[])],config};
}
const homeOf=async where=>isLocal(where)?os.homedir():(await run(where,'printf %s "$HOME"')).trim();
async function existing(where,home,paths){
  if(isLocal(where)){const found=[];for(const p of paths)if(await fs.lstat(path.join(home,p)).then(()=>true,()=>false))found.push(p);return found;}
  const out=await run(where,`cd ${quote(home)} && for p in ${paths.map(quote).join(' ')}; do [ -e "$p" ] && printf '%s\\n' "$p"; done; true`);
  return out.split('\n').map(x=>x.trim()).filter(Boolean);
}
// The same machine account: a CLI keeps one setup there, so a regular clone must go elsewhere.
const sameAccount=(agent,host)=>(agent.transport==='ssh'?agent.hostId:'')===(host?.id||'')&&agent.command!=='docker';
// Install the program on a machine when it is missing (the vendor's own command, non-interactive).
async function ensureInstalled(id,where,host,progress){
  const c=CLI[id];
  if(isLocal(where)){
    if(findExecutable(c.bin,environment()))return;
    throw new Error(`${c.name} is not installed on this computer. Install it (Install agents > ${c.name}), then clone again.`);
  }
  const has=(await run(where,`${REMOTE_PATH}; command -v ${c.bin} >/dev/null 2>&1 && echo yes || echo no`)).trim().endsWith('yes');
  if(has)return;
  const {command}=catalog.command(id,{remote:true});
  progress({step:'target',state:'active',message:`Installing ${c.name} on ${host.name}`});
  await run(where,`${REMOTE_PATH}; ${command} </dev/null`,15*60*1000).catch(error=>{throw new Error(`Installing ${c.name} on ${host.name} failed: ${String(error.message||error).slice(-300)}. Install it there (Install agents), then clone again.`);});
}
// A Node.js container with the CLI, its home folder in ~/opaya-agents/<name> on the machine (like Install agents > Docker).
async function startContainer(id,where,container,dir){
  const p=containers.PLANS[id];
  const script=[`${REMOTE_PATH}`,"command -v docker >/dev/null 2>&1 || { echo 'Docker is not installed on this machine.' >&2; exit 3; }",
    `mkdir -p ${quote(dir)}`,
    `if docker inspect ${quote(container)} >/dev/null 2>&1; then docker start ${quote(container)} >/dev/null; else docker run -d --name ${quote(container)} --restart unless-stopped -v ${quote(dir+':/root')} -w /root${p.web?` -p 127.0.0.1:${containers.webPort(container)}:${p.web}`:''} node:22-bookworm sleep infinity >/dev/null || exit 1; fi`,
    `docker exec ${quote(container)} sh -c ${quote(`command -v ${CLI[id].bin} >/dev/null 2>&1 || npm install -g ${p.npm}@latest`)} >/dev/null || exit 1`].join('\n');
  await run(where,script,15*60*1000);
}
async function copy({agent,sourceHost,id,scope,keys,to,dest,backup,progress}){
  const from=place({agent,host:sourceHost});
  progress({step:'source',state:'active',message:`Finding ${agent.name}'s folders`});
  const home=from.home||(from.container?'/root':await homeOf(from)); // a profile in a container has its own HOME
  const {wanted,excludes,config}=plan(id,scope,keys);
  const paths=await existing(from,home,wanted),hasConfig=!!config&&(await existing(from,home,[config])).length>0;
  const extra=hasConfig&&!paths.some(p=>config.startsWith(p+'/'))?[config]:[];
  if(!paths.length&&!hasConfig)throw new Error(`Nothing to copy: ${agent.name} has none of ${[...wanted,...(config?[config]:[])].join(', ')}.`);
  progress({step:'source',state:'done',message:`Source: ${home}`});
  const size=paths.length?await measure(from,home,paths):{bytes:0,files:0};
  progress({step:'select',state:'done',message:`${[...paths,...extra].join(', ')} (${size.files} files, ${fmt(size.bytes)}), without chat history${keys?'':', logins or API keys'}`,total:size.bytes});
  if(backup){
    const there=await existing(to,dest,[...paths,...extra]);
    if(there.length){
      const stamp=new Date().toISOString().slice(0,19).replace(/[-:T]/g,'');
      if(isLocal(to)){for(const p of there)await fs.rename(path.join(dest,p),path.join(dest,`${p}.before-clone-${stamp}`));}
      else await run(to,`cd ${quote(dest)} && for p in ${there.map(quote).join(' ')}; do mv "$p" "$p.before-clone-${stamp}"; done`);
      progress({message:`Kept what was already there as ${there.map(p=>`${p}.before-clone-${stamp}`).join(', ')}`});
    }
  }
  progress({step:'copy',state:'active',message:`Copying to ${dest}`,bytes:0,total:size.bytes});
  let last=0;
  const sent=paths.length?await transfer(from,home,paths,to,dest,{excludes,onBytes:n=>{const now=Date.now();if(now-last>200){last=now;progress({step:'copy',bytes:n,total:size.bytes});}}}):0;
  const wrote=hasConfig&&await copyConfig(from,home,to,dest,config,progress);
  progress({step:'copy',state:'done',message:`Copied ${fmt(sent)}`,bytes:sent,total:Math.max(size.bytes,sent)});
  return [...paths,...(wrote?extra:[])];
}
// The config without its credentials; on a redeploy the clone keeps its own. A config that is not plain JSON stays behind.
async function copyConfig(from,home,to,dest,file,progress){
  const read=(where,dir)=>isLocal(where)?fs.readFile(path.join(dir,file),'utf8').catch(()=>''):run(where,`cat ${quote(`${dir}/${file}`)} 2>/dev/null; true`);
  const mine=await read(to,dest),text=openclawWithoutSecrets(await read(from,home),mine);
  if(text===null){progress({message:`${file} is not plain JSON, so Opaya left it out: it can hold API keys and tokens. Set the clone up there (openclaw onboard).`});return false;}
  if(isLocal(to)){const target=path.join(dest,file);await fs.mkdir(path.dirname(target),{recursive:true,mode:0o700});await fs.writeFile(target,text,{mode:0o600});}
  else await collect(shell(to,`cd ${quote(dest)} && mkdir -p ${quote(path.posix.dirname(file))} && umask 077 && cat > ${quote(file)}`),{input:text,timeout:30000});
  progress({message:mine?`${file} copied; the clone keeps its own gateway token, API keys and channel tokens.`:`${file} copied without its gateway token, API keys and channel tokens. Run openclaw doctor --generate-gateway-token there and add its keys.`});
  return true;
}
async function startGateway(where,progress){
  progress({message:'Starting the OpenClaw gateway'});
  try{await run(where,`${REMOTE_PATH}; ${catalog.setupCommand('openclaw','start_gateway',{remote:true}).command} </dev/null >/dev/null 2>&1; true`,120000);}
  catch{progress({message:'Start the OpenClaw gateway there if it is not running (the Opaya Agent can do it).'});}
}
// `unique(connection)` throws when that connection is already saved; it runs before anything on the target changes.
async function clone({agent,sourceHost,host,runtime='regular',scope='everything',keys=true,name,unique=()=>{},progress=()=>{}}){
  const id=frameworkOf(agent),c=CLI[id],n=slug(name);if(!n)throw new Error('Give the clone a name with letters or numbers.');
  const where={host:host||null,container:''};
  if(runtime==='docker'&&!host&&process.platform==='win32')throw new Error('Docker clones to this Windows computer are not available yet. Clone to a machine.');
  if(runtime==='docker'&&!containers.PLANS[id]?.npm)throw new Error(`${c.name} cannot run in a Docker container from Opaya. Clone it as a regular install.`);
  if(runtime!=='docker'&&sameAccount(agent,host))throw new Error(`${c.name} keeps one setup per computer account, and ${agent.name} already uses this one. Clone it to another machine, or into a Docker container.`);
  progress({step:'target',state:'active',message:`Checking ${host?host.name:'this computer'}`});
  const home=await homeOf(where),container=runtime==='docker'?`opaya-${n}`.slice(0,60):'',dest=runtime==='docker'?`${home}/opaya-agents/${n}`:home;
  const base=runtime==='docker'?{...containers.PLANS[id].connection(container)}:c.connection();
  const connection={...base,name:String(name).trim().slice(0,80),transport:host?'ssh':base.protocol==='openai'?'http':'local',hostId:host?.id||'',cwd:runtime==='docker'?'/root':home,
    group:agent.group||'',tags:[...new Set([...(agent.tags||[]),'clone'])].slice(0,8),
    clone:{from:agent.id,framework:id,scope,keys:!!keys,runtime,dir:dest,container}};
  await unique(connection);
  if(runtime==='docker'){
    progress({step:'target',state:'active',message:`Starting container ${container} with ${c.name} (the first start downloads Node.js, which can take a few minutes)`});
    await startContainer(id,where,container,dest);
  }else await ensureInstalled(id,where,host,progress);
  progress({step:'target',state:'done',message:`Target: ${dest}${container?` (container ${container})`:''}`});
  const copied=await copy({agent,sourceHost,id,scope,keys,to:where,dest,backup:runtime!=='docker',progress});
  if(id==='openclaw'&&runtime!=='docker')await startGateway(where,progress);
  return {connection,copied,copyToken:id==='openclaw'&&runtime!=='docker'&&keys};
}
// Copy the same parts again; existing files on the clone are replaced, its chat history stays.
async function redeploy({agent,source,sourceHost,host,progress=()=>{}}){
  const c=agent.clone,to={host:host||null,container:''};
  const copied=await copy({agent:source,sourceHost,id:c.framework,scope:c.scope,keys:c.keys,to,dest:c.dir,backup:false,progress});
  if(c.framework==='openclaw'&&!c.container)await startGateway(to,progress);
  return {copied};
}
module.exports={CLI,plan,clone,redeploy,sameAccount,copy};
