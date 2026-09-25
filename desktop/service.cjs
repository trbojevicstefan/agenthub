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
const moves = require('./transfer.cjs');
const {condense} = require('./condense.cjs');
const free = require('./free-model.cjs');
const maintenance = require('./maintenance.cjs');
async function start({app, safeStorage}, root) {
  let broker, terminals, listener, opaya, stopping = false;
  const startedAt = new Date().toISOString(), approvals = new Map();
  const descriptor = path.join(root, 'session-service.json');
  await fs.mkdir(root,{recursive:true,mode:0o700});
  // Startup stages go to service-startup.log, so a service that hangs or dies before it is ready says where.
  const stageLog = path.join(root,'service-startup.log');
  await fs.writeFile(stageLog,'',{mode:0o600}).catch(()=>{});
  const stage = name => fs.appendFile(stageLog,`${new Date().toISOString()} ${name}\n`).catch(()=>{});
  await stage(`start pid ${process.pid}`);
  const old = await fs.readFile(descriptor,'utf8').then(JSON.parse).catch(()=>null);
  if (old && old.pid !== process.pid && alive(old.pid)) throw new Error('A session service is already running.');
  if (process.platform !== 'win32') await fs.rm(endpoint(root),{force:true});
  const machine = {hostname:require('node:os').hostname(), home:require('node:os').homedir()};
  function snapshot() { const base=broker.snapshot(); return {...base, agents:base.agents.map(a=>({...a,install:maintenance.capabilities(a)})), machine, opayaAgent:opaya?.describe() || null, providerPresets:PROVIDERS, frameworks:catalog.list(), gitActions:projects.actionList(), platform:process.platform, terminals:terminals?.describe() || [], service:{pid:process.pid, startedAt, persistent:true}}; }
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
  require('./process.cjs').primeShellPath(); // read the login shell's PATH in the background (macOS GUI apps lack it)
  broker = new Broker({store:new Store(root),vault:new Vault(root,safeStorage),emit,approve});
  await stage('broker');
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
  await stage('terminals');
  await terminals.init();
  // Installs and diagnostics run in visible one-off terminals; the UI is told to show them.
  // Background jobs (clone, redeploy): no IPC timeout, live steps and log sent to every window, kept until dismissed.
  const jobs=new Map(),library=new moves.SkillLibrary(root);
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
  // Update, uninstall and local backups. Update and uninstall show the exact command for approval and run in a visible
  // terminal; an uninstall prints an end marker so the job knows when it finished and can then remove the connection.
  const hostOf=a=>a.transport==='ssh'?broker.host(a.hostId):null;
  const machineName=()=>broker.data.settings?.machineName||'This computer';
  const whereName=a=>a.transport==='ssh'?broker.host(a.hostId).name:machineName();
  const windowsLocal=a=>a.transport!=='ssh'&&process.platform==='win32';
  const marked=(a,command)=>windowsLocal(a)?`${command}; Write-Host "[opaya] finished with exit code $(if ($?) { 0 } else { 1 })"`:`${command}; echo "[opaya] finished with exit code $?"`;
  const MARK=/\[opaya\] finished with exit code (\d+)/g;
  const marks=view=>[...String(view.buffer||'').replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g,'').matchAll(MARK)];
  const markCount=id=>{try{return marks(terminals.attach(id)).length;}catch{return 0;}};
  async function waitForMark(id,before,timeout=45*60*1000){
    const end=Date.now()+timeout;
    for(;;){
      let view;try{view=terminals.attach(id);}catch{throw new Error('The uninstall terminal was closed before it finished.');}
      const found=marks(view);
      if(found.length>before)return Number(found.at(-1)[1]);
      if(view.exited)throw new Error('The uninstall terminal ended before the uninstaller finished.');
      if(Date.now()>end)throw new Error('The uninstaller did not finish within 45 minutes. Check its terminal.');
      await new Promise(r=>setTimeout(r,1500));
    }
  }
  function backupJob(a,{keys,history},work){
    return startJob({kind:work?'uninstall':'backup',route:{from:a.name,fromWhere:whereName(a),to:work?'Backed up, then uninstalled':'Local backup',toWhere:machineName(),provider:a.provider},title:work?`Backing up and uninstalling ${a.name}`:`Backing up ${a.name}`,detail:`${history?'With':'Without'} chat history / ${keys?'with':'without'} API keys`,steps:[['source','Find the data'],['select','Choose files'],['copy','Write the archive'],...(work?.steps||[])]},async progress=>{
      const result=await maintenance.backup({agent:a,host:hostOf(a),dest:maintenance.backupDir(broker.data.settings),keys,history,machine:machineName(),progress});
      if(work)result.after=await work.run(progress,result);
      return result;
    });
  }
  const maintenanceActions={
    agentInstallInfo:async x=>{const a=broker.agent(x.id);const info=await maintenance.detect(a,hostOf(a));return {...info,shared:maintenance.sharing(a,broker.data.agents)};},
    agentMaintenanceCommand:async x=>{const a=broker.agent(x.id),remote=a.transport==='ssh';return x.action==='uninstall'?maintenance.uninstallCommand(a,{remote,data:!!x.data}):maintenance.updateCommand(a,{remote});},
    agentUpdate:async x=>{
      const a=broker.agent(x.id),host=hostOf(a),c=maintenance.updateCommand(a,{remote:!!host});
      if(!await approve(a,`${c.title} ${host?`on ${host.name}`:`on ${machineName()}`}?`,`${c.summary}\n\nRuns in a visible terminal:\n\n${c.preview}\n\nAfterwards: ${c.after}`))throw new Error('Update cancelled.');
      return runInTerminal({label:c.title,key:`update_${a.id}`.slice(0,60),host,command:c.command});
    },
    // Updates every installation once per machine (and every container), after one approval for the whole list.
    agentUpdateAll:async()=>{
      const seen=new Map();
      for(const a of broker.data.agents){let c;try{c=maintenance.updateCommand(a,{remote:a.transport==='ssh'});}catch{continue;}const key=`${a.transport==='ssh'?a.hostId:'local'}|${c.command}`;if(!seen.has(key))seen.set(key,{a,c});}
      if(!seen.size)throw new Error('None of your agents has an update Opaya can run.');
      const list=[...seen.values()];
      if(!await approve({name:'Opaya'},`Update ${list.length} installation${list.length===1?'':'s'}?`,list.map(({a,c})=>`${c.title} on ${whereName(a)} (${a.name})`).join('\n')+'\n\nEach runs in its own visible terminal.'))throw new Error('Update cancelled.');
      for(const {a,c} of list)await runInTerminal({label:c.title,key:`update_${a.id}`.slice(0,60),host:hostOf(a),command:c.command});
      return list.length;
    },
    agentBackup:async x=>{const a=broker.agent(x.id);return backupJob(a,{keys:x.keys!==false,history:x.history!==false});},
    agentBackups:async x=>maintenance.listBackups(broker.agent(x.id),broker.data.settings),
    backupRemove:async x=>maintenance.removeBackup(x.file,broker.data.settings),
    backupPath:async x=>x.folder?maintenance.backupDir(broker.data.settings):maintenance.insideBackups(x.file,broker.data.settings),
    agentUninstall:async x=>{
      const a=broker.agent(x.id),host=hostOf(a),c=maintenance.uninstallCommand(a,{remote:!!host,data:!!x.data});
      const shared=maintenance.sharing(a,broker.data.agents).map(id=>broker.data.agents.find(b=>b.id===id)?.name).filter(Boolean);
      if(!await approve(a,`${c.title} ${host?`on ${host.name}`:`on ${machineName()}`}?`,`${c.summary}${shared.length&&!['hermes-profile','docker'].includes(maintenance.kindOf(a).kind)?`\n\nAlso used by: ${shared.join(', ')}. They stop working too.`:''}${x.backup?'\n\nA local backup is made first; if it fails, nothing is uninstalled.':''}${x.removeConnection?'\n\nAfterwards the connection and its chats are removed from Opaya.':''}\n\nRuns in a visible terminal:\n\n${c.preview}`))throw new Error('Uninstall cancelled.');
      const steps=[['stop','Disconnect'],['uninstall','Run the uninstaller'],...(x.removeConnection?[['remove','Remove from Opaya']]:[])];
      const work=async progress=>{
        progress({step:'stop',state:'active',message:`Disconnecting ${a.name}`});await Promise.resolve(broker.disconnect(a.id)).catch(()=>{});progress({step:'stop',state:'done',message:'Disconnected'});
        progress({step:'uninstall',state:'active',message:'The uninstaller runs in the terminal below. Answer its questions there.'});
        const view=await runInTerminal({label:c.title,key:`uninstall_${a.id}`.slice(0,60),host,command:marked(a,c.command)});
        const code=await waitForMark(view.id,markCount(view.id));
        if(code!==0)throw new Error(`The uninstaller ended with exit code ${code}. Check its terminal; the connection was kept.`);
        progress({step:'uninstall',state:'done',message:'Uninstalled'});
        if(x.removeConnection){progress({step:'remove',state:'active',message:'Removing the connection and its chats from Opaya'});terminals.closeAgent(a.id);await broker.removeAgent(a.id);progress({step:'remove',state:'done',message:'Removed from Opaya'});}
        return {uninstalled:true,removed:!!x.removeConnection};
      };
      if(x.backup)return backupJob(a,{keys:true,history:true},{steps,run:work});
      return startJob({kind:'uninstall',route:{from:a.name,fromWhere:whereName(a),to:'Uninstalled',toWhere:whereName(a),provider:a.provider},title:`Uninstalling ${a.name}`,detail:c.summary,steps},work);
    }
  };
  opaya = new OpayaAgent({root,vault:broker.vault,broker,terminals,approve,emit,runInTerminal,trusted:()=>!!broker.data.settings?.itrustOpaya});
  await stage('opaya agent');
  await opaya.init();
  // A fresh install: connect the Opaya Agent to a local Ollama model with tools if one already runs (no input needed).
  free.autoConnect({opaya}).then(model=>{if(model)emit();}).catch(()=>{});
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
    // Closing a tab always works, also when its agent or machine was removed: then only the local record is dropped.
    terminalClose:async x=>{
      const s=terminals.describe().find(s=>s.id===schema.id(x.id));if(!s)return false;
      let host=null;if(s.remote){try{host=broker.host(s.agentId.startsWith('host_')?s.agentId.slice(5):broker.agent(s.agentId).hostId);}catch{host=null;}}
      if(s.remote&&!host){terminals.close(x.id);emit();return true;}
      try{await terminals.end(x.id,host);}catch(error){terminals.close(x.id);emit();return {closed:true,warning:safeError(error)};}
      emit();return true;
    },
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
    // Transfer between agents: skills (all or chosen), Hermes API keys, Opaya's MCP servers and the Opaya API token.
    agentEnvKeys:async x=>{const a=broker.agent(x.id);return moves.envKeys(a,a.transport==='ssh'?broker.host(a.hostId):null);},
    transferStart:async x=>{
      const src=broker.agent(x.sourceId),dst=broker.agent(x.targetId);if(src.id===dst.id)throw new Error('Choose a different agent to receive them.');
      const hostOf=a=>a.transport==='ssh'?broker.host(a.hostId):null;
      const parts=[x.skills&&'skills',x.keys&&'API keys',x.mcp?.length&&'tools',x.token&&'API token'].filter(Boolean);if(!parts.length)throw new Error('Choose what to transfer.');
      const steps=[...(x.skills?[['source','Read skills'],['target','Find the target'],['copy','Copy skills']]:[]),...(x.keys?[['keys','Copy API keys']]:[]),...(x.mcp?.length?[['mcp','Share MCP servers']]:[]),...(x.token?[['token','Copy API token']]:[])];
      return startJob({kind:'transfer',route:{from:src.name,fromWhere:src.transport==='ssh'?hostOf(src).name:'This computer',to:dst.name,toWhere:dst.transport==='ssh'?hostOf(dst).name:'This computer',provider:src.provider},title:`Transferring to ${dst.name}`,detail:`${parts.join(', ')} from ${src.name}`,steps},async progress=>{
        const result={};
        if(x.skills)result.skills=(await moves.transferSkills({source:src,sourceHost:hostOf(src),target:dst,targetHost:hostOf(dst),names:x.skills==='all'?'all':[].concat(x.skills).map(String),progress})).skills;
        if(x.keys)result.keys=(await moves.transferEnv({source:src,sourceHost:hostOf(src),target:dst,targetHost:hostOf(dst),keys:x.keys==='all'?'all':[].concat(x.keys).map(String),progress})).keys;
        if(x.mcp?.length){progress({step:'mcp',state:'active',message:'Sharing MCP servers'});const names=[];for(const id of x.mcp){const sv=await broker.setAgentMcp({agentId:dst.id,serverId:id,enabled:true});names.push(sv.name);}progress({step:'mcp',state:'done',message:`${dst.name} now uses ${names.join(', ')}. New conversations pick them up.`});result.mcp=names;}
        if(x.token){progress({step:'token',state:'active',message:'Copying the Opaya API token'});const token=broker.vault.get(src.id);if(!token)throw new Error(`${src.name} has no saved API token.`);await broker.vault.set(dst.id,token,true);broker.disconnect(dst.id);progress({step:'token',state:'done',message:`Token copied. Reconnect ${dst.name} to use it.`});result.token=true;}
        if(result.skills)progress({message:'New conversations with the agent load the new skills.'});
        return result;
      });
    },
    // Chat history: rename, delete, condense to the essence, and Markdown for sharing.
    renameConversation:x=>broker.renameConversation(x), deleteConversation:x=>broker.deleteConversation(x.id),
    condenseConversation:async x=>{const c=broker.conversation(x.id),a=broker.agent(c.agentId),model=opaya.summarizer();
      return startJob({kind:'condense',route:{from:c.title.slice(0,40),fromWhere:a.name,to:'Essence',toWhere:model||a.name,provider:a.provider},title:'Condensing chat',detail:c.title,steps:[['read','Read the chat'],['condense',model?'Condense with the Opaya model':`Ask ${a.name} to condense`],['save','Save the essence']]},progress=>condense({broker,opaya,id:c.id,progress}));},
    conversationMarkdown:async x=>{const c=broker.conversation(x.id),a=broker.agent(c.agentId),p=c.projectId&&(broker.data.projects||[]).find(y=>y.id===c.projectId);
      if(x.essence){if(!c.essence)throw new Error('Condense this chat first.');return `# ${c.title} (essence)\n\nAgent: ${a.name}${p?` / Project: ${p.name}`:''}\n\n${c.essence.text}\n`;}
      const messages=await broker.messagesOf(c.id);return `# ${c.title}\n\nAgent: ${a.name}${p?` / Project: ${p.name}`:''}\n\n`+messages.filter(m=>m.content).map(m=>`## ${m.role==='user'?'You':a.name}\n\n${m.content}\n`).join('\n');},
    libraryList:()=>library.list().then(list=>list.map(({name,description,category,folder})=>({name,description,category,folder}))),
    libraryImport:async x=>{const a=broker.agent(x.agentId);return startJob({kind:'library',route:{from:a.name,fromWhere:a.transport==='ssh'?broker.host(a.hostId).name:'This computer',to:'Skills library',toWhere:'Opaya',provider:a.provider},title:'Adding skills to the library',detail:`From ${a.name}`,steps:[['source','Read skills'],['copy','Copy into the library']]},progress=>library.importFrom({agent:a,host:a.transport==='ssh'?broker.host(a.hostId):null,names:x.names==='all'?'all':[].concat(x.names||[]).map(String),progress}));},
    libraryInstall:async x=>{
      const targets=[].concat(x.agentIds||[]).map(id=>broker.agent(id));if(!targets.length)throw new Error('Choose agents to install to.');
      return startJob({kind:'library',route:{from:'Skills library',fromWhere:'Opaya',to:targets.length===1?targets[0].name:`${targets.length} agents`,toWhere:targets.map(a=>a.name).join(', ').slice(0,60),provider:targets[0].provider},title:'Installing skills',detail:`${x.names==='all'?'All library skills':[].concat(x.names).length+' skill(s)'} to ${targets.map(a=>a.name).join(', ')}`,steps:[['copy','Copy to agents']]},progress=>library.installTo({agents:targets.map(a=>({agent:a,host:a.transport==='ssh'?broker.host(a.hostId):null})),names:x.names==='all'?'all':[].concat(x.names||[]).map(String),progress}));
    },
    libraryRemove:x=>library.remove(String(x.name||'')), libraryAddFolder:x=>library.addFolder(String(x.path||'')),
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
    // Free local model: install Ollama if needed, start it, download the model and connect the Opaya Agent.
    opayaFreeModels:async()=>({models:free.FREE_MODELS.map(({id,label,size,note})=>({id,label,size,note})),recommended:free.recommended(),installed:await free.ollamaModels()}),
    opayaFreeSetup:async x=>{const model=String(x?.model||free.recommended());const m=free.FREE_MODELS.find(f=>f.id===model);if(!m)throw new Error('Choose one of the free models.');
      return startJob({kind:'free-model',route:{from:m.label,fromWhere:`Free / ${m.size}`,to:'Opaya Agent',toWhere:'This computer',provider:'ollama'},title:`Setting up ${m.label}`,detail:'Free local model through Ollama. No account and no key.',steps:[['ollama','Install and start Ollama'],['download',`Download ${m.label} (${m.size})`],['connect','Connect the Opaya Agent']]},progress=>free.setupFree({opaya,model,progress}).then(r=>{emit();return r;}));},
    opayaSaveConfig:x=>opaya.saveConfig(x), opayaTest:x=>opaya.test(x||{}), opayaForgetKey:()=>opaya.forgetKey(),
    opayaSend:x=>opaya.begin(x.text), opayaNewSession:()=>opaya.newSession(), opayaSelectSession:x=>opaya.selectSession(String(x.id||'')), opayaDeleteSession:x=>opaya.deleteSession(String(x.id||'')), opayaStop:()=>opaya.stop(), opayaClear:()=>opaya.clear(),
    ...maintenanceActions,
    shutdown
  };
  const token = randomBytes(32).toString('hex');
  listener = server({token,snapshot,scopes:()=>new Map([[browserToken,new Set(['browserTool'])]]),
    dispatch:async (method,input)=>{if(!Object.hasOwn(actions,method))throw new Error('Unsupported desktop action.');try{return await actions[method](input||{});}catch(error){throw new Error(safeError(error));}},
    onApproval:(socket,message)=>{const a=approvals.get(message.id);if(a?.socket===socket)a.finish(message.allow===true);},
    onDetach:socket=>{for(const a of approvals.values())if(a.socket===socket)a.finish(false);}
  });
  await stage('listen');
  await new Promise((resolve,reject)=>{listener.once('error',reject);listener.listen(endpoint(root),resolve);});
  if(process.platform!=='win32')await fs.chmod(endpoint(root),0o600);
  await atomicJson(descriptor,{protocol:1,pid:process.pid,token,startedAt});
  await stage('ready');
  app.on('before-quit',event=>{if(!stopping){event.preventDefault();shutdown().catch(()=>app.exit(1));}});
  process.on('SIGTERM',()=>shutdown().catch(()=>app.exit(1)));
  process.on('SIGINT',()=>shutdown().catch(()=>app.exit(1)));
  // Referenced listener keeps the service alive after every UI client detaches.
  return {broker,terminals,listener,shutdown};
}
module.exports = {start};
