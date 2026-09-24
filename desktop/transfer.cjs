'use strict';
// Move skills and API keys between agents, and keep a global skills library in Opaya's home folder.
// Skills are folders with a SKILL.md, the same format for Hermes, Claude Code, Codex and OpenClaw, so they can move
// between different agents. Files travel as tar streams (this computer, SSH machines, containers). API key values
// stay in the session service: the UI only ever sees key names.
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {place,run,shell,sourceHome,transfer,isLocal}=require('./clone.cjs');
const {listSkills,localSkills,skillDirs}=require('./skills.cjs');
const {quote,collect}=require('./process.cjs');
const ENV_KEY=/^[A-Za-z_][A-Za-z0-9_]*$/;
// Where an agent keeps skills, resolved to a real absolute path on its machine.
async function skillsHome(agent,host){
  const where=place({agent,host});
  if(agent.provider==='hermes')return {where,dir:joinFor(where,await sourceHome(agent,where),'skills')};
  const dir=skillDirs(agent,{remote:!isLocal(where)})[0];if(!dir)throw new Error(`Opaya does not know where ${agent.name} keeps skills.`);
  if(isLocal(where)||!dir.startsWith('~'))return {where,dir};
  const home=(await run(where,'printf %s "$HOME"')).trim();return {where,dir:home+dir.slice(1)};
}
const joinFor=(where,...parts)=>isLocal(where)?path.join(...parts):path.posix.join(...parts);
const parentOf=(where,p)=>isLocal(where)?path.dirname(p):path.posix.dirname(p.replace(/\\/g,'/'));
const baseOf=(where,p)=>isLocal(where)?path.basename(p):path.posix.basename(p.replace(/\\/g,'/'));
async function ensureDir(where,dir){if(isLocal(where))await fs.mkdir(dir,{recursive:true});else await run(where,`mkdir -p ${quote(dir)}`);}
// Skill folders of `agent`, optionally only the named ones.
async function pickSkills(agent,host,names){
  const r=await listSkills(agent,host);
  const list=names==='all'||!names?r.skills:r.skills.filter(s=>names.includes(s.name));
  if(!list.length)throw new Error('No matching skills to copy.');
  return list;
}
// Copy skill folders from one place to a skills folder elsewhere, grouped by parent so each group is one stream.
async function copySkillFolders({skills,from,to,dest,progress=()=>{}}){
  await ensureDir(to,dest);
  const groups=new Map();for(const s of skills){const dir=parentOf(from,s.path),parent=parentOf(from,dir);if(!groups.has(parent))groups.set(parent,[]);groups.get(parent).push(baseOf(from,dir));}
  let copied=0;
  for(const [parent,names] of groups){
    progress({step:'copy',message:`Copying ${names.join(', ')}`});
    await transfer(from,parent,[...new Set(names)],to,dest,{onBytes:b=>progress({step:'copy',bytes:b})});
    copied+=names.length;
  }
  return copied;
}
async function transferSkills({source,sourceHost,target,targetHost,names='all',progress=()=>{}}){
  progress({step:'source',state:'active',message:`Reading ${source.name}'s skills`});
  const skills=await pickSkills(source,sourceHost,names);
  progress({step:'source',state:'done',message:`${skills.length} skill${skills.length===1?'':'s'}: ${skills.map(s=>s.name).join(', ')}`});
  progress({step:'target',state:'active',message:`Finding ${target.name}'s skills folder`});
  const t=await skillsHome(target,targetHost);
  progress({step:'target',state:'done',message:`Target: ${t.dir}`});
  progress({step:'copy',state:'active',message:'Copying skills'});
  await copySkillFolders({skills,from:place({agent:source,host:sourceHost}),to:t.where,dest:t.dir,progress});
  progress({step:'copy',state:'done',message:`Copied ${skills.length} skill${skills.length===1?'':'s'} to ${target.name}`});
  return {skills:skills.map(s=>s.name)};
}
// ---- API keys (.env) between Hermes agents --------------------------------------------------------------------
function parseEnv(text){const out=new Map();for(const line of String(text).split(/\r?\n/)){const m=/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);if(m)out.set(m[1],m[2]);}return out;}
async function readEnv(agent,host){
  const where=place({agent,host}),home=await sourceHome(agent,where),file=joinFor(where,home,'.env');
  const text=isLocal(where)?await fs.readFile(file,'utf8').catch(()=>''):await run(where,`cat ${quote(file)} 2>/dev/null || true`);
  return {where,file,text};
}
async function envKeys(agent,host){if(agent.provider!=='hermes')return [];return [...parseEnv((await readEnv(agent,host)).text).keys()];}
// Merge the chosen keys into the target's .env: existing lines are updated in place, missing keys are appended.
async function transferEnv({source,sourceHost,target,targetHost,keys='all',progress=()=>{}}){
  if(source.provider!=='hermes'||target.provider!=='hermes')throw new Error('API keys can be copied between Hermes agents.');
  progress({step:'keys',state:'active',message:`Reading API keys from ${source.name}`});
  const from=parseEnv((await readEnv(source,sourceHost)).text);
  const wanted=keys==='all'?[...from.keys()]:keys.filter(k=>ENV_KEY.test(k)&&from.has(k));
  if(!wanted.length)throw new Error('No matching API keys to copy.');
  const to=await readEnv(target,targetHost),lines=to.text?to.text.replace(/\r\n/g,'\n').replace(/\n$/,'').split('\n'):[],seen=new Set();
  const merged=lines.map(line=>{const m=/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);if(m&&wanted.includes(m[1])){seen.add(m[1]);return `${m[1]}=${from.get(m[1])}`;}return line;});
  for(const k of wanted)if(!seen.has(k))merged.push(`${k}=${from.get(k)}`);
  const content=merged.join('\n')+'\n';
  if(isLocal(to.where)){await fs.writeFile(to.file,content,{mode:0o600});await fs.chmod(to.file,0o600).catch(()=>{});}
  else{const child=shell(to.where,`umask 077; cat > ${quote(to.file)} && chmod 600 ${quote(to.file)}`);await collect(child,{timeout:30000,input:content});}
  progress({step:'keys',state:'done',message:`Copied ${wanted.length} key${wanted.length===1?'':'s'}: ${wanted.join(', ')}`});
  return {keys:wanted};
}
// ---- Global skills library ------------------------------------------------------------------------------------
class SkillLibrary{
  constructor(root){this.dir=path.join(root,'skills-library');}
  async list(){await fs.mkdir(this.dir,{recursive:true});return (await localSkills([this.dir])).sort((a,b)=>a.name.localeCompare(b.name)).map(s=>({...s,folder:path.relative(this.dir,path.dirname(s.path))}));}
  async importFrom({agent,host,names,progress=()=>{}}){
    progress({step:'source',state:'active',message:`Reading ${agent.name}'s skills`});
    const skills=await pickSkills(agent,host,names);
    progress({step:'source',state:'done',message:`${skills.length} skill${skills.length===1?'':'s'}: ${skills.map(s=>s.name).join(', ')}`});
    progress({step:'copy',state:'active',message:'Copying into the library'});
    await copySkillFolders({skills,from:place({agent,host}),to:{host:null,container:''},dest:this.dir,progress});
    progress({step:'copy',state:'done',message:`Added ${skills.length} to the library`});
    return {skills:skills.map(s=>s.name)};
  }
  async addFolder(folder){
    const src=path.resolve(String(folder||''));
    const skills=await localSkills([src]);if(!skills.length)throw new Error('That folder has no SKILL.md.');
    await copySkillFolders({skills,from:{host:null,container:''},to:{host:null,container:''},dest:this.dir});
    return {skills:skills.map(s=>s.name)};
  }
  async installTo({agents,names,progress=()=>{}}){
    const all=await this.list(),skills=names==='all'?all:all.filter(s=>names.includes(s.name));if(!skills.length)throw new Error('Choose skills to install.');
    const done=[];
    for(const {agent,host} of agents){
      progress({step:'copy',state:'active',message:`Installing ${skills.length} skill${skills.length===1?'':'s'} to ${agent.name}`});
      const t=await skillsHome(agent,host);
      await copySkillFolders({skills,from:{host:null,container:''},to:t.where,dest:t.dir,progress});
      done.push(agent.name);progress({message:`${agent.name}: done (${t.dir})`});
    }
    progress({step:'copy',state:'done',message:`Installed to ${done.join(', ')}`});
    return {skills:skills.map(s=>s.name),agents:done};
  }
  async remove(name){
    const s=(await this.list()).find(x=>x.name===name);if(!s)throw new Error('Skill not found in the library.');
    const dir=path.dirname(s.path);if(!dir.startsWith(this.dir+path.sep))throw new Error('Refusing to remove outside the library.');
    await fs.rm(dir,{recursive:true,force:true});return true;
  }
}
module.exports={transferSkills,transferEnv,envKeys,parseEnv,skillsHome,SkillLibrary};
