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
const REMOTE=String.raw`
import json,os,sys
dirs=json.load(sys.stdin);out=[]
for d in dirs:
  if d.startswith('@hermes/'):d=os.path.join(os.environ.get('HERMES_HOME') or os.path.expanduser('~/.hermes'),d[8:])
  root=os.path.expanduser(d)
  for base,subs,files in os.walk(root):
    if base[len(root):].count(os.sep)>3:subs[:]=[];continue
    subs[:]=[s for s in subs if not s.startswith('.') and s!='node_modules']
    if 'SKILL.md' in files:
      subs[:]=[]
      try:
        with open(os.path.join(base,'SKILL.md'),encoding='utf-8',errors='replace') as f:head=f.read(4096)
      except OSError:continue
      out.append({'path':os.path.join(base,'SKILL.md'),'root':root,'head':head})
    if len(out)>=${MAX}:break
sys.stdout.write(json.dumps(out))
`;
async function remoteSkills(host,dirs){
  const ssh=findExecutable('ssh',environment());if(!ssh)throw new Error('OpenSSH client is not installed.');
  // ~ and the Hermes home are resolved on the remote side; the list is passed as JSON on stdin, never on the command line.
  const child=spawn(ssh,[...sshArgs(host),'-T',target(host),'python3 -c '+quote(REMOTE)],{env:environment(),windowsHide:true,stdio:['pipe','pipe','pipe']});
  const rows=JSON.parse(await collect(child,{timeout:20000,maxBytes:4*1024*1024,input:JSON.stringify(dirs)}));
  return rows.map(r=>clean(r.path.replace(/\\/g,'/'),frontMatter(r.head),r.root)).filter(Boolean);
}
async function listSkills(agent,host){
  const remote=agent.transport==='ssh';
  const dirs=skillDirs(agent,{remote});
  if(!dirs.length)return {skills:[],dirs:[],supported:false};
  const skills=remote?await remoteSkills(host,dirs):await localSkills(dirs);
  skills.sort((a,b)=>a.name.localeCompare(b.name));
  return {skills,dirs,supported:true};
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
module.exports={localSkills,listSkills,skillDirs,frontMatter,skillId,hermesSkillCommand};
