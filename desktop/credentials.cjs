'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {launch,collect,dockerExecContainerIndex}=require('./process.cjs');
function parseGatewayToken(raw){
  for(const line of raw.split(/\r?\n/)){
    const m=line.match(/^\s*(?:export\s+)?API_SERVER_KEY\s*=\s*(.*?)\s*$/);
    if(!m)continue;
    let value=m[1];
    if((value.startsWith('"')&&value.endsWith('"'))||(value.startsWith("'")&&value.endsWith("'")))value=value.slice(1,-1);
    else value=value.split(/\s+#/)[0].trim();
    if(!value||value.length>16000||/[\r\n\0]/.test(value))throw new Error('The gateway token is empty or unsupported. Enter it manually.');
    if(value.includes('${'))throw new Error('The gateway token uses environment expansion. Enter its resolved value manually.');
    return value;
  }
  throw new Error('API_SERVER_KEY was not found in this profile. Configure the gateway API first.');
}
async function importGatewayToken(agent,host){
  if(agent.provider!=='hermes'||!agent.hermesHome)throw new Error('Token import requires a Hermes profile path.');
  if(agent.transport!=='ssh'){
    const file=path.join(agent.hermesHome,'.env');const info=await fs.stat(file);
    if(info.size>262144)throw new Error('Profile environment file is too large.');
    return parseGatewayToken(await fs.readFile(file,'utf8'));
  }
  const dockerIndex = agent.command === 'docker' ? dockerExecContainerIndex(agent.args || []) : -1;
  const dockerExec = dockerIndex >= 0 ? agent.args[dockerIndex] : '';
  if(dockerExec){
    const child=launch({...agent,command:'docker',args:[],hermesHome:''},['exec',dockerExec,'cat',path.posix.join(agent.hermesHome,'.env')],host);
    try{return parseGatewayToken(await collect(child,{maxBytes:300000,timeout:15000}));}
    catch(error){
      if(/No such file|not found|API_SERVER_KEY was not found/i.test(String(error?.message||error)))throw new Error('API_SERVER_KEY was not found in the Docker Hermes profile. Enter the gateway token manually, or add API_SERVER_KEY to the container profile .env and restart the gateway.');
      throw error;
    }
  }
  const code=[
    'import sys,pathlib,re,json',
    'p=pathlib.Path(sys.argv[1])/".env"',
    'assert p.stat().st_size <= 262144, "environment file too large"',
    'lines=p.read_text().splitlines()',
    'm=next((re.match(r"^\\s*(?:export\\s+)?API_SERVER_KEY\\s*=\\s*(.*?)\\s*$",x) for x in lines if re.match(r"^\\s*(?:export\\s+)?API_SERVER_KEY\\s*=",x)),None)',
    'print(json.dumps({"line": "API_SERVER_KEY="+m.group(1) if m else ""}))'
  ].join('\n');
  const child=launch({...agent,command:'python3',hermesHome:''},['-c',code,agent.hermesHome],host);
  const response=JSON.parse(await collect(child,{maxBytes:20000,timeout:15000}));
  return parseGatewayToken(response.line||'');
}
module.exports={parseGatewayToken,importGatewayToken};
