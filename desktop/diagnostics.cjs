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
// A retry loop (for example Hermes' Slack reconnect) can fill a log with one traceback repeated thousands of times.
// Collapse consecutive identical entries (a log line plus its indented/traceback continuation) so useful lines stay visible.
function collapse(text){
  const blocks=[];
  for(const line of String(text).split(/\r?\n/)){
    if(blocks.length&&(/^\s|^Traceback|^[A-Za-z_.]+(Error|Exception)\b/.test(line)||!line.trim()))blocks[blocks.length-1]+='\n'+line;else blocks.push(line);
  }
  const out=[];let count=0;
  for(let i=0;i<=blocks.length;i++){
    if(i<blocks.length&&i>0&&blocks[i]===blocks[i-1]){count++;continue;}
    if(count)out.push(`[previous entry repeated ${count} more time${count===1?'':'s'}]`);
    count=0;if(i<blocks.length)out.push(blocks[i]);
  }
  return out.join('\n');
}
const TAIL=64*1024,KEEP=8000;
const tail=text=>{const t=collapse(redact(text));return t.length>KEEP?t.slice(-KEEP):t;};

class ConnectionLog{
  constructor(limit=500){this.limit=limit;this.entries=[];this.lastIn=0;this.lastOut=0;}
  add(direction,text){
    const now=Date.now();if(direction==='in')this.lastIn=now;if(direction==='out')this.lastOut=now;
    // Cut before redacting: a frame can carry megabytes (an attached image), and only the start is kept anyway.
    for(const line of String(text).split(/\r?\n/)){if(!line.trim())continue;this.entries.push({at:now,direction,text:redact(line.slice(0,8000)).slice(0,2000)});}
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
      try{const size=(await handle.stat()).size,length=Math.min(size,TAIL),buffer=Buffer.alloc(length);await handle.read(buffer,0,length,size-length);out.push({path:f.path,modified:new Date(f.mtime).toISOString(),tail:tail(buffer.toString('utf8'))});}
      finally{await handle.close();}
    }
    if(out.length)break;
  }
  return out;
}
async function remoteHermesLogs(agent,host){
  const ssh=findExecutable('ssh',environment());if(!ssh)return [];
  const home=agent.hermesHome?quote(agent.hermesHome):'"${HERMES_HOME:-$HOME/.hermes}"';
  const script=`for f in $(ls -t ${home}/logs/*.log 2>/dev/null | head -3); do printf '\\n=== %s\\n' "$f"; tail -c 65536 "$f"; done`;
  try{
    const text=await collect(spawn(ssh,[...sshArgs(host),'-T',target(host),script],{env:environment(),windowsHide:true,stdio:['pipe','pipe','pipe']}),{timeout:15000,maxBytes:256*1024});
    return text.split(/\n=== /).filter(s=>s.trim()).map(block=>{const nl=block.indexOf('\n');return {path:block.slice(0,nl).replace(/^=== /,'').trim(),tail:tail(block.slice(nl+1))};});
  }catch{return [];}
}
function hermesLogs(agent,host){return agent.transport==='ssh'&&host?remoteHermesLogs(agent,host):localHermesLogs(agent);}
// What kind of problem an agent error is, and where to look, so the Opaya Agent starts from a good guess.
// The order matters: "API authentication failed ... gateway token" is a sign-in problem, not a gateway that is down.
const SETUP={
  hermes:{install:'Install agents > Hermes Agent',onboard:'`hermes setup` (model provider and API key)',setup:'hermes, sign_in; enable_api for the gateway API',token:true,gateway:'`hermes gateway status`; start it with `hermes gateway`',gatewaySetup:'hermes, status, then enable_api and start_gateway'},
  openclaw:{install:'Install agents > OpenClaw',onboard:'`openclaw onboard`',setup:'openclaw, sign_in, then enable_api',token:true,gateway:'`openclaw gateway status`; start it with `openclaw gateway`, and enable gateway.http.endpoints.chatCompletions',gatewaySetup:'openclaw, status, then enable_api and start_gateway'},
  claude:{install:'Install agents > Claude Code',onboard:'a first `claude` run to sign in (Run native CLI)',setup:'claude, sign_in'},
  codex:{install:'Install agents > Codex',onboard:'`codex login` (Run native CLI)',setup:'codex, sign_in'},
  dsh:{install:'Install agents > DeepSeek Harness',onboard:'a DeepSeek API key: its key is wrong or missing, so ask the user for DEEPSEEK_API_KEY (request_secret, or vault op=list and op=give when it is in the Opaya Vault) and store_secret it for this agent (Opaya writes ~/.dsh/.credentials.yaml and ~/.dsh/.env and restarts it); also tell the user the key button in its chat does the same, and that an empty balance on platform.deepseek.com fails too',key:true},
};
const KINDS=[
  ['ssh',/host key|permission denied \(publickey|could not resolve hostname|ssh: |ssh exited|no route to host/i],
  ['not-installed',/ENOENT|command not found|is not recognized as|not installed|no such file or directory|cannot find (?:the )?(?:module|executable|command)/i],
  ['rate-limit',/HTTP 429|rate limit|quota|too many requests/i],
  ['onboarding',/not signed in|sign ?in|log ?in\b|login|onboard|\bsetup\b|not configured|no (?:model|provider)|api[_ ]?key|authenticat|unauthori[sz]ed|HTTP 40[13]|credential|token/i],
  ['gateway',/gateway|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ETIMEDOUT|fetch failed|socket hang up|connection refused|refused to connect|unreachable|not reachable|HTTP 5\d\d|timed? ?out|did not (?:answer|respond|start)|closed|exited/i],
];
function classify(error,agent={}){
  const text=String(error||''),s=SETUP[agent.provider]||SETUP[agent.install?.framework]||(/(^|[\\/])dsh(\.cmd|\.exe)?$/i.test(agent.command||'')||agent.command==='docker'&&(agent.args||[]).includes('dsh')?SETUP.dsh:{});
  const id=(KINDS.find(([,re])=>re.test(text))||['other'])[0];
  const hint={
    ssh:'the SSH connection to its machine fails. Check the machine in Machines (host key, user, key) before the agent itself.',
    'not-installed':`the agent or a program it needs is not installed where it runs${s.install?` (${s.install})`:''}, or its path changed.`,
    'rate-limit':'its model provider is rate limiting or out of quota. Usually temporary; check the account, plan or model it uses.',
    onboarding:`its onboarding or sign-in is not finished, or its token is missing or wrong${s.onboard?`; finish it with ${s.onboard}`:''}${s.setup?`. Run it yourself with setup_agent (${s.setup})`:''}${s.token?`; a missing or wrong gateway token: save_connection with import_gateway_token`:s.key?'':'. Tokens are entered by the user in the connection form'}.`,
    gateway:`its gateway or server is not running, not installed or not reachable${s.gateway?` (${s.gateway})`:''}${s.gatewaySetup?`. Fix it with setup_agent (${s.gatewaySetup})`:''}.`,
    other:'no known pattern. Read its diagnostics and logs to find the cause.',
  }[id];
  return {id,hint};
}
module.exports={ConnectionLog,redact,collapse,hermesLogs,hermesHomes,classify};
