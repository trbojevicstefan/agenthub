'use strict';
// MCP server (stdio) that gives Claude Code the Opaya Agent's tools when Claude Code is the Opaya Agent's model.
// Opaya starts it through `claude --mcp-config` as `<Opaya executable> opaya-tools-mcp.cjs` with ELECTRON_RUN_AS_NODE=1.
// It connects to the session service with a scoped token that can only list and call these tools, and only while
// the Opaya Agent is working on a request; every change still asks the user for approval in Opaya.
const {connect}=require('./wire.cjs');
const VERSION='1.0.0';
let client=null;
async function service(){
  if(client)return client;
  const endpoint=process.env.OPAYA_TOOLS_ENDPOINT,token=process.env.OPAYA_TOOLS_TOKEN;
  if(!endpoint||!token)throw new Error('Opaya tools are not configured. Use them from the Opaya Agent.');
  client=await connect(endpoint,token,4000);client.on('closed',()=>{client=null;});return client;
}
const reply=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\n');
const fail=(id,message)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,error:{code:-32603,message}})+'\n');
async function tools(){return (await (await service()).call('opayaToolList',{},15000)).map(t=>({name:t.name,description:t.description,inputSchema:t.parameters}));}
async function call(name,args){
  const value=await (await service()).call('opayaToolCall',{name,args:args||{}},15*60*1000);
  return {content:[{type:'text',text:JSON.stringify(value).slice(0,24000)}],isError:false};
}
let buffer='';
process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>{
  buffer+=chunk;let i;
  while((i=buffer.indexOf('\n'))>=0){
    const line=buffer.slice(0,i).trim();buffer=buffer.slice(i+1);if(!line)continue;
    let m;try{m=JSON.parse(line);}catch{continue;}
    if(m.method==='initialize')reply(m.id,{protocolVersion:m.params?.protocolVersion||'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'opaya',version:VERSION},instructions:'The Opaya Agent tools: read the workspace, install and connect agents and tools, run fixed checks. The user approves every change in Opaya.'});
    else if(m.method==='tools/list')tools().then(list=>reply(m.id,{tools:list}),e=>fail(m.id,e.message));
    else if(m.method==='tools/call')call(m.params?.name,m.params?.arguments).then(r=>reply(m.id,r),e=>reply(m.id,{content:[{type:'text',text:JSON.stringify({error:String(e.message||e).slice(0,1000)})}],isError:true}));
    else if(m.method==='ping')reply(m.id,{});
    else if(m.id!==undefined&&m.method)fail(m.id,`Method not found: ${m.method}`);
  }
});
process.stdin.on('end',()=>{client?.close();process.exit(0);});
