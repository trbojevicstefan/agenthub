'use strict';
const os=require('node:os');
const fs=require('node:fs');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {randomUUID,createHash}=require('node:crypto');
const {atomicJson,readJson}=require('./store.cjs');
const schema=require('./schema.cjs');
const SERVER_ARGS=new Set(['acp','--acp','app-server']);
// The arguments without the protocol-server ones; a server chosen by a flag and its value (dsh --profile acp) goes whole.
function withoutServer(args){const out=[];for(let i=0;i<args.length;i++){if(args[i]==='--profile'&&SERVER_ARGS.has(args[i+1])){i++;continue;}if(!SERVER_ARGS.has(args[i]))out.push(args[i]);}return out;}
const {environment,findExecutable,windowsLaunch,sshArgs,target,remoteCommand,quote,dockerExecContainerIndex,dockerExecArgs,collect}=require('./process.cjs');
const WINDOWS_BUILD=process.platform==='win32'?Number(os.release().split('.')[2])||0:0;
function dimensions(cols,rows){
  if(!Number.isInteger(cols)||!Number.isInteger(rows))throw new Error('Invalid terminal dimensions.');
  return {cols:Math.max(20,Math.min(400,cols)),rows:Math.max(5,Math.min(200,rows))};
}
function tmuxName(agent,mode){return agent.tmuxSession||`agenthub-${createHash('sha256').update(agent.id+':'+mode).digest('hex').slice(0,20)}`;}
function tmuxCommand(name,command,{existing=false}={}){
  if(!/^[a-zA-Z0-9_-]{1,100}$/.test(name))throw new Error('Unsupported tmux session name.');
  const check='export TERM="${TERM:-xterm-256color}"; command -v tmux >/dev/null 2>&1 || { printf "\\nRemote persistence requires tmux. Install it on this host, then reconnect.\\n"; exit 127; }; ';
  // Existing sessions are never replaced or silently restarted.
  return check+(existing?`exec tmux attach-session -t ${quote(name)}`:`exec tmux new-session -A -s ${quote(name)} ${quote(command)}`);
}
// A docker exec that starts in a folder inside the container (the project copy there).
function withWorkdir(args,dir){const index=dockerExecContainerIndex(args);return dir&&index>=0?[...args.slice(0,index),'-w',dir,...args.slice(index)]:args;}
function dockerShellArgs(agent){
  const index=dockerExecContainerIndex(agent.args||[]);
  if(agent.command!=='docker'||index<0)return null;
  const options=agent.args.slice(1,index).filter(x=>!['-i','-t','-it','-ti','--interactive','--tty'].includes(x));
  return ['exec','-it',...options,agent.args[index],'sh','-l'];
}
// The pseudo agents behind "This computer" and a machine's own shell.
const localShell=home=>({id:'local-shell',name:'This computer',provider:'custom',transport:'local',command:'',args:[],cwd:home});
const hostShell=(broker,hostId)=>({id:`host_${schema.id(hostId)}`,name:broker.host(hostId).name,provider:'custom',transport:'ssh',hostId,command:'',args:[],cwd:''});
// The agent (or pseudo agent) a terminal session was opened for (describe() gives the session), so it can start again,
// or take pasted files where it runs. `broker` knows the agents and machines.
function sessionAgent(s,{broker,home}){
  if(s.agentId==='local-shell')return localShell(home);
  if(s.agentId.startsWith('host_')){try{return hostShell(broker,s.agentId.slice(5));}catch{throw new Error('The machine of this terminal was removed from Opaya. Close the tab.');}}
  // An install or diagnostics terminal gets a plain shell on its machine; the finished command does not run again.
  if(s.agentId.startsWith('svc_')){const host=s.remote?broker.data.hosts.find(h=>h.id===s.hostId||s.agentId.endsWith('_'+h.id)):null;if(s.remote&&!host)throw new Error('The machine of this terminal was removed from Opaya.');return {id:s.agentId,name:s.title,provider:'custom',transport:host?'ssh':'local',hostId:host?.id||'',command:'',args:[],cwd:host?'':home,ephemeral:true};}
  try{return broker.agent(s.agentId);}catch{throw new Error('The agent of this terminal was removed from Opaya. Close the tab.');}
}
class Terminals{
  constructor(emit,{ptyFactory,root}={}){this.emit=emit;this.sessions=new Map();this.ptyFactory=ptyFactory;this.root=root;this.queue=Promise.resolve();this.dirty=false;}
  async init(){
    if(!this.root)return;
    const saved=await readJson(path.join(this.root,'terminals.json'),[]);
    if(!Array.isArray(saved))throw new Error('Invalid saved terminal index.');
    for(const item of saved.slice(-24)){
      if(!/^[a-zA-Z0-9_-]{1,80}$/.test(item.id||''))continue;
      this.sessions.set(item.id,{...item,process:null,exited:true,restored:true,buffer:String(item.buffer||'').slice(-200000),seq:Number(item.seq)||0});
    }
  }
  describe(){return [...this.sessions.values()].map(({id,agentId,hostId,mode,cwd,title,exited,remote,restored,tmuxSession,seq})=>({id,agentId,hostId:hostId||'',mode,cwd:cwd||'',title,exited,remote,restored,tmuxSession,seq}));}
  hasLive(agentId,mode){return [...this.sessions.values()].some(s=>s.agentId===agentId&&s.mode===mode&&!s.exited);}
  persist(){
    if(!this.root)return Promise.resolve();
    const data=[...this.sessions.values()].map(({process,...item})=>item);
    const copy=structuredClone(data);
    this.queue=this.queue.catch(()=>{}).then(()=>atomicJson(path.join(this.root,'terminals.json'),copy));
    return this.queue;
  }
  checkpoint(){
    if(this.timer||!this.root)return;
    this.timer=setTimeout(()=>{this.timer=null;this.persist().catch(()=>this.emit({type:'warning',error:'Terminal history could not be saved to disk.'}));},750);
    this.timer.unref();
  }
  // xterm needs the Windows build to match ConPTY's line wrapping; without it resized TUIs draw duplicate lines.
  attach(id){const item=this.sessions.get(id);if(!item)throw new Error('Terminal not found.');const {process,...view}=item;return {...view,windowsBuild:WINDOWS_BUILD};}
  // cwd: a project folder to start in (the agent's CLI or a shell there). One live session per agent, mode and folder.
  // into: an ended session to start again in place (restart).
  open(agent,host,mode='shell',size={cols:100,rows:28},{cwd='',title='',into=null}={}){
    if(!['shell','agent'].includes(mode))throw new Error('Invalid terminal mode.');
    if(typeof cwd!=='string'||cwd.length>2048||/[\0\r\n]/.test(cwd))throw new Error('Invalid terminal folder.');
    const previous=[...this.sessions.values()].find(s=>s!==into&&s.agentId===agent.id&&s.mode===mode&&(s.cwd||'')===cwd&&!s.exited);
    if(previous)return this.attach(previous.id);
    if([...this.sessions.values()].filter(s=>!s.exited).length>=12)throw new Error('Close an existing terminal before opening another.');
    let pty=this.ptyFactory;
    if(!pty){try{pty=require('node-pty');}catch(error){throw new Error('The native terminal could not load. Install the matching Opaya Windows build; do not copy node_modules between operating systems. '+error.message.slice(0,300));}}
    const docker=agent.command==='docker'&&dockerExecContainerIndex(agent.args)>=0,workdir=docker?cwd:'';
    if(cwd&&!docker){if(agent.transport!=='ssh'&&!fs.existsSync(cwd))throw new Error(`The folder ${cwd} does not exist on this computer.`);agent={...agent,cwd};}
    const env=environment({...(agent.hermesHome&&agent.transport!=='ssh'?{HERMES_HOME:agent.hermesHome}:{}),TERM:'xterm-256color'});
    let command,args,dir=agent.cwd||os.homedir(),sessionName='';
    if(agent.transport==='ssh'){
      if(!host)throw new Error('Save an SSH host first.');
      command=findExecutable('ssh',env);if(!command)throw new Error('OpenSSH client is not installed. Enable the Windows OpenSSH Client optional feature.');
      let remote;
      const dockerShell=mode==='shell'?dockerShellArgs(agent):null;
      if(mode==='agent')remote=remoteCommand(agent,withWorkdir(this.cliArgs(agent),workdir));
      else if(dockerShell)remote=remoteCommand(agent,withWorkdir(dockerShell,workdir));
      else remote=(agent.cwd?`cd ${quote(agent.cwd)} || exit 1; `:'')+(agent.hermesHome?`export HERMES_HOME=${quote(agent.hermesHome)}; `:'')+'exec "${SHELL:-/bin/sh}" -l';
      // Service-run commands (installs, diagnostics) go to ssh as the remote command, so SSH prompts cannot swallow them.
      if(agent.ephemeral&&agent.run)remote=`${agent.run}; printf '\n[Finished. This shell stays open.]\n'; exec "\${SHELL:-/bin/sh}" -l`;
      // One-off service terminals (installs, diagnostics) must work on fresh hosts without tmux.
      if(!agent.ephemeral){sessionName=tmuxName(agent,cwd?`${mode}:${cwd}`:mode);remote=tmuxCommand(sessionName,remote,{existing:!!agent.tmuxSession});}
      args=[...sshArgs(host,{interactive:true}),'-tt',target(host),remote];dir=os.homedir();
    }else if(agent.command==='docker'&&dockerExecContainerIndex(agent.args)>=0){
      command=findExecutable('docker',env);if(!command)throw new Error('Docker client is not installed on this computer.');
      args=dockerExecArgs(agent,withWorkdir(mode==='shell'?dockerShellArgs(agent):this.cliArgs(agent),workdir));dir=os.homedir();
    }else if(mode==='agent'){
      if(!agent.command)throw new Error('This API agent has no native CLI command. Use Open shell instead.');
      const executable=findExecutable(agent.command,env);if(!executable)throw new Error('The agent CLI is not installed on this machine.');
      ({command,args}=windowsLaunch(executable,this.cliArgs(agent)));
    }else{
      command=process.platform==='win32'?(findExecutable('pwsh.exe',env)||findExecutable('powershell.exe',env)||'cmd.exe'):(process.env.SHELL||'/bin/bash');
      args=process.platform==='win32'?['-NoLogo']:['-l'];
      if(/cmd\.exe$/i.test(command))args=[];
    }
    const id=into?.id||randomUUID();
    const initial=dimensions(size.cols,size.rows);
    const processPty=pty.spawn(command,args,{name:'xterm-256color',...initial,cwd:dir,env});
    const fields={process:processPty,exited:false,restored:false,detached:false,detaching:false,remote:agent.transport==='ssh',hostId:host?.id||'',tmuxSession:sessionName,...initial};
    const item=into?Object.assign(into,fields):{id,agentId:agent.id,mode,cwd,title:title||`${agent.name} / ${mode}`,buffer:'',seq:0,...fields};this.sessions.set(id,item);
    // A restart keeps the tab and its scrollback; every window learns the session takes input again. The terminal modes the
    // old program left on are reset first (soft reset, main screen, no mouse reporting): otherwise clicks or a paste could
    // type escape codes into the new prompt.
    if(into){const note=`\x1b[!p\x1b[?1047l\x1b[?1000l\x1b[?1006l\r\n\x1b[90m[${sessionName?'Reconnecting':'Started again'}]\x1b[0m\r\n`;item.buffer=(item.buffer+note).slice(-200000);item.seq++;this.emit({id,type:'restarted',seq:item.seq});item.seq++;this.emit({id,type:'data',data:note,seq:item.seq});}
    // Events from a process this session no longer runs (killed on detach, replaced by a restart) are ignored.
    processPty.onData(data=>{if(item.process!==processPty)return;item.buffer=(item.buffer+data).slice(-200000);item.seq++;this.emit({id,type:'data',data,seq:item.seq});this.checkpoint();});
    processPty.onExit(({exitCode})=>{if(item.process!==processPty||item.detaching)return;item.exited=true;item.seq++;this.emit({id,type:'exit',exitCode,seq:item.seq});this.checkpoint();});
    this.checkpoint();return this.attach(id);
  }
  // An ended session (exited, detached, or saved output from before a restart) starts again in its tab: the agent's CLI
  // or a shell in the same folder; a remote one reattaches to the same tmux session, which kept running on the host.
  restart(id,agent,host,size){const s=this.sessions.get(id);if(!s)throw new Error('Terminal not found.');if(!s.exited)return this.attach(id);return this.open(agent,host,s.mode,size,{cwd:s.cwd||'',into:s});}
  cliArgs(agent){ // the interactive CLI: the connection's command without the protocol-server arguments
    if(agent.command==='docker'&&dockerExecContainerIndex(agent.args)>=0){
      const index=dockerExecContainerIndex(agent.args),before=agent.args.slice(1,index).filter(x=>!['-i','-t','-it','-ti','--interactive','--tty'].includes(x));
      const tail=withoutServer(agent.args.slice(index));
      if(agent.provider==='openclaw'&&!tail.includes('tui'))tail.push('tui');
      return ['exec','-it',...before,'-e','TERM=xterm-256color',...tail];
    }
    if(agent.provider==='openclaw')return ['tui'];
    // Chat connections start the agent as a protocol server (acp, --acp, app-server); its CLI is the same program without them.
    if(['hermes','claude','codex'].includes(agent.provider)||agent.protocol==='acp')return withoutServer(agent.args);
    return agent.args;
  }
  write(id,data){
    if(typeof data!=='string'||data.length>65536)throw new Error('Terminal input exceeds the safety limit.');
    const s=this.sessions.get(id);if(!s||s.exited)throw new Error('This terminal session has ended. Press Enter in it to start it again.');s.process.write(data);
  }
  // The size is kept with the session, so its screen can be rendered as the program drew it (screen.cjs).
  resize(id,cols,rows){const size=dimensions(cols,rows);const s=this.sessions.get(id);if(s&&!s.exited){s.process.resize(size.cols,size.rows);Object.assign(s,size);}}
  async rename(id,title){
    const s=this.sessions.get(id);if(!s)throw new Error('Terminal not found.');
    if(typeof title!=='string'||!title.trim()||title.trim().length>80||/[\x00-\x1f\x7f]/.test(title))throw new Error('Use a terminal name between 1 and 80 characters.');
    s.title=title.trim();await this.persist();this.emit({id,type:'renamed',title:s.title});return s.title;
  }
  detach(id){const s=this.sessions.get(id);if(!s)return false;if(!s.remote)throw new Error('Only remote terminals can detach. Hide keeps a local terminal available; End session stops it.');if(!s.exited){s.detaching=true;try{s.process?.kill();}catch{}s.process=null;s.exited=true;s.detached=true;s.seq++;this.emit({id,type:'exit',exitCode:'detached',seq:s.seq});}this.checkpoint();return true;}
  close(id){const s=this.sessions.get(id);if(s){try{s.process?.kill();}catch{}this.sessions.delete(id);this.checkpoint();}}
  async end(id,host){
    const s=this.sessions.get(id);if(!s)return false;
    if(s.remote&&s.tmuxSession){
      if(!host)throw new Error('SSH host for this terminal is missing.');
      if(!/^[a-zA-Z0-9_-]{1,100}$/.test(s.tmuxSession))throw new Error('Invalid tmux session name.');
      const env=environment(),ssh=findExecutable('ssh',env);
      const name=quote('='+s.tmuxSession);
      await collect(spawn(ssh,[...sshArgs(host),'-T',target(host),`if tmux has-session -t ${name} 2>/dev/null; then tmux kill-session -t ${name}; fi`],{env,windowsHide:true,stdio:['pipe','pipe','pipe']}));
    }
    this.close(id);return true;
  }
  closeAgent(agentId){for(const [id,s]of this.sessions)if(s.agentId===agentId)this.close(id);}
  closeAll(){for(const id of this.sessions.keys())this.close(id);}
  async shutdown(){
    clearTimeout(this.timer);this.timer=null;
    // Persist records BEFORE ending the service, so restarts can show old output.
    await this.persist();
    for(const s of this.sessions.values()){try{s.process?.kill();}catch{}}
    await this.queue;
  }
}
module.exports={Terminals,dimensions,tmuxName,tmuxCommand,dockerShellArgs,withWorkdir,localShell,hostShell,sessionAgent};
