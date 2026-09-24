'use strict';
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {launch,collect,terminate}=require('../process.cjs');
const {claudeConfig}=require('../mcp.cjs');
// MCP servers go to Claude in a private temporary file, so tokens in env or headers stay off the command line.
function mcpFile(servers){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'opaya-mcp-'));const file=path.join(dir,'mcp.json');
  fs.writeFileSync(file,JSON.stringify(claudeConfig(servers)),{mode:0o600});
  return {file,remove:()=>fs.rmSync(dir,{recursive:true,force:true})};
}
class ClaudeAdapter{
  constructor({agent,host,spawnAgent=launch,mcpServers=()=>[]}){this.agent=agent;this.host=host;this.spawnAgent=spawnAgent;this.mcpServers=mcpServers;}
  async connect(){
    const version=await collect(this.spawnAgent(this.agent,[...this.agent.args,'--version'],this.host),{timeout:15000,maxBytes:16384});
    return {description:`CLI available: ${version.trim().slice(0,100)}. Sign-in is checked when sending.`};
  }
  async run(ctx){
    const args=[...this.agent.args,'-p','--output-format','stream-json','--verbose','--include-partial-messages','--permission-mode','default'];
    if(ctx.conversation.externalSessionId)args.push('--resume',ctx.conversation.externalSessionId);
    const model=ctx.conversation.model||this.agent.model;if(model)args.push('--model',model);
    const servers=this.mcpServers()||[];let config=null;
    if(servers.length&&this.agent.transport==='ssh')ctx.onEvent({type:'activity',text:'MCP servers from Opaya are not passed to Claude over SSH. Add them on that machine with `claude mcp add`.'});
    else if(servers.length){config=mcpFile(servers);args.push('--mcp-config',config.file);}
    let child;try{child=this.spawnAgent(ctx.cwd?{...this.agent,cwd:ctx.cwd}:this.agent,args,this.host);}catch(error){config?.remove();throw error;}this.child=child;
    return new Promise((resolve,reject)=>{
      let buffer='',stderr='',sessionId='',sawText=false,resultSeen=false,done=false,resultError='';
      const finish=(error)=>{if(done)return;done=true;config?.remove();clearTimeout(timer);ctx.signal.removeEventListener('abort',cancel);this.child=null;error?reject(error):resolve({externalSessionId:sessionId||ctx.conversation.externalSessionId});};
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
      child.stdin.end(ctx.text);
      if(ctx.signal.aborted)cancel();
    });
  }
  close(){terminate(this.child);}
}
module.exports={ClaudeAdapter};
