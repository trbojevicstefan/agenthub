'use strict';
const electron=require('electron');
const {app,BrowserWindow,ipcMain,protocol,session,shell,dialog,Menu,Tray,nativeImage}=electron;
const fs=require('node:fs/promises'),fsSync=require('node:fs'),path=require('node:path');
const {safeError}=require('./broker.cjs');
const APP_URL='agenthub://app/index.html';
const smoke=process.argv.includes('--smoke-test'),hostMode=process.argv.includes('--agenthub-host');
const BRAND='Opaya';
app.setName(BRAND);
if(process.platform==='win32')app.setAppUserModelId('io.agenthub.desktop');
const explicitProfile=process.argv.find(a=>a.startsWith('--agenthub-profile='))?.slice('--agenthub-profile='.length);
if(explicitProfile)app.setPath('userData',explicitProfile);
else{
  // Opaya was released as AgentHub. Keep using an existing AgentHub workspace so agents, transcripts and the running session service carry over.
  const appData=app.getPath('appData'),legacy=path.join(appData,'AgentHub'),current=path.join(appData,BRAND);
  app.setPath('userData',!fsSync.existsSync(current)&&fsSync.existsSync(legacy)?legacy:current);
}
if(smoke&&process.env.AGENTHUB_SMOKE_OUTPUT)app.setPath('userData',path.join(process.env.AGENTHUB_SMOKE_OUTPUT,'profile'));
if(smoke||hostMode||process.argv.includes('--safe-graphics'))app.disableHardwareAcceleration();
async function startupFailure(error){
  const root=app.getPath('userData'),message=safeError(error);
  await fs.mkdir(root,{recursive:true,mode:0o700}).catch(()=>{});
  await fs.writeFile(path.join(root,hostMode?'service-startup-error.txt':'startup-error.txt'),message,{mode:0o600}).catch(()=>{});
  if(!hostMode&&!smoke)dialog.showErrorBox('Opaya could not start',message+'\n\nLocal diagnostics: '+root);
  console.error(message);app.exit(1);
}
if(hostMode){
  // The session service is the same binary; on macOS keep it out of the Dock and app switcher.
  app.dock?.hide();
  app.whenReady().then(()=>require('./service.cjs').start(electron,app.getPath('userData'))).catch(startupFailure);
}else{
  protocol.registerSchemesAsPrivileged([{scheme:'agenthub',privileges:{standard:true,secure:true,supportFetchAPI:false,corsEnabled:true}}]);
  app.enableSandbox();
  let win,client,tray,quitting=false;
  const terminalWindows=new Map();
  const docs={hermes:'https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server',acp:'https://hermes-agent.nousresearch.com/docs/user-guide/features/acp',profiles:'https://hermes-agent.nousresearch.com/docs/user-guide/profiles/',codex:'https://developers.openai.com/codex/app-server/',claude:'https://code.claude.com/docs/en/headless',openclaw:'https://docs.openclaw.ai/gateway/openai-http-api'};
  function show(){if(win&&!win.isDestroyed()){win.show();if(win.isMinimized())win.restore();win.focus();}}
  function trusted(event){
    const senderWindow=BrowserWindow.fromWebContents(event.sender);
    const window=[win,...terminalWindows.values()].find(w=>w&&!w.isDestroyed()&&(event.sender===w.webContents||senderWindow===w));
    const allowed=[APP_URL.replace(/\/$/,''),'agenthub://app/terminal.html'];
    const frameUrl=String(event.senderFrame?.url||'').split('#')[0].replace(/\/$/,'');
    const contentsUrl=String(event.sender.getURL?.()||'').split('#')[0].replace(/\/$/,'');
    if(allowed.includes(frameUrl)&&allowed.includes(contentsUrl))return true;
    return !!window&&event.senderFrame===window.webContents.mainFrame&&allowed.includes(frameUrl);
  }
  async function detach(){if(quitting)return;quitting=true;try{await win?.webContents.executeJavaScript('window.agenthubFlush?.()');}catch{}client?.close();tray?.destroy();app.quit();}
  async function stopService(){
    const result=await dialog.showMessageBox(win,{type:'warning',message:'Stop all sessions and exit?',detail:'This ends local agent processes and local shells. Remote tmux sessions remain on their hosts. Saved conversations and drafts stay on disk. Use Exit window to leave the session service running instead.',buttons:['Keep running','Stop all and exit'],defaultId:0,cancelId:0,noLink:true});
    if(result.response===1){await client.call('shutdown');await detach();}
  }
  if(!app.requestSingleInstanceLock())app.quit();else{
    app.on('second-instance',show);
    app.whenReady().then(async()=>{
      client=await require('./host-client.cjs').attach(app,app.getPath('userData'));
      const assets=new Map([
        ['/index.html',['text/html',path.join(__dirname,'../ui/index.html')]],
        ['/app.js',['text/javascript',path.join(__dirname,'../ui/app.js')]],
        ['/terminal.html',['text/html',path.join(__dirname,'../ui/terminal.html')]],
        ['/terminal-window.js',['text/javascript',path.join(__dirname,'../ui/terminal-window.js')]],
        ['/style.css',['text/css',path.join(__dirname,'../ui/style.css')]],
        ['/theme-light.css',['text/css',path.join(__dirname,'../ui/theme-light.css')]],
        ['/assets/opaya-logo.png',['image/png',path.join(__dirname,'../ui/assets/opaya-logo.png')]],
        ['/assets/agents/hermes.png',['image/png',path.join(__dirname,'../ui/assets/agents/hermes.png')]],
        ['/assets/agents/claude.png',['image/png',path.join(__dirname,'../ui/assets/agents/claude.png')]],
        ['/assets/agents/codex.svg',['image/svg+xml',path.join(__dirname,'../ui/assets/agents/codex.svg')]],
        ['/assets/agents/openclaw.svg',['image/svg+xml',path.join(__dirname,'../ui/assets/agents/openclaw.svg')]],
        ['/vendor/xterm.js',['text/javascript',path.join(__dirname,'../node_modules/@xterm/xterm/lib/xterm.js')]],
        ['/vendor/xterm.css',['text/css',path.join(__dirname,'../node_modules/@xterm/xterm/css/xterm.css')]],
        ['/vendor/addon-fit.js',['text/javascript',path.join(__dirname,'../node_modules/@xterm/addon-fit/lib/addon-fit.js')]]
      ]);
      // Icon library: any bundled SVG in ui/assets/icons, by strict file name only.
      const iconAsset=pathname=>/^\/assets\/icons\/[a-z0-9-]{1,40}\.svg$/.test(pathname)?['image/svg+xml',path.join(__dirname,'../ui/assets/icons',path.basename(pathname))]:null;
      protocol.handle('agenthub',async request=>{
        const u=new URL(request.url),asset=assets.get(u.pathname)||iconAsset(u.pathname);
        if(u.hostname!=='app'||u.username||u.password||u.search||!asset||request.method!=='GET')return new Response('Not found',{status:404});
        try{return new Response(await fs.readFile(asset[1]),{headers:{'Content-Type':asset[0],'X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"}});}catch{return new Response('A packaged UI resource is missing. Reinstall Opaya.',{status:404});}
      });
      session.defaultSession.setPermissionRequestHandler((_wc,_permission,cb)=>cb(false));
      session.defaultSession.setPermissionCheckHandler(()=>false);
      const mac=process.platform==='darwin';
      Menu.setApplicationMenu(Menu.buildFromTemplate([
        {label:BRAND,submenu:[...(mac?[{role:'about'},{type:'separator'}]:[]),{label:'Show Opaya',click:show},...(mac?[{role:'hide'},{role:'hideOthers'},{role:'unhide'}]:[]),{type:'separator'},{label:'Exit window (keep sessions)',accelerator:mac?'Command+Q':undefined,click:()=>detach()},{type:'separator'},{label:'Stop all sessions and exit',click:()=>stopService().catch(startupFailure)}]},
        {label:'Edit',submenu:[{role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'}]},
        {label:'View',submenu:[{role:'resetZoom'},{role:'zoomIn'},{role:'zoomOut'},{type:'separator'},{role:'togglefullscreen'},...(!app.isPackaged?[{role:'toggleDevTools'}]:[])]},
        ...(mac?[{role:'windowMenu'}]:[])
      ]));
      win=new BrowserWindow({width:1440,height:960,minWidth:940,minHeight:680,title:BRAND,icon:path.join(__dirname,'../build/icon.png'),backgroundColor:'#111214',show:false,autoHideMenuBar:true,frame:false,...(process.platform==='darwin'?{roundedCorners:true}:{}),webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,sandbox:true,nodeIntegration:false,webSecurity:true,allowRunningInsecureContent:false,webviewTag:false}});
      win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
      win.webContents.on('will-navigate',event=>event.preventDefault());
      win.webContents.on('will-attach-webview',event=>event.preventDefault());
      win.webContents.on('render-process-gone',()=>{if(!quitting)dialog.showErrorBox('The Opaya window stopped','Your session service is still running. Reopen Opaya to restore conversations and terminals. Try --safe-graphics if this repeats.');});
      // Native edit menu for text fields and selections; the renderer draws its own menus for agents, terminals and the workspace.
      win.webContents.on('context-menu',(_event,params)=>{
        const editable=params.isEditable,selection=!!params.selectionText?.trim();if(!editable&&!selection)return;
        Menu.buildFromTemplate(editable?[{role:'undo',enabled:params.editFlags.canUndo},{role:'redo',enabled:params.editFlags.canRedo},{type:'separator'},{role:'cut',enabled:params.editFlags.canCut},{role:'copy',enabled:params.editFlags.canCopy},{role:'paste',enabled:params.editFlags.canPaste},{type:'separator'},{role:'selectAll'}]:[{role:'copy'},{role:'selectAll'}]).popup({window:win});
      });
      // Opaya draws its own window controls on Windows, macOS and Linux.
      const windowState=()=>{if(!win.isDestroyed())win.webContents.send('hub:window-state',{maximized:win.isMaximized(),fullscreen:win.isFullScreen(),focused:win.isFocused()});};
      for(const event of ['maximize','unmaximize','enter-full-screen','leave-full-screen','focus','blur'])win.on(event,windowState);
      win.webContents.on('did-finish-load',windowState);
      client.on('state',value=>{if(!win.isDestroyed())win.webContents.send('hub:state',value);});
      client.on('terminal',value=>{for(const w of [win,...terminalWindows.values()])if(!w.isDestroyed())w.webContents.send('hub:terminal',value);});
      const pendingApprovals=new Map(),approvalFile=path.join(app.getPath('userData'),'approval-rules.json');
      const approvalRules=new Set(await fs.readFile(approvalFile,'utf8').then(JSON.parse).catch(()=>[]));
      client.on('approval',async request=>{
        if(smoke||quitting){client.answer(request.id,false);return;}
        show();
        const key=JSON.stringify([request.agent,request.title,request.detail]);
        if(approvalRules.has(key)){client.answer(request.id,true);return;}
        pendingApprovals.set(request.id,{key,expires:Date.now()+120000});win.webContents.send('hub:approval',request);
      });
      client.on('closed',()=>{if(!quitting&&!smoke&&!win.isDestroyed())win.webContents.send('hub:service-error','Session service disconnected. Reopen Opaya to reconnect. Saved history has not been deleted.');});
      const forwards=['installFramework','opayaSaveConfig','opayaTest','opayaForgetKey','opayaSend','opayaStop','opayaClear','snapshot','saveAgent','reorderAgents','updateAgentDisplay','removeAgent','saveHost','removeHost','discover','connect','disconnect','clearError','select','newConversation','selectConversation','send','stop','saveDraft','saveView','terminalOpen','terminalAttach','terminalWrite','terminalResize','terminalDetach','terminalClose'];
      const handlers=Object.fromEntries(forwards.map(method=>[method,input=>client.call(method,input)]));
      for(const method of ['agentModels','selectModel','gateway'])handlers[method]=input=>client.call(method,input);
      handlers.terminalRename=async input=>{const title=await client.call('terminalRename',input);terminalWindows.get(input.id)?.setTitle(title);return title;};
      Object.assign(handlers,{
        windowControl:async x=>{
          if(x.action==='minimize')win.minimize();
          else if(x.action==='maximize'){if(win.isFullScreen())win.setFullScreen(false);else if(win.isMaximized())win.unmaximize();else win.maximize();}
          else if(x.action==='fullscreen')win.setFullScreen(!win.isFullScreen());
          else if(x.action==='close')win.close();
          else if(x.action!=='state')throw new Error('Unknown window action.');
          return {maximized:win.isMaximized(),fullscreen:win.isFullScreen(),focused:win.isFocused()};
        },
        terminalPopout:async x=>{
          const item=await client.call('terminalAttach',x);const existing=terminalWindows.get(item.id);if(existing){existing.show();existing.focus();return true;}
          const popup=new BrowserWindow({width:1000,height:650,minWidth:480,minHeight:300,title:item.title,backgroundColor:'#111315',autoHideMenuBar:true,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,sandbox:true,nodeIntegration:false}});terminalWindows.set(item.id,popup);
          popup.webContents.setWindowOpenHandler(()=>({action:'deny'}));popup.webContents.on('will-navigate',e=>e.preventDefault());
          popup.on('closed',()=>{terminalWindows.delete(item.id);if(!win.isDestroyed())win.webContents.send('hub:terminal-docked',{id:item.id});});
          await popup.loadURL('agenthub://app/terminal.html#'+encodeURIComponent(item.id));return true;
        },
        approvalAnswer:async x=>{const pending=pendingApprovals.get(x.id);if(!pending)return false;pendingApprovals.delete(x.id);if(Date.now()>pending.expires){client.answer(x.id,false);return false;}if(x.choice==='always'){approvalRules.add(pending.key);await fs.writeFile(approvalFile,JSON.stringify([...approvalRules]),{mode:0o600});}client.answer(x.id,x.choice==='once'||x.choice==='always');return true;},
        pick:async x=>{if(!['directory','identityFile','executable'].includes(x.kind))throw new Error('Invalid file picker.');const result=await dialog.showOpenDialog(win,{title:'Choose '+x.kind,properties:[x.kind==='directory'?'openDirectory':'openFile']});return result.canceled?'':result.filePaths[0];},
        openDocs:x=>{const framework=String(x.topic||'').startsWith('framework:')&&require('./catalog.cjs').FRAMEWORKS.find(f=>'framework:'+f.id===x.topic);if(framework)return shell.openExternal(framework.docs);if(!Object.hasOwn(docs,x.topic))throw new Error('Unknown documentation topic.');return shell.openExternal(docs[x.topic]);},
        exportConversation:async x=>{const {conversation:c,agent:a,messages}=await client.call('transcript',x);const result=await dialog.showSaveDialog(win,{title:'Export conversation',defaultPath:(c.title.replace(/[^a-zA-Z0-9 -]/g,'').slice(0,70)||'conversation')+'.md',filters:[{name:'Markdown',extensions:['md']}]});if(result.canceled||!result.filePath)return false;await fs.writeFile(result.filePath,`# ${c.title}\n\nAgent: ${a.name}\n\n`+messages.map(m=>`## ${m.role==='user'?'You':a.name}\n\n${m.content}\n${m.error?'> '+m.error:''}\n`).join('\n'),{mode:0o600});return true;}
      });
      for(const [method,handler]of Object.entries(handlers))ipcMain.handle(`hub:${method}`,async(event,input)=>{
        if(!trusted(event))throw new Error('Untrusted desktop caller.');
        try{return {ok:true,data:await handler(input||{})};}catch(error){return {ok:false,error:safeError(error)};}
      });
      if(!smoke){try{
        const icon=nativeImage.createFromPath(path.join(__dirname,'../build/icon.png')).resize(process.platform==='darwin'?{width:18,height:18}:{width:24,height:24});
        tray=new Tray(icon);tray.setToolTip('Opaya / sessions stay running');tray.setContextMenu(Menu.buildFromTemplate([{label:'Open Opaya',click:show},{label:'Exit window (keep sessions)',click:()=>detach()},{type:'separator'},{label:'Stop all sessions and exit',click:()=>stopService().catch(startupFailure)}]));tray.on('double-click',show);
      }catch{tray=null;}}
      win.on('close',event=>{if(quitting)return;event.preventDefault();if(tray){win.hide();}else detach();});
      await win.loadURL(APP_URL);win.show();
      if(smoke){try{await require('../scripts/native-smoke.cjs').run({app,win,client});quitting=true;client.close();app.exit(0);}catch(error){await client.call('shutdown').catch(()=>{});quitting=true;throw error;}}
    }).catch(startupFailure);
    app.on('before-quit',event=>{if(!quitting){event.preventDefault();detach();}});
    app.on('window-all-closed',()=>{if(!quitting)detach();});
    app.on('activate',show);
  }
}
