'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {createAdapter}=require('../desktop/adapters/index.cjs');
async function run(){
  const report=require('../artifacts/agent-audit.json'),results=[];
  for(const name of ['Codex','Hermes / blondie','Hermes / daemon']){
    const agent={...report.find(r=>r.name===name).agent},adapter=createAdapter({agent,approve:async()=>false});const abort=new AbortController();let text='';
    const timer=setTimeout(()=>{abort.abort();adapter.close();},60000);
    try{
      await adapter.connect();const models=await adapter.listModels();
      const model=agent.provider==='codex'?'gpt-5.6-sol':'openai-codex:gpt-5.6-sol';
      if(!models.includes(model))throw new Error('Requested repair model is not available.');agent.model=model;
      await adapter.run({text:'Reply with exactly OK. Do not use tools or change any files.',conversation:{id:'agenthub-repair-'+Date.now()},signal:abort.signal,onSession:async()=>{},onEvent:e=>{if(e.type==='text')text+=e.text;}});
      const result={name,model,ok:text.trim()==='OK',reply:text.slice(0,180),agent};results.push(result);console.log(JSON.stringify({...result,agent:undefined}));
    }catch(e){results.push({name,error:e.message});console.log(JSON.stringify({name,error:e.message}));}finally{clearTimeout(timer);adapter.close();}
  }
  await fs.writeFile(path.join(__dirname,'../artifacts/agent-repairs.json'),JSON.stringify(results,null,2));
}
run().catch(e=>{console.error(e.message);process.exitCode=1;});
