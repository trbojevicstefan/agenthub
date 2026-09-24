'use strict';
// MCP server library. Opaya keeps the list and hands the servers to agents that accept them per session (ACP
// session/new mcpServers, Claude --mcp-config). Environment values and HTTP headers can hold API keys, so they live in
// the OS-encrypted vault and never appear in workspace.json, the renderer or the Opaya Agent.
const {randomUUID}=require('node:crypto');
const {text,id}=require('./schema.cjs');
const TYPES=new Set(['stdio','http','sse']);
const NAME=/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/;
const ENV=/^[A-Za-z_][A-Za-z0-9_]{0,99}$/;
const HEADER=/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/;
const vaultKey=serverId=>`mcp-${serverId}`.slice(0,80);
function url(value){
  let u;try{u=new URL(text(value,'MCP URL',2048));}catch{throw new Error('Enter the full MCP server URL, for example https://mcp.example.com/mcp.');}
  if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.hash)throw new Error('Use an HTTP(S) MCP URL without credentials. Put tokens in Headers instead.');
  const loopback=['127.0.0.1','[::1]','localhost'].includes(u.hostname);
  if(u.protocol==='http:'&&!loopback)throw new Error('Unencrypted remote HTTP is not allowed. Use HTTPS.');
  return u.toString();
}
// "NAME=value" lines, one per line. Returns a plain object; used for env and headers.
function pairs(input,label,pattern){
  const out={};if(input===undefined||input===null||input==='')return out;
  const list=typeof input==='string'?input.split(/\r?\n/).filter(l=>l.trim()).map(l=>{const i=l.search(label==='header'?/[:=]/:/=/);if(i<1)throw new Error(`Write each ${label} as NAME${label==='header'?': ':'='}value.`);return [l.slice(0,i).trim(),l.slice(i+1).trim()];}):Object.entries(input);
  if(list.length>40)throw new Error(`Use at most 40 ${label} entries.`);
  for(const [k,v] of list){
    if(!pattern.test(k))throw new Error(`Invalid ${label} name: ${String(k).slice(0,40)}`);
    if(typeof v!=='string'||v.length>4000||/[\0\r\n]/.test(v))throw new Error(`Invalid value for ${k}.`);
    out[k]=v;
  }
  return out;
}
const names=(list,pattern)=>[...new Set((Array.isArray(list)?list:[]).filter(n=>typeof n==='string'&&pattern.test(n)))].slice(0,40);
function server(input){
  if(!input||typeof input!=='object')throw new Error('Missing MCP server.');
  const name=text(input.name,'MCP server name',40).trim();
  if(!NAME.test(name))throw new Error('MCP server names use letters, numbers, - and _ (up to 40).');
  const type=TYPES.has(input.type)?input.type:'stdio';
  const args=typeof input.args==='string'?input.args.split(/\r?\n/).map(a=>a.trim()).filter(Boolean):input.args||[];
  if(!Array.isArray(args)||args.length>32)throw new Error('Use at most 32 arguments.');
  const command=type==='stdio'?text(input.command,'command',2048).trim():'';
  if(type==='stdio'&&(!command||command.startsWith('-')||/[;&|`$<>]/.test(command)))throw new Error('Enter the MCP server executable (for example npx or uvx), not a shell command.');
  const agents=input.agents==='all'||input.agents===undefined?'all':Array.isArray(input.agents)?[...new Set(input.agents.map(id))].slice(0,128):(()=>{throw new Error('Choose which agents use this server.');})();
  return {id:input.id?id(input.id):randomUUID(),name,type,command,args:type==='stdio'?args.map(a=>text(a,'argument',2048)):[],url:type==='stdio'?'':url(input.url),
    envNames:names(input.envNames,ENV),headerNames:type==='stdio'?[]:names(input.headerNames,HEADER),
    agents,enabled:input.enabled!==false,note:text(input.note,'note',300).trim()};
}
// Secrets arrive as "NAME=value" text from the settings form. Empty text keeps what is saved.
function secrets({env,headers}={}){return {env:pairs(env,'environment variable',ENV),headers:pairs(headers,'header',HEADER)};}
const appliesTo=(s,agentId)=>s.enabled&&(s.agents==='all'||s.agents.includes(agentId));
// ACP wire format (also what Hermes, Zed and other ACP agents accept).
function acpServers(list,agentId,readSecrets){
  return list.filter(s=>appliesTo(s,agentId)).map(s=>{
    const secret=readSecrets(s.id);
    if(s.type==='stdio')return {name:s.name,command:s.command,args:s.args,env:Object.entries(secret.env||{}).map(([name,value])=>({name,value}))};
    return {type:s.type,name:s.name,url:s.url,headers:Object.entries(secret.headers||{}).map(([name,value])=>({name,value}))};
  });
}
// Claude Code --mcp-config format.
function claudeConfig(servers){
  return {mcpServers:Object.fromEntries(servers.map(s=>[s.name,s.type&&s.type!=='stdio'?{type:s.type,url:s.url,headers:Object.fromEntries((s.headers||[]).map(h=>[h.name,h.value]))}:{command:s.command,args:s.args,env:Object.fromEntries((s.env||[]).map(e=>[e.name,e.value]))}]))};
}
// What the UI and the Opaya Agent may see: never values, only names.
const publicView=s=>({id:s.id,name:s.name,type:s.type,command:s.command,args:s.args,url:s.url,envNames:s.envNames,headerNames:s.headerNames,agents:s.agents,enabled:s.enabled,note:s.note});
module.exports={server,secrets,acpServers,claudeConfig,appliesTo,publicView,vaultKey};
