'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
async function run({app,win,client}){
  const output=process.env.AGENTHUB_SMOKE_OUTPUT;
  if(!output)throw new Error('AGENTHUB_SMOKE_OUTPUT is required for an isolated smoke test.');
  await fs.mkdir(output,{recursive:true});
  const phase=process.env.AGENTHUB_SMOKE_PHASE||'write';
  await new Promise(resolve=>setTimeout(resolve,1000));
  const checks=await win.webContents.executeJavaScript(`({title:document.title,nodeUnavailable:typeof window.require==='undefined',bridge:typeof window.agenthub?.snapshot==='function',genericIpcAbsent:window.agenthub?.invoke===undefined,overflow:document.documentElement.scrollWidth>innerWidth,sidebar:!!document.querySelector('.sidebar'),terminalUi:typeof window.Terminal==='function'&&typeof window.FitAddon?.FitAddon==='function'})`);
  const prefs=win.webContents.getLastWebPreferences();Object.assign(checks,{sandbox:prefs.sandbox,contextIsolation:prefs.contextIsolation,nodeIntegration:prefs.nodeIntegration});
  assert(checks.nodeUnavailable&&checks.bridge&&checks.genericIpcAbsent&&!checks.overflow&&checks.sidebar&&checks.terminalUi&&checks.sandbox&&checks.contextIsolation&&!checks.nodeIntegration,'Native UI/security smoke failed: '+JSON.stringify(checks));
  if(phase==='write'){
    const agent=await client.call('saveAgent',{agent:{id:'smoke-agent',name:'Restart verification',provider:'custom',protocol:'openai',transport:'http',endpoint:'http://127.0.0.1:8642/v1',model:'test-only'}});
    const conversation=await client.call('newConversation',{agentId:agent.id});
    await client.call('saveDraft',{agentId:agent.id,conversationId:conversation.id,text:'This draft survives closing the window.'});
    const terminal=await client.call('terminalOpen',{local:true,mode:'shell'});
    await client.call('terminalWrite',{id:terminal.id,data:process.platform==='win32'?"Write-Output ('AGENTHUB_' + 'NATIVE_PTY_OK')\r":"printf 'AGENTHUB_%s\\n' 'NATIVE_PTY_OK'\r"});
    let nativeOutput=false;
    for(let i=0;i<100;i++){const current=await client.call('terminalAttach',{id:terminal.id});if(current.buffer.includes('AGENTHUB_NATIVE_PTY_OK')){nativeOutput=true;break;}await new Promise(resolve=>setTimeout(resolve,100));}
    assert(nativeOutput,'The real native terminal did not produce the marker.');
    const state=await client.call('snapshot');
    await fs.writeFile(path.join(output,'restart-state.json'),JSON.stringify({pid:state.service.pid,conversationId:conversation.id,terminalId:terminal.id}));
    checks.nativePtyOutput=true;checks.servicePid=state.service.pid;
  }else{
    const previous=JSON.parse(await fs.readFile(path.join(output,'restart-state.json'),'utf8'));
    const state=await client.call('snapshot');
    assert.equal(state.service.pid,previous.pid,'UI restart launched a replacement service.');
    assert.equal(state.activeConversationId,previous.conversationId);
    assert.equal(state.drafts[previous.conversationId],'This draft survives closing the window.');
    const terminal=await client.call('terminalAttach',{id:previous.terminalId});
    assert.equal(terminal.exited,false,'Native terminal did not survive UI process exit.');
    assert(terminal.buffer.includes('AGENTHUB_NATIVE_PTY_OK'),'Terminal output was lost.');
    checks.sameService=true;checks.sameTerminal=true;checks.draftRestored=true;checks.sameConversation=true;
    await client.call('shutdown');
  }
  await fs.writeFile(path.join(output,`native-smoke-${phase}.json`),JSON.stringify(checks,null,2));
  await fs.writeFile(path.join(output,`native-${phase}.png`),(await win.webContents.capturePage()).toPNG());
  console.log(JSON.stringify({phase,checks}));
}
module.exports={run};
