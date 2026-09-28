'use strict';
// MCP server (stdio) that lets an agent take keys from the Opaya Vault. Opaya starts it for agents on this computer:
// `<Opaya executable> vault-mcp.cjs` with ELECTRON_RUN_AS_NODE=1, OPAYA_VAULT_AGENT set to the agent's id. It connects
// to the session service with a scoped token that can only call vaultTool. vault_list returns names only; vault_use asks
// the user in Opaya, then Opaya writes the key into the file this agent reads keys from. A value never comes back here.
const {connect}=require('./wire.cjs');
const VERSION='1.0.0';
const TOOLS=[
  {name:'vault_list',description:'List the API keys, tokens and passwords in the Opaya Vault: their names (such as OPENROUTER_API_KEY), a masked hint, the endpoint when one was saved, and whether you already have them. Values are never shown.',inputSchema:{type:'object',properties:{}}},
  {name:'vault_use',description:'Ask for a key from the Opaya Vault. The user approves it in Opaya (unless iTrust is on), then Opaya writes NAME=value (and NAME_BASE_URL when the key has an endpoint) into the file you read keys from: .env of a Hermes home, OpenClaw\'s .env, env in Claude Code\'s settings.json, or Codex\'s .env. You get the variable name and the file, never the value: read it from that file or your environment when you need it, and never print it.',inputSchema:{type:'object',properties:{name:{type:'string',description:'The key name from vault_list, for example OPENROUTER_API_KEY.'},why:{type:'string',description:'One sentence for the user: what you need it for.'}},required:['name']}}
];
let client=null;
async function service(){
  if(client)return client;
  const endpoint=process.env.OPAYA_VAULT_ENDPOINT,token=process.env.OPAYA_VAULT_TOKEN;
  if(!endpoint||!token)throw new Error('The Opaya Vault is not configured. Start this agent from Opaya.');
  client=await connect(endpoint,token,4000);client.on('closed',()=>{client=null;});return client;
}
async function call(name,args){
  if(!TOOLS.some(t=>t.name===name))throw new Error(`Unknown tool ${name}.`);
  const value=await (await service()).call('vaultTool',{agentId:process.env.OPAYA_VAULT_AGENT||'',op:name==='vault_list'?'list':'use',name:args?.name,why:args?.why},11*60*1000);
  return {content:[{type:'text',text:JSON.stringify(value).slice(0,20000)}],isError:false};
}
const reply=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\n');
const fail=(id,message)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,error:{code:-32603,message}})+'\n');
let buffer='';
process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>{
  buffer+=chunk;let i;
  while((i=buffer.indexOf('\n'))>=0){
    const line=buffer.slice(0,i).trim();buffer=buffer.slice(i+1);if(!line)continue;
    let m;try{m=JSON.parse(line);}catch{continue;}
    if(m.method==='initialize')reply(m.id,{protocolVersion:m.params?.protocolVersion||'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'opaya-vault',version:VERSION},instructions:'Opaya Vault: the user\'s API keys. When a task needs a key (an API, a provider, a service), call vault_list, then vault_use with its name. The key lands in your env file; read it from there. Never print a key or put it in code, commits or chat.'});
    else if(m.method==='tools/list')reply(m.id,{tools:TOOLS});
    else if(m.method==='tools/call')call(m.params?.name,m.params?.arguments).then(r=>reply(m.id,r),e=>reply(m.id,{content:[{type:'text',text:`Opaya Vault: ${e.message}`}],isError:true}));
    else if(m.method==='ping')reply(m.id,{});
    else if(m.id!==undefined&&m.method)fail(m.id,`Method not found: ${m.method}`);
  }
});
process.stdin.on('end',()=>{client?.close();process.exit(0);});
