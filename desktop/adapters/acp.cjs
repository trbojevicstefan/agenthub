'use strict';
const {Rpc}=require('../rpc.cjs');
const {launch}=require('../process.cjs');
class AcpAdapter {
  constructor({agent,host,approve,spawnAgent=launch}){this.agent=agent;this.host=host;this.approve=approve;this.spawnAgent=spawnAgent;this.sessions=new Map();this.active=null;}
  async connect(){
    const args=[...this.agent.args];
    if(this.agent.provider==='hermes'&&!args.includes('acp'))args.push('acp');
    this.rpc=new Rpc(this.spawnAgent(this.agent,args,this.host),{onRequest:async(method,params)=>{
      if(method!=='session/request_permission')throw new Error('Client filesystem and terminal capabilities are not enabled.');
      if(!this.active||params.sessionId!==this.active.sessionId||this.active.signal.aborted)return {outcome:{outcome:'cancelled'}};
      const options=Array.isArray(params.options)?params.options:[];
      const allow=options.find(o=>o.kind==='allow_once');
      if(!allow)return {outcome:{outcome:'cancelled'}};
      const pending=this.active;
      const accepted=await this.approve(this.agent, String(params.toolCall?.title||'Agent tool request'), JSON.stringify(params.toolCall?.rawInput||params.toolCall||{},null,2).slice(0,5000));
      if(!accepted||this.active!==pending||pending.signal.aborted)return {outcome:{outcome:'cancelled'}};
      return {outcome:{outcome:'selected',optionId:allow.optionId}};
    }});
    this.rpc.on('notification',(method,params)=>{
      if(method!=='session/update'||!this.active||params.sessionId!==this.active.sessionId)return;
      const update=params.update||{};
      if(update.sessionUpdate==='agent_message_chunk'&&update.content?.type==='text')this.active.onEvent({type:'text',text:update.content.text});
      else if(['tool_call','tool_call_update'].includes(update.sessionUpdate))this.active.onEvent({type:'activity',text:String(update.title||update.status||'Agent tool').slice(0,200)});
    });
    const init=await this.rpc.request('initialize',{protocolVersion:1,clientCapabilities:{fs:{readTextFile:false,writeTextFile:false},terminal:false},clientInfo:{name:'agenthub',version:'0.1.0'}},60000);
    if(init.protocolVersion!==1)throw new Error('This ACP protocol version is not supported.');
    this.capabilities=init.agentCapabilities||{};
    return {description:'ACP connected; tool approvals stay explicit'};
  }
  async run(ctx){
    let sessionId=this.sessions.get(ctx.conversation.id);
    if(!sessionId){
      const cwd=this.agent.cwd;
      if(!cwd)throw new Error('ACP requires an absolute working directory. Edit this agent first.');
      if(ctx.conversation.externalSessionId){
        if(!this.capabilities.loadSession)throw new Error('This ACP server cannot resume a previous process session. The local transcript is preserved. Start a new conversation.');
        await this.rpc.request('session/load',{sessionId:ctx.conversation.externalSessionId,cwd,mcpServers:[]});
        sessionId=ctx.conversation.externalSessionId;
      }else{
        const session=await this.rpc.request('session/new',{cwd,mcpServers:[]},60000);sessionId=session.sessionId;
      }
      if(typeof sessionId!=='string')throw new Error('ACP did not return a session ID.');
      this.sessions.set(ctx.conversation.id,sessionId);await ctx.onSession(sessionId);
    }
    this.active={...ctx,sessionId};
    const cancel=()=>{try{this.rpc.notify('session/cancel',{sessionId});}catch{}};
    ctx.signal.addEventListener('abort',cancel,{once:true});
    try{
      if(ctx.signal.aborted)throw new Error('Cancelled.');
      await this.rpc.request('session/prompt',{sessionId,prompt:[{type:'text',text:ctx.text}]},10*60*1000);
      if(ctx.signal.aborted)throw new Error('Cancelled.');
      return {externalSessionId:sessionId};
    }finally{ctx.signal.removeEventListener('abort',cancel);this.active=null;}
  }
  close(){this.rpc?.close();}
}
module.exports={AcpAdapter};
