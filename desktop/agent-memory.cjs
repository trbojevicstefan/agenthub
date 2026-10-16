'use strict';
// Memory and personality of every agent, in the files the agent itself reads: Hermes' SOUL.md and memories/,
// OpenClaw's workspace (SOUL.md, IDENTITY.md, USER.md, MEMORY.md, AGENTS.md, TOOLS.md, memory/), and the instruction
// file of Claude Code (CLAUDE.md), Codex, OpenCode and DeepSeek Harness (AGENTS.md) and Goose (.goosehints). Agents with
// no personality file of their own keep it in a marked section of their instruction file, which they read every session.
// Files are read and written where the agent runs (this computer, an SSH machine, a container); a save keeps the
// previous version next to it as <file>.opaya-bak.
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {quote}=require('./process.cjs');
const MAX=512*1024;

const TEMPLATES={
  personality:'# Who you are\n\nYou are a calm, direct assistant. Keep answers short and concrete.\n\n## Tone\n- Friendly, never flattering.\n- Say what you did and what is left.\n\n## Boundaries\n- Ask before anything destructive or public.\n',
  identity:'# Identity\n\n- Name: \n- Role: \n- Emoji: \n',
  user:'# About me\n\n- Name: \n- Language: \n- Time zone: \n- What I work on: \n- How I like answers: \n',
  memory:'# Memory\n\nFacts worth remembering between sessions.\n\n- \n',
  instructions:'# Instructions\n\nHow to work in my projects.\n\n- \n',
  tools:'# Tools\n\nNotes about tools and machines this agent uses.\n\n- \n'
};
// One entry: a file below the agent's root folder, or a marked section ("block") of another entry's file.
const f=(id,kind,file,label,hint)=>({id,kind,file,label,hint});
const b=(id,kind,of,label,hint)=>({id,kind,block:id,of,label,hint});
const BLOCKS={
  personality:(file,name)=>b('personality','personality','instructions','Personality',`${name} has no separate personality file, so Opaya keeps it in a marked section of ${file}, which ${name} reads every session.`),
  user:(file)=>b('user','user','instructions','About you',`Who you are and how you like to work. Kept in a marked section of ${file}.`)
};
const FRAMEWORKS={
  hermes:{name:'Hermes',root:'hermes',entries:[
    f('personality','personality','SOUL.md','Personality (SOUL.md)','Hermes\' soul: who it is and how it talks. Loaded into every conversation.'),
    f('memory','memory','memories/MEMORY.md','Memory','What Hermes remembers between sessions. Entries are separated by a line with §. Hermes keeps this short (about 2,200 characters).'),
    f('user','user','memories/USER.md','About you (USER.md)','What Hermes knows about you. Hermes keeps this short (about 1,400 characters).')]},
  openclaw:{name:'OpenClaw',root:'openclaw',notes:'memory',entries:[
    f('personality','personality','SOUL.md','Personality (SOUL.md)','OpenClaw\'s soul: persona, tone and boundaries. Read at the start of every session.'),
    f('identity','identity','IDENTITY.md','Identity','Its name, role and emoji.'),
    f('user','user','USER.md','About you (USER.md)','Who you are and how to address you.'),
    f('memory','memory','MEMORY.md','Long-term memory','Curated facts and decisions it keeps between sessions.'),
    f('instructions','instructions','AGENTS.md','Instructions (AGENTS.md)','How it should work: rules, priorities, what to do on its own.'),
    f('tools','tools','TOOLS.md','Tools (TOOLS.md)','Notes about its tools, machines and conventions.')]},
  claude:{name:'Claude Code',root:'claude',entries:[
    f('instructions','memory','CLAUDE.md','Memory (CLAUDE.md)','Claude Code\'s user memory: instructions and facts it reads in every project.')],blocks:['personality','user']},
  codex:{name:'Codex',root:'codex',notes:'memories',entries:[
    f('instructions','memory','AGENTS.md','Memory (AGENTS.md)','Codex\'s global instructions: read in every session, in every project.')],blocks:['personality','user']},
  opencode:{name:'OpenCode',root:'opencode',entries:[
    f('instructions','memory','AGENTS.md','Memory (AGENTS.md)','OpenCode\'s global rules: read in every session.')],blocks:['personality','user']},
  dsh:{name:'DeepSeek Harness',root:'dsh',entries:[
    f('instructions','memory','AGENTS.md','Memory (AGENTS.md)','DeepSeek Harness\'s global instructions.')],blocks:['personality','user']},
  goose:{name:'Goose',root:'goose',notes:'memory',entries:[
    f('instructions','memory','.goosehints','Memory (.goosehints)','Goose\'s global hints: read in every session.')],blocks:['personality','user']}
};
function spec(framework){
  const s=FRAMEWORKS[framework];if(!s)return null;
  return {...s,entries:[...s.entries,...(s.blocks||[]).map(k=>BLOCKS[k](s.entries[0].file,s.name))]};
}
const supported=framework=>!!FRAMEWORKS[framework];

