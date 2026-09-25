'use strict';
// MCP server (stdio) that gives an agent Opaya's browser pane. Opaya starts it for agents that have "Opaya browser"
// turned on: `<Opaya executable> browser-mcp.cjs` with ELECTRON_RUN_AS_NODE=1. It connects to the session service with a
// scoped token that can only call browserTool; the page opens in the pane the user is watching.
const {connect}=require('./wire.cjs');
const VERSION='1.0.0';
const TOOLS=[
  {name:'browser_open',description:'Open a web address (or search words) in the Opaya browser the user can see, then return the page text, links and form fields.',inputSchema:{type:'object',properties:{url:{type:'string',description:'https://..., localhost:3000, or search words'}},required:['url']}},
  {name:'browser_read',description:'Read the current page: URL, title, visible text, links and form fields.',inputSchema:{type:'object',properties:{max_chars:{type:'integer',description:'Text limit, default 12000'}}}},
  {name:'browser_screenshot',description:'Take a screenshot of the current page.',inputSchema:{type:'object',properties:{}}},
  {name:'browser_click',description:'Click an element by CSS selector, or by its visible text.',inputSchema:{type:'object',properties:{selector:{type:'string'},text:{type:'string'}}}},
  {name:'browser_type',description:'Type into an input (CSS selector, or the focused field). Set submit to press Enter / submit the form.',inputSchema:{type:'object',properties:{selector:{type:'string'},text:{type:'string'},submit:{type:'boolean'}},required:['text']}},
  {name:'browser_scroll',description:'Scroll the page by a number of pixels (negative scrolls up).',inputSchema:{type:'object',properties:{dy:{type:'integer'}}}},
  {name:'browser_back',description:'Go back to the previous page.',inputSchema:{type:'object',properties:{}}}
];
const OPS={browser_open:['open',a=>({url:a.url})],browser_read:['read',a=>({max:a.max_chars})],browser_screenshot:['screenshot',()=>({})],browser_click:['click',a=>({selector:a.selector,text:a.text})],browser_type:['type',a=>({selector:a.selector,text:a.text,submit:a.submit})],browser_scroll:['scroll',a=>({dy:a.dy})],browser_back:['back',()=>({})]};
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
async function call(name,args){
  const op=OPS[name];if(!op)throw new Error(`Unknown tool ${name}.`);
  const value=await (await service()).call('browserTool',{op:op[0],args:op[1](args||{})},120000);
  const content=[{type:'text',text:text(value)}];
  if(value?.image)content.push({type:'image',data:value.image,mimeType:'image/png'});
  return {content,isError:!!value?.error};
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
    if(m.method==='initialize')reply(m.id,{protocolVersion:m.params?.protocolVersion||'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'opaya-browser',version:VERSION},instructions:'Opaya browser: a real browser pane the user watches. Open pages, read them, click and type. Ask before submitting forms that buy, send or delete things.'});
    else if(m.method==='tools/list')reply(m.id,{tools:TOOLS});
    else if(m.method==='tools/call')call(m.params?.name,m.params?.arguments).then(r=>reply(m.id,r),e=>reply(m.id,{content:[{type:'text',text:`Browser error: ${e.message}`}],isError:true}));
    else if(m.method==='ping')reply(m.id,{});
    else if(m.id!==undefined&&m.method)fail(m.id,`Method not found: ${m.method}`);
  }
});
process.stdin.on('end',()=>{client?.close();process.exit(0);});
