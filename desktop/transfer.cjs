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
  // Bundled skills (OpenClaw's) have no folder: they come with the agent and are not copied.
  const list=(names==='all'||!names?r.skills:r.skills.filter(s=>names.includes(s.name))).filter(s=>s.path);
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
// ---- API keys between any agents --------------------------------------------------------------------------------
// Each agent reads keys somewhere else: Hermes and OpenClaw a .env, Claude Code env in settings.json, Codex its login
// (codex login --with-api-key, kept in auth.json), OpenCode auth.json per provider, an API connection the token Opaya
// keeps in its vault. Keys are read where the source keeps them and written where the target reads them, by provider
// (OPENAI_API_KEY is OpenCode's "openai" and signs Codex in; other keys go into Codex's .env). Values stay in the session service: the UI
// and the Opaya Agent get names and places only, and values go into files on stdin, never on a command line.
const secrets=require('./secrets.cjs');
function parseEnv(text){const out=new Map();for(const line of String(text).split(/\r?\n/)){const m=/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);if(m)out.set(m[1],m[2]);}return out;}
// OpenCode's provider ids and the variable each provider's key has elsewhere.
const PROVIDER_KEYS={openai:'OPENAI_API_KEY',anthropic:'ANTHROPIC_API_KEY',openrouter:'OPENROUTER_API_KEY',google:'GEMINI_API_KEY',deepseek:'DEEPSEEK_API_KEY',groq:'GROQ_API_KEY',mistral:'MISTRAL_API_KEY',xai:'XAI_API_KEY',togetherai:'TOGETHER_API_KEY',fireworks:'FIREWORKS_API_KEY',cerebras:'CEREBRAS_API_KEY',perplexity:'PERPLEXITY_API_KEY',moonshotai:'MOONSHOT_API_KEY',zai:'ZAI_API_KEY'};
// Other names of the same key: Gemini is also read as GOOGLE_API_KEY.
const ALIASES={GOOGLE_API_KEY:'GEMINI_API_KEY',GOOGLE_GENERATIVE_AI_API_KEY:'GEMINI_API_KEY'};
const canon=name=>ALIASES[name]||name;
// The key an API endpoint takes, from its host.
const HOSTS=[[/(^|\.)openai\.com$/,'OPENAI_API_KEY'],[/(^|\.)anthropic\.com$/,'ANTHROPIC_API_KEY'],[/(^|\.)openrouter\.ai$/,'OPENROUTER_API_KEY'],[/(^|\.)googleapis\.com$/,'GEMINI_API_KEY'],[/(^|\.)deepseek\.com$/,'DEEPSEEK_API_KEY'],[/(^|\.)groq\.com$/,'GROQ_API_KEY'],[/(^|\.)mistral\.ai$/,'MISTRAL_API_KEY'],[/(^|\.)x\.ai$/,'XAI_API_KEY'],[/(^|\.)together\.(ai|xyz)$/,'TOGETHER_API_KEY'],[/(^|\.)fireworks\.ai$/,'FIREWORKS_API_KEY'],[/(^|\.)cerebras\.ai$/,'CEREBRAS_API_KEY'],[/(^|\.)perplexity\.ai$/,'PERPLEXITY_API_KEY'],[/(^|\.)moonshot\.(ai|cn)$/,'MOONSHOT_API_KEY']];
function endpointKey(endpoint){let h='';try{h=new URL(endpoint).hostname;}catch{return '';}return HOSTS.find(([re])=>re.test(h))?.[1]||'';}
const LOOPBACK=/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i;
// Where an agent keeps keys: hermes, openclaw, claude, codex, opencode, token (an API connection), or '' (unknown).
function keyKind(agent){
  if(agent.protocol==='openai'&&!['hermes','openclaw'].includes(agent.provider))return 'token';
  const f=require('./maintenance.cjs').frameworkOf(agent);
  return ['hermes','openclaw','claude','codex','opencode','dsh'].includes(f)?f:'';
}
const KIND_LABEL={hermes:'.env',openclaw:'.env',dsh:'.env',claude:'settings.json env',codex:'Codex login or .env',opencode:'auth.json',token:'Opaya vault'};
// .env values: quotes removed, a trailing comment after an unquoted value dropped.
function envValueOf(raw){const v=String(raw).trim();const m=/^(['"])(.*)\1$/.exec(v);return m?m[2]:v.replace(/\s+#.*$/,'');}
const keyName=n=>ENV_KEY.test(n)&&secrets.secretName(n);
// The file an agent's keys are in, where it runs (this computer, a machine, or its container).
async function keyFile(kind,agent,host){
  const where=place({agent,host}),local=isLocal(where),home=os.homedir(),env=process.env;
  if(agent.transport==='http'&&!LOOPBACK.test(agent.endpoint||''))throw new Error(`Opaya reaches ${agent.name} only over HTTP (${agent.endpoint}), so it cannot read or write its files. Add its machine and connect it over SSH.`);
  const at=async(expr,localDir,...rest)=>local?path.join(localDir,...rest):path.posix.join(await secrets.dirAt(where,expr),...rest);
  if(kind==='hermes')return {where,file:joinFor(where,await sourceHome(agent,where),'.env')};
  if(kind==='openclaw')return {where,file:await at('${OPENCLAW_STATE_DIR:-$HOME/.openclaw}',env.OPENCLAW_STATE_DIR||path.join(home,'.openclaw'),'.env')};
  if(kind==='claude')return {where,file:await at('${CLAUDE_CONFIG_DIR:-$HOME/.claude}',env.CLAUDE_CONFIG_DIR||path.join(home,'.claude'),'settings.json')};
  if(kind==='codex')return {where,file:await at('${CODEX_HOME:-$HOME/.codex}',env.CODEX_HOME||path.join(home,'.codex'),'auth.json')};
  if(kind==='dsh')return {where,file:await at('${DSH_HOME:-$HOME/.dsh}',env.DSH_HOME||path.join(home,'.dsh'),'.env')};
  if(kind==='codex-env')return {where,file:await at('${CODEX_HOME:-$HOME/.codex}',env.CODEX_HOME||path.join(home,'.codex'),'.env')};
  if(kind==='opencode')return {where,file:await at('${XDG_DATA_HOME:-$HOME/.local/share}',env.XDG_DATA_HOME||path.join(home,'.local','share'),'opencode','auth.json')};
  throw new Error(`Opaya does not know where ${agent.name} keeps API keys.`);
}
const json=(text,file)=>{const raw=String(text||'').replace(/^﻿/,'').trim();if(!raw)return {};let d;try{d=JSON.parse(raw);}catch{throw new Error(`${file} is not valid JSON, so Opaya does not change it.`);}if(!d||typeof d!=='object'||Array.isArray(d))throw new Error(`${file} does not hold a JSON object.`);return d;};
// Name -> value of the keys `agent` has. `vault` reads an API connection's token.
async function readKeys(agent,host,{vault}={}){
  const kind=keyKind(agent),out=new Map();
  if(kind==='token'){const v=vault?.get(agent.id);if(v)out.set(endpointKey(agent.endpoint)||'API_KEY',v);return {kind,values:out};}
  if(!kind)return {kind,values:out};
  const {where,file}=await keyFile(kind,agent,host),text=await secrets.readAt(where,file);
  if(kind==='hermes'||kind==='openclaw'||kind==='dsh'){for(const [k,raw] of parseEnv(text)){const v=envValueOf(raw);if(keyName(k)&&v)out.set(k,v);}}
  else if(kind==='claude'){const env=json(text,file).env;if(env&&typeof env==='object')for(const [k,v] of Object.entries(env))if(keyName(k)&&typeof v==='string'&&v)out.set(k,v);}
  else if(kind==='codex'){
    const v=json(text,file).OPENAI_API_KEY;if(typeof v==='string'&&v)out.set('OPENAI_API_KEY',v);
    // Other keys Codex has are in CODEX_HOME/.env (Opaya puts them in the environment of the Codex it starts).
    const env=await keyFile('codex-env',agent,host);for(const [k,raw] of parseEnv(await secrets.readAt(env.where,env.file))){const x=envValueOf(raw);if(keyName(k)&&x&&!/^CODEX_/.test(k)&&!out.has(k))out.set(k,x);}
  }
  else for(const [id,e] of Object.entries(json(text,file)))if(e?.type==='api'&&typeof e.key==='string'&&e.key&&/^[\w.-]{1,60}$/.test(id))out.set(PROVIDER_KEYS[id]||`${id.toUpperCase().replace(/[^A-Z0-9]+/g,'_')}_API_KEY`,e.key);
  return {kind,file,values:out};
}
// Key names only, with where they come from; for the UI.
async function envKeys(agent,host,opts){const r=await readKeys(agent,host,opts);return [...r.values.keys()].map(name=>({name,from:KIND_LABEL[r.kind]||''}));}
// Where each key goes on the target, or why it cannot (pure: names in, places out).
function planKeys(kind,names,{endpoint=''}={}){
  const want=endpointKey(endpoint);
  return names.map(name=>{
    const c=canon(name);
    if(kind==='hermes'||kind==='openclaw'||kind==='dsh')return /^DSH_/.test(name)&&kind==='dsh'?{name,why:'DeepSeek Harness never reads DSH_* names from a .env'}:{name,to:`.env as ${name}`};
    if(kind==='claude')return {name,to:`settings.json env ${name}`};
    if(kind==='codex')return c==='OPENAI_API_KEY'?{name,to:'codex login --with-api-key'}:/^CODEX_/.test(name)?{name,why:'Codex never reads CODEX_* names from its .env'}:{name,to:`Codex's .env as ${name}`};
    if(kind==='opencode'){const id=Object.keys(PROVIDER_KEYS).find(p=>PROVIDER_KEYS[p]===c);return id?{name,to:`auth.json provider ${id}`,provider:id}:{name,why:'OpenCode has no provider for this key'};}
    if(kind==='token'){if(want?c===want:names.length===1)return {name,to:'its connection token (Opaya vault)'};return {name,why:want?`This connection takes ${want}`:'An API connection has one token: choose one key'};}
    return {name,why:'Opaya does not know where this agent reads API keys'};
  });
}
// Copy the chosen keys (names, or 'all') from `source` to where `target` reads them. Returns names and places only.
async function transferKeys({source,sourceHost,target,targetHost,keys='all',vault=null,launch=require('./process.cjs').launch,progress=()=>{}}){
  const kind=keyKind(target);if(!kind)throw new Error(`Opaya does not know where ${target.name} reads API keys. Use its own sign-in.`);
  progress({step:'keys',state:'active',message:`Reading API keys from ${source.name}`});
  const from=(await readKeys(source,sourceHost,{vault})).values;
  const wanted=keys==='all'?[...from.keys()]:[...new Set(keys)].filter(k=>ENV_KEY.test(k)&&from.has(k));
  if(!wanted.length)throw new Error('No matching API keys to copy.');
  const plan=planKeys(kind,wanted,{endpoint:target.endpoint}),go=plan.filter(p=>p.to),skipped=plan.filter(p=>!p.to);
  if(!go.length)throw new Error(`${target.name} cannot use ${wanted.join(', ')}: ${skipped[0].why}.`);
  let into=KIND_LABEL[kind];
  if(kind==='token'){if(!vault)throw new Error('Opaya\'s vault is not available.');await vault.set(target.id,from.get(go[0].name),true);}
  else if(kind==='codex'){
    // An OpenAI key signs Codex in on its input, as with the Opaya Agent's store_secret; other keys go into its .env.
    const login=go.find(p=>p.to.startsWith('codex login')),rest=go.filter(p=>p!==login);
    if(login){const agent={...target,args:(target.args||[]).filter(x=>x!=='app-server')};await collect(launch(agent,[...agent.args,'login','--with-api-key'],targetHost),{timeout:60000,input:from.get(login.name)+'\n'});}
    if(rest.length){const {where,file}=await keyFile('codex-env',target,targetHost);let text=await secrets.readAt(where,file);for(const p of rest)text=secrets.setEnv(text,p.name,from.get(p.name));await secrets.writeAt(where,file,text);into=login?`Codex login and ${file}`:file;}
  }else{
    const {where,file}=await keyFile(kind,target,targetHost);into=file;
    let text=await secrets.readAt(where,file);
    for(const p of go){const v=from.get(p.name);
      if(kind==='claude')text=secrets.setJsonEnv(text,p.name,v);
      else if(kind==='opencode'){const d=json(text,file);d[p.provider]={type:'api',key:v};text=JSON.stringify(d,null,2)+'\n';}
      else text=secrets.setEnv(text,p.name,v);}
    await secrets.writeAt(where,file,text);
  }
  progress({step:'keys',state:'done',message:`Copied ${go.length} key${go.length===1?'':'s'} to ${target.name} (${into}): ${go.map(p=>p.name).join(', ')}${skipped.length?`. Not copied: ${skipped.map(p=>`${p.name} (${p.why})`).join(', ')}`:''}. Reconnect ${target.name} so it loads them.`});
  return {keys:go.map(p=>p.name),skipped:skipped.map(({name,why})=>({name,why})),into};
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
module.exports={transferSkills,transferKeys,transferEnv:transferKeys,envKeys,readKeys,planKeys,keyKind,endpointKey,parseEnv,envValueOf,skillsHome,SkillLibrary};
