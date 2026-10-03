'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
async function run({win,client,output}){
  const {BrowserWindow,dialog}=require('electron'),checks={},js=code=>win.webContents.executeJavaScript(code);
  async function until(fn,label='UI condition'){for(let i=0;i<100;i++){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw new Error(label+' timed out.');}
  const click=async selector=>{await until(()=>js(`!!document.querySelector(${JSON.stringify(selector)})`),selector);await js(`document.querySelector(${JSON.stringify(selector)}).click()`);};
  const menu=async label=>{await until(()=>js(`[...document.querySelectorAll('.context-menu:not(.closing) [data-menu-index]')].some(b=>b.textContent.includes(${JSON.stringify(label)}))`),label);await js(`[...document.querySelectorAll('.context-menu:not(.closing) [data-menu-index]')].find(b=>b.textContent.includes(${JSON.stringify(label)})).click()`);};
  const ids=()=>js(`[...document.querySelectorAll('#terminal-panes .terminal-pane')].map(p=>p.dataset.id).filter(Boolean)`);
  const pane=id=>`#terminal-panes .terminal-pane[data-id="${id}"]`;
  const flush=()=>js('window.agenthubFlush()');
  const workspace=async id=>{await flush();return (await client.call('snapshot')).view.terminalWorkspaces.find(w=>w.ctx===id);};
  const select=async id=>{await click(`[data-action="select"][data-id="${id}"]`);await until(()=>js(`!!document.querySelector('#topbar [data-action="agent-mode"][data-id="${id}"]')`),'agent selection');};
  const destination=mode=>click(`#topbar [data-action="agent-mode"][data-mode="${mode}"]`);
  const server=require('node:http').createServer((req,res)=>{
    if(req.method==='POST'){req.resume();res.setHeader('Content-Type','text/event-stream');res.write('data: '+JSON.stringify({choices:[{delta:{content:'Background '}}]})+'\n\n');setTimeout(()=>res.end('data: '+JSON.stringify({choices:[{delta:{content:'reply verified.'+'\n\nSaved history paragraph.'.repeat(100)}}]})+'\n\ndata: [DONE]\n\n'),1200);return;}
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{id:'test-model-a'},{id:'test-model-b'}]}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const originalAsk=dialog.showMessageBox;
  await js(`window.__featureErrors=[];window.addEventListener('error',e=>window.__featureErrors.push(e.message));window.addEventListener('unhandledrejection',e=>window.__featureErrors.push(String(e.reason)));new MutationObserver(()=>window.__featureErrors.push(document.querySelector('#toast').textContent)).observe(document.querySelector('#toast'),{childList:true});`);
  try{
    await client.call('saveSettings',{interface:'chat',tips:false});
    await js(`document.querySelector('#interface-chooser')?.closest('dialog')?.dispatchEvent(new Event('cancel'))`);
    const root=path.join(output,'shell-workspace');await fs.mkdir(root,{recursive:true});
    const definition={provider:'custom',protocol:'openai',transport:'http',endpoint:`http://127.0.0.1:${server.address().port}/v1`,cwd:root};
    const agent=await client.call('saveAgent',{agent:{...definition,name:'Navigation verification'}});
    const other=await client.call('saveAgent',{agent:{...definition,name:'Second context',endpoint:definition.endpoint+'/other'}});
    const conversation=await client.call('newConversation',{agentId:agent.id});
    await select(agent.id);
    await until(()=>js(`!!document.querySelector('#topbar [data-mode="chat"][aria-current]')`),'Chat');
    // The upstream Search and Back controls remain available beside the new destinations.
    await click('#topbar [data-action="find"]');
    await js(`const search=document.querySelector('#find-input');search.value='Navigation verification Model';search.dispatchEvent(new Event('input',{bubbles:true}));`);
    await until(()=>js(`[...document.querySelectorAll('.find-row')].some(b=>b.querySelector('strong')?.textContent==='Model & skills')`),'management search result');
    await js(`[...document.querySelectorAll('.find-row')].find(b=>b.querySelector('strong')?.textContent==='Model & skills').click()`);
    await until(()=>js(`document.querySelector('.pg-title h1')?.textContent==='Model & skills'`),'search destination');
    await click('#topbar [data-action="nav-back"]');
    await until(()=>js(`!!document.querySelector('#topbar [data-mode="chat"][aria-current]')`),'Back to Chat');checks.searchAndBack=true;
    await js(`const input=document.querySelector('#message-input');input.value='Draft kept through navigation';input.dispatchEvent(new Event('input',{bubbles:true}));`);await flush();
    await destination('console');await until(async()=>(await ids()).length===1,'initial terminal');
    const first=(await ids())[0];
    const marker=process.platform==='win32'?"Write-Output ('UI_' + 'PROCESS_OK')\r":"printf 'UI_%s\\n' 'PROCESS_OK'\r";
    await client.call('terminalWrite',{id:first,data:marker});await until(async()=>(await client.call('terminalAttach',{id:first})).buffer.includes('UI_PROCESS_OK'),'PTY marker');
    await click(`${pane(first)} [data-pane-action="split"]`);await menu('Split right');await until(async()=>(await ids()).length===2,'split right');
    const second=(await ids()).find(id=>id!==first);
    await click(`${pane(second)} [data-pane-action="split"]`);await menu('Split below');await until(async()=>(await ids()).length===3,'split below');
    const third=(await ids()).find(id=>id!==first&&id!==second),tree=(await workspace(agent.id)).tree;
    assert.equal(tree.axis,'x');assert.equal(tree.first.id,first);assert.equal(tree.second.axis,'y');assert.equal(tree.second.first.id,second);assert.equal(tree.second.second.id,third);
    assert.equal((await client.call('terminalAttach',{id:third})).cwd,root);
    assert.equal(await js(`document.querySelectorAll('.an-win').length`),3);checks.independentMixedSplits=true;
    const rects=await js(`Object.fromEntries([...document.querySelectorAll('#terminal-panes .terminal-pane')].map(p=>{const r=p.getBoundingClientRect();return [p.dataset.id,{left:r.left,top:r.top,width:r.width,height:r.height}]}))`);
    assert(rects[first].left<rects[second].left);assert(rects[second].top<rects[third].top);assert(rects[first].height>rects[second].height);
    win.focus();win.webContents.focus();await js(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    await js(`document.querySelector('${pane(third)} .xterm-helper-textarea').focus()`);
    const modifiers=[process.platform==='darwin'?'meta':'control','shift'];
    for(const type of ['keyDown','keyUp'])win.webContents.sendInputEvent({type,keyCode:'Up',modifiers});
    await until(()=>js(`document.activeElement.closest('.terminal-pane')?.dataset.id===${JSON.stringify(second)}`),'directional focus');
    checks.directionalFocus=true;
    await click(`${pane(second)} [data-pane-action="maximize"]`);assert.deepEqual(await ids(),[second]);
    await click(`${pane(second)} [data-pane-action="maximize"]`);assert.equal((await ids()).length,3);assert.deepEqual((await workspace(agent.id)).tree,tree);checks.maximize=true;
    await js(`document.querySelector('#terminal-panes .pane-grip').focus();document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))`);
    assert((await workspace(agent.id)).tree.ratio>tree.ratio);checks.keyboardResize=true;
    await click(`${pane(third)} [data-pane-action="hide"]`);assert.equal((await ids()).length,2);assert.equal((await client.call('terminalAttach',{id:third})).exited,false);
    await click('[data-action="terminal-hidden"]');await menu('shell');await until(async()=>(await ids()).includes(third),'show hidden');checks.hideKeepsSession=true;
    // Rename the current pane through the existing menu.
    await click('[data-action="terminal-more"]');await menu('Rename');await until(()=>js(`!!document.querySelector('#terminal-rename-form')`));
    await js(`document.querySelector('#terminal-rename-form input').value='UI verification';document.querySelector('#terminal-rename-form').requestSubmit()`);
    await until(async()=>(await client.call('terminalAttach',{id:third})).title==='UI verification','rename');checks.rename=true;
    await click(`${pane(third)} [data-pane-action="popout"]`);let popup;
    await until(async()=>{popup=BrowserWindow.getAllWindows().find(w=>w!==win);return popup&&await popup.webContents.executeJavaScript(`!!document.querySelector('#terminal .xterm')`).catch(()=>false);},'popout');
    await fs.writeFile(path.join(output,'terminal-popout.png'),(await popup.webContents.capturePage()).toPNG());
    // Docking while another agent is selected keeps the original context.
    await select(other.id);
    await popup.webContents.executeJavaScript(`document.querySelector('#dock').click()`);
    await until(()=>Promise.resolve(!BrowserWindow.getAllWindows().includes(popup)),'dock');
    assert(!(await ids()).includes(third));
    await select(agent.id);await until(async()=>(await ids()).includes(third),'original context');checks.popoutRedock=true;
    await destination('chat');assert(await js(`!!document.querySelector('#message-input')`));
    assert.equal(await js(`document.querySelector('#message-input').value`),'Draft kept through navigation');
    assert.equal((await client.call('snapshot')).activeConversationId,conversation.id);checks.draftAndConversation=true;
    await click('[data-action="chat-terminal"]');await menu('Show terminal beside chat');
    await until(()=>js(`document.querySelector('#dock-right').contains(document.querySelector('#terminal-panel'))`),'terminal beside chat');
    assert(await js(`!!document.querySelector('#message-input')`));checks.chatWithTerminal=true;
    await destination('manage');await click('[data-action="agent-section"][data-key="overview"]');await until(()=>js(`!!document.querySelector('.ov-actions')`));
    for(const key of ['update','clone','backup','settings','machines'])assert(await js(`!!document.querySelector('.ov-actions [data-key="${key}"]')`));
    assert(await js(`document.querySelector('.ov-actions [data-key="update"]').disabled`));
    assert(await js(`document.querySelector('.ov-actions [data-key="update"]').parentElement.textContent.includes('does not support updates')`));checks.manageCapabilities=true;
    assert(await js(`[...document.querySelectorAll('.ov-manage-actions button')].every(b=>{const r=b.getBoundingClientRect(),parent=b.closest('.ov-manage-actions').getBoundingClientRect();return r.top>=parent.top&&r.bottom<=parent.bottom;})`));
    await click('[data-action="agent-section"][data-key="model"]');await click('[data-action="manage-run"][data-key="models"]');
    await until(()=>js(`!!document.querySelector('#model-form')`));await js(`document.querySelector('#model-form select').value='test-model-b';document.querySelector('#model-form').requestSubmit()`);
    await until(async()=>(await client.call('snapshot')).agents.find(a=>a.id===agent.id)?.model==='test-model-b');checks.modelSelection=true;
    await destination('chat');await client.call('connect',{id:agent.id});
    await until(()=>js(`!document.querySelector('#send-button')?.disabled`),'connected chat');
    await js(`document.querySelector('#message-input').value='Reply during navigation';document.querySelector('#message-form').requestSubmit()`);
    await until(async()=>(await client.call('snapshot')).agents.find(a=>a.id===agent.id)?.busy,'running chat');
    await destination('manage');await until(()=>js(`!!document.querySelector('#status-tray [data-conv="${conversation.id}"]')`),'background chat notice');
    await until(async()=>!(await client.call('snapshot')).agents.find(a=>a.id===agent.id)?.busy,'background reply');
    assert((await client.call('snapshot')).histories[conversation.id].some(m=>m.content.startsWith('Background reply verified.')));checks.backgroundReply=true;
    await destination('chat');await until(()=>js(`document.querySelector('#message-list')?.scrollHeight>document.querySelector('#message-list')?.clientHeight`),'scrollable history');
    await js(`document.querySelector('#message-list').scrollTop=80`);await destination('manage');await destination('chat');
    assert.equal(await js(`document.querySelector('#message-list').scrollTop`),80);checks.chatScroll=true;await destination('manage');


    await select(other.id);await select(agent.id);
    await until(()=>js(`document.querySelector('.pg-title h1')?.textContent==='Model & skills'`),'remember Manage section');checks.savedDestination=true;
    await click('#topbar [data-action="agent-machine"]');await until(()=>js(`!!document.querySelector('#fl-docker')`),'machine link');checks.machineLink=true;
    await select(agent.id);await destination('console');
    await click(`${pane(first)} [data-pane-action="split"]`);await menu('Split left');await until(async()=>(await ids()).length===4,'split left');
    const fourth=(await ids()).find(id=>![first,second,third].includes(id));
    await click(`${pane(fourth)} [data-pane-action="split"]`);await menu('Split above');await until(async()=>(await ids()).length===5,'split above');checks.allDirections=true;
    win.setSize(940,680);await new Promise(r=>setTimeout(r,200));
    for(const theme of ['dark','light']){
      await click('[data-action="settings"]');await click(`[data-action="theme"][data-theme="${theme}"]`);await click('[data-action="modal-close"]');
      assert(!await js(`document.documentElement.scrollWidth>innerWidth`));
      assert(await js(`[...document.querySelectorAll('#terminal-panes .terminal-pane')].every(p=>p.offsetWidth>=240&&p.offsetHeight>=110)`));
      await fs.writeFile(path.join(output,`terminal-${theme}.png`),(await win.webContents.capturePage()).toPNG());
    }
    checks.smallWindowThemes=true;assert((await client.call('terminalAttach',{id:first})).buffer.includes('UI_PROCESS_OK'));checks.processPreserved=true;
    // Verify both cancellation and confirmation without an unattended native dialog.
    // Opaya asks in its own dialog (.opaya-ask): Cancel keeps the session, the action button ends it.
    await click(`${pane(first)} [data-pane-action="close"]`);await until(()=>js(`!!document.querySelector('.opaya-ask[open] h2')?.textContent`),'end confirmation');
    await js(`document.querySelector('.opaya-ask[open] [value="cancel"]').click()`);assert.equal((await client.call('terminalAttach',{id:first})).exited,false);
    await click(`${pane(first)} [data-pane-action="close"]`);await until(()=>js(`!!document.querySelector('.opaya-ask[open]')`),'end confirmation again');await js(`document.querySelector('.opaya-ask[open] [value="ok"]').click()`);await until(async()=>!(await ids()).includes(first),'end session');
    await assert.rejects(()=>client.call('terminalAttach',{id:first}),/not found/);checks.endConfirmation=true;
    await client.call('updateAgentDisplay',{id:other.id,surface:'terminal'});
    await select(other.id);await until(()=>js(`document.body.classList.contains('terminal-stage')`));
    assert(!await js(`!!document.querySelector('#topbar [data-mode="chat"]')`));checks.terminalOnly=true;
    await until(async()=>(await ids()).length===1,'terminal-only shell');
    const beforeFailure=await ids(),target=beforeFailure[0];
    await flush();const legacy=await client.call('snapshot');
    await client.call('saveView',{...legacy.view,terminalWorkspaces:[],panes:[target],paneSizes:[2]});
    await new Promise(resolve=>{win.webContents.once('did-finish-load',resolve);win.webContents.reload();});
    await until(async()=>(await ids()).includes(target),'legacy layout restoration');
    assert.equal((await client.call('snapshot')).terminals.length,legacy.terminals.length);
    assert.deepEqual((await workspace(other.id)).tree,{id:target});checks.legacyMigration=true;

    while((await client.call('snapshot')).terminals.filter(t=>!t.exited).length<12)await client.call('terminalOpen',{sourceId:target,newSession:true});
    await click(`${pane(target)} [data-pane-action="split"]`);await menu('Split right');
    await until(()=>js(`document.querySelector('#toast').textContent.includes('12 live terminal sessions')`),'session limit notice');
    assert.deepEqual(await ids(),beforeFailure);checks.failedSplitPreservesLayout=true;
    await fs.writeFile(path.join(output,'feature-checks.json'),JSON.stringify(checks,null,2));console.log('Feature evidence: '+output);
  }catch(error){await fs.writeFile(path.join(output,'failure.png'),(await win.webContents.capturePage()).toPNG());await fs.writeFile(path.join(output,'failure.txt'),await js('document.body.innerText'));console.error('Feature evidence: '+output);console.error(await js('window.__featureErrors'));console.error(error.stack);throw error;}finally{dialog.showMessageBox=originalAsk;server.close();await client.call('shutdown');}
}
module.exports={run};
