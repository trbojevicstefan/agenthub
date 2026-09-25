'use strict';
// Agent maintenance: how an agent is installed, updating it, uninstalling it, and local backups of its data.
// Commands are fixed per framework and pick the right uninstaller on the machine itself (npm, Homebrew, uv, pipx,
// pip or the vendor's installer). The only values put into them are validated container names, profile names and
// folders, always quoted. Update and uninstall run in a visible terminal after the user approves the exact command.
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const zlib=require('node:zlib');
const {spawn}=require('node:child_process');
const {REMOTE_PATH,findExecutable,environment,quote,collect,dockerExecContainerIndex}=require('./process.cjs');
const {place,shell,run,sourceHome,isLocal,measure,slug}=require('./clone.cjs');
const catalog=require('./catalog.cjs');
const {hermesHomes}=require('./diagnostics.cjs');

const PATH_PREFIX=REMOTE_PATH;
// How each framework can be installed. `files` are what the vendor installer puts in place; `data` is the agent's own
// folder (settings, logins, memory), deleted only when the user asks. Paths are relative to the home folder.
const TOOLS={
  hermes:{name:'Hermes Agent',bin:'hermes',uv:'hermes-agent',pipx:'hermes-agent',own:true,files:['.local/bin/hermes'],data:[]},
  claude:{name:'Claude Code',bin:'claude',npm:'@anthropic-ai/claude-code',brew:'claude-code',files:['.local/bin/claude','.local/share/claude'],data:['.claude','.claude.json'],
    win:{files:['.local\\bin\\claude.exe','.local\\share\\claude'],data:['.claude','.claude.json']}},
  codex:{name:'Codex CLI',bin:'codex',npm:'@openai/codex',brew:'codex',files:[],data:['.codex'],win:{data:['.codex']}},
  openclaw:{name:'OpenClaw',bin:'openclaw',npm:'openclaw',brew:'openclaw',files:[],data:['.openclaw'],win:{data:['.openclaw']}},
  'gemini-cli':{name:'Gemini CLI',bin:'gemini',npm:'@google/gemini-cli',brew:'gemini-cli',files:[],data:['.gemini'],win:{data:['.gemini']}},
  opencode:{name:'OpenCode',bin:'opencode',npm:'opencode-ai',brew:'opencode',files:['.opencode'],data:['.config/opencode','.local/share/opencode'],win:{data:['.config\\opencode','.local\\share\\opencode']}},
  goose:{name:'Goose',bin:'goose',brew:'block-goose-cli',files:['.local/bin/goose'],data:['.config/goose']},
  aider:{name:'Aider',bin:'aider',uv:'aider-chat',pipx:'aider-chat',pip:'aider-chat',files:['.local/bin/aider'],data:['.aider.conf.yml','.aider.model.settings.yml'],win:{pip:'aider-chat',data:['.aider.conf.yml']}},
  ollama:{name:'Ollama',bin:'ollama',brew:'ollama',files:['Applications/Ollama.app'],system:true,data:['.ollama'],win:{winget:'Ollama.Ollama',data:['.ollama']}}
};
// What a local backup holds. `dirs` are copied entry by entry so history and keys can be left out by name.
const HISTORY={hermes:['state.db','state.db-wal','state.db-shm','sessions','logs','checkpoints','state-snapshots'],claude:['projects','todos','shell-snapshots','statsig'],codex:['sessions','history.jsonl','log'],openclaw:['sessions','logs'],'gemini-cli':['tmp'],opencode:['log','snapshot']};
const SECRETS={hermes:['.env','auth.json'],claude:['.credentials.json'],codex:['auth.json'],openclaw:['credentials','.env'],'gemini-cli':['oauth_creds.json','.env'],opencode:['auth.json']};
// Never part of a backup: the Hermes installation itself, caches and other profiles (they are agents of their own).
const HERMES_SKIP=['hermes-agent','venv','node','python','git','bin','cache','.install','profiles','backups'];
const BACKUP={
  claude:{dirs:['.claude'],files:['.claude.json']},
  codex:{dirs:['.codex'],files:[]},
  openclaw:{dirs:['.openclaw'],files:[]},
  'gemini-cli':{dirs:['.gemini'],files:[]},
  opencode:{dirs:['.config/opencode','.local/share/opencode'],files:[]},
  goose:{dirs:['.config/goose'],files:[]}
};
const CONTAINER=/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const PROFILE=/^[a-z0-9][a-z0-9_-]{0,63}$/;
const IMAGE='nousresearch/hermes-agent';
// A folder Opaya may delete: absolute, at least two levels deep, and not a home folder itself.
function deletable(dir){
  const p=String(dir||'').replace(/\\/g,'/').replace(/\/+$/,''),parts=p.split('/').filter(Boolean);
  if(!/^(\/|[A-Za-z]:\/)/.test(p)||parts.length<3||/^(\/home\/[^/]+|\/Users\/[^/]+|\/root|[A-Za-z]:\/Users\/[^/]+)$/.test(p))throw new Error(`Opaya will not delete ${dir}. Delete it yourself if you are sure.`);
  return dir;
}

