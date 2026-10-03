'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==','base64');
const ANSI=/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()#][0-9A-Za-z]|\x1b[=>78NMc]/g;
// Paste on the real clipboard, soft, in a terminal of its own that the window shows: text and a small image with Cmd+V /
// Ctrl+V (the image arrives as the path of its saved PNG), and text through the Edit menu's paste. It never fails or holds
// up the run: 8 seconds at most, every problem recorded as text, the terminal closed again. The first terminal, the chat
// and its draft are left alone; nothing is pasted unless the keyboard is in this terminal.
async function pasteChecks({app,win,client}){
  const {clipboard,nativeImage}=require('electron'),out={},started=Date.now(),end=started+7000;
  const sleep=ms=>new Promise(r=>setTimeout(r,ms)),left=()=>Math.max(0,end-Date.now());
  const bounded=(promise,ms=left())=>Promise.race([promise,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Timed out.')),ms))]);
  async function until(test,ms){const stop=Math.min(end,Date.now()+ms);for(;;){try{if(await test())return true;}catch{}if(Date.now()>=stop)return false;await sleep(100);}}
  let id='',before='';
  // What the shell echoed, without colors and cursor moves.
  const echoed=async()=>String((await bounded(client.call('terminalAttach',{id}))).buffer||'').replace(ANSI,'').replace(/[\r\n]/g,'');
  // The first-launch question (How do you like to work?) would cover the terminal: it is put away, unanswered.
  const focus=()=>bounded(win.webContents.executeJavaScript(`(()=>{if(!window.__smokeKey){window.__smokeKey='none';document.addEventListener('keydown',e=>{window.__smokeKey=[e.key,e.code,e.metaKey?'meta':'',e.ctrlKey?'ctrl':''].filter(Boolean).join(' ');},true);}
    const ask=document.querySelector('#interface-chooser')?.closest('dialog');if(ask)ask.dispatchEvent(new Event('cancel'));
    if(document.querySelector('dialog[open]')||!document.querySelector('#terminal-panes .terminal-pane[data-id=${JSON.stringify(JSON.stringify(id)).slice(1,-1)}]'))return false;
    const pane=document.querySelector('#terminal-panes .terminal-pane[data-id=${JSON.stringify(JSON.stringify(id)).slice(1,-1)}]'),input=pane&&pane.querySelector('.xterm-helper-textarea');
    if(!input)return false;input.focus();return document.activeElement===input;})()`));
  const press=()=>{const modifiers=[process.platform==='darwin'?'meta':'control'];for(const type of ['keyDown','keyUp'])win.webContents.sendInputEvent({type,keyCode:'V',modifiers});};
  const step=async(name,run)=>{if(!left()){out[name]='Skipped: out of time.';return;}try{out[name]=await run();}catch(error){out[name]=String(error?.message||error).slice(0,300);}};
  const away='The terminal did not take the keyboard.';
  try{
    before=clipboard.readText();
    id=(await bounded(client.call('terminalOpen',{agentId:'smoke-agent',mode:'shell'}))).id;
    win.webContents.send('hub:terminal',{type:'opened',id});
    await until(async()=>/[>$%#]$/.test((await echoed()).trimEnd()),3000);// its prompt (typing ahead works too)
    const marker=`OPAYA_PASTE_${started.toString(36).toUpperCase()}`,menu=`OPAYA_MENU_${started.toString(36).toUpperCase()}`;
    await step('pasteText',async()=>{clipboard.writeText(marker);if(!await until(focus,1500))return away;press();return until(async()=>(await echoed()).includes(marker),2000);});
    out.pasteKey=await bounded(win.webContents.executeJavaScript('window.__smokeKey'),500).catch(()=>'');
    await step('pasteImage',async()=>{clipboard.writeImage(nativeImage.createFromBuffer(PNG));if(!await until(focus,1000))return away;press();const dir=path.join(app.getPath('userData'),'pasted');
      return until(async()=>{const names=await fs.readdir(dir).catch(()=>[]),text=await echoed();return names.some(n=>text.includes(n));},2000);});
    await step('pasteMenu',async()=>{clipboard.writeText(menu);if(!await until(focus,1000))return away;win.webContents.paste();return until(async()=>(await echoed()).includes(menu),1500);});
  }catch(error){out.pasteError=String(error?.message||error).slice(0,300);}
  finally{
    if(id)await bounded(client.call('terminalClose',{id}),1000).catch(error=>{out.pasteClose=String(error?.message||error).slice(0,200);});
    try{clipboard.writeText(before);}catch{}
    out.pasteSeconds=Math.round((Date.now()-started)/100)/10;
  }
  return out;
}
async function run({app,win,client}){
  const output=process.env.AGENTHUB_SMOKE_OUTPUT;
  if(!output)throw new Error('AGENTHUB_SMOKE_OUTPUT is required for an isolated smoke test.');
  await fs.mkdir(output,{recursive:true});
  const phase=process.env.AGENTHUB_SMOKE_PHASE||'write';
  await new Promise(resolve=>setTimeout(resolve,1000));
  const checks=await win.webContents.executeJavaScript(`({title:document.title,nodeUnavailable:typeof window.require==='undefined',bridge:typeof window.agenthub?.snapshot==='function',genericIpcAbsent:window.agenthub?.invoke===undefined,overflow:document.documentElement.scrollWidth>innerWidth,sidebar:!!document.querySelector('.sidebar'),terminalLayout:typeof window.OpayaTerminalLayout?.split==='function',terminalUi:typeof window.Terminal==='function'&&typeof window.FitAddon?.FitAddon==='function'})`);
  const prefs=win.webContents.getLastWebPreferences();Object.assign(checks,{sandbox:prefs.sandbox,contextIsolation:prefs.contextIsolation,nodeIntegration:prefs.nodeIntegration});
  assert(checks.nodeUnavailable&&checks.bridge&&checks.genericIpcAbsent&&!checks.overflow&&checks.sidebar&&checks.terminalUi&&checks.terminalLayout&&checks.sandbox&&checks.contextIsolation&&!checks.nodeIntegration,'Native UI/security smoke failed: '+JSON.stringify(checks));
  if(phase==='features'){await require('./native-features.cjs').run({win,client,output});console.log('Native terminal feature checks passed.');return;}
  if(phase==='write'){
    const agent=await client.call('saveAgent',{agent:{id:'smoke-agent',name:'Restart verification',provider:'custom',protocol:'openai',transport:'http',endpoint:'http://127.0.0.1:8642/v1',model:'test-only'}});
    const conversation=await client.call('newConversation',{agentId:agent.id});
    await client.call('saveDraft',{agentId:agent.id,conversationId:conversation.id,text:'This draft survives closing the window.'});
    const terminal=await client.call('terminalOpen',{local:true,mode:'shell'});
    await client.call('terminalWrite',{id:terminal.id,data:process.platform==='win32'?"Write-Output ('AGENTHUB_' + 'NATIVE_PTY_OK')\r":"printf 'AGENTHUB_%s\\n' 'NATIVE_PTY_OK'\r"});
    let nativeOutput=false;
    for(let i=0;i<100;i++){const current=await client.call('terminalAttach',{id:terminal.id});if(current.buffer.includes('AGENTHUB_NATIVE_PTY_OK')){nativeOutput=true;break;}await new Promise(resolve=>setTimeout(resolve,100));}
    assert(nativeOutput,'The real native terminal did not produce the marker.');
    checks.nativePtyOutput=true;
    // Soft: pasting on the real clipboard, recorded here, never failing the run.
    try{Object.assign(checks,await pasteChecks({app,win,client}));}catch(error){checks.pasteError=String(error?.message||error).slice(0,300);}
    const second=await client.call('terminalOpen',{sourceId:terminal.id,newSession:true}),hidden=await client.call('terminalOpen',{sourceId:terminal.id,newSession:true});
    const tree={axis:'y',ratio:.65,first:{id:terminal.id},second:{id:second.id}},before=await client.call('snapshot');
    await client.call('saveView',{...before.view,overview:false,opaya:false,terminalVisible:true,terminalId:second.id,
      agentNavigation:[{id:agent.id,mode:'console',section:'care'}],terminalWorkspaces:[{ctx:agent.id,tree,active:second.id,visible:false,dock:'right'}],
      windows:[[terminal.id,agent.id,0],[second.id,agent.id,0],[hidden.id,agent.id,1]]});
    await new Promise(resolve=>{win.webContents.once('did-finish-load',resolve);win.webContents.reload();});
    await new Promise(resolve=>setTimeout(resolve,1000));await win.webContents.executeJavaScript('window.agenthubFlush()');
    const state=await client.call('snapshot');checks.servicePid=state.service.pid;
    await fs.writeFile(path.join(output,'restart-state.json'),JSON.stringify({pid:state.service.pid,conversationId:conversation.id,terminalId:terminal.id,secondId:second.id,hiddenId:hidden.id,tree,count:state.terminals.length}));
  }else{
    const previous=JSON.parse(await fs.readFile(path.join(output,'restart-state.json'),'utf8'));
    const state=await client.call('snapshot');
    assert.equal(state.service.pid,previous.pid,'UI restart launched a replacement service.');
    assert.equal(state.activeConversationId,previous.conversationId);
    assert.equal(state.drafts[previous.conversationId],'This draft survives closing the window.');
    const terminal=await client.call('terminalAttach',{id:previous.terminalId});
    assert.equal(terminal.exited,false,'Native terminal did not survive UI process exit.');
    assert(terminal.buffer.includes('AGENTHUB_NATIVE_PTY_OK'),'Terminal output was lost.');
    await win.webContents.executeJavaScript('window.agenthubFlush()');
    const restored=await client.call('snapshot'),workspace=restored.view.terminalWorkspaces.find(w=>w.ctx==='smoke-agent');
    assert.deepEqual(workspace.tree,previous.tree);assert.equal(workspace.active,previous.secondId);assert.equal(workspace.dock,'right');
    assert.equal(restored.terminals.length,previous.count,'Restoration created a duplicate session.');
    assert.deepEqual(restored.view.agentNavigation,[{id:'smoke-agent',mode:'console',section:'care'}]);
    const visible=await win.webContents.executeJavaScript(`[...document.querySelectorAll('#terminal-panes .terminal-pane')].map(p=>p.dataset.id)`);
    assert.deepEqual(visible,[previous.terminalId,previous.secondId]);assert(!visible.includes(previous.hiddenId));
    checks.savedLayout=true;checks.savedNavigation=true;checks.hiddenSession=true;checks.noDuplicates=true;
    checks.sameService=true;checks.sameTerminal=true;checks.draftRestored=true;checks.sameConversation=true;
    await client.call('shutdown');
  }
  await fs.writeFile(path.join(output,`native-smoke-${phase}.json`),JSON.stringify(checks,null,2));
  await fs.writeFile(path.join(output,`native-${phase}.png`),(await win.webContents.capturePage()).toPNG());
  console.log(JSON.stringify({phase,checks}));
}
module.exports={run};