// The agent's root folder, as a shell expression (where it runs) and, on this computer, as a path.
function profileArg(agent){const a=agent.args||[],i=a.indexOf('--profile');return i>=0&&/^[\w.-]+$/.test(a[i+1]||'')?a[i+1]:'';}
function rootShell(framework,agent,where){
  if(framework==='hermes')return agent.hermesHome?quote(agent.hermesHome):where?.container?'/opt/data':'"${HERMES_HOME:-$HOME/.hermes}"';
  if(framework==='openclaw'){const p=profileArg(agent);return p?`"$HOME/.openclaw-${p}/workspace"`:'"${OPENCLAW_WORKSPACE:-$HOME/.openclaw/workspace}"';}
  return {claude:'"${CLAUDE_CONFIG_DIR:-$HOME/.claude}"',codex:'"${CODEX_HOME:-$HOME/.codex}"',opencode:'"$HOME/.config/opencode"',dsh:'"$HOME/.dsh"',goose:'"$HOME/.config/goose"'}[framework];
}
async function rootLocal(framework,agent,{home=os.homedir(),env=process.env,platform=process.platform}={}){
  if(framework==='hermes'){
    if(agent.hermesHome)return agent.hermesHome;
    const homes=[env.HERMES_HOME,platform==='win32'&&env.LOCALAPPDATA?path.join(env.LOCALAPPDATA,'hermes'):'',path.join(home,'.hermes')].filter(Boolean);
    for(const h of homes)if(await fs.access(path.join(h,'config.yaml')).then(()=>true,()=>false))return h;
    return homes[0];
  }
  if(framework==='openclaw'){const p=profileArg(agent);return p?path.join(home,`.openclaw-${p}`,'workspace'):env.OPENCLAW_WORKSPACE||path.join(home,'.openclaw','workspace');}
  if(framework==='claude')return env.CLAUDE_CONFIG_DIR||path.join(home,'.claude');
  if(framework==='codex')return env.CODEX_HOME||path.join(home,'.codex');
  return path.join(home,...{opencode:['.config','opencode'],dsh:['.dsh'],goose:['.config','goose']}[framework]);
}

