'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
async function run({win,client,output}){
  const js=code=>win.webContents.executeJavaScript(code);
  async function until(fn){for(let i=0;i<100;i++){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw new Error('Native UI condition timed out.');}
  await js(`document.querySelector('[data-action="hosts"]').click();document.querySelector('[data-action="local-terminal"]').click()`);
  await until(()=>js(`!!document.querySelector('[data-action="terminal-tab"]')`));
  const id=await js(`document.querySelector('[data-action="terminal-tab"]').dataset.id`);
  await js(`document.querySelector('[data-action="terminal-tab"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true}));document.querySelector('#terminal-rename-form input').value='UI verification';document.querySelector('#terminal-rename-form').requestSubmit()`);
  await until(()=>js(`document.querySelector('#terminal-title').textContent==='UI verification'`));
  assert.equal((await client.call('terminalAttach',{id})).title,'UI verification');
  const before=await js(`document.querySelector('#terminal-panel').offsetHeight`);
  await js(`document.querySelector('.terminal-resize-grip').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true}))`);
  assert(await js(`document.querySelector('#terminal-panel').offsetHeight>${before}`));
  await js(`document.querySelector('[data-action="terminal-detach"]').click()`);
  const {BrowserWindow}=require('electron');let popup;
  await until(async()=>{popup=BrowserWindow.getAllWindows().find(w=>w!==win);return popup&&await popup.webContents.executeJavaScript(`!!document.querySelector('#terminal .xterm')`).catch(()=>false);});
  popup.setSize(720,480);await new Promise(r=>setTimeout(r,300));
  assert(await popup.webContents.executeJavaScript(`document.querySelector('#terminal').clientWidth>600`));
  await popup.webContents.insertText("Write-Output ('UI_' + 'KEYBOARD_OK')");
  popup.webContents.sendInputEvent({type:'keyDown',keyCode:'Enter'});popup.webContents.sendInputEvent({type:'keyUp',keyCode:'Enter'});
  await until(async()=> (await client.call('terminalAttach',{id})).buffer.includes('UI_KEYBOARD_OK'));
  await fs.writeFile(path.join(output,'terminal-popout.png'),(await popup.webContents.capturePage()).toPNG());
  await popup.webContents.executeJavaScript(`document.querySelector('#dock').click()`);
  await until(()=>js(`!document.querySelector('#terminal-panel').hidden`));
  await js(`document.querySelector('[data-action="terminal-tab"]').dispatchEvent(new MouseEvent('auxclick',{button:1,bubbles:true}))`);
  await until(()=>js(`!document.querySelector('[data-action="terminal-tab"]')`));
  await assert.rejects(()=>client.call('terminalAttach',{id}),/not found/);
  const server=require('node:http').createServer((_req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{id:'test-model-a'},{id:'test-model-b'}]}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const agent=await client.call('saveAgent',{agent:{name:'Model selector verification',provider:'custom',protocol:'openai',transport:'http',endpoint:`http://127.0.0.1:${server.address().port}/v1`}});
    await until(()=>js(`!!document.querySelector('[data-action="select"][data-id="${agent.id}"]')`));
    await js(`document.querySelector('[data-action="select"][data-id="${agent.id}"]').click()`);
    await until(()=>js(`!!document.querySelector('[data-action="models"]')`));await js(`document.querySelector('[data-action="models"]').click()`);
    await until(()=>js(`!!document.querySelector('#model-form')`));
    await js(`document.querySelector('#model-form select').value='test-model-b';document.querySelector('#model-form').requestSubmit()`);
    await until(async()=> (await client.call('snapshot')).agents.find(a=>a.id===agent.id)?.model==='test-model-b');
    win.setSize(940,680);await new Promise(r=>setTimeout(r,300));
    assert(!await js(`document.documentElement.scrollWidth>innerWidth`));
    await fs.writeFile(path.join(output,'model-selector.png'),(await win.webContents.capturePage()).toPNG());
  }finally{server.close();}
  await fs.writeFile(path.join(output,'feature-checks.json'),JSON.stringify({rename:true,resize:true,popout:true,keyboard:true,dock:true,middleClickClose:true,modelSelection:true,smallWindow:true},null,2));
  await client.call('shutdown');
}
module.exports={run};
