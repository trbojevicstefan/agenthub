'use strict';
const path=require('node:path');
const {launch,collect,dockerExecContainerIndex}=require('./process.cjs');
function gatewayArgs(agent,operation){
  if(!['status','restart'].includes(operation))throw new Error('Unsupported gateway operation.');
  if(!['hermes','openclaw'].includes(agent.provider)||!agent.command)throw new Error('This connection has no managed gateway.');
  if(agent.command==='docker'){
    const index=dockerExecContainerIndex(agent.args);
    if(index<0)throw new Error('Docker container is not configured.');
    const executable=agent.args.slice(index+1).filter(arg=>!['acp','app-server'].includes(arg));
    if(!executable.length)throw new Error('Configure the gateway executable inside this container.');
    if(operation==='restart'&&agent.provider==='hermes'){
      const profile=path.posix.basename(path.posix.dirname(agent.hermesHome||''))==='profiles'?path.posix.basename(agent.hermesHome):'default';
      if(!/^[a-zA-Z0-9_.-]+$/.test(profile))throw new Error('Unsupported gateway profile name.');
      return [...agent.args.slice(0,index+1),'sh','-c','service=$1; shift; if [ -x /command/s6-svc ] && [ -d "$service" ]; then /command/s6-svc -t "$service" && printf "Gateway restart requested via s6.\\n"; else exec "$@" gateway restart; fi','agenthub-gateway',`/run/service/gateway-${profile}`,...executable];
    }
    return [...agent.args.slice(0,index+1),...executable,'gateway',operation];
  }
  return [...(agent.args||[]).filter(arg=>!['acp','app-server'].includes(arg)),'gateway',operation];
}
async function gatewayOperation(agent,host,operation){
  const output=await collect(launch(agent,gatewayArgs(agent,operation),host),{timeout:operation==='restart'?120000:20000,maxBytes:65536});
  return output.trim();
}
module.exports={gatewayArgs,gatewayOperation};
