'use strict';
// The web app's window.agenthub: the same methods and events as desktop/preload.cjs, over one WebSocket to the web
// server (web/src/runtime/relay.ts), which relays them to the user's runtime container. What a browser does by itself
// (clipboard, links, file picking and downloads) happens here; what only the desktop app can do says so.
(()=>{
  const methods=['snapshot','saveAgent','reorderAgents','removeAgent','saveHost','removeHost','discover','connect','disconnect','clearError','select','newConversation','selectConversation','send','stop','saveDraft','saveView','terminalAttach','terminalOpen','terminalWrite','terminalResize','terminalDetach','terminalClose','pick','openDocs','exportConversation'];
  methods.push('approvalAnswer','terminalPopout','terminalRename','terminalRestart','terminalPaste');
  methods.push('agentEnvKeys','transferStart','renameConversation','deleteConversation','condenseConversation','conversationMarkdown','libraryList','libraryImport','libraryInstall','libraryRemove','libraryAddFolder','jobs','jobDismiss','cloneAgent','redeployAgent','sshKeyCreate','hostTest','browserPlace','browserOpen','browserNav','browserPreview','browserState','browserClose','cookieSources','cookieImport','pickCookieFile','updateState','updateCheck','updateDownload','updateInstall','updateRunInstaller','clipboardRead','clipboardWrite','openLink');
  methods.push('agentModels','selectModel','gateway','updateAgentDisplay');
  methods.push('selectEffort','pickFiles','fileInfo');
  methods.push('projectRemoteInfo','projectRemoteStart','projectRemoteSend','projectRemoteBring','projectRemoteApply','projectRemoteStop','projectRemoteGithubLogin','guideScan','guidePlan','guideStart','opayaSignIn','toolVersions','toolCheckAll','toolUpdate','agentInstallInfo','agentMaintenanceCommand','agentUpdate','agentUpdateAll','agentBackup','agentBackups','agentRepair','agentChannels','agentChannelSetup','agentSetupChoices','agentSetupModel','agentChannelConnect','agentChannelPair','agentChannelOptions','feedbackState','feedbackSend','feedbackClear','reportClientError','agentSkillCreate','agentSkillRead','agentSkillSave','agentSkillRemove','skillsShare','agentMemory','agentMemorySave','agentMemoryNote','agentMemoryNoteSave','agentMemoryCopy','browsersList','openInBrowser','signInAgain','jobCancel','jobInput','backupRemove','agentUninstall','revealBackup');
  methods.push('opayaFreeModels','opayaFreeSetup','saveSettings','projectSave','projectRemove','projectInfo','projectBranches','projectGit','projectClone','mcpSave','mcpRemove','agentMcp','agentSkills','skillAction','agentDiagnostics','moveAgent','connectAll','playground','files','installFramework','opayaSaveConfig','opayaTest','opayaForgetKey','opayaSend','opayaNewSession','opayaSelectSession','opayaDeleteSession','opayaStop','opayaClear','windowControl','ask');
  methods.push('opayaHoldSecret','opayaForgetSecret','opayaUpdateSecret','agentGiveSecret','opayaGiveAll','vaultGiveAgent','agentKeys','agentWeb');
  methods.push('vaultImportScan','vaultImportCommit','pickSecretFile','vaultBackupSave','pickVaultBackup','vaultBackupRestore','agentFile','agentFileOpen','agentFileSave','agentFileReveal','scheduleSave','scheduleRemove','scheduleRun','agentCron','agentCronDo','tokenRemove');
  methods.push('mcpCatalog','mcpInstall');
  methods.push('dockerList','dockerAction','dockerTerminal','dockerStats','dockerInspect','dockerLogs');
  methods.push('codexLoginFinish','cordConnect');
  methods.push('accountState','accountSignIn','accountSignInCancel','accountSignOut','accountRefresh','accountOpen','hostWebAccess','syncNow','opayaSecretSync');
  const DESKTOP_ONLY='This works in the Opaya desktop app only.';
  const listeners=new Map(),pending=new Map(),queue=[];let socket=null,ready=false,next=1,retry=0,account=null,lastState=null;
  const fire=(event,value)=>{for(const cb of listeners.get(event)||[])try{cb(value);}catch(error){console.error(error);}};
  // The web account (the plan of this web session) replaces the desktop account part of the state.
  const withAccount=state=>state&&typeof state==='object'?{...state,account:account||{enabled:false}}:state;
  async function loadAccount(){
    try{const r=await fetch('/api/entitlements',{credentials:'same-origin',cache:'no-store'});if(!r.ok)throw new Error();const e=await r.json();
      const key=await fetch('/api/web-ssh-key',{credentials:'same-origin',cache:'no-store'}).then(k=>k.ok?k.json():null).catch(()=>null);
      account={enabled:true,web:true,webSsh:key?{publicKey:key.publicKey,address:key.address||''}:null,server:location.origin,signedIn:true,email:e.account?.email||'',name:e.account?.name||'',plan:e.plan,planTitle:{free:'Free',pro:'Pro',fleet:'Fleet',team:'Team'}[e.plan]||e.plan,status:e.status,trialEnd:e.trialEnd?e.trialEnd*1000:null,limits:e.limits,features:e.features,checkedAt:Date.now(),expiresAt:e.expiresAt*1000,expired:false,pending:null,error:''};}
    catch{account=account||{enabled:false};}
    if(lastState)fire('state',withAccount(lastState));return account;
  }
  function connect(){
    socket=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/app/ws`);
    socket.onmessage=event=>{
      let m;try{m=JSON.parse(event.data);}catch{return;}
      if(m.kind==='hello'){ready=true;retry=0;lastState=m.value;for(const send of queue.splice(0))send();presence();if(m.value)fire('state',withAccount(m.value));return;}
      if(m.kind==='event'){if(m.event==='state'){lastState=m.value;fire('state',withAccount(m.value));}else fire(m.event,m.value);return;}
      if(m.kind==='result'){const p=pending.get(m.id);if(!p)return;pending.delete(m.id);m.error?p.reject(new Error(m.error)):p.resolve(m.value);}
    };
    socket.onclose=event=>{
      ready=false;for(const p of pending.values())p.reject(new Error('The connection to Opaya dropped. Reconnecting; do not resend an active task blindly.'));pending.clear();
      // 4401: signed out; 4402: the plan has no web app. The page itself explains it.
      if(event.code===4401||event.code===4402){location.href=event.code===4401?'/login?next=%2Fapp%2F':'/pricing';return;}
      fire('service-error',event.code===4503?'Your Opaya runtime stopped. Reload the page to start it again.':'The connection to Opaya dropped. Reconnecting...');
      if(event.code!==4503)setTimeout(connect,Math.min(30000,1000*2**retry++));
    };
  }
  function call(method,input,timeout=150000){
    return new Promise((resolve,reject)=>{
      const id=next++,send=()=>{socket.send(JSON.stringify({kind:'call',id,method,input}));};
      const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`${method} timed out. Check the connection before retrying.`));},timeout);
      pending.set(id,{resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}});
      ready&&socket.readyState===1?send():queue.push(send);
    });
  }
  const unavailable=async()=>{throw new Error(DESKTOP_ONLY);};
  const httpLink=url=>{let u;try{u=new URL(String(url||''));}catch{throw new Error('Invalid link.');}if(!['http:','https:'].includes(u.protocol))throw new Error('Only web links open.');return u.toString();};
  function download(name,blob){const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),60000);}
  const fileBlob=async x=>{const r=await call('agentFile',{agentId:x?.agentId,path:x?.path,op:'read'},130000);if(!r?.exists)throw new Error('That file is not there any more.');const bytes=Uint8Array.from(atob(r.data||''),c=>c.charCodeAt(0));return {blob:new Blob([bytes]),name:String(r.path||x.path).split(/[\\/]/).pop().replace(/[\\/:*?"<>|]/g,'_')||'file'};};
  // Files from this browser: read as base64, like files pasted into the desktop app (the server stores them for the runtime).
  function pickFiles(){
    return new Promise(resolve=>{const input=document.createElement('input');input.type='file';input.multiple=true;input.onchange=async()=>{const out=[];
      for(const f of input.files||[]){if(f.size>20*1024*1024)continue;const data=await new Promise(done=>{const r=new FileReader();r.onload=()=>done(String(r.result).replace(/^data:[^,]*,/,''));r.onerror=()=>done('');r.readAsDataURL(f);});if(data)out.push({name:f.name,mime:f.type||'application/octet-stream',size:f.size,data});}
      resolve(out);};input.click();});
  }
  const local={
    clipboardRead:async()=>navigator.clipboard?.readText?(await navigator.clipboard.readText()).slice(0,1024*1024):'',
    clipboardWrite:async x=>{if(typeof x?.text!=='string')throw new Error('Nothing to copy.');await navigator.clipboard.writeText(x.text);return true;},
    openLink:async x=>{window.open(httpLink(x?.url),'_blank','noopener');return true;},
    openInBrowser:async x=>{window.open(httpLink(x?.url),'_blank','noopener');return true;},
    openDocs:async x=>{const r=await call('openDocs',x);window.open(httpLink(r.url),'_blank','noopener');return true;},
    ask:async x=>window.opayaAsk?(await window.opayaAsk({title:String(x?.text||'').split('\n\n')[0],text:String(x?.text||'').split('\n\n').slice(1).join('\n\n')}))===true:window.confirm(String(x?.text||'')),
    windowControl:async()=>({maximized:false,fullscreen:!!document.fullscreenElement,focused:document.hasFocus()}),
    terminalPopout:async x=>{window.open(`terminal.html#${encodeURIComponent(x?.id||'')}`,'_blank','noopener');return true;},
    pickFiles,pick:unavailable,pickSecretFile:unavailable,pickCookieFile:unavailable,pickVaultBackup:unavailable,
    loginItem:async()=>({supported:false,on:false}),openDataFolder:unavailable,revealBackup:unavailable,
    updateState:async()=>({status:'unsupported',current:''}),updateCheck:async()=>({status:'unsupported',current:''}),updateDownload:unavailable,updateInstall:unavailable,updateRunInstaller:unavailable,
    browserPlace:unavailable,browserOpen:unavailable,browserNav:unavailable,browserPreview:unavailable,browserState:async()=>null,browserClose:async()=>true,
    cookieSources:async()=>[],cookieImport:unavailable,hostWebAccess:unavailable,opayaSecretSync:unavailable,vaultBackupSave:unavailable,vaultBackupRestore:unavailable,cordConnect:unavailable,agentFileReveal:unavailable,
    exportConversation:async x=>{const text=await call('conversationMarkdown',{id:x?.id});download(`${(String(text).match(/^# (.*)$/m)?.[1]||'conversation').replace(/[^a-zA-Z0-9 -]/g,'').slice(0,70)||'conversation'}.md`,new Blob([text],{type:'text/markdown'}));return true;},
    agentFileOpen:async x=>{const {blob}=await fileBlob(x);window.open(URL.createObjectURL(blob),'_blank','noopener');return true;},
    agentFileSave:async x=>{const {blob,name}=await fileBlob(x);download(name,blob);return name;},
    accountState:async()=>account||loadAccount(),accountRefresh:()=>loadAccount(),accountSignIn:async()=>account,accountSignInCancel:async()=>true,
    accountOpen:async x=>{const page={billing:'/billing',pricing:'/pricing',account:'/account'}[x?.page];if(!page)throw new Error('Unknown account page.');window.open(page,'_blank','noopener');return true;},
    accountSignOut:async()=>{const form=document.createElement('form');form.method='post';form.action='/logout';document.body.append(form);form.submit();return account;},
    snapshot:async()=>withAccount(await call('snapshot'))
  };
  const timeouts={cloneAgent:20*60*1000,redeployAgent:20*60*1000,agentUpdate:11*60*1000,agentUpdateAll:11*60*1000,agentUninstall:11*60*1000,toolUpdate:11*60*1000,installFramework:11*60*1000,projectRemoteStop:11*60*1000,guideStart:11*60*1000,terminalRestart:11*60*1000,terminalPaste:11*60*1000,dockerAction:3*60*1000,agentWeb:3*60*1000,opayaUpdateSecret:5*60*1000,vaultImportScan:2*60*1000,agentFile:130000,agentCronDo:150000};
  const api={};
  for(const method of methods)api[method]=local[method]||(input=>call(method,input||{},timeouts[method]||150000));
  for(const [name,event] of [['onTerminalDocked','terminal-docked'],['onWindowState','window-state'],['onApproval','approval'],['onState','state'],['onTerminal','terminal'],['onServiceError','service-error'],['onUpdate','update'],['onBrowser','browser'],['onJob','job'],['onNotice','notice']]){
    api[name]=callback=>{if(typeof callback!=='function')throw new Error('A callback is required.');if(!listeners.has(event))listeners.set(event,new Set());listeners.get(event).add(callback);return()=>listeners.get(event).delete(callback);};
  }
  for(const method of ['loginItem','openDataFolder'])api[method]=local[method];
  api.onOpen=callback=>{if(typeof callback!=='function')throw new Error('A callback is required.');return()=>{};};
  // Browser notifications (Web Push, web/src/push.ts): the user turns them on in Settings > Notifications. The server
  // pushes only while no Opaya tab is in front, so each tab says when it is.
  window.opayaWebPush=async()=>{
    if(!('serviceWorker' in navigator)||!('PushManager' in window))throw new Error('This browser has no web notifications.');
    const key=await fetch('/api/push/key',{credentials:'same-origin'}).then(r=>r.ok?r.json():null);if(!key?.publicKey)throw new Error('Notifications are not set up on this server.');
    if(await Notification.requestPermission()!=='granted')throw new Error('The browser did not allow notifications. Allow them in its site settings.');
    const reg=await navigator.serviceWorker.register('sw.js'),b64=key.publicKey.replace(/-/g,'+').replace(/_/g,'/'),raw=atob(b64+'='.repeat((4-b64.length%4)%4));
    const subscription=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:Uint8Array.from(raw,c=>c.charCodeAt(0))});
    const r=await fetch('/api/push/subscribe',{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({subscription})});if(!r.ok)throw new Error('The server did not save the subscription.');
    return true;
  };
  const presence=()=>{if(ready&&socket?.readyState===1)socket.send(JSON.stringify({kind:'presence',visible:document.visibilityState==='visible'&&document.hasFocus()}));};
  document.addEventListener?.('visibilitychange',presence);window.addEventListener?.('focus',presence);window.addEventListener?.('blur',presence);
  // A browser has no local path for a dropped file; its bytes go along instead.
  api.pathForFile=()=>'';
  window.agenthub=Object.freeze(api);
  document.documentElement.dataset.runtime='web';
  connect();loadAccount();setInterval(loadAccount,10*60*1000);
})();
