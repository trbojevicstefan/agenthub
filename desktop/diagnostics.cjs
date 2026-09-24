'use strict';
// Connection diagnostics: what Opaya and an agent actually exchanged, the agent's stderr, and the tail of Hermes' own
// log files. Everything is redacted and bounded, so it is safe to show in the UI and to give to the Opaya Agent.
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {findExecutable,environment,sshArgs,target,quote,collect}=require('./process.cjs');
const SECRET=/((?:authorization|api[_-]?key|token|secret|password)["']?\s*[:=]\s*["']?(?:bearer\s+)?)[^\s"',}]+|\b(sk-[a-z0-9-]{8,}|gh[pousr]_[a-z0-9]{20,}|xox[a-z]-[a-z0-9-]{10,})/gi;
const redact=text=>String(text??'').replace(SECRET,(m,prefix)=>prefix?`${prefix}[redacted]`:'[redacted]');

class ConnectionLog{
  constructor(limit=500){this.limit=limit;this.entries=[];this.lastIn=0;this.lastOut=0;}
  add(direction,text){
    const now=Date.now();if(direction==='in')this.lastIn=now;if(direction==='out')this.lastOut=now;
    for(const line of String(text).split(/\r?\n/)){if(!line.trim())continue;this.entries.push({at:now,direction,text:redact(line).slice(0,2000)});}
    if(this.entries.length>this.limit)this.entries.splice(0,this.entries.length-this.limit);
  }
  toJSON(){return {entries:this.entries.slice(),lastIn:this.lastIn,lastOut:this.lastOut};}
}

// Hermes keeps its logs in <HERMES_HOME>/logs. On Windows the installer uses %LOCALAPPDATA%\hermes.
function hermesHomes(agent){
  const homes=[agent.hermesHome,process.env.HERMES_HOME,process.platform==='win32'&&process.env.LOCALAPPDATA?path.join(process.env.LOCALAPPDATA,'hermes'):'',path.join(os.homedir(),'.hermes')];
  return [...new Set(homes.filter(Boolean))];
}
async function localHermesLogs(agent){
  const out=[];
  for(const home of hermesHomes(agent)){
    const dir=path.join(home,'logs');let names;try{names=await fs.readdir(dir);}catch{continue;}
    const files=(await Promise.all(names.filter(n=>/\.(log|txt)$/i.test(n)).map(async n=>{const p=path.join(dir,n);try{return {path:p,mtime:(await fs.stat(p)).mtimeMs};}catch{return null;}}))).filter(Boolean).sort((a,b)=>b.mtime-a.mtime).slice(0,3);
    for(const f of files){
      const handle=await fs.open(f.path,'r');
      try{const size=(await handle.stat()).size,length=Math.min(size,8000),buffer=Buffer.alloc(length);await handle.read(buffer,0,length,size-length);out.push({path:f.path,modified:new Date(f.mtime).toISOString(),tail:redact(buffer.toString('utf8'))});}
      finally{await handle.close();}
    }
    if(out.length)break;
  }
  return out;
}
async function remoteHermesLogs(agent,host){
  const ssh=findExecutable('ssh',environment());if(!ssh)return [];
  const home=agent.hermesHome?quote(agent.hermesHome):'"${HERMES_HOME:-$HOME/.hermes}"';
  const script=`for f in $(ls -t ${home}/logs/*.log 2>/dev/null | head -3); do printf '\\n=== %s\\n' "$f"; tail -c 8000 "$f"; done`;
  try{
    const text=await collect(spawn(ssh,[...sshArgs(host),'-T',target(host),script],{env:environment(),windowsHide:true,stdio:['pipe','pipe','pipe']}),{timeout:15000,maxBytes:64*1024});
    return text.split(/\n=== /).filter(s=>s.trim()).map(block=>{const nl=block.indexOf('\n');return {path:block.slice(0,nl).replace(/^=== /,'').trim(),tail:redact(block.slice(nl+1))};});
  }catch{return [];}
}
function hermesLogs(agent,host){return agent.transport==='ssh'&&host?remoteHermesLogs(agent,host):localHermesLogs(agent);}
module.exports={ConnectionLog,redact,hermesLogs,hermesHomes};