function containerOf(agent){
  const i=agent.command==='docker'?dockerExecContainerIndex(agent.args||[]):-1;
  const name=i>=0?String(agent.args[i]):'';
  return CONTAINER.test(name)?name:'';
}
// A Hermes profile lives in <root>/profiles/<name>; the root home and the installation are shared with other profiles.
function profileOf(agent){
  if(agent.provider!=='hermes'||!agent.hermesHome)return null;
  const parts=agent.hermesHome.replace(/\\/g,'/').replace(/\/+$/,'').split('/');
  const name=parts.at(-1),parent=parts.at(-2);
  return parent==='profiles'&&PROFILE.test(name)?{name,dir:agent.hermesHome}:null;
}
// Which catalog framework an agent runs, from its provider or command.
function frameworkOf(agent){
  if(['hermes','claude','codex','openclaw'].includes(agent.provider))return agent.provider;
  if(agent.provider==='ollama')return /\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(agent.endpoint||'')||agent.transport==='ssh'?'ollama':'';
  // In a container the program is the one `docker exec` runs, right after the container name.
  const i=agent.command==='docker'?dockerExecContainerIndex(agent.args||[]):-1;
  const bin=path.basename(String(i>=0?agent.args[i+1]||'':agent.command||'')).replace(/\.(exe|cmd|bat|ps1)$/i,'').toLowerCase();
  return {gemini:'gemini-cli',opencode:'opencode',goose:'goose',aider:'aider',ollama:'ollama'}[bin]||'';
}
// The installation kind decides which update, uninstall and backup apply.
function kindOf(agent){
  const container=containerOf(agent),framework=frameworkOf(agent),profile=profileOf(agent);
  if(container)return {kind:'docker',label:'Docker container',framework,container,managed:!!agent.clone?.container&&agent.clone.container===container,dir:agent.clone?.dir||''};
  if(!framework)return {kind:'remote-api',label:agent.protocol==='openai'?'API connection':'Custom command',framework:''};
  if(profile)return {kind:'hermes-profile',label:`Hermes profile "${profile.name}"`,framework,profile:profile.name,dir:profile.dir};
  return {kind:'cli',label:TOOLS[framework]?.name||framework,framework};
}
const posixScript=lines=>`sh -c ${quote([PATH_PREFIX,...lines].join('\n'))}`;
const q=quote;
// The readable script inside `sh -c '...'`, for the approval dialog.
function previewOf(command){
  if(!command.startsWith("sh -c '")||!command.endsWith("'"))return command;
  return command.slice(7,-1).replace(/'\\''/g,"'").split('\n').filter(line=>line!==PATH_PREFIX).join('\n');
}
const withPreview=fn=>(...args)=>{const r=fn(...args);return {...r,preview:previewOf(r.command)};};
// ---- Update --------------------------------------------------------------------------------------------------
function updateCommand(agent,{remote,windows=process.platform==='win32'}){
  const k=kindOf(agent),posix=remote||!windows;
  if(k.kind==='remote-api')throw new Error('This is an API connection: the provider updates it. There is nothing to install here.');
  if(k.kind==='docker'){
    const c=k.container;
    if(k.managed&&k.dir){
      const run=`docker run -d --name ${q(c)} --restart unless-stopped -v ${q(k.dir+':/opt/data')} ${IMAGE} gateway run`;
      return {title:`Update container ${c}`,summary:`Downloads the newest ${IMAGE} image and recreates ${c} with the same data folder.`,after:'Reconnect the agent when the container runs again.',
        command:posix?posixScript([`docker pull ${IMAGE}`,`docker rm -f ${q(c)} >/dev/null`,run,`echo 'Container ${c} runs the new image.'`]):`docker pull ${IMAGE}; docker rm -f ${q(c)}; ${run}`};
    }
    // Installed by Opaya with Install agents > Docker: an npm CLI in a Node.js container, or Hermes from its image.
    const plan=require('./containers.cjs').PLANS[k.framework];
    if(/^opaya-/.test(c)&&plan?.npm){
      const cmd=`docker exec ${q(c)} npm install -g ${plan.npm}@latest`;
      return {title:`Update ${plan.name} in ${c}`,summary:`Updates ${plan.name} inside the container to its latest version.`,after:'Reconnect the agent afterwards.',command:posix?posixScript([cmd]):cmd};
    }
    if(/^opaya-/.test(c)&&k.framework==='hermes'&&plan?.image){
      const dir=`"$HOME/${plan.dir}/${c.replace(/^opaya-/,'')}"`;
      const lines=[`docker pull ${plan.image} || exit 1`,`docker rm -f ${q(c)} >/dev/null`,`docker run -d --name ${q(c)} --restart unless-stopped -v ${dir}:${plan.mount} -e HERMES_HOME=${plan.mount} --entrypoint sleep ${plan.image} infinity >/dev/null && echo 'Container ${c} runs the newest Hermes image.'`];
      return {title:`Update container ${c}`,summary:`Downloads the newest ${plan.image} and recreates ${c} with the same data folder.`,after:'Reconnect the agent afterwards.',command:posixScript(lines)};
    }
    const lines=[`img=$(docker inspect -f '{{.Config.Image}}' ${q(c)}) || exit 1`,'docker pull "$img" || exit 1',
      `dir=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' ${q(c)} 2>/dev/null)`,
      `if [ -n "$dir" ] && [ "$dir" != '<no value>' ] && [ -d "$dir" ]; then echo "Recreating with Docker Compose in $dir"; (cd "$dir" && docker compose up -d); else echo 'Image updated. Recreate the container with your own docker run command to use it; Opaya did not create this container.'; fi`];
    return {title:`Update container ${c}`,summary:'Pulls the newest version of the container image and, for Docker Compose, recreates the container.',after:'Reconnect the agent afterwards.',
      command:posix?posixScript(lines):`$img=(docker inspect -f '{{.Config.Image}}' ${q(c)}); docker pull $img; 'Image updated. Recreate the container to use it.'`};
  }
  if(k.framework==='hermes'){
    const cmd='hermes update';
    return {title:'Update Hermes',summary:k.kind==='hermes-profile'?'Updates the Hermes installation. Every profile on this machine uses it.':'Updates Hermes with its own updater.',after:'Reconnect Hermes agents on this machine afterwards.',command:posix?posixScript([cmd]):cmd};
  }
  const {framework,command}=catalog.command(k.framework,{remote,update:true});
  return {title:`Update ${framework.name}`,summary:`Brings ${framework.name} to its latest version.`,after:'Reconnect the agent afterwards.',command};
}
// ---- Uninstall -----------------------------------------------------------------------------------------------
function posixUninstall(t,{data}){
  const lines=['found=0'];
  if(t.npm)lines.push(`if command -v npm >/dev/null 2>&1 && npm ls -g --depth=0 ${t.npm} >/dev/null 2>&1; then echo 'Installed with npm (${t.npm})'; npm uninstall -g ${t.npm} && found=1; fi`);
  if(t.brew)lines.push(`if command -v brew >/dev/null 2>&1 && brew list ${t.brew} >/dev/null 2>&1; then echo 'Installed with Homebrew (${t.brew})'; brew uninstall ${t.brew} && found=1; fi`);
  if(t.uv)lines.push(`if command -v uv >/dev/null 2>&1 && uv tool list 2>/dev/null | grep -q '^${t.uv} '; then echo 'Installed with uv (${t.uv})'; uv tool uninstall ${t.uv} && found=1; fi`);
  if(t.pipx)lines.push(`if command -v pipx >/dev/null 2>&1 && pipx list --short 2>/dev/null | grep -q '^${t.pipx} '; then echo 'Installed with pipx (${t.pipx})'; pipx uninstall ${t.pipx} && found=1; fi`);
  if(t.pip)lines.push(`if [ "$found" = 0 ] && command -v python3 >/dev/null 2>&1 && python3 -m pip show ${t.pip} >/dev/null 2>&1; then echo 'Installed with pip (${t.pip})'; python3 -m pip uninstall -y ${t.pip} && found=1; fi`);
  if(t.system)lines.push(`if [ "$found" = 0 ] && [ "$(uname)" = Linux ] && [ -x /usr/local/bin/${t.bin} ]; then echo 'Installed with the official Linux installer'; if command -v systemctl >/dev/null 2>&1; then sudo systemctl disable --now ${t.bin} 2>/dev/null; sudo rm -f /etc/systemd/system/${t.bin}.service; fi; sudo rm -rf /usr/local/bin/${t.bin} /usr/local/lib/${t.bin} && found=1; fi`);
  if(t.files?.length)lines.push(`for f in ${t.files.map(f=>`"$HOME"/${q(f)}`).join(' ')}; do if [ -e "$f" ] || [ -L "$f" ]; then rm -rf "$f" && echo "Removed $f" && found=1; fi; done`);
  if(data&&t.data?.length)lines.push(`for f in ${t.data.map(f=>`"$HOME"/${q(f)}`).join(' ')}; do if [ -e "$f" ]; then rm -rf "$f" && echo "Deleted data: $f"; fi; done`);
  lines.push(`if [ "$found" = 1 ]; then echo '${t.name} is uninstalled.'; else echo 'No ${t.name} installation was found through npm, Homebrew, uv, pipx, pip or the official installer.'; fi`,
    `hash -r 2>/dev/null; if command -v ${t.bin} >/dev/null 2>&1; then echo "Still on PATH: $(command -v ${t.bin}). Remove it with the tool that installed it."; fi`);
  return posixScript(lines);
}
function windowsUninstall(t,{data}){
  const w=t.win||{},parts=[];
  if(t.npm)parts.push(`npm ls -g --depth=0 ${t.npm} *> $null; if ($LASTEXITCODE -eq 0) { 'Installed with npm (${t.npm})'; npm uninstall -g ${t.npm} }`);
  if(w.winget)parts.push(`winget uninstall --id ${w.winget} -e`);
  if(w.pip)parts.push(`py -m pip uninstall -y ${w.pip}`);
  for(const f of w.files||[])parts.push(`$f=Join-Path $env:USERPROFILE '${f}'; if (Test-Path $f) { Remove-Item -Recurse -Force $f; "Removed $f" }`);
  if(data)for(const f of w.data||[])parts.push(`$f=Join-Path $env:USERPROFILE '${f}'; if (Test-Path $f) { Remove-Item -Recurse -Force $f; "Deleted data: $f" }`);
  parts.push(`if (Get-Command ${t.bin} -ErrorAction SilentlyContinue) { 'Still on PATH: ' + (Get-Command ${t.bin}).Source + '. Remove it in Settings > Apps.' } else { '${t.name} is uninstalled.' }`);
  return parts.join('; ');
}
function uninstallCommand(agent,{remote,data=false,windows=process.platform==='win32'}){
  const k=kindOf(agent),posix=remote||!windows;
  if(k.kind==='remote-api')throw new Error('This is an API connection. There is nothing installed to remove; remove the connection instead.');
  if(k.kind==='docker'){
    const c=k.container,dir=data&&k.managed&&k.dir?deletable(k.dir):'';
    return {title:`Remove container ${c}`,summary:`Stops and deletes the container ${c}.${dir?` Also deletes its data folder ${dir}.`:k.managed?' Its data folder stays.':' Volumes and the image stay.'}`,
      command:posix?posixScript([`docker rm -f ${q(c)} && echo 'Container ${c} removed.'`,...(dir?[`rm -rf ${q(dir)} && echo 'Deleted data: ${dir.replace(/'/g,'')}'`]:[])]):`docker rm -f ${q(c)}${dir?`; Remove-Item -Recurse -Force ${q(dir)}`:''}`};
  }
  if(k.kind==='hermes-profile'){
    const n=k.profile;deletable(k.dir);
    return {title:`Delete Hermes profile ${n}`,summary:`Deletes the profile ${n} and everything in it (config, memory, skills, sessions). Hermes itself and other profiles stay.`,
      command:posix?posixScript([`if hermes profile delete --help >/dev/null 2>&1; then hermes profile delete ${q(n)}; else rm -rf ${q(k.dir)} && echo 'Deleted profile folder ${k.dir.replace(/'/g,'')}'; fi`])
        :`if (hermes profile delete --help 2>$null) { hermes profile delete ${q(n)} } else { Remove-Item -Recurse -Force ${q(k.dir)}; 'Deleted profile folder' }`};
  }
  const t=TOOLS[k.framework];if(!t)throw new Error('Opaya has no uninstaller for this agent.');
  if(k.framework==='hermes'){
    const home=agent.hermesHome?q(agent.hermesHome):'"${HERMES_HOME:-$HOME/.hermes}"';
    const lines=[`home=${home}`,
      'if hermes uninstall --help >/dev/null 2>&1; then echo "Running Hermes\' own uninstaller"; hermes uninstall',
      `elif command -v uv >/dev/null 2>&1 && uv tool list 2>/dev/null | grep -q '^hermes-agent '; then uv tool uninstall hermes-agent`,
      `elif command -v pipx >/dev/null 2>&1 && pipx list --short 2>/dev/null | grep -q '^hermes-agent '; then pipx uninstall hermes-agent`,
      `else rm -rf "$home/hermes-agent" "$home/venv" "$HOME/.local/bin/hermes" && echo 'Removed the Hermes installation'; fi`,
      ...(data?['case "$home" in /|"$HOME"|"$HOME/"|"") echo "Opaya will not delete $home." ;; *) rm -rf "$home" && echo "Deleted data: $home" ;; esac']:[]),
      'hash -r 2>/dev/null; command -v hermes >/dev/null 2>&1 && echo "Still on PATH: $(command -v hermes)" || echo "Hermes is uninstalled."'];
    return {title:'Uninstall Hermes',summary:`Removes the Hermes installation${data?' and its home folder (config, memory, skills, sessions, every profile)':'. Its home folder with config, memory, skills and profiles stays'}.`,
      command:posix?posixScript(lines):`if (hermes uninstall --help 2>$null) { hermes uninstall } else { 'Remove Hermes in Settings > Apps.' }`};
  }
  return {title:`Uninstall ${t.name}`,summary:`Finds how ${t.name} was installed (npm, Homebrew, uv, pipx, pip or the official installer) and removes it${data?', then deletes its data folder':'. Its settings and logins stay'}.`,
    command:posix?posixUninstall(t,{data}):windowsUninstall(t,{data})};
}
// ---- Detection -----------------------------------------------------------------------------------------------
// Read-only: which installers own the agent, its path, version and data size. Parsed from key=value lines.
function detectScript(agent,{windows}){
  const k=kindOf(agent),t=TOOLS[k.framework]||{};
  if(k.kind==='docker')return windows?null:`docker inspect -f 'image={{.Config.Image}}' ${q(k.container)} 2>/dev/null; docker inspect -f 'state={{.State.Status}}' ${q(k.container)} 2>/dev/null; v=$(docker exec ${q(k.container)} sh -c 'hermes --version 2>/dev/null | head -1' 2>/dev/null); [ -n "$v" ] && echo "version=$v"; true`;
  if(!t.bin)return null;
  if(windows)return [`$p=(Get-Command ${t.bin} -ErrorAction SilentlyContinue).Source; "path=$p"`,`if ($p) { "version=" + ((& ${t.bin} --version 2>&1 | Select-Object -First 1)) }`,
    ...(t.npm?[`npm ls -g --depth=0 ${t.npm} *> $null; if ($LASTEXITCODE -eq 0) { 'method=npm' }`]:[]),
    ...((t.win?.files||[]).map(f=>`if (Test-Path (Join-Path $env:USERPROFILE '${f}')) { 'method=installer' }`))].join('; ');
  const home=k.kind==='hermes-profile'?q(k.dir):agent.hermesHome?q(agent.hermesHome):'"${HERMES_HOME:-$HOME/.hermes}"';
  return [PATH_PREFIX,`p=$(command -v ${t.bin} 2>/dev/null); echo "path=$p"`,`[ -n "$p" ] && echo "version=$(${t.bin} --version 2>&1 | head -1)"`,
    ...(t.npm?[`command -v npm >/dev/null 2>&1 && npm ls -g --depth=0 ${t.npm} >/dev/null 2>&1 && echo method=npm`]:[]),
    ...(t.brew?[`command -v brew >/dev/null 2>&1 && brew list ${t.brew} >/dev/null 2>&1 && echo method=brew`]:[]),
    ...(t.uv?[`command -v uv >/dev/null 2>&1 && uv tool list 2>/dev/null | grep -q '^${t.uv} ' && echo method=uv`]:[]),
    ...(t.pipx?[`command -v pipx >/dev/null 2>&1 && pipx list --short 2>/dev/null | grep -q '^${t.pipx} ' && echo method=pipx`]:[]),
    ...(k.framework==='hermes'?[`[ -d ${home}/hermes-agent ] || [ -d "\${HERMES_HOME:-$HOME/.hermes}/hermes-agent" ] && echo method=installer`,`[ -d ${home} ] && echo "data=$(du -sh ${home} 2>/dev/null | cut -f1)"`]:[]),
    ...((t.files||[]).map(f=>`[ -e "$HOME"/${q(f)} ] && echo method=installer`)),
    ...(k.framework!=='hermes'&&t.data?.length?[`du -sch ${t.data.map(f=>`"$HOME"/${q(f)}`).join(' ')} 2>/dev/null | tail -1 | cut -f1 | sed 's/^/data=/'`]:[]),'true'].join('\n');
}
const METHODS={npm:'npm (global package)',brew:'Homebrew',uv:'uv tool',pipx:'pipx',pip:'pip',installer:'Official installer'};
async function detect(agent,host){
  const k=kindOf(agent),remote=agent.transport==='ssh',windows=!remote&&process.platform==='win32';
  const info={...k,methods:[],path:'',version:'',data:'',image:'',state:''};
  const script=detectScript(agent,{windows});if(!script)return info;
  let out='';
  try{
    if(windows){const ps=findExecutable('powershell.exe',environment())||findExecutable('pwsh',environment());if(!ps)return info;out=await collect(spawn(ps,['-NoProfile','-Command',script],{windowsHide:true,stdio:['pipe','pipe','pipe']}),{timeout:30000});}
    else out=await run({host:remote?host:null,container:''},script,30000);
  }catch(error){info.error=String(error.message||error).slice(0,300);return info;}
  for(const line of out.split(/\r?\n/)){
    const m=/^(path|version|method|data|image|state)=(.*)$/.exec(line.trim());if(!m||!m[2])continue;
    if(m[1]==='method'){if(!info.methods.includes(m[2]))info.methods.push(m[2]);}else info[m[1]]=m[2].slice(0,200);
  }
  info.methodLabels=info.methods.map(m=>METHODS[m]||m);
  return info;
}
// ---- Local backup ---------------------------------------------------------------------------------------------
function backupDir(settings){return settings?.backupDir||path.join(os.homedir(),'Opaya Backups');}
const stamp=(d=new Date())=>d.toISOString().replace(/\..*$/,'').replace(/[-:]/g,'').replace('T','-');
// Which folders to read from, relative to `base`, for this agent.
async function backupSpec(agent,where){
  const k=kindOf(agent);
  if(agent.provider==='hermes'){
    let base;
    if(isLocal(where)&&!agent.hermesHome){for(const h of hermesHomes(agent)){try{await fsp.access(path.join(h,'config.yaml'));base=h;break;}catch{}}}
    base=base||await sourceHome(agent,where);
    return {base,dirs:['.'],files:[],skip:HERMES_SKIP,history:HISTORY.hermes,secrets:SECRETS.hermes,label:k.kind==='hermes-profile'?`Hermes profile ${k.profile}`:'Hermes home'};
  }
  const spec=BACKUP[k.framework];if(!spec)throw new Error('Opaya does not know where this agent keeps its data, so it cannot back it up.');
  const base=isLocal(where)?os.homedir():(await run(where,'printf %s "$HOME"')).trim();
  return {base,...spec,skip:[],history:HISTORY[k.framework]||[],secrets:SECRETS[k.framework]||[],label:`${TOOLS[k.framework]?.name||k.framework} data`};
}
// Top-level entries of each data folder, minus what the user left out. Returns tar member paths relative to base.
async function members(where,spec,{keys,history}){
  const drop=new Set([...spec.skip,...(history?[]:spec.history),...(keys?[]:spec.secrets)]),found=[];
  const join=(d,n)=>d==='.'?n:`${d}/${n}`;
  if(isLocal(where)){
    for(const d of spec.dirs){let names=[];try{names=await fsp.readdir(path.join(spec.base,d));}catch{continue;}for(const n of names)if(!drop.has(n))found.push(join(d,n));}
    for(const f of spec.files){try{await fsp.access(path.join(spec.base,f));found.push(f);}catch{}}
    return found;
  }
  const script=`cd ${q(spec.base)} || exit 1\n${spec.dirs.map(d=>`if [ -d ${q(d)} ]; then ls -A ${q(d)} | while IFS= read -r n; do printf '%s\\t%s\\n' ${q(d)} "$n"; done; fi`).join('\n')}\n${spec.files.map(f=>`[ -e ${q(f)} ] && printf '%s\\t%s\\n' @ ${q(f)}`).join('\n')}\ntrue`;
  for(const line of (await run(where,script,30000)).split('\n')){
    const [d,n]=line.split('\t');if(!n)continue;
    if(d==='@')found.push(n);else if(!drop.has(n))found.push(join(d,n));
  }
  return found;
}
function producer(where,base,paths){
  if(isLocal(where)){const tar=findExecutable('tar',environment());if(!tar)throw new Error('tar is not available on this computer.');return spawn(tar,['-cf','-','-C',base,...paths],{windowsHide:true,stdio:['ignore','pipe','pipe']});}
  return shell(where,`cd ${q(base)} && tar -cf - ${paths.map(q).join(' ')}`,{compress:true});
}
const fmt=n=>n<1024?`${n} B`:n<1048576?`${(n/1024).toFixed(1)} KB`:n<1073741824?`${(n/1048576).toFixed(1)} MB`:`${(n/1073741824).toFixed(2)} GB`;
// Streams the agent's data (this computer, SSH, or inside a container) into a .tar.gz on this computer, next to a
// small manifest describing the connection. The archive is private to the user (0600).
async function backup({agent,host,dest,keys=true,history=true,machine='',progress=()=>{}}){
  const where=place({agent,host:agent.transport==='ssh'?host:null});
  const at=where.host?where.host.name+(where.container?` / ${where.container}`:''):where.container?`container ${where.container}`:'this computer';
  progress({step:'source',state:'active',message:`Finding ${agent.name}'s data on ${at}`});
  const spec=await backupSpec(agent,where);
  progress({step:'source',state:'done',message:`${spec.label}: ${spec.base}`});
  progress({step:'select',state:'active',message:`Choosing files (${history?'with':'without'} chat history, ${keys?'with':'without'} API keys and logins)`});
  const paths=await members(where,spec,{keys,history});if(!paths.length)throw new Error(`Nothing to back up in ${spec.base}.`);
  const size=await measure(where,spec.base,paths);
  progress({step:'select',state:'done',message:`${paths.length} item${paths.length===1?'':'s'}: ${paths.slice(0,12).join(', ')}${paths.length>12?', ...':''} (${size.files} files, ${fmt(size.bytes)})`,total:size.bytes});
  const folder=path.join(dest,slug(agent.name)||'agent');await fsp.mkdir(folder,{recursive:true,mode:0o700});
  const name=`${slug(agent.name)||'agent'}-${stamp()}`,file=path.join(folder,`${name}.tar.gz`),part=file+'.part';
  progress({step:'copy',state:'active',message:`Writing ${file}`,bytes:0,total:size.bytes});
  const child=producer(where,spec.base,paths);let err='',sent=0,last=0;
  child.stderr?.on('data',d=>{err=(err+d).slice(-2000);});
  child.stdout.on('data',chunk=>{sent+=chunk.length;const now=Date.now();if(now-last>200){last=now;progress({step:'copy',bytes:sent,total:size.bytes});}});
  const out=fs.createWriteStream(part,{mode:0o600}),gzip=zlib.createGzip({level:6});
  const exit=new Promise(resolve=>{child.on('error',e=>resolve(e.message));child.on('close',code=>resolve(code));});
  const written=new Promise((resolve,reject)=>{out.on('finish',resolve);out.on('error',reject);gzip.on('error',reject);});
  child.stdout.pipe(gzip).pipe(out);
  const timer=setTimeout(()=>child.kill(),4*60*60*1000);
  try{const code=await exit;await written;clearTimeout(timer);if(code!==0)throw new Error(`Reading ${agent.name}'s data failed: ${String(err||code).trim().slice(0,400)}`);}
  catch(error){clearTimeout(timer);await fsp.rm(part,{force:true});throw error;}
  await fsp.rename(part,file);
  const bytes=(await fsp.stat(file)).size;
  progress({step:'copy',state:'done',message:`Saved ${fmt(bytes)} (${fmt(sent)} before compression)`,bytes:sent,total:Math.max(size.bytes,sent)});
  const {id,name:agentName,provider,protocol,transport,command,args,cwd,hermesHome,endpoint,model,displayName,description,group,tags,clone}=agent;
  const manifest={format:1,createdAt:new Date().toISOString(),agent:{id,name:agentName,provider,protocol,transport,command,args,cwd,hermesHome,endpoint,model,displayName,description,group,tags,clone},
    source:{machine:where.host?where.host.name:machine||'This computer',container:where.container,base:spec.base,kind:kindOf(agent).kind},contents:{items:paths,history:!!history,keys:!!keys},archive:path.basename(file),bytes};
  await fsp.writeFile(file.replace(/\.tar\.gz$/,'.json'),JSON.stringify(manifest,null,2),{mode:0o600});
  return {file,bytes,items:paths.length,keys:!!keys,history:!!history};
}
// Backups kept for an agent, newest first.
async function listBackups(agent,settings){
  const folder=path.join(backupDir(settings),slug(agent.name)||'agent');
  let names=[];try{names=await fsp.readdir(folder);}catch{return {folder,backups:[]};}
  const backups=[];
  for(const n of names.filter(n=>n.endsWith('.tar.gz'))){
    const file=path.join(folder,n);let st;try{st=await fsp.stat(file);}catch{continue;}
    const manifest=await fsp.readFile(file.replace(/\.tar\.gz$/,'.json'),'utf8').then(JSON.parse).catch(()=>null);
    backups.push({file,name:n,bytes:st.size,createdAt:manifest?.createdAt||st.mtime.toISOString(),keys:manifest?.contents?.keys,history:manifest?.contents?.history});
  }
  return {folder,backups:backups.sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,50)};
}
// Only files inside the backup folder can be shown or deleted from the UI.
function insideBackups(file,settings){
  const root=path.resolve(backupDir(settings)),p=path.resolve(String(file||''));
  if(p!==root&&!p.startsWith(root+path.sep))throw new Error('That file is not in the Opaya backup folder.');
  return p;
}
async function removeBackup(file,settings){
  const p=insideBackups(file,settings);if(!p.endsWith('.tar.gz'))throw new Error('Choose a backup archive.');
  await fsp.rm(p,{force:true});await fsp.rm(p.replace(/\.tar\.gz$/,'.json'),{force:true});return true;
}
// What the UI may offer for an agent, without touching the machine.
function capabilities(agent){
  const k=kindOf(agent),posix=agent.transport==='ssh'||process.platform!=='win32';
  const update=k.kind==='docker'||k.framework==='hermes'||!!catalog.UPDATES[k.framework]?.[posix?'posix':'windows'];
  return {kind:k.kind,label:k.label,framework:k.framework,update:k.kind!=='remote-api'&&update,uninstall:k.kind!=='remote-api'&&(k.kind!=='docker'||!!k.container),backup:agent.provider==='hermes'||!!BACKUP[k.framework]};
}
// Agents that share one installation: updating or uninstalling it affects all of them.
function sharing(agent,agents){
  const k=kindOf(agent);if(k.kind==='docker'||k.kind==='remote-api')return [];
  return agents.filter(a=>a.id!==agent.id&&a.transport===agent.transport&&(a.hostId||'')===(agent.hostId||'')&&!containerOf(a)&&frameworkOf(a)===k.framework).map(a=>a.id);
}
module.exports={TOOLS,kindOf,capabilities,frameworkOf,containerOf,profileOf,previewOf,updateCommand:withPreview(updateCommand),uninstallCommand:withPreview(uninstallCommand),detect,backup,backupDir,listBackups,removeBackup,insideBackups,sharing};
