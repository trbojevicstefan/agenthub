'use strict';
const {randomUUID}=require('node:crypto');
const schema=require('./schema.cjs');
const {scanLocal,scanRemote,fingerprint}=require('./discovery.cjs');
const {createAdapter}=require('./adapters/index.cjs');
const {importGatewayToken}=require('./credentials.cjs');
const {gatewayOperation}=require('./management.cjs');
function safeError(error,token=''){
  let value=String(error?.message||error||'Operation failed.');
  if(token)value=value.split(token).join('[redacted]');
  return value.replace(/\x1b\[[0-9;]*[A-Za-z]/g,'').replace(/(Bearer\s+)[^\s]+/gi,'$1[redacted]').replace(/\bsk-[A-Za-z0-9_-]{12,}/g,'[redacted]').slice(0,2400);
}
class Broker{
  constructor({store,vault,emit,approve,adapterFactory=createAdapter}){
    Object.assign(this,{store,vault,emit,approve,adapterFactory});this.runtime=new Map();this.histories=new Map();this.turns=new Map();this.connecting=new Map();this.scanBusy=false;this.closing=false;
  }
  async init(){
    await this.vault.load();this.data=await this.store.load();
    this.data.drafts=this.data.drafts||{};this.data.lastConversation=this.data.lastConversation||{};this.data.view=this.data.view||{};
    this.data.agents=this.data.agents.map(a=>schema.agent(a));this.data.hosts=this.data.hosts.map(h=>schema.host(h));
    this.data.activeAgentId=this.data.agents.some(a=>a.id===this.data.activeAgentId)?this.data.activeAgentId:this.data.agents[0]?.id||'';
    for(const a of this.data.agents)this.runtime.set(a.id,{status:'disconnected',error:'',models:[]});
    for(const c of this.data.conversations){schema.id(c.id);schema.id(c.agentId);}
    for(const c of this.data.conversations.slice(-100))this.histories.set(c.id,await this.store.transcript(c.id));
    // An app crash may have left streaming placeholders on disk.
    for(const [id,messages] of this.histories){let recovered=false;for(const m of messages)if(m.status==='streaming'){m.status='error';m.error='The session service stopped during this turn. Saved partial output is preserved. Check the agent before retrying.';recovered=true;}if(recovered)await this.store.writeTranscript(id,messages);}
    return this.snapshot();
  }
  agent(id){const a=this.data.agents.find(a=>a.id===schema.id(id));if(!a)throw new Error('Agent not found.');return a;}
  host(id){const h=this.data.hosts.find(h=>h.id===schema.id(id));if(!h)throw new Error('Host not found.');return h;}
  runtimeFor(id){if(!this.runtime.has(id))this.runtime.set(id,{status:'disconnected',error:'',models:[]});return this.runtime.get(id);}
  snapshot(){
    const {agents,hosts,conversations,activeAgentId,activeConversationId}=this.data;
    return {version:'0.2.1',drafts:this.data.drafts,view:this.data.view,recoveryNotice:this.data.recoveryNotice||'',agents:agents.map(a=>{const r=this.runtimeFor(a.id);return {...a,status:r.status,error:r.error||'',adapterDescription:r.description||'',models:r.models||[],hasToken:this.vault.has(a.id),busy:this.turns.has(a.id)};}),hosts,conversations,activeAgentId,activeConversationId:activeConversationId||'',histories:Object.fromEntries([...this.histories].filter(([id])=>id===activeConversationId||Object.values(this.data.playground?.conversations||{}).includes(id))),playground:this.data.playground||null,secureStorage:this.vault.available(),platform:process.platform};
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
  async saveAgent({agent:input,token,remember=true,importToken=false}){
    const a=schema.agent(input);if(a.transport==='ssh')this.host(a.hostId);
    const existing=this.data.agents.find(x=>x.id===a.id);
    if(existing&&this.turns.has(a.id))throw new Error('Stop the active turn before editing this agent.');
    if(!existing&&this.data.agents.length>=128)throw new Error('Workspace limit reached (128 agents).');
    const duplicate=this.data.agents.find(x=>x.id!==a.id&&fingerprint(x)===fingerprint(a));
    if(duplicate)throw new Error(`This connection already exists as ${duplicate.name}.`);
    if(a.protocol!=='openai'&&(!existing||existing.command!==a.command||JSON.stringify(existing.args)!==JSON.stringify(a.args)||existing.hermesHome!==a.hermesHome)){
      const ok=await this.approve(a,'Trust this agent executable?',`${a.command} ${a.args.join(' ')}\n${a.transport==='ssh'?'Runs on '+this.host(a.hostId).name:'Runs on this computer'}\n\nThe agent can use the permissions of that OS account. Hermes ACP starts a new process: do not run it against a profile already used by a gateway.`);
      if(!ok)throw new Error('Agent executable was not approved.');
    }
    if(importToken){
      const ok=await this.approve(a,'Import this Hermes gateway token?',`Read only API_SERVER_KEY from ${a.hermesHome}/.env${a.transport==='ssh'?' over verified SSH':''}. Provider API keys are not imported. The token stays in Opaya\'s native process and OS-encrypted vault.`);
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
    for(const c of conversations){this.histories.delete(c.id);delete this.data.drafts[c.id];await this.store.deleteTranscript(c.id);}
    delete this.data.drafts[id];delete this.data.lastConversation[id];
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
        if(!c)c=await this.createConversation(id,{activate:false,title:`Playground: ${text.slice(0,50).replace(/\s+/g,' ')}`});
        conversations[id]=c.id;
      }catch(error){errors[id]=safeError(error);}
    }
    this.data.playground={agentIds:ids,prompt:text,keepContext:!!keepContext,conversations,errors,at:new Date().toISOString()};
    await Promise.all(ids.filter(id=>conversations[id]).map(id=>this.send({agentId:id,conversationId:conversations[id],text}).catch(error=>{errors[id]=safeError(error);})));
    await this.persist();return this.data.playground;
  }
  async newConversation(agentId){
    this.agent(agentId);if(this.turns.has(agentId))throw new Error('Wait for or stop this agent\'s current turn first.');
    return this.createConversation(agentId);
  }
  async createConversation(agentId,{activate=true,title='New conversation'}={}){
    if(this.data.conversations.length>=2000)throw new Error('Conversation limit reached. Export and remove old agent connections.');
    const c={id:randomUUID(),agentId,title,createdAt:new Date().toISOString(),externalSessionId:''};
    this.data.conversations.push(c);this.histories.set(c.id,[]);if(activate){this.data.activeConversationId=c.id;this.data.activeAgentId=agentId;this.data.lastConversation[agentId]=c.id;}await this.persist();return c;
  }
  async selectConversation(id){const c=this.data.conversations.find(c=>c.id===schema.id(id));if(!c)throw new Error('Conversation not found.');this.data.activeAgentId=c.agentId;this.data.activeConversationId=c.id;this.data.lastConversation[c.agentId]=c.id;if(!this.histories.has(c.id))this.histories.set(c.id,await this.store.transcript(c.id));await this.persist();}
  async saveDraft({agentId,conversationId='',text=''}){
    this.agent(agentId);if(typeof text!=='string'||text.length>80000||text.includes('\0'))throw new Error('Invalid draft.');
    if(conversationId&&!this.data.conversations.some(c=>c.id===conversationId&&c.agentId===agentId))throw new Error('Draft conversation does not belong to this agent.');
    const key=conversationId||agentId;this.data.drafts[key]=text;await this.store.write(this.data);return true;
  }
  async saveView(input){
    this.data.view={overview:!!input.overview,opaya:!!input.opaya,playground:!!input.playground,collapsed:Array.isArray(input.collapsed)?[...new Set(input.collapsed.filter(x=>typeof x==='string'&&x.length<=60))].slice(0,100):[],terminalVisible:!!input.terminalVisible,terminalId:input.terminalId?schema.id(input.terminalId):'',theme:input.theme==='light'?'light':'dark'};await this.store.write(this.data);return true;
  }
  async updateAgentDisplay({id,displayName,pinned,avatar,group,tags}){
    const index=this.data.agents.findIndex(a=>a.id===schema.id(id));if(index<0)throw new Error('Agent not found.');
    const a={...this.data.agents[index]};
    if(displayName!==undefined)a.displayName=schema.text(displayName,'display name',80).trim();
    if(pinned!==undefined)a.pinned=Boolean(pinned);
    if(avatar!==undefined)a.avatar=schema.avatar(avatar);
    if(group!==undefined)a.group=schema.group(group);
    if(tags!==undefined)a.tags=schema.tags(tags);
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
      let adapter,token='';
      try{
        token=this.vault.get(id);adapter=this.adapterFactory({agent:a,host:a.transport==='ssh'?this.host(a.hostId):null,token,approve:this.approve});r.adapter=adapter;
        const info=await adapter.connect();
        if(r.generation!==generation){adapter.close();return;}
        Object.assign(r,info,{status:'connected'});
        const closed=error=>{if(r.adapter!==adapter||r.generation!==generation)return;r.status='error';r.error=safeError(error,token);this.changed();};
        adapter.rpc?.on('closed',closed);adapter.tunnel?.on('closed',closed);
      }catch(error){adapter?.close();if(r.generation===generation){r.adapter=null;r.status='error';r.error=safeError(error,token);}throw new Error(safeError(error,token));}
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
    if(a.protocol==='acp'&&model&&!(this.runtimeFor(id).models||[]).includes(model))throw new Error('Refresh models and choose an available ACP model.');
    if(a.protocol==='terminal')throw new Error('Choose the model in this agent\'s CLI.');
    if(scope==='conversation'){const c=this.data.conversations.find(c=>c.id===schema.id(conversationId)&&c.agentId===a.id);if(!c)throw new Error('Start a conversation first.');c.model=model;await this.persist();return true;}
    a.model=model;await this.persist();return true;
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
  async send({agentId,conversationId,text}){
    this.agent(agentId);text=schema.prompt(text);
    if(this.closing)throw new Error('Opaya is closing.');
    if(this.turns.has(agentId))throw new Error('This agent is already working. Stop or wait for the active turn.');
    const r=this.runtimeFor(agentId);
    if(r.status!=='connected'||!r.adapter)throw new Error('Connect this agent before sending a message.');
    const adapter=r.adapter,token=this.vault.get(agentId),abort=new AbortController();
    // Reserve BEFORE any asynchronous disk access: IPC calls can arrive together.
    let finishDone;const turn={abort,done:new Promise(resolve=>{finishDone=resolve;})};
    this.turns.set(agentId,turn);this.changed();
    let c,messages,assistant,timeout,emitTimer,checkpoint;
    try{
      c=this.data.conversations.find(x=>x.id===conversationId&&x.agentId===agentId);
      if(!c){if(conversationId)throw new Error('Conversation does not belong to this agent.');c=await this.createConversation(agentId);}
      turn.conversationId=c.id;
      messages=this.histories.get(c.id)||await this.store.transcript(c.id);this.histories.set(c.id,messages);
      if(abort.signal.aborted)throw new Error('Turn cancelled before it was sent.');
      const user={id:randomUUID(),role:'user',content:text,status:'done',createdAt:new Date().toISOString()};
      assistant={id:randomUUID(),role:'assistant',content:'',status:'streaming',activity:[],createdAt:new Date().toISOString()};
      messages.push(user,assistant);if(c.title==='New conversation')c.title=text.slice(0,65).replace(/\s+/g,' ');
      delete this.data.drafts[conversationId||agentId];
      await this.store.writeTranscript(c.id,messages);await this.persist();
      if(abort.signal.aborted)throw new Error('Turn cancelled before it was sent.');
      // Inactivity limit, not a hard cap: long agent tasks that keep reporting progress are never cut off.
      const idle=()=>{clearTimeout(timeout);timeout=setTimeout(()=>{turn.reason='No response from the agent for 15 minutes, so Opaya stopped waiting. The task may still be running on the agent.';abort.abort();},15*60*1000);timeout.unref?.();};idle();
      checkpoint=setInterval(()=>{this.store.writeTranscript(c.id,messages).catch(()=>{assistant.error='Disk checkpoint failed. Keep this window open and export the transcript.';this.changed();});},750);checkpoint.unref?.();
      const onEvent=event=>{
        if(abort.signal.aborted||assistant.status!=='streaming')return;
        idle();
        if(event.type==='text'){
          if(typeof event.text!=='string')return;
          assistant.content+=event.text;
          if(assistant.content.length>2*1024*1024){abort.abort();adapter.close();return;}
        }else if(event.type==='activity')assistant.activity=[...assistant.activity.slice(-39),String(event.text).slice(0,500)];
        if(!emitTimer)emitTimer=setTimeout(()=>{emitTimer=null;this.changed();},40);
      };
      turn.task=Promise.resolve().then(()=>{
        if(abort.signal.aborted)throw new Error('Turn cancelled before it was sent.');
        return adapter.run({text,messages:messages.filter(m=>m!==assistant),conversation:c,signal:abort.signal,onEvent,onSession:async sessionId=>{c.externalSessionId=sessionId;await this.store.write(this.data);}});
      }).then(result=>{
        if(abort.signal.aborted){assistant.status='cancelled';assistant.error=turn.reason||'Stopped. The answer so far is kept and the agent stays connected.';}else assistant.status='done';
        if(result?.externalSessionId)c.externalSessionId=result.externalSessionId;
      }).catch(error=>{assistant.status=abort.signal.aborted?'cancelled':'error';assistant.error=abort.signal.aborted?(turn.reason||'Stopped. The answer so far is kept and the agent stays connected.'):safeError(error,token);}).finally(async()=>{
        clearTimeout(timeout);clearTimeout(emitTimer);clearInterval(checkpoint);
        try{await this.store.writeTranscript(c.id,messages);await this.store.write(this.data);}catch{assistant.error='Could not save the final transcript to disk. Export it before closing.';}
        if(this.turns.get(agentId)===turn)this.turns.delete(agentId);
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
module.exports={Broker,safeError};