// A marked section of an instruction file.
const mark=id=>[`<!-- opaya:${id} -->`,`<!-- /opaya:${id} -->`];
const BLOCK_TITLES={personality:'## Personality',user:'## About me'};
function readBlock(text,id){
  const [open,close]=mark(id),s=text.indexOf(open),e=text.indexOf(close);
  if(s<0||e<s)return null;
  return text.slice(s+open.length,e).replace(/^\n/,'').replace(/\n$/,'').replace(new RegExp(`^${BLOCK_TITLES[id]}\\n+`),'');
}
function writeBlock(text,id,body){
  const [open,close]=mark(id),s=text.indexOf(open),e=text.indexOf(close),value=String(body).trim();
  const section=value?`${open}\n${BLOCK_TITLES[id]}\n\n${value}\n${close}`:'';
  if(s>=0&&e>s){const rest=text.slice(0,s)+section+text.slice(e+close.length);return section?rest:rest.replace(/\n{3,}/g,'\n\n');}
  if(!section)return text;
  return text.trim()?`${text.replace(/\s+$/,'')}\n\n${section}\n`:`${section}\n`;
}
// The file without Opaya's sections (shown in its own editor), and the sections to keep when it is saved.
function stripBlocks(text,ids){let out=text;for(const id of ids)out=writeBlock(out,id,'');return out.replace(/\s+$/,'')+(out.trim()?'\n':'');}
function keepBlocks(text,current,ids){let out=text;for(const id of ids){const v=readBlock(current,id);if(v!=null)out=writeBlock(out,id,v);}return out;}
const safeNote=name=>typeof name==='string'&&/^[\w][\w .-]{0,120}\.(md|txt)$/i.test(name)&&!name.includes('..');

// Reading and writing files below the root, here or through a shell where the agent runs.
function localIo(root){
  const file=rel=>path.join(root,...rel.split('/'));
  return {
    root,
    async read(rels){const out={};for(const rel of rels){const st=await fs.stat(file(rel)).catch(()=>null);out[rel]=st?.isFile()?{size:st.size,content:st.size>MAX?null:await fs.readFile(file(rel),'utf8')}:null;}return out;},
    async list(dir){const names=await fs.readdir(file(dir)).catch(()=>[]);const rows=[];for(const n of names){if(!safeNote(n))continue;const st=await fs.stat(path.join(file(dir),n)).catch(()=>null);if(st?.isFile())rows.push({name:n,size:st.size,modified:st.mtimeMs});}return rows.sort((x,y)=>y.modified-x.modified).slice(0,80);},
    async write(rel,content){const p=file(rel);await fs.mkdir(path.dirname(p),{recursive:true});const old=await fs.readFile(p).catch(()=>null);if(old)await fs.writeFile(`${p}.opaya-bak`,old);const tmp=`${p}.opaya-tmp`;await fs.writeFile(tmp,content,'utf8');await fs.rename(tmp,p);}
  };
}
function shellIo(rootExpr,run){
  const R=`R=${rootExpr}`;
  return {
    root:'',
    async read(rels){
      const out=await run(`${R}; printf '@@root %s\\n' "$R"; for f in ${rels.map(quote).join(' ')}; do if [ -f "$R/$f" ]; then s=$(wc -c < "$R/$f" | tr -d ' '); printf '@@file %s %s\\n' "$s" "$f"; if [ "$s" -le ${MAX} ]; then base64 < "$R/$f" | tr -d '\\n'; fi; echo; else printf '@@missing %s\\n' "$f"; fi; done`);
      const files={},lines=String(out).split('\n');
      for(let i=0;i<lines.length;i++){
        const m=/^@@file (\d+) (.+)$/.exec(lines[i]);if(m){const size=Number(m[1]);files[m[2]]={size,content:size>MAX?null:Buffer.from(lines[i+1]||'','base64').toString('utf8')};i++;continue;}
        const r=/^@@root (.*)$/.exec(lines[i]);if(r)this.root=r[1];
        const n=/^@@missing (.+)$/.exec(lines[i]);if(n)files[n[1]]=null;
      }
      return files;
    },
    async list(dir){
      const out=await run(`${R}; D="$R"/${quote(dir)}; [ -d "$D" ] && ls -1t "$D" 2>/dev/null | head -80 | while IFS= read -r n; do [ -f "$D/$n" ] && printf '%s\\t%s\\n' "$(wc -c < "$D/$n" | tr -d ' ')" "$n"; done; true`);
      return String(out).split('\n').map(l=>/^(\d+)\t(.+)$/.exec(l)).filter(Boolean).filter(m=>safeNote(m[2])).map(m=>({name:m[2],size:Number(m[1])}));
    },
    async write(rel,content){await run(`${R}; f="$R"/${quote(rel)}; mkdir -p "$(dirname "$f")" && { [ ! -f "$f" ] || cp "$f" "$f.opaya-bak"; } && cat > "$f.opaya-tmp" && mv "$f.opaya-tmp" "$f"`,content);}
  };
}
// io for an agent: local (fs) when it runs on this computer, otherwise a shell; run(script,input) runs a POSIX script there.
async function ioFor(framework,agent,{local,where,run,home,env,platform}={}){
  return local?localIo(await rootLocal(framework,agent,{home,env,platform})):shellIo(rootShell(framework,agent,where),run);
}

