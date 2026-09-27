'use strict';
const {Rpc}=require('../rpc.cjs');
const {launch}=require('../process.cjs');
const attach=require('../attachments.cjs');
const levels=require('../effort.cjs');
class CodexAdapter{
  constructor({agent,host,approve,spawnAgent=launch,trusted=()=>false,mcpServers=()=>[],onChange=()=>{}}){this.trusted=trusted;this.mcpServers=mcpServers;this.agent=agent;this.host=host;this.approve=approve;this.spawnAgent=spawnAgent;this.onChange=onChange;this.threads=new Map();this.threadModels=new Map();this.modelInfo=new Map();this.defaultModel='';this.active=null;}
  // Reasoning effort levels of the agent's model as model/list reports them (read in the background on connect).
  get efforts(){return this.modelInfo.get(this.agent.model||this.defaultModel)?.efforts??levels.CODEX;}
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
    this.listModels().then(()=>this.onChange(),()=>{});
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
      if(typeof result.model==='string')this.threadModels.set(threadId,result.model);
      this.threads.set(ctx.conversation.id,threadId);await ctx.onSession(threadId);
    }
    const actual=model||this.threadModels.get(threadId)||this.defaultModel,info=this.modelInfo.get(actual);
    // Reasoning effort: the chosen level, or the nearest one this model offers.
    let effort=ctx.effort||'';
    if(effort&&info?.efforts){const fit=levels.nearest(effort,info.efforts);if(fit!==effort)ctx.onEvent({type:'activity',text:fit?`Using ${fit} reasoning effort: ${actual} does not offer ${effort}.`:`${actual} has no reasoning effort setting, so it uses its own.`});effort=fit;}
    // Attached files: text inlined, images as local images, other files by path. On another machine or in a container
    // they are copied there first.
    const items=ctx.attachments||[],images=items.filter(i=>i.kind==='image'&&info?.images!==false),cut=attach.plan(items);
    const linked=items.filter(i=>i.kind!=='text'||cut.has(i));
    const where=linked.length?await attach.locate(this.agent,this.host,linked,ctx.conversation.id,{signal:ctx.signal,onEvent:ctx.onEvent,spawn:this.spawnAgent}):new Map();
    if(ctx.signal.aborted)throw new Error('Cancelled.');
    const input=[{type:'text',text:items.length?attach.compose(ctx.text,items,i=>images.includes(i)?'':where.get(i)||''):ctx.text},...images.map(i=>({type:'localImage',path:where.get(i)}))];
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
      const start=params=>this.rpc.request('turn/start',params,60000).then(result=>{if(!done&&this.active?.threadId===threadId)this.active.turnId=result.turn?.id;},e=>{
        // A level the model refuses: answer without it rather than fail the turn.
        if(!params.effort||done||!/effort|reasoning/i.test(String(e?.message||'')))return finish(e);
        ctx.onEvent({type:'activity',text:`Codex did not take ${params.effort} reasoning effort (${String(e.message).slice(0,160)}), so it answers with its own.`});
        const {effort:_,...rest}=params;return start(rest);
      });
      start({threadId,input,...(model?{model}:{}),...(effort?{effort}:{})});
    });
  }
  close(){this.rpc?.close();}
  // model/list pages through nextCursor; older app-servers answered with `models` or `items` instead of `data`.
  async listModels(){
    const out=[];let cursor;
    for(let page=0;page<5;page++){
      const result=await this.rpc.request('model/list',{limit:100,...(cursor?{cursor}:{})});
      const list=result?.data||result?.models||result?.items||[];
      for(const m of list){
        const id=typeof m==='string'?m:m?.model||m?.id||m?.slug;if(typeof id!=='string')continue;out.push(id);
        // Its reasoning levels (none listed by an older app-server: the usual ones) and whether it can see images.
        if(m&&typeof m==='object'){this.modelInfo.set(id,{efforts:Array.isArray(m.supportedReasoningEfforts)?levels.order(m.supportedReasoningEfforts.map(e=>typeof e==='string'?e:e?.reasoningEffort)):null,images:!Array.isArray(m.inputModalities)||m.inputModalities.includes('image')});if(m.isDefault)this.defaultModel=id;}
      }
      cursor=result?.nextCursor;if(!cursor)break;
    }
    return [...new Set(out)];
  }
}
module.exports={CodexAdapter};
