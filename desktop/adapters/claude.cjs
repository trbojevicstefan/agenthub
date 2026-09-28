'use strict';
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {launch,collect,terminate,inFolder}=require('../process.cjs');
const {claudeConfig}=require('../mcp.cjs');
const attach=require('../attachments.cjs');
const levels=require('../effort.cjs');
// MCP servers go to Claude in a private temporary file, so tokens in env or headers stay off the command line.
function mcpFile(servers){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'opaya-mcp-'));const file=path.join(dir,'mcp.json');
  fs.writeFileSync(file,JSON.stringify(claudeConfig(servers)),{mode:0o600});
  return {file,remove:()=>fs.rmSync(dir,{recursive:true,force:true})};
}
// Claude Code has no model list API; its --model flag takes these aliases (always the latest of each family) and full ids.
const CLAUDE_MODELS=['sonnet','opus','haiku','opusplan','claude-opus-5-5','claude-sonnet-5','claude-fable-5-1','claude-haiku-4-5-20251001'];
class ClaudeAdapter{
  async listModels(){return [...new Set([...CLAUDE_MODELS,this.agent.model].filter(Boolean))];}
  constructor({agent,host,spawnAgent=launch,mcpServers=()=>[],trusted=()=>false,onChange=()=>{}}){this.trusted=trusted;this.agent=agent;this.host=host;this.spawnAgent=spawnAgent;this.mcpServers=mcpServers;this.onChange=onChange;this.noEffort=false;}
  // --effort takes these; a Claude Code too old for the flag gets none (found on the first turn that uses it).
  get efforts(){return this.noEffort?[]:levels.CLAUDE;}
  async connect(){
    const version=await collect(this.spawnAgent(this.agent,[...this.agent.args,'--version'],this.host),{timeout:15000,maxBytes:16384});
    return {description:`CLI available: ${version.trim().slice(0,100)}. Sign-in is checked when sending.`};
  }
  async run(ctx){
    const agent=inFolder(this.agent,ctx.cwd),items=ctx.attachments||[],remote=attach.placeOf(this.agent)!=='local';
    // Attached files: text inlined, images up to 3.75 MB as image blocks (stream-json input), everything else by a path in
    // a folder Claude may read (the chat's attachments folder here, or a copy on the machine or container it runs in).
    const images=items.filter(i=>i.kind==='image'&&i.size<=attach.INLINE_IMAGE),cut=attach.plan(items);
    const linked=items.filter(i=>i.kind==='file'||i.kind==='image'&&!images.includes(i)||cut.has(i));
    const where=linked.length?await attach.locate(this.agent,this.host,linked,ctx.conversation.id,{signal:ctx.signal,onEvent:ctx.onEvent,spawn:this.spawnAgent,copyTo:ctx.filesDir||''}):new Map();
    const text=items.length?attach.compose(ctx.text,items,i=>where.get(i)||''):ctx.text;
    const args=[...agent.args,'-p','--output-format','stream-json','--verbose','--include-partial-messages','--permission-mode',this.trusted()?'bypassPermissions':'default'];
    if(images.length)args.push('--input-format','stream-json');
    if(ctx.conversation.externalSessionId)args.push('--resume',ctx.conversation.externalSessionId);
    const model=ctx.conversation.model||this.agent.model;if(model)args.push('--model',model);
    const effort=this.noEffort?'':levels.nearest(ctx.effort||'',levels.CLAUDE);if(effort)args.push('--effort',effort);
    const dirs=[...new Set([...where.values()].map(p=>(remote?path.posix:path).dirname(p)))];if(dirs.length)args.push('--add-dir',...dirs);
    const servers=this.mcpServers()||[];let config=null;
    // On a machine or in a container Claude reads Opaya's servers from its own ~/.claude.json, where Opaya writes them
    // when they are turned on (mcp-config.cjs); a file on this computer would not be there.
    if(servers.length&&this.agent.transport!=='ssh'&&this.agent.command!=='docker'){config=mcpFile(servers);args.push('--mcp-config',config.file);}
    try{
      // The prompt goes on stdin: plain text, or one stream-json user message when it carries images.
      const input=images.length?JSON.stringify({type:'user',message:{role:'user',content:[{type:'text',text},...await Promise.all(images.map(async i=>({type:'image',source:{type:'base64',media_type:i.mime,data:await attach.base64(i)}})))]}})+'\n':text;
      try{return await this.turn(agent,args,input,ctx);}
      catch(error){
        // Claude Code before --effort existed: answer without it, and stop offering it.
        if(!effort||ctx.signal.aborted||!/unknown option.*--effort/i.test(String(error?.message||'')))throw error;
        this.noEffort=true;this.onChange();ctx.onEvent({type:'activity',text:'This Claude Code version has no reasoning effort setting, so it answers with its own (update it with claude update).'});
        args.splice(args.indexOf('--effort'),2);return await this.turn(agent,args,input,ctx);
      }
    }finally{config?.remove();}
  }
  turn(agent,args,input,ctx){
    const child=this.spawnAgent({...agent,args:this.agent.args},args,this.host);this.child=child;
    return new Promise((resolve,reject)=>{
      let buffer='',stderr='',sessionId='',sawText=false,resultSeen=false,done=false,resultError='';
      const finish=(error)=>{if(done)return;done=true;clearTimeout(timer);ctx.signal.removeEventListener('abort',cancel);this.child=null;error?reject(error):resolve({externalSessionId:sessionId||ctx.conversation.externalSessionId});};
      const cancel=()=>{terminate(child);finish(new Error('Cancelled.'));};
      const timer=setTimeout(()=>{terminate(child);finish(new Error('Claude turn timed out.'));},10*60*1000);
      ctx.signal.addEventListener('abort',cancel,{once:true});
      child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
      const parse=line=>{
        if(!line.trim())return;
        let e;try{e=JSON.parse(line);}catch{terminate(child);finish(new Error('Claude emitted invalid stream-json. Check its version in Terminal.'));return;}
        if(e.session_id)sessionId=e.session_id;
        if(e.type==='stream_event'&&e.event?.delta?.type==='text_delta'){sawText=true;ctx.onEvent({type:'text',text:e.event.delta.text});}
        if(e.type==='assistant'&&!sawText){for(const c of e.message?.content||[])if(c.type==='text'){ctx.onEvent({type:'text',text:c.text});sawText=true;}}
        if(e.type==='system'&&e.subtype==='api_retry')ctx.onEvent({type:'activity',text:'Claude is retrying a provider request.'});
        if(e.type==='result'){
          resultSeen=true;
          if(e.is_error)resultError=String(e.result||e.errors?.join('\n')||'Claude could not complete this request.');
          if(!sawText&&typeof e.result==='string'&&!e.is_error)ctx.onEvent({type:'text',text:e.result});
          if(Array.isArray(e.permission_denials)&&e.permission_denials.length)ctx.onEvent({type:'activity',text:'Claude denied tools in headless mode. Open the native CLI in Terminal to approve them interactively.'});
        }
      };
      child.stdout.on('data',chunk=>{
        if(done)return;buffer+=chunk;
        if(buffer.length>4*1024*1024){terminate(child);finish(new Error('Claude event exceeds the safety limit.'));return;}
        let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);parse(line);}
      });
      child.stderr.on('data',c=>{stderr=(stderr+c).slice(-4000);});
      child.on('error',finish);
      child.on('close',code=>{if(buffer.trim())parse(buffer);finish(code!==0?new Error(stderr||`Claude exited (${code}).`):resultError?new Error(resultError):!resultSeen?new Error('Claude exited before a final result. Partial output was kept.'):null);});
      child.stdin.on('error',()=>{});
      // Prompt stays off the command line and process list, including over SSH.
      child.stdin.end(input);
      if(ctx.signal.aborted)cancel();
    });
  }
  close(){terminate(this.child);}
}
module.exports={ClaudeAdapter};
