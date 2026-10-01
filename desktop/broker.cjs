'use strict';
const {randomUUID}=require('node:crypto');
const path=require('node:path');
const schema=require('./schema.cjs');
const {primeShellPath}=require('./process.cjs');
const {visionOf}=require('./vision.cjs');
const {scanLocal,scanRemote,fingerprint}=require('./discovery.cjs');
const {hermesLogs}=require('./diagnostics.cjs');
const {createAdapter,efforts:effortLevels}=require('./adapters/index.cjs');
const attach=require('./attachments.cjs');
const {importGatewayToken}=require('./credentials.cjs');
const {gatewayOperation}=require('./management.cjs');
const mcp=require('./mcp.cjs');
const mcpConfig=require('./mcp-config.cjs');
// What a written config entry depends on: a change rewrites it on the agents that use the server.
const mcpDefinition=s=>JSON.stringify([s.name,s.type,s.command,s.args,s.url,s.envNames,s.headerNames]);
const {listSkills}=require('./skills.cjs');
const projects=require('./projects.cjs');
const files=require('./files.cjs');
const cloner=require('./clone.cjs');
// The browser bridge runs next to Opaya, so only agents on this computer (not SSH or containers) can use it.
const browserCapable=a=>a.transport!=='ssh'&&a.command!=='docker'&&['acp','claude'].includes(a.protocol);
function safeError(error,token=''){
  let value=String(error?.message||error||'Operation failed.');
  if(token)value=value.split(token).join('[redacted]');
  return value.replace(/\x1b\[[0-9;]*[A-Za-z]/g,'').replace(/(Bearer\s+)[^\s]+/gi,'$1[redacted]').replace(/\bsk-[A-Za-z0-9_-]{12,}/g,'[redacted]').slice(0,2400);
}
// Agents whose vendor no longer accepts connections from other apps. Their own CLI in a terminal is the way to use them, so Opaya switches them to it.
const CLIENT_REFUSED=/client is no longer supported/i;
// Console grid layouts (ui/app.js) and the share of the first column / row, kept between 0.15 and 0.85.
const GRIDS=['row','cols2','rows2','grid4','main3','cols3','grid6'];
const ratio=v=>{const n=Number(v);return Number.isFinite(n)&&n>=0.15&&n<=0.85?Math.round(n*1000)/1000:0.5;};
// Chat windows open in the chat dock: existing conversations only, each once, at most six.
const chatDock=(list,conversations)=>Array.isArray(list)?list.filter(d=>d&&typeof d.id==='string'&&conversations.some(c=>c.id===d.id)).filter((d,i,all)=>all.findIndex(x=>x.id===d.id)===i).slice(0,6).map(d=>({id:d.id,min:!!d.min})):[];
class Broker{
  constructor({store,vault,emit,approve,adapterFactory=createAdapter}){
    Object.assign(this,{store,vault,emit,approve,adapterFactory});this.runtime=new Map();this.histories=new Map();this.turns=new Map();this.connecting=new Map();this.scanBusy=false;this.closing=false;
  }
  async init(){
    await this.vault.load();this.data=await this.store.load();
    this.data.drafts=this.data.drafts||{};this.data.lastConversation=this.data.lastConversation||{};this.data.view=this.data.view||{};
    this.data.agents=this.data.agents.map(a=>schema.agent(a));
    // 0.19: iTrust for the Opaya Agent is on by default (once for existing settings too); the user can turn it off.
    {const s=this.data.settings||{};this.data.settings={itrustAll:!!s.itrustAll,itrustOpaya:s.opayaDefaults===2?!!s.itrustOpaya:true,opayaDefaults:2,machineName:typeof s.machineName==='string'?s.machineName.slice(0,60):'',machineNote:typeof s.machineNote==='string'?s.machineNote.slice(0,200):'',backupDir:typeof s.backupDir==='string'&&path.isAbsolute(s.backupDir)?s.backupDir:'',updateChecks:s.updateChecks!==false,autoFix:s.autoFix!==false,interface:['chat','terminal'].includes(s.interface)?s.interface:'',chatOpens:s.chatOpens==='full'?'full':'window',
      notifyReplies:s.notifyReplies!==false,notifyApprovals:s.notifyApprovals!==false,notifyJobs:s.notifyJobs!==false,notifySound:s.notifySound!==false,tips:s.tips!==false,autoConnect:s.autoConnect===true,sendKey:s.sendKey==='mod-enter'?'mod-enter':'enter'};}
    this.data.projects=(Array.isArray(this.data.projects)?this.data.projects:[]).flatMap(p=>{try{return [projects.project(p)];}catch{return [];}});
    this.migrateLinkedCopies();
    this.data.mcpServers=(Array.isArray(this.data.mcpServers)?this.data.mcpServers:[]).flatMap(s=>{try{return [mcp.server(s)];}catch{return [];}});this.data.hosts=this.data.hosts.map(h=>schema.host(h));
    this.data.activeAgentId=this.data.agents.some(a=>a.id===this.data.activeAgentId)?this.data.activeAgentId:this.data.agents[0]?.id||'';
    for(const a of this.data.agents)this.runtime.set(a.id,{status:'disconnected',error:'',models:[]});
    for(const c of this.data.conversations){schema.id(c.id);schema.id(c.agentId);}
    for(const c of this.data.conversations.slice(-100))this.histories.set(c.id,await this.store.transcript(c.id));
    // Chat windows left open in the dock get their messages from the first snapshot, also for older chats.
    for(const d of this.data.view?.chatDock||[])if(!this.histories.has(d.id)&&this.data.conversations.some(c=>c.id===d.id))this.histories.set(d.id,await this.store.transcript(d.id));
    // An app crash may have left streaming placeholders on disk.
    for(const [id,messages] of this.histories){let recovered=false;for(const m of messages)if(m.status==='streaming'){m.status='error';m.error='The session service stopped during this turn. Saved partial output is preserved. Check the agent before retrying.';recovered=true;}if(recovered)await this.store.writeTranscript(id,messages);}
    attach.prune(this.store.root).catch(()=>{});
    // No snapshot here: it asks the OS keychain whether encryption is available, and on macOS that can wait on a
    // keychain prompt. The service must finish starting first; the UI's first snapshot asks instead.
    return true;
  }
  agent(id){const a=this.data.agents.find(a=>a.id===schema.id(id));if(!a)throw new Error('Agent not found.');return a;}
  host(id){const h=this.data.hosts.find(h=>h.id===schema.id(id));if(!h)throw new Error('Host not found.');return h;}
  runtimeFor(id){if(!this.runtime.has(id))this.runtime.set(id,{status:'disconnected',error:'',models:[]});return this.runtime.get(id);}
  snapshot(){
    const {agents,hosts,conversations,activeAgentId,activeConversationId}=this.data;
    return {version:'0.2.1',drafts:this.data.drafts,view:this.data.view,recoveryNotice:this.data.recoveryNotice||'',agents:agents.map(a=>{const r=this.runtimeFor(a.id);return {...a,status:r.status,error:r.error||'',adapterDescription:r.description||'',agentVersion:r.agentVersion||'',activeModel:r.adapter?.currentModel||'',commands:r.adapter?.commands||[],models:r.models||[],efforts:effortLevels(a,r.adapter),hasToken:this.vault.has(a.id),busy:this.turns.has(a.id),turnStartedAt:this.turns.get(a.id)?.startedAt||0,lastEventAt:this.turns.get(a.id)?.lastEventAt||0,lastEvent:this.turns.get(a.id)?.lastEvent||''};}),hosts,settings:this.data.settings,projects:this.data.projects||[],mcpServers:(this.data.mcpServers||[]).map(mcp.publicView),conversations:conversations.map(({essence,...c})=>essence?{...c,essence:{by:essence.by,at:essence.at}}:c),activeAgentId,activeConversationId:activeConversationId||'',histories:Object.fromEntries([...this.histories].filter(([id])=>id===activeConversationId||(this.data.view?.chatDock||[]).some(d=>d.id===id)||Object.values(this.data.playground?.conversations||{}).includes(id))),playground:this.data.playground||null,secureStorage:this.vault.available(),platform:process.platform};
  }
  changed(){if(!this.closing)this.emit(this.snapshot());}
  async persist(){await this.store.write(this.data);this.changed();}
  async saveHost(input){
    const host=schema.host(input),i=this.data.hosts.findIndex(h=>h.id===host.id||host.alias&&h.alias===host.alias);
    if(i>=0){
      host.id=this.data.hosts[i].id;
      const agents=this.data.agents.filter(a=>a.hostId===host.id);
      if(agents.some(a=>this.turns.has(a.id)))throw new Error('Stop this host\'s active turns before editing its connection.');
      for(const a of agents)this.disconnect(a.id);
      this.data.hosts[i]=host;
    }else{if(this.data.hosts.length>=128)throw new Error('Host limit reached.');this.data.hosts.push(host);}
    await this.persist();return host;
  }
  async removeHost(id){this.host(id);if(this.data.agents.some(a=>a.hostId===id))throw new Error('Remove or reassign this host\'s agents before removing the host.');this.data.hosts=this.data.hosts.filter(h=>h.id!==id);await this.persist();}
  // `preapproved` is internal only (the service passes one argument): a clone the user just confirmed, or the Opaya Agent
  // with iTrust on, is not asked again (also not for a gateway token import).
  async saveAgent({agent:input,token,remember=true,importToken=false},{preapproved=false}={}){
    const a=schema.agent(input);if(a.transport==='ssh')this.host(a.hostId);
    const existing=this.data.agents.find(x=>x.id===a.id);
    if(existing&&this.turns.has(a.id))throw new Error('Stop the active turn before editing this agent.');
    if(!existing&&this.data.agents.length>=128)throw new Error('Workspace limit reached (128 agents).');
    const duplicate=this.data.agents.find(x=>x.id!==a.id&&fingerprint(x)===fingerprint(a));
    if(duplicate)throw new Error(`This connection already exists as ${duplicate.name}.`);
    if(!preapproved&&a.protocol!=='openai'&&(!existing||existing.command!==a.command||JSON.stringify(existing.args)!==JSON.stringify(a.args)||existing.hermesHome!==a.hermesHome)){
      const ok=await this.approve(a,'Trust this agent executable?',`${a.command} ${a.args.join(' ')}\n${a.transport==='ssh'?'Runs on '+this.host(a.hostId).name:'Runs on this computer'}\n\nThe agent can use the permissions of that OS account. Hermes ACP starts a new process: do not run it against a profile already used by a gateway.`);
      if(!ok)throw new Error('Agent executable was not approved.');
    }
    if(importToken){
      const where=a.transport==='ssh'?' over verified SSH':'';
      const ok=preapproved||await this.approve(a,`Import this ${a.provider==='openclaw'?'OpenClaw':'Hermes'} gateway token?`,a.provider==='openclaw'?`Read only the gateway token from ${a.command==='docker'?'its Docker container':'~/.openclaw/openclaw.json'}${where}. Provider API keys are not imported. The token stays in Opaya\'s native process and OS-encrypted vault.`:`Read only API_SERVER_KEY from ${a.hermesHome}/.env${where}. Provider API keys are not imported. The token stays in Opaya\'s native process and OS-encrypted vault.`);
      if(!ok)throw new Error('Token import cancelled.');
      token=await importGatewayToken(a,a.transport==='ssh'?this.host(a.hostId):null);
    }
    if(token!==undefined)await this.vault.set(a.id,token,Boolean(remember));
    if(existing){this.disconnect(a.id);this.data.agents=this.data.agents.map(x=>x.id===a.id?a:x);}else{this.data.agents.push(a);this.runtimeFor(a.id);}
    this.data.activeAgentId=a.id;this.data.activeConversationId=this.data.conversations.filter(c=>c.agentId===a.id).at(-1)?.id||'';
    await this.persist();return a;
  }
  async removeAgent(id){
    const a=this.agent(id),turn=this.turns.get(id);this.disconnect(id);await turn?.done;this.data.agents=this.data.agents.filter(x=>x.id!==id);
    const conversations=this.data.conversations.filter(c=>c.agentId===id);this.data.conversations=this.data.conversations.filter(c=>c.agentId!==id);
    for(const c of conversations){this.histories.delete(c.id);delete this.data.drafts[c.id];await this.store.deleteTranscript(c.id);await attach.remove(this.store.root,c.id);}
    delete this.data.drafts[id];delete this.data.lastConversation[id];
    for(const p of this.data.projects||[]){p.agentIds=p.agentIds.filter(x=>x!==id);p.remotes=(p.remotes||[]).filter(r=>r.agentId!==id);}
    await this.vault.remove(id);this.runtime.delete(id);
    if(this.data.activeAgentId===id){this.data.activeAgentId=this.data.agents[0]?.id||'';this.data.activeConversationId='';}
    await this.persist();return a;
  }
  async select(id){this.agent(id);this.data.activeAgentId=id;const c=this.data.conversations.find(c=>c.agentId===id&&c.id===this.data.lastConversation[id])||this.data.conversations.filter(c=>c.agentId===id).at(-1);this.data.activeConversationId=c?.id||'';if(c&&!this.histories.has(c.id))this.histories.set(c.id,await this.store.transcript(c.id));await this.persist();}
  // Playground: ask two agents the same question side by side. Each run gets its own conversations (or continues the
  // previous playground ones) without switching the agent that is open in the main view.
  async playground({agentIds,text,keepContext=false}){
    if(!Array.isArray(agentIds)||agentIds.length!==2||agentIds[0]===agentIds[1])throw new Error('Choose two different agents.');
    const ids=agentIds.map(id=>this.agent(id).id);text=schema.prompt(text);
    const previous=this.data.playground,conversations={},errors={};
    for(const id of ids){
      try{
        let c=keepContext&&previous?.conversations?.[id]?this.data.conversations.find(x=>x.id===previous.conversations[id]&&x.agentId===id):null;
        if(!c)c=await this.createConversation(id,{activate:false,kind:'playground',title:`Playground: ${text.slice(0,50).replace(/\s+/g,' ')}`});
        conversations[id]=c.id;
      }catch(error){errors[id]=safeError(error);}
    }
    this.data.playground={agentIds:ids,prompt:text,keepContext:!!keepContext,conversations,errors,at:new Date().toISOString()};
    await Promise.all(ids.filter(id=>conversations[id]).map(id=>this.send({agentId:id,conversationId:conversations[id],text}).catch(error=>{errors[id]=safeError(error);})));
    await this.persist();return this.data.playground;
  }
  // activate:false makes a chat without switching the selected agent (a chat window opened from the chat dock).
  async newConversation(agentId,projectId='',{activate=true}={}){
    const a=this.agent(agentId);if(this.turns.has(agentId))throw new Error('Wait for or stop this agent\'s current turn first.');
    if(projectId){const p=this.project(projectId);if(!projects.fits(a,p))throw new Error(`${a.name} runs on a different machine than ${p.name}.`);}
    return this.createConversation(agentId,{projectId,activate});
  }
  async createConversation(agentId,{activate=true,title='New conversation',projectId='',kind=''}={}){
    if(this.data.conversations.length>=2000)throw new Error('Conversation limit reached. Delete old chats from History.');
    const c={id:randomUUID(),agentId,title,createdAt:new Date().toISOString(),externalSessionId:'',...(projectId?{projectId}:{}),...(kind?{kind}:{})};
    this.data.conversations.push(c);this.histories.set(c.id,[]);if(activate){this.data.activeConversationId=c.id;this.data.activeAgentId=agentId;this.data.lastConversation[agentId]=c.id;}await this.persist();return c;
  }
  async selectConversation(id){const c=this.data.conversations.find(c=>c.id===schema.id(id));if(!c)throw new Error('Conversation not found.');this.data.activeAgentId=c.agentId;this.data.activeConversationId=c.id;this.data.lastConversation[c.agentId]=c.id;if(!this.histories.has(c.id))this.histories.set(c.id,await this.store.transcript(c.id));await this.persist();}
  conversation(id){const c=this.data.conversations.find(c=>c.id===schema.id(id));if(!c)throw new Error('Conversation not found.');return c;}
  async renameConversation({id,title}){const c=this.conversation(id);c.title=schema.text(title,'title',120).replace(/\s+/g,' ').trim()||c.title;await this.persist();return c;}
  // Deletes a chat and its transcript. The agent keeps its own session files; Opaya only forgets the chat.
  async deleteConversation(id){
    const c=this.conversation(id),turn=this.turns.get(c.agentId);
    if(turn&&turn.conversationId===c.id)throw new Error('Stop the agent\'s current answer in this chat first.');
    this.data.conversations=this.data.conversations.filter(x=>x.id!==c.id);this.histories.delete(c.id);delete this.data.drafts[c.id];
    if(this.data.lastConversation?.[c.agentId]===c.id)delete this.data.lastConversation[c.agentId];
    if(this.data.activeConversationId===c.id)this.data.activeConversationId=this.data.conversations.filter(x=>x.agentId===c.agentId).at(-1)?.id||'';
    const pg=this.data.playground;if(pg?.conversations)for(const [k,v] of Object.entries(pg.conversations))if(v===c.id)delete pg.conversations[k];
    await this.store.deleteTranscript(c.id);await attach.remove(this.store.root,c.id);await this.persist();return true;
  }
  async setEssence(id,essence){const c=this.conversation(id);c.essence={text:String(essence.text||'').slice(0,40000),by:String(essence.by||'').slice(0,120),at:new Date().toISOString()};await this.persist();return c.essence;}
  async messagesOf(id){const c=this.conversation(id);return this.histories.get(c.id)||await this.store.transcript(c.id);}
  async saveDraft({agentId,conversationId='',text=''}){
    this.agent(agentId);if(typeof text!=='string'||text.length>80000||text.includes('\0'))throw new Error('Invalid draft.');
    if(conversationId&&!this.data.conversations.some(c=>c.id===conversationId&&c.agentId===agentId))throw new Error('Draft conversation does not belong to this agent.');
    const key=conversationId||agentId;this.data.drafts[key]=text;await this.store.write(this.data);return true;
  }
  async saveView(input){
    this.data.view={overview:!!input.overview,opaya:!!input.opaya,playground:!!input.playground,collapsed:Array.isArray(input.collapsed)?[...new Set(input.collapsed.filter(x=>typeof x==='string'&&x.length<=60))].slice(0,100):[],terminalVisible:!!input.terminalVisible,terminalId:input.terminalId?schema.id(input.terminalId):'',panes:Array.isArray(input.panes)?input.panes.filter(x=>typeof x==='string'&&/^[\w-]{1,80}$/.test(x)).slice(0,8):[],paneSizes:Array.isArray(input.paneSizes)?input.paneSizes.map(Number).filter(x=>Number.isFinite(x)&&x>0&&x<100).slice(0,8):[],theme:input.theme==='light'?'light':'dark',projects:!!input.projects,sidebarHidden:!!input.sidebarHidden,tips:Array.isArray(input.tips)?[...new Set(input.tips.filter(x=>typeof x==='string'&&x.length<=200))].slice(-300):[],lastVersion:typeof input.lastVersion==='string'&&/^\d+\.\d+\.\d+$/.test(input.lastVersion)?input.lastVersion:'',greeted:typeof input.greeted==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(input.greeted)?input.greeted:'',layout:(l=>({terminal:l?.terminal==='right'?'right':'bottom',browser:l?.browser==='bottom'?'bottom':'right',bottomHeight:Math.max(120,Math.min(3000,Number(l?.bottomHeight)||280)),rightWidth:Math.max(240,Math.min(4000,Number(l?.rightWidth)||520)),grid:GRIDS.includes(l?.grid)?l.grid:'row',gridCol:ratio(l?.gridCol),gridRow:ratio(l?.gridRow)}))(input.layout),chatDock:chatDock(input.chatDock,this.data.conversations),sidebarHide:Array.isArray(input.sidebarHide)?[...new Set(input.sidebarHide.filter(x=>['home','playground','machines','vault','help'].includes(x)))]:[],terminalFont:(n=>Number.isInteger(n)&&n>=8&&n<=28?n:13)(Number(input.terminalFont)),projectsOpen:Array.isArray(input.projectsOpen)?[...new Set(input.projectsOpen.filter(x=>typeof x==='string'&&/^[\w-]{1,80}$/.test(x)))].slice(0,50):[]};const docked=this.data.view.chatDock.map(d=>d.id),missing=docked.filter(id=>!this.histories.has(id));
    for(const id of missing)this.histories.set(id,await this.store.transcript(id));
    await this.store.write(this.data);
    // A newly docked chat's messages reach the window with the next snapshot.
    if(missing.length||docked.join()!==(this.lastDocked||'')){this.lastDocked=docked.join();this.changed();}
    return true;
  }
  // iTrust: tool requests from this agent (or every agent) are approved without asking. Read at request time.
  isTrusted(id){const a=this.data.agents.find(x=>x.id===id);return !!a&&(this.data.settings?.itrustAll||a.itrust);}
  async saveSettings(input){
    const next={...this.data.settings};
    if(input.itrustAll!==undefined)next.itrustAll=!!input.itrustAll;
    if(input.itrustOpaya!==undefined)next.itrustOpaya=!!input.itrustOpaya;
    // Hourly update checks, and fixing "too old" connection errors by updating automatically. Both on by default.
    if(input.updateChecks!==undefined)next.updateChecks=!!input.updateChecks;
    if(input.autoFix!==undefined)next.autoFix=!!input.autoFix;
    // System notifications when Opaya is not in front (all on by default), Opaya's tips, connecting at start, the send key.
    for(const key of ['notifyReplies','notifyApprovals','notifyJobs','notifySound','tips','autoConnect'])if(input[key]!==undefined)next[key]=!!input[key];
    if(input.sendKey!==undefined){if(!['enter','mod-enter'].includes(input.sendKey))throw new Error('Choose Enter or Ctrl+Enter to send.');next.sendKey=input.sendKey;}
    // Chat or Terminal first. '' until the user chooses on first launch.
    if(input.interface!==undefined){if(!['chat','terminal'].includes(input.interface))throw new Error('Choose chat or terminal.');next.interface=input.interface;}
    // What Chat opens: a window in the chat dock, or the full chat view.
    if(input.chatOpens!==undefined){if(!['window','full'].includes(input.chatOpens))throw new Error('Choose a chat window or the full view.');next.chatOpens=input.chatOpens;}
    // This computer as shown in Opaya (the sidebar, Machines, backups) and where local backups go.
    if(input.machineName!==undefined)next.machineName=schema.text(input.machineName,'machine name',60).trim();
    if(input.machineNote!==undefined)next.machineNote=schema.text(input.machineNote,'machine note',200).trim();
    if(input.backupDir!==undefined){const dir=schema.text(input.backupDir,'backup folder',2048).trim();if(dir&&!path.isAbsolute(dir))throw new Error('Choose an absolute folder for backups.');next.backupDir=dir;}
    this.data.settings=next;await this.persist();return next;
  }
  async updateAgentDisplay({id,displayName,pinned,avatar,group,tags,itrust,browser,surface}){
    const index=this.data.agents.findIndex(a=>a.id===schema.id(id));if(index<0)throw new Error('Agent not found.');
    const a={...this.data.agents[index]};
    if(displayName!==undefined)a.displayName=schema.text(displayName,'display name',80).trim();
    if(pinned!==undefined)a.pinned=Boolean(pinned);
    if(avatar!==undefined)a.avatar=schema.avatar(avatar);
    if(group!==undefined)a.group=schema.group(group);
    if(tags!==undefined)a.tags=schema.tags(tags);
    if(itrust!==undefined)a.itrust=Boolean(itrust);
    if(browser){const v=visionOf({...a,activeModel:this.runtimeFor(a.id).adapter?.currentModel});if(v.vision===false)throw new Error(`${a.displayName||a.name} cannot use the Opaya browser: ${v.reason} Choose a model that can see images (Models button), then try again.`);}
    if(browser!==undefined)a.browser=Boolean(browser);
    if(surface!==undefined)a.surface=['chat','terminal'].includes(surface)?surface:'';
    this.data.agents[index]=a;await this.persist();return a;
  }
  // Drag and drop: place an agent before or after another one and optionally move it into a section (group or pinned).
  async moveAgent({id,targetId,position='before',group,pinned}){
    id=schema.id(id);const from=this.data.agents.findIndex(a=>a.id===id);if(from<0)throw new Error('Agent not found.');
    const [agent]=this.data.agents.splice(from,1),moved={...agent};
    if(group!==undefined)moved.group=schema.group(group);
    if(pinned!==undefined)moved.pinned=Boolean(pinned);
    let to=targetId?this.data.agents.findIndex(a=>a.id===schema.id(targetId)):-1;
    if(to<0)to=this.data.agents.length;else if(position==='after')to+=1;
    this.data.agents.splice(to,0,moved);await this.persist();return true;
  }
  // Connect every saved agent that is not connected yet, in parallel. One failure does not stop the others.
  // Everything needed to see why an agent is not answering: live turn timing, the adapter's protocol log, stderr and,
  // for Hermes, the tail of its own log files.
  async diagnostics(id){
    const a=this.agent(id),r=this.runtimeFor(id),turn=this.turns.get(id),now=Date.now();
    const adapter=r.adapter?.diagnostics?.()||null;
    return {agent:{id:a.id,name:a.name,provider:a.provider,protocol:a.protocol,transport:a.transport,command:a.command,args:a.args,endpoint:a.endpoint,cwd:a.cwd,hermesHome:a.hermesHome},
      status:r.status,error:r.error||'',
      turn:turn?{runningSeconds:Math.round((now-(turn.startedAt||now))/1000),secondsSinceLastEvent:Math.round((now-(turn.lastEventAt||turn.startedAt||now))/1000),lastEvent:turn.lastEvent||''}:null,
      adapter,hermesLogs:a.provider==='hermes'?await hermesLogs(a,a.transport==='ssh'?this.data.hosts.find(h=>h.id===a.hostId):null).catch(()=>[]):[]};
  }
  // ---- Projects ---------------------------------------------------------------------------------------------------
  project(id){const p=(this.data.projects||[]).find(p=>p.id===schema.id(id));if(!p)throw new Error('Project not found.');return p;}
  projectHost(p){return p.hostId?this.host(p.hostId):null;}
  async saveProject(input){
    const existing=input?.id?this.data.projects.find(p=>p.id===input.id):null;
    const p=projects.project({...(existing||{}),...input});if(p.hostId)this.host(p.hostId);
    p.agentIds=p.agentIds.filter(id=>this.data.agents.some(a=>a.id===id));p.remotes=p.remotes.filter(r=>p.agentIds.includes(r.agentId));p.link=null;
    if(!existing&&this.data.projects.length>=200)throw new Error('Project limit reached (200).');
    if(this.data.projects.some(x=>x.id!==p.id&&x.path===p.path&&x.hostId===p.hostId))throw new Error('This folder is already a project.');
    this.data.projects=existing?this.data.projects.map(x=>x.id===p.id?p:x):[...this.data.projects,p];
    await this.persist();return p;
  }
  async removeProject(id){
    const p=this.project(id);this.data.projects=this.data.projects.filter(x=>x.id!==p.id);
    for(const c of this.data.conversations)if(c.projectId===p.id)delete c.projectId;
    await this.persist();return true;
  }
  async projectInfo(id){const p=this.project(id);return files.browse({op:'project',path:p.path,host:this.projectHost(p)});}
  async projectBranches(id){const p=this.project(id);return files.browse({op:'branches',path:p.path,host:this.projectHost(p)});}
  // The folder a conversation's agent should work in: its project's folder when the agent runs on that machine.
  conversationCwd(c,a){const p=c.projectId&&(this.data.projects||[]).find(x=>x.id===c.projectId);return p?projects.folderFor(a,p):'';}
  // Opaya 0.16.0 kept a remote agent's copy as a second project ("<name> on <machine>"). Fold each copy into the local
  // project it came from: its agents become that project's remote agents and their chats move over. Copies with no
  // agent, or whose original is gone, stay as ordinary projects on the machine.
  migrateLinkedCopies(){
    for(const copy of [...this.data.projects]){
      const l=copy.link;if(!l)continue;copy.link=null;
      const local=this.data.projects.find(p=>p.id===l.from&&!p.hostId),agents=copy.agentIds.map(id=>this.data.agents.find(a=>a.id===id)).filter(Boolean);
      if(!local||!agents.length)continue;
      for(const a of agents){
        if((local.remotes||[]).some(r=>r.agentId===a.id))continue;
        const r=projects.remote({...l,agentId:a.id,hostId:copy.hostId,container:'',dir:copy.path});if(!r)continue;
        local.remotes=[...(local.remotes||[]),r];if(!local.agentIds.includes(a.id))local.agentIds.push(a.id);
      }
      for(const c of this.data.conversations)if(c.projectId===copy.id)c.projectId=local.id;
      this.data.projects=this.data.projects.filter(p=>p.id!==copy.id);
    }
  }
  // ---- Clone and redeploy (Hermes) ------------------------------------------------------------------------------
  async cloneAgent({id,name,hostId='',runtime='regular',scope='everything',keys=true,cron,container=''},progress=()=>{}){
    const a=this.agent(id),host=hostId?this.host(hostId):null;
    // A profile goes into a container Opaya already runs an agent in, on that machine; it asks before changing it.
    const into=runtime==='profile'?require('./profiles.cjs').targets(this.data.agents).find(t=>t.container===container&&t.hostId===(host?.id||'')):null;
    if(runtime==='profile'&&!into)throw new Error('Choose a container Opaya runs an agent in.');
    const result=await cloner.clone({agent:a,sourceHost:a.transport==='ssh'?this.host(a.hostId):null,host,runtime,scope,keys,cron:cron===undefined?undefined:!!cron,name:name||`${a.name}-clone`,
      into:into&&this.agent(into.agentId),confirm:(title,detail)=>this.approve({name:'Opaya'},title,detail),progress});
    progress({step:'save',state:'active',message:'Adding the clone to Opaya'});
    const saved=await this.saveAgent({agent:result.connection},{preapproved:true});
    // An OpenClaw clone got the source's config, so its gateway token is the same one; a profile uses its container's gateway.
    const tokenFrom=into?into.agentId:a.id;
    if(result.copyToken&&this.vault.has(tokenFrom))await this.vault.set(saved.id,this.vault.get(tokenFrom),true);
    progress({step:'save',state:'done',message:`${saved.name} added`});
    progress({step:'connect',state:'active',message:`Connecting to ${saved.name}`});
    try{await this.connect(saved.id);progress({step:'connect',state:'done',message:`${saved.name} is connected`});}
    catch(error){progress({step:'connect',state:'warn',message:`Saved, but connecting failed: ${safeError(error).slice(0,200)}. Open it and reconnect.`});}
    return {agent:saved,copied:result.copied};
  }
  async redeployAgent(id,progress=()=>{}){
    const a=this.agent(id);if(!a.clone)throw new Error('This agent is not a clone.');
    if(this.turns.has(id))throw new Error('Stop this agent\'s current turn first.');
    const source=this.agent(a.clone.from),wasConnected=this.runtimeFor(id).status==='connected';
    this.disconnect(id);
    const result=await cloner.redeploy({agent:a,source,sourceHost:source.transport==='ssh'?this.host(source.hostId):null,host:a.transport==='ssh'?this.host(a.hostId):null,progress});
    if(wasConnected){progress({step:'connect',state:'active',message:`Reconnecting ${a.name}`});await this.connect(id).then(()=>progress({step:'connect',state:'done',message:`${a.name} is connected`}),()=>progress({step:'connect',state:'warn',message:'Reconnect failed. Open the agent and connect.'}));}
    return result;
  }
  // ---- MCP servers and skills ----------------------------------------------------------------------------------
  mcpSecrets(serverId){try{const raw=this.vault.get(mcp.vaultKey(serverId));return raw?JSON.parse(raw):{env:{},headers:{}};}catch{return {env:{},headers:{}};}}
  mcpFor(agentId){
    const list=mcp.acpServers(this.data.mcpServers||[],agentId,id=>this.mcpSecrets(id));
    // Built-in: Opaya's browser pane, for agents on this computer that were given it (right-click > Opaya browser).
    const a=this.data.agents.find(x=>x.id===agentId),b=this.browserBridge;
    // A text-only model cannot use a browser: it would read pages but miss everything shown as pictures.
    // Built-in: the Opaya Vault, so an agent on this computer can take a key it needs (the user approves each one).
    const v=this.vaultBridge;
    if(a&&v&&a.transport!=='ssh'&&a.command!=='docker'&&a.protocol!=='openai'&&a.protocol!=='terminal'&&this.data.settings?.vaultMcp!==false)list.push({name:'opaya-vault',command:v.command,args:v.args,env:[...Object.entries(v.env).map(([name,value])=>({name,value})),{name:'OPAYA_VAULT_AGENT',value:a.id}]});
    if(a?.browser&&b&&browserCapable(a)&&visionOf({...a,activeModel:this.runtimeFor(a.id).adapter?.currentModel}).vision!==false)list.push({name:'opaya-browser',command:b.command,args:b.args,env:Object.entries(b.env).map(([name,value])=>({name,value}))});
    return list;
  }
  async saveMcpServer({server:input,env,headers}){
    const existing=input?.id?this.data.mcpServers.find(s=>s.id===input.id):null;
    const saved=existing?this.mcpSecrets(existing.id):{env:{},headers:{}};
    // Empty text keeps the saved values; a line per variable replaces them all.
    const next=mcp.secrets({env,headers}),newSecrets=typeof env==='string'&&!!env.trim()||typeof headers==='string'&&!!headers.trim();
    const secret={env:typeof env==='string'&&env.trim()?next.env:saved.env,headers:typeof headers==='string'&&headers.trim()?next.headers:saved.headers};
    const s=mcp.server({...(existing||{}),...input,envNames:Object.keys(secret.env),headerNames:Object.keys(secret.headers)});
    if(this.data.mcpServers.some(x=>x.name===s.name&&x.id!==s.id))throw new Error(`An MCP server named ${s.name} already exists.`);
    if(!existing&&this.data.mcpServers.length>=64)throw new Error('MCP server limit reached (64).');
    if(s.type==='stdio'&&(!existing||existing.command!==s.command||JSON.stringify(existing.args)!==JSON.stringify(s.args))){
      if(!await this.approve({name:s.name},'Trust this MCP server?',`${s.command} ${s.args.join(' ')}\n\nAgents that use it start this program on the machine where they run, with that account's permissions.`))throw new Error('MCP server was not approved.');
    }
    const hasSecrets=Object.keys(secret.env).length||Object.keys(secret.headers).length;
    if(hasSecrets)await this.vault.set(mcp.vaultKey(s.id),JSON.stringify(secret),true);else if(existing)await this.vault.remove(mcp.vaultKey(s.id));
    this.data.mcpServers=existing?this.data.mcpServers.map(x=>x.id===s.id?s:x):[...this.data.mcpServers,s];
    await this.persist();
    const warnings=await this.syncMcpConfigs(existing,s,{changed:newSecrets||!existing||mcpDefinition(existing)!==mcpDefinition(s)});
    return {...mcp.publicView(s),...(warnings.length?{warnings}:{})};
  }
  // A one-click server from Opaya's catalog: only the typed key (masked in the page) and the folder come from the user.
  async installMcp({id,secret='',folder='',agents='all'}){
    const name=mcp.CATALOG.find(c=>c.id===id)?.name,existing=this.data.mcpServers.find(s=>s.name===name);
    const {server,env,headers}=mcp.fromCatalog(String(id||''),{secret,folder,agents,keep:!!existing&&(existing.envNames.length+existing.headerNames.length>0)});
    return this.saveMcpServer({server:{...server,...(existing?{id:existing.id}:{})},env,headers});
  }
  async removeMcpServer(id){
    id=schema.id(id);const s=this.data.mcpServers.find(x=>x.id===id);if(!s)throw new Error('MCP server not found.');
    const warnings=await this.syncMcpConfigs(s,null,{cancel:true});
    this.data.mcpServers=this.data.mcpServers.filter(x=>x.id!==id);await this.vault.remove(mcp.vaultKey(id));await this.persist();return warnings.length?{removed:true,warnings}:true;
  }
  // Turn one server on or off for one agent. ACP agents and Claude Code on this computer get it with their next new
  // conversation; Claude Code elsewhere, Codex and OpenClaw read it from their own config, where it is written now.
  async setAgentMcp({agentId,serverId,enabled}){
    const a=this.agent(agentId),s=this.data.mcpServers.find(x=>x.id===schema.id(serverId));if(!s)throw new Error('MCP server not found.');
    let list=s.agents==='all'?this.data.agents.map(x=>x.id):[...s.agents];
    list=enabled?[...new Set([...list,a.id])]:list.filter(x=>x!==a.id);
    const after={...s,agents:list.length===this.data.agents.length&&this.data.agents.every(x=>list.includes(x.id))?'all':list,enabled:enabled?true:s.enabled};
    await this.syncMcpConfigs(s,after,{cancel:true,strict:true});
    Object.assign(s,after);await this.persist();return mcp.publicView(s);
  }
  // Write a server into (or remove it from) the config of agents that read MCP servers only from there, after one
  // approval for all of them. before/after: the server as it was and is (null when new or removed). Returns warnings;
  // cancel: a declined approval throws; strict: a failed write throws.
  async syncMcpConfigs(before,after,{changed=false,cancel=false,strict=false}={}){
    const uses=s=>s?this.data.agents.filter(a=>mcp.appliesTo(s,a.id)&&mcpConfig.written(a)):[];
    const was=uses(before),now=uses(after),renamed=!!(before&&after&&before.name!==after.name);
    const on=now.filter(a=>changed||renamed||!was.includes(a)),off=was.filter(a=>renamed||!now.includes(a));
    if(!on.length&&!off.length)return [];
    const host=a=>a.transport==='ssh'?this.host(a.hostId):null,at=a=>`${a.name}${host(a)?` on ${host(a).name}`:''}`;
    const lines=[...off.map(a=>`Remove "${before.name}" from ${mcpConfig.LABEL[mcpConfig.mode(a)]} of ${at(a)}`),...on.map(a=>`Add "${after.name}" to ${mcpConfig.LABEL[mcpConfig.mode(a)]} of ${at(a)}`)];
    const n=new Set([...on,...off]).size,one=[...on,...off][0];
    const title=off.length&&!on.length?`Remove MCP server ${before.name} from ${n===1?one.name:`${n} agents`}?`:`Write MCP server ${after.name} into ${n===1?`${one.name}'s`:`${n} agents'`} config?`;
    if(!await this.approve({name:(after||before).name},title,`${lines.join('\n')}\n\nThese agents read MCP servers only from their own config. Keys and tokens go from Opaya's vault into the file (mode 600), never into a command line or the chat. Other entries stay as they are.`)){
      if(cancel)throw new Error('MCP change cancelled.');return ['Not written into agent configs: declined.'];
    }
    const warnings=[],secret=after?this.mcpSecrets(after.id):{};
    for(const [list,server,enabled] of [[off,before,false],[on,after,true]])for(const a of list){
      try{await mcpConfig.write({agent:a,host:host(a),server,secret:enabled?secret:{},enabled});}
      catch(error){if(strict)throw error;warnings.push(`${a.name}: ${safeError(error)}`);}
    }
    return warnings;
  }
  async skills(id){const a=this.agent(id);return listSkills(a,a.transport==='ssh'?this.host(a.hostId):null);}
  async connectAll({ids}={}){
    const targets=this.data.agents.filter(a=>(!ids||ids.includes(a.id))&&a.protocol!=='terminal'&&!['connected','connecting'].includes(this.runtimeFor(a.id).status));
    const results=await Promise.all(targets.map(a=>this.connect(a.id).then(()=>({id:a.id,ok:true}),error=>({id:a.id,ok:false,error:safeError(error)}))));
    return {attempted:results.length,connected:results.filter(r=>r.ok&&this.runtimeFor(r.id).status==='connected').length,failed:results.filter(r=>!r.ok||this.runtimeFor(r.id).status!=='connected').map(r=>({id:r.id,name:this.agent(r.id).name,error:r.error||this.runtimeFor(r.id).error||'Not connected'}))};
  }
  async reorderAgents({id,direction}){
    id=schema.id(id);if(!['up','down'].includes(direction))throw new Error('Unsupported reorder direction.');
    const index=this.data.agents.findIndex(a=>a.id===id);if(index<0)throw new Error('Agent not found.');
    const target=direction==='up'?index-1:index+1;if(target<0||target>=this.data.agents.length)return false;
    const [agent]=this.data.agents.splice(index,1);this.data.agents.splice(target,0,agent);await this.persist();return true;
  }
  async connect(id){
    const a=this.agent(id),r=this.runtimeFor(id);
    if(r.status==='connected')return;
    if(this.connecting.has(id))return this.connecting.get(id);
    const job=(async()=>{
      r.status='connecting';r.error='';this.changed();
      const generation=(r.generation||0)+1;r.generation=generation;
      if(a.transport!=='ssh')await primeShellPath(); // local CLIs installed with nvm, Volta or Homebrew
      let adapter,token='';
      try{
        token=this.vault.get(id);adapter=this.adapterFactory({agent:a,host:a.transport==='ssh'?this.host(a.hostId):null,token,approve:this.approve,trusted:()=>this.isTrusted(a.id),mcpServers:()=>this.mcpFor(a.id),onChange:()=>this.changed()});r.adapter=adapter;
        const info=await adapter.connect();
        if(r.generation!==generation){adapter.close();return;}
        Object.assign(r,info,{status:'connected'});
        const closed=error=>{if(r.adapter!==adapter||r.generation!==generation)return;r.status='error';r.error=safeError(error,token);this.changed();try{this.onAgentError?.(a,r.error,'dropped');}catch{}};
        adapter.rpc?.on('closed',closed);adapter.tunnel?.on('closed',closed);
      }catch(error){adapter?.close();if(r.generation===generation){r.adapter=null;r.status='error';r.error=safeError(error,token);}try{this.onConnectError?.(a,safeError(error,token));}catch{}throw new Error(safeError(error,token));}
      finally{this.changed();}
    })();
    this.connecting.set(id,job);try{return await job;}finally{this.connecting.delete(id);}
  }
  disconnect(id){
    this.stop(id);const r=this.runtimeFor(id);r.generation=(r.generation||0)+1;const adapter=r.adapter;r.adapter=null;r.status='disconnected';r.error='';adapter?.close();this.changed();
  }
  clearError(id){
    this.agent(id);const r=this.runtimeFor(id);r.error='';if(r.status==='error')r.status='disconnected';this.changed();return true;
  }
  async models(id){
    const a=this.agent(id);if(this.turns.has(id))throw new Error('Wait for the current turn before refreshing models.');
    await this.connect(id);const r=this.runtimeFor(id);
    if(r.adapter.listModels)r.models=await r.adapter.listModels();
    r.models=(r.models||[]).filter(m=>typeof m==='string'&&m.length<=256).slice(0,500);
    this.changed();return {models:r.models||[],selected:a.model||''};
  }
  // scope 'default' sets the agent's model for every chat; scope 'conversation' overrides it for one chat only.
  async selectModel({id,model,scope='default',conversationId}){
    const a=this.agent(id);if(this.turns.has(id)||this.connecting.has(id))throw new Error('Wait for the current operation before changing models.');
    model=schema.text(model,'model',256).trim();
    // An ACP agent that lists its models must get one of them; one that lists none takes the name the user typed.
    const known=this.runtimeFor(id).models||[];
    if(a.protocol==='acp'&&model&&known.length&&!known.includes(model)&&!model.includes(':'))throw new Error('Refresh models and choose an available ACP model.');
    if(a.protocol==='terminal')throw new Error('Choose the model in this agent\'s CLI.');
    if(scope==='conversation'){const c=this.data.conversations.find(c=>c.id===schema.id(conversationId)&&c.agentId===a.id);if(!c)throw new Error('Start a conversation first.');c.model=model;await this.persist();return true;}
    a.model=model;await this.persist();return true;
  }
  // Reasoning effort, like the model: scope 'default' for every chat of the agent, 'conversation' for one chat. '' is the
  // agent's own setting (for a chat: the agent default). It applies from the next message, so a running answer is fine.
  async selectEffort({id,effort,scope='default',conversationId}){
    const a=this.agent(id);effort=schema.effort(effort);
    if(!['default','conversation'].includes(scope))throw new Error('Choose default or conversation.');
    const offered=effortLevels(a,this.runtimeFor(a.id).adapter);
    if(effort&&!offered.includes(effort))throw new Error(offered.length?`${a.displayName||a.name} takes these reasoning efforts: ${offered.join(', ')}.`:`${a.displayName||a.name} has no reasoning effort setting.`);
    if(scope==='conversation'){const c=this.data.conversations.find(c=>c.id===schema.id(conversationId)&&c.agentId===a.id);if(!c)throw new Error('Start a conversation first.');c.effort=effort;await this.persist();return true;}
    a.effort=effort;await this.persist();return true;
  }
  async gateway({id,operation}){
    const a=this.agent(id);if(this.turns.has(id))throw new Error('Stop this agent\'s current turn first.');
    if(!['status','restart'].includes(operation))throw new Error('Unsupported gateway operation.');
    if(operation==='restart'&&!await this.approve(a,'Restart this gateway?',`Restart only ${a.name} on ${a.transport==='ssh'?this.host(a.hostId).name:'this computer'}. Its gateway connections will briefly disconnect.`))throw new Error('Gateway restart cancelled.');
    const wasConnected=this.runtimeFor(id).status==='connected';
    if(operation==='restart')this.disconnect(id);
    const output=await gatewayOperation(a,a.transport==='ssh'?this.host(a.hostId):null,operation);
    if(operation==='restart'&&wasConnected){
      let error;for(let attempt=0;attempt<8;attempt++){try{await this.connect(id);error=null;break;}catch(e){error=e;await new Promise(r=>setTimeout(r,1500));}}
      if(error)throw new Error('Restart command finished, but reconnect failed: '+safeError(error));
    }
    return {output:safeError(output||'Command completed.'),operation};
  }
  async send({agentId,conversationId,text,attachments}){
    this.agent(agentId);const files=attach.check(attachments);text=schema.prompt(text??'',{empty:files.length>0});
    if(this.closing)throw new Error('Opaya is closing.');
    if(this.turns.has(agentId))throw new Error('This agent is already working. Stop or wait for the active turn.');
    const r=this.runtimeFor(agentId);
    if(r.status!=='connected'||!r.adapter)throw new Error('Connect this agent before sending a message.');
    const adapter=r.adapter,token=this.vault.get(agentId),abort=new AbortController();
    // Reserve BEFORE any asynchronous disk access: IPC calls can arrive together.
    let finishDone;const turn={abort,startedAt:Date.now(),done:new Promise(resolve=>{finishDone=resolve;})};
    this.turns.set(agentId,turn);this.changed();
    let c,messages,assistant,timeout,emitTimer,checkpoint;
    try{
      // What each attached file is, read before any chat is created, so a missing file changes nothing.
      const items=files.length?await attach.load(files,{root:this.store.root}):[];
      c=this.data.conversations.find(x=>x.id===conversationId&&x.agentId===agentId);
      if(!c){if(conversationId)throw new Error('Conversation does not belong to this agent.');c=await this.createConversation(agentId);}
      turn.conversationId=c.id;
      messages=this.histories.get(c.id)||await this.store.transcript(c.id);this.histories.set(c.id,messages);
      if(abort.signal.aborted)throw new Error('Turn cancelled before it was sent.');
      // Pasted files are saved in this chat's attachments folder; the transcript keeps only name, size, type and kind.
      if(items.length)await attach.save(items,{root:this.store.root,conversationId:c.id});
      const user={id:randomUUID(),role:'user',content:text,status:'done',createdAt:new Date().toISOString(),...(items.length?{attachments:attach.meta(items)}:{})};
      assistant={id:randomUUID(),role:'assistant',content:'',status:'streaming',activity:[],createdAt:new Date().toISOString()};
      messages.push(user,assistant);if(c.title==='New conversation')c.title=(text.trim()?text:items.map(i=>i.name).join(', ')).slice(0,65).replace(/\s+/g,' ');
      delete this.data.drafts[conversationId||agentId];
      await this.store.writeTranscript(c.id,messages);await this.persist();
      if(abort.signal.aborted)throw new Error('Turn cancelled before it was sent.');
      // Inactivity limit, not a hard cap: long agent tasks that keep reporting progress are never cut off.
      const idle=()=>{clearTimeout(timeout);timeout=setTimeout(()=>{turn.reason='No response from the agent for 15 minutes, so Opaya stopped waiting. The task may still be running on the agent.';abort.abort();},15*60*1000);timeout.unref?.();};idle();
      checkpoint=setInterval(()=>{this.store.writeTranscript(c.id,messages).catch(()=>{assistant.error='Disk checkpoint failed. Keep this window open and export the transcript.';this.changed();});},750);checkpoint.unref?.();
      const onEvent=event=>{
        if(abort.signal.aborted||assistant.status!=='streaming')return;
        idle();turn.lastEventAt=Date.now();turn.lastEvent=event.type==='activity'?String(event.text||'').slice(0,200):turn.lastEvent;
        if(event.type==='text'){
          if(typeof event.text!=='string')return;
          assistant.content+=event.text;
          if(assistant.content.length>2*1024*1024){abort.abort();adapter.close();return;}
        }else if(event.type==='activity'){
          const text=String(event.text||'').trim().slice(0,500),last=assistant.activity.at(-1);
          if(text&&text!==last)assistant.activity=[...assistant.activity.slice(-79),text];
        }
        if(!emitTimer)emitTimer=setTimeout(()=>{emitTimer=null;this.changed();},40);
      };
      const refused=()=>{const text=`${assistant.content||''} ${assistant.error||''}`;if(!CLIENT_REFUSED.test(text))return;const a=this.data.agents.find(x=>x.id===agentId);if(!a||a.surface==='terminal')return;a.surface='terminal';this.onClientRefused?.(a,text.trim().slice(0,400));}; // saved with the turn below
      turn.task=Promise.resolve().then(()=>{
        if(abort.signal.aborted)throw new Error('Turn cancelled before it was sent.');
        const a=this.agent(agentId);
        return adapter.run({text,attachments:items,effort:c.effort||a.effort||'',filesDir:attach.folder(this.store.root,c.id),messages:messages.filter(m=>m!==assistant),conversation:c,cwd:this.conversationCwd(c,a),signal:abort.signal,onEvent,onSession:async sessionId=>{c.externalSessionId=sessionId;await this.store.write(this.data);}});
      }).then(result=>{
        if(abort.signal.aborted){assistant.status='cancelled';assistant.error=turn.reason||'Stopped. The answer so far is kept and the agent stays connected.';}else assistant.status='done';
        if(result?.externalSessionId)c.externalSessionId=result.externalSessionId;
      }).catch(error=>{assistant.status=abort.signal.aborted?'cancelled':'error';assistant.error=abort.signal.aborted?(turn.reason||'Stopped. The answer so far is kept and the agent stays connected.'):safeError(error,token);}).finally(async()=>{
        clearTimeout(timeout);clearTimeout(emitTimer);clearInterval(checkpoint);refused();
        if(assistant.status==='error'&&!CLIENT_REFUSED.test(`${assistant.content||''} ${assistant.error||''}`)){const a=this.data.agents.find(x=>x.id===agentId);try{if(a)this.onAgentError?.(a,assistant.error,'turn');}catch{}}
        try{await this.store.writeTranscript(c.id,messages);await this.store.write(this.data);}catch{assistant.error='Could not save the final transcript to disk. Export it before closing.';}
        if(this.turns.get(agentId)===turn)this.turns.delete(agentId);
        if(assistant.status==='done'||assistant.status==='error'){try{this.onReply?.(this.data.agents.find(x=>x.id===agentId),c,assistant);}catch{}}
        finishDone();this.changed();
      });
      this.changed();return {conversationId:c.id,messageId:assistant.id};
    }catch(error){
      clearInterval(checkpoint);if(assistant){assistant.status=abort.signal.aborted?'cancelled':'error';assistant.error='No agent request was sent: '+safeError(error,token);await this.store.writeTranscript(c.id,messages).catch(()=>{});}
      this.turns.delete(agentId);finishDone();this.changed();throw error;
    }
  }
  // Stop cancels the current answer only. Adapters cancel through the abort signal (HTTP abort, ACP session/cancel,
  // Codex turn/interrupt, Claude per-turn process), so the connection stays usable. An agent that ignores the cancel
  // for 15 seconds gets its connection reset so it cannot keep writing into the chat.
  stop(id){
    const turn=this.turns.get(id);if(!turn)return;turn.abort.abort();this.changed();
    const guard=setTimeout(()=>{if(this.turns.get(id)!==turn)return;const r=this.runtimeFor(id);r.adapter?.close();r.adapter=null;r.status='disconnected';r.error='The agent did not stop within 15 seconds, so its connection was reset. Reconnect to continue.';this.changed();},15000);guard.unref?.();
  }
  async discover({hostId,extraHome}={}){
    if(this.scanBusy)throw new Error('A discovery scan is already running.');this.scanBusy=true;
    try{const result=hostId?await scanRemote(this.host(hostId)):await scanLocal({extraHomes:extraHome?[schema.text(extraHome,'folder',2048)]:[]});for(const candidate of result.agents){const existing=this.data.agents.find(a=>fingerprint(a)===fingerprint(candidate));if(existing)candidate.existingId=existing.id;}return result;}
    finally{this.scanBusy=false;}
  }
  async close(){this.closing=true;for(const a of this.data.agents)this.disconnect(a.id);await Promise.allSettled([...this.turns.values()].map(t=>t.done));await this.store.queue;}
}
module.exports={Broker,safeError,browserCapable,CLIENT_REFUSED};
