'use strict';
const os=require('node:os');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {randomUUID,createHash}=require('node:crypto');
const {atomicJson,readJson}=require('./store.cjs');
const SERVER_ARGS=new Set(['acp','--acp','--experimental-acp','app-server']);
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
function dockerShellArgs(agent){
  const index=dockerExecContainerIndex(agent.args||[]);
  if(agent.command!=='docker'||index<0)return null;
  const options=agent.args.slice(1,index).filter(x=>!['-i','-t','-it','-ti','--interactive','--tty'].includes(x));
  return ['exec','-it',...options,agent.args[index],'sh','-l'];
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
  describe(){return [...this.sessions.values()].map(({id,agentId,mode,title,exited,remote,restored,tmuxSession,seq})=>({id,agentId,mode,title,exited,remote,restored,tmuxSession,seq}));}
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
  open(agent,host,mode='shell',size={cols:100,rows:28}){
    if(!['shell','agent'].includes(mode))throw new Error('Invalid terminal mode.');
    const previous=[...this.sessions.values()].find(s=>s.agentId===agent.id&&s.mode===mode&&!s.exited);
    if(previous)return this.attach(previous.id);
    if([...this.sessions.values()].filter(s=>!s.exited).length>=12)throw new Error('Close an existing terminal before opening another.');
    let pty=this.ptyFactory;
    if(!pty){try{pty=require('node-pty');}catch(error){throw new Error('The native terminal could not load. Install the matching Opaya Windows build; do not copy node_modules between operating systems. '+error.message.slice(0,300));}}
    const env=environment({...(agent.hermesHome&&agent.transport!=='ssh'?{HERMES_HOME:agent.hermesHome}:{}),TERM:'xterm-256color'});
    let command,args,cwd=agent.cwd||os.homedir(),sessionName='';
    if(agent.transport==='ssh'){
      if(!host)throw new Error('Save an SSH host first.');
      command=findExecutable('ssh',env);if(!command)throw new Error('OpenSSH client is not installed. Enable the Windows OpenSSH Client optional feature.');
      let remote;
      const dockerShell=mode==='shell'?dockerShellArgs(agent):null;
      if(mode==='agent')remote=remoteCommand(agent,this.cliArgs(agent));
      else if(dockerShell)remote=remoteCommand(agent,dockerShell);
      else remote=(agent.cwd?`cd ${quote(agent.cwd)} || exit 1; `:'')+(agent.hermesHome?`export HERMES_HOME=${quote(agent.hermesHome)}; `:'')+'exec "${SHELL:-/bin/sh}" -l';
      // Service-run commands (installs, diagnostics) go to ssh as the remote command, so SSH prompts cannot swallow them.
      if(agent.ephemeral&&agent.run)remote=`${agent.run}; printf '\n[Finished. This shell stays open.]\n'; exec "\${SHELL:-/bin/sh}" -l`;
      // One-off service terminals (installs, diagnostics) must work on fresh hosts without tmux.
      if(!agent.ephemeral){sessionName=tmuxName(agent,mode);remote=tmuxCommand(sessionName,remote,{existing:!!agent.tmuxSession});}
      args=[...sshArgs(host,{interactive:true}),'-tt',target(host),remote];cwd=os.homedir();
    }else if(agent.command==='docker'&&dockerExecContainerIndex(agent.args)>=0){
      command=findExecutable('docker',env);if(!command)throw new Error('Docker client is not installed on this computer.');
      args=dockerExecArgs(agent,mode==='shell'?dockerShellArgs(agent):this.cliArgs(agent));cwd=os.homedir();
    }else if(mode==='agent'){
      if(!agent.command)throw new Error('This API agent has no native CLI command. Use Open shell instead.');
      const executable=findExecutable(agent.command,env);if(!executable)throw new Error('The agent CLI is not installed on this machine.');
      ({command,args}=windowsLaunch(executable,this.cliArgs(agent)));
    }else{
      command=process.platform==='win32'?(findExecutable('pwsh.exe',env)||findExecutable('powershell.exe',env)||'cmd.exe'):(process.env.SHELL||'/bin/bash');
      args=process.platform==='win32'?['-NoLogo']:['-l'];
      if(/cmd\.exe$/i.test(command))args=[];
    }
    const archived=null;
    const id=randomUUID();
    const processPty=pty.spawn(command,args,{name:'xterm-256color',...dimensions(size.cols,size.rows),cwd,env});
    const buffer=archived?.buffer?archived.buffer+'\r\n\x1b[90m[Saved output above. Reconnecting below.]\x1b[0m\r\n':'';
    const item={id,agentId:agent.id,mode,title:`${agent.name} / ${mode}`,process:processPty,buffer,seq:archived?.seq||0,exited:false,restored:false,remote:agent.transport==='ssh',tmuxSession:sessionName};this.sessions.set(id,item);
    processPty.onData(data=>{item.buffer=(item.buffer+data).slice(-200000);item.seq++;this.emit({id,type:'data',data,seq:item.seq});this.checkpoint();});
    processPty.onExit(({exitCode})=>{if(item.detaching)return;item.exited=true;item.seq++;this.emit({id,type:'exit',exitCode,seq:item.seq});this.checkpoint();});
    this.checkpoint();return this.attach(id);
  }
  cliArgs(agent){ // the interactive CLI: the connection's command without the protocol-server arguments
    if(agent.command==='docker'&&dockerExecContainerIndex(agent.args)>=0){
      const index=dockerExecContainerIndex(agent.args),before=agent.args.slice(1,index).filter(x=>!['-i','-t','-it','-ti','--interactive','--tty'].includes(x));
      const tail=agent.args.slice(index).filter(x=>!SERVER_ARGS.has(x));
      if(agent.provider==='openclaw'&&!tail.includes('tui'))tail.push('tui');
      return ['exec','-it',...before,'-e','TERM=xterm-256color',...tail];
    }
    if(agent.provider==='openclaw')return ['tui'];
    // Chat connections start the agent as a protocol server (acp, --acp, app-server); its CLI is the same program without them.
    if(['hermes','claude','codex'].includes(agent.provider)||agent.protocol==='acp')return agent.args.filter(x=>!SERVER_ARGS.has(x));
    return agent.args;
  }
  write(id,data){
    if(typeof data!=='string'||data.length>65536)throw new Error('Terminal input exceeds the safety limit.');
    const s=this.sessions.get(id);if(!s||s.exited)throw new Error('This is saved terminal output from a closed session. Open a new shell to reconnect.');s.process.write(data);
  }
  resize(id,cols,rows){const size=dimensions(cols,rows);const s=this.sessions.get(id);if(s&&!s.exited)s.process.resize(size.cols,size.rows);}
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
module.exports={Terminals,dimensions,tmuxName,tmuxCommand,dockerShellArgs};
