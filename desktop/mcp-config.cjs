'use strict';
// MCP servers written into an agent's own config, for agents that read them only from there: Claude Code on a machine
// or in a container (user servers in ~/.claude.json; on this computer Opaya passes --mcp-config with every message
// instead), Codex ([mcp_servers.<name>] in ~/.codex/config.toml) and OpenClaw (openclaw mcp set). ACP agents such as
// Hermes and OpenCode get them with each new session and need nothing written. Files are read and written where the
// agent runs (this computer, an SSH machine or its container) through a temporary file, with values on stdin; only
// the entry with this server's name changes and everything else in the file stays as it was.
const os=require('node:os');
const path=require('node:path');
const {place,isLocal}=require('./clone.cjs');
const secrets=require('./secrets.cjs');
// How an agent gets Opaya's MCP servers: session (ACP session/new), flag (claude --mcp-config), claude, codex, openclaw
// (written into its config), or '' (not possible).
function mode(agent){
  if(agent.provider==='openclaw')return 'openclaw';
  if(agent.protocol==='acp')return 'session';
  if(agent.protocol==='claude')return agent.transport==='ssh'||agent.command==='docker'?'claude':'flag';
  if(agent.protocol==='codex')return 'codex';
  return '';
}
const written=agent=>['claude','codex','openclaw'].includes(mode(agent));
const LABEL={claude:'~/.claude.json (mcpServers)',codex:'~/.codex/config.toml ([mcp_servers])',openclaw:'OpenClaw\'s config (mcp.servers)'};
// ---- Claude Code: ~/.claude.json, the same entry `claude mcp add --scope user` writes -----------------------------
function claudeEntry(server,secret={}){
  if(server.type==='stdio')return {type:'stdio',command:server.command,args:server.args||[],env:{...(secret.env||{})}};
  return {type:server.type,url:server.url,...(Object.keys(secret.headers||{}).length?{headers:{...secret.headers}}:{})};
}
function setClaude(text,name,entry){
  let data={};const raw=String(text||'').replace(/^﻿/,'').trim();
  if(raw){try{data=JSON.parse(raw);}catch{throw new Error('.claude.json is not valid JSON, so Opaya does not change it. Fix it first.');}}
  if(!data||typeof data!=='object'||Array.isArray(data))throw new Error('.claude.json does not hold a JSON object, so Opaya does not change it.');
  if(data.mcpServers!==undefined&&(!data.mcpServers||typeof data.mcpServers!=='object'||Array.isArray(data.mcpServers)))throw new Error('.claude.json has mcpServers that is not an object, so Opaya does not change it.');
  const servers={...(data.mcpServers||{})};if(entry)servers[name]=entry;else{if(!(name in servers))return text;delete servers[name];}
  data.mcpServers=servers;return JSON.stringify(data,null,2)+'\n';
}
// ---- Codex: config.toml [mcp_servers.<name>] (stdio and streamable HTTP) -----------------------------------------
// TOML basic strings: JSON's escapes are valid TOML; DEL must be escaped too.
const tstr=v=>JSON.stringify(String(v)).replace(/\x7f/g,'\\u007f');
const tkey=k=>/^[A-Za-z0-9_-]+$/.test(k)?k:tstr(k);
const inline=obj=>`{ ${Object.entries(obj).map(([k,v])=>`${tstr(k)} = ${tstr(v)}`).join(', ')} }`;
function codexBlock(name,server,secret={}){
  const lines=[`[mcp_servers.${tkey(name)}]`];
  if(server.type==='stdio'){lines.push(`command = ${tstr(server.command)}`,`args = [${(server.args||[]).map(tstr).join(', ')}]`);if(Object.keys(secret.env||{}).length)lines.push(`env = ${inline(secret.env)}`);}
  else if(server.type==='http'){lines.push(`url = ${tstr(server.url)}`);if(Object.keys(secret.headers||{}).length)lines.push(`http_headers = ${inline(secret.headers)}`);}
  else throw new Error('Codex takes MCP servers that run as a program or over streamable HTTP, not SSE.');
  return lines.join('\n');
}
// The table name of a header line, or null. Tracks multi-line strings so text inside them is never taken for a table.
function tables(text){
  const lines=String(text||'').replace(/\r\n/g,'\n').split('\n'),out=[];let open='';
  lines.forEach((line,i)=>{
    if(open){if((line.split(open).length-1)%2===1)open='';out.push(null);return;}
    for(const q of ['"""',"'''"])if((line.split(q).length-1)%2===1){open=q;break;}
    const m=/^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/.exec(line);
    out.push(!open&&m?m[1].split('.').map(p=>p.trim().replace(/^"(.*)"$|^'(.*)'$/,'$1$2')):null);
  });
  return {lines,heads:out};
}
function setCodex(text,name,block){
  const {lines,heads}=tables(text);
  // Servers written as dotted keys or an inline table at the top level would be changed in two places: refuse.
  const first=heads.findIndex(h=>h);
  if(lines.slice(0,first<0?lines.length:first).some(l=>/^\s*mcp_servers\s*[.=]/.test(l)))throw new Error('config.toml sets mcp_servers in a form Opaya does not edit. Add the server with codex mcp add.');
  const out=[];let skip=false;
  lines.forEach((line,i)=>{const h=heads[i];if(h)skip=h[0]==='mcp_servers'&&h[1]===name;if(!skip)out.push(line);});
  while(out.length&&!out.at(-1).trim())out.pop();
  if(block)out.push(...(out.length?['']:[]),block);
  const next=out.length?out.join('\n')+'\n':'';
  return next===String(text||'').replace(/\r\n/g,'\n')?text:next;
}
// ---- Where and how -----------------------------------------------------------------------------------------------
async function configFile(kind,where){
  const local=isLocal(where),home=os.homedir(),env=process.env;
  if(kind==='claude')return local?path.join(env.CLAUDE_CONFIG_DIR||home,'.claude.json'):path.posix.join(await secrets.dirAt(where,'${CLAUDE_CONFIG_DIR:-$HOME}'),'.claude.json');
  return local?path.join(env.CODEX_HOME||path.join(home,'.codex'),'config.toml'):path.posix.join(await secrets.dirAt(where,'${CODEX_HOME:-$HOME/.codex}'),'config.toml');
}
// Turn `server` (with its vault secrets) on or off in `agent`'s config. Returns where it was written, or null when
// this agent takes servers another way.
async function write({agent,host,server,secret,enabled}){
  const kind=mode(agent);
  if(kind==='openclaw'){await require('./openclaw.cjs').setMcp(agent,agent.transport==='ssh'?host:null,server,secret,enabled);return {kind,where:LABEL.openclaw};}
  if(kind!=='claude'&&kind!=='codex')return null;
  const where=place({agent,host:agent.transport==='ssh'?host:null}),file=await configFile(kind,where),text=await secrets.readAt(where,file);
  const next=kind==='claude'?setClaude(text,server.name,enabled?claudeEntry(server,secret):null):setCodex(text,server.name,enabled?codexBlock(server.name,server,secret):null);
  if(next!==text)await secrets.writeAt(where,file,next);
  return {kind,where:file};
}
module.exports={mode,written,LABEL,claudeEntry,setClaude,codexBlock,setCodex,tables,configFile,write};
