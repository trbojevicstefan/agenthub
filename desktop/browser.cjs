'use strict';
// Opaya's browser pane: sandboxed WebContentsViews in the main window, positioned over a placeholder the renderer lays
// out. The user browses there, and each agent with the Opaya browser drives its own tab through a small set of tools
// (open, read, screenshot, click, type, scroll, back), shown on that agent's screen so every step is visible.
const {WebContentsView,session}=require('electron');
const PARTITION='persist:opaya-browser';
const allowed=u=>{try{const x=new URL(u);return ['http:','https:'].includes(x.protocol)||(x.protocol==='data:'&&/^data:text\/html[;,]/i.test(u));}catch{return false;}};
function normalize(input){
  let u=String(input||'').trim();if(!u)throw new Error('Enter an address.');
  if(!/^[a-z][a-z0-9+.-]*:/i.test(u))u=/^(localhost|127\.|\[::1\])/.test(u)||/^[\w-]+(\.[\w-]+)+(:\d+)?(\/|$)/.test(u)?(/^(localhost|127\.|\[::1\])/.test(u)?'http://':'https://')+u:`https://duckduckgo.com/?q=${encodeURIComponent(u)}`;
  if(!allowed(u)||u.startsWith('data:'))throw new Error('Only http and https addresses open in the Opaya browser.');
  return u;
}
// One tab per owner: the user ("user", the pane on Home and other shared screens) and each agent, with its own page,
// history and session (cookies, logins), so agents never share or see each other's browsing. The pane shows the tab of
// the screen the user is on; an agent's tab keeps working while it is not shown.
const ownerId=o=>{o=String(o||'user');return /^[A-Za-z0-9_-]{1,80}$/.test(o)?o:'user';};
const partitionOf=o=>o==='user'?PARTITION:`${PARTITION}-${o}`;
class BrowserPane{
  constructor({win,emit}){this.win=win;this.emit=emit;this.tabs=new Map();this.shown='user';this.bounds=null;this.visible=false;}
  tab(owner){owner=ownerId(owner);if(!this.tabs.has(owner))this.tabs.set(owner,new BrowserTab(this,owner));return this.tabs.get(owner);}
  // The renderer reports where the pane is, whose tab it shows and whether it is visible (hidden under dialogs).
  place({x,y,width,height,visible,owner}){
    const o=ownerId(owner),ok=[x,y,width,height].every(Number.isFinite)&&width>20&&height>20;this.shown=o;
    if(ok)this.bounds={x:Math.round(x),y:Math.round(y),width:Math.round(width),height:Math.round(height)};
    for(const [k,t] of this.tabs)if(k!==o)t.hide();
    const t=this.tabs.get(o);if(!t)return {...emptyState(),owner:o};
    return t.place(!!visible&&ok);
  }
  state(owner){const t=this.tabs.get(ownerId(owner||this.shown));return t?t.state():{...emptyState(),owner:ownerId(owner||this.shown)};}
  open(url,owner){return this.tab(owner).open(url);}
  preview(html,owner){return this.tab(owner).preview(html);}
  navigate(action,owner){return this.tab(owner).navigate(action);}
  tool(op,args,owner){return this.tab(owner).tool(op,args);}
  // Closing a tab forgets its page and history (its session keeps cookies and logins); the next open starts empty.
  close(owner){const o=ownerId(owner),t=this.tabs.get(o);if(t){t.destroy();this.tabs.delete(o);}this.emit({...emptyState(),owner:o,request:'hide'});return {...emptyState(),owner:o};}
  // Cookies go into one owner's session, or every agent's ("all") and the user's.
  async importCookies(cookies,owners){
    const {session:s}=require('electron');const targets=[...new Set(owners.map(ownerId))];let set=0,failed=0;
    for(const o of targets){const ses=s.fromPartition(partitionOf(o));for(const c of cookies){try{await ses.cookies.set(c);set++;}catch{failed++;}}await ses.cookies.flushStore().catch(()=>{});}
    return {set,failed,owners:targets};
  }
}
const emptyState=()=>({url:'',title:'',loading:false,canGoBack:false,canGoForward:false,visible:false});
class BrowserTab{
  constructor(pane,owner){this.pane=pane;this.owner=owner;this.view=null;this.visible=false;}
  get win(){return this.pane.win;}
  emit(state){this.pane.emit({...state,owner:this.owner});}
  ensure(){
    if(this.view&&!this.view.webContents.isDestroyed())return this.view;
    const partition=partitionOf(this.owner),ses=session.fromPartition(partition);
    ses.setPermissionRequestHandler((_wc,_permission,done)=>done(false));
    ses.setPermissionCheckHandler(()=>false);
    const view=new WebContentsView({webPreferences:{partition,sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,allowRunningInsecureContent:false,webviewTag:false,spellcheck:false,backgroundThrottling:false}});
    const wc=view.webContents;
    view.setBackgroundColor('#ffffff');
    // Pop-ups open in the same tab; other schemes (file:, javascript:, custom apps) are refused.
    wc.setWindowOpenHandler(({url})=>{if(allowed(url)&&!url.startsWith('data:'))wc.loadURL(url);return {action:'deny'};});
    wc.on('will-navigate',(event,url)=>{if(!allowed(url))event.preventDefault();});
    wc.on('will-redirect',(event,url)=>{if(!allowed(url))event.preventDefault();});
    for(const e of ['did-navigate','did-navigate-in-page','page-title-updated','did-start-loading','did-stop-loading','did-fail-load'])wc.on(e,()=>this.publish());
    this.win.contentView.addChildView(view);view.setVisible(false);this.view=view;
    if(this.pane.bounds)view.setBounds(this.pane.bounds);
    this.answerDialogs(wc);
    return view;
  }
  destroy(){const v=this.view;this.view=null;if(!v)return;try{if(v.webContents.isFocused()&&!this.win.isDestroyed())this.win.webContents.focus();this.win.contentView.removeChildView(v);}catch{}try{v.webContents.close();}catch{}}
  hide(){if(this.view&&!this.view.webContents.isDestroyed()){if(this.view.webContents.isFocused()&&!this.win.isDestroyed())this.win.webContents.focus();this.view.setVisible(false);}this.visible=false;}
  place(visible){
    if(!this.view&&!visible)return this.state();
    const view=this.ensure();this.visible=visible;if(this.pane.bounds)view.setBounds(this.pane.bounds);
    // A hidden pane keeps keyboard focus if it had it, so typing in the chat box would go nowhere: hand focus back.
    if(!visible&&view.webContents.isFocused()&&!this.win.isDestroyed())this.win.webContents.focus();
    view.setVisible(visible);return this.state();
  }
  // alert(), confirm(), prompt() and "leave this page?" block the page until someone answers, and while they are open
  // no script runs, so an agent's read or click would wait forever. Answer them through the DevTools protocol.
  answerDialogs(wc){
    try{
      if(!wc.debugger.isAttached())wc.debugger.attach('1.3');
      wc.debugger.on('message',(_event,method,params)=>{if(method==='Page.javascriptDialogOpening'){this.lastDialog=`${params.type}: ${String(params.message||'').slice(0,200)}`;wc.debugger.sendCommand('Page.handleJavaScriptDialog',{accept:true,promptText:''}).catch(()=>{});}});
      wc.debugger.sendCommand('Page.enable').catch(()=>{});
    }catch{} // DevTools already attached: dialogs then wait for the user, and the time limits below still apply
  }
  state(){const wc=this.view&&!this.view.webContents.isDestroyed()?this.view.webContents:null;return {url:wc?.getURL()||'',title:wc?.getTitle()||'',loading:!!wc?.isLoading(),canGoBack:!!wc?.navigationHistory?.canGoBack(),canGoForward:!!wc?.navigationHistory?.canGoForward(),visible:this.visible,owner:this.owner};}
  publish(){this.emit(this.state());}
  async open(url){const view=this.ensure();const target=normalize(url);this.emit({...this.state(),request:'show'});view.webContents.loadURL(target).catch(()=>{});await this.settle();return this.state();}
  async preview(html){const view=this.ensure();if(typeof html!=='string'||html.length>2*1024*1024)throw new Error('Preview is too large.');this.emit({...this.state(),request:'show'});await view.webContents.loadURL('data:text/html;charset=utf-8;base64,'+Buffer.from(html).toString('base64')).catch(()=>{});return this.state();}
  navigate(action){
    const wc=this.ensure().webContents,h=wc.navigationHistory;
    if(action==='back'&&h.canGoBack())h.goBack();else if(action==='forward'&&h.canGoForward())h.goForward();else if(action==='reload')wc.reload();else if(action==='stop')wc.stop();
    return this.state();
  }
  async settle(ms=15000){
    const wc=this.ensure().webContents;if(!wc.isLoading())return;
    await new Promise(resolve=>{const t=setTimeout(done,ms);function done(){clearTimeout(t);wc.removeListener('did-stop-loading',done);resolve();}wc.on('did-stop-loading',done);});
  }
  // ---- Agent tools. Scripts are fixed; arguments are passed as JSON, never spliced as code. ------------------------
  // A busy page (a long script, a frozen tab) never answers; give up after `ms` with an error the agent can act on.
  async run(fn,arg,ms=10000){
    const wc=this.ensure().webContents;let timer;
    const limit=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`The page did not respond within ${ms/1000} seconds; it may be busy. Try again, or open it again to reload it.`)),ms);});
    const code=`(${fn})(${JSON.stringify(arg??null)})`;
    // Through the DevTools protocol the script runs at once; executeJavaScript waits for a page to finish loading,
    // which a streaming or slow page never does.
    const evaluate=wc.debugger.isAttached()?wc.debugger.sendCommand('Runtime.evaluate',{expression:code,returnByValue:true,awaitPromise:true,userGesture:true}).then(r=>{if(r.exceptionDetails)throw new Error(`Page script failed: ${r.exceptionDetails.exception?.description||r.exceptionDetails.text||'error'}`.slice(0,300));return r.result?.value;}):wc.executeJavaScript(code,true);
    try{return await Promise.race([evaluate,limit]);}finally{clearTimeout(timer);}
  }
  // Every agent action returns within 45 seconds, with the page state and an error if it could not finish.
  async tool(op,args={}){
    this.emit({...this.state(),request:'show',agent:this.owner!=='user'});this.lastDialog='';let timer;
    const limit=new Promise(resolve=>{timer=setTimeout(()=>resolve({...this.state(),error:'The browser action took longer than 45 seconds and was stopped. The page may still be loading; try browser_read.'}),45000);});
    try{
      const result=await Promise.race([this.action(op,args).catch(error=>({...this.state(),error:String(error?.message||error)})),limit]);
      return this.lastDialog?{...result,dialog:`Answered a page dialog (${this.lastDialog}).`}:result;
    }finally{clearTimeout(timer);}
  }
  async action(op,args={}){
    switch(op){
      case 'open':return {...await this.open(args.url),...await this.read({max:args.max||6000,settled:true})};
      case 'read':return this.read(args);
      case 'close':return this.pane.close(this.owner);
      case 'back':this.navigate('back');await this.settle();return this.state();
      case 'screenshot':{
        const view=this.ensure();await this.settle();
        // A tab that is not on screen does not paint: show it outside the window for the capture.
        const off=!this.visible;if(off){const b=this.pane.bounds||{width:1280,height:800};view.setBounds({x:-20000,y:0,width:b.width,height:b.height});view.setVisible(true);await new Promise(r=>setTimeout(r,250));}
        let image;try{image=await view.webContents.capturePage();}finally{if(off){view.setVisible(false);if(this.pane.bounds)view.setBounds(this.pane.bounds);}}
        const size=image.getSize();if(size.width>1280)image=image.resize({width:1280});
        return {...this.state(),image:image.toPNG().toString('base64')};
      }
      case 'click':{
        const r=await this.run(function(a){
          const visible=el=>{const s=getComputedStyle(el),b=el.getBoundingClientRect();return s.visibility!=='hidden'&&s.display!=='none'&&b.width>0&&b.height>0;};
          let el=null;
          if(a.selector)try{el=document.querySelector(a.selector);}catch{return {error:'Invalid CSS selector.'};}
          if(!el&&a.text){const want=String(a.text).trim().toLowerCase();el=[...document.querySelectorAll('a,button,[role=button],input[type=submit],input[type=button],summary,label,[onclick]')].find(e=>visible(e)&&(e.innerText||e.value||e.getAttribute('aria-label')||'').trim().toLowerCase().includes(want));}
          if(!el)return {error:'Nothing to click matched.'};
          el.scrollIntoView({block:'center'});el.click();return {clicked:(el.innerText||el.value||el.tagName).trim().slice(0,120)};
        },args);
        await new Promise(r=>setTimeout(r,400));await this.settle();return {...r,...this.state()};
      }
      case 'type':{
        const r=await this.run(function(a){
          let el=null;if(a.selector)try{el=document.querySelector(a.selector);}catch{return {error:'Invalid CSS selector.'};}
          el=el||document.activeElement;if(!el||!('value' in el||el.isContentEditable))return {error:'No input field matched.'};
          el.focus();if(el.isContentEditable)el.textContent=a.text;else{const proto=Object.getPrototypeOf(el);const set=Object.getOwnPropertyDescriptor(proto,'value')?.set;set?set.call(el,a.text):el.value=a.text;}
          el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));
          if(a.submit){const form=el.form;if(form?.requestSubmit)form.requestSubmit();else el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));}
          return {typed:true};
        },{selector:args.selector,text:String(args.text??'').slice(0,5000),submit:!!args.submit});
        await new Promise(r=>setTimeout(r,300));await this.settle();return {...r,...this.state()};
      }
      case 'scroll':await this.run(function(a){window.scrollBy(0,a.dy);},{dy:Math.max(-20000,Math.min(20000,Number(args.dy)||800))});return this.state();
      default:throw new Error('Unknown browser action.');
    }
  }
  async read({max=12000,settled=false}={}){
    if(!settled)await this.settle(8000); // open() already waited for the page
    const page=await this.run(function(a){
      const text=(document.body?.innerText||'').replace(/\n{3,}/g,'\n\n').slice(0,a.max);
      const links=[...document.querySelectorAll('a[href]')].filter(l=>l.innerText.trim()).slice(0,80).map(l=>({text:l.innerText.trim().slice(0,80),href:l.href}));
      const inputs=[...document.querySelectorAll('input,textarea,select,button')].slice(0,40).map(e=>({tag:e.tagName.toLowerCase(),type:e.type||'',name:e.name||'',id:e.id||'',label:(e.labels?.[0]?.innerText||e.placeholder||e.getAttribute('aria-label')||e.innerText||e.value||'').trim().slice(0,60)}));
      return {text,links,inputs};
    },{max:Math.max(500,Math.min(40000,Number(max)||12000))});
    return {...this.state(),...page};
  }
}
module.exports={BrowserPane,BrowserTab,normalize,allowed,partitionOf,ownerId};
