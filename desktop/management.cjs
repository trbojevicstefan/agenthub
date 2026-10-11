'use strict';
const path=require('node:path');
const {launch,collect,dockerExecContainerIndex,dockerExecArgs,quote}=require('./process.cjs');
function gatewayArgs(agent,operation){
  if(!['status','restart'].includes(operation))throw new Error('Unsupported gateway operation.');
  if(!['hermes','openclaw'].includes(agent.provider)||!agent.command)throw new Error('This connection has no managed gateway.');
  if(agent.command==='docker'){
    const index=dockerExecContainerIndex(agent.args);
    if(index<0)throw new Error('Docker container is not configured.');
    const executable=agent.args.slice(index+1).filter(arg=>!['acp','app-server'].includes(arg));
    if(!executable.length)throw new Error('Configure the gateway executable inside this container.');
    if(operation==='restart'&&agent.provider==='hermes'){
      const profile=path.posix.basename(path.posix.dirname(agent.hermesHome||''))==='profiles'?path.posix.basename(agent.hermesHome):'default';
      if(!/^[a-zA-Z0-9_.-]+$/.test(profile))throw new Error('Unsupported gateway profile name.');
      return [...agent.args.slice(0,index+1),'sh','-c','service=$1; shift; if [ -x /command/s6-svc ] && [ -d "$service" ]; then /command/s6-svc -t "$service" && printf "Gateway restart requested via s6.\\n"; else exec "$@" gateway restart; fi','agenthub-gateway',`/run/service/gateway-${profile}`,...executable];
    }
    return [...agent.args.slice(0,index+1),...executable,'gateway',operation];
  }
  return [...(agent.args||[]).filter(arg=>!['acp','app-server'].includes(arg)),'gateway',operation];
}
async function gatewayOperation(agent,host,operation){
  const output=await collect(launch(agent,gatewayArgs(agent,operation),host),{timeout:operation==='restart'?120000:20000,maxBytes:65536});
  return output.trim();
}
// ---- The agent's own CLI: repairs and messaging channels (Hermes and OpenClaw) -------------------------------------
const NOT_CLI=['acp','app-server'];
const managed=agent=>{
  if(!['hermes','openclaw'].includes(agent.provider))throw new Error('Repairs and channels are for Hermes and OpenClaw.');
  if(!agent.command)throw new Error('This connection has no CLI Opaya can run. Set its command in Connection settings.');
};
// The executable and its fixed arguments, without the chat mode (acp), for running other commands of the same CLI.
function cliArgs(agent,args){
  managed(agent);
  if(agent.command==='docker'){
    const index=dockerExecContainerIndex(agent.args);if(index<0)throw new Error('Docker container is not configured.');
    const executable=agent.args.slice(index+1).filter(arg=>!NOT_CLI.includes(arg));
    return [...agent.args.slice(0,index+1),...(executable.length?executable:[agent.provider]),...args];
  }
  return [...(agent.args||[]).filter(arg=>!NOT_CLI.includes(arg)),...args];
}
// The same as a command line for a visible terminal (interactive: docker exec -it). `windows`: PowerShell on this computer.
function cliCommand(agent,args,{remote=false,windows=false}={}){
  const ps=windows&&!remote,psq=v=>`'${String(v).replace(/'/g,"''")}'`,qq=ps?psq:quote,word=v=>/^[\w.\/:=@+-]+$/.test(v)?v:qq(v);
  if(agent.command==='docker'){
    managed(agent);
    const all=dockerExecArgs(agent,agent.args||[]),index=dockerExecContainerIndex(all);if(index<0)throw new Error('Docker container is not configured.');
    const flags=all.slice(1,index).filter(f=>!['-i','-t','-it','-ti','--interactive','--tty'].includes(f));
    const executable=all.slice(index+1).filter(arg=>!NOT_CLI.includes(arg));
    return ['docker','exec','-it',...flags,all[index],...(executable.length?executable:[agent.provider]),...args].map(word).join(' ');
  }
  managed(agent);
  const bin=agent.command,line=[...(agent.args||[]).filter(arg=>!NOT_CLI.includes(arg)),...args].map(word).join(' ');
  const home=agent.provider==='hermes'&&agent.hermesHome?agent.hermesHome:'';
  if(ps)return `${home?`$env:HERMES_HOME=${psq(home)}; `:''}& ${psq(bin)} ${line}`;
  return `${home?`HERMES_HOME=${quote(home)} `:''}${word(bin)} ${line}`;
}
// Repairs with the agent's own tools: OpenClaw shows its last update, finishes or rolls back an interrupted one
// (update repair) and fixes its settings (doctor --fix); Hermes runs doctor --fix.
const REPAIR={
  openclaw:{steps:[['update','status'],['update','repair','--yes'],['doctor','--fix']],title:'Repair OpenClaw',
    summary:'Shows the last update, finishes or rolls back an update that did not complete (openclaw update repair) and fixes settings and data (openclaw doctor --fix).'},
  hermes:{steps:[['doctor','--fix']],title:'Repair Hermes',summary:'Checks the setup, settings and dependencies and fixes what it can (hermes doctor --fix).'}};
