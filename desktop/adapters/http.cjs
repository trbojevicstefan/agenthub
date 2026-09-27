'use strict';
const {Tunnel} = require('../tunnel.cjs');
const {limitedBody} = require('../discovery.cjs');
const {ConnectionLog} = require('../diagnostics.cjs');
const openclaw = require('../openclaw.cjs');
const attach = require('../attachments.cjs');
const {visionOf} = require('../vision.cjs');
const levels = require('../effort.cjs');
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
// Node's fetch drops a response after 300 s without data (and waits at most 300 s for headers). Hermes and other
// gateways run tools for minutes without sending anything, so chat requests use a dispatcher without those timeouts;
// the broker's inactivity limit and the Stop button still end a turn.
let streamingDispatcher;
function longRequestDispatcher(){
  if(!streamingDispatcher){try{const current=globalThis[Symbol.for('undici.globalDispatcher.1')];if(current)streamingDispatcher=new current.constructor({bodyTimeout:0,headersTimeout:0});}catch{}}
  return streamingDispatcher||undefined;
}
const hostOf=url=>{try{return new URL(url).hostname;}catch{return '';}};
// Text from OpenAI-style content, which may be a string or an array of typed parts.
const textOf=content=>typeof content==='string'?content:Array.isArray(content)?content.map(p=>typeof p==='string'?p:p?.type==='text'||p?.type==='output_text'?String(p.text||''):'').join(''):'';
// Hermes' API server keeps at most 64 KB of text per message part, so files are inlined only up to about that much.
const HERMES_TEXT=60000;
// Files that went with earlier messages, kept so a stateless API gets them again (this connection only, bounded).
const SENT_KEEP=10;
class HttpAdapter {
  constructor({agent,host,token,fetchImpl=fetch,onChange=()=>{},openclawCli=openclaw}) { this.agent=agent;this.host=host;this.token=token;this.onChange=onChange;this.oc=openclawCli;this.sent=new Map();this.noEffort=new Set();this.patched=new Set();this.thinking=null;this.fetch=async(...args)=>{try{return await fetchImpl(...args);}catch(error){if(error.name==='AbortError'||error.name==='TimeoutError')throw error;throw new Error(`Cannot reach ${agent.provider} gateway at ${agent.endpoint}${agent.transport==='ssh'?' on the selected VPS':''}. Check Gateway status, or use the native CLI/ACP connection when its API is disabled.`);}};this.url=agent.endpoint;this.tunnel=null;this.log=new ConnectionLog(); }
  headers() { return {'Content-Type':'application/json',...(this.token?{Authorization:`Bearer ${this.token}`}:{})}; }
  async connect() {
    if(this.agent.transport==='ssh') { this.tunnel=new Tunnel(this.host,this.agent.endpoint);this.url=await this.tunnel.start(); }
    const r=await this.fetch(`${this.url}/models`,{headers:this.headers(),signal:AbortSignal.timeout(15000),redirect:'error'});
    if(r.status===404&&this.agent.provider==='openclaw'&&this.agent.model){await r.body?.cancel();this.models=[this.agent.model];this.refreshThinking();return {models:this.models,description:'Gateway reachable; authentication and chat route are verified on the first message'};}
    if(!r.ok) { await r.body?.cancel();throw new Error(this.failure(r.status)); }
    const data=JSON.parse(await limitedBody(r,256*1024));
    if(!Array.isArray(data.data))throw new Error('This endpoint did not return an OpenAI-compatible model list.');
    this.models=data.data.slice(0,200).map(x=>x.id).filter(x=>typeof x==='string'&&x.length<=256);
    this.refreshThinking();
    return {models:this.models,description:this.agent.transport==='ssh'?'Private SSH tunnel established':'API authenticated'};
  }
  // Reasoning effort levels for the selector under the chat. Hermes has no per-chat setting; OpenClaw's come from its
  // gateway; a model API takes low, medium and high unless the default model refused them on this connection.
  get efforts(){
    if(this.agent.provider==='hermes')return [];
    if(this.agent.provider==='openclaw')return this.thinking?.levels||[];
    return this.noEffort.has(this.agent.model||this.models?.[0]||'')?[]:levels.API;
  }
  // OpenClaw: the thinking levels its default model takes, read in the background with its CLI where it runs.
  refreshThinking(){
    if(this.agent.provider!=='openclaw'||!openclaw.reachable(this.agent))return;
    this.oc.thinking(this.agent,this.host,{caller:this.oc.call}).then(t=>{this.thinking=t;this.onChange();},error=>this.log.add('err',`openclaw thinking levels: ${String(error?.message||error).slice(0,300)}`));
  }
  // OpenClaw keeps the thinking level per session. Opaya sets it (or clears it for the agent's own setting) when it
  // changes, and once per chat after connecting in case OpenClaw started that session over.
  async think(conversation,route,level,onEvent){
    const had=conversation.effortApplied||'';
    if(level===had&&(!level||this.patched.has(conversation.id)))return;
    if(!openclaw.reachable(this.agent)){if(level)onEvent({type:'activity',text:'Reasoning effort is not applied: Opaya sets it with the OpenClaw CLI, which it cannot run for a gateway it reaches only over HTTPS.'});return;}
    const key=openclaw.sessionKey(route,conversation.id),port=openclaw.cliPort(this.agent);
    const patch=value=>this.oc.call(this.agent,this.host,'sessions.patch',{key,thinkingLevel:value||null},{port});
    onEvent({type:'activity',text:level?`Setting reasoning effort to ${level}`:'Returning reasoning effort to the agent\'s own setting'});
    try{
      try{await patch(level);}
      catch(error){
        // A level this model does not take: OpenClaw names the ones it does, so use the nearest.
        const fit=levels.nearest(level,openclaw.offered(error?.message));if(!level||!fit||fit===level)throw error;
        await patch(fit);onEvent({type:'activity',text:`Using ${fit} reasoning effort: this model does not offer ${level}.`});
      }
      conversation.effortApplied=level;this.patched.add(conversation.id);
    }catch(error){onEvent({type:'activity',text:`Reasoning effort was not applied: ${String(error?.message||error).replace(/\s+/g,' ').slice(0,200)}`});}
  }
  async detailOf(r){
    let detail='';
    if(![401,403].includes(r.status)){try{const body=(await limitedBody(r,64*1024)).trim();try{const data=JSON.parse(body),d=data.error?.message||data.detail||data.message||'';detail=typeof d==='string'?d:JSON.stringify(d);}catch{detail=body;}}catch{}}
    else await r.body?.cancel();
    return detail.replace(/\s+/g,' ').slice(0,300);
  }
  async failureFrom(r,detail){
    if(detail===undefined)detail=await this.detailOf(r);
    return this.failure(r.status)+(detail?` Gateway said: ${detail}`:'');
  }
  failure(status) {
    if(status===401||status===403)return 'API authentication failed. Edit this agent and add or import its gateway token.';
    if(status===429)return 'The gateway is rate limited or busy (HTTP 429). Wait a moment and send again.';
    if(status>=500)return `The ${this.agent.provider==='hermes'?'Hermes gateway':'gateway'} failed while answering (HTTP ${status}). Check its logs in Terminal${this.agent.provider==='hermes'?' (hermes gateway status)':''}.`;
    if(status===404)return this.agent.provider==='openclaw'?'Enable gateway.http.endpoints.chatCompletions on OpenClaw, then reconnect.':'API route not found. Verify the base URL ends with /v1 and that this gateway API is enabled.';
    return `API request failed (HTTP ${status}). Check the agent gateway in Terminal.`;
  }
  // The newest message with its files: text inlined, images as image_url parts, other files by path where a Hermes or
  // OpenClaw agent runs (copied there first over SSH or into its container). A plain model API takes text and images.
  async content(text,items,{model,conversation,signal,onEvent}){
    const provider=this.agent.provider,machine=['hermes','openclaw'].includes(provider),place=attach.placeOf(this.agent),files=machine&&place!=='api';
    const sees=visionOf(this.agent,{model}).vision,native=[],linked=[];let inline=0;
    for(const item of items){
      if(item.kind==='image'){
        // Small images go inline (Hermes takes at most 10 MB per request); others, and any for a text-only model, by path.
        if(files){if(sees!==false&&item.size<=attach.INLINE_IMAGE&&inline+item.size<=7*1024*1024){native.push(item);inline+=item.size;}else linked.push(item);continue;}
        if(sees===false)throw new Error(`${model} reads text only, so it cannot see ${item.name}. Choose a model that can see images (Models), or remove the image.`);
        native.push(item);
      }else if(item.kind==='file'){
        if(files){linked.push(item);continue;}
        if(machine)throw new Error(`${item.name} cannot be sent: Opaya reaches ${this.agent.name||'this agent'} only through its API. Attach text files or images, or connect it over SSH to send other files.`);
        throw new Error(item.mime.startsWith('image/')?`${item.name} is an image format models do not read (${item.mime}). Convert it to PNG or JPEG, or attach a screenshot.`:`${item.name} cannot be sent to a model API: it reads text and images only. Attach it to an agent that runs on a computer, such as Claude Code, Codex, Hermes or OpenClaw.`);
      }
    }
    for(const item of attach.plan(items,provider==='hermes'?Math.max(0,HERMES_TEXT-text.length):Infinity))if(files)linked.push(item);
    const where=linked.length?await attach.locate(this.agent,this.host,linked,conversation.id,{signal,onEvent}):new Map();
    const composed=attach.compose(text,items,item=>native.includes(item)?'':where.get(item)||'');
    // What a later turn gets again: the text, and a note that the images are not sent again.
    const again=[composed,attach.earlier(attach.meta(native))].filter(Boolean).join('\n\n');
    if(!native.length)return {content:composed,again};
    return {content:[{type:'text',text:composed},...await Promise.all(native.map(async item=>({type:'image_url',image_url:{url:`data:${item.mime};base64,${await attach.base64(item)}`}})))],again};
  }
  async run({text,attachments=[],effort='',messages,conversation,signal,onEvent,cwd}) {
    const model=conversation?.model||this.agent.model||this.models?.[0];
    if(!model)throw new Error('Choose a model in the agent connection settings.');
    const keep=(m,i)=>['user','assistant'].includes(m.role)&&m.status!=='error'&&m.status!=='cancelled'&&!(m.role==='user'&&['error','cancelled'].includes(messages[i+1]?.status));
    // A stateless API gets the whole conversation each turn. Earlier files go again while this connection remembers
    // them (text only); otherwise a note says what was attached.
    const build=again=>messages.map((m,i)=>!keep(m,i)?null:{role:m.role,content:m.role==='user'&&m.attachments?.length?(again&&this.sent.get(m.id))||[m.content,attach.earlier(m.attachments)].filter(Boolean).join('\n\n'):m.content}).filter(Boolean);
    let history=build(true);
    if(JSON.stringify(history).length>500000)history=build(false);
    if(JSON.stringify(history).length>500000)throw new Error('This conversation is too large to resend safely. Start a new conversation.');
    let current={content:text,again:''};
    if(attachments.length){
      current=await this.content(text,attachments,{model,conversation,signal,onEvent});
      if(history.at(-1)?.role==='user')history.at(-1).content=current.content;else history.push({role:'user',content:current.content});
    }
    // Gateway agents keep their own working folder; a project conversation tells them which folder it is about.
    if(cwd)history.unshift({role:'system',content:`This conversation is about the project folder ${cwd}. Work in that folder unless the user says otherwise.`});
    const payload={model,stream:true,messages:history};
    if(this.agent.provider==='hermes'&&model.includes(':')){
      const separator=model.indexOf(':',model.startsWith('custom:')?7:0);
      if(separator>0){payload.provider=model.slice(0,separator);payload.model=model.slice(separator+1);}
    }
    // OpenClaw owns conversation history when given a stable user key. Sending only
    // the new turn avoids replaying previously stored messages into its session.
    if(this.agent.provider==='openclaw') { payload.user=`agenthub:${conversation.id}`;payload.messages=[...(cwd?[history[0]]:[]),{role:'user',content:current.content}]; }
    const headers=this.headers();
    // OpenClaw's chat routes are openclaw and openclaw/<agent>; a provider model (anthropic/claude-sonnet-5) goes in its
    // model header on the connection's route.
    if(this.agent.provider==='openclaw'&&!openclaw.isRoute(model)){payload.model=openclaw.isRoute(this.agent.model)?this.agent.model:'openclaw';headers['x-openclaw-model']=openclaw.modelKey(model);}
    if(this.agent.provider==='hermes'){headers['X-Hermes-Session-Id']=conversation.id;headers['X-Hermes-Session-Key']=`agenthub:${this.agent.id}:${conversation.id}`;}
    if(this.agent.provider==='openclaw')await this.think(conversation,payload.model,effort||'',onEvent);
    // Reasoning effort for a model API: reasoning.effort on OpenRouter, reasoning_effort elsewhere. Hermes has no
    // per-chat setting; OpenClaw's is set on its session above.
    let level=['hermes','openclaw'].includes(this.agent.provider)||this.noEffort.has(model)?'':levels.nearest(effort||'',levels.API);
    const withEffort=()=>{delete payload.reasoning;delete payload.reasoning_effort;if(!level)return;if(/(^|\.)openrouter\.ai$/i.test(hostOf(this.agent.endpoint)))payload.reasoning={effort:level};else payload.reasoning_effort=level;};
    const post=()=>{withEffort();this.log.add('out',`POST ${this.url}/chat/completions model=${payload.model}${headers['x-openclaw-model']?` (${headers['x-openclaw-model']})`:''} messages=${payload.messages.length}${level?` effort=${level}`:''}`);return this.fetch(`${this.url}/chat/completions`,{method:'POST',headers:{...headers,Accept:'text/event-stream'},body:JSON.stringify(payload),signal,redirect:'error',dispatcher:longRequestDispatcher()});};
    let r=await post();
    this.log.add('in',`HTTP ${r.status} ${r.headers.get('content-type')||''}`);
    if(!r.ok){
      const detail=await this.detailOf(r);
      // A model that does not reason refuses the field: ask once more without it and stop sending it to that model.
      if(level&&[400,422].includes(r.status)&&/reason|effort|think/i.test(detail)){
        onEvent({type:'activity',text:`${model} ignored the ${level} reasoning effort (it does not take one), so Opaya asked again without it.`});
        this.noEffort.add(model);level='';this.onChange();r=await post();this.log.add('in',`HTTP ${r.status} ${r.headers.get('content-type')||''}`);
        if(!r.ok)throw new Error(await this.failureFrom(r));
      }else if(attachments.some(i=>i.kind==='image')&&[400,413,415,422].includes(r.status)&&/image|vision|multimodal|modalit|too large|payload/i.test(detail))throw new Error(`${model} did not take the attached image${attachments.filter(i=>i.kind==='image').length>1?'s':''}. Gateway said: ${detail} Choose a model that can see images, or send a smaller image.`);
      else throw new Error(await this.failureFrom(r,detail));
    }
    // Remember this message's files for the next turns of a stateless API.
    const id=messages.at(-1)?.id;
    if(current.again&&id&&this.agent.provider!=='openclaw'&&current.again.length<=500000){this.sent.set(id,current.again);while(this.sent.size>SENT_KEEP)this.sent.delete(this.sent.keys().next().value);}
    if(!(r.headers.get('content-type')||'').includes('text/event-stream')) {
      const data=JSON.parse(await limitedBody(r,2*1024*1024));
      if(data.error)throw new Error(String(data.error.message||'Agent API failed.'));
      const message=data.choices?.[0]?.message||{},content=textOf(message.content);
      if(message.tool_calls?.length)throw new Error('This endpoint requested client-side tools. Connect an agent gateway or ACP server instead.');
      if(!content&&typeof message.content!=='string')throw new Error('API returned no assistant text. This client does not execute model-side tool calls.');
      onEvent({type:'text',text:content});return {};
    }
    if(!r.body)throw new Error('API returned an empty stream.');
    let completed=false,ended=false,bytes=0,thinking=false;
    const parser=new SSE((event,raw)=>{
      this.log.add('in',`${event!=='message'?event+': ':''}${raw.slice(0,300)}`);
      if(raw==='[DONE]'){completed=ended=true;return;}
      let data;try{data=JSON.parse(raw);}catch{throw new Error('Invalid JSON in API event stream.');}
      if(data.error)throw new Error(String(data.error.message||'The agent run failed.'));
      // Hermes and other gateways report their own tool runs as named events; show them as activity.
      if(event!=='message'&&/tool|progress|status|step/i.test(event)) {
        const name=String(data.tool_name||data.tool||data.name||data.label||data.status||data.message||'agent tool').slice(0,160);
        onEvent({type:'activity',text:`${event.replace(/^hermes\./,'').replace(/[._]/g,' ')}: ${name}`});return;
      }
      const choice=data.choices?.[0]||{},delta=choice.delta||choice.message||{};
      const reasoning=delta.reasoning_content??delta.reasoning;
      if(!thinking&&typeof reasoning==='string'&&reasoning.trim()){thinking=true;onEvent({type:'activity',text:'Thinking'});}
      const text=textOf(delta.content);
      if(text) {bytes+=text.length;if(bytes>2*1024*1024)throw new Error('Assistant output exceeds the safety limit.');onEvent({type:'text',text});}
      if(delta.tool_calls?.length)throw new Error('This endpoint requested client-side tools. Use an agent gateway that executes its own tools, or connect through ACP.');
      // Some gateways end with finish_reason and close without the [DONE] marker; that is a complete answer.
      if(choice.finish_reason&&choice.finish_reason!=='tool_calls')completed=true;
    });
    const reader=r.body.getReader(),decoder=new TextDecoder();
    try {
      while(true){const {done,value}=await reader.read();if(done)break;parser.feed(decoder.decode(value,{stream:true}));if(ended)break;}
      parser.feed(decoder.decode());parser.end();
      if(!completed)throw new Error('The stream disconnected before its completion marker. Partial output was kept; the task may still be running remotely.');
    }finally{await reader.cancel().catch(()=>{});}
    return {};
  }
  diagnostics(){return {protocol:'http',endpoint:this.url,...this.log.toJSON()};}
  close(){this.tunnel?.close();}
  async listModels(){
    const r=await this.fetch(`${this.url}/models`,{headers:this.headers(),signal:AbortSignal.timeout(15000),redirect:'error'});
    if(r.status===404&&this.agent.provider==='openclaw'){await r.body?.cancel();this.models=[...new Set(['openclaw',this.agent.model].filter(Boolean))];}
    else{
      if(!r.ok){await r.body?.cancel();throw new Error(this.failure(r.status));}
      const data=JSON.parse(await limitedBody(r,256*1024));this.models=(data.data||[]).map(m=>m.id).filter(m=>typeof m==='string');
    }
    if(this.agent.provider==='hermes'){
      const options=await this.fetch(this.url.replace(/\/v1$/,'')+'/api/model/options',{headers:this.headers(),signal:AbortSignal.timeout(15000),redirect:'error'});
      if(options.ok){
        const inventory=JSON.parse(await limitedBody(options,2*1024*1024));
        for(const provider of inventory.providers||[]){if(!provider.authenticated)continue;for(const model of provider.models||[]){const id=typeof model==='string'?model:model.id||model.model;if(id&&provider.slug)this.models.push(`${provider.slug}:${id}`);}}
      }else{await options.body?.cancel();if(![404,405,501].includes(options.status))throw new Error(this.failure(options.status));}
    }
    // OpenClaw: the models of the providers it is signed in to, from its CLI where it runs (chosen per chat or as default).
    if(this.agent.provider==='openclaw'){
      try{const r=await openclaw.models(this.agent,this.host);this.models.push(...r.models);this.defaultModel=r.default;}
      catch(error){this.log.add('err',`openclaw models list: ${String(error?.message||error).slice(0,300)}`);}
      this.refreshThinking();
    }
    return [...new Set(this.models)].slice(0,500);
  }
}
module.exports={HttpAdapter,SSE};