async function read(framework,io){
  const s=spec(framework);if(!s)throw new Error('Opaya does not know where this agent keeps its memory.');
  const rels=[...new Set(s.entries.filter(e=>e.file).map(e=>e.file))],files=await io.read(rels);
  const entries=s.entries.map(e=>{
    const file=e.file||s.entries.find(x=>x.id===e.of).file,got=files[file];
    const content=got?got.content:null,tooBig=!!got&&got.content===null;
    const hosted=s.entries.filter(x=>x.of===e.id).map(x=>x.block);
    const value=content==null?null:e.block?readBlock(content,e.block):hosted.length?stripBlocks(content,hosted):content;
    return {id:e.id,kind:e.kind,label:e.label,hint:e.hint,file,block:!!e.block,exists:value!=null,tooBig,size:got?.size||0,content:value??'',template:TEMPLATES[e.kind]||''};
  });
  const notes=s.notes?await io.list(s.notes):[];
  return {framework,name:s.name,root:io.root,entries,notesDir:s.notes||'',notes};
}
async function write(framework,io,id,content){
  const s=spec(framework),e=s?.entries.find(x=>x.id===id);if(!e)throw new Error('Unknown memory file.');
  const text=String(content??'');if(Buffer.byteLength(text)>MAX)throw new Error('That is more than 512 KB.');
  const hosted=s.entries.filter(x=>x.of===e.id).map(x=>x.block);
  if(!e.block&&!hosted.length){await io.write(e.file,text);return {file:e.file};}
  if(!e.block){const current=(await io.read([e.file]))[e.file];if(current&&current.content===null)throw new Error(`${e.file} is larger than 512 KB.`);await io.write(e.file,keepBlocks(text,current?.content||'',hosted));return {file:e.file};}
  const host=s.entries.find(x=>x.id===e.of),current=(await io.read([host.file]))[host.file];
  if(current&&current.content===null)throw new Error(`${host.file} is larger than 512 KB.`);
  await io.write(host.file,writeBlock(current?.content||'',e.block,text));return {file:host.file};
}
async function readNote(framework,io,name){
  const s=spec(framework);if(!s?.notes||!safeNote(name))throw new Error('Unknown note.');
  const rel=`${s.notes}/${name}`,got=(await io.read([rel]))[rel];if(!got)throw new Error('That note is gone.');if(got.content===null)throw new Error('The note is larger than 512 KB.');
  return {name,content:got.content};
}
async function writeNote(framework,io,name,content){
  const s=spec(framework);if(!s?.notes||!safeNote(name))throw new Error('Use a name like 2026-10-16.md.');
  const text=String(content??'');if(Buffer.byteLength(text)>MAX)throw new Error('That is more than 512 KB.');
  await io.write(`${s.notes}/${name}`,text);return {name};
}
// The entry of another agent that holds the same kind (personality, about you), for copying between agents.
function entryOfKind(framework,kind){return spec(framework)?.entries.find(e=>e.kind===kind)||null;}
module.exports={FRAMEWORKS,TEMPLATES,spec,supported,rootShell,rootLocal,readBlock,writeBlock,stripBlocks,keepBlocks,safeNote,localIo,shellIo,ioFor,read,write,readNote,writeNote,entryOfKind};