function repairCommand(agent,opts={}){
  managed(agent);const r=REPAIR[agent.provider];
  return {title:r.title,summary:r.summary,command:r.steps.map(args=>cliCommand(agent,args,opts)).join('; ')};
}
// Adding a messaging channel (Telegram, Discord, Slack, WhatsApp...) is interactive: the agent's own setup asks for
// tokens and pairings in a terminal.
const CHANNEL_SETUP={openclaw:['channels','add'],hermes:['gateway','setup']};
function channelSetupCommand(agent,opts={}){managed(agent);return cliCommand(agent,CHANNEL_SETUP[agent.provider],opts);}
const plain=text=>String(text||'').replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g,'').replace(/\r/g,'');
const label=v=>String(v||'').slice(0,60);
// `openclaw channels list --json`: channels with their accounts and installed/configured/enabled tags.
function parseOpenclawChannels(text){
  // The JSON may follow log lines, some of them starting with [ ("[plugins] ...").
  const s=plain(text);let data;
  for(const m of s.matchAll(/^[ \t]*[{[]/gm)){try{data=JSON.parse(s.slice(m.index));break;}catch{}}
  if(data===undefined)return null;
  const list=Array.isArray(data)?data:Array.isArray(data?.channels)?data.channels:data?.channels&&typeof data.channels==='object'?Object.entries(data.channels).map(([id,v])=>({id,...v})):[];
  const out=[];
  for(const c of list.slice(0,100)){
    if(!c||typeof c!=='object')continue;
    const id=label(c.id||c.channel||c.name),name=label(c.label||c.name||id);if(!id&&!name)continue;
    const accounts=Array.isArray(c.accounts)?c.accounts:c.accounts&&typeof c.accounts==='object'?Object.entries(c.accounts).map(([accountId,v])=>({accountId,...(v&&typeof v==='object'?v:{})})):[];
    const on=x=>x.configured!==false&&x.enabled!==false&&(x.configured===true||x.enabled===true||x.running===true);
    if(!accounts.length)out.push({id,name,connected:on(c),detail:c.configured===false?'not configured':c.enabled===false?'disabled':on(c)?'configured':''});
    for(const a of accounts.slice(0,20)){const acc=label(a.accountId||a.id||a.name||'default');out.push({id,name:acc&&acc!=='default'?`${name} (${acc})`:name,connected:on(a),detail:a.enabled===false?'disabled':a.configured===false?'not configured':on(a)?'configured':''});}
  }
  return out;
}
// `hermes status --full`, section "Messaging Platforms": rows "  Telegram      ✓ configured (home: ...)".
function parseHermesChannels(text){
  const lines=plain(text).split('\n'),start=lines.findIndex(l=>/^\s*◆\s*Messaging Platforms/.test(l));if(start<0)return null;
  const out=[];
  for(const line of lines.slice(start+1)){
    if(/^\s*◆/.test(line))break;
    const m=/^\s{2}(\S.*?)\s+([✓✗])\s+(.*)$/.exec(line);if(!m)continue;
    out.push({id:label(m[1].toLowerCase()),name:label(m[1]),connected:m[2]==='✓',detail:label(m[3])});
  }
  return out;
}
// Older Hermes has no `status --full` (argparse: "unrecognized arguments"); its plain status shows every section.
const CHANNEL_LIST={openclaw:[['channels','list','--json']],hermes:[['status','--full'],['status']]};
// The agent's messaging channels, read with its CLI where it runs. Read-only.
async function channels(agent,host,{run=(args)=>collect(launch(agent,args,host),{timeout:60000,maxBytes:1024*1024})}={}){
  const parse=agent.provider==='openclaw'?parseOpenclawChannels:parseHermesChannels;let failure='';
  for(const tail of CHANNEL_LIST[agent.provider]||[]){
    let out;
    try{out=await run(cliArgs(agent,tail));}
    catch(error){if(!error?.stdout){failure=String(error.message||error);continue;}out=error.stdout;}
    const list=parse(out);if(list)return {channels:list,setup:CHANNEL_SETUP[agent.provider].join(' ')};
  }
  if(failure&&!/unrecognized arguments|invalid choice|^usage:/im.test(failure))throw new Error(`Could not read its channels: ${failure.slice(0,300)}`);
  throw new Error(agent.provider==='openclaw'?'This OpenClaw did not list its channels (openclaw channels list --json). Update it, or open its CLI.':'This Hermes did not report its messaging platforms (hermes status). Update it, or open its CLI.');
}
module.exports={gatewayArgs,gatewayOperation,cliArgs,cliCommand,repairCommand,channelSetupCommand,parseOpenclawChannels,parseHermesChannels,channels};
