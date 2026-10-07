'use strict';
// Independent Electron main process; no BrowserWindow and no public port.
const fs = require('node:fs/promises');
const path = require('node:path');
const {randomBytes, randomUUID} = require('node:crypto');
const {Store, Vault, atomicJson} = require('./store.cjs');
const {Broker, safeError} = require('./broker.cjs');
const {Terminals, ...shells} = require('./terminal.cjs');
const {server, endpoint} = require('./wire.cjs');
const {PROVIDERS}=require('./providers.cjs');
const {alive} = require('./host-client.cjs');
const schema = require('./schema.cjs');
const catalog = require('./catalog.cjs');
const files = require('./files.cjs');
const {OpayaAgent} = require('./opaya-agent.cjs');
const skills = require('./skills.cjs');
const projects = require('./projects.cjs');
const {dockerExecContainerIndex,collect} = require('./process.cjs');
const vps = require('./vps.cjs');
const moves = require('./transfer.cjs');
const {condense} = require('./condense.cjs');
const free = require('./free-model.cjs');
const maintenance = require('./maintenance.cjs');
const versions = require('./versions.cjs');
const updates = require('./updates.cjs');
const secrets = require('./secrets.cjs');
const diagnostics = require('./diagnostics.cjs');
const containers = require('./containers.cjs');
const dockerManager = require('./docker-manager.cjs');
const mcp = require('./mcp.cjs');
const remoteWork = require('./remote-work.cjs');
const guide = require('./guide.cjs');
const toolchain = require('./toolchain.cjs');
const {visionOf, SUPPORTED:VISION_MODELS} = require('./vision.cjs');
const pasting = require('./clipboard.cjs');
async function start({app, safeStorage, shell: electronShell}, root) {
  let broker, terminals, listener, opaya, stopping = false, setupTrust = false, codexLogins = null;
  const codexWhere = new Map(), codexChecks = new Map(), codexSeen = new Set(); // codex-login.cjs: where a terminal's command runs; pending screen reads
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
  const toolState = {machines:{}, checking:false, notified:''}; // update checks, filled in the background
  function snapshot() { const base=broker.snapshot(); return {...base, agents:base.agents.map(a=>({...a,install:maintenance.capabilities(a),vision:visionOf(a)})), toolUpdates:{machines:toolState.machines,checking:toolState.checking}, machine, opayaAgent:opaya?.describe() || null, providerPresets:PROVIDERS, visionModels:VISION_MODELS, frameworks:catalog.list(), gitActions:projects.actionList(), platform:process.platform, terminals:terminals?.describe() || [], service:{pid:process.pid, startedAt, persistent:true}}; }
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
  // The Opaya Agent's secure prompt (request_secret): an approval of kind secret, with a password field in the window.
  // The typed value comes back with the answer and goes to the vault, never into a chat. No window: no value.
  function askSecret({name, why = '', agent = ''}) {
    const socket = [...(listener?.clients || [])].at(-1);
    if (!socket) return Promise.resolve(null);
    const id = randomUUID();
    return new Promise(resolve => {
      const timer = setTimeout(() => finish(false), 10 * 60 * 1000);
      function finish(allow, value) { clearTimeout(timer); approvals.delete(id); resolve(allow === true && typeof value === 'string' && value.trim() && value.length <= 12000 && !value.includes('\0') ? value.trim() : null); }
      approvals.set(id,{socket,finish}); listener.notify(socket,'approval',{id,kind:'secret',agent:{name:'Opaya Agent'},title:`The Opaya Agent asks for ${name}`,detail:[why,agent?`For ${agent}.`:''].filter(Boolean).join('\n\n'),secret:{name,why,for:agent}});
    });
  }
  require('./process.cjs').primeShellPath(); // read the login shell's PATH in the background (macOS GUI apps lack it)
  broker = new Broker({store:new Store(root),vault:new Vault(root,safeStorage),emit,approve});
  await stage('broker');
  await broker.init();
  // Opaya browser for agents: the MCP bridge gets a token that can only call browserTool, forwarded to the Opaya window.
  const browserToken = randomBytes(32).toString('hex'), browserCalls = new Map();
  const toolsToken = randomBytes(32).toString('hex');
  // Opaya Vault for agents on this computer: the MCP bridge gets a token that can only call vaultTool.
  const vaultToken = randomBytes(32).toString('hex');
  broker.vaultBridge = {command:process.execPath, args:[path.join(__dirname,'vault-mcp.cjs')], env:{ELECTRON_RUN_AS_NODE:'1',OPAYA_VAULT_ENDPOINT:endpoint(root),OPAYA_VAULT_TOKEN:vaultToken}};
  // Agents on other machines and in containers: a relay where they run (remote-bridge.cjs) brings their browser_* calls
  // here, answered like the local bridge, in their own browser tab.
  const relays=new Map(),{RemoteBridge}=require('./remote-bridge.cjs'),browserMcp=require('./browser-mcp.cjs'),{visionOf:seesImages}=require('./vision.cjs');
  broker.remoteBrowser=async agent=>{
    relays.get(agent.id)?.close();
    const where=require('./clone.cjs').place({agent,host:agent.transport==='ssh'?broker.host(agent.hostId):null});
    const textOnly=seesImages({...agent,activeModel:broker.runtimeFor(agent.id).adapter?.currentModel}).vision===false;
    const relay=new RemoteBridge({where,shell:require('./clone.cjs').shell,onConnection:conn=>{const on=browserMcp.serve({send:t=>conn.send(t),browserTool:input=>browserTool(input),agent:agent.id,textOnly});conn.lines(on);}});
    relay.onClose=()=>{if(relays.get(agent.id)===relay){relays.delete(agent.id);const r=broker.runtimeFor(agent.id);if(r.remoteMcp)r.remoteMcp=null;}};
    relays.set(agent.id,relay);return relay.start();
  };
  broker.closeRemoteBrowser=id=>{relays.get(id)?.close();relays.delete(id);};
  broker.browserBridge = {command:process.execPath, args:[path.join(__dirname,'browser-mcp.cjs')], env:{ELECTRON_RUN_AS_NODE:'1',OPAYA_BROWSER_ENDPOINT:endpoint(root),OPAYA_BROWSER_TOKEN:browserToken}};
  function browserTool(input){
    const socket=[...(listener?.clients||[])].at(-1);
    if(!socket)return Promise.reject(new Error('Open the Opaya window to use its browser.'));
    const id=randomUUID();
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{browserCalls.delete(id);reject(new Error('The browser did not answer in time.'));},110000);
      browserCalls.set(id,{resolve,reject,timer});
      listener.notify(socket,'browser-request',{id,op:String(input.op||''),args:input.args&&typeof input.args==='object'?input.args:{},owner:/^[A-Za-z0-9_-]{1,80}$/.test(String(input.agent||''))?String(input.agent):'user'});
    });
  }
  terminals = new Terminals(event => { listener?.broadcast('terminal',event); if (event.type === 'data') codexWatch(event); else { if (event.type === 'exit') codexLogins?.stopTerminal(event.id); emit(); } },{root});
  await stage('terminals');
  await terminals.init();
  // Installs and diagnostics run in visible one-off terminals; the UI is told to show them.
  // Background jobs (clone, redeploy): no IPC timeout, live steps and log sent to every window, kept until dismissed.
  const webs=new Map(),dshWeb=require('./dsh-web.cjs'),{Tunnel,freePort}=require('./tunnel.cjs');
  const reachable=url=>fetch(url,{signal:AbortSignal.timeout(2000)}).then(()=>true,()=>false);
  const jobs=new Map(),library=new moves.SkillLibrary(root),origin=new (require('node:async_hooks').AsyncLocalStorage)();
  function publishJob(job){listener?.broadcast('job',job);}
  function startJob({kind,title,detail,steps,route},work){
    const byOpaya=origin.getStore()==='opaya';
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
      error=>{job.status='error';job.error=safeError(error);job.finishedAt=Date.now();for(const s of job.steps)if(s.state==='active')s.state='error';job.log.push({at:Date.now(),text:job.error,state:'error'});
        // A job the user started that failed goes to the Opaya Agent (one it started itself, it follows with its jobs tool).
        if(!byOpaya)actionFailed(job.title,job.error,`It ran as an Opaya job (job_id ${job.id}, ${kind}); its steps: ${job.steps.map(x=>`${x.label} ${x.state}`).join(', ')}. Read it with your jobs tool.`);})
      .finally(()=>{clearTimeout(timer);publishJob(job);emit();});
    return job;
  }
  // The pseudo agents behind "This computer" and a machine's own shell.
  const localShell=()=>shells.localShell(app.getPath('home'));
  const hostShell=hostId=>shells.hostShell(broker,hostId);
  // The agent (or pseudo agent) a terminal session was opened for: to start it again, or to take pasted files there.
  const sessionAgent=s=>shells.sessionAgent(s,{broker,home:app.getPath('home')});
  // owner: whose screen the terminal belongs to (an agent's id, 'opaya' for the Opaya Agent); none: the screen in front.
  // where: where the command runs ({host, container}) when that is not just the machine (a docker exec in it).
  async function runInTerminal({label,key,host,command,owner,where}){
    const pseudo={id:`svc_${key}_${host?host.id:'local'}`.slice(0,80),name:label,provider:'custom',transport:host?'ssh':'local',hostId:host?.id||'',command:'',args:[],cwd:host?'':app.getPath('home'),ephemeral:true,run:host?command:''};
    const reused=terminals.hasLive(pseudo.id,'shell'),view=terminals.open(pseudo,host,'shell',{cols:110,rows:30});
    if(!host||reused)terminals.write(view.id,command+'\r');
    if(where)codexWhere.set(view.id,{host:where.host||null,container:where.container||''});
    listener?.broadcast('terminal',{type:'opened',id:view.id,...(owner?{owner}:{})});emit();return view;
  }
  // ---- Codex sign-in on a machine or in a container (codex-login.cjs) -------------------------------------------------
  // `codex login` there prints a sign-in link whose answer goes to 127.0.0.1 where Codex runs. When a terminal on a
  // machine or in a container shows one, Opaya listens on that port here, opens the link in the browser, and passes the
  // browser's answer to Codex there. Terminals on this computer are left alone: Codex opens the browser itself.
  codexLogins=new (require('./codex-login.cjs').CodexLogins)({shell:require('./clone.cjs').shell,collect,
    open:url=>electronShell?.openExternal?electronShell.openExternal(url):Promise.reject(new Error('No browser available from the session service.')),
    notify:n=>{
      const text={open:`Finish it in your browser. Opaya passes the answer to Codex on ${n.name}.`,paste:`${n.error?`${n.error} `:''}Open the sign-in page, sign in, then paste the address the browser ends on (it starts with http://127.0.0.1:${n.port}/auth/callback).`,done:`Codex on ${n.name} is signed in.`,failed:`Codex on ${n.name} did not accept the sign-in (${n.status}). Start the sign-in again.`}[n.phase];
      notice({kind:'codex-login',level:n.phase==='failed'?'error':n.phase==='done'?'done':'info',title:n.phase==='done'?'Codex signed in':'Codex sign-in',text,phase:n.phase,state:n.state,url:n.url,port:n.port,machine:n.name,terminalId:n.terminalId});
      emit();
    }});
  // Where a terminal's program runs: the container named by its launcher, the agent's own place, or the machine.
  function terminalWhere(session){
    if(codexWhere.has(session.id))return codexWhere.get(session.id);
    let host=null;try{host=session.hostId?broker.host(session.hostId):null;}catch{}
    try{const a=broker.agent(session.agentId);return require('./clone.cjs').place({agent:a,host:a.transport==='ssh'?broker.host(a.hostId):null});}catch{}
    return {host,container:''};
  }
  const codexPlace=where=>`${where.host?where.host.name:machineName()}${where.container?` (container ${where.container})`:''}`;
  function codexWatch({id,data}){
    if(!codexLogins||codexChecks.has(id)||!/oauth|authorize|openai/.test(String(data||'')))return;
    codexChecks.set(id,setTimeout(()=>{codexChecks.delete(id);codexScan(id).catch(()=>{});},400));
  }
  async function codexScan(id){
    let session;try{session=terminals.attach(id);}catch{return;}
    const where=terminalWhere(session);if(!where.host&&!where.container)return;
    const {findAuthUrl}=require('./codex-login.cjs'),{render}=require('./screen.cjs');
    const tail=String(session.buffer||'').slice(-60000),shown=await render(tail,session.cols,session.rows);
    // What is on screen now (or was just printed), never a link from an earlier sign-in further back.
    const auth=findAuthUrl(shown.lines)||findAuthUrl(tail.slice(-6000).replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)/g,'').replace(/\r/g,''));
    if(!auth||codexSeen.has(auth.state))return;codexSeen.add(auth.state);
    await codexLogins.start({auth,where,name:codexPlace(where),terminalId:id});
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
  async function waitForMark(id,before,timeout=45*60*1000,what='uninstall'){
    const end=Date.now()+timeout;
    for(;;){
      let view;try{view=terminals.attach(id);}catch{throw new Error(`The ${what} terminal was closed before it finished.`);}
      const found=marks(view);
      if(found.length>before)return Number(found.at(-1)[1]);
      if(view.exited)throw new Error(`The ${what} terminal ended before the ${what} finished.`);
      if(Date.now()>end)throw new Error(`The ${what} did not finish within ${Math.round(timeout/60000)} minutes. Check its terminal.`);
      await new Promise(r=>setTimeout(r,1500));
    }
  }
  // What one marked run printed: the text between the end line before it and its own end line.
  function markedOutput(id,before){
    let text='';try{text=String(terminals.attach(id).buffer||'').replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)/g,'').replace(/\r/g,'');}catch{return '';}
    const found=[...text.matchAll(MARK)],from=before>0&&found[before-1]?found[before-1].index+found[before-1][0].length:0;
    return text.slice(from,found[before]?.index??text.length);
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
    // One approval, then the update runs in the machine's "Updates" terminal; if it fails or does not take effect, the
    // Opaya Agent finishes it (runBatch).
    agentUpdate:async x=>{
      const a=broker.agent(x.id),host=hostOf(a),c=maintenance.updateCommand(a,{remote:!!host}),j=agentJob(a,c);
      if(!await approve(a,`${c.title} ${host?`on ${host.name}`:`on ${machineName()}`}?`,`${c.summary}${j.how?`\n\nInstalled with: ${j.how}.`:''}\n\nRuns in a visible terminal:\n\n${c.preview}\n\nAfterwards: ${c.after} If it fails, the Opaya Agent finishes it.`))throw new Error('Update cancelled.');
      runBatch([j]).catch(()=>{});return true;
    },
    // Updates every installation once per machine (and every container), after one approval for the whole list.
    agentUpdateAll:async()=>{
      const seen=new Map();
      for(const a of broker.data.agents){let c;try{c=maintenance.updateCommand(a,{remote:a.transport==='ssh'});}catch{continue;}const key=`${a.transport==='ssh'?a.hostId:'local'}|${c.command}`;if(!seen.has(key))seen.set(key,{a,c});}
      if(!seen.size)throw new Error('None of your agents has an update Opaya can run.');
      const list=[...seen.values()],jobs=list.map(({a,c})=>agentJob(a,c));
      if(!await approve({name:'Opaya'},`Update ${list.length} installation${list.length===1?'':'s'}?`,list.map(({a,c},i)=>`${c.title} on ${whereName(a)} (${a.name}${jobs[i].how?`, ${jobs[i].how}`:''})`).join('\n')+'\n\nThey run one after another in each machine\'s "Updates" terminal. Whatever fails or does not take effect goes to the Opaya Agent to finish.'))throw new Error('Update cancelled.');
      runBatch(jobs).catch(()=>{});
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
        const view=await runInTerminal({label:c.title,key:`uninstall_${a.id}`.slice(0,60),host,command:marked(a,c.command),owner:a.id});
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
  // ---- Update checks and automatic fixes -------------------------------------------------------------------------
  // Every hour: which agents and tools are installed on this computer and on machines with agents, and whether a newer
  // version exists. The UI tells the user; nothing is updated without them, except the auto-fix below.
  const machineKey=host=>host?host.id:'local';
  async function checkMachine(host){
    const key=machineKey(host),name=host?host.name:machineName();
    try{toolState.machines[key]={name,hostId:host?.id||'',...await versions.check(host)};}
    catch(error){toolState.machines[key]={...(toolState.machines[key]||{items:[]}),name,hostId:host?.id||'',checkedAt:new Date().toISOString(),error:safeError(error)};}
    return toolState.machines[key];
  }
  async function checkAll({notify=true}={}){
    if(toolState.checking)return toolState;toolState.checking=true;emit();
    try{
      await checkMachine(null);
      for(const h of broker.data.hosts)if(broker.data.agents.some(a=>a.hostId===h.id))await checkMachine(h);
      for(const k of Object.keys(toolState.machines))if(k!=='local'&&!broker.data.hosts.some(h=>h.id===k))delete toolState.machines[k];
    }finally{toolState.checking=false;}
    const outdated=Object.values(toolState.machines).flatMap(m=>m.items.filter(i=>i.outdated).map(i=>({...i,machine:m.name})));
    const signature=outdated.map(i=>`${i.machine}/${i.id}/${i.latest||i.note}`).sort().join(',');
    if(notify&&signature&&signature!==toolState.notified){
      toolState.notified=signature;
      notice({level:'info',kind:'updates',title:`${outdated.length} update${outdated.length===1?'':'s'} available`,text:outdated.slice(0,4).map(i=>`${i.name} ${i.installed}${i.latest?` > ${i.latest}`:''}${i.note?` (${i.note})`:''} on ${i.machine}`).join(', ')+(outdated.length>4?', ...':'')});
    }
    emit();return toolState;
  }
  // Opaya's schedules: each minute, the ones due send their message (schedules.cjs). An agent is connected first if it is
  // not; a busy one is skipped this time. Each schedule keeps its own chat with that agent.
  const schedules=require('./schedules.cjs');
  async function runSchedule(x,{manual=false}={}){
    const at=new Date().toISOString(),done=(status,error='')=>broker.scheduleRan(x.id,{lastRun:at,lastStatus:status,lastError:String(error).slice(0,300)}).then(emit);
    try{
      if(x.agentId==='opaya'){if(!opaya?.configured())throw new Error('Connect the Opaya Agent to a model first.');if(opaya.busy){await done('skipped','The Opaya Agent was busy.');return;}opaya.begin(`[Schedule: ${x.name}] ${x.prompt}`);await done('sent');return;}
      const a=broker.agent(x.agentId);if(broker.turns.has(a.id)){await done('skipped',`${a.name} was busy.`);return;}
      if(broker.runtimeFor(a.id).status!=='connected')await broker.connect(a.id);
      let conv=x.conversationId&&broker.data.conversations.find(c=>c.id===x.conversationId);
      if(!conv){conv=await broker.createConversation(a.id,{activate:false,title:`Schedule: ${x.name}`.slice(0,80)});await broker.scheduleRan(x.id,{conversationId:conv.id});}
      broker.send({agentId:a.id,conversationId:conv.id,text:x.prompt}).catch(error=>done('failed',error?.message||error));
      await done('sent');if(!manual)notice({level:'info',title:`Schedule: ${x.name}`,text:`Sent to ${a.displayName||a.name}.`});
    }catch(error){await done('failed',error?.message||error);notice({level:'error',title:`Schedule failed: ${x.name}`,text:String(error?.message||error).slice(0,200)});}
  }
  let lastTick='';
  setInterval(()=>{const now=new Date(),key=now.toISOString().slice(0,16);if(key===lastTick)return;lastTick=key;
    for(const x of broker.data.schedules||[])if(x.enabled){try{if(schedules.matches(x.cron,now))runSchedule(x);}catch{}}},15*1000).unref?.();
  const hourly=()=>{if(broker.data.settings?.updateChecks!==false)checkAll().catch(()=>{});};
  setTimeout(hourly,2*60*1000);setInterval(hourly,60*60*1000);
  function notice(n){listener?.broadcast('notice',{id:randomUUID(),at:Date.now(),...n});}
  // Runs a marked update in a visible terminal and waits for its end line: {code, output (what it printed), terminal}.
  async function runUpdate({host,label,key,command,timeout=20*60*1000,owner}){
    const end=!host&&process.platform==='win32'?'; Write-Host "[opaya] finished with exit code $(if ($?) { 0 } else { 1 })"':'; echo "[opaya] finished with exit code $?"';
    const view=await runInTerminal({label,key,host,command:command+end,owner}),before=markCount(view.id);
    const code=await waitForMark(view.id,before,timeout,'update');
    return {code,output:markedOutput(view.id,before),terminal:view.id};
  }
  // Agent errors go to the Opaya Agent. A connection that fails because something is too old is updated first and
  // reconnected; every other error (gateway not installed or down, onboarding or sign-in unfinished, a dropped
  // connection, a failed answer) goes to the Opaya Agent right away with Opaya's guess at the cause. If the Opaya Agent
  // cannot take it, the user sees the error. At most once per 30 minutes per agent and kind, so nothing loops, and one
  // hand-off at a time, so the Opaya Agent is never asked while it is busy.
  const fixing=new Map(),inFlight=new Map(),reported=new Map();let handoffs=Promise.resolve();
  const PHASE={connect:'does not connect',dropped:'lost its connection',turn:'failed while answering a chat'};
  const idle=async(o,ms)=>{const end=Date.now()+ms;while(o.busy&&Date.now()<end)await new Promise(r=>setTimeout(r,2000));return !o.busy;};
  function escalate(a,error,detail,phase='connect'){
    const run=handoffs.then(()=>handOff(a,error,detail,phase));handoffs=run.catch(()=>{});return run;
  }
  async function handOff(a,error,detail,phase){
    if(stopping||!broker.data.agents.some(x=>x.id===a.id))return;
    const o=opaya,where=whereName(a);
    // Fixed in the meantime (by an earlier hand-off for an agent sharing its gateway, or by the user).
    if(phase!=='turn'&&broker.runtimeFor(a.id).status==='connected')return;
    if(o?.configured()){
      try{
        if(!await idle(o,5*60*1000))throw new Error('it stayed busy with another request');
        if(phase!=='turn'&&broker.runtimeFor(a.id).status==='connected')return;
        o.begin(`${a.name} (agent_id ${a.id}; ${a.provider} over ${a.protocol}, on ${where}) ${PHASE[phase]||PHASE.connect}: "${error}". ${detail} Call agent_diagnostics and read_app_logs to find the real cause, fix it with your tools, then reconnect it and check that it works. Tell me only what I must do myself (for example an interactive sign-in or a token).`);
        notice({level:'info',kind:'opaya',title:`The Opaya Agent is looking into ${a.name}`,text:detail,agentId:a.id});
        await idle(o,15*60*1000);
        if(!o.error)return;
        detail+=` The Opaya Agent could not fix it: ${o.error}`;
      }catch(e){detail+=` The Opaya Agent could not take it: ${safeError(e)}`;}
    }else detail+=' The Opaya Agent has no model connected, so it could not take over.';
    notice({level:'error',kind:'fix-failed',title:`${a.name} needs your attention`,text:`${error}\n\n${detail}`,agentId:a.id});
  }
  // Any error that is not "too old": hand it to the Opaya Agent with a first diagnosis.
  function report(a,error,phase){
    if(stopping||broker.data.settings?.autoFix===false)return;
    const kind=diagnostics.classify(error,a),key=`${a.id}|${kind.id}`;
    if(reported.has(key)&&Date.now()-reported.get(key)<30*60*1000)return;
    reported.set(key,Date.now());
    escalate(a,String(error||'Unknown error'),`Opaya's first guess: ${kind.hint}`,phase).catch(()=>{});
  }
  // Something the user started in Opaya failed (a job, a Docker action, giving a key, an install in a terminal): the
  // Opaya Agent gets it with what Opaya knows, the same way agent errors reach it. Cancellations are not failures.
  const actionReported=new Map();
  function actionFailed(title,error,context=''){
    const text=String(error||'');
    if(stopping||broker.data.settings?.autoFix===false||/cancel|declined|not approved|stopped by the user/i.test(text))return;
    const key=`${title}|${text.slice(0,120)}`;if(actionReported.has(key)&&Date.now()-actionReported.get(key)<30*60*1000)return;actionReported.set(key,Date.now());
    const run=handoffs.then(async()=>{
      const o=opaya;if(!o?.configured())return;
      if(!await idle(o,5*60*1000))return;
      o.begin(`Something I did in Opaya failed: ${title}: "${text.slice(0,1500)}". ${context} Find the real cause with your tools (jobs, read_terminal, read_app_logs, agent_diagnostics, docker, run_diagnostic), fix it and finish what I was doing when you can do it safely. Tell me only what I must do myself.`);
    });handoffs=run.catch(()=>{});
  }
  async function autoFix(a,error){
    if(broker.data.settings?.autoFix===false)return;
    const target=versions.fixTarget(error);
    if(!target)return report(a,error,'connect');
    if(fixing.has(a.id)&&Date.now()-fixing.get(a.id)<30*60*1000)return;
    fixing.set(a.id,Date.now());
    const host=hostOf(a),remote=!!host;
    const dep=target==='agent'?'':target; // "requires Node 20": the runtime is too old, not the agent
    let c;
    try{c=dep?{...catalog.command(dep,{remote,update:true}),title:`Update ${dep==='node'?'Node.js':'Python'}`}:maintenance.updateCommand(a,{remote});}
    catch(e){return escalate(a,error,`Opaya could not update it automatically: ${safeError(e)}`);}
    notice({level:'info',kind:'fixing',title:`Updating ${dep?(dep==='node'?'Node.js':'Python'):a.name} automatically`,text:`${a.name} did not connect: ${error}. ${c.title||'The update'} runs in the terminal; Opaya reconnects when it finishes.`,agentId:a.id});
    // Agents that share an installation (Hermes profiles) fail together; they share one update run.
    const runKey=`${host?.id||'local'}|${c.command}`;
    if(!inFlight.has(runKey))inFlight.set(runKey,onMachine(host,()=>runUpdate({host,label:`${c.title||'Update'} (auto-fix)`,key:`autofix_${a.id}`.slice(0,60),command:c.command,owner:a.id})).finally(()=>setTimeout(()=>inFlight.delete(runKey),60000)));
    let code;
    try{code=(await inFlight.get(runKey)).code;}
    catch(e){return escalate(a,error,`The automatic update did not finish: ${safeError(e)}`);}
    if(code!==0)return escalate(a,error,`The automatic update (${c.title||'update'}) ended with exit code ${code}; see its terminal.`);
    versions.cache.clear();checkMachine(host).then(emit).catch(()=>{});
    try{await broker.connect(a.id);notice({level:'done',kind:'fixed',title:`${a.name} is updated and connected`,text:c.title||'',agentId:a.id});}
    catch(e){const err=safeError(e);if(versions.fixTarget(err))escalate(a,err,`Opaya updated it (${c.title||'update'}), but it still does not connect.`);} // other errors were reported by onConnectError
  }
  broker.onConnectError=(a,error)=>{autoFix(a,error).catch(()=>{});};
  broker.onAgentError=(a,error,phase)=>{report(a,error,phase);};
  broker.onClientRefused=(a,text)=>{notice({level:'info',kind:'surface',agentId:a.id,title:`${a.name} opens in its terminal now`,text:`It does not accept chats from other apps anymore ("${text.slice(0,160)}"). Its own CLI still works: Opaya shows it in the terminal. Right-click it > Allow chat again switches back, for example after you add an API key.`});emit();};
  // ---- Updates the user starts (one tool, Update selected, Update all here, an agent's Update, Update all agents) ------
  // One at a time per machine, so two Homebrew or npm runs never collide, in that machine's "Updates" terminal. Then the
  // versions are checked again: exit code 0 with the old version still first on PATH counts as failed. Everything that
  // failed in one run goes to the Opaya Agent in a single hand-off, or to the user when it cannot take it.
  const machineRuns=new Map();
  function onMachine(host,work){const k=machineKey(host),run=(machineRuns.get(k)||Promise.resolve()).catch(()=>{}).then(work);machineRuns.set(k,run.catch(()=>{}));return run;}
  const toolItem=(host,id)=>(toolState.machines[machineKey(host)]?.items||[]).find(i=>i.id===id)||null;
  // A job: {host, tool (versions id, '' for containers), name, command, plan, before (the checked item), builtin}.
  function toolJob(host,id,c){
    const before=toolItem(host,id),windows=!host&&process.platform==='win32';
    return {host,tool:id,name:c.framework.name,command:c.command,before,how:before?.how||'',path:before?.path||'',plan:updates.plan(id,before?.method,{windows})||(id==='homebrew'?'brew update && brew upgrade':''),builtin:!host&&before?.method==='opaya'&&builtinHere(id)};
  }
  async function runJob(j){
    if(j.builtin){const {done}=builtinJob([j.tool],{update:true}),r=await done;return {code:r.error?1:0,output:r.error||`Installed ${Object.values(r.installed||{}).join(' ')} with Opaya's installer.`};}
    // Agent names come from the user: only plain characters reach the echo.
    const windows=!j.host&&process.platform==='win32',name=String(j.name).replace(/[^\w .()+-]/g,'').slice(0,80),head=windows?`Write-Host '[opaya] Updating ${name}'; `:`echo '[opaya] Updating ${name}'; `;
    return runUpdate({host:j.host,label:'Updates',key:'updates',command:head+j.command});
  }
  async function runMachine(list){
    const host=list[0].host,out=[];
    for(const j of list){let r;try{r=await runJob(j);}catch(e){r={error:safeError(e)};}out.push({...j,...r});}
    versions.cache.clear();let report=null;try{report=await checkMachine(host);emit();}catch{}
    const fresh=report&&!report.error?report.items||[]:null;
    return out.map(x=>{
      const ran=updates.report(x.output),after=x.tool&&fresh?fresh.find(i=>i.id===x.tool)||(x.before?{missing:true}:null):null;
      const v=updates.verdict({name:x.name,code:x.code,error:x.error,item:after,ran});
      return {...x,...v,how:ran.label||x.how,path:after?.path||ran.path||x.path,installed:x.before?.installed||ran.before||'',after:after?.installed||ran.after||'',latest:after?.latest||x.before?.latest||'',machine:host?host.name:machineName(),machineId:host?.id||''};
    });
  }
  async function runBatch(jobs){
    const groups=new Map();for(const j of jobs){const k=machineKey(j.host);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(j);}
    const results=(await Promise.all([...groups.values()].map(list=>onMachine(list[0].host,()=>runMachine(list))))).flat();
    const failed=results.filter(r=>!r.ok),done=results.filter(r=>r.ok);
    if(done.length&&!failed.length)notice({level:'done',kind:'updated',title:`${done.length===1?`${done[0].name} is`:`${done.length} updates are`} done`,text:done.map(r=>`${r.name}${r.after?` ${r.after}`:''} on ${r.machine}`).join(', ')});
    if(failed.length){const run=handoffs.then(()=>finishUpdates(failed,done));handoffs=run.catch(()=>{});}
    return results;
  }
  // The Opaya Agent finishes what failed; the terminal output it gets has every secret hidden.
  async function finishUpdates(failed,done){
    if(stopping)return;
    const o=opaya,n=failed.length,title=`${n} update${n===1?'':'s'} did not finish`;
    const held=o?.heldValues?.()||[],items=failed.map(f=>({...f,output:secrets.shieldOutput(updates.tail(f.output),held)}));
    const list=failed.map(f=>`${f.name} on ${f.machine}: ${f.reason}`).join('\n')+(done.length?`\n\nDone: ${done.map(r=>r.name).join(', ')}.`:'');
    const prompt=updates.handoffPrompt(items);
    if(broker.data.settings?.autoFix===false){notice({level:'error',kind:'update-failed',title,text:`${list}\n\nAutomatic fixing is off in Settings, so the Opaya Agent did not take over.`,...(o?.configured()?{prompt}:{})});return;}
    if(!o?.configured()){notice({level:'error',kind:'update-failed',title,text:`${list}\n\nConnect a model for the Opaya Agent and it finishes updates that fail.`});return;}
    let detail;
    try{
      if(!await idle(o,5*60*1000))throw new Error('it stayed busy with another request');
      o.begin(prompt);
      notice({level:'info',kind:'opaya',title:`The Opaya Agent is finishing ${n} update${n===1?'':'s'}`,text:failed.map(f=>`${f.name} on ${f.machine}`).join(', ')});
      await idle(o,30*60*1000);
      if(!o.error)return;
      detail=`The Opaya Agent could not finish them: ${o.error}`;
    }catch(e){detail=`The Opaya Agent could not take them: ${safeError(e)}`;}
    notice({level:'error',kind:'update-failed',title,text:`${list}\n\n${detail}`,prompt});
  }
  // An agent's installation as an update job; containers are checked by their exit code only.
  function agentJob(a,c){const host=hostOf(a),k=maintenance.kindOf(a),tool=k.kind==='docker'||k.kind==='npx'?'':c.tool||'';return {host,tool,name:tool?updates.SPECS[tool]?.name||a.name:`${a.name} (${k.label})`,command:c.command,before:tool?toolItem(host,tool):null,how:tool?toolItem(host,tool)?.how||'':k.label,plan:c.summary};}
  // An agent installed as a Docker container on a machine: the script runs in a visible terminal (pull, start, install,
  // then an interactive sign-in), and when it ends Opaya adds the container as an agent and connects it.
  async function installContainer(host,x){
    if(!host)throw new Error('Docker installs are for machines added in Machines. On this computer use the regular install.');
    const p=containers.plan(String(x.id||''),{name:x.name});
    if(broker.data.agents.some(a=>a.hostId===host.id&&a.command==='docker'&&a.args?.includes(p.container)))throw new Error(`${host.name} already has an agent in container ${p.container}. Choose another name.`);
    if(!await approve({name:'Opaya'},`Install ${p.framework.name} in a Docker container on ${host.name}?`,`Container ${p.container} (${p.image}), data in ${p.folder}. It restarts with the machine. Afterwards you sign in, and Opaya adds it as an agent${p.importToken?' and imports its gateway token into the vault':''}.\n\nRuns in a visible terminal:\n\n${p.preview}`))throw new Error('Install cancelled.');
    return startJob({kind:'install',route:{from:p.framework.name,fromWhere:`Docker / ${p.image}`,to:p.container,toWhere:host.name,toHostId:host.id,provider:p.connection.provider==='custom'?'custom':p.connection.provider},title:`Installing ${p.framework.name} in Docker`,detail:`${host.name} / container ${p.container}`,
      steps:[['install','Start the container and install'],['signin','Sign in (in the terminal)'],['save','Add to Opaya'],['connect','Connect']]},async progress=>{
      progress({step:'install',state:'active',message:`Running on ${host.name}. Follow it in the terminal below; the first download can take a few minutes.`});
      const view=await runInTerminal({label:`Install ${p.framework.name} (Docker)`,key:`docker_${p.container}`.slice(0,60),host,command:`${p.command}; echo "[opaya] finished with exit code $?"`,where:{host,container:p.container}});
      progress({step:'install',state:'done',message:'Installing. When it is done, sign in in the terminal.'});progress({step:'signin',state:'active',message:'Waiting for the sign-in in the terminal to finish'});
      const code=await waitForMark(view.id,markCount(view.id),60*60*1000);
      if(code!==0)throw new Error(containers.EXIT[code]||`The install ended with exit code ${code}. See the terminal.`);
      progress({step:'signin',state:'done',message:'Done in the terminal'});
      progress({step:'save',state:'active',message:'Adding the agent to Opaya'});
      // OpenClaw: its gateway token is imported from the container (the user approved that with the install).
      const agent=await broker.saveAgent({agent:{...p.connection,name:String(x.name||'').trim()?`${String(x.name).trim().slice(0,60)}`:p.connection.name,hostId:host.id},importToken:!!p.importToken},{preapproved:!!p.importToken});
      progress({step:'save',state:'done',message:`Added ${agent.name}`});
      progress({step:'connect',state:'active',message:`Connecting ${agent.name}`});
      try{await broker.connect(agent.id);progress({step:'connect',state:'done',message:'Connected'});}
      catch(e){progress({step:'connect',state:'warn',message:`Added, but it did not connect yet: ${safeError(e)}. If you skipped the sign-in, use Run native CLI to sign in, then Connect.`});}
      versions.cache.clear();checkMachine(host).then(emit).catch(()=>{});
      return {agent:{id:agent.id,name:agent.name}};
    });
  }
  // ---- Remote agents on local projects: each agent gets its own copy where it runs, changes move both ways ---------
  const bringResults=new Map(); // `${projectId}:${agentId}` -> last review (ref and base), for Apply / Merge / Branch
  // The local project, the agent's copy of it, and where that copy is (machine and container).
  function shared(x){
    const p=broker.project(x.id);if(p.hostId)throw new Error('Choose a project on this computer.');
    const agent=broker.agent(x.agentId),r=projects.remoteOf(agent,p);if(!r)throw new Error(`${agent.name} does not have a copy of ${p.name}. Share the project with it first.`);
    const host=agent.transport==='ssh'?broker.host(agent.hostId):null;
    return {p,agent,r,host,container:r.container,at:r.container?`${agent.name} (${r.container}${host?` on ${host.name}`:''})`:`${agent.name} on ${host?host.name:machineName()}`};
  }
  const placeOf=agent=>{const i=agent.command==='docker'?dockerExecContainerIndex(agent.args||[]):-1;return {host:agent.transport==='ssh'?broker.host(agent.hostId):null,container:i>=0?agent.args[i]:''};};
  async function saveRemote(p,agentId,patch){const fresh=broker.project(p.id);return broker.saveProject({...fresh,remotes:fresh.remotes.map(r=>r.agentId===agentId?{...r,...patch}:r)});}
  const remoteSteps={git:[['prepare','Prepare the copy'],['send','Send your branch']],github:[['push','Push your branch to GitHub'],['prepare','Get it from GitHub']],copy:[['send','Copy the folder']]};
  const projectRemoteActions={
    projectRemoteInfo:async x=>{const p=broker.project(x.id);if(p.hostId)throw new Error('Choose a project on this computer.');return remoteWork.inspect(p.path);},
    // Share a local project with one remote agent: it gets its own copy where it runs, and joins the project.
    projectRemoteStart:async x=>{
      const p=broker.project(x.id),agent=broker.agent(x.agentId),mode=String(x.mode||'');if(p.hostId)throw new Error('Choose a project on this computer.');
      if(!remoteSteps[mode])throw new Error('Choose how the project gets there.');
      if(projects.remoteOf(agent,p))throw new Error(`${agent.name} already has a copy of ${p.name}. Use Send my changes instead.`);
      if(!projects.needsCopy(agent,p))throw new Error(agent.protocol==='openai'||agent.transport==='http'?`${agent.name} is an API connection with no files; it cannot work in a folder.`:`${agent.name} runs on this computer and can use ${p.name} directly.`);
      const {host,container}=placeOf(agent);
      if(mode==='github'&&container)throw new Error('Agents in a container get the project with Git over SSH or a plain copy.');
      const info=await remoteWork.inspect(p.path);
      if(mode!=='copy'&&!info.git)throw new Error(`${p.name} is not a git repository. Use a plain copy, or run git init in it first.`);
      if(mode==='github'&&!info.github)throw new Error(`${p.name} has no GitHub remote (origin).`);
      if(mode!=='copy'&&!info.branch)throw new Error('Check out a branch first (you are on a detached commit).');
      const branch=`opaya/${remoteWork.slug(agent.name)}`,where=container?`${container}${host?` on ${host.name}`:''}`:host?host.name:machineName();
      return startJob({kind:'project-remote',route:{from:p.name,fromWhere:machineName(),to:agent.name,toWhere:where,toHostId:host?.id||'',hostId:host?.id||'',agentId:agent.id,provider:agent.provider||'custom'},title:`Sharing ${p.name} with ${agent.name}`,detail:mode==='git'?`Git over SSH / branch ${branch}`:mode==='github'?`Through GitHub / branch ${branch}`:'Plain copy',steps:[['check',container?'Find the container\'s data folder':'Find a place for the copy'],...remoteSteps[mode],['save',`Add ${agent.name} to the project`]]},async progress=>{
        progress({step:'check',state:'active',message:`Looking on ${where}`});
        const dir=await remoteWork.placement({host,container,project:p.name,agent:agent.name});
        progress({step:'check',state:'done',message:dir});
        let sent={};
        if(mode==='git')sent=await remoteWork.sendGit({folder:p.path,host,container,dir,branch,includeChanges:!!x.includeChanges,first:true,progress});
        else if(mode==='github')sent=await remoteWork.sendGithub({folder:p.path,host,dir,branch,base:info.branch,origin:info.origin,first:true,progress});
        else sent=await remoteWork.sendCopy({folder:p.path,host,container,dir,progress});
        progress({step:'save',state:'active',message:'Adding the agent'});
        const fresh=broker.project(p.id);
        await broker.saveProject({...fresh,remotes:[...fresh.remotes.filter(r=>r.agentId!==agent.id),{agentId:agent.id,hostId:host?.id||'',container,dir,mode,branch:mode==='copy'?'':branch,base:info.branch,origin:info.origin,lastSent:sent.commit||'',sentAt:new Date().toISOString()}]});
        progress({step:'save',state:'done',message:`${agent.name} works in ${dir}`});
        return {projectId:p.id,agentId:agent.id,dir,branch:mode==='copy'?'':branch,includedChanges:!!sent.included};
      });
    },
    projectRemoteSend:async x=>{
      const {p,agent,r,host,container,at}=shared(x);
      return startJob({kind:'project-remote',route:{from:p.name,fromWhere:machineName(),to:agent.name,toWhere:at,hostId:host?.id||'',agentId:agent.id,provider:agent.provider||'custom'},title:`Sending your changes to ${agent.name}`,detail:r.mode==='copy'?'Plain copy':`Branch ${r.branch}`,steps:r.mode==='github'?remoteSteps.github:r.mode==='git'?[['prepare','Check the copy'],['send','Send your branch']]:remoteSteps.copy},async progress=>{
        let sent={};
        if(r.mode==='git')sent=await remoteWork.sendGit({folder:p.path,host,container,dir:r.dir,branch:r.branch,includeChanges:!!x.includeChanges,first:false,lease:r.lastFetched,progress});
        else if(r.mode==='github')sent=await remoteWork.sendGithub({folder:p.path,host,dir:r.dir,branch:r.branch,base:(await remoteWork.inspect(p.path)).branch||r.base,origin:r.origin,first:false,progress});
        else sent=await remoteWork.sendCopy({folder:p.path,host,container,dir:r.dir,progress});
        await saveRemote(p,agent.id,{lastSent:sent.commit||r.lastSent,sentAt:new Date().toISOString()});
        return {sent:true,projectId:p.id,agentId:agent.id};
      });
    },
    projectRemoteBring:async x=>{
      const {p,agent,r,host,container,at}=shared(x);
      const steps=r.mode==='git'?[['save','Save the agent\'s changes'],['fetch','Fetch them']]:r.mode==='github'?[['save','Save the agent\'s changes'],['push','Push to GitHub'],['fetch','Fetch them']]:[['fetch','Copy the folder back'],['apply','Update your folder']];
      return startJob({kind:'project-bring',route:{from:agent.name,fromWhere:at,to:p.name,toWhere:machineName(),hostId:host?.id||'',agentId:agent.id,provider:agent.provider||'custom'},title:`Bringing changes from ${agent.name}`,detail:r.mode==='copy'?'Plain copy':`Branch ${r.branch}`,steps},async progress=>{
        const args={folder:p.path,host,container,dir:r.dir,branch:r.branch,agentName:agent.name,base:r.lastSent,progress};
        const result=r.mode==='git'?await remoteWork.bringBackGit(args):r.mode==='github'?await remoteWork.bringBackGithub(args):await remoteWork.bringBackCopy({...args,backupRoot:maintenance.backupDir(broker.data.settings),name:p.name});
        if(result.ref){bringResults.set(`${p.id}:${agent.id}`,{ref:result.ref,base:result.base});await saveRemote(p,agent.id,{lastFetched:result.tip,fetchedAt:new Date().toISOString()});}
        return {projectId:p.id,agentId:agent.id,agentName:agent.name,mode:r.mode,...result};
      });
    },
    // After reviewing: apply the agent's changes to your folder, merge its commits, put them on a branch, or show the diff.
    projectRemoteApply:async x=>{
      const {p,agent}=shared(x),last=bringResults.get(`${p.id}:${agent.id}`);if(!last)throw new Error('Bring the changes back first.');
      const windows=process.platform==='win32',patchFile=path.join(require('node:os').tmpdir(),`opaya-${p.id.slice(0,8)}-${agent.id.slice(0,8)}.patch`);
      const cmds=remoteWork.applyCommands(last,String(x.action||''),{branch:x.branch,patchFile,windows});
      const command=windows?`Set-Location -LiteralPath '${p.path.replace(/'/g,"''")}'; ${cmds.map((c,i)=>i?`if ($?) { ${c} }`:c).join('; ')}`:`cd -- ${require('./process.cjs').quote(p.path)} && ${cmds.join(' && ')}`;
      return runInTerminal({label:`${p.name} / changes from ${agent.name}`,key:`bring_${p.id.slice(0,20)}_${agent.id.slice(0,20)}`,host:null,command});
    },
    // Stop sharing with an agent: it leaves the project; its copy is kept unless you ask to delete it.
    projectRemoteStop:async x=>{
      const {p,agent,r,host,container,at}=shared(x);
      if(x.deleteCopy){
        const ok=await approve({name:'Opaya'},`Delete ${agent.name}'s copy of ${p.name}?`,`${r.dir} on ${at} is deleted, with anything the agent did not bring back. Your folder is not touched.`);
        if(!ok)return {stopped:false};
        await remoteWork.removeCopy({host,container,dir:r.dir});
      }
      const fresh=broker.project(p.id);bringResults.delete(`${p.id}:${agent.id}`);
      await broker.saveProject({...fresh,agentIds:fresh.agentIds.filter(id=>id!==agent.id),remotes:fresh.remotes.filter(q=>q.agentId!==agent.id)});
      return {stopped:true,deleted:!!x.deleteCopy};
    },
    projectRemoteGithubLogin:async x=>{const host=broker.host(x.hostId);return runInTerminal({label:`GitHub sign-in on ${host.name}`,key:`ghlogin_${host.id}`,host,command:"command -v gh >/dev/null 2>&1 || { echo 'GitHub CLI is not installed here. Install it: Install agents > this machine > GitHub CLI.'; exit 1; }; gh auth login && gh auth setup-git && echo 'Signed in. Go back to Opaya and try again.'"});}
  };
  // ---- Built-in installer: Node.js with npm, Python, uv, GitHub CLI and Git, from their official downloads ------------
  // Used for this computer instead of winget, Homebrew or apt scripts, which fresh computers often cannot run.
  const builtinHere=id=>toolchain.supports(id)&&(id!=='git'||process.platform!=='linux');
  const builtinIds=id=>id==='essentials'?['node','python','git','uv'].filter(builtinHere):builtinHere(id)?[id]:[];
  async function missingOf(ids){versions.cache.clear();await require('./process.cjs').primeShellPath();const have=await versions.installed(null).catch(()=>({}));return ids.filter(id=>!Object.hasOwn(have,id)||id==='node'&&!Object.hasOwn(have,'npm'));}
  async function builtinStep(id,progress,step=id){
    progress({step,state:'active',message:`Installing ${toolchain.NAMES[id]} (official download, no administrator password)`});
    const r=await toolchain.install(id,{progress:e=>progress({step,...e})});
    versions.cache.clear();emit();progress({step,state:'done',message:`${toolchain.NAMES[id]} ${r.version}`});return r;
  }
  // Starts a job and returns it at once; done resolves when it finishes (for the Opaya Agent, which waits for it).
  // update: download the latest even when it is installed (Opaya's own copy of it is out of date).
  function builtinJob(ids,{update=false}={}){
    let finish;const done=new Promise(r=>{finish=r;});
    const job=startJob({kind:'toolchain',route:{from:'Official downloads',fromWhere:'nodejs.org / GitHub',to:ids.map(id=>toolchain.NAMES[id]).join(', '),toWhere:machineName(),provider:'opaya'},title:`Installing ${ids.map(id=>toolchain.NAMES[id].replace(/ \(.*\)$/,'')).join(', ')}`,detail:'Checked against the official checksums; no administrator password',steps:ids.map(id=>[id,toolchain.NAMES[id]])},async progress=>{
      const missing=update?ids:await missingOf(ids),out={};
      try{for(const id of ids){if(!missing.includes(id)){progress({step:id,state:'done',message:'Already installed'});continue;}out[id]=(await builtinStep(id,progress)).version;}finish({installed:out});return {installed:out};}
      catch(e){finish({error:safeError(e),installed:out});throw e;}
    });
    return {job,done};
  }
  // ---- Setup guide: plain scripts that get this computer ready, model first, then the Opaya Agent finishes ----------
  const windowsHere=process.platform==='win32';
  async function guideFacts(){await require('./process.cjs').primeShellPath();return {...guide.describe({installed:await versions.installed(null).catch(()=>({}))}),machine:machineName(),brain:opaya.configured()?opaya.config.preset:''};}
  // Run one marked command in the setup terminal and wait for its end line. Password and question prompts are passed
  // on to the guide so it can tell the person what to do.
  async function setupRun(step,command,progress,{timeout=45*60*1000}={}){
    const view=await runInTerminal({owner:'opaya',label:'Opaya setup',key:'setup',host:null,command:guide.marked(step.id,guide.withPath(command,{windows:windowsHere}),{windows:windowsHere})});
    const end=Date.now()+timeout;let hinted='';
    for(;;){
      await new Promise(r=>setTimeout(r,1200));
      let v;try{v=terminals.attach(view.id);}catch{throw new Error('The setup terminal was closed.');}
      const code=guide.markOf(v.buffer,step.id);if(code!==null)return code;
      if(v.exited)throw new Error('The setup terminal ended.');
      const p=require('./opaya-agent.cjs').promptState(v.buffer),hint=p.password?'password':p.question?'question':'';
      if(hint&&hint!==hinted){progress({step:step.id,state:'warn',message:hint==='password'?'The terminal below asks for your computer password (the one you log in with). Click into it, type it (it stays invisible) and press Enter.':'The terminal below asks a question. Usually pressing Enter picks the safe default.'});}
      hinted=hint;
      if(Date.now()>end)throw new Error(`${step.title} did not finish within ${Math.round(timeout/60000)} minutes.`);
    }
  }
  async function guideInstall(step,progress){
    if(builtinHere(step.tool)){
      for(let attempt=1;attempt<=2;attempt++){
        try{await builtinStep(step.tool,progress,step.id);return true;}
        catch(e){progress({step:step.id,state:attempt===1?'warn':'error',message:attempt===1?`${safeError(e)} Trying once more.`:`${step.title} did not work: ${safeError(e)}`});}
      }
      return false;
    }
    const {command}=catalog.command(step.tool,{remote:false});
    for(let attempt=1;attempt<=2;attempt++){
      progress({step:step.id,state:'active',message:attempt===1?`${step.title}: ${step.why}`:'That did not work; trying once more.'});
      await setupRun({...step,id:`${step.id}-${attempt}`},command,progress);
      versions.cache.clear();const now=await versions.installed(null).catch(()=>({}));
      if(Object.hasOwn(now,step.tool)){progress({step:step.id,state:'done',message:`${guide.TOOL_NAMES[step.tool]} ${String(now[step.tool]).slice(0,40)}`});return true;}
    }
    progress({step:step.id,state:'error',message:`${step.title} did not work. The terminal below shows why.`});return false;
  }
  async function guideSignIn(step,progress){
    const a=guide.AGENTS[step.tool];progress({step:step.id,state:'active',message:a.signInNote});
    // Its own terminal: an interactive sign-in (Claude Code opens its app) must not catch the next setup commands.
    const view=await runInTerminal({owner:'opaya',label:`Sign in to ${guide.TOOL_NAMES[step.tool]}`,key:`signin_${step.tool}`,host:null,command:guide.withPath(windowsHere?a.signIn.windows:a.signIn.posix,{windows:windowsHere})});
    const end=Date.now()+30*60*1000;
    while(!guide.signedIn(step.tool)){if(Date.now()>end)throw new Error(`Sign-in to ${guide.TOOL_NAMES[step.tool]} did not finish within 30 minutes. Start the guide again when you are ready.`);await new Promise(r=>setTimeout(r,2500));}
    progress({step:step.id,state:'done',message:'Signed in'});
    setTimeout(()=>{try{terminals.close(view.id);emit();}catch{}},4000);
  }
  async function guideBrain(step,progress){
    progress({step:step.id,state:'active',message:`Connecting the Opaya Agent to ${guide.TOOL_NAMES[step.tool]}`});
    let last;
    for(let i=0;i<4;i++){try{const r=await opaya.test({preset:step.tool});await opaya.saveConfig({preset:step.tool,model:''});progress({step:step.id,state:'done',message:r.message});return true;}catch(e){last=e;await new Promise(r=>setTimeout(r,4000));}}
    progress({step:step.id,state:'error',message:safeError(last)});return false;
  }
  async function guideAdd(step,progress){
    progress({step:step.id,state:'active',message:'Looking for agents on this computer'});
    const found=await broker.discover({}).catch(()=>({agents:[]}));let added=[];
    for(const c of found.agents||[]){
      if(c.existingId||!['codex','claude'].includes(c.provider)&&!/^opencode$/.test(String(c.command||'').split(/[\\/]/).pop().replace(/\.(exe|cmd)$/i,'')))continue;
      const {existingId,detail,readiness,...agent}=c;try{const saved=await broker.saveAgent({agent},{preapproved:true});added.push(saved.name);}catch{}
    }
    progress({step:step.id,state:'done',message:added.length?`Added ${added.join(', ')}`:'Your agents are already in Opaya'});return added;
  }
  // Keep the Opaya Agent from asking again for each install while it finishes the setup, when the person chose that.
  // Its own name: a second `function handOff` in this scope replaced the error hand-off above for every caller.
  function guideHandOff(text,trust){
    if(trust)setupTrust=true;opaya.begin(text);
    const watch=setInterval(()=>{if(!opaya.busy){setupTrust=false;clearInterval(watch);}},2000);watch.unref?.();
  }
  const guideActions={
    guideScan:async()=>guideFacts(),
    guidePlan:async x=>{const facts=await guideFacts();return {facts,steps:guide.plan({way:String(x.way||''),goals:[].concat(x.goals||[]),agents:[].concat(x.agents||[]),facts})};},
    guideStart:async x=>{
      const facts=await guideFacts(),way=String(x.way||''),goals=[].concat(x.goals||[]).map(String),agents=[].concat(x.agents||[]).map(String);
      let steps=guide.plan({way,goals,agents,facts});
      const brainReady=()=>opaya.configured();
      if(x.scriptOnly)steps=steps.filter(s=>s.phase==='rest');
      const commands=steps.filter(s=>s.kind==='install').map(s=>`${guide.TOOL_NAMES[s.tool]}:\n${catalog.command(s.tool,{remote:false}).command}`);
      if(!await approve({name:'Opaya'},'Set up this computer?',`${steps.map((s,i)=>`${i+1}. ${s.title}`).join('\n')}\n\nEverything runs in the "Opaya setup" terminal, where you can watch it.${commands.length?`\n\nCommands:\n\n${commands.join('\n\n')}`:''}`))throw new Error('Setup cancelled.');
      if(process.platform==='win32')await toolchain.persistPath().catch(()=>{});
      return startJob({kind:'guide',route:{from:'Setup guide',fromWhere:facts.system,to:'Ready to build',toWhere:machineName(),provider:'opaya'},title:'Setting up this computer',detail:[WAYS_LABEL(way),...goals.map(g=>guide.GOALS[g]?.label)].filter(Boolean).join(' / '),steps:steps.map(s=>[s.id,s.title])},async progress=>{
        const failed=[];
        for(const step of steps.filter(s=>s.phase==='model')){
          if(step.kind==='install'&&!await guideInstall(step,progress))throw new Error(`${step.title} did not work, so the AI part cannot start yet. Look at the "Opaya setup" terminal, then press Try again.`);
          if(step.kind==='signin')await guideSignIn(step,progress);
          if(step.kind==='brain'&&!await guideBrain(step,progress))throw new Error('The Opaya Agent could not use it yet. Make sure you finished signing in, then press Try again.');
        }
        const rest=steps.filter(s=>s.phase==='rest');
        // With a model, the Opaya Agent finishes: it installs the rest, checks and fixes what went wrong.
        if(brainReady()&&!x.scriptOnly){
          progress({message:'The Opaya Agent takes it from here: watch it in the Opaya Agent chat.'});
          guideHandOff(guide.handoff({steps,facts,goals}),x.trust!==false);
          return {handoff:true,way,steps:rest.map(s=>s.id)};
        }
        for(const step of rest){
          if(step.kind==='install'&&!await guideInstall(step,progress))failed.push(step.title.replace(/^Install /,''));
          if(step.kind==='add')await guideAdd(step,progress);
        }
        if(failed.length)throw new Error(`Almost done: ${failed.join(', ')} did not install. The "Opaya setup" terminal shows why. Connect a model for the Opaya Agent and it can fix this for you.`);
        return {handoff:false,way,ready:true};
      });
    }
  };
  const WAYS_LABEL=way=>guide.WAYS[way]?.label||'';
  const toolActions={
    toolVersions:async x=>{const host=x.hostId?broker.host(x.hostId):null,m=toolState.machines[machineKey(host)];if(!x.force&&m?.checkedAt&&Date.now()-Date.parse(m.checkedAt)<10*60*1000)return m;const r=await checkMachine(host);emit();return r;},
    toolCheckAll:async()=>{versions.cache.clear();await checkAll({notify:false});return toolState;},
    // Update one tool (agent or dependency) on a machine, the ones the user ticked (ids), or every outdated one: one
    // approval, one batch, one hand-off to the Opaya Agent for whatever failed or did not take effect.
    toolUpdate:async x=>{
      const host=x.hostId?broker.host(x.hostId):null,where=host?host.name:machineName();
      const ids=Array.isArray(x.ids)?x.ids.map(String):x.id==='outdated'?(toolState.machines[machineKey(host)]?.items||[]).filter(i=>i.outdated).map(i=>i.id):[String(x.id||'')];
      const jobs=[...new Set(ids)].slice(0,40).map(id=>{try{return toolJob(host,id,catalog.command(id,{remote:!!host,update:true}));}catch{return null;}}).filter(Boolean);
      if(!jobs.length)throw new Error('Nothing to update here.');
      const lines=jobs.map(j=>`${j.name} (${j.how||'detected when it runs'}): ${j.builtin?"Opaya's built-in installer":j.plan}`).join('\n');
      if(!await approve({name:'Opaya'},jobs.length===1?`Update ${jobs[0].name} on ${where}?`:`Install ${jobs.length} updates on ${where}?`,`${lines}\n\nEach update finds how the tool is installed and updates that copy, one after another in the "Updates" terminal. Opaya checks the versions afterwards; whatever fails or does not take effect goes to the Opaya Agent to finish.`))throw new Error('Update cancelled.');
      runBatch(jobs).catch(()=>{});
      return jobs.length;
    }
  };
  opaya = new OpayaAgent({root,vault:broker.vault,broker,terminals,approve,emit,runInTerminal:x=>runInTerminal({...x,owner:'opaya'}),trusted:()=>!!broker.data.settings?.itrustOpaya||setupTrust});
  opaya.askSecret = askSecret;
  // Claude Code as the Opaya Agent's model reaches the Opaya tools through this bridge; its token can only list and call them.
  opaya.builtinInstall = async (id,{update=false}={})=>{const ids=builtinIds(id);if(!ids.length)return null;const {job,done}=builtinJob(ids,{update});const r=await done;return {job_id:job.id,...r};};
  opaya.toolBridge = {command:process.execPath, args:[path.join(__dirname,'opaya-tools-mcp.cjs')], env:{ELECTRON_RUN_AS_NODE:'1',OPAYA_TOOLS_ENDPOINT:endpoint(root),OPAYA_TOOLS_TOKEN:toolsToken}};
  await stage('opaya agent');
  await opaya.init();
  // A fresh install: connect the Opaya Agent to a local Ollama model with tools if one already runs (no input needed).
  free.autoConnect({opaya}).then(model=>{if(model)emit();}).catch(()=>{});
  broker.onReply=(a,c,m)=>{if(a)listener?.broadcast('reply',{agentId:a.id,agentName:a.displayName||a.name,conversationId:c.id,status:m.status,text:String(m.status==='error'?m.error:m.content||'').replace(/\s+/g,' ').trim().slice(0,220)});};
  // "Connect agents when Opaya starts": after a reboot the service starts fresh, so connect them once, quietly.
  if(broker.data.settings?.autoConnect)setTimeout(()=>{for(const a of broker.data.agents)if(a.protocol!=='terminal')broker.connect(a.id).catch(()=>{});},1500).unref?.();
  async function shutdown() {
    if (stopping) return true; stopping = true; for (const w of webs.values()) w.tunnel?.close();
    for (const a of approvals.values()) a.finish(false);
    codexLogins?.close(); await terminals.shutdown(); await opaya?.close?.(); await broker.close();
    await fs.rm(descriptor,{force:true});
    setTimeout(()=>app.exit(0),100).unref(); return true;
  }
  const actions = {
    agentModels:x=>broker.models(schema.id(x.id)),selectModel:x=>broker.selectModel(x),gateway:x=>broker.gateway(x),
    // Reasoning effort under the chat, and what a picked or dropped file is ([{path,name,size,mime}]) before it is attached.
    selectEffort:x=>broker.selectEffort(x), fileInfo:x=>require('./attachments.cjs').inspect(x?.paths),
    // The address the browser ended on after a Codex sign-in, for a sign-in Opaya could not finish by itself. Without a
    // waiting sign-in, the agent or terminal says where Codex runs.
    codexLoginFinish:async x=>{
      let where=null;
      if(x.terminalId){try{where=terminalWhere(terminals.attach(String(x.terminalId)));}catch{}}
      else if(x.agentId){const a=broker.agent(schema.id(x.agentId));where=require('./clone.cjs').place({agent:a,host:a.transport==='ssh'?broker.host(a.hostId):null});}
      else if(x.hostId)where={host:broker.host(schema.id(x.hostId)),container:String(x.container||'')};
      if(where&&!where.host&&!where.container)where=null;
      return codexLogins.finish({text:String(x.url||''),where,name:where?codexPlace(where):''});
    },
    codexLogins:()=>codexLogins.list(),
    snapshot, saveAgent:x=>broker.saveAgent(x), reorderAgents:x=>broker.reorderAgents(x), updateAgentDisplay:x=>broker.updateAgentDisplay(x), saveHost:x=>broker.saveHost(x), removeHost:x=>broker.removeHost(x.id),
    removeAgent:async x=>{const a=broker.agent(x.id); if(!await approve(a,'Remove this agent connection?','Deletes its saved connection and local chat transcripts, not the agent installation.'))return false;terminals.closeAgent(a.id);await broker.removeAgent(a.id);return true;},
    discover:x=>broker.discover(x), connect:x=>broker.connect(x.id), disconnect:x=>broker.disconnect(x.id), clearError:x=>broker.clearError(x.id),
    select:x=>broker.select(x.id), newConversation:x=>broker.newConversation(x.agentId,x.projectId||'',{activate:x.activate!==false}), selectConversation:x=>broker.selectConversation(x.id),
    send:x=>broker.send(x), stop:x=>broker.stop(x.id), saveDraft:x=>broker.saveDraft(x), saveView:x=>broker.saveView(x),
    transcript:async x=>{const c=broker.data.conversations.find(c=>c.id===schema.id(x.id));if(!c)throw new Error('Conversation not found.');return {conversation:c,agent:broker.agent(c.agentId),messages:broker.histories.get(c.id)||await broker.store.transcript(c.id)};},
    terminalOpen:async x=>{
      const source=x.sourceId?terminals.attach(schema.id(x.sourceId)):null;
      const a=source?sessionAgent(source):x.local===true?localShell():x.agentId?broker.agent(x.agentId):hostShell(x.hostId);
      const mode=source?.mode||x.mode||'shell';
      // A project: the agent's CLI (or a shell) starts in the project's folder on the machine where it runs.
      let cwd=source?.cwd||'',title='';
      if(x.projectId&&!source){
        const p=broker.project(x.projectId);
        if(x.agentId&&!x.local){cwd=projects.folderFor(a,p);if(!cwd)throw new Error(`${a.name} runs on a different machine than ${p.name}.`);}
        else{if((p.hostId||'')!==(x.local===true?'':String(x.hostId||'')))throw new Error(`${p.name} is on another machine.`);cwd=p.path;}
        title=`${x.mode==='agent'?a.name:a.name+' shell'} · ${p.name}`.slice(0,80);
      }
      if(mode==='agent'&&a.provider==='hermes'&&(x.newSession===true||!terminals.hasLive(a.id,mode))&&!await approve(a,'Start a new Hermes CLI process?','This does not attach to an existing gateway. Do not run another writer against a Hermes profile already used by a gateway. Use its gateway API or existing tmux session instead.'))throw new Error('CLI launch cancelled.');
      const result=terminals.open(a,a.transport==='ssh'?broker.host(a.hostId):null,mode,{cols:x.cols||100,rows:x.rows||28},{cwd,title,newSession:x.newSession===true});emit();return result;
    },
    // Enter in an ended terminal starts it again in its tab: the same agent or shell, machine, mode and folder. A remote one
    // reattaches to its tmux session, which usually outlived the dropped SSH connection.
    terminalRestart:async x=>{
      const s=terminals.describe().find(s=>s.id===schema.id(x.id));if(!s)throw new Error('This terminal was closed.');
      if(!s.exited)return terminals.attach(s.id);
      const a=sessionAgent(s);
      if(s.mode==='agent'&&a.provider==='hermes'&&!terminals.hasLive(a.id,s.mode)&&!await approve(a,'Start a new Hermes CLI process?','This does not attach to an existing gateway. Do not run another writer against a Hermes profile already used by a gateway. Use its gateway API or existing tmux session instead.'))throw new Error('CLI launch cancelled.');
      const result=terminals.restart(s.id,a,a.transport==='ssh'?broker.host(a.hostId):null,{cols:x.cols||100,rows:x.rows||28});emit();return result;
    },
    // Files and images pasted or dropped into a terminal: a terminal on this computer types their paths as they are; one on
    // a machine or in a container gets copies there first (~/.opaya/attachments/pasted) and types the copies' paths.
    terminalPaste:async x=>{
      const s=terminals.describe().find(s=>s.id===schema.id(x.id));if(!s)throw new Error('This terminal was closed.');
      if(s.exited)throw new Error('This terminal session has ended. Press Enter in it to start it again.');
      const a=sessionAgent(s);return pasting.place(a,a.transport==='ssh'?broker.host(a.hostId):null,x.paths,{root});
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
    installFramework:async x=>{
      const host=x.hostId?broker.host(x.hostId):null;
      if(x.runtime==='docker')return installContainer(host,x);
      if(!host&&builtinIds(String(x.id||'')).length)return builtinJob(builtinIds(String(x.id))).job;
      const {framework,command}=catalog.command(String(x.id||''),{remote:!!host});
      // The install runs with an exit-code mark; a failed install goes to the Opaya Agent.
      const end=!host&&process.platform==='win32'?'; Write-Host "[opaya] finished with exit code $(if ($?) { 0 } else { 1 })"':'; echo "[opaya] finished with exit code $?"';
      const view=await runInTerminal({label:`Install ${framework.name}`,key:`install_${framework.id}`,host,command:command+end}),before=markCount(view.id);
      waitForMark(view.id,before,60*60*1000,'install').then(code=>{if(code!==0)actionFailed(`Install ${framework.name} on ${host?host.name:machineName()}`,`The install ended with exit code ${code}.`,`It ran in the terminal "Install ${framework.name}" (terminal_id ${view.id}); read it with read_terminal. Last output: ${markedOutput(view.id,before).slice(-1500)}`);}).catch(()=>{});
      return view;
    },
    files:async x=>{
      let host=null,folder=typeof x.path==='string'?x.path:'',fallback=false;
      if(x.agentId){const a=broker.agent(x.agentId);if(a.transport==='ssh')host=broker.host(a.hostId);if(!folder){folder=a.cwd||a.hermesHome||'';fallback=!!folder;}}
      else if(x.hostId)host=broker.host(x.hostId);
      try{return await files.browse({op:x.op,path:folder,host});}
      // An agent folder inside a container may not exist on the host; fall back to the home folder.
      catch(error){if(fallback&&x.op!=='read')return files.browse({op:x.op,path:'',host});throw error;}
    },
    // A file an agent made or mentioned, read where the agent runs (this computer, a machine, a container), so its
    // chat can show it as an attachment: size first (stat), the bytes when shown, opened or saved (up to 25 MB).
    agentFile:async x=>{
      const a=x.agentId==='opaya'?{transport:'local',command:'',args:[]}:broker.agent(x.agentId),p=String(x.path||'').trim();if(!p||p.length>2048||/[\0\n]/.test(p))throw new Error('Invalid path.');
      const clone=require('./clone.cjs'),where=clone.place({agent:a,host:a.transport==='ssh'?broker.host(a.hostId):null}),stat=x.op==='stat';
      if(clone.isLocal(where)){const fsx=require('node:fs/promises'),file=path.resolve(p.replace(/^~(?=$|[\\/])/,require('node:os').homedir()));const st=await fsx.stat(file).catch(()=>null);if(!st?.isFile())return {exists:false};
        if(stat)return {exists:true,size:st.size,path:file};if(st.size>25*1024*1024)throw new Error('The file is larger than 25 MB.');return {exists:true,size:st.size,path:file,data:(await fsx.readFile(file)).toString('base64')};}
      const q=require('./process.cjs').quote,f=p.startsWith('~/')?`"$HOME"/${q(p.slice(2))}`:q(p);
      const out=await require('./process.cjs').collect(clone.shell(where,`f=${f}; if [ -f "$f" ]; then s=$(wc -c < "$f" | tr -d ' '); echo "SIZE $s"; ${stat?'':'if [ "$s" -le 26214400 ]; then base64 < "$f" | tr -d "\\n"; fi;'} else echo MISSING; fi`),{timeout:stat?15000:120000,maxBytes:36*1024*1024});
      const text=String(out||'');if(/^MISSING/.test(text))return {exists:false};const m=/^SIZE (\d+)\n?([\s\S]*)$/.exec(text);if(!m)return {exists:false};
      if(stat)return {exists:true,size:Number(m[1]),path:p};if(Number(m[1])>25*1024*1024)throw new Error('The file is larger than 25 MB.');return {exists:true,size:Number(m[1]),path:p,data:m[2].trim()};
    },
    tokenRemove:async x=>{await broker.removeToken(schema.id(x.id));emit();return true;},
    scheduleSave:async x=>{const r=await broker.saveSchedule(x);emit();return r;},scheduleRemove:async x=>{await broker.removeSchedule(x.id);emit();return true;},
    scheduleRun:async x=>{const s=(broker.data.schedules||[]).find(y=>y.id===x.id);if(!s)throw new Error('Schedule not found.');await runSchedule(s,{manual:true});return true;},
    // What an agent schedules itself (Hermes cron jobs, OpenClaw cron, the crontab where it runs), as text.
    agentSchedules:async x=>{const a=broker.agent(x.id),clone=require('./clone.cjs'),where=clone.place({agent:a,host:a.transport==='ssh'?broker.host(a.hostId):null});
      if(clone.isLocal(where)&&process.platform==='win32')return {text:'Windows keeps scheduled tasks in Task Scheduler. Agents on this computer have no crontab.'};
      try{return {text:String(await require('./process.cjs').collect(clone.shell(where,schedules.nativeListScript(a)),{timeout:30000,maxBytes:256*1024})).slice(0,60000)};}catch(error){return {text:'',error:String(error?.message||error).slice(0,300)};}},
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
    // Docker manager for one machine: containers and images, start/stop/restart/remove, and logs or a shell in a terminal.
    // DeepSeek Harness's own Web UI: started in a visible terminal where the agent runs, reached on this computer
    // directly, through an SSH tunnel, or on the port published from its container; opened in the Opaya browser.
    agentWeb:async x=>{
      const a=broker.agent(x.id);if(maintenance.frameworkOf(a)!=='dsh')throw new Error('Only DeepSeek Harness has a Web UI Opaya can open.');
      const host=hostOf(a),exec=dshWeb.execPrefix(a),old=webs.get(a.id);
      if(old&&await reachable(old.url))return {url:old.url,terminal:old.terminal};
      old?.tunnel?.close();webs.delete(a.id);
      // Where the browser connects: a free port here; for a container, the port published for it on its machine.
      let port=await freePort(),hostPort=0;
      if(exec){
        const out=await collect(require('./process.cjs').launch({transport:host?'ssh':'local',hostId:host?.id||'',command:'docker',args:[],cwd:''},['port',exec.container,String(dshWeb.WEB_PORT)],host),{timeout:20000}).catch(()=>'');
        hostPort=Number(/:(\d+)\s*$/m.exec(String(out))?.[1]||0);
        if(!hostPort)throw new Error(`Container ${exec.container} does not publish port ${dshWeb.WEB_PORT}, so its Web UI cannot be reached. Containers Opaya creates for DeepSeek Harness publish it; recreate this one from Install agents > Docker.`);
        if(!host)port=hostPort;
      }
      const trusted=host?[`127.0.0.1:${port}`,`localhost:${port}`]:exec?[`127.0.0.1:${port}`]:[];
      const view=await runInTerminal({owner:a.id,label:`${a.name} Web UI`.slice(0,60),key:`dshweb_${a.id}`.slice(0,60),host,command:dshWeb.command(a,{port:host&&!exec?0:port,trusted,windows:!host&&process.platform==='win32',unset:host||exec?[]:require('./process.cjs').dshStoreNames(require('./process.cjs').environment()).filter(n=>process.env[n]!==undefined)})});
      let printed='';const end=Date.now()+120000;
      while(!printed&&Date.now()<end){await new Promise(r=>setTimeout(r,500));let v;try{v=terminals.attach(view.id);}catch{break;}printed=dshWeb.printedUrl(v.buffer);if(!printed&&v.exited)break;}
      if(!printed)throw new Error(`The DeepSeek Harness Web UI did not start. Its terminal "${a.name} Web UI" shows why.`);
      let url=printed,tunnel=null;
      if(host){
        const remotePort=exec?hostPort:Number(new URL(printed).port||80);
        tunnel=new Tunnel(host,`http://127.0.0.1:${remotePort}`,{localPort:port});await tunnel.start();
        url=dshWeb.atAddress(printed,port);
      }else if(exec)url=dshWeb.atAddress(printed,hostPort);
      webs.set(a.id,{url,tunnel,terminal:view.id});
      return {url,terminal:view.id};
    },
    dockerList:x=>dockerManager.list(x.hostId?broker.host(x.hostId):null),
    dockerAction:async x=>{const host=x.hostId?broker.host(x.hostId):null;const r=await dockerManager.act(host,{container:x.container,action:x.action});emit();return r;},
    dockerStats:x=>dockerManager.stats(x.hostId?broker.host(x.hostId):null),
    dockerInspect:x=>dockerManager.inspect(x.hostId?broker.host(x.hostId):null,x.container),
    // The last lines a container printed, for the Docker manager's log view (dockerTerminal follows them live).
    dockerLogs:async x=>({text:await dockerManager.logs(x.hostId?broker.host(x.hostId):null,x.container,x.tail)}),
    dockerTerminal:async x=>{const host=x.hostId?broker.host(x.hostId):null,command=dockerManager.terminalCommand(x);const view=await runInTerminal({label:`${x.kind==='logs'?'Logs':'Shell'}: ${x.container}`.slice(0,60),key:`docker_${x.kind==='logs'?'logs':'sh'}_${String(x.container).replace(/[^a-zA-Z0-9_-]/g,'_')}`.slice(0,60),host,command});return {id:view.id};},
    sshKeyCreate:x=>vps.createKey(x.name), hostTest:x=>vps.test(x.hostId?broker.host(x.hostId):schema.host(x.host||{})),
    saveSettings:x=>broker.saveSettings(x), cloneAgent:async x=>{
      const a=broker.agent(x.id),host=x.hostId?broker.host(x.hostId):null;
      const profile=x.runtime==='profile',container=profile?String(x.container||''):'';
      return startJob({kind:'clone',route:{from:a.name,fromWhere:a.transport==='ssh'?broker.host(a.hostId).name:'This computer',to:x.name||`${a.name}-clone`,toWhere:`${host?host.name:'This computer'}${container?` / ${container}`:''}`,toHostId:host?.id||'',provider:a.provider},title:`Cloning ${a.name}`,detail:`${a.name} to ${host?host.name:'this computer'} / ${profile?`profile in container ${container}`:x.runtime==='docker'?'Docker container':a.provider==='hermes'?'Hermes profile':'regular install'}`,steps:[['target','Check the target'],['source','Find the source'],['select','Choose files'],['copy','Copy'],...(x.runtime==='docker'?[['start','Start the container']]:profile&&maintenance.frameworkOf(a)==='openclaw'?[['start','Add the agent to OpenClaw']]:[]),['save','Add to Opaya'],['connect','Connect']]},progress=>broker.cloneAgent({...x,container},progress));
    },
    redeployAgent:async x=>{
      const a=broker.agent(x.id);if(!a.clone)throw new Error('This agent is not a clone.');
      const src=broker.data.agents.find(s=>s.id===a.clone.from);
      return startJob({kind:'redeploy',route:{from:src?.name||'source',fromWhere:src?.transport==='ssh'?broker.host(src.hostId).name:'This computer',to:a.name,toWhere:a.transport==='ssh'?broker.host(a.hostId).name:'This computer',provider:a.provider},title:`Redeploying ${a.name}`,detail:`From ${broker.data.agents.find(s=>s.id===a.clone.from)?.name||'source'}`,steps:[['source','Find the source'],['select','Choose files'],['copy','Copy'],...(a.clone.container&&a.clone.runtime!=='profile'?[['start','Restart the container']]:[]),['connect','Reconnect']]},progress=>broker.redeployAgent(a.id,progress));
    },
    // Transfer between agents: skills (all or chosen), API keys between any agents, Opaya's MCP servers and the Opaya API token.
    // Key names (never values) an agent has, and with targetId where each would go on that agent.
    agentEnvKeys:async x=>{const a=broker.agent(x.id),keys=await moves.envKeys(a,a.transport==='ssh'?broker.host(a.hostId):null,{vault:broker.vault});
      if(!x.targetId)return keys;const t=broker.agent(x.targetId),kind=moves.keyKind(t);
      return {keys,target:{kind,plan:kind?moves.planKeys(kind,keys.map(k=>k.name),{endpoint:t.endpoint}).map(({name,to,why})=>({name,to:to||'',why:why||''})):[]},source:{kind:moves.keyKind(a)}};},
    transferStart:async x=>{
      const src=broker.agent(x.sourceId),dst=broker.agent(x.targetId);if(src.id===dst.id)throw new Error('Choose a different agent to receive them.');
      const hostOf=a=>a.transport==='ssh'?broker.host(a.hostId):null;
      const parts=[x.skills&&'skills',x.keys&&'API keys',x.mcp?.length&&'tools',x.token&&'API token'].filter(Boolean);if(!parts.length)throw new Error('Choose what to transfer.');
      const steps=[...(x.skills?[['source','Read skills'],['target','Find the target'],['copy','Copy skills']]:[]),...(x.keys?[['keys','Copy API keys']]:[]),...(x.mcp?.length?[['mcp','Share MCP servers']]:[]),...(x.token?[['token','Copy API token']]:[])];
      return startJob({kind:'transfer',route:{from:src.name,fromWhere:src.transport==='ssh'?hostOf(src).name:'This computer',to:dst.name,toWhere:dst.transport==='ssh'?hostOf(dst).name:'This computer',provider:src.provider},title:`Transferring to ${dst.name}`,detail:`${parts.join(', ')} from ${src.name}`,steps},async progress=>{
        const result={};
        if(x.skills)result.skills=(await moves.transferSkills({source:src,sourceHost:hostOf(src),target:dst,targetHost:hostOf(dst),names:x.skills==='all'?'all':[].concat(x.skills).map(String),progress})).skills;
        if(x.keys){const r=await moves.transferKeys({source:src,sourceHost:hostOf(src),target:dst,targetHost:hostOf(dst),keys:x.keys==='all'?'all':[].concat(x.keys).map(String),vault:broker.vault,progress});result.keys=r.keys;result.skippedKeys=r.skipped;if(moves.keyKind(dst)==='token')broker.disconnect(dst.id);}
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
    opayaToolList:async()=>require('./opaya-agent.cjs').TOOLS.map(t=>({name:t.function.name,description:t.function.description,parameters:t.function.parameters})),
    opayaToolCall:async x=>opaya.bridgeCall(String(x?.name||''),x?.args),
    browserTool, browserResult:async x=>{const c=browserCalls.get(x.id);if(!c)return false;clearTimeout(c.timer);browserCalls.delete(x.id);x.ok?c.resolve(x.value):c.reject(new Error(String(x.error||'Browser action failed.')));return true;},
    mcpSave:x=>broker.saveMcpServer(x), mcpRemove:x=>broker.removeMcpServer(x.id), agentMcp:x=>broker.setAgentMcp(x), agentSkills:x=>broker.skills(x.id),
    // One-click MCP servers: Opaya's catalog (no secrets in it) and installing one with the key typed in a masked field.
    mcpCatalog:async()=>mcp.catalog(), mcpInstall:x=>broker.installMcp({id:x.id,secret:typeof x.secret==='string'&&x.secret?x.secret:x.vaultKey?opaya.secretValue(opaya.secretEntry(String(x.vaultKey))):'',folder:typeof x.folder==='string'?x.folder:'',agents:x.agents==='all'?'all':[].concat(x.agents||[]).map(String)}),
    // Hermes and OpenClaw skills: browse the hub or install one with the agent's CLI in a visible terminal.
    skillAction:async x=>{
      const a=broker.agent(x.agentId),host=a.transport==='ssh'?broker.host(a.hostId):null;
      const command=skills.hermesSkillCommand(a,{action:x.action,skill:x.skill,remote:!!host,windows:process.platform==='win32'});
      if(x.action==='install'&&!await approve(a,`Install skill ${x.skill}?`,`Runs in a visible terminal ${host?'on '+host.name:'on this computer'}:\n\n${command}\n\n${a.provider==='openclaw'?'OpenClaw checks ClawHub skills before installing.':'Hermes scans hub skills before installing.'} Start a new conversation to use it.`))throw new Error('Skill install cancelled.');
      return runInTerminal({owner:a.id,label:x.action==='install'?`Skill ${x.skill}`:a.provider==='openclaw'?'OpenClaw skills':'Hermes skills',key:`skills_${a.id}`.slice(0,60),host,command});
    },
    playground:x=>broker.playground(x), moveAgent:x=>broker.moveAgent(x), connectAll:x=>broker.connectAll(x),
    // Free local model: install Ollama if needed, start it, download the model and connect the Opaya Agent.
    opayaFreeModels:async()=>({models:free.FREE_MODELS.map(({id,label,size,note})=>({id,label,size,note})),recommended:free.recommended(),installed:await free.ollamaModels()}),
    opayaFreeSetup:async x=>{const model=String(x?.model||free.recommended());const m=free.FREE_MODELS.find(f=>f.id===model);if(!m)throw new Error('Choose one of the free models.');
      return startJob({kind:'free-model',route:{from:m.label,fromWhere:`Free / ${m.size}`,to:'Opaya Agent',toWhere:'This computer',provider:'ollama'},title:`Setting up ${m.label}`,detail:'Free local model through Ollama. No account and no key.',steps:[['ollama','Install and start Ollama'],['download',`Download ${m.label} (${m.size})`],['connect','Connect the Opaya Agent']]},progress=>free.setupFree({opaya,model,progress}).then(r=>{emit();return r;}));},
    opayaSaveConfig:x=>opaya.saveConfig(x), opayaTest:x=>opaya.test(x||{}), opayaForgetKey:()=>opaya.forgetKey(),
    opayaSend:x=>opaya.begin(x.text), opayaNewSession:()=>opaya.newSession(), opayaSelectSession:x=>opaya.selectSession(String(x.id||'')), opayaDeleteSession:x=>opaya.deleteSession(String(x.id||'')), opayaStop:()=>opaya.stop(), opayaClear:()=>opaya.clear(),
    ...maintenanceActions, ...toolActions, ...projectRemoteActions, ...guideActions,
    shutdown
  };
  // Secrets the user gives the Opaya Agent with the key button next to its message box, and forgetting one.
  actions.opayaHoldSecret = x=>opaya.holdFromUser({name:x.name,value:x.value,endpoint:x.endpoint});
  actions.vaultTool = async x=>{const r=await opaya.vaultTool({agentId:x.agentId,op:x.op,name:x.name,why:x.why});emit();return r;};
  actions.vaultGiveAgent = async x=>{const r=await opaya.giveHeldToAgent({id:x.id,agentId:x.agentId});emit();return r;};
  actions.agentKeys = x=>opaya.agentKeys({agentId:x.agentId});
  actions.opayaGiveAll = async x=>{const r=await opaya.giveToAll({id:x.id});emit();return r;};
  actions.agentGiveSecret = async x=>{const r=await opaya.giveToAgent({agentId:x.agentId,name:x.name,value:x.value,endpoint:x.endpoint});emit();return r;};
  actions.opayaForgetSecret = x=>opaya.forgetSecret(String(x.id||''));
  // Import into the vault from a file the user chose, pasted text or the tools on this computer. Only the user starts
  // these (never the Opaya Agent's tools): a scan returns names and masks, a commit holds the picked values.
  actions.vaultImportScan = x=>opaya.vaultImportScan({file:x.file,text:x.text,tools:!!x.tools});
  actions.vaultImportCommit = async x=>{const r=await opaya.vaultImportCommit({id:x.id,picks:x.picks});emit();return r;};
  // The Opaya Agent's tools for backup, uninstall, update, clone, transfer, MCP servers, Docker shells and jobs run these.
  // Importing into the vault and giving an MCP server a vault key are the user's own clicks, never the Opaya Agent's.
  actions.vaultBackupSave = x=>opaya.vaultBackupSave({file:x.file,password:x.password});
  actions.vaultBackupRestore = x=>opaya.vaultBackupRestore({file:x.file,password:x.password});
  const USER_ONLY=new Set(['vaultImportScan','vaultImportCommit','vaultBackupSave','vaultBackupRestore']);
  opaya.appAction=(name,input)=>{if(!Object.hasOwn(actions,name)||USER_ONLY.has(name)||name==='mcpInstall'&&input?.vaultKey)throw new Error('Unsupported action.');return origin.run('opaya',()=>actions[name](input));};
  // Actions the user starts whose failure the Opaya Agent should handle, with how to name them.
  const nameOf=id=>{try{return broker.agent(id).name;}catch{return 'an agent';}},hostName=id=>{try{return id?broker.host(id).name:machineName();}catch{return 'a machine';}};
  const REPORTED={
    dockerAction:x=>`Docker ${x.action} ${x.container} on ${hostName(x.hostId)}`,
    agentGiveSecret:x=>`Give ${x.name||'a key'} to ${nameOf(x.agentId)}`,
    vaultGiveAgent:x=>`Give a vault key to ${nameOf(x.agentId)}`,
    opayaGiveAll:()=>'Give a key to every agent',
    mcpInstall:x=>`Add the ${x.id} MCP server`,
    installFramework:x=>`Install ${x.id} on ${hostName(x.hostId)}`,
    agentBackup:x=>`Back up ${nameOf(x.id)}`,
    cloneAgent:x=>`Clone ${nameOf(x.id)}`,
    transferStart:x=>`Transfer from ${nameOf(x.sourceId)} to ${nameOf(x.targetId)}`,
    agentUpdate:x=>`Update ${nameOf(x.id)}`,
    toolUpdate:x=>`Update ${x.id||'a tool'}`
  };
  const token = randomBytes(32).toString('hex');
  listener = server({token,snapshot,scopes:()=>new Map([[browserToken,new Set(['browserTool'])],[toolsToken,new Set(['opayaToolList','opayaToolCall'])],[vaultToken,new Set(['vaultTool'])]]),
    dispatch:async (method,input)=>{if(!Object.hasOwn(actions,method))throw new Error('Unsupported desktop action.');try{return await actions[method](input||{});}catch(error){const text=safeError(error);if(REPORTED[method])actionFailed(REPORTED[method](input||{}),text);throw new Error(text);}},
    onApproval:(socket,message)=>{const a=approvals.get(message.id);if(a?.socket===socket)a.finish(message.allow===true,message.value);},
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
