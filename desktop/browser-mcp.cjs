'use strict';
// MCP server (stdio) that gives an agent Opaya's browser pane. Opaya starts it for agents that have "Opaya browser"
// turned on: `<Opaya executable> browser-mcp.cjs` with ELECTRON_RUN_AS_NODE=1. It connects to the session service with a
// scoped token that can only call browserTool; the page opens in the pane the user is watching.
const {connect}=require('./wire.cjs');
const VERSION='1.0.0';
// The agent's own tab in the Opaya browser, which the user watches. opaya_* names are accepted as aliases.
const W='Opaya browser: ';
const TOOLS=[
  {name:'browser_open',description:W+'open a web address (or search words), then return the page text, links and form fields.',inputSchema:{type:'object',properties:{url:{type:'string',description:'https://..., localhost:3000, or search words'}},required:['url']}},
  {name:'browser_read',description:W+'read the current page again: URL, title, visible text, links and form fields.',inputSchema:{type:'object',properties:{max_chars:{type:'integer',description:'Text limit, default 12000'}}}},
  {name:'browser_screenshot',description:W+'take a screenshot of the current page.',inputSchema:{type:'object',properties:{}}},
  {name:'browser_click',description:W+'click an element by CSS selector, or by its visible text (a link or button label).',inputSchema:{type:'object',properties:{selector:{type:'string'},text:{type:'string'}}}},
  {name:'browser_type',description:W+'type into an input (CSS selector, or the focused field). Set submit to press Enter / submit the form.',inputSchema:{type:'object',properties:{selector:{type:'string'},text:{type:'string'},submit:{type:'boolean'}},required:['text']}},
  {name:'browser_scroll',description:W+'scroll the page by a number of pixels (negative scrolls up).',inputSchema:{type:'object',properties:{dy:{type:'integer'}}}},
  {name:'browser_back',description:W+'go back to the previous page.',inputSchema:{type:'object',properties:{}}},
  {name:'browser_close',description:W+'close your browser tab when you are done; its page is forgotten (logins stay).',inputSchema:{type:'object',properties:{}}}
];
const OPS={browser_open:['open',a=>({url:a.url})],browser_read:['read',a=>({max:a.max_chars})],browser_screenshot:['screenshot',()=>({})],browser_click:['click',a=>({selector:a.selector,text:a.text})],browser_type:['type',a=>({selector:a.selector,text:a.text,submit:a.submit})],browser_scroll:['scroll',a=>({dy:a.dy})],browser_back:['back',()=>({})],browser_close:['close',()=>({})]};
for(const k of Object.keys(OPS))OPS[k.replace('browser_','opaya_')]=OPS[k];
let client=null;
async function service(){
  if(client)return client;
  const endpoint=process.env.OPAYA_BROWSER_ENDPOINT,token=process.env.OPAYA_BROWSER_TOKEN;
  if(!endpoint||!token)throw new Error('Opaya browser is not configured. Start this agent from Opaya.');
  client=await connect(endpoint,token,4000);client.on('closed',()=>{client=null;});return client;
}
function text(value){
  const {image,...rest}=value||{};const lines=[`URL: ${rest.url||''}`,`Title: ${rest.title||''}`];
  if(rest.error)lines.push(`Error: ${rest.error}`);if(rest.dialog)lines.push(rest.dialog);if(rest.clicked)lines.push(`Clicked: ${rest.clicked}`);if(rest.typed)lines.push('Typed.');
  if(rest.text)lines.push('',rest.text);
  if(rest.inputs?.length)lines.push('','Form fields:',...rest.inputs.map(i=>`- ${i.tag}${i.type?`[${i.type}]`:''}${i.id?` #${i.id}`:''}${i.name?` name=${i.name}`:''} ${i.label}`));
  if(rest.links?.length)lines.push('','Links:',...rest.links.map(l=>`- ${l.text}: ${l.href}`));
  return lines.join('\n');
}
// One MCP conversation over lines of JSON: `send(line)` writes a reply, `browserTool(input)` drives the agent's tab.
// Used by this program over stdio (agents on this computer) and by the session service for agents on other machines
// and in containers, whose lines come through a relay (remote-bridge.cjs).
const INSTRUCTIONS='Opaya browser: your own browser tab in Opaya, which the user watches on your screen. browser_open returns the page as text with its links and form fields; browser_click takes a CSS selector or the visible text of a link or button; browser_type fills a field (submit:true presses Enter); browser_read reads the page again after it changed; browser_close closes your tab when you are done. Ask before submitting forms that buy, send or delete things.';
function serve({send,browserTool,agent='',textOnly=false}){
  const reply=(id,result)=>send(JSON.stringify({jsonrpc:'2.0',id,result}));
  const fail=(id,message)=>send(JSON.stringify({jsonrpc:'2.0',id,error:{code:-32603,message}}));
  const call=async(name,args)=>{
    const op=OPS[name];if(!op)throw new Error(`Unknown tool ${name}.`);
    const value=await browserTool({op:op[0],args:op[1](args||{}),agent});
    const content=[{type:'text',text:text(value)}];
    if(value?.image)content.push({type:'image',data:value.image,mimeType:'image/png'});
    return {content,isError:!!value?.error};
  };
  return line=>{
    line=String(line||'').trim();if(!line)return;let m;try{m=JSON.parse(line);}catch{return;}
    if(m.method==='initialize')reply(m.id,{protocolVersion:m.params?.protocolVersion||'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'opaya-browser',version:VERSION},instructions:INSTRUCTIONS});
    // A model that reads text only gets every tool but the screenshot; pages always come back as text.
    else if(m.method==='tools/list')reply(m.id,{tools:textOnly?TOOLS.filter(t=>t.name!=='browser_screenshot'):TOOLS});
    else if(m.method==='tools/call')call(m.params?.name,m.params?.arguments).then(r=>reply(m.id,r),e=>reply(m.id,{content:[{type:'text',text:`Browser error: ${e.message}`}],isError:true}));
    else if(m.method==='ping')reply(m.id,{});
    else if(m.id!==undefined&&m.method)fail(m.id,`Method not found: ${m.method}`);
  };
}
module.exports={serve,TOOLS,OPS,text};
if(require.main===module){
  const onLine=serve({send:line=>process.stdout.write(line+'\n'),browserTool:async input=>(await service()).call('browserTool',input,120000),agent:process.env.OPAYA_BROWSER_AGENT||'',textOnly:process.env.OPAYA_BROWSER_TEXT_ONLY==='1'});
  let buffer='';process.stdin.setEncoding('utf8');
  process.stdin.on('data',chunk=>{buffer+=chunk;let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);onLine(line);}});
  process.stdin.on('end',()=>{client?.close();process.exit(0);});
}
