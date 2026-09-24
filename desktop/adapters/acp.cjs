'use strict';
const {Rpc}=require('../rpc.cjs');
const {launch}=require('../process.cjs');
const {ConnectionLog}=require('../diagnostics.cjs');
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
const commandList=list=>(Array.isArray(list)?list:[]).filter(c=>c&&typeof c.name==='string'&&/^[\w.:-]{1,64}$/.test(c.name)).slice(0,200).map(c=>({name:c.name,description:String(c.description||'').slice(0,300),hint:String(c.input?.hint||'').slice(0,120)}));
class AcpAdapter {
  constructor({agent,host,approve,spawnAgent=launch,mcpServers=()=>[],onChange=()=>{},envStallMs=ENV_STALL_MS}){this.envStallMs=envStallMs;this.agent=agent;this.host=host;this.approve=approve;this.spawnAgent=spawnAgent;this.mcpServers=mcpServers;this.onChange=onChange;this.sessions=new Map();this.active=null;this.log=new ConnectionLog();this.tools=new Map();this.permission=null;this.envStart=null;this.commands=[];this.agentInfo=null;}
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
  async run(ctx){
    let sessionId=this.sessions.get(ctx.conversation.id);
    if(!sessionId){
      const cwd=ctx.cwd||sessionCwd(this.agent);
      if(!cwd)throw new Error('ACP requires an absolute working directory. Edit this agent first.');
      if(ctx.conversation.externalSessionId){
        if(!this.capabilities.loadSession)throw new Error('This ACP server cannot resume a previous process session. The local transcript is preserved. Start a new conversation.');
        await this.rpc.request('session/load',{sessionId:ctx.conversation.externalSessionId,cwd,mcpServers:this.sessionMcp()});
        sessionId=ctx.conversation.externalSessionId;
      }else{
        const session=this.preparedSession||await this.rpc.request('session/new',{cwd,mcpServers:this.sessionMcp()},60000);this.preparedSession=null;sessionId=session.sessionId;
        this.modelIds=(session.models?.availableModels||[]).map(m=>m.modelId);
      }
      if(typeof sessionId!=='string')throw new Error('ACP did not return a session ID.');
      this.sessions.set(ctx.conversation.id,sessionId);await ctx.onSession(sessionId);
    }
    this.active={...ctx,sessionId};
    const cancel=()=>{try{this.rpc.notify('session/cancel',{sessionId});}catch{}};
    ctx.signal.addEventListener('abort',cancel,{once:true});
    try{
      if(ctx.signal.aborted)throw new Error('Cancelled.');
      const model=ctx.conversation.model||this.agent.model;
      if(model&&(model.includes(':')||this.modelIds?.includes(model)))await this.rpc.request('session/set_model',{sessionId,modelId:model},60000);
      // No fixed cap: long tool runs are normal. The broker's inactivity limit and Stop end a stuck turn.
      this.tools.clear();
      const pending=this.active;
      const watch=setInterval(()=>{if(this.envStart&&!this.envStart.warned&&Date.now()-this.envStart.at>this.envStallMs){this.envStart.warned=true;this.log.add('info','Terminal start is taking longer than 30 seconds.');pending.onEvent({type:'activity',text:envHint(this.agent)});}},Math.min(2000,this.envStallMs));watch.unref?.();
      try{await this.rpc.request('session/prompt',{sessionId,prompt:[{type:'text',text:ctx.text}]},24*60*60*1000);}finally{clearInterval(watch);}
      if(ctx.signal.aborted)throw new Error('Cancelled.');
      return {externalSessionId:sessionId};
    }finally{ctx.signal.removeEventListener('abort',cancel);this.active=null;this.tools.clear();}
  }
  async listModels(){
    if(!this.preparedSession)this.preparedSession=await this.rpc.request('session/new',{cwd:sessionCwd(this.agent),mcpServers:this.sessionMcp()},60000);
    this.modelIds=(this.preparedSession.models?.availableModels||[]).map(m=>m.modelId).filter(m=>typeof m==='string');
    return this.modelIds;
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
