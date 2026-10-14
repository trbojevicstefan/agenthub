'use strict';
const fs=require('node:fs'),path=require('node:path');
const OPAYA_ROOT=fs.existsSync(path.join(__dirname,'../../desktop/wire.cjs'))?path.join(__dirname,'../../desktop'):path.join(__dirname,'vendor/opaya');
const wire=require(path.join(OPAYA_ROOT,'wire.cjs'));
const wait=ms=>new Promise(r=>setTimeout(r,ms));
// Reuse OPAYA's authenticated local service. Vault material never leaves OPAYA.
class OpayaServiceAdapter{
  constructor(local){this.local=local;this.client=null;this.sending=false;}
  async connect(){
    const descriptor=JSON.parse(fs.readFileSync(path.join(this.local.serviceRoot,'session-service.json'),'utf8'));
    try{this.client=await wire.connect(wire.endpoint(this.local.serviceRoot),descriptor.token);}catch{throw new Error('Open OPAYA Desktop with this profile, then retry the connection. Its local session service is not reachable.');}
    const state=await this.client.call('snapshot');this.scopedStop=state.service?.cordBridgeVersion===2;const agent=state.agents.find(a=>a.id===this.local.agent.id);
    if(!agent)throw new Error('The selected agent no longer exists in OPAYA.');
    if(agent.status!=='connected')await this.client.call('connect',{id:agent.id},60000);
    return {description:'Connected through the local OPAYA session service; existing Vault and tools retained.'};
  }
  async run(ctx){
    const id=this.local.agent.id;
    // Do not interrupt an OPAYA conversation already in progress.
    while(true){if(ctx.signal.aborted)throw new Error('Cancelled');const state=await this.client.call('snapshot');if(!state.agents.find(a=>a.id===id)?.busy)break;ctx.onEvent({type:'activity',text:'Waiting for the current OPAYA turn to finish'});await wait(1000);}
    let conversationId=ctx.conversation.externalSessionId;
    if(!conversationId){const c=await this.client.call('newConversation',{agentId:id,activate:false});conversationId=c.id;await ctx.onSession(c.id);}
    if(ctx.conversation.model)await this.client.call('selectModel',{id,model:ctx.conversation.model,scope:'conversation',conversationId});
    if(ctx.effort)await this.client.call('selectEffort',{id,effort:ctx.effort,scope:'conversation',conversationId});
    const cancel=()=>{if(!this.sending)return;if(this.scopedStop)this.client?.call('stop',{id,conversationId}).catch(()=>{});else ctx.onEvent({type:'activity',text:'Cancelled in Cord. This older OPAYA service cannot safely stop a specific turn; check OPAYA before retrying.'});};
    ctx.signal.addEventListener('abort',cancel,{once:true});
    try{
      if(ctx.signal.aborted)throw new Error('Cancelled');
      this.sending=true;
      const sent=await this.client.call('send',{agentId:id,conversationId,text:ctx.text,attachments:[]},60000);
      while(!ctx.signal.aborted){
        const transcript=await this.client.call('transcript',{id:conversationId});
        const message=transcript.messages.find(m=>m.id===sent.messageId);
        if(message&&message.status!=='streaming'){
          if(message.status!=='done')throw new Error(message.error||'OPAYA agent did not complete the turn');
          ctx.onEvent({type:'text',text:message.content});return {externalSessionId:conversationId};
        }
        if(message?.activity?.length)ctx.onEvent({type:'activity',text:message.activity.at(-1)});
        await wait(500);
      }
      throw new Error('Cancelled');
    }finally{this.sending=false;ctx.signal.removeEventListener('abort',cancel);}
  }
  close(){this.client?.close();}
}
module.exports={OpayaServiceAdapter};
