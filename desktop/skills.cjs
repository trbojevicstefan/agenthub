'use strict';
// Installed skills: folders with a SKILL.md (name and description in its front matter). Read-only; installing goes
// through the agent's own CLI in a visible terminal after approval.
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {findExecutable,environment,sshArgs,target,quote,collect}=require('./process.cjs');
const {hermesHomes}=require('./diagnostics.cjs');
const MAX=400;
// Where each agent keeps skills. `~` is the home folder of the machine the agent runs on; `.` is its working directory.
function skillDirs(agent,{remote=false}={}){
  const cwd=agent.cwd||'';
  switch(agent.provider){
    case 'hermes':return remote?[agent.hermesHome?`${agent.hermesHome}/skills`:'@hermes/skills']:hermesHomes(agent).map(h=>path.join(h,'skills'));
    case 'claude':return [remote?'~/.claude/skills':path.join(os.homedir(),'.claude','skills'),cwd&&(remote?`${cwd}/.claude/skills`:path.join(cwd,'.claude','skills'))].filter(Boolean);
    case 'codex':return [remote?'~/.codex/skills':path.join(os.homedir(),'.codex','skills'),cwd&&(remote?`${cwd}/.codex/skills`:path.join(cwd,'.codex','skills'))].filter(Boolean);
    case 'openclaw':return [remote?'~/.openclaw/skills':path.join(os.homedir(),'.openclaw','skills'),cwd&&(remote?`${cwd}/skills`:path.join(cwd,'skills'))].filter(Boolean);
    default:return [];
  }
}
function frontMatter(text){
  const m=/^---\r?\n([\s\S]*?)\r?\n---/.exec(text);const out={};if(!m)return out;
  for(const line of m[1].split(/\r?\n/)){const kv=/^(name|description):\s*(.*)$/.exec(line);if(kv)out[kv[1]]=kv[2].replace(/^["']|["']$/g,'').trim();}
  return out;
}
const clean=(file,meta,root)=>{const folder=path.basename(path.dirname(file));const name=String(meta.name||folder).slice(0,80);return /^[\w.:-]{1,80}$/.test(name)?{name,description:String(meta.description||'').slice(0,400),category:path.relative(root,path.dirname(path.dirname(file))).split(/[\\/]/).filter(Boolean).join('/').slice(0,80),path:file}:null;};
async function localSkills(dirs){
  const found=[];
  const walk=async(dir,root,depth)=>{
    if(found.length>=MAX||depth>3)return;let entries;try{entries=await fs.readdir(dir,{withFileTypes:true});}catch{return;}
    if(entries.some(e=>e.isFile()&&e.name==='SKILL.md')){const file=path.join(dir,'SKILL.md');try{const handle=await fs.open(file,'r');try{const buffer=Buffer.alloc(4096);const {bytesRead}=await handle.read(buffer,0,4096,0);const s=clean(file,frontMatter(buffer.subarray(0,bytesRead).toString('utf8')),root);if(s)found.push(s);}finally{await handle.close();}}catch{}return;}
    for(const e of entries)if(e.isDirectory()&&!e.name.startsWith('.')&&e.name!=='node_modules')await walk(path.join(dir,e.name),root,depth+1);
  };
  for(const dir of dirs)await walk(dir,dir,0);
  return found;
}
// Skills on an SSH machine or inside a container (Hermes in Docker keeps them in the container, not on the host).
// Plain sh and find, so it works without python3; the Hermes home is resolved the same way clone and transfer do.
const MARK='@@OPAYA-SKILL@@';
async function remoteSkills(agent,host,dirs){
  const {place,run,sourceHome}=require('./clone.cjs');
  const where=place({agent,host});
  let roots=dirs;
  if(agent.provider==='hermes')roots=[path.posix.join(await sourceHome(agent,where),'skills')];
  const arg=d=>d==='~'?'"$HOME"':d.startsWith('~/')?`"$HOME"/${quote(d.slice(2))}`:quote(d);
  const script=`for d in ${roots.map(arg).join(' ')}; do [ -d "$d" ] || continue; find "$d" -maxdepth 5 \\( \\( -name '.*' -o -name node_modules \\) -type d -prune \\) -o \\( -type f -name SKILL.md -print \\) 2>/dev/null | while IFS= read -r f; do printf '\\n${MARK}%s\\t%s\\n' "$d" "$f"; head -c 2048 "$f"; done; done; true`;
  const out=await run(where,script,25000);
  const rows=[];
  for(const chunk of out.split('\n'+MARK).slice(1)){
    const nl=chunk.indexOf('\n'),head=nl<0?'':chunk.slice(nl+1),[root,file]=(nl<0?chunk:chunk.slice(0,nl)).split('\t');
    if(!root||!file)continue;const s=clean(file,frontMatter(head),root);if(s)rows.push(s);if(rows.length>=MAX)break;
  }
  return {skills:rows,roots};
}
async function listSkills(agent,host){
  const inContainer=agent.command==='docker',remote=agent.transport==='ssh'||inContainer;
  const dirs=skillDirs(agent,{remote});
  if(!dirs.length)return {skills:[],dirs:[],supported:false};
  if(!remote){const skills=await localSkills(dirs);skills.sort((a,b)=>a.name.localeCompare(b.name));return {skills,dirs,supported:true};}
  const r=await remoteSkills(agent,host,dirs);r.skills.sort((a,b)=>a.name.localeCompare(b.name));
  return {skills:r.skills,dirs:r.roots,supported:true};
}
// Skill ids accepted by `hermes skills install`: hub ids (official/security/1password, skills-sh/owner/repo/skill) or
// an https URL to a SKILL.md. Checked strictly because the id becomes a command argument.
function skillId(value){
  const v=String(value||'').trim();
  if(/^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*){0,6}$/i.test(v)&&v.length<=200)return v;
  if(/^https:\/\/[a-z0-9.-]+(:\d+)?(\/[\w.~%-]+)*\/SKILL\.md$/i.test(v)&&v.length<=500)return v;
  throw new Error('Use a skill id such as official/security/1password, or an https:// link to a SKILL.md.');
}
// Hermes manages skills with its own CLI (`hermes skills ...`). Runs in a visible terminal after approval.
function hermesSkillCommand(agent,{action,skill,remote,windows}){
  if(agent.provider!=='hermes')throw new Error('Installing skills from Opaya is available for Hermes. For other agents, add a skill folder with a SKILL.md to the skills folder shown here.');
  if(agent.command==='docker')throw new Error('This Hermes runs in a container. Install skills inside the container with `hermes skills install`.');
  const args=action==='browse'?'skills browse':action==='install'?`skills install ${skillId(skill)}`:(()=>{throw new Error('Unknown skill action.');})();
  const home=agent.hermesHome||'';
  if(remote||!windows)return `${home?`HERMES_HOME=${quote(home)} `:''}hermes ${args}`;
  return `${home?`$env:HERMES_HOME='${home.replace(/'/g,"''")}'; `:''}hermes ${args}`;
}
module.exports={localSkills,remoteSkills,listSkills,skillDirs,frontMatter,skillId,hermesSkillCommand};
