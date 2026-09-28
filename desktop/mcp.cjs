'use strict';
// MCP server library. Opaya keeps the list and hands the servers to agents that accept them per session (ACP
// session/new mcpServers, Claude --mcp-config). Environment values and HTTP headers can hold API keys, so they live in
// the OS-encrypted vault and never appear in workspace.json, the renderer or the Opaya Agent.
const path=require('node:path');
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
// One-click servers. Opaya's own browser is turned on per agent (it gets a fresh token each session, so it is never
// written into a config). The others are well-known servers started with npx or uvx on the machine where the agent
// runs, or remote HTTPS servers. `secret` is what the user types once, in a masked field; it goes to the vault as an
// environment variable or a header. `folder` is a path the server may use, on the agent's machine.
const CATALOG=[
  {id:'opaya-browser',title:'Opaya browser',own:true,description:'The browser pane in Opaya: the agent opens pages you watch, reads them, clicks and types. For agents on this computer with a model that sees images.'},
  {id:'filesystem',name:'filesystem',title:'Files',description:'Read and write files in one folder you choose.',type:'stdio',command:'npx',args:['-y','@modelcontextprotocol/server-filesystem','{folder}'],folder:{label:'Folder the agent may use (on the machine where it runs)'},needs:'Node.js'},
  {id:'fetch',name:'fetch',title:'Fetch',description:'Fetch web pages and read them as text.',type:'stdio',command:'uvx',args:['mcp-server-fetch'],needs:'uv'},
  {id:'memory',name:'memory',title:'Memory',description:'A knowledge graph the agent keeps between chats.',type:'stdio',command:'npx',args:['-y','@modelcontextprotocol/server-memory'],needs:'Node.js'},
  {id:'sequential-thinking',name:'sequential-thinking',title:'Sequential thinking',description:'Step-by-step problem solving with revisions.',type:'stdio',command:'npx',args:['-y','@modelcontextprotocol/server-sequential-thinking'],needs:'Node.js'},
  {id:'playwright',name:'playwright',title:'Playwright',description:'A headless browser the agent drives on its own machine (Microsoft).',type:'stdio',command:'npx',args:['-y','@playwright/mcp@latest'],needs:'Node.js'},
  {id:'github',name:'github',title:'GitHub',description:'Issues, pull requests and code, from GitHub\'s own remote server.',type:'http',url:'https://api.githubcopilot.com/mcp/',secret:{kind:'header',name:'Authorization',prefix:'Bearer ',label:'GitHub personal access token'}},
  {id:'context7',name:'context7',title:'Context7',description:'Current documentation and examples for libraries and frameworks.',type:'http',url:'https://mcp.context7.com/mcp',secret:{kind:'header',name:'CONTEXT7_API_KEY',label:'Context7 API key (optional, for higher limits)',optional:true}},
  {id:'brave-search',name:'brave-search',title:'Brave Search',description:'Web and news search.',type:'stdio',command:'npx',args:['-y','@brave/brave-search-mcp-server'],secret:{kind:'env',name:'BRAVE_API_KEY',label:'Brave Search API key'},needs:'Node.js'},
  {id:'git',name:'git',title:'Git',description:'Read and work with local Git repositories.',type:'stdio',command:'uvx',args:['mcp-server-git'],needs:'uv'},
  {id:'time',name:'time',title:'Time',description:'Current time and time zone conversions.',type:'stdio',command:'uvx',args:['mcp-server-time'],needs:'uv'}
];
const catalog=()=>CATALOG.map(({secret,folder,...c})=>({...c,...(secret?{secret:{label:secret.label,optional:!!secret.optional,kind:secret.kind,name:secret.name}}:{}),...(folder?{folder:{label:folder.label}}:{})}));
// The server (and its secret as NAME=value text) for a catalog entry. Everything but the typed values comes from here.
function fromCatalog(id,{secret='',folder='',agents='all',keep=false}={}){
  const c=CATALOG.find(x=>x.id===id&&!x.own);if(!c)throw new Error('Unknown MCP server.');
  const value=String(secret||'').trim();
  if(c.secret&&!value&&!c.secret.optional&&!keep)throw new Error(`Enter the ${c.secret.label}.`); // keep: an update without a new key keeps the saved one
  if(/[\0\r\n]/.test(value)||value.length>4000)throw new Error('Paste the key on one line.');
  let args=c.args||[];
  if(c.folder){const f=String(folder||'').trim();if(!f||f.length>1024||/[\0\r\n]/.test(f)||!(path.posix.isAbsolute(f)||path.win32.isAbsolute(f)))throw new Error('Choose the full path of the folder, for example /home/you/projects.');args=args.map(a=>a==='{folder}'?f:a);}
  const line=c.secret&&value?`${c.secret.name}${c.secret.kind==='header'?': ':'='}${c.secret.prefix||''}${value}`:'';
  return {server:{name:c.name,type:c.type,command:c.command||'',args,url:c.url||'',agents,note:c.title,enabled:true},env:c.secret?.kind==='env'?line:'',headers:c.secret?.kind==='header'?line:''};
}
// What the UI and the Opaya Agent may see: never values, only names.
const publicView=s=>({id:s.id,name:s.name,type:s.type,command:s.command,args:s.args,url:s.url,envNames:s.envNames,headerNames:s.headerNames,agents:s.agents,enabled:s.enabled,note:s.note});
module.exports={server,secrets,acpServers,claudeConfig,appliesTo,publicView,vaultKey,CATALOG,catalog,fromCatalog};
