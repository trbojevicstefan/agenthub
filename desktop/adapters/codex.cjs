'use strict';
const {Rpc}=require('../rpc.cjs');
const {launch}=require('../process.cjs');
class CodexAdapter{
  constructor({agent,host,approve,spawnAgent=launch,trusted=()=>false,mcpServers=()=>[]}){this.trusted=trusted;this.mcpServers=mcpServers;this.agent=agent;this.host=host;this.approve=approve;this.spawnAgent=spawnAgent;this.threads=new Map();this.active=null;}
  async connect(){
    this.rpc=new Rpc(this.spawnAgent(this.agent,[...this.agent.args,'app-server'],this.host),{jsonrpc:false,onRequest:async(method,params)=>{
      if(['item/commandExecution/requestApproval','item/fileChange/requestApproval'].includes(method)){
        if(!this.active||params.threadId!==this.active.threadId||(this.active.turnId&&params.turnId!==this.active.turnId)||this.active.signal.aborted)return {decision:'decline'};
        const pending=this.active;
        if(this.trusted()){pending.onEvent?.({type:'activity',text:`iTrust approved: ${method.includes('fileChange')?'file changes':'command'}`});return {decision:'accept'};}
        const accepted=await this.approve(this.agent,method.includes('fileChange')?'Approve file changes?':'Approve command?',JSON.stringify(params,null,2).slice(0,5000));
        return {decision:accepted&&this.active===pending&&!pending.signal.aborted?'accept':'decline'};
      }
      throw new Error('This server request is unsupported and was denied.');
    }});
    this.rpc.on('notification',(method,p)=>this.notification(method,p));
    this.rpc.on('closed',e=>{if(this.active)this.active.reject(e);});
    await this.rpc.request('initialize',{clientInfo:{name:'agenthub',title:'Opaya',version:'0.1.0'},capabilities:{experimentalApi:false}});
    this.rpc.notify('initialized',{});
    return {description:'Codex app server connected; existing CLI login retained'};
  }
  notification(method,p){
    const a=this.active;if(!a||p.threadId!==a.threadId)return;
    if(method==='turn/started')a.turnId=p.turn?.id;
    if(method==='item/agentMessage/delta'){a.deltaItems.add(p.itemId||'unknown');a.onEvent({type:'text',text:p.delta||''});}
    if(method==='item/started'&&p.item?.type!=='agentMessage')a.onEvent({type:'activity',text:`Codex: ${p.item?.type||'working'}`});
    if(method==='item/completed'&&p.item?.type==='agentMessage'&&!a.deltaItems.has(p.item.id||'unknown')&&p.item.text)a.onEvent({type:'text',text:p.item.text});
    if(method==='turn/completed'){
      if(p.turn?.status==='failed')a.reject(new Error(p.turn?.error?.message||'Codex turn failed.'));
      else if(p.turn?.status==='interrupted')a.reject(new Error('Codex turn interrupted.'));
      else a.resolve({externalSessionId:a.threadId});
    }
    if(method==='error'&&!p.willRetry)a.reject(new Error(p.error?.message||'Codex reported an error.'));
  }
  async run(ctx){
    const model=ctx.conversation.model||this.agent.model;let threadId=this.threads.get(ctx.conversation.id);
    if(!threadId){
      const params={cwd:ctx.cwd||this.agent.cwd||undefined,approvalPolicy:'on-request',sandbox:'workspace-write',...(model?{model}:{})};
      const result=ctx.conversation.externalSessionId?await this.rpc.request('thread/resume',{...params,threadId:ctx.conversation.externalSessionId}):await this.rpc.request('thread/start',params);
      threadId=result.thread?.id;if(!threadId)throw new Error('Codex did not return a thread ID.');
      this.threads.set(ctx.conversation.id,threadId);await ctx.onSession(threadId);
    }
    return new Promise((resolve,reject)=>{
      let done=false;
      const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);ctx.signal.removeEventListener('abort',cancel);this.active=null;error?reject(error):resolve(value);};
      const timer=setTimeout(()=>{cancel();finish(new Error('Codex turn timed out. Check Terminal before retrying.'));},10*60*1000);
      const cancel=()=>{
        const turnId=this.active?.turnId;
        if(turnId)this.rpc.request('turn/interrupt',{threadId,turnId},10000).catch(()=>{});
        finish(new Error('Cancelled. The interrupt was requested; verify remote task status before retrying.'));
      };
      this.active={...ctx,threadId,resolve:v=>finish(null,v),reject:e=>finish(e),deltaItems:new Set()};
      ctx.signal.addEventListener('abort',cancel,{once:true});
      if(ctx.signal.aborted){cancel();return;}
      this.rpc.request('turn/start',{threadId,input:[{type:'text',text:ctx.text}],...(model?{model}:{})},60000).then(result=>{if(!done&&this.active?.threadId===threadId)this.active.turnId=result.turn?.id;},e=>finish(e));
    });
  }
  close(){this.rpc?.close();}
  async listModels(){const result=await this.rpc.request('model/list',{limit:100});return (result.data||[]).map(m=>m.model||m.id).filter(m=>typeof m==='string');}
}
module.exports={CodexAdapter};
