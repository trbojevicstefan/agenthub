'use strict';
// OpenClaw's own CLI where an OpenClaw agent runs (this computer, a machine over SSH, or its Docker container), for what
// its gateway API does not offer: the models of the providers it is signed in to, its skills, and MCP servers.
// Commands are fixed; the only values passed in are checked model keys, MCP server names and their JSON config.
const {launch,collect,dockerExecContainerIndex}=require('./process.cjs');
const NAME=/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/;
const MODEL=/^[\w.-]{1,60}\/[\w.:@+\/-]{1,190}$/;
function run(agent,host,args,{timeout=45000,maxBytes=4*1024*1024}={}){
  const index=agent.command==='docker'?dockerExecContainerIndex(agent.args||[]):-1,base={...agent,hermesHome:'',cwd:''};
  const child=index>=0?launch({...base,command:'docker',args:[]},['exec',agent.args[index],'openclaw',...args],host):launch({...base,command:'openclaw',args:[]},args,host);
  return collect(child,{timeout,maxBytes});
}
// JSON from a CLI that may print a banner or warnings before it.
function json(text){
  const s=String(text||''),start=s.search(/^\s*[{[]/m);
  if(start<0)throw new Error('OpenClaw returned no JSON.');
  return JSON.parse(s.slice(start));
}
// A model key as OpenClaw writes it (provider/model); the gateway chat routes are openclaw and openclaw/<agent>.
const isRoute=model=>/^openclaw(\/|$)/.test(String(model||''));
const modelKey=model=>{const m=String(model||'').trim();if(!MODEL.test(m)||isRoute(m))throw new Error('Choose an OpenClaw model such as anthropic/claude-sonnet-5.');return m;};
// The models OpenClaw can use now (providers it is signed in to) plus the configured and default ones.
function parseModels(data){
  const list=(Array.isArray(data?.models)?data.models:[]).filter(m=>m&&typeof m.key==='string'&&MODEL.test(m.key));
  const tags=m=>Array.isArray(m.tags)?m.tags:[];
  const usable=list.filter(m=>m.available===true||tags(m).includes('default')||tags(m).includes('configured'));
  return {models:[...new Set(usable.map(m=>m.key))].slice(0,400),default:list.find(m=>tags(m).includes('default'))?.key||''};
}
// `models list` has the configured ones (with the default), `--all` the catalog with what is available now.
async function models(agent,host){
  const [configured,all]=await Promise.all([run(agent,host,['models','list','--json']),run(agent,host,['models','list','--all','--json']).catch(()=>'{"models":[]}')]);
  return parseModels({models:[...json(configured).models||[],...json(all).models||[]]});
}
// Skills OpenClaw loads, including bundled ones (they have no folder to copy); ineligible bundled ones are left out.
function parseSkills(data){
  return (Array.isArray(data?.skills)?data.skills:[]).filter(s=>s&&typeof s.name==='string'&&/^[\w.:-]{1,80}$/.test(s.name)&&(s.eligible||!s.bundled)&&!s.disabled)
    .slice(0,400).map(s=>({name:s.name,description:String(s.description||'').slice(0,400),category:s.bundled?'bundled with OpenClaw':String(s.source||'').replace(/^openclaw-/,'').slice(0,40)}));
}
async function skills(agent,host){return parseSkills(json(await run(agent,host,['skills','list','--json'])));}
// Opaya's MCP server (with its secrets) in OpenClaw's mcp.servers format.
function mcpConfig(server,secret={}){
  if(server.type==='stdio')return {command:server.command,args:server.args||[],...(Object.keys(secret.env||{}).length?{env:secret.env}:{})};
  return {url:server.url,...(server.type==='http'?{transport:'streamable-http'}:{}),...(Object.keys(secret.headers||{}).length?{headers:secret.headers}:{})};
}
async function setMcp(agent,host,server,secret,enabled){
  if(!NAME.test(server.name))throw new Error('Invalid MCP server name.');
  if(!enabled)return run(agent,host,['mcp','unset',server.name]).catch(error=>{if(!/not found|no such|unknown|no mcp server/i.test(String(error?.message||error)))throw error;});
  return run(agent,host,['mcp','set',server.name,JSON.stringify(mcpConfig(server,secret))]);
}
// ---- Thinking (reasoning effort) --------------------------------------------------------------------------------
// OpenClaw keeps a thinking level per session and its chat API has no field for it, so Opaya sets it with a gateway call
// through the CLI where OpenClaw runs. The CLI reads the gateway's port and token from OpenClaw's own config; nothing
// secret goes on the command line. Only possible where Opaya can run that CLI (this computer, SSH or its container).
const reachable=agent=>require('./attachments.cjs').placeOf(agent)!=='api';
// The gateway port the connection uses, for a CLI on the same machine (a container publishes it under another port).
const cliPort=agent=>{if(agent.command==='docker')return '';try{return new URL(agent.endpoint).port||'';}catch{return '';}};
// A gateway method; refusals come back as JSON on stdout with exit code 1.
async function call(agent,host,method,params,{port=''}={}){
  let out;
  try{out=await run(agent,host,['gateway','call',method,'--json','--params',JSON.stringify(params),...(port?['--port',String(port)]:[])],{timeout:30000,maxBytes:2*1024*1024});}
  catch(error){if(!error?.stdout)throw error;out=error.stdout;}
  let data;try{data=json(out);}catch{throw new Error('OpenClaw gateway call returned no JSON.');}
  if(data?.ok===false)throw new Error(String(data.error?.message||'OpenClaw refused the request.').slice(0,300));
  return data;
}
const LEVEL=/^[a-z][a-z0-9_-]{0,31}$/;
const levelsOf=list=>(Array.isArray(list)?list:[]).map(l=>typeof l==='string'?l:l?.id).filter(l=>typeof l==='string'&&LEVEL.test(l));
// The levels a refusal names: thinkingLevel "xhigh" is not supported for fake/thinker (use off|minimal|low|medium|high)
const offered=message=>levelsOf((/\(use ([a-z0-9_|-]+)\)/i.exec(String(message||''))?.[1]||'').split('|'));
// The session an OpenAI-compatible chat with user "agenthub:<conversation>" runs in: the default agent's for the
// openclaw and openclaw/default routes, agent:<id>:... for openclaw/<id>.
function sessionKey(route,conversationId){
  const id=/^openclaw[:/]([a-z0-9][a-z0-9_-]{0,63})$/i.exec(String(route||''))?.[1]?.toLowerCase();
  return `${id&&id!=='default'?`agent:${id}:`:''}openai-user:agenthub:${conversationId}`;
}
// The levels the gateway's default model takes (low to high), and its default level.
async function thinking(agent,host,{port=cliPort(agent),caller=call}={}){
  const d=(await caller(agent,host,'sessions.list',{limit:1},{port}))?.defaults||{};
  return {levels:require('./effort.cjs').order(levelsOf(d.thinkingLevels?.length?d.thinkingLevels:d.thinkingOptions)),default:LEVEL.test(d.thinkingDefault||'')?d.thinkingDefault:''};
}
module.exports={run,json,isRoute,modelKey,parseModels,models,parseSkills,skills,mcpConfig,setMcp,reachable,cliPort,call,levelsOf,offered,sessionKey,thinking};
