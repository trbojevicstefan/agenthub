'use strict';
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {Broker,safeError}=require('../desktop/broker.cjs');
const {Store,Vault}=require('../desktop/store.cjs');
const {scanLocal,scanRemote}=require('../desktop/discovery.cjs');
async function run(){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'agenthub-audit-'));
  const broker=new Broker({store:new Store(root),vault:new Vault(root,{isEncryptionAvailable:()=>false}),emit:()=>{},approve:async(_a,title)=>['Trust this agent executable?','Import this Hermes gateway token?'].includes(title)});
  await broker.init();const report=[];
  try{
    const workspace=JSON.parse(await fs.readFile(path.join(process.env.APPDATA,'AgentHub','workspace.json'),'utf8'));
    const prior=process.argv.includes('--from-report')?JSON.parse(await fs.readFile(path.join(__dirname,'../artifacts/agent-audit.json'),'utf8')):null;
    const inventories=prior?[{agents:prior.filter(r=>r.connected&&r.agent).map(r=>r.agent)}]:[await scanLocal()];
    for(const host of workspace.hosts.filter(h=>['hostinger','med-sta'].includes(h.alias))){await broker.saveHost(host);if(!prior)try{inventories.push(await scanRemote(host));}catch(e){report.push({host:host.name,error:safeError(e)});}}
    for(const candidate of inventories.flatMap(i=>i.agents).filter(a=>a.protocol!=='terminal')){
      const row={name:candidate.name,location:candidate.hostId||'local',protocol:candidate.protocol};let saved;
      try{
        const agent={...candidate,model:candidate.protocol==='acp'?'':candidate.model};
        saved=await broker.saveAgent({agent,remember:false,importToken:agent.provider==='hermes'&&agent.protocol==='openai'&&!!agent.hermesHome});row.added=true;
        await broker.connect(saved.id);row.connected=true;
        const models=prior?{models:[]}:await broker.models(saved.id);row.models=models.models.length;
        row.modelExamples=models.models.slice(0,3);
        if(process.argv.includes('--chat')&&saved.provider!=='openclaw'){
          const result=await broker.send({agentId:saved.id,text:'Connection test. Reply with exactly OK. Do not use tools, read files, or change anything.'});
          const timer=setTimeout(()=>broker.stop(saved.id),60000);await broker.turns.get(saved.id)?.done;clearTimeout(timer);const message=broker.histories.get(result.conversationId)?.at(-1);
          row.chat=message?.status;row.reply=message?.content.slice(0,100);if(message?.error)row.error=message.error;
        }
        row.agent=saved;
      }catch(e){row.error=safeError(e);}finally{if(saved)broker.disconnect(saved.id);}
      report.push(row);console.log(JSON.stringify({...row,agent:undefined}));
    }
    await fs.mkdir(path.join(__dirname,'../artifacts'),{recursive:true});await fs.writeFile(path.join(__dirname,prior?'../artifacts/agent-chat-audit.json':'../artifacts/agent-audit.json'),JSON.stringify(report,null,2));
  }finally{await broker.close();}
}
run().catch(e=>{console.error(safeError(e));process.exitCode=1;});
