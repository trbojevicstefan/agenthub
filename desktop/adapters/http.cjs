'use strict';
const {Tunnel} = require('../tunnel.cjs');
const {limitedBody} = require('../discovery.cjs');
class SSE {
  constructor(onEvent) { this.buffer=''; this.onEvent=onEvent; }
  feed(chunk) {
    this.buffer=(this.buffer+chunk).replace(/\r\n/g,'\n');
    if(this.buffer.length>1024*1024)throw new Error('API event exceeds the safety limit.');
    let i;
    while((i=this.buffer.indexOf('\n\n'))>=0) {
      const frame=this.buffer.slice(0,i);this.buffer=this.buffer.slice(i+2);
      let event='message';const lines=[];
      for(const line of frame.split('\n')) {
        if(line.startsWith('event:'))event=line.slice(6).trim();
        if(line.startsWith('data:'))lines.push(line.slice(5).replace(/^ /,''));
      }
      if(lines.length)this.onEvent(event,lines.join('\n'));
    }
  }
  end() { if(this.buffer.trim())this.feed('\n\n'); }
}
class HttpAdapter {
  constructor({agent,host,token,fetchImpl=fetch}) { this.agent=agent;this.host=host;this.token=token;this.fetch=async(...args)=>{try{return await fetchImpl(...args);}catch(error){if(error.name==='AbortError'||error.name==='TimeoutError')throw error;throw new Error(`Cannot reach ${agent.provider} gateway at ${agent.endpoint}${agent.transport==='ssh'?' on the selected VPS':''}. Check Gateway status, or use the native CLI/ACP connection when its API is disabled.`);}};this.url=agent.endpoint;this.tunnel=null; }
  headers() { return {'Content-Type':'application/json',...(this.token?{Authorization:`Bearer ${this.token}`}:{})}; }
  async connect() {
    if(this.agent.transport==='ssh') { this.tunnel=new Tunnel(this.host,this.agent.endpoint);this.url=await this.tunnel.start(); }
    const r=await this.fetch(`${this.url}/models`,{headers:this.headers(),signal:AbortSignal.timeout(15000),redirect:'error'});
    if(r.status===404&&this.agent.provider==='openclaw'&&this.agent.model){await r.body?.cancel();this.models=[this.agent.model];return {models:this.models,description:'Gateway reachable; authentication and chat route are verified on the first message'};}
    if(!r.ok) { await r.body?.cancel();throw new Error(this.failure(r.status)); }
    const data=JSON.parse(await limitedBody(r,256*1024));
    if(!Array.isArray(data.data))throw new Error('This endpoint did not return an OpenAI-compatible model list.');
    this.models=data.data.slice(0,200).map(x=>x.id).filter(x=>typeof x==='string'&&x.length<=256);
    return {models:this.models,description:this.agent.transport==='ssh'?'Private SSH tunnel established':'API authenticated'};
  }
  failure(status) {
    if(status===401||status===403)return 'API authentication failed. Edit this agent and add or import its gateway token.';
    if(status===404)return this.agent.provider==='openclaw'?'Enable gateway.http.endpoints.chatCompletions on OpenClaw, then reconnect.':'API route not found. Verify the base URL ends with /v1 and that this gateway API is enabled.';
    return `API request failed (HTTP ${status}). Check the agent gateway in Terminal.`;
  }
  async run({text,messages,conversation,signal,onEvent}) {
    const history=messages.filter((m,i)=>['user','assistant'].includes(m.role)&&m.status!=='error'&&m.status!=='cancelled'&&!(m.role==='user'&&['error','cancelled'].includes(messages[i+1]?.status))).map(m=>({role:m.role,content:m.content}));
    if(JSON.stringify(history).length>500000)throw new Error('This conversation is too large to resend safely. Start a new conversation.');
    const model=this.agent.model||this.models?.[0];
    if(!model)throw new Error('Choose a model in the agent connection settings.');
    const payload={model,stream:true,messages:history};
    if(this.agent.provider==='hermes'&&model.includes(':')){
      const separator=model.indexOf(':',model.startsWith('custom:')?7:0);
      if(separator>0){payload.provider=model.slice(0,separator);payload.model=model.slice(separator+1);}
    }
    // OpenClaw owns conversation history when given a stable user key. Sending only
    // the new turn avoids replaying previously stored messages into its session.
    if(this.agent.provider==='openclaw') { payload.user=`agenthub:${conversation.id}`;payload.messages=[{role:'user',content:text}]; }
    const headers=this.headers();
    if(this.agent.provider==='hermes'){headers['X-Hermes-Session-Id']=conversation.id;headers['X-Hermes-Session-Key']=`agenthub:${this.agent.id}:${conversation.id}`;}
    const r=await this.fetch(`${this.url}/chat/completions`,{method:'POST',headers,body:JSON.stringify(payload),signal,redirect:'error'});
    if(!r.ok) { await r.body?.cancel();throw new Error(this.failure(r.status)); }
    if(!(r.headers.get('content-type')||'').includes('text/event-stream')) {
      const data=JSON.parse(await limitedBody(r,2*1024*1024));
      if(data.error)throw new Error(String(data.error.message||'Agent API failed.'));
      const content=data.choices?.[0]?.message?.content;
      if(data.choices?.[0]?.message?.tool_calls)throw new Error('This endpoint requested client-side tools. Connect an agent gateway or ACP server instead.');
      if(typeof content!=='string')throw new Error('API returned no assistant text. This client does not execute model-side tool calls.');
      onEvent({type:'text',text:content});return {};
    }
    if(!r.body)throw new Error('API returned an empty stream.');
    let completed=false,bytes=0;
    const parser=new SSE((event,raw)=>{
      if(raw==='[DONE]'){completed=true;return;}
      let data;try{data=JSON.parse(raw);}catch{throw new Error('Invalid JSON in API event stream.');}
      if(data.error)throw new Error(String(data.error.message||'The agent run failed.'));
      if(event==='hermes.tool.progress'||event==='tool.started'||event==='tool.completed') {
        onEvent({type:'activity',text:`${event}: ${String(data.tool_name||data.name||data.status||'agent tool').slice(0,180)}`});return;
      }
      const delta=data.choices?.[0]?.delta?.content;
      if(typeof delta==='string') {bytes+=delta.length;if(bytes>2*1024*1024)throw new Error('Assistant output exceeds the safety limit.');onEvent({type:'text',text:delta});}
      if(data.choices?.[0]?.delta?.tool_calls)throw new Error('This endpoint requested client-side tools. Use an agent gateway that executes its own tools, or connect through ACP.');
    });
    const reader=r.body.getReader(),decoder=new TextDecoder();
    try {
      while(true){const {done,value}=await reader.read();if(done)break;parser.feed(decoder.decode(value,{stream:true}));if(completed)break;}
      parser.feed(decoder.decode());parser.end();
      if(!completed)throw new Error('The stream disconnected before its completion marker. Partial output was kept; the task may still be running remotely.');
    }finally{await reader.cancel().catch(()=>{});}
    return {};
  }
  close(){this.tunnel?.close();}
  async listModels(){
    const r=await this.fetch(`${this.url}/models`,{headers:this.headers(),signal:AbortSignal.timeout(15000),redirect:'error'});
    if(r.status===404&&this.agent.provider==='openclaw'){await r.body?.cancel();return this.models||[this.agent.model];}
    if(!r.ok){await r.body?.cancel();throw new Error(this.failure(r.status));}
    const data=JSON.parse(await limitedBody(r,256*1024));this.models=(data.data||[]).map(m=>m.id).filter(m=>typeof m==='string');
    if(this.agent.provider==='hermes'){
      const options=await this.fetch(this.url.replace(/\/v1$/,'')+'/api/model/options',{headers:this.headers(),signal:AbortSignal.timeout(15000),redirect:'error'});
      if(options.ok){
        const inventory=JSON.parse(await limitedBody(options,2*1024*1024));
        for(const provider of inventory.providers||[]){if(!provider.authenticated)continue;for(const model of provider.models||[]){const id=typeof model==='string'?model:model.id||model.model;if(id&&provider.slug)this.models.push(`${provider.slug}:${id}`);}}
      }else{await options.body?.cancel();if(![404,405,501].includes(options.status))throw new Error(this.failure(options.status));}
    }
    return [...new Set(this.models)].slice(0,500);
  }
}
module.exports={HttpAdapter,SSE};
