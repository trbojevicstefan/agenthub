'use strict';
const {Rpc}=require('../rpc.cjs');
const {launch}=require('../process.cjs');
const {ConnectionLog}=require('../diagnostics.cjs');
const attach=require('../attachments.cjs');
const levels=require('../effort.cjs');
function sessionCwd(agent){
  return agent.command==='docker'&&agent.provider==='hermes'&&agent.hermesHome?agent.hermesHome:agent.cwd;
}
const short=value=>String(value??'').replace(/\s+/g,' ').trim().slice(0,300);
function activityOf(update){
  const kind=update.sessionUpdate;
  if(kind==='agent_thought_chunk')return 'Thinking';
  if(kind==='plan'){
    const entries=Array.isArray(update.entries)?update.entries:[];
    const active=entries.find(e=>e?.status==='in_progress'),done=entries.filter(e=>e?.status==='completed').length;
    return active?`Plan ${done}/${entries.length}: ${short(active.content)}`:entries.length?`Plan: ${done}/${entries.length} complete`:'Plan updated';
  }
  if(!['tool_call','tool_call_update'].includes(kind))return '';
  const title=short(update.title||update.toolCall?.title||update.name||update.kind||'Agent tool');
  const status=short(update.status||update.toolCall?.status||'');
  const locations=Array.isArray(update.locations)?update.locations:Array.isArray(update.toolCall?.locations)?update.toolCall.locations:[];
  const location=locations.map(x=>short(x?.path||x?.uri||x)).filter(Boolean).slice(0,2).join(', ');
  return [title,status&&status!=='pending'?status:'',location].filter(Boolean).join(' — ');
}
// Hermes on Windows starts Git Bash the first time a terminal or file tool runs. Some Hermes versions hang there when
// they run under an ACP client (NousResearch/hermes-agent#73403). These stderr lines mark the start and the end.
const ENV_START=/Creating new (\S+) environment for/,ENV_READY=/environment ready for|Session snapshot created|init_session failed/;
const ENV_STALL_MS=30000;
const envHint=agent=>`${agent.provider==='hermes'?'Hermes':'The agent'} is still starting its local terminal after 30 seconds. On Windows this is a known Hermes issue with Git Bash under ACP: run \`hermes update\` in Terminal and reconnect. If it persists, connect this Hermes through its gateway API (hermes gateway) instead of ACP.`;
// Values of a select config option; options may be grouped.
const flat=list=>(Array.isArray(list)?list:[]).flatMap(o=>Array.isArray(o?.options)?flat(o.options):[o?.value]).filter(v=>typeof v==='string');
const commandList=list=>(Array.isArray(list)?list:[]).filter(c=>c&&typeof c.name==='string'&&/^[\w.:-]{1,64}$/.test(c.name)).slice(0,200).map(c=>({name:c.name,description:String(c.description||'').slice(0,300),hint:String(c.input?.hint||'').slice(0,120)}));
class AcpAdapter {
  constructor({agent,host,approve,spawnAgent=launch,mcpServers=()=>[],onChange=()=>{},trusted=()=>false,envStallMs=ENV_STALL_MS}){this.trusted=trusted;this.envStallMs=envStallMs;this.agent=agent;this.host=host;this.approve=approve;this.spawnAgent=spawnAgent;this.mcpServers=mcpServers;this.onChange=onChange;this.sessions=new Map();this.active=null;this.log=new ConnectionLog();this.tools=new Map();this.permission=null;this.envStart=null;this.commands=[];this.agentInfo=null;this.levels=new Map();this.lastLevels=[];this.levelDefault='';this.effortNoted=new Set();}
  // Reasoning effort: the levels of the thought_level config option the agent's sessions have ([] when they have none).
  get efforts(){return this.lastLevels;}
  watchStderr(text){
    for(const line of String(text).split(/\r?\n/)){
      if(ENV_START.test(line))this.envStart={at:Date.now(),warned:false};
      else if(ENV_READY.test(line))this.envStart=null;
    }
  }
  // MCP servers from Opaya's library, limited to the transports this agent says it supports. Stdio is always supported.
  sessionMcp(){
    const caps=this.capabilities?.mcpCapabilities||this.capabilities?.mcp||{};
    return (this.mcpServers()||[]).filter(s=>!s.type||s.type==='stdio'?true:!!caps[s.type]).map(({type,...s})=>type&&type!=='stdio'?{type,...s}:s);
  }
  async connect(){
    const args=[...this.agent.args];
    if(this.agent.provider==='hermes'&&!args.includes('acp'))args.push('acp');
    this.log.add('info',`Starting ${this.agent.command} ${args.join(' ')}`);
    this.rpc=new Rpc(this.spawnAgent(this.agent,args,this.host),{log:(direction,text)=>{this.log.add(direction,text);if(direction==='stderr')this.watchStderr(text);},onRequest:async(method,params)=>{
      if(method!=='session/request_permission')throw new Error('Client filesystem and terminal capabilities are not enabled.');
      if(!this.active||params.sessionId!==this.active.sessionId||this.active.signal.aborted)return {outcome:{outcome:'cancelled'}};
      const options=Array.isArray(params.options)?params.options:[];
      // Prefer a one-time allow; some agents only offer allow_always. Either way the user decides in a native dialog.
      const allow=options.find(o=>o.kind==='allow_once')||options.find(o=>o.kind==='allow_always');
      if(!allow){this.log.add('info','Permission request had no allow option; cancelled.');return {outcome:{outcome:'cancelled'}};}
      const pending=this.active,title=String(params.toolCall?.title||'Agent tool request');
      // Opaya's own tools (its browser and Vault, which asks the user itself) are Opaya's to allow: no dialog for each page.
      if(/\bopaya[_-]?(browser|vault)\b|\bopaya_(open|read|screenshot|click|type|scroll|back)\b|mcp[_-]+opaya/i.test(`${title} ${params.toolCall?.toolName||''} ${params.toolCall?.kind||''} ${JSON.stringify(params.toolCall?.rawInput||{}).slice(0,200)}`)){const pick=options.find(o=>o.kind==='allow_always')||allow;pending.onEvent({type:'activity',text:`Opaya allowed: ${title}`});return {outcome:{outcome:'selected',optionId:pick.optionId}};}
      // iTrust: approve on the agent's own terms (prefer "always" so it stops asking), without a dialog.
      if(this.trusted()){const pick=options.find(o=>o.kind==='allow_always')||allow;pending.onEvent({type:'activity',text:`iTrust approved: ${title}`});this.log.add('info',`iTrust approved: ${title}`);return {outcome:{outcome:'selected',optionId:pick.optionId}};}
      this.permission={title,since:Date.now()};pending.onEvent({type:'activity',text:`Waiting for your approval: ${title}`});
      let accepted;try{accepted=await this.approve(this.agent, title, JSON.stringify(params.toolCall?.rawInput||params.toolCall||{},null,2).slice(0,5000));}finally{this.permission=null;}
      pending.onEvent({type:'activity',text:`${accepted?'Approved':'Declined'}: ${title}`});
      if(!accepted||this.active!==pending||pending.signal.aborted)return {outcome:{outcome:'cancelled'}};
      return {outcome:{outcome:'selected',optionId:allow.optionId}};
    }});
    this.rpc.on('notification',(method,params)=>{
      if(method!=='session/update')return;
      const update=params?.update||{};
      // Slash commands (Hermes: /tools, /model, /compress ...) are advertised per session; they are the same for all.
      if(update.sessionUpdate==='available_commands_update'){this.commands=commandList(update.availableCommands);this.onChange();return;}
      if(update.sessionUpdate==='config_option_update'){this.readConfig(params?.sessionId,update.configOptions);return;}
      if(!this.active||params.sessionId!==this.active.sessionId)return;
      // Track tool calls so diagnostics can say which tool is still running and for how long.
      if(['tool_call','tool_call_update'].includes(update.sessionUpdate)){const id=update.toolCallId||update.toolCall?.toolCallId||update.title;const status=update.status||update.toolCall?.status||'';const prev=this.tools.get(id);
        if(['completed','failed'].includes(status))this.tools.delete(id);else this.tools.set(id,{title:update.title||prev?.title||update.kind||'tool',status:status||prev?.status||'pending',since:prev?.since||Date.now()});}
      if(update.sessionUpdate==='agent_message_chunk'&&update.content?.type==='text')this.active.onEvent({type:'text',text:update.content.text});
      else {const text=activityOf(update);if(text)this.active.onEvent({type:'activity',text});}
    });
    const init=await this.rpc.request('initialize',{protocolVersion:1,clientCapabilities:{fs:{readTextFile:false,writeTextFile:false},terminal:false},clientInfo:{name:'agenthub',version:'0.1.0'}},60000);
    if(init.protocolVersion!==1)throw new Error('This ACP protocol version is not supported.');
    this.capabilities=init.agentCapabilities||{};
    const info=init.agentInfo||{};this.agentInfo={name:String(info.title||info.name||'').slice(0,80),version:String(info.version||'').slice(0,40)};
    return {description:`ACP connected${this.agentInfo.version?` to ${this.agentInfo.name||this.agent.name} ${this.agentInfo.version}`:''}; tool approvals stay explicit`,agentVersion:this.agentInfo.version};
  }
  // What Opaya passes as MCP servers, without secrets: when it changes (the browser given, a server turned on), a session
  // opened before is opened again so the agent has them in this chat right away instead of after a reconnect.
  mcpSignature(){return JSON.stringify(this.sessionMcp().map(s=>[s.name,s.command||s.url||'',...(s.args||[])]));}
  async run(ctx){
    let sessionId=this.sessions.get(ctx.conversation.id);const sig=this.mcpSignature();
    if(!this.mcpSigs)this.mcpSigs=new Map();
    if(sessionId&&(this.mcpSigs.get(sessionId)??sig)!==sig&&this.capabilities.loadSession&&ctx.conversation.externalSessionId===sessionId){this.sessions.delete(ctx.conversation.id);sessionId=null;}
    if(this.preparedSession&&this.preparedSig!==sig)this.preparedSession=null;
    if(!sessionId){
      const cwd=ctx.cwd||sessionCwd(this.agent);
      if(!cwd)throw new Error('ACP requires an absolute working directory. Edit this agent first.');
      if(ctx.conversation.externalSessionId){
        if(!this.capabilities.loadSession)throw new Error('This ACP server cannot resume a previous process session. The local transcript is preserved. Start a new conversation.');
        this.readModels(await this.rpc.request('session/load',{sessionId:ctx.conversation.externalSessionId,cwd,mcpServers:this.sessionMcp()}),ctx.conversation.externalSessionId);
        sessionId=ctx.conversation.externalSessionId;
      }else{
        const session=this.preparedSession||await this.rpc.request('session/new',{cwd,mcpServers:this.sessionMcp()},60000);this.preparedSession=null;sessionId=session.sessionId;
        this.readModels(session,sessionId,true);
      }
      if(typeof sessionId!=='string')throw new Error('ACP did not return a session ID.');
      this.sessions.set(ctx.conversation.id,sessionId);this.mcpSigs.set(sessionId,sig);await ctx.onSession(sessionId);
    }
    this.active={...ctx,sessionId};
    const cancel=()=>{try{this.rpc.notify('session/cancel',{sessionId});}catch{}};
    ctx.signal.addEventListener('abort',cancel,{once:true});
    try{
      if(ctx.signal.aborted)throw new Error('Cancelled.');
      const model=ctx.conversation.model||this.agent.model;
      if(model){
        // Newer ACP servers expose the model as a session config option; older ones take session/set_model. A model the
        // server never listed (typed by the user) is tried, and a refusal is reported instead of failing the turn.
        const listed=model.includes(':')||this.modelIds?.includes(model);
        const apply=()=>(this.modelConfigId?this.rpc.request('session/set_config_option',{sessionId,configId:this.modelConfigId,value:model},60000):this.rpc.request('session/set_model',{sessionId,modelId:model},60000)).then(r=>{this.readConfig(sessionId,r?.configOptions);return r;});
        if(listed)await apply();
        else if(!this.modelIds?.length)await apply().catch(error=>ctx.onEvent({type:'activity',text:`Model ${model} was not applied: ${String(error.message||error).slice(0,160)}. Using the agent's own setting.`}));
      }
      await this.applyEffort(sessionId,ctx);
      const prompt=await this.prompt(ctx);
      if(ctx.signal.aborted)throw new Error('Cancelled.');
      // No fixed cap: long tool runs are normal. The broker's inactivity limit and Stop end a stuck turn.
      this.tools.clear();
      const pending=this.active;
      const watch=setInterval(()=>{if(this.envStart&&!this.envStart.warned&&Date.now()-this.envStart.at>this.envStallMs){this.envStart.warned=true;this.log.add('info','Terminal start is taking longer than 30 seconds.');pending.onEvent({type:'activity',text:envHint(this.agent)});}},Math.min(2000,this.envStallMs));watch.unref?.();
      try{await this.rpc.request('session/prompt',{sessionId,prompt},24*60*60*1000);}finally{clearInterval(watch);}
      if(ctx.signal.aborted)throw new Error('Cancelled.');
      return {externalSessionId:sessionId};
    }finally{ctx.signal.removeEventListener('abort',cancel);this.active=null;this.tools.clear();}
  }
  // Reasoning effort: the session's thought_level option set to the chosen level (or the nearest one it offers), or back to
  // the level new sessions start with when the agent's own setting is chosen.
  async applyEffort(sessionId,ctx){
    const option=this.levels.get(sessionId),want=ctx.effort||'';
    if(!option){
      if(want&&!this.effortNoted.has(sessionId)){this.effortNoted.add(sessionId);ctx.onEvent({type:'activity',text:`${this.agentInfo?.name||this.agent.name||'This agent'} has no reasoning effort setting, so it uses its own.`});}
      return;
    }
    const target=want?levels.nearest(want,levels.order(option.values)):option.initial;
    if(want&&!target){ctx.onEvent({type:'activity',text:`This agent does not offer ${want} reasoning effort, so it uses its own.`});return;}
    if(!target||target===option.current)return;
    try{
      const r=await this.rpc.request('session/set_config_option',{sessionId,configId:option.configId,value:target},60000);
      option.current=target;this.readConfig(sessionId,r?.configOptions);
      if(want&&target!==want)ctx.onEvent({type:'activity',text:`Using ${target} reasoning effort: this agent does not offer ${want}.`});
    }catch(error){ctx.onEvent({type:'activity',text:`Reasoning effort ${target} was not applied: ${String(error?.message||error).slice(0,160)}.`});}
  }
  // The prompt blocks: the text with text files inlined; images as image blocks when the agent takes them (up to
  // 3.75 MB); everything else as resource links to a path where the agent runs (copied there first over SSH or into its
  // container), named in the text too for agents that ignore links.
  async prompt(ctx){
    const items=ctx.attachments||[];
    if(!items.length)return [{type:'text',text:ctx.text}];
    const caps=this.capabilities?.promptCapabilities||{},remote=attach.placeOf(this.agent)!=='local',cut=attach.plan(items);
    const images=items.filter(i=>i.kind==='image'&&caps.image&&i.size<=attach.INLINE_IMAGE),linked=items.filter(i=>!images.includes(i)&&(i.kind!=='text'||cut.has(i)));
    const where=linked.length?await attach.locate(this.agent,this.host,linked,ctx.conversation.id,{signal:ctx.signal,onEvent:ctx.onEvent,spawn:this.spawnAgent}):new Map();
    return [{type:'text',text:attach.compose(ctx.text,items,i=>where.get(i)||'')},
      ...await Promise.all(images.map(async i=>({type:'image',mimeType:i.mime,data:await attach.base64(i)}))),
      ...linked.map(i=>({type:'resource_link',uri:attach.fileUri(where.get(i),remote),name:i.name,mimeType:i.mime,size:i.size}))];
  }
  // The thought_level option of a session, from session/new, session/load, set_config_option or config_option_update.
  // `fresh`: a new session, whose level is the agent's own default.
  readConfig(sessionId,options,fresh=false){
    if(typeof sessionId!=='string'||!Array.isArray(options))return;
    const o=options.find(x=>x&&x.category==='thought_level'&&typeof x.id==='string'&&x.type!=='boolean');
    if(!o)return;
    const values=flat(o.options),current=typeof o.currentValue==='string'?o.currentValue:'',prev=this.levels.get(sessionId);
    if(fresh&&current)this.levelDefault=current;
    this.levels.set(sessionId,{configId:o.id,values,current,initial:prev?.initial??(fresh?current:this.levelDefault||current)});
    const shown=levels.order(values);
    if(shown.join()!==this.lastLevels.join()){this.lastLevels=shown;this.onChange();}
  }
  async listModels(){
    if(!this.preparedSession){this.preparedSig=this.mcpSignature();this.preparedSession=await this.rpc.request('session/new',{cwd:sessionCwd(this.agent),mcpServers:this.sessionMcp()},60000);}
    this.readModels(this.preparedSession,this.preparedSession?.sessionId,true);
    return this.modelIds||[];
  }
  // Models from a session/new or session/load result: the unstable `models.availableModels` field, or the newer
  // session config option with category "model" (options may be grouped).
  readModels(session,sessionId=session?.sessionId,fresh=false){
    if(!session||typeof session!=='object')return;
    this.readConfig(sessionId,session.configOptions,fresh);
    const legacy=(session.models?.availableModels||[]).map(m=>m?.modelId).filter(m=>typeof m==='string');
    const option=(Array.isArray(session.configOptions)?session.configOptions:[]).find(o=>o&&(o.category==='model'||o.id==='model'));
    const configured=option?flat(option.options):[];
    if(option&&typeof option.id==='string')this.modelConfigId=option.id;
    if(legacy.length||configured.length)this.modelIds=[...new Set([...legacy,...configured])];
    // The model the session runs now, so Opaya can tell whether it can see images (the Opaya browser needs that).
    const current=session.models?.currentModelId||option?.currentValue;if(typeof current==='string'&&current)this.currentModel=current.slice(0,200);
  }
  diagnostics(){
    const now=Date.now();
    return {protocol:'acp',pid:this.rpc?.child?.pid||null,closed:!!this.rpc?.closed,stderr:this.rpc?.stderr||'',
      waitingForApproval:this.permission?{title:this.permission.title,seconds:Math.round((now-this.permission.since)/1000)}:null,
      runningTools:[...this.tools.values()].map(t=>({title:t.title,status:t.status,seconds:Math.round((now-t.since)/1000)})),
      agentVersion:this.agentInfo?.version||'',terminalStarting:this.envStart?Math.round((now-this.envStart.at)/1000):0,hint:this.envStart&&now-this.envStart.at>this.envStallMs?envHint(this.agent):'',
      ...this.log.toJSON()};
  }
  close(){this.rpc?.close();}
}
module.exports={AcpAdapter,sessionCwd,activityOf,ENV_STALL_MS};
