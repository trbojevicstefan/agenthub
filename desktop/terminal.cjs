'use strict';
const os=require('node:os');
const path=require('node:path');
const {randomUUID,createHash}=require('node:crypto');
const {atomicJson,readJson}=require('./store.cjs');
const {environment,findExecutable,windowsLaunch,sshArgs,target,remoteCommand,quote}=require('./process.cjs');
function dimensions(cols,rows){
  if(!Number.isInteger(cols)||!Number.isInteger(rows))throw new Error('Invalid terminal dimensions.');
  return {cols:Math.max(20,Math.min(400,cols)),rows:Math.max(5,Math.min(200,rows))};
}
function tmuxName(agent,mode){return agent.tmuxSession||`agenthub-${createHash('sha256').update(agent.id+':'+mode).digest('hex').slice(0,20)}`;}
function tmuxCommand(name,command,{existing=false}={}){
  if(!/^[a-zA-Z0-9_-]{1,100}$/.test(name))throw new Error('Unsupported tmux session name.');
  const check='command -v tmux >/dev/null 2>&1 || { printf "\\nRemote persistence requires tmux. Install it on this host, then reconnect.\\n"; exit 127; }; ';
  // Existing sessions are never replaced or silently restarted.
  return check+(existing?`exec tmux attach-session -t ${quote(name)}`:`exec tmux new-session -A -s ${quote(name)} ${quote(command)}`);
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
  attach(id){const item=this.sessions.get(id);if(!item)throw new Error('Terminal not found.');const {process,...view}=item;return view;}
  open(agent,host,mode='shell',size={cols:100,rows:28}){
    if(!['shell','agent'].includes(mode))throw new Error('Invalid terminal mode.');
    const previous=[...this.sessions.values()].find(s=>s.agentId===agent.id&&s.mode===mode&&!s.exited);
    if(previous)return this.attach(previous.id);
    if([...this.sessions.values()].filter(s=>!s.exited).length>=12)throw new Error('Close an existing terminal before opening another.');
    let pty=this.ptyFactory;
    if(!pty){try{pty=require('node-pty');}catch(error){throw new Error('The native terminal could not load. Install the matching AgentHub Windows build; do not copy node_modules between operating systems. '+error.message.slice(0,300));}}
    const env=environment(agent.hermesHome&&agent.transport!=='ssh'?{HERMES_HOME:agent.hermesHome}:{});
    let command,args,cwd=agent.cwd||os.homedir(),sessionName='';
    if(agent.transport==='ssh'){
      if(!host)throw new Error('Save an SSH host first.');
      command=findExecutable('ssh',env);if(!command)throw new Error('OpenSSH client is not installed. Enable the Windows OpenSSH Client optional feature.');
      let remote;
      if(mode==='agent')remote=remoteCommand(agent,this.cliArgs(agent));
      else remote=(agent.cwd?`cd ${quote(agent.cwd)} || exit 1; `:'')+(agent.hermesHome?`export HERMES_HOME=${quote(agent.hermesHome)}; `:'')+'exec "${SHELL:-/bin/sh}" -l';
      sessionName=tmuxName(agent,mode);
      remote=tmuxCommand(sessionName,remote,{existing:!!agent.tmuxSession});
      args=[...sshArgs(host,{interactive:true}),'-tt',target(host),remote];cwd=os.homedir();
    }else if(mode==='agent'){
      if(!agent.command)throw new Error('This API agent has no native CLI command. Use Open shell instead.');
      const executable=findExecutable(agent.command,env);if(!executable)throw new Error('The agent CLI is not installed on this machine.');
      ({command,args}=windowsLaunch(executable,this.cliArgs(agent)));
    }else{
      command=process.platform==='win32'?(findExecutable('pwsh.exe',env)||findExecutable('powershell.exe',env)||'cmd.exe'):(process.env.SHELL||'/bin/bash');
      args=process.platform==='win32'?['-NoLogo']:['-l'];
      if(/cmd\.exe$/i.test(command))args=[];
    }
    const archived=[...this.sessions.values()].find(s=>s.agentId===agent.id&&s.mode===mode&&s.restored);
    const id=archived?.id||randomUUID();
    const processPty=pty.spawn(command,args,{name:'xterm-256color',...dimensions(size.cols,size.rows),cwd,env});
    const buffer=archived?.buffer?archived.buffer+'\r\n\x1b[90m[Saved output above. Reconnecting below.]\x1b[0m\r\n':'';
    const item={id,agentId:agent.id,mode,title:`${agent.name} / ${mode}`,process:processPty,buffer,seq:archived?.seq||0,exited:false,restored:false,remote:agent.transport==='ssh',tmuxSession:sessionName};this.sessions.set(id,item);
    processPty.onData(data=>{item.buffer=(item.buffer+data).slice(-200000);item.seq++;this.emit({id,type:'data',data,seq:item.seq});this.checkpoint();});
    processPty.onExit(({exitCode})=>{item.exited=true;item.seq++;this.emit({id,type:'exit',exitCode,seq:item.seq});this.checkpoint();});
    this.checkpoint();return this.attach(id);
  }
  cliArgs(agent){
    if(agent.provider==='openclaw')return ['tui'];
    if(['hermes','claude','codex'].includes(agent.provider))return agent.args.filter(x=>x!=='acp'&&x!=='app-server');
    return agent.args;
  }
  write(id,data){
    if(typeof data!=='string'||data.length>65536)throw new Error('Terminal input exceeds the safety limit.');
    const s=this.sessions.get(id);if(!s||s.exited)throw new Error('Terminal is closed. Open shell to reconnect; saved output is still available.');s.process.write(data);
  }
  resize(id,cols,rows){const size=dimensions(cols,rows);const s=this.sessions.get(id);if(s&&!s.exited)s.process.resize(size.cols,size.rows);}
  close(id){const s=this.sessions.get(id);if(s){try{s.process?.kill();}catch{}this.sessions.delete(id);this.checkpoint();}}
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
module.exports={Terminals,dimensions,tmuxName,tmuxCommand};
