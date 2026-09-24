'use strict';
// Independent Electron main process; no BrowserWindow and no public port.
const fs = require('node:fs/promises');
const path = require('node:path');
const {randomBytes, randomUUID} = require('node:crypto');
const {Store, Vault, atomicJson} = require('./store.cjs');
const {Broker, safeError} = require('./broker.cjs');
const {Terminals} = require('./terminal.cjs');
const {server, endpoint} = require('./wire.cjs');
const {PROVIDERS}=require('./providers.cjs');
const {alive} = require('./host-client.cjs');
const schema = require('./schema.cjs');
const catalog = require('./catalog.cjs');
const files = require('./files.cjs');
const {OpayaAgent} = require('./opaya-agent.cjs');
const skills = require('./skills.cjs');
const projects = require('./projects.cjs');
const vps = require('./vps.cjs');
async function start({app, safeStorage}, root) {
  let broker, terminals, listener, opaya, stopping = false;
  const startedAt = new Date().toISOString(), approvals = new Map();
  const descriptor = path.join(root, 'session-service.json');
  await fs.mkdir(root,{recursive:true,mode:0o700});
  const old = await fs.readFile(descriptor,'utf8').then(JSON.parse).catch(()=>null);
  if (old && old.pid !== process.pid && alive(old.pid)) throw new Error('A session service is already running.');
  if (process.platform !== 'win32') await fs.rm(endpoint(root),{force:true});
  const machine = {hostname:require('node:os').hostname()};
  function snapshot() { return {...broker.snapshot(), machine, opayaAgent:opaya?.describe() || null, providerPresets:PROVIDERS, frameworks:catalog.list(), gitActions:projects.actionList(), platform:process.platform, terminals:terminals?.describe() || [], service:{pid:process.pid, startedAt, persistent:true}}; }
  const emit = () => listener?.broadcast('state', snapshot());
  async function approve(agent, title, detail) {
    const socket = [...(listener?.clients || [])].at(-1);
    if (!socket) return false; // No UI present: never approve unattended operations.
    const id = randomUUID();
    return new Promise(resolve => {
      const timer = setTimeout(() => finish(false), 10 * 60 * 1000);
      function finish(value) { clearTimeout(timer); approvals.delete(id); resolve(value); }
      approvals.set(id,{socket,finish}); listener.notify(socket,'approval',{id,agent:{name:agent.name},title,detail});
    });
  }
  broker = new Broker({store:new Store(root),vault:new Vault(root,safeStorage),emit,approve});
  await broker.init();
  // Opaya browser for agents: the MCP bridge gets a token that can only call browserTool, forwarded to the Opaya window.
  const browserToken = randomBytes(32).toString('hex'), browserCalls = new Map();
  broker.browserBridge = {command:process.execPath, args:[path.join(__dirname,'browser-mcp.cjs')], env:{ELECTRON_RUN_AS_NODE:'1',OPAYA_BROWSER_ENDPOINT:endpoint(root),OPAYA_BROWSER_TOKEN:browserToken}};
  function browserTool(input){
    const socket=[...(listener?.clients||[])].at(-1);
    if(!socket)return Promise.reject(new Error('Open the Opaya window to use its browser.'));
    const id=randomUUID();
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{browserCalls.delete(id);reject(new Error('The browser did not answer in time.'));},110000);
      browserCalls.set(id,{resolve,reject,timer});
      listener.notify(socket,'browser-request',{id,op:String(input.op||''),args:input.args&&typeof input.args==='object'?input.args:{}});
    });
  }
  terminals = new Terminals(event => { listener?.broadcast('terminal',event); if (event.type !== 'data') emit(); },{root});
  await terminals.init();
  // Installs and diagnostics run in visible one-off terminals; the UI is told to show them.
  // Background jobs (clone, redeploy): no IPC timeout, live steps and log sent to every window, kept until dismissed.
  const jobs=new Map();
  function publishJob(job){listener?.broadcast('job',job);}
  function startJob({kind,title,detail,steps,route},work){
    const job={id:randomUUID(),kind,title,detail,route,status:'running',startedAt:Date.now(),steps:steps.map(([key,label])=>({key,label,state:'pending'})),log:[],bytes:0,total:0,result:null,error:''};
    jobs.set(job.id,job);if(jobs.size>20)jobs.delete(jobs.keys().next().value);
    let timer=null;const flush=()=>{timer=null;publishJob(job);};
    const progress=e=>{
      if(e.step){const s=job.steps.find(x=>x.key===e.step);if(s&&e.state)s.state=e.state;}
      if(e.message)job.log.push({at:Date.now(),text:String(e.message).slice(0,600),state:e.state||''});if(job.log.length>300)job.log.splice(0,job.log.length-300);
      if(Number.isFinite(e.bytes))job.bytes=e.bytes;if(Number.isFinite(e.total)&&e.total>0)job.total=e.total;
      if(e.message||e.state)flush();else if(!timer)timer=setTimeout(flush,250);
    };
    publishJob(job);
    Promise.resolve().then(()=>work(progress)).then(result=>{job.status='done';job.result=result;job.finishedAt=Date.now();for(const s of job.steps)if(s.state==='pending')s.state='skipped';job.log.push({at:Date.now(),text:'Done.',state:'done'});},
      error=>{job.status='error';job.error=safeError(error);job.finishedAt=Date.now();for(const s of job.steps)if(s.state==='active')s.state='error';job.log.push({at:Date.now(),text:job.error,state:'error'});})
      .finally(()=>{clearTimeout(timer);publishJob(job);emit();});
    return job;
  }
  async function runInTerminal({label,key,host,command}){
    const pseudo={id:`svc_${key}_${host?host.id:'local'}`.slice(0,80),name:label,provider:'custom',transport:host?'ssh':'local',hostId:host?.id||'',command:'',args:[],cwd:host?'':app.getPath('home'),ephemeral:true,run:host?command:''};
    const reused=terminals.hasLive(pseudo.id,'shell'),view=terminals.open(pseudo,host,'shell',{cols:110,rows:30});
    if(!host||reused)terminals.write(view.id,command+'\r');
    listener?.broadcast('terminal',{type:'opened',id:view.id});emit();return view;
  }
  opaya = new OpayaAgent({root,vault:broker.vault,broker,terminals,approve,emit,runInTerminal,trusted:()=>!!broker.data.settings?.itrustOpaya});
  await opaya.init();
  async function shutdown() {
    if (stopping) return true; stopping = true;
    for (const a of approvals.values()) a.finish(false);
    await terminals.shutdown(); await opaya?.close?.(); await broker.close();
    await fs.rm(descriptor,{force:true});
    setTimeout(()=>app.exit(0),100).unref(); return true;
  }
  const actions = {
    agentModels:x=>broker.models(schema.id(x.id)),selectModel:x=>broker.selectModel(x),gateway:x=>broker.gateway(x),
    snapshot, saveAgent:x=>broker.saveAgent(x), reorderAgents:x=>broker.reorderAgents(x), updateAgentDisplay:x=>broker.updateAgentDisplay(x), saveHost:x=>broker.saveHost(x), removeHost:x=>broker.removeHost(x.id),
    removeAgent:async x=>{const a=broker.agent(x.id); if(!await approve(a,'Remove this agent connection?','Deletes its saved connection and local chat transcripts, not the agent installation.'))return false;terminals.closeAgent(a.id);await broker.removeAgent(a.id);return true;},
    discover:x=>broker.discover(x), connect:x=>broker.connect(x.id), disconnect:x=>broker.disconnect(x.id), clearError:x=>broker.clearError(x.id),
    select:x=>broker.select(x.id), newConversation:x=>broker.newConversation(x.agentId,x.projectId||''), selectConversation:x=>broker.selectConversation(x.id),
    send:x=>broker.send(x), stop:x=>broker.stop(x.id), saveDraft:x=>broker.saveDraft(x), saveView:x=>broker.saveView(x),
    transcript:async x=>{const c=broker.data.conversations.find(c=>c.id===schema.id(x.id));if(!c)throw new Error('Conversation not found.');return {conversation:c,agent:broker.agent(c.agentId),messages:broker.histories.get(c.id)||await broker.store.transcript(c.id)};},
    terminalOpen:async x=>{
      const a=x.local===true?{id:'local-shell',name:'This computer',provider:'custom',transport:'local',command:'',args:[],cwd:app.getPath('home')}:x.agentId?broker.agent(x.agentId):{id:`host_${schema.id(x.hostId)}`,name:broker.host(x.hostId).name,provider:'custom',transport:'ssh',hostId:x.hostId,command:'',args:[],cwd:''};
      if(x.mode==='agent'&&a.provider==='hermes'&&!terminals.hasLive(a.id,x.mode)&&!await approve(a,'Start a new Hermes CLI process?','This does not attach to an existing gateway. Do not run another writer against a Hermes profile already used by a gateway. Use its gateway API or existing tmux session instead.'))throw new Error('CLI launch cancelled.');
      const result=terminals.open(a,a.transport==='ssh'?broker.host(a.hostId):null,x.mode||'shell',{cols:x.cols||100,rows:x.rows||28});emit();return result;
    },
    terminalAttach:x=>terminals.attach(schema.id(x.id)), terminalWrite:x=>terminals.write(schema.id(x.id),x.data),
    terminalResize:x=>terminals.resize(schema.id(x.id),x.cols,x.rows),
    terminalRename:async x=>{const title=await terminals.rename(schema.id(x.id),x.title);emit();return title;},
    terminalDetach:async x=>{terminals.detach(schema.id(x.id));emit();return true;},
    terminalClose:async x=>{const s=terminals.describe().find(s=>s.id===schema.id(x.id));if(!s)return false;const host=s.remote?broker.host(s.agentId.startsWith('host_')?s.agentId.slice(5):broker.agent(s.agentId).hostId):null;await terminals.end(x.id,host);emit();return true;},
    installFramework:async x=>{const host=x.hostId?broker.host(x.hostId):null;const {framework,command}=catalog.command(String(x.id||''),{remote:!!host});return runInTerminal({label:`Install ${framework.name}`,key:`install_${framework.id}`,host,command});},
    files:async x=>{
      let host=null,folder=typeof x.path==='string'?x.path:'',fallback=false;
      if(x.agentId){const a=broker.agent(x.agentId);if(a.transport==='ssh')host=broker.host(a.hostId);if(!folder){folder=a.cwd||a.hermesHome||'';fallback=!!folder;}}
      else if(x.hostId)host=broker.host(x.hostId);
      try{return await files.browse({op:x.op,path:folder,host});}
      // An agent folder inside a container may not exist on the host; fall back to the home folder.
      catch(error){if(fallback&&x.op!=='read')return files.browse({op:x.op,path:'',host});throw error;}
    },
    agentDiagnostics:x=>broker.diagnostics(x.id),
    projectSave:x=>broker.saveProject(x), projectRemove:x=>broker.removeProject(x.id), projectInfo:x=>broker.projectInfo(x.id), projectBranches:x=>broker.projectBranches(x.id),
    // Git and GitHub CLI actions run as fixed commands in the project's own visible terminal.
    projectGit:async x=>{
      const p=broker.project(x.id),host=broker.projectHost(p);
      const command=projects.gitCommand(p,String(x.action||''),x,{windows:process.platform==='win32'});
      return runInTerminal({label:`${p.name} / git`,key:`git_${p.id}`.slice(0,60),host,command});
    },
    projectClone:async x=>{
      const host=x.hostId?broker.host(x.hostId):null;
      const {command,path:folder,name}=projects.cloneCommand(x,{windows:process.platform==='win32'});
      const p=await broker.saveProject({name:x.name||name,path:folder,hostId:host?.id||'',agentIds:x.agentIds||[]});
      await runInTerminal({label:`Clone ${name}`,key:`clone_${p.id}`.slice(0,60),host,command});return p;
    },
    sshKeyCreate:x=>vps.createKey(x.name), hostTest:x=>vps.test(x.hostId?broker.host(x.hostId):schema.host(x.host||{})),
    saveSettings:x=>broker.saveSettings(x), cloneAgent:async x=>{
      const a=broker.agent(x.id),host=x.hostId?broker.host(x.hostId):null;
      return startJob({kind:'clone',route:{from:a.name,fromWhere:a.transport==='ssh'?broker.host(a.hostId).name:'This computer',to:x.name||`${a.name}-clone`,toWhere:host?host.name:'This computer',toHostId:host?.id||'',provider:a.provider},title:`Cloning ${a.name}`,detail:`${a.name} to ${host?host.name:'this computer'} / ${x.runtime==='docker'?'Docker container':'Hermes profile'}`,steps:[['target','Check the target'],['source','Find the source'],['select','Choose files'],['copy','Copy'],...(x.runtime==='docker'?[['start','Start the container']]:[]),['save','Add to Opaya'],['connect','Connect']]},progress=>broker.cloneAgent(x,progress));
    },
    redeployAgent:async x=>{
      const a=broker.agent(x.id);if(!a.clone)throw new Error('This agent is not a clone.');
      const src=broker.data.agents.find(s=>s.id===a.clone.from);
      return startJob({kind:'redeploy',route:{from:src?.name||'source',fromWhere:src?.transport==='ssh'?broker.host(src.hostId).name:'This computer',to:a.name,toWhere:a.transport==='ssh'?broker.host(a.hostId).name:'This computer',provider:a.provider},title:`Redeploying ${a.name}`,detail:`From ${broker.data.agents.find(s=>s.id===a.clone.from)?.name||'source'}`,steps:[['source','Find the source'],['select','Choose files'],['copy','Copy'],...(a.clone.container?[['start','Restart the container']]:[]),['connect','Reconnect']]},progress=>broker.redeployAgent(a.id,progress));
    },
    jobs:async()=>[...jobs.values()], jobDismiss:async x=>jobs.delete(String(x.id||'')),
    browserTool, browserResult:async x=>{const c=browserCalls.get(x.id);if(!c)return false;clearTimeout(c.timer);browserCalls.delete(x.id);x.ok?c.resolve(x.value):c.reject(new Error(String(x.error||'Browser action failed.')));return true;},
    mcpSave:x=>broker.saveMcpServer(x), mcpRemove:x=>broker.removeMcpServer(x.id), agentMcp:x=>broker.setAgentMcp(x), agentSkills:x=>broker.skills(x.id),
    // Hermes skills: browse the hub or install one with the Hermes CLI in a visible terminal.
    skillAction:async x=>{
      const a=broker.agent(x.agentId),host=a.transport==='ssh'?broker.host(a.hostId):null;
      const command=skills.hermesSkillCommand(a,{action:x.action,skill:x.skill,remote:!!host,windows:process.platform==='win32'});
      if(x.action==='install'&&!await approve(a,`Install skill ${x.skill}?`,`Runs in a visible terminal ${host?'on '+host.name:'on this computer'}:\n\n${command}\n\nHermes scans hub skills before installing. Start a new conversation to use it.`))throw new Error('Skill install cancelled.');
      return runInTerminal({label:x.action==='install'?`Skill ${x.skill}`:'Hermes skills',key:`skills_${a.id}`.slice(0,60),host,command});
    },
    playground:x=>broker.playground(x), moveAgent:x=>broker.moveAgent(x), connectAll:x=>broker.connectAll(x),
    opayaSaveConfig:x=>opaya.saveConfig(x), opayaTest:x=>opaya.test(x||{}), opayaForgetKey:()=>opaya.forgetKey(),
    opayaSend:x=>opaya.begin(x.text), opayaNewSession:()=>opaya.newSession(), opayaSelectSession:x=>opaya.selectSession(String(x.id||'')), opayaDeleteSession:x=>opaya.deleteSession(String(x.id||'')), opayaStop:()=>opaya.stop(), opayaClear:()=>opaya.clear(),
    shutdown
  };
  const token = randomBytes(32).toString('hex');
  listener = server({token,snapshot,scopes:()=>new Map([[browserToken,new Set(['browserTool'])]]),
    dispatch:async (method,input)=>{if(!Object.hasOwn(actions,method))throw new Error('Unsupported desktop action.');try{return await actions[method](input||{});}catch(error){throw new Error(safeError(error));}},
    onApproval:(socket,message)=>{const a=approvals.get(message.id);if(a?.socket===socket)a.finish(message.allow===true);},
    onDetach:socket=>{for(const a of approvals.values())if(a.socket===socket)a.finish(false);}
  });
  await new Promise((resolve,reject)=>{listener.once('error',reject);listener.listen(endpoint(root),resolve);});
  if(process.platform!=='win32')await fs.chmod(endpoint(root),0o600);
  await atomicJson(descriptor,{protocol:1,pid:process.pid,token,startedAt});
  app.on('before-quit',event=>{if(!stopping){event.preventDefault();shutdown().catch(()=>app.exit(1));}});
  process.on('SIGTERM',()=>shutdown().catch(()=>app.exit(1)));
  process.on('SIGINT',()=>shutdown().catch(()=>app.exit(1)));
  // Referenced listener keeps the service alive after every UI client detaches.
  return {broker,terminals,listener,shutdown};
}
module.exports = {start};
