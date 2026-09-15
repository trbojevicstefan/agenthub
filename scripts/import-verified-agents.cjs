'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const wire=require('../desktop/wire.cjs'),{fingerprint}=require('../desktop/discovery.cjs'),{findExecutable}=require('../desktop/process.cjs');
async function run(){
  const root=path.join(process.env.APPDATA,'AgentHub'),descriptor=JSON.parse(await fs.readFile(path.join(root,'session-service.json'),'utf8'));
  const client=await wire.connect(wire.endpoint(root),descriptor.token);
  try{
    const chats=require('../artifacts/agent-chat-audit.json'),repairs=require('../artifacts/agent-repairs.json');
    const verified=chats.filter(r=>r.reply?.trim()==='OK').map(r=>r.agent);
    for(const r of repairs.filter(r=>r.ok)){const index=verified.findIndex(a=>a.name===r.agent.name&&a.hostId===r.agent.hostId);if(index>=0)verified[index]=r.agent;else verified.push(r.agent);}
    const openclaw=findExecutable('openclaw');if(openclaw)verified.push({name:'OpenClaw / CLI',provider:'openclaw',protocol:'terminal',transport:'local',command:openclaw,args:[],cwd:os.homedir(),note:'CLI installed. Gateway API at localhost:18789 is not configured or running.'});
    const names=new Set(verified.map(a=>a.name));
    client.on('approval',r=>client.answer(r.id,names.has(r.agent?.name)&&['Trust this agent executable?','Import this Hermes gateway token?'].includes(r.title)));
    const initial=await client.call('snapshot');
    if(initial.agents.some(a=>a.busy))throw new Error('An agent is currently working. Finish the active turn before importing.');
    await fs.copyFile(path.join(root,'workspace.json'),path.join(root,'workspace.before-verified-import-'+Date.now()+'.json'));
    const results=[];
    for(const candidate of verified){
      const state=await client.call('snapshot'),existing=state.agents.find(a=>(a.name===candidate.name&&a.hostId===(candidate.hostId||''))||fingerprint(a)===fingerprint(candidate));
      const agent={...candidate,...(existing?{id:existing.id,createdAt:existing.createdAt,pinned:existing.pinned}:{} )};
      try{
        const saved=await client.call('saveAgent',{agent,remember:true,importToken:agent.provider==='hermes'&&agent.protocol==='openai'&&!existing?.hasToken});
        await client.call('connect',{id:saved.id});results.push({id:saved.id,name:saved.name,status:'connected'});
      }catch(e){results.push({name:agent.name,error:e.message});}
      console.log(JSON.stringify(results.at(-1)));
    }
    if(initial.activeAgentId)await client.call('select',{id:initial.activeAgentId});
    await fs.writeFile(path.join(__dirname,'../artifacts/import-results.json'),JSON.stringify(results,null,2));
  }finally{client.close();}
}
run().catch(e=>{console.error(e.message);process.exitCode=1;});
