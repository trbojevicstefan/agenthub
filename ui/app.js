/* Opaya renderer. No Node access, remote HTML, tokens in storage or generic IPC. */
'use strict';
(() => {
  const api = window.agenthub;
  const $ = (selector, root = document) => root.querySelector(selector);
  const plural=(n,w)=>`${n} ${w}${n===1?'':'s'}`;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const labels = {hermes:'Hermes',codex:'Codex',claude:'Claude Code',openclaw:'OpenClaw',deepseek:'DeepSeek',openai:'OpenAI',google:'Google Gemini',openrouter:'OpenRouter',xai:'xAI',groq:'Groq',mistral:'Mistral',ollama:'Ollama',lmstudio:'LM Studio',custom:'Custom agent'};
  const title = a => a?.displayName || a?.name || 'Agent';
  const description = a => a?.description || a?.note || labels[a?.provider] || 'Agent';
  // The sidebar's one line under the name: what it is (unless the name already says so) and where it runs.
  const navSub = a => {const d=description(a),n=title(a).toLowerCase(),where=location(a)+(isDocker(a)?' / Docker':'');return d&&!n.includes(d.toLowerCase())&&d!=='Custom agent'?`${d} · ${where}`:where;};
  // Icon library: the four website logos plus curated LobeHub icons (ui/assets/icons, MIT). Agents default to their provider's logo.
  const ICONS={hermes:['Hermes','assets/agents/hermes.png'],codex:['Codex','assets/agents/codex.svg'],claude:['Claude','assets/agents/claude.png'],openclaw:['OpenClaw','assets/agents/openclaw.svg'],
    ...Object.fromEntries([['hermes-agent','Hermes Agent'],['nous-research','Nous Research'],['claude-code','Claude Code'],['anthropic','Anthropic'],['gemini','Gemini'],['opencode','OpenCode'],['goose','Goose'],['openhands','OpenHands'],['cline','Cline'],['kilo-code','Kilo Code'],['roo-code','Roo Code'],['amp','Amp'],['cursor','Cursor'],['windsurf','Windsurf'],['junie','Junie'],['github-copilot','GitHub Copilot'],['copilot','Copilot'],['openai','OpenAI'],['qwen','Qwen'],['deepseek','DeepSeek'],['kimi','Kimi'],['mistral','Mistral'],['ollama','Ollama'],['lm-studio','LM Studio'],['openrouter','OpenRouter'],['grok','Grok'],['meta-ai','Meta AI'],['manus','Manus'],['zhipu','Zhipu']].map(([id,label])=>[id,[label,`assets/icons/${id}.svg`]]))};
  const agentLogos={hermes:ICONS.hermes[1],codex:ICONS.codex[1],claude:ICONS.claude[1],openclaw:ICONS.openclaw[1],deepseek:ICONS.deepseek[1],openai:ICONS.openai[1],google:ICONS.gemini[1],openrouter:ICONS.openrouter[1],xai:ICONS.grok[1],groq:ICONS['gpt-oss']?.[1],mistral:ICONS.mistral[1],ollama:ICONS.ollama[1],lmstudio:ICONS['lm-studio'][1]};
  const iconImg=(src,cls='')=>`<img class="agent-logo ${cls}" src="${esc(src)}" alt="" draggable="false">`;
  const avatarSrc=a=>{const v=a?.avatar||'';if(v.startsWith('lib:'))return ICONS[v.slice(4)]?.[1]||'';if(v.startsWith('data:image/'))return v;return '';};
  const providerIcon = provider => agentLogos[provider]?`<img class="agent-logo ${provider}-logo" src="${agentLogos[provider]}" alt="" draggable="false">`:'<span class="mark custom-mark"><i></i></span>';
  let state = {agents:[],hosts:[],conversations:[],histories:{},secureStorage:false}, overview = true, opayaView = false, playgroundView = false, renderKey = '', initialized = false, theme = 'dark';
  let toastTimer, returnFocus, currentTerminal = '', lastSelected = '', modalBusy = false;
  let manageId = '', manageHtml = '', manageKeyed = {}, lastFullChat = '';
  // Remember each agent's destination. Graphical agents start in Chat; terminal-only agents start in Terminal.
  const agentModes=new Map(),manageSections=new Map();
  const modeOf=a=>agentModes.get(a.id)==='manage'?'manage':a.protocol==='terminal'||a.surface==='terminal'?'console':agentModes.get(a.id)||'chat';
  // Back: the screens you came through (Home, Machines, an agent's chat, console or Manage section...), newest last.
  let navBack=[],navCur='',navRestoring=false;
  // Sidebar items the user turned off in Settings > Sidebar.
  const SIDE_ITEMS = [['home','Home','Agents at a glance and quick actions'],['playground','Playground','Ask two agents the same question'],['machines','Machines','The fleet board'],['vault','Vault','API keys and tokens'],['skills','Skills & tools','Skills library and MCP servers'],['schedules','Schedules','Messages sent to agents on a schedule; their own cron jobs'],['help','Help','Where is what, connection help and shortcuts']];
  let sidebarHide = new Set();
  const applySidebar = () => { for (const [key] of SIDE_ITEMS) { const el = document.querySelector(`[data-side="${key}"]`); if (el) el.hidden = sidebarHide.has(key); } };
  let stageAgent = ''; // the agent whose CLI the terminal stage last opened
  const pendingWrites = new Set();
  const draftKey = () => currentConversation()?.id || selected()?.id || '';
  const save = promise => { pendingWrites.add(promise); promise.catch(error=>toast(error.message,true)).finally(()=>pendingWrites.delete(promise)); return promise; };
  window.agenthubFlush = () => Promise.allSettled([...pendingWrites]);
  const saveView = () => { if(api.saveView&&!restoringWorkspace)save(api.saveView({overview,opaya:opayaView,playground:playgroundView,collapsed:[...collapsedGroups],terminalVisible:!$('#terminal-panel').hidden,terminalId:currentTerminal,panes:panes.filter(Boolean),terminalWorkspaces:savedWorkspaces(),agentNavigation:[...agentModes].map(([id,mode])=>({id,mode,section:manageSections.get(id)||'overview'})),windows:[...terminalViews.values()].filter(v=>!v.exited).map(v=>[v.id,v.ctx||'',v.hiddenPane?1:0]),theme,projects:projectsOpen,projectsOpen:[...projectsExpanded],layout,chatDock:chatDock.map(d=>({id:d.id,min:!!d.min})),sidebarHide:[...sidebarHide],sidebarHidden,sidebarRail,tips:[...tipsSeen].slice(-300),greeted,lastVersion,terminalFont})); };
  const drafts = new Map(), pendingSends = new Set(), terminalViews = new Map(), terminalPending = new Map();
  const selected = () => state.agents.find(a => a.id === state.activeAgentId);
  const currentConversation = () => state.conversations.find(c => c.id === state.activeConversationId && c.agentId === state.activeAgentId);
  // This computer can be renamed in Machines; the name shows under each agent in the sidebar.
  const localName = () => state.settings?.machineName || 'This computer';
  // An API connection to a provider runs on the provider's server, not on this computer.
  const apiHost = a => {if(a.transport!=='http'||!a.endpoint)return '';try{const h=new URL(a.endpoint).hostname;return ['127.0.0.1','localhost','[::1]'].includes(h)?'':h;}catch{return '';}};
  const location = a => a.transport === 'ssh' ? (state.hosts.find(h=>h.id===a.hostId)?.name || 'SSH host') : apiHost(a) || localName();
  const isDocker = a => a?.command === 'docker' || a?.args?.includes?.('docker') || /docker/i.test(`${a?.name||''} ${a?.detail||''}`);
  const environmentLabel = a => isDocker(a) ? 'Docker' : a.transport === 'ssh' ? 'VPS' : 'Local';
  const placeText = a => isDocker(a) ? `${a.transport === 'ssh' ? 'VPS' : 'Local'} Docker` : environmentLabel(a);
  const agentIcon = a => {const src=avatarSrc(a);if(src)return iconImg(src,'custom-logo');if(a.icon)return esc(a.icon);return providerIcon(a.provider);};
  const badge = (a, large=false) => `<span class="agent-avatar ${esc(a.provider)} ${avatarSrc(a)?'has-avatar':''} ${large?'large':''}" aria-label="${esc(labels[a.provider]||'Agent')} icon"><span class="provider-icon">${agentIcon(a)}</span></span>`;
  const envIcon = a => `<span class="meta-icon ${isDocker(a)?'docker-mark':a.transport==='ssh'?'vps-mark':'local-mark'}" aria-hidden="true"></span>`;
  const meta = a => `<span class="agent-meta">${envIcon(a)}<span>${esc(placeText(a))}</span><span class="meta-divider">/</span><span>${esc(location(a))}</span></span>`;
  const connectionLabel = a => isDocker(a) ? 'Containerized agent runtime' : a.transport === 'ssh' ? 'SSH encrypted connection' : a.protocol === 'openai' ? 'Gateway API' : 'Native CLI connection';
  const status = a => a.busy?'Working':({connected:'Connected',connecting:'Connecting',disconnected:'Disconnected',error:'Needs attention'}[a.status]||'Not connected');
  const trusted = a => !!(state.settings?.itrustAll||a?.itrust);
  const dot = a => `<span class="status-dot ${esc(a.busy?'working':a.status||'disconnected')}"></span>`;
  const mod=()=>state.platform==='darwin'?'\u2318':'Ctrl ';
  // Chat or terminal: how an agent opens. API connections have no CLI, so they always chat; terminal-only agents always
  // use their CLI; otherwise the agent's own choice, then Settings (asked on first launch).
  const hasCli=a=>!!a?.command&&!(a.protocol==='openai'&&!['hermes','openclaw'].includes(a.provider));
  // Motion bookkeeping: state updates re-render often, so entrance animations are keyed to first appearance, not to every render.
  let terminalFont=13,lastVersion='',tipsSeen=new Set(),greeted='',collapsedGroups=new Set(),projectsOpen=false,projectsExpanded=new Set(),layout={terminal:'bottom',browser:'right',bottomHeight:280,rightWidth:520};
  const navSeen=new Map(),messageSeen=new Map(),chatScroll=new Map();let navHtml='',navSelected='',navSelectedAt=0,messageConversation=null,overviewHtml='';
  const fresh=(map,key,now,ms)=>{if(!map.has(key))map.set(key,now);return now-map.get(key)<ms;};
  function enter(element){element.classList.remove('view-enter');void element.offsetWidth;element.classList.add('view-enter');clearTimeout(element.enterTimer);element.enterTimer=setTimeout(()=>element.classList.remove('view-enter'),900);}
  function contentKind(kind){const c=$('#content');c.className=`content ${kind}${c.classList.contains('view-enter')?' view-enter':''}`;}
  function applyTheme(value) {
    theme=value==='light'?'light':'dark';
    document.body.dataset.theme=theme;
    for(const view of terminalViews?.values?.()||[])view.core?.setLight(theme==='light');
  }
  function toast(message, error=false) {
    const box=$('#toast');box.textContent=message;box.classList.toggle('error',error);box.hidden=false;
    clearTimeout(toastTimer);toastTimer=setTimeout(()=>box.hidden=true,error?8500:4500);
  }
  // Yes/no questions go through a native dialog in the desktop app. window.confirm() in Electron can leave the page
  // unable to take keyboard input afterwards (the chat box stops accepting typing until the window is refocused).
  // Opaya's own question dialog, styled like the app (never the system box): a title, what will happen, and a button
  // named for the action, red when it removes something. With `input` it asks for text and returns it (or null).
  const ACTION_WORD=/^(Remove|Delete|Uninstall|Forget|Stop|End|Close|Discard|Replace|Overwrite|Install|Restart|Reconnect|Turn|Give|Migrate|Clone|Update|Import|Reset|Clear|Disconnect|Run|Send|Apply|Merge|Push|Pull|Leave)\b/i;
  function opayaAsk({title:t='',text='',ok='',cancel='Cancel',danger,input=null,placeholder=''}={}){
    return new Promise(resolve=>{
      const word=ACTION_WORD.exec(t)?.[1],label=ok||(word?word[0].toUpperCase()+word.slice(1).toLowerCase():'OK'),red=danger??/^(remove|delete|uninstall|forget|stop|end|discard|overwrite|clear|reset)/i.test(word||'');
      const d=document.createElement('dialog');d.className='opaya-ask';
      d.innerHTML=`<form method="dialog"><h2>${esc(t)}</h2>${text?`<p>${esc(text).replace(/\n/g,'<br>')}</p>`:''}${input!==null?`<input name="value" value="${esc(input)}" placeholder="${esc(placeholder)}" autocomplete="off" spellcheck="false">`:''}<footer><button type="button" class="secondary" value="cancel">${esc(cancel)}</button><button type="submit" class="primary ${red?'danger-button':''}" value="ok">${esc(label)}</button></footer></form>`;
      document.body.append(d);let done=false;const finish=v=>{if(done)return;done=true;d.close();d.remove();resolve(v);};
      d.querySelector('[value="cancel"]').addEventListener('click',()=>finish(input!==null?null:false));
      d.addEventListener('cancel',e=>{e.preventDefault();finish(input!==null?null:false);});
      d.querySelector('form').addEventListener('submit',e=>{e.preventDefault();finish(input!==null?d.querySelector('[name=value]').value.trim()||null:true);});
      d.addEventListener('pointerdown',e=>{if(e.target!==d)return;const r=d.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)finish(input!==null?null:false);});
      d.showModal();(d.querySelector('[name=value]')||d.querySelector(red?'[value="cancel"]':'[value="ok"]')).focus();
    });
  }
  window.opayaAsk=opayaAsk;
  // The questions written as one text: the first paragraph is the title, the rest the explanation.
  const ask=text=>{const t=String(text||''),at=t.indexOf('\n\n');return opayaAsk({title:at<0?t:t.slice(0,at),text:at<0?'':t.slice(at+2)});};
  async function action(fn) { try { return await fn(); } catch(error) {toast(error.message,true); return undefined;} }
  // Files an agent mentions in a reply (an absolute path with a name and extension) show under it as attachments:
  // checked where the agent runs, images previewed, Open, Save and (here) Show in folder. Paths in URLs are not files.
  const FILE_PATH=/(?<![\w:/.\]@-])((?:~\/|\/)(?:[\w.@+-]+\/)*[\w.@+-]*[\w@+-]\.[A-Za-z0-9]{1,8}|[A-Za-z]:\\(?:[^\\\s'"`<>|*?]+\\)*[^\\\s'"`<>|*?]+\.[A-Za-z0-9]{1,8})(?![\w/\\])/g;
  const IMAGE_EXT=/\.(png|jpe?g|gif|webp|bmp|svg)$/i,fileChecks=new Map();
  function agentFiles(text,a){
    if(!a||!text)return '';const found=[...new Set([...String(text).matchAll(FILE_PATH)].map(m=>m[1].replace(/[.,;:]+$/,'')))].slice(0,8);if(!found.length)return '';
    const local=a.transport!=='ssh'&&a.command!=='docker';
    return `<div class="agent-files">${found.map(p=>{const c=fileChecks.get(`${a.id}|${p}`),name=p.split(/[\\/]/).pop();return `<div class="agent-file ${IMAGE_EXT.test(p)?'image':''}" data-agent-file="${esc(p)}" data-agent="${esc(a.id)}" ${c?.exists?'':'hidden'}><span class="af-ico" aria-hidden="true">${fileIcon({name,kind:IMAGE_EXT.test(p)?'image':'file'})}</span><span class="af-text"><strong title="${esc(p)}">${esc(name)}</strong><small>${esc(c?.size!=null?fmtSize(c.size):'')}</small></span><span class="af-actions"><button type="button" class="secondary small" data-action="af-open">Open</button><button type="button" class="secondary small" data-action="af-save">Save&#8230;</button>${local?'<button type="button" class="text-button" data-action="af-reveal">Show in folder</button>':''}</span>${c?.preview?`<img class="af-preview" alt="${esc(name)}" src="${c.preview}">`:''}</div>`;}).join('')}</div>`;
  }
  // Each path is checked once per agent; a found image is fetched once for its preview (up to 8 MB).
  function checkAgentFiles(root=document){
    for(const el of root.querySelectorAll('.agent-file[hidden]')){
      const key=`${el.dataset.agent}|${el.dataset.agentFile}`;if(fileChecks.has(key))continue;fileChecks.set(key,{pending:true});
      api.agentFile?.({agentId:el.dataset.agent,path:el.dataset.agentFile,op:'stat'}).then(async r=>{
        const c={exists:!!r?.exists,size:r?.size};fileChecks.set(key,c);
        if(c.exists&&IMAGE_EXT.test(el.dataset.agentFile)&&c.size<=8*1024*1024){try{const d=await api.agentFile({agentId:el.dataset.agent,path:el.dataset.agentFile});const ext=el.dataset.agentFile.split('.').pop().toLowerCase();c.preview=`data:image/${ext==='svg'?'svg+xml':ext==='jpg'?'jpeg':ext};base64,${d.data}`;}catch{}}
        for(const x of document.querySelectorAll('.agent-file')){if(`${x.dataset.agent}|${x.dataset.agentFile}`!==key)continue;x.hidden=!c.exists;const sm=x.querySelector('.af-text small');if(sm&&c.size!=null)sm.textContent=fmtSize(c.size);if(c.preview&&!x.querySelector('.af-preview'))x.insertAdjacentHTML('beforeend',`<img class="af-preview" alt="" src="${c.preview}">`);}
      }).catch(()=>fileChecks.set(key,{exists:false}));
    }
  }
  new MutationObserver(()=>{clearTimeout(checkAgentFiles.t);checkAgentFiles.t=setTimeout(()=>checkAgentFiles(),120);}).observe(document.body,{childList:true,subtree:true});
  document.addEventListener('click',event=>{const b=event.target.closest('[data-action="af-open"],[data-action="af-save"],[data-action="af-reveal"]');if(!b)return;const card=b.closest('.agent-file');if(!card)return;event.stopPropagation();
    const input={agentId:card.dataset.agent,path:card.dataset.agentFile},act=b.dataset.action;b.disabled=true;
    action(async()=>{try{if(act==='af-open')await api.agentFileOpen(input);else if(act==='af-save'){const to=await api.agentFileSave(input);if(to)toast(`Saved to ${to}.`);}else await api.agentFileReveal(input);}finally{b.disabled=false;}});},true);
  function format(text) { return window.OpayaMarkdown?window.OpayaMarkdown.render(text):esc(text); }
  // agentId adds a live line (running time, time since the last update) that updateTurnWatch() refreshes every second.
  function activityMarkup(message,limit=20,agentId=''){
    const watch=message?.status==='streaming'&&agentId?`<footer class="turn-watch" data-turn-watch="${esc(agentId)}"></footer>`:'';
    const items=(message?.activity||[]).slice(-limit);if(!items.length)return watch?`<section class="activity-live solo">${watch}</section>`:'';
    if(message.status==='streaming')return `<section class="activity-live"><header><span class="status-dot working"></span><strong>Live activity</strong><small>${items.length} update${items.length===1?'':'s'}</small></header><div>${items.map((t,i)=>`<p class="${i===items.length-1?'current':''}"><span>${i===items.length-1?'&#9656;':'&#10003;'}</span>${esc(t)}</p>`).join('')}</div>${watch}</section>`;
    return `<details class="activity-detail"><summary>${esc(items.length+' step'+(items.length===1?'':'s')+': '+items.at(-1))}</summary><div>${items.map(t=>`<p>${esc(t)}</p>`).join('')}</div></details>`;
  }
  function applyState(next) {
    state=next;document.body.dataset.platform=state.platform;
    if(!initialized){for(const n of state.view?.agentNavigation||[]){agentModes.set(n.id,n.mode);manageSections.set(n.id,n.section);}overview=state.view?.overview??!state.activeAgentId;opayaView=!!state.view?.opaya||!state.agents.length&&!state.opayaAgent?.configured;playgroundView=!!state.view?.playground&&!opayaView;collapsedGroups=new Set(state.view?.collapsed||[]);sidebarHidden=!!state.view?.sidebarHidden;sidebarRail=state.view?.sidebarRail??true;projectsOpen=!!state.view?.projects;tipsSeen=new Set(state.view?.tips||[]);greeted=state.view?.greeted||'';lastVersion=state.view?.lastVersion||'';setTimeout(checkNudges,4000);if(state.view?.layout)layout={...layout,...state.view.layout};terminalFont=Number(state.view?.terminalFont)||13;queueMicrotask(()=>placePanes());projectsExpanded=new Set(state.view?.projectsOpen||[]);chatDock=(state.view?.chatDock||[]).map(d=>({id:d.id,min:!!d.min}));sidebarHide=new Set(state.view?.sidebarHide||[]);if(projectsOpen)setTimeout(()=>refreshProjectGit(),300);applyTheme(state.view?.theme||'dark');for(const [key,value]of Object.entries(state.drafts||{}))drafts.set(key,value);initialized=true;if(state.recoveryNotice)toast(state.recoveryNotice,true);renderWindowControls();api.windowControl?.({action:'state'}).then(v=>{windowState=v;renderWindowControls();}).catch(()=>{});}
    render();
  }
  // The sidebar's groups in the order they show: Pinned, custom groups, This computer, Remote. Ctrl/Cmd+1 to 9 follow
  // this order, so the first agent on screen is 1.
  function navGroups(){
    const customGroups=[...new Set(state.agents.filter(a=>!a.pinned&&a.group).map(a=>a.group))];
    return [['pinned','PINNED',state.agents.filter(a=>a.pinned)],...customGroups.map(g=>[`group:${g}`,g,state.agents.filter(a=>!a.pinned&&a.group===g)]),['local','ON THIS COMPUTER',state.agents.filter(a=>!a.pinned&&!a.group&&a.transport!=='ssh')],['remote','REMOTE AGENTS',state.agents.filter(a=>!a.pinned&&!a.group&&a.transport==='ssh')]];
  }
  const navOrder=()=>navGroups().flatMap(g=>g[2]);
  // One string per screen; each change pushes the previous one, unless Back itself is moving.
  function navSig(){if(playgroundView)return 'pg';if(opayaView)return 'opaya';if(overview)return fleetView?'fleet':'home';const a=selected();if(!a)return 'home';const m=modeOf(a);return `a|${a.id}|${m}|`;}
  function trackNav(){const sig=navSig();if(sig===navCur)return;if(navCur&&!navRestoring){navBack=navBack.filter(x=>x!==sig);navBack.push(navCur);if(navBack.length>40)navBack.shift();}navCur=sig;queueMicrotask(()=>{const b=$('.topbar-back');if(b){b.disabled=!navBack.length;b.title=navBack.length?`Back to ${navLabel(navBack.at(-1))} (Alt+Left)`:'Back';}});}
  function navLabel(sig){if(sig==='pg')return 'Playground';if(sig==='opaya')return 'Opaya Agent';if(sig==='home')return 'Home';if(sig==='fleet')return 'Machines';const [,id,m,sec]=sig.split('|'),a=state.agents.find(x=>x.id===id);if(!a)return 'the previous screen';return `${title(a)}: ${m==='manage'?'Manage':m==='console'?'Terminal':'Chat'}`;}
  async function navGoBack(){
    while(navBack.length){const sig=navBack.pop(),parts=sig.split('|');if(parts[0]==='a'&&!state.agents.some(x=>x.id===parts[1]))continue;
      navRestoring=true;
      try{if(sig==='home')fire('overview');else if(sig==='fleet')openFleet();else if(sig==='opaya')fire('opaya');else if(sig==='pg')fire('playground');else{const a=state.agents.find(x=>x.id===parts[1]);if(parts[2]==='manage')await openManage(a.id);else{if(parts[2]==='console')agentModes.set(a.id,'console');await setAgentMode(a,parts[2]==='console'?'console':'chat');}}}
      finally{navCur=navSig();navRestoring=false;const b=$('.topbar-back');if(b){b.disabled=!navBack.length;b.title=navBack.length?`Back to ${navLabel(navBack.at(-1))} (Alt+Left)`:'Back';}}
      return;}
  }
  function render() {
    trackNav();
    const oldMessages=$('#message-list');if(oldMessages?.dataset.conversation)chatScroll.set(oldMessages.dataset.conversation,{top:oldMessages.scrollTop,bottom:oldMessages.scrollHeight-oldMessages.scrollTop-oldMessages.clientHeight<110});
    queueMicrotask(()=>{ensureProjectsToggle();renderProjects();renderDock();const sel=selected()?.id||'';if(historyOpen&&sel!==historyFollow&&historyAgent&&sel)historyAgent=sel;historyFollow=sel;renderHistory();});
    $('#agent-count').textContent=state.agents.length;applySidebar();
    $('#host-count').textContent=state.hosts.length;const vc=$('#vault-count');if(vc)vc.textContent=(state.opayaAgent?.secrets||[]).filter(k=>k.kept||k.global||k.stored?.length).length||'';
    $('.nav-overview').classList.toggle('selected',overview&&!fleetView&&!opayaView&&!playgroundView);document.querySelector('[data-side="machines"]')?.classList.toggle('selected',overview&&fleetView&&!opayaView&&!playgroundView);$('.nav-playground')?.classList.toggle('selected',playgroundView);$('.nav-opaya').classList.toggle('selected',opayaView);renderOpayaNav();
    // Sections: pinned, each custom group in first-seen order, then ungrouped local and remote agents. Every section collapses
    // to a row of its agents' icons, so a collapsed section never looks like it holds only the selected agent.
    const groups=navGroups(),hkOf=new Map(navOrder().slice(0,9).map((a,i)=>[a.id,i+1]));
    const now=performance.now(),current=overview||opayaView||playgroundView?'':state.activeAgentId||'';let row=0;
    if(current!==navSelected){navSelected=current;navSelectedAt=now;}
    const nav=groups.filter(g=>g[2].length).map(([key,name,all])=>{const closed=collapsedGroups.has(key),agents=closed?[]:all,busy=closed&&all.some(a=>a.busy);return `<button class="sidebar-section-label ${closed?'collapsed':''} ${key.startsWith('group:')?'custom-group':''}" data-action="toggle-group" data-group="${esc(key)}" aria-expanded="${!closed}" title="${closed?'Expand':'Collapse'} ${esc(name)} (right-click for group actions)"><span class="group-chevron" aria-hidden="true">&#9662;</span><span class="group-name">${esc(name)}</span><span class="group-short" aria-hidden="true">${esc(key==='local'?'Local':key==='remote'?'Remote':key==='pinned'?'Pinned':name)}</span>${busy?'<span class="status-dot working"></span>':''}<span class="group-count">${all.length}</span></button><div class="sidebar-group ${closed?'closed':''}">${closed?`<div class="collapsed-strip" data-section="${esc(key)}">${all.map(a=>`<button type="button" class="mini-agent ${a.id===current?'selected':''}" data-action="select" data-id="${esc(a.id)}" data-agent-id="${esc(a.id)}" title="${esc(title(a)+' / '+placeText(a)+' / '+status(a))}" aria-label="${esc(title(a))}">${badge(a)}${dot(a)}</button>`).join('')}</div>`:''}${agents.map(a=>`<div class="agent-nav-row ${fresh(navSeen,a.id,now,650)?'enter':''}" style="--i:${row++}" data-agent-id="${esc(a.id)}" data-section="${esc(key)}" draggable="true"><button class="agent-nav ${!overview&&!opayaView&&!playgroundView&&a.id===state.activeAgentId?'selected':''} ${a.id===navSelected&&now-navSelectedAt<500?'just-selected':''}" data-action="select" data-id="${esc(a.id)}" aria-label="${esc(title(a)+', '+status(a)+', '+location(a))}">${badge(a)}<span class="agent-nav-text"><strong>${esc(title(a))}${trusted(a)?'<span class="itrust-mark" title="iTrust: approved automatically">iT</span>':''}</strong><small class="agent-nav-host">${esc(navSub(a))}</small></span>${dot(a)}${hkOf.has(a.id)?`<kbd class="nav-hk" aria-hidden="true">${hkOf.get(a.id)}</kbd>`:''}</button><button type="button" class="agent-nav-manage" data-action="manage" data-id="${esc(a.id)}" title="Manage ${esc(title(a))}" aria-label="Manage ${esc(title(a))}">&#9881;</button></div>`).join('')}</div>`;}).join('')||'<div class="sidebar-empty"><span class="connection-dots"><i></i><i></i><i></i></span><span class="sidebar-empty-text">Your agents will<br>feel at home here.</span><button type="button" class="sidebar-empty-add" data-action="discover" title="Find the agents on this computer, or install one" aria-label="Add your first agent">+</button></div>';
    if(nav!==navHtml){navHtml=nav;$('#agent-list').innerHTML=nav;}refreshRailCard();
    const a=selected();
    // A left click opens an agent's management screen; Chat and Terminal are the other two ways to work with it.
    const mode=!overview&&!opayaView&&!playgroundView&&a?modeOf(a):'';manageId=mode==='manage'?a.id:'';
    const stage=mode==='console';if(manageId)mgSection=manageSections.get(a.id)||'overview';
    if(stage!==document.body.classList.contains('terminal-stage')){document.body.classList.toggle('terminal-stage',stage);placePanes();}
    if(!stage)stageAgent='';
    // The terminal windows follow the screen first, so the agent's sidebar shows them as they now are.
    syncTerminalContext();
    {const full=mode==='chat'&&a&&a.protocol!=='terminal'&&state.activeConversationId?`${a.id}|${state.activeConversationId}`:'';
      if(lastFullChat&&lastFullChat!==full){const [aid,cid]=lastFullChat.split('|'),ag=state.agents.find(x=>x.id===aid);
        if(ag?.busy&&state.conversations.some(c=>c.id===cid)&&!chatDock.some(d=>d.id===cid)){chatDock.push({id:cid,min:true});saveView();}}
      lastFullChat=full;}
    renderAgentNav(mode?a:null,mode==='manage'?'manage':mode==='console'?'console':mode?'chat':opayaView&&!playgroundView?'opaya':'');
    // A view can rebuild its chat box while someone is typing (a new chat gets its id, the agent's details change).
    // The new box would not have focus, so keystrokes went nowhere: keep focus and the caret in the chat box.
    const typing=document.activeElement?.id==='message-input'?document.activeElement:null,caret=typing&&[typing.value,typing.selectionStart,typing.selectionEnd];
    if(opayaView)renderOpaya();else if(playgroundView)renderPlayground();else if(overview&&fleetView)renderFleet();else if(overview||!a)renderOverview();else if(manageId)renderManage(a);else if(stage)renderAgentTerminal(a);else renderAgent(a);
    const box=$('#message-input');
    if(typing&&box&&box!==typing&&!box.disabled&&(!document.activeElement||document.activeElement===document.body)){box.focus({preventScroll:true});if(box.value===caret[0])box.setSelectionRange(caret[1],caret[2]);}
    $('#status-left').textContent=playgroundView?'Playground / ask two agents the same question':opayaView?'Opaya Agent / installs, connects and troubleshoots your agents':a&&!overview?`${labels[a.provider]||a.provider} / ${a.protocol==='openai'?'Gateway API':a.protocol.toUpperCase()} / ${location(a)}`:'One place. All your agents.';
    $('#status-right').textContent=state.agents.some(a=>a.busy)?`${state.agents.filter(a=>a.busy).length} agent working`:(state.service?.persistent?'Sessions protected / safe to close window':'Local workspace / no cloud account');
    updateTurnWatch();renderToolChip();renderTitleControls();
    if(lastSelected!==state.activeAgentId)lastSelected=state.activeAgentId;
  }
  // ---- Workspace: every control in one place, and filters for a long list of agents --------------------------------
  let wsQuery='',wsStatus='',wsPlace='';
  const wsPlaceOf=a=>isDocker(a)?'docker':a.transport==='ssh'?'vps':a.protocol==='openai'&&!a.command&&/^https?:/.test(a.endpoint||'')&&!/127\.0\.0\.1|localhost/.test(a.endpoint||'')?'api':'local';
  // A chat error that means the agent's API key is missing or wrong: the message offers the key button's dialog.
  const KEY_ERROR=/api[ _-]?key|authentication fail|unauthori[sz]ed|invalid[ _-]?(?:x-)?api|HTTP 401|incorrect api/i;
  const wsStatusOf=a=>a.error||a.status==='error'?'attention':a.status==='connected'?'connected':'offline';
  const wsMatch=(a,{status=wsStatus,place=wsPlace}={})=>{const q=wsQuery.trim().toLowerCase();return (!tagFilter||(a.tags||[]).includes(tagFilter))&&(!status||wsStatusOf(a)===status)&&(!place||wsPlaceOf(a)===place)&&(!q||[title(a),a.name,a.provider,labels[a.provider],location(a),a.group,...(a.tags||[])].filter(Boolean).join(' ').toLowerCase().includes(q));};
  // A chip counts what it shows with the other filters kept. It counted every agent, so "Connected 5" could open on one.
  const wsCount=(kind,v)=>state.agents.filter(a=>wsMatch(a,kind==='status'?{status:v}:{place:v})).length;
  const wsAgents=()=>state.agents.filter(a=>wsMatch(a));
  function workspaceControls(){
    const outdated=typeof outdatedTools==='function'?outdatedTools().length:0,group=(name,items)=>`<div class="ws-group"><h3>${name}</h3><div>${items.join('')}</div></div>`,b=(act,icon,label,hint,extra='')=>`<button type="button" class="ws-control" data-action="${act}" title="${esc(hint)}" ${extra}><span class="ws-ico" aria-hidden="true">${typeof icon==='string'&&icon.startsWith('<svg')?icon:dkIcon(icon)}</span><span class="ws-label">${label}</span></button>`;
    const I={...AN_ICON,check:anI('<path d="M4 12l5 5L20 6"/>'),updates:anI('<path d="M12 20V6M6 12l6-6 6 6"/>'),disconnect:anI('<circle cx="12" cy="12" r="7"/>'),terminal:anI('<path d="m5 8 4 4-4 4M12 17h7"/>'),settings:anI('<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>'),playground:anI('<path d="M4 5h9v7H7l-3 3zM11 15h6l3 3V10h-4"/>')};
    return `<section class="ws-controls" aria-label="Workspace controls">
      ${group('Agents',[b('connect-all',I.power,'Connect all','Connect every agent at once'),b('disconnect-all',I.disconnect,'Disconnect all','Disconnect every agent; chats stay'),b('install-catalog','pull','Install agents','Install Hermes, Claude Code, Codex, OpenClaw and more, here or on a VPS'),b('add',I.plus,'Add connection','Add an agent or an API by hand')])}
      ${group('Keep them healthy',[b('tool-updates',I.updates,`Check for updates${outdated?` <em>${outdated}</em>`:''}`,'Installed agents and tools with newer versions'),b('update-all','refresh','Update all agents','Update every agent installation on every machine',state.agents.some(a=>a.install?.update)?'':'disabled'),b('opaya-check-all',I.check,'Check &amp; fix all','The Opaya Agent checks every agent that has an error and fixes it',state.agents.some(a=>a.error)?'':'disabled'),b('opaya',I.chat,'Ask the Opaya Agent','Install, connect or repair anything by asking')])}
      ${group('Keys, skills and tools',[b('vault',I.access,'Opaya Vault','Your API keys: add, import from a .env or your tools, give to agents'),b('library',I.library,'Skills library','Global skills you can install to any agent'),b('mcp-manage',I.mcp,'MCP servers','Tools such as GitHub, a browser or a database'),b('transfer-pick',I.shareSkills,'Share between agents','Copy skills, keys and MCP servers from one agent to another',state.agents.length>1?'':'disabled'),b('playground',I.playground,'Playground','Ask two agents the same question side by side')])}
      ${group('Machines and files',[b('hosts',I.machine,'Machines','This computer and your servers'),b('docker-manager','box','Docker manager','Containers and images on your machines','data-id="local"'),b('new-vps',I.plus,'New VPS','Set up a new server with its own SSH key'),b('local-terminal',I.terminal,'Local terminal','A shell on this computer'),b('files-local',I.projects,'Files','Browse files on this computer'),b('settings',I.settings,'Settings','Theme, notifications, terminal and more')])}
    </section>`;
  }
  // No agents yet: Home opens with the three ways to start instead of controls that have nothing to act on.
  function getStarted(){
    const card=(act,icon,t,sub,extra='')=>`<button type="button" class="ws-start-card" data-action="${act}">${extra}<span class="ws-start-ico" aria-hidden="true">${icon}</span><strong>${t}</strong><small>${sub}</small></button>`;
    return `<section class="ws-start" aria-label="Get started"><h2>Bring in your first agent</h2><p>Opaya brings the AI agents you use (Hermes, Claude Code, Codex, OpenClaw and others) into one place, on this computer and on your servers. Choose how to start:</p>
      <div class="ws-start-cards">${card('discover',dkIcon('inspect'),'Find agents on this computer','Already use Claude Code, Codex or Hermes? Opaya looks for them, and you choose which to connect.','<em class="ws-start-tag">Recommended</em>')}${card('install-catalog',dkIcon('pull'),'Install an agent','One click installs Hermes, Claude Code, Codex, OpenClaw and more, here or on a server.')}${card('opaya',AN_ICON.chat,'Ask the Opaya Agent','Say what you want; it sets things up step by step and asks before every change.')}</div>
      <p class="ws-start-more">Or: <button type="button" class="text-button" data-action="add">add a connection by hand</button> &#183; <button type="button" class="text-button" data-action="new-vps">connect a server (VPS)</button> &#183; <button type="button" class="text-button" data-action="vault-import">import your API keys</button></p></section>`;
  }
  function renderOverview() {
    topbar('Home');
    const connected=state.agents.filter(a=>a.status==='connected').length,entering=renderKey!=='overview';
    contentKind('overview');
    const html=`<div class="workspace-heading"><div><div class="eyebrow"><span class="tiny-square"></span> HOME</div><h1>One place.<br>All your agents.</h1><p>From the machine in front of you to the server across the world.<br>Connect, switch, and keep the conversation going.</p></div><div class="workspace-art" aria-hidden="true"><div class="orbit orbit-one"></div><div class="orbit orbit-two"></div><div class="art-center"><span class="opaya-mark large"><img src="assets/opaya-logo.png" alt=""><i></i></span></div><span class="art-node node-one">${providerIcon('hermes')}</span><span class="art-node node-two">${providerIcon('codex')}</span><span class="art-node node-three">${providerIcon('claude')}</span><span class="art-node node-four">${providerIcon('openclaw')}</span><span class="orbit-signal"></span></div></div><div class="workspace-stats"><div><span class="status-dot connected"></span><strong>${connected}</strong> connected</div><div><span class="machine-icon"></span><strong>${state.hosts.length}</strong> remote machines</div><div><span class="terminal-glyph">&gt;_</span> Native terminal built in</div><div class="stats-private"><span class="lock-symbol">&#9906;</span> Private by default</div></div>${state.agents.length?workspaceControls():getStarted()}<div class="section-heading"><div><h2>Your agents <span>${state.agents.length}</span></h2><p>Different runtimes. One familiar workspace.</p></div><div class="section-actions"><button class="text-button" data-action="install-catalog">&#8595; Install agents</button><button class="text-button" data-action="add">+ Add connection</button></div></div><div class="ws-filters"><label class="ws-search"><span class="search-icon" aria-hidden="true"></span><input id="ws-search" value="${esc(wsQuery)}" placeholder="Filter agents" aria-label="Filter agents" autocomplete="off" spellcheck="false"></label>${[['','All'],['connected','Connected'],['attention','Needs attention'],['offline','Not connected']].map(([v,l])=>`<button type="button" class="tag-chip ${wsStatus===v?'active':''}" data-action="ws-status" data-value="${v}">${l} <small>${wsCount('status',v)}</small></button>`).join('')}<span class="ws-filter-gap"></span>${[['','Everywhere'],['local','This computer'],['vps','Remote'],['docker','Docker'],['api','API']].filter(([v])=>!v||state.agents.some(a=>wsPlaceOf(a)===v)).map(([v,l])=>`<button type="button" class="tag-chip ${wsPlace===v?'active':''}" data-action="ws-place" data-value="${v}">${l} <small>${wsCount('place',v)}</small></button>`).join('')}${allTags().length?`<span class="ws-filter-gap"></span>${allTags().map(t=>`<button class="tag-chip ${t===tagFilter?'active':''}" data-action="tag-filter" data-tag="${esc(t)}">#${esc(t)}</button>`).join('')}`:''}</div>${(n=>n&&n<state.agents.length?`<div class="ws-showing">Showing ${n} of ${state.agents.length} agents. <button type="button" class="text-button" data-action="ws-clear">Show all</button></div>`:'')(wsAgents().length)}<div class="agent-grid">${wsAgents().map((a,i)=>`<article class="agent-card" data-agent-id="${esc(a.id)}" style="--i:${i}"><div class="card-top">${badge(a,true)}<span class="status-pill ${esc(a.status)}">${dot(a)}${status(a)}</span></div><h3>${esc(title(a))}</h3><div class="agent-card-meta">${meta(a)}</div><p>${esc(description(a))}</p>${a.tags?.length?`<div class="card-tags">${tagChips(a)}</div>`:''}<div class="card-connection">${envIcon(a)}${esc(connectionLabel(a))}</div>${a.error?`<p class="card-error" title="${esc(a.error)}">${esc(a.error)}</p>`:''}<div class="card-quick"><button type="button" class="${a.status==='connected'?'secondary':'primary'}" data-action="card-connect" data-id="${esc(a.id)}" ${a.status==='connecting'?'disabled':''}>${a.status==='connected'?'Disconnect':a.status==='connecting'?'Connecting...':'Connect'}</button><button type="button" class="secondary" data-action="select" data-id="${esc(a.id)}" title="Open ${esc(title(a))}">${a.protocol==='terminal'||a.surface==='terminal'?'Open':'Chat'}</button><button type="button" class="secondary" data-action="card-terminal" data-id="${esc(a.id)}" title="${esc(hasCli(a)?`Open ${title(a)}'s CLI`:'Open a shell')}">&gt;_ Terminal</button><button type="button" class="secondary" data-action="manage" data-id="${esc(a.id)}" title="Update, skills, clone, back up, uninstall and more">&#9881; Manage</button>${a.error?`<button type="button" class="secondary" data-action="card-fix" data-id="${esc(a.id)}" title="The Opaya Agent checks it end to end and fixes it">&#10038; Fix</button>`:''}</div>${a.group?`<span class="card-group">${esc(a.group)}</span>`:''}</article>`).join('')}${wsAgents().length||!state.agents.length?'':'<div class="ws-none">No agent matches these filters. <button type="button" class="text-button" data-action="ws-clear">Show all</button></div>'}<button class="add-card" data-action="add" style="--i:${state.agents.length}"><span class="add-card-plus">+</span><strong>${state.agents.length?'Make room for another.':'Meet your first agent.'}</strong><small>Hermes, Codex, Claude, OpenClaw<br>or any ACP / compatible API agent.</small><span class="add-card-link">Add an agent &#8594;</span></button></div>${!state.agents.length?'<div class="getting-started"><span class="step-number">01</span><div><strong>Already have agents installed?</strong><p>Discover checks known install folders, CLI tools and local API ports. Review what it finds before connecting.</p></div><button class="secondary" data-action="discover">Discover this computer</button></div>':''}<div class="workspace-footnote">No account to create. No credentials to route through someone else\'s server. Just your agents, connected.</div>`;
    if(entering||html!==overviewHtml){const searching=document.activeElement?.id==='ws-search'?document.activeElement:null,caret=searching&&[searching.selectionStart,searching.selectionEnd];overviewHtml=html;$('#content').innerHTML=html;if(searching){const box=$('#ws-search');box?.focus({preventScroll:true});box?.setSelectionRange(...caret);}}
    if(entering)enter($('#content'));
    renderKey='overview';
  }
  // Terminal-first: the agent's own CLI fills the main area, with tabs, splits and the terminal right-click menu.
  // Entering an agent opens (or brings back) its CLI once; after that the user decides what runs where.
  const stageOpening=new Set();
  function renderAgentTerminal(a){
    topbar('<strong>Terminal</strong>','','console');
    contentKind('stage');if(renderKey!=='stage:'+a.id){$('#content').innerHTML='';renderKey='stage:'+a.id;}
    $('#terminal-panel').hidden=false;
    if(restoringWorkspace||stageAgent===a.id)return;stageAgent=a.id;
    // Its windows as they are; else its sessions from elsewhere, brought here. Someone typing in a form or dialog keeps
    // the keyboard when the stage follows another agent.
    const own=ctxWindows(a.id).filter(v=>!v.hiddenPane);if(own.length){activateTerminal((own.find(v=>v.id===workspace().active)||own[0]).id,{focus:!typingElsewhere()});return;}
    if(ctxWindows(a.id).length)return;
    const mine=[...terminalViews.values()].filter(v=>v.agentId===a.id&&!v.exited&&!v.poppedOut),cli=mine.find(v=>v.mode==='agent');
    if(cli||mine[0]){activateTerminal((cli||mine[0]).id,{focus:!typingElsewhere(),bring:true});return;}
    if(stageOpening.has(a.id))return;stageOpening.add(a.id);
    openTerminal(hasCli(a)?{agentId:a.id,mode:'agent'}:{agentId:a.id}).catch(error=>toast(error.message,true)).finally(()=>stageOpening.delete(a.id));
  }
  function renderAgent(a) {
    const proj=projectOf(currentConversation());topbar(`${proj?`<button type="button" class="crumb-project" data-action="project-focus" data-id="${esc(proj.id)}" title="${esc(proj.path)}"><span class="project-folder" aria-hidden="true"></span>${esc(proj.name)}</button>`:''}`,trusted(a)?`<button type="button" class="itrust-pill" data-action="itrust-agent" data-id="${esc(a.id)}" title="iTrust is on: ${esc(title(a))}'s tool requests are approved automatically. Click to change.">iTrust</button>`:'','chat');
    contentKind('conversation');
    if(renderKey!==JSON.stringify([a.id,title(a),a.description,a.icon,a.provider,location(a),state.activeConversationId])) {
      $('#content').innerHTML=`<div class="conversation-heading"><div class="conversation-identity">${badge(a,true)}<div><h1>${esc(title(a))}</h1><p>${esc(description(a))}</p><div class="identity-meta">${meta(a)}${a.tags?.length?`<span class="heading-tags">${tagChips(a,6)}</span>`:''}</div></div></div><div class="conversation-controls"><button type="button" class="secondary" data-action="chat-terminal">Show terminal beside chat</button><select id="conversation-picker" aria-label="Conversation history" title="Switch between this agent's conversations"></select><button class="icon-button" data-action="new-conversation" title="New conversation (Ctrl + N)" aria-label="New conversation">+</button><button class="icon-button" data-action="export" title="Export this conversation as Markdown" aria-label="Export conversation">&#8595;</button><button class="icon-button history-button" data-action="history-toggle" title="Chat history (${mod()}Shift+H)" aria-label="Chat history"><span class="history-glyph" aria-hidden="true"></span></button>${a.install?.framework==='dsh'?'<button class="secondary" data-action="dsh-web" title="Open DeepSeek Harness\'s own Web UI in the Opaya browser">Web UI</button>':''}<button id="connect-button" class="secondary" data-action="connect"></button></div></div>${tipsSeen.has('note:chat-cli')?'':'<p class="terminal-chat-note"><span>Chat here and the agent\'s own CLI in Terminal can be separate conversations: switching views does not move messages between them.</span><button type="button" class="text-button" data-action="dismiss-note" data-id="note:chat-cli">Got it</button></p>'}<div id="connection-banner"></div><div id="message-list" class="message-list"></div><div class="compose-area"><form id="message-form"><div id="compose-files" class="compose-files" hidden></div><textarea id="message-input" placeholder="Message ${esc(title(a))}..." aria-label="Message ${esc(title(a))}" rows="2" maxlength="80000"></textarea><div class="compose-bottom"><div class="compose-tools"><button type="button" class="compose-tool" data-action="compose-attach" title="Attach files (you can also drop files here or paste a screenshot)" aria-label="Attach files"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg></button><button type="button" class="compose-tool" data-action="compose-secret" title="Keys: see the keys this agent has, insert one into your message, or give it a new one" aria-label="This agent's keys"><svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3 20 3M16 7l3 3M13.5 9.5l2 2"/></svg></button><button type="button" id="compose-model" class="compose-chip" data-action="compose-model" title="Model for this chat"></button><button type="button" id="compose-effort" class="compose-chip" data-action="compose-effort" title="Reasoning effort for this chat" hidden></button><span id="compose-hint"></span></div><button type="button" id="stop-button" class="stop-button" data-action="stop" title="Stop this turn" hidden><span>&#9632;</span> Stop</button><button id="send-button" type="submit" class="send-button" title="Send message (Enter)" aria-label="Send message">&#8593;</button></div></form><p class="compose-caption"><span class="send-caption">${sendCaption()}</span> <span>&#183;</span> Conversations stay on this computer</p></div>`;
      closePicker();
      if(!String(renderKey).startsWith(`["${a.id}"`))enter($('#content'));
      renderKey=JSON.stringify([a.id,title(a),a.description,a.icon,a.provider,location(a),state.activeConversationId]);$('#message-input').value=drafts.get(draftKey())??state.drafts?.[draftKey()]??'';
      $('#message-input').addEventListener('input',event=>{drafts.set(draftKey(),event.target.value);if(api.saveDraft)save(api.saveDraft({agentId:a.id,conversationId:currentConversation()?.id||'',text:event.target.value}));event.target.style.height='auto';event.target.style.height=Math.min(event.target.scrollHeight,190)+'px';updateSlash();});
      $('#message-input').addEventListener('blur',()=>setTimeout(closeSlash,120));
      $('#message-input').addEventListener('paste',event=>{const files=[...(event.clipboardData?.files||[])];if(files.length){event.preventDefault();addDroppedFiles(files);}});
      const area=$('.compose-area');area.addEventListener('dragover',event=>{if(![...(event.dataTransfer?.types||[])].includes('Files'))return;event.preventDefault();area.classList.add('drop-target');});
      area.addEventListener('dragleave',event=>{if(!area.contains(event.relatedTarget))area.classList.remove('drop-target');});
      area.addEventListener('drop',event=>{area.classList.remove('drop-target');const files=[...(event.dataTransfer?.files||[])];if(!files.length)return;event.preventDefault();addDroppedFiles(files);});
      $('#message-input').addEventListener('keydown',event=>{if(slashKey(event))return;if(sendKeyPressed(event)){event.preventDefault();sendMessage();}});
      $('#message-form').addEventListener('submit',event=>{event.preventDefault();sendMessage();});
      $('#conversation-picker').addEventListener('change',event=>action(()=>api.selectConversation({id:event.target.value})));
    }
    const convs=state.conversations.filter(c=>c.agentId===a.id).slice().reverse();
    $('#conversation-picker').innerHTML=convs.length?convs.map(c=>`<option value="${esc(c.id)}" ${c.id===state.activeConversationId?'selected':''}>${esc(chatLabel(c))}</option>`).join(''):'<option>New conversation</option>';
    const connect=$('#connect-button');connect.textContent=a.status==='connected'?'Disconnect':a.status==='connecting'?'Connecting...':'Connect';connect.disabled=a.status==='connecting';
    $('#connection-banner').innerHTML=a.error?`<div class="inline-notice error-notice"><span>!</span><div><strong>Connection needs attention</strong><p>${esc(a.error)}</p><div class="notice-actions"><button type="button" class="primary small" data-action="agent-run" data-key="fix" data-id="${esc(a.id)}" title="The Opaya Agent checks it end to end and repairs what it can">Let the Opaya Agent fix it</button><button type="button" class="secondary small" data-action="agent-run" data-key="restart" data-id="${esc(a.id)}">Try again</button><button class="text-button" data-action="edit" data-id="${esc(a.id)}">Edit connection</button><button class="text-button" data-action="terminal">Open terminal</button><button class="text-button" data-action="clear-error" data-id="${esc(a.id)}">Clear error</button></div></div></div>`:a.protocol==='terminal'?'<div class="inline-notice"><span>&gt;_</span><p>This is a terminal-only agent. Use its native CLI in the integrated terminal.</p></div>':a.status==='disconnected'?'<div class="inline-notice"><span class="local-icon"></span><p>This agent is not connected. Your saved conversations are still here.</p><button type="button" class="primary small" data-action="connect">Connect</button></div>':'';
    const c=currentConversation(),messages=c?state.histories[c.id]||[]:[],now=performance.now(),conversationKey=`${a.id}/${c?.id||''}`;
    // Existing history appears at once; only messages that arrive while this conversation is open animate in.
    if(messageConversation!==conversationKey){const continuing=messageConversation===`${a.id}/`;messageSeen.clear();messageConversation=conversationKey;if(!continuing)messages.forEach((m,i)=>messageSeen.set(m.id||i,-1e9));}
    const list=$('#message-list'),changed=list.dataset.conversation!==conversationKey,previous=chatScroll.get(conversationKey),atBottom=list.scrollHeight-list.scrollTop-list.clientHeight<110;list.dataset.conversation=conversationKey;
    list.innerHTML=messages.length?messages.map((m,i)=>`<article class="message ${m.role==='user'?'user-message':'assistant-message'} ${fresh(messageSeen,m.id||i,now,450)?'message-enter':''}"><div class="message-avatar ${m.role==='user'?'you-avatar':esc(a.provider)}">${m.role==='user'?'S':agentIcon(a)}</div><div class="message-body"><div class="message-meta"><strong>${m.role==='user'?'You':esc(title(a))}</strong><time>${esc(new Date(m.createdAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}))}</time>${m.status==='streaming'?'<span class="stream-label"><span class="status-dot working"></span> Working</span>':''}</div>${activityMarkup(m,20,a.id)}<div class="message-text">${format(m.content)}${m.status==='streaming'&&!m.content?'<div class="thinking-dots"><i></i><i></i><i></i></div>':''}</div>${m.role!=='user'&&m.status!=='streaming'?agentFiles(m.content,a):''}${m.attachments?.length?`<div class="message-files">${m.attachments.map(f=>`<span class="file-chip ${esc(f.kind||'file')}" title="${esc(f.name)}"><span class="file-chip-icon" aria-hidden="true">${fileIcon(f)}</span><span class="file-chip-name">${esc(f.name)}</span><small>${esc(fmtSize(f.size||0))}</small></span>`).join('')}</div>`:''}${m.error?`<div class="message-error">${esc(m.error)}${KEY_ERROR.test(m.error)?' <button type="button" class="text-button" data-action="compose-secret">Give it a key</button>':''}</div>`:''}</div></article>`).join(''):`<div class="chat-empty">${badge(a,true)}<h2>A direct line to ${esc(title(a))}.</h2><p>${a.transport==='ssh'?'The agent runs on your remote machine. Opaya is the window into it.':'Your agent stays on your computer. Opaya brings the conversation together.'}</p><div class="starter-prompts"><button data-action="starter" data-text="What can you help me with, and which tools do you have?">What can you help me with? <span>&#8599;</span></button><button data-action="starter" data-text="Tell me about your current workspace. Please only inspect it; do not change anything.">Get to know this workspace <span>&#8599;</span></button></div><span class="chat-empty-note">${a.status==='connected'?'Connected and ready for your first message.':'Connect above when you are ready.'}</span></div>`;
    if(changed&&previous&&!previous.bottom)list.scrollTop=previous.top;else if(atBottom||changed||!messages.length)list.scrollTop=list.scrollHeight;
    $('#send-button').disabled=a.status!=='connected'||a.busy||a.protocol==='terminal'||pendingSends.has(a.id);$('#send-button').hidden=!!a.busy;$('#stop-button').hidden=!a.busy;
    $('#compose-hint').textContent=a.busy?'Agent is working':a.status==='connected'?'':'Connect to start chatting';
    renderCompose(a);
  }
  // Enter sends (Shift+Enter is a new line), or with the setting, Ctrl/Cmd+Enter sends and Enter is a new line.
  const sendCaption=()=>state.settings?.sendKey==='mod-enter'?`${state.platform==='darwin'?'&#8984;':'Ctrl + '}Enter to send <span>&#183;</span> Enter for a new line`:'Enter to send <span>&#183;</span> Shift + Enter for a new line';
  const sendKeyPressed=event=>event.key==='Enter'&&!event.isComposing&&(state.settings?.sendKey==='mod-enter'?(event.ctrlKey||event.metaKey):!event.shiftKey&&!event.ctrlKey&&!event.metaKey);
  async function sendMessage() {
    const a=selected(),input=$('#message-input'),key=draftKey(),files=composeFiles.get(key)||[];if(!a||!input||!input.value.trim()&&!files.length||pendingSends.has(a.id))return;
    if(a.status!=='connected'){toast('Connect this agent before sending a message.',true);return;}
    const text=input.value;pendingSends.add(a.id);$('#send-button').disabled=true;
    try{await api.send({agentId:a.id,conversationId:currentConversation()?.id||'',text,...(files.length?{attachments:files.map(f=>f.path?{path:f.path}:{name:f.name,mime:f.mime,data:f.data})}:{})});drafts.set(key,'');composeFiles.delete(key);if(selected()?.id===a.id){input.value='';input.style.height='auto';}}
    catch(error){toast(error.message,true);}finally{pendingSends.delete(a.id);render();}
  }
  // ---- Composer: attachments, model and reasoning effort for this chat ------------------------------------------
  const composeFiles=new Map(),modelLists=new Map(),MAX_FILES=10,MAX_FILE=20*1024*1024;
  const EFFORT_LABELS={minimal:'Minimal',low:'Low',medium:'Medium',high:'High',xhigh:'Extra high',max:'Max'};
  const fileKind=f=>/^image\//.test(f.mime||'')?'image':/^text\/|json|xml|yaml|javascript|csv|markdown/.test(f.mime||'')?'text':'file';
  const fileIcon=f=>(f.kind||fileKind(f))==='image'?'&#9635;':(f.kind||fileKind(f))==='text'?'&#9776;':'&#128196;';
  function addFiles(list){
    const key=draftKey(),have=composeFiles.get(key)||[],next=[...have];
    for(const f of list){
      if(next.length>=MAX_FILES){toast(`Up to ${MAX_FILES} files per message.`,true);break;}
      if(f.size>MAX_FILE){toast(`${f.name} is larger than 20 MB.`,true);continue;}
      if(f.path&&next.some(x=>x.path===f.path))continue;
      next.push({...f,kind:fileKind(f)});
    }
    composeFiles.set(key,next);renderComposeFiles();$('#message-input')?.focus();
  }
  // Dropped or pasted files: ones on disk go by path; a pasted screenshot has no path, so its bytes go along.
  async function addDroppedFiles(files){
    const withPath=[],inline=[];
    for(const f of files){let p='';try{p=api.pathForFile?.(f)||'';}catch{}if(p)withPath.push(p);else inline.push(f);}
    const out=[];
    if(withPath.length){try{out.push(...await api.fileInfo({paths:withPath}));}catch(error){toast(error.message,true);}}
    for(const f of inline){
      if(f.size>MAX_FILE){toast(`${f.name||'The pasted file'} is larger than 20 MB.`,true);continue;}
      const data=await new Promise(resolve=>{const r=new FileReader();r.onload=()=>resolve(String(r.result).replace(/^data:[^,]*,/,''));r.onerror=()=>resolve('');r.readAsDataURL(f);});
      if(data)out.push({name:f.name&&f.name!=='image.png'?f.name:`screenshot-${new Date().toISOString().slice(11,19).replace(/:/g,'')}.${(f.type.split('/')[1]||'png').replace('jpeg','jpg')}`,mime:f.type||'application/octet-stream',size:f.size,data});
    }
    if(out.length)addFiles(out);
  }
  function renderComposeFiles(){
    const box=$('#compose-files');if(!box)return;const files=composeFiles.get(draftKey())||[];
    box.hidden=!files.length;
    box.innerHTML=files.map((f,i)=>`<span class="file-chip ${esc(f.kind)}" title="${esc(f.path||f.name)}">${f.kind==='image'&&f.data?`<img src="data:${esc(f.mime)};base64,${f.data}" alt="">`:`<span class="file-chip-icon" aria-hidden="true">${fileIcon(f)}</span>`}<span class="file-chip-name">${esc(f.name)}</span><small>${esc(fmtSize(f.size||0))}</small><button type="button" class="file-chip-remove" data-action="compose-unattach" data-index="${i}" title="Remove ${esc(f.name)}" aria-label="Remove ${esc(f.name)}">&#10005;</button></span>`).join('');
  }
  function renderCompose(a){
    const c=currentConversation(),chatModel=c?.model||'',model=chatModel||a.model||'',m=$('#compose-model'),e=$('#compose-effort');
    if(m){m.hidden=a.protocol==='terminal';const html=`<span class="chip-glyph" aria-hidden="true">&#9672;</span><span class="chip-label">${esc(modelText(model)||'Agent\'s model')}</span>${chatModel?'<em>this chat</em>':''}<span class="chip-caret" aria-hidden="true">&#9662;</span>`;if(m.dataset.html!==html){m.innerHTML=html;m.dataset.html=html;}m.disabled=!!a.busy;}
    const levels=Array.isArray(a.efforts)?a.efforts:[],effort=c?.effort||a.effort||'';
    if(e){e.hidden=!levels.length;const html=`<span class="chip-glyph" aria-hidden="true">&#9889;</span><span class="chip-label">${esc(effort?EFFORT_LABELS[effort]||effort:'Effort: auto')}</span><span class="chip-caret" aria-hidden="true">&#9662;</span>`;if(e.dataset.html!==html){e.innerHTML=html;e.dataset.html=html;}e.disabled=!!a.busy;}
    const box=$('#compose-files');if(box&&box.dataset.key!==draftKey()){box.dataset.key=draftKey();renderComposeFiles();}
    const send=$('#send-button');if(send&&(composeFiles.get(draftKey())||[]).length&&!a.busy&&a.status==='connected'&&!pendingSends.has(a.id))send.disabled=false;
    const cap=$('.send-caption'),text=sendCaption();if(cap&&cap.dataset.text!==text){cap.innerHTML=text;cap.dataset.text=text;}
  }
  // A chat model or effort belongs to a chat: a new agent view without one gets its chat first.
  async function chatFor(a){const c=currentConversation();if(c&&c.agentId===a.id)return c;const created=await api.newConversation({agentId:a.id});await refresh();return created;}
  // A model id some agents send as a JSON pair (DeepSeek Harness: ["deepseek-official","deepseek-v4-flash"]) reads as its model.
  const modelText=m=>{const v=String(m||'');if(!v.startsWith('['))return v;try{const x=JSON.parse(v);return Array.isArray(x)&&x.length?`${x.at(-1)}${x.length>1?` (${x.slice(0,-1).join(' / ')})`:''}`:v;}catch{return v;}};
  async function openModelPicker(button){
    const a=selected();if(!a)return;const c=currentConversation(),current=c?.model||'';
    const show=list=>openPicker(button,{title:`${title(a)} model`,items:[{value:'',label:`Agent default: ${a.model?modelText(a.model):a.activeModel?`${modelText(a.activeModel)} (its own setting)`:'its own setting'}`},...list.map(m=>({value:m,label:modelText(m)}))],current,search:list.length>10,
      footer:[{label:'Make it the default for new chats',run:async()=>{const pick=currentConversation()?.model;if(!pick){toast('Choose a model for this chat first.');return;}await api.selectModel({id:a.id,model:pick,scope:'default'});await refresh();toast(`${modelText(pick)} is now ${title(a)}'s default model.`);}},{label:'Refresh models',run:async()=>{modelLists.delete(a.id);await openModelPicker(button);}}],
      pick:async value=>{const chat=await chatFor(a);await api.selectModel({id:a.id,model:value,scope:'conversation',conversationId:chat.id});await refresh();toast(value?`${modelText(value)} for this chat.`:'This chat uses the agent default.');}});
    if(modelLists.has(a.id)){show(modelLists.get(a.id));return;}
    openPicker(button,{title:`${title(a)} model`,items:[],loading:`Asking ${title(a)} for its models...`});
    try{const r=await api.agentModels({id:a.id});const list=[...new Set([...(r.models||[]),a.model,c?.model].filter(Boolean))];modelLists.set(a.id,list);if(pickerFor===button)show(list);}
    catch(error){if(pickerFor===button)openPicker(button,{title:`${title(a)} model`,items:[],loading:error.message});}
  }
  function openEffortPicker(button){
    const a=selected();if(!a)return;const c=currentConversation(),levels=a.efforts||[];
    openPicker(button,{title:'Reasoning effort',items:[{value:'',label:`Auto${a.effort?`: agent default (${EFFORT_LABELS[a.effort]||a.effort})`:' (the model decides)'}`},...levels.map(l=>({value:l,label:EFFORT_LABELS[l]||l}))],current:c?.effort||'',
      note:'Higher effort thinks longer: better on hard tasks, slower and more tokens.',
      footer:[{label:'Make it the default for new chats',run:async()=>{const pick=currentConversation()?.effort;if(!pick){toast('Choose an effort for this chat first.');return;}await api.selectEffort({id:a.id,effort:pick,scope:'default'});await refresh();toast(`${EFFORT_LABELS[pick]||pick} effort is now ${title(a)}'s default.`);}}],
      pick:async value=>{const chat=await chatFor(a);await api.selectEffort({id:a.id,effort:value,scope:'conversation',conversationId:chat.id});await refresh();toast(value?`${EFFORT_LABELS[value]||value} effort for this chat.`:'This chat uses the agent default effort.');}});
  }
  // Manage > Model & reasoning: the effort new chats of this agent start with.
  function openDefaultEffort(a){
    const button=document.querySelector('[data-action="manage-run"][data-key="effort"]');if(!button)return;
    openPicker(button,{title:`${title(a)}: default effort`,items:[{value:'',label:'Auto (the model decides)'},...a.efforts.map(l=>({value:l,label:EFFORT_LABELS[l]||l}))],current:a.effort||'',
      note:'New chats start with this. Each chat can change it under its message box.',
      pick:async value=>{await api.selectEffort({id:a.id,effort:value,scope:'default'});await refresh();toast(value?`New ${title(a)} chats use ${EFFORT_LABELS[value]||value} effort.`:`New ${title(a)} chats let the model decide the effort.`);}});
  }
  // A small list that opens from a button: optional search, a check on the current value, extra actions below.
  let pickerFor=null;
  function closePicker(){$('#picker')?.remove();pickerFor?.classList.remove('menu-open');pickerFor=null;document.removeEventListener('pointerdown',pickerOutside,true);}
  const pickerOutside=event=>{if(!event.target.closest('#picker')&&!event.target.closest('.compose-chip'))closePicker();};
  function openPicker(button,{title:heading,items,current='',search=false,loading='',note='',footer=[],pick}){
    $('#picker')?.remove();pickerFor=button;button.classList.add('menu-open');
    const el=document.createElement('div');el.id='picker';el.className='picker';el.setAttribute('role','dialog');el.setAttribute('aria-label',heading);
    el.innerHTML=`<div class="picker-head">${esc(heading)}</div>${search?'<input class="picker-search" placeholder="Search" aria-label="Search" autocomplete="off" spellcheck="false">':''}<div class="picker-list" role="listbox">${loading?`<p class="picker-empty">${esc(loading)}</p>`:''}</div>${note?`<p class="picker-note">${esc(note)}</p>`:''}${footer.length&&!loading?`<div class="picker-foot">${footer.map((f,i)=>`<button type="button" data-foot="${i}">${esc(f.label)}</button>`).join('')}</div>`:''}`;
    document.body.append(el);
    const list=$('.picker-list',el),fill=q=>{const t=q.trim().toLowerCase(),shown=items.filter(x=>!t||x.label.toLowerCase().includes(t)||x.value.toLowerCase().includes(t)).slice(0,200);list.innerHTML=loading?list.innerHTML:shown.length?shown.map(x=>`<button type="button" role="option" aria-selected="${x.value===current}" data-value="${esc(x.value)}" class="${x.value===current?'current':''}"><span class="picker-check" aria-hidden="true">${x.value===current?'&#10003;':''}</span><span>${esc(x.label)}</span></button>`).join(''):'<p class="picker-empty">Nothing matches.</p>';};
    fill('');
    const r=button.getBoundingClientRect(),w=Math.max(260,el.offsetWidth),h=el.offsetHeight;el.style.left=Math.max(8,Math.min(r.left,innerWidth-w-8))+'px';el.style.top=(r.top-h-6>=8?r.top-h-6:Math.max(8,Math.min(r.bottom+6,innerHeight-h-8)))+'px';
    const input=$('.picker-search',el);if(input){input.addEventListener('input',()=>fill(input.value));input.focus();}else $('.picker-list button',el)?.focus();
    el.addEventListener('click',event=>{const b=event.target.closest('[data-value]');if(b&&pick){closePicker();action(()=>pick(b.dataset.value));return;}const f=event.target.closest('[data-foot]');if(f){closePicker();action(()=>footer[Number(f.dataset.foot)].run());}});
    el.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closePicker();button.focus();}else if(['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();const all=[...el.querySelectorAll('.picker-list button')],at=all.indexOf(document.activeElement);all[(at+(event.key==='ArrowDown'?1:-1)+all.length)%all.length]?.focus();}else if(event.key==='Enter'&&document.activeElement===input){event.preventDefault();$('.picker-list button',el)?.click();}});
    setTimeout(()=>document.addEventListener('pointerdown',pickerOutside,true));
  }
  function modal(title,subtitle,body,wide=false) {
    returnFocus=document.activeElement;
    $('#modal-root').innerHTML=`<dialog class="modal ${wide?'wide':''}" id="app-dialog"><div class="modal-header"><div><h2>${esc(title)}</h2><p>${esc(subtitle)}</p></div><button class="icon-button" data-action="modal-close" aria-label="Close dialog">&#10005;</button></div><div class="modal-body">${body}</div></dialog>`;
    const d=$('#app-dialog');d.addEventListener('cancel',event=>{if(modalBusy)event.preventDefault();else closeModal();});d.showModal();
    // A click on the dimmed page around the dialog closes it, like Esc. While it works, or once something was typed into
    // it, the dialog only nudges, so a stray click never throws away a key or a form.
    const outside=e=>{const r=d.getBoundingClientRect();return e.target===d&&(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom);};let downOutside=false;
    d.addEventListener('pointerdown',e=>{downOutside=outside(e);});
    d.addEventListener('click',e=>{if(!downOutside||!outside(e))return;downOutside=false;
      if(modalBusy||d.dataset.typed){d.classList.remove('nudge');void d.offsetWidth;d.classList.add('nudge');if(!modalBusy)toast('Close with ✕ or Esc to leave what you typed.');return;}closeModal();});
    d.addEventListener('input',e=>{if(e.target.matches('textarea,select,input:not([type=search]):not([type=checkbox]):not([type=radio]):not([type=range])'))d.dataset.typed='1';});
  }
  function closeModal(){if(modalBusy)return;$('#app-dialog')?.close();$('#modal-root').innerHTML='';const back=returnFocus?.isConnected?returnFocus:returnFocus?.id==='message-input'?$('#message-input'):null;if(back&&!back.disabled)back.focus?.();}
  function openAdd(){
    modal('Bring your agents together.','Choose where to look. Nothing connects until you approve it.',`<div class="connect-options"><button data-action="discover"><span class="option-symbol"><span class="radar-icon"></span></span><strong>Discover this computer</strong><p>Find Hermes profiles, Codex, Claude Code and local gateways.</p><small>Recommended to get started &#8594;</small></button><button data-action="hosts"><span class="option-symbol"><span class="machine-icon"></span></span><strong>Connect a remote machine</strong><p>Use your saved SSH config, key files or ssh-agent. No public API ports.</p><small>VPS, server or remote computer &#8594;</small></button><button data-action="install-catalog"><span class="option-symbol install-glyph">&#8595;</span><strong>Install a new agent</strong><p>One click installs Hermes, Claude Code, Codex, OpenClaw and more, here or on a VPS.</p><small>Local or remote &#8594;</small></button><button data-action="manual"><span class="option-symbol">+</span><strong>Add a connection manually</strong><p>Choose an agent preset, API endpoint, ACP command or native terminal.</p><small>For custom installations &#8594;</small></button></div><div class="modal-note"><span class="status-dot connected"></span> No Opaya account. No third-party routing. Your provider login stays where the agent runs.</div>`,true);
  }
  const LIB_ICONS=new Set(['opencode','deepseek','goose','ollama','openclaw','codex','claude','hermes-agent']);
  async function discover(hostId,extraHome){
    const host=state.hosts.find(h=>h.id===hostId);
    const tabs=`<div class="segmented discover-tabs" role="tablist"><button type="button" role="tab" class="${!host?'selected':''}" data-action="discover-tab" data-id="">This computer</button>${state.hosts.map(h=>`<button type="button" role="tab" class="${host?.id===h.id?'selected':''}" data-action="discover-tab" data-id="${esc(h.id)}">${esc(h.name)}</button>`).join('')}<button type="button" class="discover-add-vps" data-action="new-vps">+ New VPS</button></div>`;
    modal('Discover agents',host?`Read-only check of ${host.name} over SSH.`:'Read-only check of this computer: known install folders, CLI tools and loopback API ports.',`${tabs}<div class="scan-progress"><span class="radar-icon"></span><h3>${host?`Looking on ${esc(host.name)}`:'Looking on this computer'}</h3><p>No subnet scanning. Nothing is installed or restarted.</p></div>`,true);
    modalBusy=true;
    try{
      const result=await api.discover({hostId,extraHome});modalBusy=false;
      const items=result.agents||[];window.__discovered=items;
      const fresh=items.map((a,i)=>({a,i})).filter(x=>!x.a.existingId),added=items.map((a,i)=>({a,i})).filter(x=>x.a.existingId);
      // Frameworks from the catalog that were not found on this machine.
      const found=new Set(items.flatMap(a=>[a.provider,String(a.command||'').split(/[\\/]/).pop().replace(/\.(exe|cmd)$/i,'')]));
      const missing=(state.frameworks||[]).filter(f=>f.kind==='agent'&&!f.runtime&&(host?f.remote:f.local)&&!found.has(f.provider==='custom'?f.command:f.provider)&&!found.has(f.id)&&!toolFor(host?.id,f.id));
      const row=({a,i})=>`<div class="discovery-row">${badge(a)}<div><strong>${esc(a.name)}</strong><p>${esc(a.detail)}</p><div class="discovery-meta">${meta(a)}</div><code>${esc(a.hermesHome||a.endpoint||a.command)}</code></div><span class="discovery-state">${esc(a.readiness)}</span><button class="${a.existingId?'subtle':'primary'}" data-action="discovered-add" data-index="${i}">${a.existingId?'Open':'Add'}</button></div>`;
      modal('Discover agents',result.scope||(host?`Agents on ${host.name}`:'Agents on this computer'),`${tabs}
        <section class="discover-group"><h3><span class="discover-dot new"></span>Found, not in Opaya yet <small>${fresh.length}</small></h3>${fresh.length?`<div class="discovery-results">${fresh.map(row).join('')}</div>`:`<p class="field-help">${added.length?'Every agent found here is already in Opaya.':'No agents found in the standard locations. Your agent may be in a custom folder, a container or WSL: add it manually.'}</p>`}</section>
        ${missing.length?`<section class="discover-group"><h3><span class="discover-dot missing"></span>Not installed ${host?`on ${esc(host.name)}`:'here'} <small>${missing.length}</small></h3><div class="discover-missing">${missing.map(f=>`<div class="missing-card">${badge({provider:f.provider,avatar:f.provider==='custom'&&LIB_ICONS.has(f.icon)?'lib:'+f.icon:''})}<div><strong>${esc(f.name)}</strong><small>${esc(f.description)}</small></div><button type="button" class="secondary small" data-action="discover-install" data-fw="${esc(f.id)}" data-host="${esc(host?.id||'')}">Install</button></div>`).join('')}</div></section>`:''}
        ${added.length?`<details class="discover-group discover-added"><summary><span class="discover-dot added"></span>Already in Opaya <small>${added.length}</small></summary><div class="discovery-results">${added.map(row).join('')}</div></details>`:''}
        ${result.warnings?.length?`<details class="discovery-warnings"><summary>Discovery notes (${result.warnings.length})</summary>${result.warnings.map(w=>`<p>${esc(w)}</p>`).join('')}</details>`:''}
        <div class="modal-footer"><span>${esc(result.machine?.hostname||'')}</span><div>${!host?'<button class="subtle" data-action="scan-folder">Scan another Hermes home</button>':''}<button class="secondary" data-action="manual">Add manually</button></div></div>`,true);
    }catch(error){modalBusy=false;modal('Discovery needs attention','No changes were made to your agents.',`${tabs}<div class="inline-notice error-notice"><p>${esc(error.message)}</p></div><div class="modal-footer"><button class="secondary" data-action="${host?'host-terminal':'manual'}" ${host?`data-id="${esc(host.id)}"`:''}>${host?'Open SSH terminal':'Add manually'}</button><button class="subtle" data-action="help">Connection help</button></div>`,true);}
  }
  function inputField(name,label,value='',placeholder='',extra='') {return `<label class="field"><span>${label}</span><input name="${name}" value="${esc(value)}" placeholder="${esc(placeholder)}" ${extra}></label>`;}
  function openAgentForm(input={}) {
    const a={provider:'hermes',protocol:'openai',transport:'http',name:'',endpoint:'http://127.0.0.1:8642/v1',model:'hermes-agent',command:'hermes',args:[],...input};
    const options=(values,current)=>values.map(([id,label])=>`<option value="${id}" ${id===current?'selected':''}>${label}</option>`).join('');
    const providerEntries=Object.entries(state.providerPresets||{}).map(([id,p])=>[id,p.label||labels[id]||id]);if(!providerEntries.length)providerEntries.push(...Object.entries(labels));
    const modelOptions=(provider,current)=>{const known=state.providerPresets?.[provider]?.models||[],all=[...new Set([current,...known].filter(Boolean))];return `<option value="">${all.length?'Use provider default':'Connect, then choose from Models'}</option>`+all.map(m=>`<option value="${esc(m)}" ${m===current?'selected':''}>${esc(m)}</option>`).join('');};
    modal(a.id?'Connection settings':'Add an agent',a.id?'Rename it in Opaya, add notes, or change where this connection runs.':'A name, a connection, and you are in.',`<form id="agent-form" data-id="${esc(a.id||'')}"><div class="form-grid">${inputField('name','Connection name',a.name,'e.g. Hermes / Research','required maxlength="80"')}${inputField('displayName','Display name in Opaya',a.displayName,'Leave empty to use connection name','maxlength="80"')}${inputField('description','Description',a.description,'e.g. Lead gen on Hostinger','maxlength="500"')}${inputField('icon','Text icon',a.icon,'Optional, e.g. HC or *','maxlength="16"')}${inputField('group','Group',a.group,'Optional, e.g. Clients','maxlength="40"')}${inputField('tags','Tags',(a.tags||[]).join(', '),'Comma separated, e.g. prod, coding','')}<label class="field"><span>Agent / API provider</span><select name="provider">${options(providerEntries,a.provider)}</select></label><label class="field"><span>Connection protocol</span><select name="protocol">${options([['openai','Gateway / OpenAI-compatible API'],['codex','Codex app server'],['claude','Claude Code (streamed CLI)'],['acp','Agent Client Protocol (ACP)'],['terminal','Native terminal only']],a.protocol)}</select></label><label class="field"><span>Where it runs</span><select name="transport">${options([['http','Direct API (local or HTTPS)'],['local','Local executable'],['ssh','Remote machine over SSH']],a.transport)}</select></label></div>${a.id?`<p class="field-help"><button type="button" class="text-button" data-action="icon-picker" data-id="${esc(a.id)}">Choose an icon from the library or upload one &#8594;</button></p>`:''}<p class="field-help">Display name, description and custom icon are only for Opaya. They do not rename the real agent, container, profile or CLI.</p><div data-field="ssh"><label class="field"><span>Remote machine</span><select name="hostId"><option value="">Select a saved SSH host</option>${state.hosts.map(h=>`<option value="${esc(h.id)}" ${a.hostId===h.id?'selected':''}>${esc(h.name)} (${esc(h.alias||h.hostname)})</option>`).join('')}</select></label><p class="field-help">The endpoint below is on the remote host. Opaya creates a loopback-only SSH tunnel. Add machines from the sidebar first.</p></div><div data-field="api">${inputField('endpoint','API base URL',a.endpoint,'http://127.0.0.1:8642/v1')}<p class="field-help">The provider fills its official base URL. Use Models after connecting to refresh the live catalog.</p><div class="form-grid"><label class="field"><span>Model / agent ID</span><select name="model">${modelOptions(a.provider,a.model)}</select></label><label class="field"><span>Gateway API token ${a.hasToken?'<em>stored securely</em>':''}</span><input name="token" type="password" autocomplete="new-password" placeholder="${a.hasToken?'Leave empty to keep the saved token':'Only if the gateway requires one'}"></label></div><label class="check-row"><input type="checkbox" name="remember" ${state.secureStorage?'checked':''}> Remember token with OS encryption <small>${state.secureStorage?'Protected by your OS keychain':'Unavailable here: keep tokens in memory only'}</small></label><label class="check-row" data-field="hermes-import"><input type="checkbox" name="importToken" ${(a.hermesHome||a.provider==='openclaw'&&a.command==='docker')&&!a.hasToken?'checked':''}> Import the gateway token (Hermes API_SERVER_KEY, or OpenClaw's gateway token) <small>A native confirmation is required. Provider keys are never imported.</small></label></div><div data-field="command"><div class="path-field">${inputField('command','Executable',a.command,'hermes, codex, claude or an absolute path')}<button type="button" class="secondary" data-action="pick" data-kind="executable" data-field-name="command" title="Choose a local executable">Browse</button></div>${inputField('args','Arguments (JSON array)',JSON.stringify(a.args||[]),'[]')}<p class="field-help">No shell interpolation. Hermes adds acp; Codex adds app-server. For a custom ACP Docker agent, use docker with ["exec","-i","container","hermes","acp"].</p></div><details class="advanced-fields" ${a.hermesHome?'open':''}><summary>Workspace, profile & advanced</summary><div class="path-field">${inputField('cwd','Working directory',a.cwd,'Absolute path on the selected machine')}<button type="button" class="secondary" data-action="pick" data-kind="directory" data-field-name="cwd">Browse</button></div><div data-field="hermes">${inputField('hermesHome','Hermes profile home',a.hermesHome,'e.g. /home/ubuntu/.hermes/profiles/research')}<p class="field-help">Existing gateway API is recommended for running agents. ACP creates a separate process; never point two writers at the same active profile.</p></div>${inputField('note','Connection note',a.note,'Optional technical context for this connection')}<label class="check-row"><input type="checkbox" name="pinned" ${a.pinned?'checked':''}> Pin to the top of the sidebar</label></details><div class="inline-notice" data-field="claude"><p>Claude keeps its CLI login and native permission defaults. When a headless tool is denied, use Run CLI in Terminal to approve it interactively.</p></div><div class="inline-notice" data-field="acp"><p>Only use trusted agent executables. ACP tool requests are shown in native approval dialogs and are denied by default. This does not sandbox the agent's own process.</p></div><div class="modal-footer"><div>${a.id?`<button type="button" class="danger-text" data-action="remove" data-id="${esc(a.id)}">Delete connection</button>`:'<span>Stored only on this computer.</span>'}</div><div><button type="submit" class="secondary" value="save">Save connection</button><button type="submit" class="primary" value="connect">Save & connect &#8594;</button></div></div></form>`,true);
    const form=$('#agent-form');
    form.elements.token.addEventListener('input',()=>{if(form.elements.token.value)form.elements.importToken.checked=false;});
    function sync(){const p=form.elements.protocol.value,t=form.elements.transport.value,v=form.elements.provider.value;for(const node of form.querySelectorAll('[data-field]')){const f=node.dataset.field;node.hidden=!(f==='ssh'?t==='ssh':f==='api'?p==='openai':f==='command'?p!=='openai':f==='hermes'?v==='hermes':f==='hermes-import'?(v==='hermes'||v==='openclaw')&&p==='openai':f==='claude'?p==='claude':f==='acp'?p==='acp':true);}for(const button of form.querySelectorAll('[data-action="pick"]'))button.hidden=t==='ssh';}
    form.elements.provider.addEventListener('change',()=>{const p=form.elements.provider.value,preset=state.providerPresets?.[p]||{};form.elements.command.value=preset.command||(['codex','claude'].includes(p)?p:'');form.elements.protocol.value=preset.protocol||'openai';if(form.elements.transport.value!=='ssh')form.elements.transport.value=preset.transport||'http';form.elements.endpoint.value=preset.endpoint||'';form.elements.model.innerHTML=modelOptions(p,preset.models?.[0]||'');sync();});
    form.elements.protocol.addEventListener('change',()=>{if(form.elements.transport.value!=='ssh')form.elements.transport.value=form.elements.protocol.value==='openai'?'http':'local';sync();});
    form.elements.transport.addEventListener('change',sync);sync();
    form.addEventListener('submit',async event=>{
      event.preventDefault();if(modalBusy)return;
      const values=Object.fromEntries(new FormData(form));
      let args;try{args=JSON.parse(values.args||'[]');}catch{toast('Arguments must be a JSON array, for example ["acp"].',true);return;}
      const agent={...a,...values,args,pinned:form.elements.pinned.checked};delete agent.token;delete agent.importToken;delete agent.remember;
      const token=values.token||undefined;
      modalBusy=true;for(const b of form.querySelectorAll('button[type="submit"]'))b.disabled=true;
      try{const saved=await api.saveAgent({agent,token,remember:form.elements.remember.checked,importToken:form.elements.importToken.checked&&['hermes','openclaw'].includes(values.provider)&&values.protocol==='openai'});modalBusy=false;overview=false;opayaView=false;playgroundView=false;closeModal();if(event.submitter?.value==='connect')await action(()=>api.connect({id:saved.id}));else toast('Connection saved.');render();}
      catch(error){modalBusy=false;for(const b of form.querySelectorAll('button[type="submit"]'))b.disabled=false;toast(error.message,true);}
    });
  }
  // ---- Machines: this computer and SSH servers, what runs on them and what can be done there -----------------------
  // A check result stays per machine while Opaya runs, so reopening Machines shows the last known state at once.
  const hostChecks=new Map();let hostFormOpen=false;
  const machineAgents=hostId=>state.agents.filter(a=>hostId?a.transport==='ssh'&&a.hostId===hostId:a.transport!=='ssh');
  const sshText=h=>h.alias?`ssh ${h.alias}`:`ssh ${h.port&&Number(h.port)!==22?`-p ${h.port} `:''}${h.username?h.username+'@':''}${h.hostname}`;
  async function testMachine(id){
    const h=state.hosts.find(x=>x.id===id);if(!h)return;if(hostChecks.get(id)?.state==='checking')return;
    hostChecks.set(id,{state:'checking'});if(fleetView&&overview)render();
    try{hostChecks.set(id,{state:'ok',result:await api.hostTest({hostId:id})});}catch(error){hostChecks.set(id,{state:'error',error:error.message});}
    if(fleetView&&overview)render();
  }
  async function testAllMachines(){const ids=state.hosts.map(h=>h.id);for(let i=0;i<ids.length;i+=4)await Promise.all(ids.slice(i,i+4).map(testMachine));}
  // Machines live on one screen, the Machines board. Adding a machine by its address, or editing one, is this form.
  function openHosts(edit={},{form=false}={}){
    if(!form&&!edit.id){openFleet();return;}
    hostFormOpen=true;
    modal(edit.id?`Edit ${edit.name||'machine'}`:'Add a machine by its address','An SSH address you already use: OpenSSH handles your keys, ssh-agent, jump hosts and host verification. For a brand new server, New VPS also creates its key.',`<div id="machines"><section class="machine-form" id="host-form-section"><form id="host-form">${inputField('address','Quick connect',edit.alias||'','user@server:22, ssh://user@server:2222, or saved-alias')}<p class="field-help">Paste your SSH address. Existing keys and ssh-agent stay on this computer. Or use the individual fields below.</p><div class="form-grid">${inputField('name','Display name',edit.name,'e.g. Hetzner / Production')}${inputField('alias','Existing SSH config alias',edit.alias,'e.g. production')}</div><div class="field-divider">OR CONNECT DIRECTLY</div><div class="form-grid">${inputField('hostname','Hostname or IP',edit.hostname,'203.0.113.10')}${inputField('username','SSH username',edit.username,'ubuntu')}${inputField('port','SSH port',edit.port||22,'22','type="number" min="1" max="65535"')}<div class="path-field">${inputField('identityFile','SSH identity file (optional)',edit.identityFile,'Use ssh-agent / SSH config')}<button type="button" class="secondary" data-action="pick" data-kind="identityFile" data-field-name="identityFile">Browse</button></div></div><p class="field-help">A config alias takes precedence over hostname, username and port. Private keys are never uploaded or copied into Opaya. Encrypted keys should be unlocked in your OS ssh-agent.</p><div class="modal-footer"><span>Saving does not contact the server; Test connection does.</span><div><button type="button" class="secondary" data-action="modal-close">Cancel</button><button type="submit" class="primary">${edit.id?'Update machine':'Save machine'}</button></div></div></form></section></div>`);
    const f=$('#host-form');if(f){f.addEventListener('submit',async event=>{event.preventDefault();await action(async()=>{const saved=await api.saveHost({...edit,...Object.fromEntries(new FormData(event.target))});state=await api.snapshot();closeModal();openFleet(saved?.id);toast('Machine saved. Testing the connection...');if(saved?.id)testMachine(saved.id);});});f.elements[edit.id?'name':'address']?.focus();}
  }

  // This computer: its name in Opaya (sidebar, Machines, backups), a note, and where local backups go.
  function openLocalMachine(){
    const st=state.settings||{};
    modal('This computer',`${state.machine?.hostname||''} / ${({win32:'Windows',darwin:'macOS',linux:'Linux'}[state.platform]||state.platform||'')}`,`<form id="local-machine-form"><div class="form-grid">${inputField('machineName','Name in Opaya',st.machineName||'','This computer','maxlength="60"')}${inputField('machineNote','Note',st.machineNote||'','e.g. Office workstation','maxlength="200"')}</div><p class="field-help">Shown under every local agent in the sidebar, in Machines and in backups. Leave it empty to use "This computer". The system hostname (${esc(state.machine?.hostname||'')}) does not change.</p><div class="path-field">${inputField('backupDir','Backup folder',st.backupDir||'',state.machine?.home?`${state.machine.home}${state.platform==='win32'?'\\':'/'}Opaya Backups`:'Opaya Backups in your home folder')}<button type="button" class="secondary" data-action="pick" data-kind="directory" data-field-name="backupDir">Browse</button></div><p class="field-help">Where "Back up to this computer" saves agents, local or remote. Each agent gets its own subfolder.</p><div class="modal-footer"><button type="button" class="secondary" data-action="hosts">Back</button><button type="submit" class="primary">Save</button></div></form>`);
    $('#local-machine-form').addEventListener('submit',event=>{event.preventDefault();const f=event.target;action(async()=>{await api.saveSettings({machineName:f.elements.machineName.value,machineNote:f.elements.machineNote.value,backupDir:f.elements.backupDir.value});await refresh();backupLists.clear();openHosts();toast('This computer is saved.');});});
  }
  // ---- Docker manager: the containers and images on one machine, with start, stop, restart, logs, a shell and remove --
  // One look for the manager window (machine tabs, search, a state filter, live stats) and the agent's Machine & Docker
  // section: a card per container with its state, ports, CPU and memory, the agents in it and its controls, and an
  // images table that says which containers use each image.
  const dockerViews=new Map();
  const DK_PATHS={play:'<path d="M8 5v14l11-7z"/>',stop:'<rect x="6" y="6" width="12" height="12" rx="2"/>',restart:'<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>',pause:'<path d="M9 5v14M15 5v14"/>',logs:'<path d="M5 6h14M5 10h14M5 14h9M5 18h6"/>',shell:'<path d="m5 8 4 4-4 4M12 17h7"/>',inspect:'<circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5"/>',trash:'<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/>',pull:'<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',link:'<path d="M14 5h5v5M19 5l-8 8M17 14v5H5V7h5"/>',refresh:'<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>',box:'<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12 4 7.5"/>'};
  const dkIcon=k=>`<svg viewBox="0 0 24 24" aria-hidden="true">${DK_PATHS[k]||''}</svg>`;
  const imageRef=i=>i.repository&&i.repository!=='<none>'?`${i.repository}${i.tag&&i.tag!=='<none>'?':'+i.tag:''}`:i.id;
  // "0.0.0.0:8642->8642/tcp, :::8642->8642/tcp" -> one entry per published port; unpublished ones (8080/tcp) too.
  const portsOf=text=>{const seen=new Set(),out=[];for(const p of String(text||'').split(',').map(x=>x.trim()).filter(Boolean)){const m=/^(?:\[?([\d.:a-f]*)\]?:)?(\d+)->(\d+\/\w+)$/i.exec(p);const item=m?{host:m[1]||'',port:m[2],inside:m[3]}:{host:'',port:'',inside:p};const k=item.port+'|'+item.inside;if(!seen.has(k)){seen.add(k);out.push(item);}}return out.slice(0,6);};
  const bytes=t=>{const m=/([\d.]+)\s*([kKMGT]?i?B)/.exec(String(t||''));if(!m)return 0;const u={B:1,KB:1e3,kB:1e3,MB:1e6,GB:1e9,TB:1e12,KiB:1024,MiB:1048576,GiB:1073741824,TiB:1099511627776}[m[2]]||1;return Number(m[1])*u;};
  const dkSize=n=>n>=1e9?`${(n/1e9).toFixed(1)} GB`:n>=1e6?`${Math.round(n/1e6)} MB`:n>=1e3?`${Math.round(n/1e3)} kB`:`${n} B`;
  const STATE_LABEL={running:'Running',exited:'Stopped',paused:'Paused',restarting:'Restarting',created:'Created',dead:'Dead',removing:'Removing'};
  function dockerCard(key,c,{mine='',stats}={}){
    const s=stats?.by?.[c.name],on=c.state==='running',paused=c.state==='paused',agents=machineAgents(key==='local'?'':key).filter(x=>containerOf(x)===c.name),me=!!mine&&c.name===mine,v=dockerViews.get(key)||{},logs=v.logs?.name===c.name?v.logs:null;
    const b=(act,icon,label,attrs='',cls='')=>`<button type="button" class="dk-btn ${cls}" data-action="${act}" data-id="${esc(key)}" data-name="${esc(c.name)}" ${attrs} title="${esc(label)}" aria-label="${esc(label)} ${esc(c.name)}">${dkIcon(icon)}</button>`;
    const ports=portsOf(c.ports);
    return `<article class="dk-card ${esc(c.state)} ${me?'mine':''}" data-container="${esc(c.name)}">
      <header><span class="dk-light ${on?'on':paused?'paused':c.state==='restarting'?'busy':'off'}" aria-hidden="true"></span><div class="dk-id"><strong title="${esc(c.name)}">${esc(c.name)}</strong><small title="${esc(c.image)}">${esc(c.image)}</small></div>${me?'<em class="mg-badge">this agent</em>':''}<span class="dk-state ${esc(c.state)}">${esc(STATE_LABEL[c.state]||c.state)}</span></header>
      <p class="dk-status">${esc(c.status)}</p>
      ${ports.length?`<div class="dk-ports">${ports.map(p=>p.port&&key==='local'?`<button type="button" class="dk-port" data-action="docker-port" data-port="${esc(p.port)}" title="Open http://localhost:${esc(p.port)}">${dkIcon('link')}:${esc(p.port)} <span>&#8594; ${esc(p.inside)}</span></button>`:`<span class="dk-port">${p.port?`:${esc(p.port)} <span>&#8594; ${esc(p.inside)}</span>`:esc(p.inside)}</span>`).join('')}</div>`:''}
      ${on?`<div class="dk-gauges">${gauge('CPU',s?.cpu,s?.cpu)}${gauge('MEM',s?.memPercent,s?s.mem.split(' / ')[0]:'')}${s?`<div class="dk-io"><span title="Network in / out">NET ${esc(s.net||'')}</span><span title="Processes">${esc(s.pids||'0')} proc</span></div>`:''}</div>`:''}
      ${agents.length?`<div class="dk-agents">${agents.map(x=>`<button type="button" class="docker-agent" data-action="manage" data-id="${esc(x.id)}" title="Manage ${esc(title(x))}">${badge(x)}${esc(title(x))}</button>`).join('')}</div>`:''}
      <footer class="dk-actions">${on||paused?b('docker-do','stop','Stop','data-do="stop"','dk-power on'):b('docker-do','play','Start','data-do="start"','dk-power')}${on?b('docker-do','restart','Restart','data-do="restart"'):''}${on?b('docker-do','pause','Pause: freeze its processes','data-do="pause"'):paused?b('docker-do','play','Resume','data-do="unpause"'):''}<span class="dk-sep" aria-hidden="true"></span>${b('docker-logs','logs',logs?'Hide its log':'Show its last lines',`aria-expanded="${!!logs}"`,logs?'active':'')}${on?b('docker-terminal','shell','Shell inside it','data-kind="shell"'):''}${b('docker-inspect','inspect','Details: image, mounts, ports, restart policy')}<span class="dk-grow"></span>${b('docker-do','trash','Remove container','data-do="remove"','danger')}</footer>
      ${logs?`<div class="dk-logs"><div class="dk-logs-bar"><small>${logs.loading?'Reading...':logs.error?esc(logs.error):'Last 200 lines'}</small><button type="button" class="text-button" data-action="docker-logs-refresh" data-id="${esc(key)}" data-name="${esc(c.name)}">Refresh</button><button type="button" class="text-button" data-action="docker-terminal" data-kind="logs" data-id="${esc(key)}" data-name="${esc(c.name)}">Follow in a terminal</button></div><pre tabindex="0">${esc(logs.text||'')}</pre></div>`:''}
    </article>`;
  }
  function dockerImages(key,r,v){
    if(!r.images.length)return '';
    const total=r.images.reduce((n,i)=>n+bytes(i.size),0);
    const row=i=>{const ref=imageRef(i),users=r.containers.filter(c=>c.image===ref||c.image===i.repository&&(!i.tag||i.tag==='latest')||c.image===i.id);
      return `<div class="dk-image"><span class="dk-image-icon" aria-hidden="true">${dkIcon('box')}</span><span class="dk-image-ref"><strong title="${esc(ref)}">${esc(ref)}</strong><small>${esc(i.created)}</small></span><span class="dk-image-size">${esc(i.size)}</span><span class="dk-image-use">${users.length?`<span title="${esc(users.map(c=>c.name).join(', '))}">${plural(users.length,'container')}</span>`:'<span class="unused">Unused</span>'}</span><span class="dk-image-actions">${i.repository&&i.repository!=='<none>'?`<button type="button" class="dk-btn" data-action="docker-do" data-do="pull" data-id="${esc(key)}" data-name="${esc(ref)}" title="Download the newest ${esc(ref)}" aria-label="Pull ${esc(ref)}">${dkIcon('pull')}</button>`:''}<button type="button" class="dk-btn danger" data-action="docker-do" data-do="remove-image" data-id="${esc(key)}" data-name="${esc(ref)}" title="Remove this image" aria-label="Remove ${esc(ref)}">${dkIcon('trash')}</button></span></div>`;};
    return `<details class="dk-images mg-images" ${v.imagesOpen?'open':''} data-key="${esc(key)}"><summary><span>Images <small>${r.images.length} / ${dkSize(total)}</small></span><button type="button" class="secondary small" data-action="docker-prune" data-id="${esc(key)}" title="Remove dangling images: no name and no container uses them">Prune</button></summary><div class="dk-image-list">${r.images.map(row).join('')}</div></details>`;
  }
  // The manager window: machine tabs, the engine line with counts, search, a state filter, Live and Refresh.
  function dockerBody(key){
    const v=dockerViews.get(key)||{},r=v.result,host=key==='local'?'':key,machines=[['local',localName()],...state.hosts.map(h=>[h.id,h.name])];
    const tabs=`<nav class="dk-tabs" aria-label="Machines">${machines.map(([k,n])=>{const x=dockerViews.get(k)?.result;return `<button type="button" class="dk-tab ${k===key?'active':''}" data-action="docker-machine" data-id="${esc(k)}" aria-pressed="${k===key}"><span class="status-dot ${x?.running?'connected':x?'error':''}"></span>${esc(n)}</button>`;}).join('')}</nav>`;
    const running=r?.containers?.filter(c=>c.state==='running').length||0,stopped=(r?.containers?.length||0)-running;
    const engine=v.loading&&!r?'<span class="status-dot working"></span> Reading Docker...':v.error?`<span class="status-dot error"></span> ${esc(v.error)}`:r?.running?`<span class="status-dot connected"></span> Docker ${esc(r.version)}`:r?`<span class="status-dot error"></span> ${esc(r.error)}`:'';
    const show=v.show||'all',q=(v.q||'').trim().toLowerCase();
    const bar=`<div class="dk-bar"><div class="dk-engine">${engine}${r?.running?`<span class="dk-count"><b>${running}</b> running</span><span class="dk-count"><b>${stopped}</b> stopped</span><span class="dk-count"><b>${r.images.length}</b> image${r.images.length===1?'':'s'}</span>`:''}</div>${r?.running?`<input type="search" class="dk-search" data-docker-search="${esc(key)}" placeholder="Search containers" aria-label="Search containers" value="${esc(v.q||'')}"><div class="segmented transfer-mode dk-show" role="radiogroup" aria-label="Show">${[['all','All'],['running','Running'],['stopped','Stopped']].map(([k,l])=>`<label class="${show===k?'selected':''}"><input type="radio" name="dk-show" value="${k}" data-docker-show="${esc(key)}" ${show===k?'checked':''}>${l}</label>`).join('')}</div><label class="mg-toggle" title="Live CPU and memory while this window is open"><input type="checkbox" data-action="docker-live" data-id="${esc(key)}" ${v.statsOff?'':'checked'}><span class="switch" aria-hidden="true"></span>Live</label>`:''}<button type="button" class="dk-btn" data-action="docker-refresh" data-id="${esc(key)}" ${v.loading?'disabled':''} title="Refresh" aria-label="Refresh">${dkIcon('refresh')}</button></div>`;
    if(!r?.running)return tabs+bar+`<div class="dk-empty">${r&&!r.installed?`<span class="dk-empty-icon">${dkIcon('box')}</span><h3>Docker is not installed on ${esc(key==='local'?localName():hostName(key))}</h3><p>Opaya can install it with the agents that run in containers.</p><button type="button" class="primary" data-action="install-catalog"${host?` data-host="${esc(host)}"`:''}>&#8595; Install Docker</button>`:r?`<span class="dk-empty-icon">${dkIcon('box')}</span><h3>Docker is not running</h3><p>${esc(r.error||'Start Docker there, then refresh.')}</p><button type="button" class="secondary" data-action="docker-refresh" data-id="${esc(key)}">Refresh</button>`:'<p class="field-help">Reading Docker...</p>'}</div>`;
    const list=r.containers.filter(c=>(show==='all'||(show==='running')===(c.state==='running'))&&(!q||`${c.name} ${c.image}`.toLowerCase().includes(q))).sort((x,y)=>(y.state==='running')-(x.state==='running')||x.name.localeCompare(y.name));
    return tabs+bar+`<div class="dk-grid">${list.map(c=>dockerCard(key,c,{stats:dockerStatsOf.get(key)})).join('')||`<p class="field-help dk-none">${r.containers.length?'No container matches.':'No containers on this machine yet. Dockerize an agent, or Install agents can set one up in Docker.'}</p>`}</div>${dockerImages(key,r,v)}`;
  }
  // Repaints keep the search box focused where the cursor was.
  function paintDocker(key){
    const active=document.activeElement,search=active?.matches?.('[data-docker-search]')?{at:active.selectionStart}:null;
    const box=$('#docker-manager');if(box&&box.dataset.key===key)box.innerHTML=dockerBody(key);const mg=$('#mg-docker'),a=selected();if(mg&&mg.dataset.key===key&&manageId&&a&&a.install?.kind!=='remote-api')mg.innerHTML=dockerPanel(a);const fl=$('#fl-docker');if(fl&&fl.dataset.key===key)fl.innerHTML=dockerPanel(null,key);if(fleetView&&overview&&$('#fl-board'))render();
    if(search){const f=$('[data-docker-search]');if(f){f.focus();f.setSelectionRange(search.at,search.at);}}
  }
  // The images list stays open or closed across refreshes.
  document.addEventListener('toggle',event=>{const d=event.target;if(d.classList?.contains('mg-images')){const v=dockerViews.get(d.dataset.key);if(v)v.imagesOpen=d.open;}},true);
  async function loadDocker(key){
    dockerViews.set(key,{...dockerViews.get(key),loading:true,error:''});paintDocker(key);
    // The Live switch, the filter, the open log and the images list survive a refresh.
    try{const result=await api.dockerList({hostId:key==='local'?undefined:key}),prev=dockerViews.get(key)||{};dockerViews.set(key,{statsOff:prev.statsOff,imagesOpen:prev.imagesOpen,q:prev.q,show:prev.show,logs:prev.logs,result});if(result?.running&&!prev.statsOff&&$('#docker-manager')?.dataset.key===key)loadDockerStats(key);}
    catch(error){dockerViews.set(key,{...dockerViews.get(key),loading:false,error:error.message});}
    paintDocker(key);
  }
  async function dockerLogs(key,name,toggle=true){
    const v=dockerViews.get(key);if(!v)return;
    if(toggle&&v.logs?.name===name){v.logs=null;paintDocker(key);return;}
    v.logs={name,loading:true,text:v.logs?.name===name?v.logs.text:''};paintDocker(key);
    try{const r=await api.dockerLogs({hostId:key==='local'?undefined:key,container:name,tail:200});if(v.logs?.name===name)v.logs={name,text:r?.text||'(no output)'};}
    catch(error){if(v.logs?.name===name)v.logs={name,error:error.message,text:''};}
    paintDocker(key);for(const pre of document.querySelectorAll(`.dk-card[data-container="${CSS.escape(name)}"] .dk-logs pre`))pre.scrollTop=pre.scrollHeight;
  }
  // While the manager window is open, Live samples CPU and memory: every 4 seconds here, every 10 over SSH.
  let dkTimer=0;
  function dockerTick(){clearTimeout(dkTimer);const box=$('#docker-manager');if(!box){dkTimer=0;return;}const key=box.dataset.key,v=dockerViews.get(key);if(v?.result?.running&&!v.statsOff&&!document.hidden)loadDockerStats(key);dkTimer=setTimeout(dockerTick,key==='local'?4000:10000);}
  function openDocker(key){
    const h=key==='local'?null:state.hosts.find(x=>x.id===key);if(key!=='local'&&!h)return;
    modal('Docker manager','Containers and images on your machines. Opaya runs docker there; nothing changes without your click.',`<div id="docker-manager" class="dk" data-key="${esc(key)}">${dockerBody(key)}</div>`,true);
    $('#app-dialog').classList.add('tall');
    const box=$('#docker-manager');
    box.addEventListener('input',event=>{const t=event.target;if(t.matches('[data-docker-search]')){const v=dockerViews.get(box.dataset.key);if(v){v.q=t.value;paintDocker(box.dataset.key);}}});
    box.addEventListener('change',event=>{const t=event.target;if(t.matches('[data-docker-show]')){const v=dockerViews.get(box.dataset.key);if(v){v.show=t.value;paintDocker(box.dataset.key);}}});
    loadDocker(key);dockerTick();
  }
  async function dockerDo(key,name,what){
    const machine=key==='local'?localName():state.hosts.find(x=>x.id===key)?.name||'this machine';
    const agents=machineAgents(key==='local'?'':key).filter(a=>a.command==='docker'&&a.args?.includes(name)).map(a=>title(a));
    const warn=agents.length?`\n\nOpaya uses it for: ${agents.join(', ')}.`:'';
    if(what==='remove'&&!await ask(`Remove container ${name} on ${machine}?\n\nA running container is stopped first. Data in its volumes and mounted folders stays; everything else inside the container is deleted.${warn}`))return;
    if(what==='stop'&&agents.length&&!await ask(`Stop container ${name} on ${machine}?${warn} It stops answering until you start the container again.`))return;
    if(what==='remove-image'&&!await ask(`Remove image ${name} on ${machine}?\n\nDocker refuses if a container still uses it. It can be downloaded again.`))return;
    if(what==='prune'&&!await ask(`Remove unused images on ${machine}?\n\nOnly images no container uses and that have no name (dangling) are removed. They can be downloaded again.`))return;
    if(what==='pull')toast(`Downloading the newest ${name} on ${machine}...`);
    dockerViews.set(key,{...dockerViews.get(key),loading:true});paintDocker(key);
    try{await api.dockerAction({hostId:key==='local'?undefined:key,container:name,action:what});toast(what==='prune'?`Unused images removed on ${machine}.`:{start:'Started',stop:'Stopped',restart:'Restarted',pause:'Paused',unpause:'Resumed',pull:'Pulled the newest',remove:'Removed','remove-image':'Removed'}[what]+` ${name}.${what==='pull'?' Restart or update its container to use it.':''}`);}
    catch(error){toast(error.message,true);}
    await loadDocker(key);
  }
  // What's new: shown once after an update to a version listed here, and from Find (What's new).
  const WHATS_NEW={'0.29.0':[
    ['overview','Manage on one page','Everything about an agent is on one page now. The agent\'s sidebar is its table of contents: click a section (or press its letter) to go there, and the section you are reading is marked as you scroll.'],
    ['machine','A clearer Machines screen','Pick a machine and its panel opens right under it: what it is, its tools and its Docker, with every container side by side.'],
    ['model','Settings, a page at a time','Settings has a page per topic on the left and a filter that searches all of them, so there is no long scroll.'],
    ['power','Dialogs close when you click beside them','Click the dimmed page around a dialog to close it, like Esc. If you typed something in it, it stays open so nothing is lost.']],
  '0.28.0':[
    ['chat','Chat, Terminal and Manage','Every agent has these three at the top of its screen, and each agent remembers where you left it.'],
    ['console','Split terminals any way','The split button on a terminal window opens a new terminal to its right, below, left or above. Ctrl+Shift+Arrow moves between them (Cmd on a Mac).'],
    ['overview','Manage at a glance','Update, Clone, Back up, Connection settings and its machine are one click away on Manage, with a line on what each does.'],
    ['power','Fix it from the chat','When an agent cannot connect, its chat offers Let the Opaya Agent fix it and Try again.'],
    ['find','Find anything, go back','Search at the top (Ctrl+K) finds any agent, setting or action and shows where it lives; the arrow at the top left goes back.']]};
  function openWhatsNew(version=update.current||''){
    const list=WHATS_NEW[version]||WHATS_NEW[Object.keys(WHATS_NEW).sort(compareVersions).at(-1)],shown=WHATS_NEW[version]?version:Object.keys(WHATS_NEW).sort(compareVersions).at(-1);
    modal(`What's new in Opaya ${shown}`,'A quick look at what changed, and where to find it.',`<div class="whats-new">${list.map(([icon,t,text])=>`<div class="wn-item"><span class="wn-ico" aria-hidden="true">${icon==='find'?dkIcon('inspect'):AN_ICON[icon]||''}</span><div><strong>${esc(t)}</strong><p>${esc(text)}</p></div></div>`).join('')}</div><div class="modal-footer"><button type="button" class="text-button" data-action="help">Where is what &#8594;</button><button type="button" class="primary" data-action="modal-close">Got it</button></div>`);
  }
  function openHelp(){
    const k=mod().trim(),tile=(icon,t,where,how,act='',attrs='')=>`<div class="help-tile"><span class="help-tile-ico" aria-hidden="true">${icon}</span><div><strong>${t}</strong><small class="help-where">${where}</small><p>${how}</p>${act?`<button type="button" class="text-button" data-action="${act}" ${attrs}>Open &#8594;</button>`:''}</div></div>`;
    const map=`<section class="help-map"><h3>Where is what</h3><p class="help-find">Looking for something? Press <kbd>${esc(k)}${state.platform==='darwin'?'':'+'}K</kbd> or <strong>Search</strong> at the top of every screen: it finds agents, their settings and actions, machines, chats and keys, and shows where each one lives. <button type="button" class="text-button" data-action="find">Search now &#8594;</button></p><div class="help-tiles">
      ${tile(AN_ICON.chat,'Your agents','Left sidebar',`Click an agent to restore its last destination; ${k}+1 to 9 open them in sidebar order. Its own sidebar holds Chat, Terminal, and Manage.`)}
      ${tile(AN_ICON.overview,'Manage an agent','Agent sidebar > Manage',`One page with everything about it. Its sidebar lists the sections: Model &amp; skills (Q), Keys &amp; tools (W), Machine &amp; Docker (E), Deploy &amp; clone (R), Projects (A), Updates &amp; backups (S), Profile (D), Danger zone (F); click one or press its letter to go there.`)}
      ${tile(AN_ICON.access,'API keys','Vault (sidebar), an agent\'s Keys &amp; tools','Add keys, import them from a .env or your tools, and give each to the agents that need it. Values never show or go into a chat.','vault')}
      ${tile(AN_ICON.library,'Skills and MCP servers','Skills &amp; tools (sidebar), an agent\'s Model &amp; skills','The skills library and MCP servers are shared by all agents; an agent\'s Model &amp; skills shows its own and shares them with another agent.','library')}
      ${tile(AN_ICON.deploy,'Clone and deploy','Deploy &amp; clone (R)','Drag the agent onto a machine, or click Install or Docker there. Clones keep a link to their source for Redeploy.')}
      ${tile(dkIcon('box'),'Docker','Machine &amp; Docker (E), Docker manager','Start, stop, logs, shell and details of every container, with live CPU and memory.','docker-manager','data-id="local"')}
      ${tile(AN_ICON.machine,'Machines','Machines (sidebar)','This computer and your servers: agents on each, versions, Docker, New VPS.','hosts')}
      ${tile(AN_ICON.chat,'Opaya Agent','Top of the sidebar','Ask it to install, connect, update or fix anything; it shows what it does and asks first.','opaya')}
    </div></section>`;
    modal('A little help, right here.','Where everything is, and how to connect the agents you already have.',`${map}<div class="help-grid"><section><h3>Hermes already running?</h3><p>Connect to its gateway API, not a second ACP process using the same profile. Each independent profile needs its own API port.</p><pre>API_SERVER_ENABLED=true\nAPI_SERVER_PORT=8642\nAPI_SERVER_KEY=your-long-random-secret</pre><p>Add those settings to that profile's .env and start or restart its gateway yourself. Then Discover and choose Import gateway token.</p><button class="text-button" data-action="docs" data-topic="hermes">Hermes API setup &#8599;</button></section><section><h3>Your first SSH connection</h3><p>Machines &rarr; import your SSH aliases &rarr; Terminal. Verify the host fingerprint against a trusted source. Use Local shell to unlock your key in this computer's ssh-agent, then run Discover agents.</p><p>Unknown or changed host keys block automated connections. Opaya never disables host verification or forwards your SSH agent.</p></section><section><h3>Codex & Claude Code</h3><p>Use the same CLI installation and login you already use. Log in through the integrated terminal if necessary.</p><p>Codex uses its app server. Claude streams its CLI and resumes specific sessions. Claude's interactive approvals remain in its native terminal.</p><button class="text-button" data-action="docs" data-topic="codex">Codex integration &#8599;</button><button class="text-button" data-action="docs" data-topic="claude">Claude CLI &#8599;</button></section><section><h3>OpenClaw & other agents</h3><p>Enable OpenClaw's chatCompletions HTTP endpoint and enter its gateway token. Select an agent with openclaw/agent-id.</p><p>Other agents can use an OpenAI-compatible gateway, ACP executable, or native terminal. Container and WSL installations need an explicit command or endpoint in this release.</p><button class="text-button" data-action="docs" data-topic="openclaw">OpenClaw setup &#8599;</button></section></div><div class="privacy-box"><h3>What stays where</h3><p>Provider credentials and agent memory stay with the agent. Saved gateway tokens use OS encryption; when unavailable, choose memory-only tokens. Chat transcripts are local plaintext files in your OS application-data folder. Terminal scrollback is saved locally. A separate session service keeps live terminals and chat streams running when the window closes. Remote shells use tmux, so they can survive losing this computer's SSH connection. Local processes do not survive a computer reboot; saved history does. No analytics or automatic cloud sync.</p><p>Disconnect and Stop close the local connection. A remote job may continue after a network break; verify its status before resending a task. HTTP gateways enforce their own tool permissions.</p></div><div class="shortcuts"><span><kbd>${mod()}K</kbd> Switch agent</span><span><kbd>${mod()}N</kbd> New conversation</span><span><kbd>${mod()}&#96;</kbd> Terminal</span><span><kbd>Shift Enter</kbd> New line</span><span><kbd>Right-click</kbd> Agent, tab &amp; workspace actions</span></div>`,true);
  }
  async function openModels(){
    const a=selected();if(!a)return;const c=currentConversation();
    modal('Model',title(a),`<p class="clone-progress"><span class="status-dot working"></span> Asking ${esc(title(a))} for its models${a.protocol==='acp'?`. ${a.provider==='hermes'?'Hermes':'It'} opens a session for this, which can take up to a minute`:''}...</p>`);
    try{
      const result=await api.agentModels({id:a.id});
      if(!$('#app-dialog'))return;
      // Agents list the models they know (Hermes its own catalog), which can lag behind the provider: the newest models of the
      // provider it uses (deepseek:deepseek-flash...) are added, and Other model takes any name.
      const presets=opaya().presets||{},prefixes=new Set([...(result.models||[]),a.model,a.activeModel,c?.model].filter(Boolean).map(m=>/^([a-z][\w-]*):/.exec(m)?.[1]).filter(p=>presets[p]?.models?.length));
      const models=[...new Set([...(result.models||[]),...[...prefixes].flatMap(p=>presets[p].models.map(x=>`${p}:${x}`)),a.model,c?.model].filter(Boolean))],current=c?.model||a.model||'';
      modal('Model',title(a),`<form id="model-form"><div class="model-scope"><div><small>Agent default</small><strong>${esc(a.model?modelText(a.model):a.activeModel?`${modelText(a.activeModel)} (its own setting)`:`${title(a)}'s own setting`)}</strong><span>Used by every chat with ${esc(title(a))}.</span></div><div><small>This chat</small><strong>${esc(c?.model?modelText(c.model):'Uses the default')}</strong><span>${c?esc(c.title):'Start a conversation to set a chat model.'}</span></div></div><label class="field"><span>Model ${models.length?`<em>${models.length} available</em>`:''}</span>${models.length?`<select name="model"><option value="">${esc(title(a))}'s own setting${a.activeModel&&!a.model?` (now ${esc(modelText(a.activeModel))})`:''}</option>${models.map(m=>`<option value="${esc(m)}" ${m===current?'selected':''}>${esc(modelText(m))}</option>`).join('')}<option value="__other">Other model&#8230;</option></select><input name="otherModel" class="model-other" hidden placeholder="Exact model name, for example deepseek:deepseek-flash" autocomplete="off" spellcheck="false">`:`<input name="model" value="${esc(current)}" placeholder="Type a model name, or leave empty for the agent's own setting" autocomplete="off" spellcheck="false">`}</label><p class="field-help">${models.length?'This list comes from the connected agent or provider. Refresh after changing credentials or endpoint.':`${esc(title(a))} did not report its models${a.protocol==='acp'?' (its ACP server does not list them)':''}. Type the model name it uses, for example the one in its config, or keep its own setting.`}</p><div class="modal-footer"><div><button type="button" class="secondary" data-action="models">Refresh</button>${c?.model?'<button type="submit" class="subtle" value="clear-chat">Clear chat override</button>':''}</div><div>${c?'<button class="secondary" type="submit" value="conversation">Use in this chat</button>':''}<button class="primary" type="submit" value="default">Set as agent default</button></div></div></form>`);
      {const sel=$('#model-form select[name="model"]'),other=$('#model-form [name="otherModel"]');sel?.addEventListener('change',()=>{other.hidden=sel.value!=='__other';if(!other.hidden)other.focus();});}
      $('#model-form').addEventListener('submit',event=>{event.preventDefault();const form=event.target,scope=event.submitter?.value||'default',picked=form.elements.model.value,model=scope==='clear-chat'?'':picked==='__other'?form.elements.otherModel.value.trim():picked;
        if(picked==='__other'&&!model&&scope!=='clear-chat'){toast('Type the exact model name.',true);form.elements.otherModel.focus();return;}
        action(async()=>{await api.selectModel({id:a.id,model,scope:scope==='default'?'default':'conversation',conversationId:c?.id});closeModal();toast(scope==='default'?`Default model for ${title(a)} updated.`:scope==='clear-chat'?'This chat uses the agent default again.':'Model set for this chat.');});});
    }catch(e){if($('#app-dialog'))modal('Model',title(a),`<div class="inline-notice error-notice">${esc(e.message)}</div>`);}
  }

  async function openGateway(){
    const a=selected();if(!a)return;
    modal('Gateway',`${title(a)} / ${location(a)}`,`<pre id="gateway-output">Checking gateway status...</pre><div class="modal-footer"><button class="secondary" data-action="gateway">Refresh status</button><button class="primary" id="gateway-restart">Restart gateway</button></div>`);
    const output=$('#gateway-output'),restart=$('#gateway-restart');
    const run=async operation=>{restart.disabled=true;output.textContent=operation==='restart'?'Restarting gateway...':'Checking gateway status...';try{const result=await api.gateway({id:a.id,operation});output.textContent=result.output;}catch(e){output.textContent=e.message;}finally{restart.disabled=false;}};
    restart.onclick=()=>run('restart');await run('status');
  }
  function openSettings(focus=''){
    // Settings is a page per topic, picked on the left; choosing an option redraws the page in place (same page, same
    // scroll, same filter) instead of reopening the dialog.
    if(focus&&SETTINGS_PAGE_OF[focus])settingsPage=SETTINGS_PAGE_OF[focus];
    const open=$('#app-dialog.settings-dialog'),keepAt=open?$('.set-pane',open)?.scrollTop:null,filter=open?$('.set-filter',open)?.value||'':'';
    const st=state.settings||{},on=(key,dflt=true)=>st[key]===undefined?dflt:!!st[key],cmd=state.platform==='darwin'?'\u2318':'Ctrl+',version=update.current?`Opaya ${esc(update.current)}`:'Opaya';
    const toggle=(key,label,hint='',dflt=true)=>`<label class="switch-row"><input type="checkbox" data-setting="${key}" ${on(key,dflt)?'checked':''}><span class="switch" aria-hidden="true"></span><span>${label}${hint?` <small>(${hint})</small>`:''}</span></label>`;
    const choice=(act,value,current,label,small,extra='')=>`<button type="button" class="theme-option compact ${current?'selected':''}" data-action="${act}" data-value="${value}" ${extra}><strong>${label}</strong><small>${small}</small></button>`;
    const html=`<div class="set-layout"><nav class="set-nav" aria-label="Settings pages"><input type="search" class="set-filter" placeholder="Filter settings" aria-label="Filter settings" value="${esc(filter)}">${SETTINGS_PAGES.map(([k,label,icon])=>`<button type="button" class="set-tab" data-set-page="${k}">${icon}<span>${label}</span></button>`).join('')}<p class="set-empty" hidden>No setting matches.</p></nav><div class="set-pane settings-grid">
      <section data-page="look"><h3>Theme</h3><div class="theme-options"><button class="theme-option ${theme==='dark'?'selected':''}" data-action="theme" data-theme="dark"><span class="theme-swatch dark-swatch"></span><strong>Dark</strong><small>Original Opaya look</small></button><button class="theme-option ${theme==='light'?'selected':''}" data-action="theme" data-theme="light"><span class="theme-swatch light-swatch"></span><strong>White</strong><small>Bright workspace</small></button></div></section>
      <section data-page="look"><h3>Sidebar</h3><p class="settings-copy">Your agents' sidebar shows their names, or only their icons as a slim strip. The button at its bottom switches too.</p><div class="theme-options"><button class="theme-option ${sidebarRail?'':'selected'}" data-action="rail-set" data-value="full"><strong>Names</strong><small>Full width, with machines and status</small></button><button class="theme-option ${sidebarRail?'selected':''}" data-action="rail-set" data-value="rail"><strong>Icons only</strong><small>A slim strip; more room for the page</small></button></div><p class="settings-copy">What shows in the sidebar besides your agents. Settings stays, so you can turn items back on.</p>${SIDE_ITEMS.map(([key,label,hint])=>`<label class="switch-row"><input type="checkbox" data-side-toggle="${key}" ${sidebarHide.has(key)?'':'checked'}><span class="switch" aria-hidden="true"></span><span>${label} <small>(${hint})</small></span></label>`).join('')}</section>
      <section class="set-intro" data-page="chat"><h3>Chat and Terminal</h3><p class="settings-copy">Every agent has <strong>Chat</strong> (talk to it in Opaya) and <strong>Terminal</strong> (its own CLI and a shell) at the top of its screen; Opaya reopens the one you used last. Chat and the agent's own CLI can be separate conversations. To see both, use <em>Show terminal beside chat</em> in Chat.</p></section>
      <section data-page="chat"><h3>Chat</h3><p class="settings-copy">How the message box sends. Models, reasoning effort and attachments are under each chat's message box.</p><div class="theme-options">${choice('send-key','enter',(st.sendKey||'enter')==='enter','Enter sends','Shift+Enter: new line')}${choice('send-key','mod-enter',st.sendKey==='mod-enter',`${mod()}Enter sends`,'Enter: new line')}</div>${toggle('tips','Tips from Opaya','now and then, when something useful applies')}</section>
      <section data-page="chat"><h3>Terminal</h3><p class="settings-copy">Text size in every terminal (also ${mod()}+ and ${mod()}- in a terminal) and where the terminal panel sits.</p><div class="settings-stepper"><button type="button" class="secondary" data-action="font-step" data-step="-1" aria-label="Smaller text">A&#8722;</button><strong id="settings-font">${terminalFont}px</strong><button type="button" class="secondary" data-action="font-step" data-step="1" aria-label="Larger text">A+</button></div><div class="theme-options">${choice('terminal-place','bottom',layout.terminal!=='right','At the bottom','Under the chat')}${choice('terminal-place','right',layout.terminal==='right','On the side','Next to the chat')}</div><p class="field-help">Closed terminals reopen as read-only saved output. Use New to get a live prompt again.</p></section>
      <section data-page="notify"><h3>Notifications</h3><p class="settings-copy">System notifications while Opaya is not in front: hidden, minimized or behind another app. Click one to open that chat.</p>${toggle('notifyReplies','When an agent or the Opaya Agent replies')}${toggle('notifyApprovals','When something waits for your approval')}${toggle('notifyJobs','When installs, clones, updates and fixes finish')}${toggle('notifySound','With sound')}</section>
      <section data-page="notify"><h3>Startup</h3><p class="settings-copy">Opaya's session service keeps agents and terminals running while the window is closed. After a restart of the computer:</p><div id="login-item-row">${['win32','darwin'].includes(state.platform)?'<label class="switch-row"><input type="checkbox" id="login-item" disabled><span class="switch" aria-hidden="true"></span><span>Start Opaya when you sign in</span></label>':''}</div>${toggle('autoConnect','Connect agents when Opaya starts','',false)}</section>
      <section data-page="agents"><h3>Opaya Agent</h3><p class="settings-copy">Model: <strong>${esc(opaya().configured?opayaModelLabel(opaya()):'not connected')}</strong>. It installs, connects and repairs agents; keys you give it go straight to the OS keychain and to the agent that needs them.</p><div class="settings-buttons"><button class="secondary" data-action="opaya-config">Change model</button><button class="secondary" data-action="guide-open">Setup guide</button></div></section>
      <section data-page="agents"><h3>Agents and tools</h3><p class="settings-copy">Opaya checks your agents, CLIs and tools such as Node.js and Python on every machine once an hour and tells you when an update is out.</p>${toggle('updateChecks','Check for updates every hour')}${toggle('autoFix','Fix agent errors automatically','update when too old; gateway, sign-in and other errors go to the Opaya Agent')}<button class="secondary" data-action="tool-updates">See updates</button></section>
      <section class="itrust-settings" data-page="agents"><h3>iTrust mode</h3><p class="settings-copy">Approve tool requests automatically: commands, file edits and other actions agents ask permission for. Works for Hermes and other ACP agents, Codex and Claude Code. Turn it on only for agents you trust with this computer.</p><label class="switch-row"><input type="checkbox" data-setting="itrustAll" ${st.itrustAll?'checked':''}><span class="switch" aria-hidden="true"></span><span>All agents</span></label><label class="switch-row"><input type="checkbox" data-setting="itrustOpaya" ${st.itrustOpaya?'checked':''}><span class="switch" aria-hidden="true"></span><span>Opaya Agent <small>(removals still ask)</small></span></label><p class="field-help">Per agent: right-click an agent &gt; Turn on iTrust.</p></section>
      <section data-page="keys"><h3>Opaya Vault</h3><p class="settings-copy">${plural(vaultKeys().length,'key')} kept, ${state.secureStorage===false?'in memory until Opaya closes':'encrypted by your OS'}. Give them to one agent or to all of them, or import the ones you have from a .env file or your tools.</p><div class="settings-buttons"><button class="secondary" data-action="vault">Open Opaya Vault</button><button class="secondary" data-action="vault-import">Import keys</button><button class="secondary" data-action="vault-backup">Back up</button></div></section>
      <section data-page="keys"><h3>Skills and MCP servers</h3><p class="settings-copy">Global skills kept by Opaya, and ${(state.mcpServers||[]).length} saved MCP server${(state.mcpServers||[]).length===1?'':'s'} (GitHub, a browser, a database) that Opaya passes to your agents.</p><div class="settings-buttons"><button class="secondary" data-action="library">Skills library</button><button class="secondary" data-action="mcp-manage">MCP servers</button></div></section>
      <section data-page="machines"><h3>Machines</h3><p class="settings-copy">This computer is <strong>${esc(localName())}</strong>${state.hosts.length?`, with ${state.hosts.length} server${state.hosts.length===1?'':'s'}`:''}. Backups go to <code>${esc(st.backupDir||'Opaya Backups in your home folder')}</code>.</p><div class="settings-buttons"><button class="secondary" data-action="hosts">Open Machines</button><button class="secondary" data-action="local-machine">Name and backup folder</button></div></section>
      <section data-page="machines"><h3>Data and privacy</h3><p class="settings-copy">No account and no telemetry. Chats, transcripts and settings stay in Opaya's folder on this computer; API keys and tokens are encrypted with the OS keychain${state.secureStorage===false?' <strong>(not available here)</strong>':''}.</p><button class="secondary" data-action="open-data-folder">Open Opaya's folder</button></section>
      <section data-page="shortcuts"><h3>Keyboard shortcuts</h3><div class="shortcut-grid">${[[`${cmd}K`,'Find anything'],[state.platform==='darwin'?'\u2325Left':'Alt+Left','Back to the previous screen'],[`${cmd}1 to 9`,'Open agent 1 to 9'],[`${cmd}N`,'New chat'],[`${cmd}\``,'Show or hide the terminal'],[`${cmd}B`,'Show or hide the sidebar'],[`${cmd}Shift+M`,'Manage the agent'],[`${cmd}Shift+H`,'Chat history'],[`${cmd}Shift+P`,'Projects'],[`${cmd}+ / ${cmd}-`,'Terminal text size'],[`${cmd}Shift+Arrow`,'Focus terminal pane'],[`${cmd}Shift+[ / ]`,'Previous / next terminal pane'],[`${cmd}Shift+Enter`,'Maximize / restore terminal pane'],['Arrow keys on a separator','Resize terminal panes'],['Right-click','Menus for agents, terminal windows and chats']].map(([k,t])=>`<span><kbd>${esc(k)}</kbd>${esc(t)}</span>`).join('')}</div></section>
      <section data-page="about"><h3>Updates</h3><p class="settings-copy">Installed: ${version}. ${update.status==='available'?`Version ${esc(update.latest?.version||'')} is ready to download.`:'Opaya checks GitHub for new versions.'}</p><button class="secondary" data-action="updates">${update.status==='available'?'Update now':'Check for updates'}</button></section>
      <section class="about" data-page="about"><h3>About</h3><p class="settings-copy">${version}. One place. All your agents.</p><div class="settings-buttons"><button class="text-button" data-action="open-link" data-external="1" data-url="https://github.com/trbojevicstefan/agenthub/blob/main/docs/RELEASE_NOTES.md">What's new &#8599;</button><button class="text-button" data-action="open-link" data-external="1" data-url="https://github.com/trbojevicstefan/agenthub">GitHub &#8599;</button><button class="text-button" data-action="open-link" data-external="1" data-url="https://opaya.dev">opaya.dev &#8599;</button></div></section>
    </div></div>`;
    if(open)$('.modal-body',open).innerHTML=html;else{modal('Settings','Opaya itself: look, chat, terminal, notifications and more. Agents are set up in their own Manage.',html,true);$('#app-dialog').classList.add('tall','settings-dialog');}
    // The OS keeps "start at sign-in"; ask it, then let the switch change it.
    const box=$('#login-item');if(box&&api.loginItem)api.loginItem({}).then(r=>{if(!r?.supported){$('#login-item-row').innerHTML='';return;}box.checked=!!r.on;box.disabled=false;box.onchange=()=>action(async()=>{const next=await api.loginItem({on:box.checked});box.checked=!!next.on;toast(next.on?'Opaya starts when you sign in.':'Opaya no longer starts at sign-in.');});}).catch(()=>{$('#login-item-row').innerHTML='';});
    settingsNav(focus,keepAt);
  }
  const sI=d=>`<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
  const SETTINGS_PAGES=[['look','Appearance',sI('<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/>')],['chat','Chat & Terminal',sI('<path d="M4 5h16v11H9l-5 4z"/>')],['notify','Notifications & startup',sI('<path d="M6 16v-5a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 20a2 2 0 0 0 4 0"/>')],['agents','Agents',sI('<rect x="5" y="8" width="14" height="11" rx="3"/><path d="M12 4v4M9.5 13.5h.01M14.5 13.5h.01"/>')],['keys','Keys & skills',sI('<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M16 7l3 3"/>')],['machines','Machines & data',sI('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>')],['shortcuts','Shortcuts',sI('<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10"/>')],['about','Updates & about',sI('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>')]];
  const SETTINGS_PAGE_OF={'Chat and Terminal':'chat','Sidebar':'look','Theme':'look','Notifications':'notify','Chat':'chat','Terminal':'chat','Startup':'notify','iTrust mode':'agents','Opaya Agent':'agents','Updates':'about','Agents and tools':'agents','Opaya Vault':'keys','Machines':'machines','Skills and MCP servers':'keys','Data and privacy':'machines','Keyboard shortcuts':'shortcuts','About':'about'};
  let settingsPage='look';
  // One page at a time; the filter searches every page and shows what matches from all of them.
  function settingsNav(focus='',keepAt=null){
    const d=$('#app-dialog.settings-dialog');if(!d)return;const pane=$('.set-pane',d),nav=$('.set-nav',d),input=$('.set-filter',d),secs=[...pane.querySelectorAll('section')];
    for(const x of secs){const t=x.querySelector('h3').textContent;x.dataset.words=`${t} ${(SETTINGS_INDEX.find(([n])=>n===t)||[])[1]||''} ${x.textContent}`.toLowerCase();}
    const show=()=>{const q=input.value.trim().toLowerCase(),terms=q.split(/\s+/).filter(Boolean);let any=false;
      for(const x of secs){const hit=terms.length?terms.every(t=>x.dataset.words.includes(t)):x.dataset.page===settingsPage;x.hidden=!hit;any=any||hit;}
      for(const b of nav.querySelectorAll('[data-set-page]')){const k=b.dataset.setPage;b.classList.toggle('active',!terms.length&&k===settingsPage);b.classList.toggle('dim',!!terms.length&&!secs.some(x=>x.dataset.page===k&&!x.hidden));}
      $('.set-empty',d).hidden=any;pane.classList.toggle('filtering',!!terms.length);};
    nav.addEventListener('click',e=>{const b=e.target.closest('[data-set-page]');if(!b)return;settingsPage=b.dataset.setPage;input.value='';show();pane.scrollTop=0;});
    input.addEventListener('input',()=>{show();pane.scrollTop=0;});
    show();if(keepAt!=null)pane.scrollTop=keepAt;
    if(focus){const x=secs.find(s=>s.querySelector('h3').textContent===focus);if(x)requestAnimationFrame(()=>{x.scrollIntoView({block:'nearest'});x.classList.remove('flash');void x.offsetWidth;x.classList.add('flash');});}
  }


  // ---- Find anything (Ctrl/Cmd+K): agents, their sections and actions, places, settings, machines, chats and keys -----
  // Every result says where it lives (Hermes > Keys & tools, Settings > Theme), so finding something also shows where to
  // find it next time. Enter runs the highlighted result; arrows move; Esc closes.
  const FIND_WORDS={keys:'api key token secret env password',vault:'api key token secret',backup:'save copy restore',backups:'restore folder',uninstall:'delete remove',remove:'delete',clone:'copy duplicate deploy',dockerize:'docker container',update:'upgrade version',restart:'reconnect',itrust:'trust approve automatically permissions',browser:'web pages',transfer:'share copy skills keys',shareSkills:'share copy transfer',mcp:'tools github',models:'model llm',effort:'reasoning thinking',terminal:'cli command line',shell:'terminal command line',files:'folder browse',rename:'name title',groupTags:'group tag',containerLogs:'docker logs',containerRestart:'docker restart',settings:'connection endpoint command',newVps:'server ssh machine'};
  const SETTINGS_INDEX=[['Sidebar','icons names strip rail hide items'],['Theme','dark light white look'],['Notifications','notify sound replies approvals'],['Chat','enter send ctrl enter tips'],['Terminal','text size font bottom side'],['Startup','start sign in login connect at start'],['iTrust mode','trust approve automatically'],['Opaya Agent','model setup guide'],['Updates','check for updates fix errors automatically version'],['Opaya Vault','keys import'],['Machines','computer name backup folder'],['Skills and MCP servers','skills library tools'],['Data and privacy','folder telemetry privacy'],['Keyboard shortcuts','keys hotkeys shortcuts']];
  // Places: the shared screens and windows, run through the same handlers as their buttons.
  const FIND_PLACES=[['overview','Home','Sidebar','Your agents at a glance'],['fleet','Machines','Sidebar','Every machine and its agents'],['vault','Opaya Vault','Sidebar','API keys: add, import, give to agents'],['vault-import','Import keys','Opaya Vault','From a .env, any text file or your tools'],['vault-backup','Back up the Vault','Opaya Vault','An encrypted file with your keys; restore it anywhere'],['schedules','Schedules','Sidebar','Messages to agents on a schedule; their cron jobs'],['library','Skills library','Library','Global skills for any agent'],['mcp-manage','MCP servers','Library','Tools such as GitHub or a browser'],['docker-manager','Docker manager','Machines','Containers and images',{id:'local'}],['playground','Playground','Sidebar','Ask two agents the same question'],['opaya','Opaya Agent','Sidebar','Install, connect or repair by asking'],['install-catalog','Install agents','Home','Hermes, Claude Code, Codex, OpenClaw and more'],['discover','Discover agents','Sidebar','Find agents on this computer'],['add','Add connection','Home','An agent or an API by hand'],['new-vps','New VPS','Machines','A new server with its own SSH key'],['connect-all','Connect all','Home','Connect every agent'],['tool-updates','Check for updates','Home','Agents and tools with newer versions'],['update-all','Update all agents','Home','Every installation on every machine'],['local-terminal','Local terminal','Home','A shell on this computer'],['files-local','Files','Home','Browse files on this computer'],['settings','Settings','Sidebar','Theme, chat, terminal, notifications'],['help','Help','Sidebar','Where is what, and connection help'],['whats-new',"What's new",'Help','What changed in this version']];
  const fire=(name,data={})=>{const b=document.createElement('button');b.type='button';b.hidden=true;b.dataset.action=name;Object.assign(b.dataset,data);document.body.append(b);b.click();b.remove();};
  function findIndex(){
    const out=[],sel=selected(),secName=k=>AN_SECTIONS.find(s=>s.key===k)?.name||({chat:'Chat',console:'Terminal'})[k]||k;
    const agents=[...state.agents].sort((x,y)=>(y.id===sel?.id)-(x.id===sel?.id));
    for(const a of agents){const mine=a.id===sel?.id,who=title(a);
      out.push({group:'Agents',icon:badge(a),label:who,path:[`${description(a)}`,location(a)],words:`${labels[a.provider]||''} ${placeText(a)} ${a.group||''} ${(a.tags||[]).join(' ')}`,run:()=>openChat(a.id),boost:mine?20:0,status:a});
      for(const s of AN_SECTIONS)out.push({group:'Agent sections',icon:s.icon,label:s.name,path:[who,'Manage'],words:`${who} ${s.desc}`,hint:s.hk,run:()=>openManage(a.id,s.key),boost:mine?15:0,agentOnly:true,agentId:a.id});
      let acts={};try{acts=manageActions(a);}catch{}
      const seen=new Set();
      for(const [sec,list] of Object.entries(AN_SUB))for(const [k,label] of list){const it=acts[k];if(!it||it.disabled||k==='export'||seen.has(k))continue;seen.add(k);
        out.push({group:'Actions',icon:AN_ICON[k]||AN_ICON[sec]||'',label:it.label&&!/\.\.\.$/.test(label)&&it.label.length<40?it.label.replace(/\.\.\.$/,''):label,path:[who,secName(sec)],words:`${who} ${label} ${secName(sec)} ${FIND_WORDS[k]||''}`,boost:mine?15:0,agentOnly:true,agentId:a.id,
          run:async()=>{if(sec==='chat'||sec==='console'){if(state.activeAgentId!==a.id)await openChat(a.id);}else await openManage(a.id,sec);const row=sec!=='chat'&&sec!=='console'&&document.querySelector(`#content .set-row[data-key="${CSS.escape(k)}"]`);if(row){row.scrollIntoView({block:'center'});row.classList.remove('flash');void row.offsetWidth;row.classList.add('flash');}const now=manageActions(state.agents.find(x=>x.id===a.id)||a)[k];if(now&&!now.disabled)await now.run();}});}
    }
    const gear=anI('<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>');
    const PLACE_ICON={overview:AN_ICON.overview,fleet:AN_ICON.machine,vault:AN_ICON.access,'vault-import':dkIcon('pull'),library:AN_ICON.library,'mcp-manage':AN_ICON.mcp,'docker-manager':dkIcon('box'),playground:AN_ICON.chat,opaya:AN_ICON.chat,'install-catalog':dkIcon('pull'),discover:dkIcon('inspect'),add:AN_ICON.plus,'new-vps':AN_ICON.plus,'connect-all':AN_ICON.power,'tool-updates':dkIcon('refresh'),'update-all':dkIcon('refresh'),'local-terminal':dkIcon('shell'),'files-local':AN_ICON.projects,settings:gear,help:dkIcon('inspect')};
    for(const [act,label,where,help,data] of FIND_PLACES)out.push({group:'Places',icon:PLACE_ICON[act]||'',label,path:[where],words:help,run:()=>fire(act,data)});
    for(const [t,words] of SETTINGS_INDEX)out.push({group:'Settings',icon:gear,label:t,path:['Settings'],words,run:()=>openSettings(t)});
    for(const [k,n] of [['local',localName()],...state.hosts.map(h=>[h.id,h.name])])out.push({group:'Machines',icon:AN_ICON.machine,label:n,path:['Machines'],words:`${k==='local'?'this computer local':`${state.hosts.find(h=>h.id===k)?.hostname||''} vps server remote`}`,run:()=>openFleet(k)});
    for(const c of state.conversations.slice().sort((x,y)=>String(y.createdAt).localeCompare(String(x.createdAt))).slice(0,200)){const a=state.agents.find(x=>x.id===c.agentId);if(!a)continue;out.push({group:'Chats',icon:AN_ICON.chat,label:chatLabel(c),path:[title(a),'Chats'],words:'',run:()=>fire('an-chat',{id:c.id})});}
    for(const k of vaultKeys())out.push({group:'Keys',icon:KEY_SVG,label:k.name,path:['Opaya Vault'],words:`${k.mask} key`,run:()=>{openVault();vault.filter=k.name;vault.open=k.id;drawVault();}});
    return out;
  }
  const FIND_GROUPS=['Agents','Actions','Agent sections','Places','Settings','Machines','Chats','Keys'];
  // Without an agent's name in the query, an agent's sections and actions are the selected agent's (or every agent's
  // when none is selected); a name ("hermes backup") picks that agent. Spaces do not matter ("backup" finds Back up), and a
  // match only in where something lives counts less than one in its name.
  function findResults(all,q){
    q=q.trim().toLowerCase();
    if(!q){const sel=selected();return [...all.filter(x=>x.group==='Agents').slice(0,6),...(sel?all.filter(x=>x.group==='Agent sections'&&x.agentId===sel.id):[]),...all.filter(x=>x.group==='Places').slice(0,8)];}
    // A plural finds its singular too (logs finds Connection log).
    const tokens=q.split(/\s+/).filter(Boolean).map(t=>t.length>3&&t.endsWith('s')?t.slice(0,-1):t),flat=q.replace(/\s+/g,''),sel=selected();
    const named=new Set(state.agents.filter(a=>{const n=title(a).toLowerCase();return tokens.some(t=>t.length>=3&&n.includes(t));}).map(a=>a.id));
    const scored=[];
    for(const x of all){
      if(x.agentOnly&&(named.size?!named.has(x.agentId):sel&&x.agentId!==sel.id))continue;
      // The words that named the agent pick it; the rest must match the section or action itself.
      const owner=x.agentOnly?title(state.agents.find(a=>a.id===x.agentId)||{name:''}).toLowerCase():'',rest=owner?tokens.filter(t=>!owner.includes(t)):tokens;
      if(x.agentOnly&&!rest.length&&x.group==='Actions')continue;
      const label=x.label.toLowerCase(),flatLabel=label.replace(/[^a-z0-9]+/g,''),hay=`${label} ${flatLabel} ${x.path.join(' ')} ${x.words}`.toLowerCase();
      if(!tokens.every(t=>hay.includes(t)||flatLabel.includes(t)))continue;
      if(owner&&rest.length&&!rest.every(t=>`${label} ${flatLabel} ${x.words} ${x.path.slice(1).join(' ')}`.toLowerCase().replace(owner,'').includes(t)))continue;
      // An agent's sections and actions are scored on the words left after its name.
      const mine=owner&&rest.length?rest:tokens,mq=mine.join(' '),mflat=mq.replace(/\s+/g,'');
      let s=x.boost||0;
      if(label===mq)s+=120;else if(label.startsWith(mq)||flatLabel.startsWith(mflat))s+=90;else if(label.includes(mq)||flatLabel.includes(mflat))s+=60;
      let inName=0;for(const t of mine){if(new RegExp(`(^|[^a-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}`).test(label)){s+=12;inName++;}else if(label.includes(t)||flatLabel.includes(t)){s+=6;inName++;}}
      if(!inName)s-=30;
      scored.push([s,x]);}
    scored.sort((p,r)=>r[0]-p[0]);const per=new Map(),out=[];
    for(const [,x] of scored){const n=per.get(x.group)||0;if(n>=8)continue;per.set(x.group,n+1);out.push(x);if(out.length>=40)break;}
    // Groups in the order of their best match, so the likeliest answer is on top.
    const best=new Map();scored.forEach(([sc,x])=>{if(!best.has(x.group))best.set(x.group,sc);});
    return out.sort((p,r)=>(best.get(r.group)-best.get(p.group))||FIND_GROUPS.indexOf(p.group)-FIND_GROUPS.indexOf(r.group));
  }
  function switcher(){openFind();}
  function openFind(initial=''){
    modal('Find anything','Agents, their settings and actions, places, machines, chats and keys. Each result shows where it lives.',`<div class="find"><div class="find-box"><span class="find-ico" aria-hidden="true">${dkIcon('inspect')}</span><input id="find-input" class="find-input" placeholder="Search: an agent, backup, theme, docker, OPENAI..." aria-label="Find anything" autocomplete="off" spellcheck="false" value="${esc(initial)}" role="combobox" aria-expanded="true" aria-controls="find-list"></div><div id="find-list" class="find-list" role="listbox"></div><div class="find-foot"><span><kbd>&#8593;</kbd><kbd>&#8595;</kbd> move</span><span><kbd>Enter</kbd> open</span><span><kbd>Esc</kbd> close</span></div></div>`);
    $('#app-dialog').classList.add('find-dialog');
    const all=findIndex(),input=$('#find-input'),list=$('#find-list');let shown=[],at=0;
    const draw=()=>{shown=findResults(all,input.value);at=Math.min(at,Math.max(0,shown.length-1));let last='';
      list.innerHTML=shown.map((x,i)=>{const head=x.group!==last?`<div class="find-group" role="presentation">${esc(input.value.trim()?x.group:x.group==='Agent sections'?`${x.path[0]}`:x.group==='Agents'?'Your agents':x.group)}</div>`:'';last=x.group;
        return `${head}<button type="button" class="find-row ${i===at?'active':''}" role="option" aria-selected="${i===at}" data-find="${i}"><span class="find-row-ico" aria-hidden="true">${x.icon||dkIcon('link')}</span><span class="find-row-text"><strong>${esc(x.label)}</strong><small>${x.path.filter(Boolean).map(esc).join(' <i>&#8250;</i> ')}</small></span>${x.status?dot(x.status):''}${x.hint?`<kbd>${esc(x.hint)}</kbd>`:''}</button>`;}).join('')||`<p class="find-empty">Nothing found for "${esc(input.value)}". Try a word like keys, backup, docker or theme, or ask the Opaya Agent.</p>`;
      list.querySelector('.find-row.active')?.scrollIntoView({block:'nearest'});};
    const go=i=>{const x=shown[i];if(!x)return;closeModal();action(async()=>{await x.run();});};
    input.addEventListener('input',()=>{at=0;draw();});
    input.addEventListener('keydown',e=>{if(e.key==='ArrowDown'){e.preventDefault();at=Math.min(shown.length-1,at+1);draw();}else if(e.key==='ArrowUp'){e.preventDefault();at=Math.max(0,at-1);draw();}else if(e.key==='Enter'){e.preventDefault();go(at);}});
    list.addEventListener('click',e=>{const b=e.target.closest('[data-find]');if(b)go(Number(b.dataset.find));});
    list.addEventListener('mousemove',e=>{const b=e.target.closest('[data-find]');if(b&&Number(b.dataset.find)!==at){at=Number(b.dataset.find);for(const r of list.querySelectorAll('.find-row'))r.classList.toggle('active',r===b);}});
    draw();input.focus();input.select();
  }
  // Terminal layouts belong to an agent context; the session service owns the processes.
  const TL=window.OpayaTerminalLayout,terminalWorkspaces=new Map();
  let panes=[''],paneFocus=0,termOrder=0,restoringWorkspace=true;
  // Whose terminals the panel shows: the agent on screen, the Opaya Agent on its own screen, else the shared screens'.
  const termCtx=()=>inAgentView()?selected().id:opayaView&&!overview?'opaya':'';
  const ctxWindows=(ctx=termCtx())=>[...terminalViews.values()].filter(v=>(v.ctx||'')===ctx&&!v.poppedOut).sort((x,y)=>x.order-y.order);
  const ARRANGE={cols:['Side by side','Replace this layout with columns'],rows:['Stacked','Replace this layout with rows'],grid:['Grid','Replace this layout with a grid']};
  function workspace(ctx=termCtx()){
    if(!terminalWorkspaces.has(ctx))terminalWorkspaces.set(ctx,{ctx,tree:null,active:'',visible:false,dock:'bottom'});
    return terminalWorkspaces.get(ctx);
  }
  function savedWorkspaces(){
    if(!restoringWorkspace&&termCtxShown!==null){const w=workspace(termCtxShown);w.active=currentTerminal;w.dock=layout.terminal;if(!document.body.classList.contains('terminal-stage'))w.visible=!$('#terminal-panel').hidden;}
    return [...terminalWorkspaces.values()];
  }
  function paneRoot(){
    let root=$('#terminal-panes');
    if(!root){root=document.createElement('div');root.id='terminal-panes';root.className='terminal-panes';$('#terminal-views').prepend(root);
      root.addEventListener('pointerdown',event=>{const pane=event.target.closest('.terminal-pane');if(!pane||event.target.closest('.pane-grip'))return;const i=Number(pane.dataset.index);if(i!==paneFocus){paneFocus=i;currentTerminal=panes[i]||'';workspace().active=currentTerminal;markPanes();saveView();}},true);
      root.addEventListener('click',event=>{const b=event.target.closest('[data-pane-action]');if(!b)return;const id=b.closest('.terminal-pane').dataset.id,act=b.dataset.paneAction;
        if(act==='hide')hideWindow(id);else if(act==='popout')action(()=>popoutTerminal(id));else if(act==='close')action(()=>endWindow(id));else if(act==='show')showWindow(b.dataset.id);
        else if(act==='split')openToolbarMenu(b,splitItems(id),'Split terminal');else if(act==='maximize')maximizePane(id);});
    }
    return root;
  }
  function terminalPool(){let pool=$('#terminal-pool');if(!pool){pool=document.createElement('div');pool.id='terminal-pool';pool.hidden=true;$('#terminal-views').append(pool);}return pool;}
  function normalizePanes(){
    const w=workspace(),shown=ctxWindows().filter(v=>!v.hiddenPane).map(v=>v.id);
    w.tree=TL.reconcile(w.tree,shown);
    if(w.maximized&&!shown.includes(w.maximized))w.maximized='';
    panes=TL.leaves(w.tree);if(!panes.length)panes=[''];
    if(!panes.includes(currentTerminal))currentTerminal=panes.includes(w.active)?w.active:panes[0];
    paneFocus=Math.max(0,panes.indexOf(currentTerminal));w.active=currentTerminal;
  }
  function markPanes(){for(const el of paneRoot().querySelectorAll('.terminal-pane'))el.classList.toggle('focused',el.dataset.id===currentTerminal);}
  function renderArrange(){
    const box=$('#terminal-arrange');if(!box)return;const hidden=ctxWindows().filter(v=>v.hiddenPane);
    const html=`${arrangePicker()}${workspace().maximized?'<button type="button" class="term-btn" data-action="terminal-maximize">Restore panes</button>':''}${hidden.length?`<button type="button" class="term-btn hidden-windows" data-action="terminal-hidden" title="Sessions that keep running out of sight">${hidden.length} hidden</button>`:''}`;
    if(box.dataset.html!==html){box.dataset.html=html;box.innerHTML=html;}
  }
  function renderPanes(){
    normalizePanes();
    const root=paneRoot(),pool=terminalPool(),w=workspace(),tree=w.maximized?{id:w.maximized}:w.tree;
    const signature=JSON.stringify(tree,(key,value)=>key==='ratio'?undefined:value),focused=viewOf(document.activeElement);
    if(root.dataset.tree!==signature){
      const existing=new Map([...root.querySelectorAll('.terminal-pane')].map(el=>[el.dataset.id,el]));
      for(const view of terminalViews.values())if(!TL.leaves(tree).includes(view.id)){view.element.hidden=true;pool.append(view.element);}
      function build(node,path=''){
        if(!node||node.id){
          const id=node?.id||'';let pane=existing.get(id);
          if(!pane){pane=document.createElement('section');pane.className='terminal-pane';pane.dataset.id=id;
            pane.innerHTML='<header class="terminal-pane-head"><span class="pane-dot" aria-hidden="true"></span><span class="pane-title"></span><button type="button" class="pane-btn pane-split" data-pane-action="split" title="Split: open a new terminal beside or below this one" aria-label="Split terminal"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/></svg></button><button type="button" class="pane-btn" data-pane-action="maximize" title="Maximize or restore pane" aria-label="Maximize or restore pane">&#9633;</button><button type="button" class="pane-btn" data-pane-action="hide" title="Hide (keeps running)" aria-label="Hide terminal">&#8722;</button><button type="button" class="pane-btn" data-pane-action="popout" title="Open in separate window" aria-label="Open in separate window">&#8599;</button><button type="button" class="pane-btn danger" data-pane-action="close" title="End session" aria-label="End session">&#10005;</button></header><div class="terminal-pane-body"></div>';}
          return pane;
        }
        const split=document.createElement('div');split.className='terminal-branch';split.dataset.axis=node.axis;split.dataset.path=path;
        const grip=document.createElement('div');grip.className='pane-grip';grip.tabIndex=0;grip.dataset.path=path;grip.setAttribute('role','separator');grip.setAttribute('aria-label','Resize terminal panes');grip.setAttribute('aria-orientation',node.axis==='x'?'vertical':'horizontal');
        split.append(build(node.first,path+'0'),grip,build(node.second,path+'1'));return split;
      }
      root.replaceChildren(build(tree));root.dataset.tree=signature;
    }
    for(const branch of root.querySelectorAll('.terminal-branch')){
      const node=TL.at(w.tree,branch.dataset.path),[first,grip,second]=branch.children;
      first.style.flex=`${node.ratio} 1 0`;second.style.flex=`${1-node.ratio} 1 0`;
      const minimum=TL.minimum(node);branch.style.minWidth=minimum.width+'px';branch.style.minHeight=minimum.height+'px';
      grip.setAttribute('aria-valuenow',Math.round(node.ratio*100));grip.setAttribute('aria-valuemin','5');grip.setAttribute('aria-valuemax','95');
    }
    for(const pane of root.querySelectorAll('.terminal-pane')){
      const id=pane.dataset.id,view=terminalViews.get(id),body=pane.querySelector('.terminal-pane-body');pane.dataset.index=panes.indexOf(id);
      pane.classList.toggle('empty',!view);pane.classList.toggle('ended',!!view?.exited);pane.classList.toggle('attention',!!view?.attention);
      pane.querySelector('.pane-title').textContent=view?tabTitle(view)+(view.exited?' (ended)':''):'';
      if(view){if(view.element.parentElement!==body)body.replaceChildren(view.element);view.element.hidden=false;}
      else{const hidden=ctxWindows().filter(v=>v.hiddenPane),a=inAgentView()?selected():null;
        body.innerHTML=`<div class="terminal-placeholder"><div><p>${a?`No terminal for ${esc(title(a))} yet.`:'No terminal here yet.'}</p><div class="placeholder-actions">${a&&hasCli(a)?'<button type="button" class="secondary" data-action="terminal-cli">Agent CLI</button>':''}<button type="button" class="secondary" data-action="terminal-shell">+ Shell</button></div>${hidden.length?`<p>Hidden: ${hidden.map(v=>`<button type="button" class="text-button" data-pane-action="show" data-id="${esc(v.id)}">${esc(tabTitle(v))}</button>`).join(' ')}</p>`:''}</div></div>`;}
    }
    markPanes();renderArrange();
    for(const id of TL.leaves(tree)){const view=terminalViews.get(id);if(view)requestAnimationFrame(()=>{if(!view.exited)view.core.fitAndReport(view.report);else{try{view.fit.fit();}catch{}}});}
    if(focused&&!focused.element.hidden&&!focused.poppedOut)focused.term.focus();
  }
  // The glyph shows where the new terminal goes: the filled half.
  const splitItems=id=>[['right','Split right','&#9704;'],['below','Split below','&#11027;'],['left','Split left','&#9703;'],['above','Split above','&#11026;']].map(([direction,label,icon])=>({icon,label,run:()=>splitTerminal(id,direction)}));
  async function splitTerminal(id,direction){
    const view=terminalViews.get(id);if(!view)return;
    await openTerminal({sourceId:id,newSession:true,split:direction});
  }
  function maximizePane(id=currentTerminal){const w=workspace();w.maximized=w.maximized?'':id;renderPanes();focusCurrent();}
  function focusPane(direction){
    const w=workspace();if(w.maximized){w.maximized='';renderPanes();}
    const rects=[...paneRoot().querySelectorAll('.terminal-pane')].map(el=>{const r=el.getBoundingClientRect();return {id:el.dataset.id,left:r.left,right:r.right,top:r.top,bottom:r.bottom};});
    const id=direction==='next'||direction==='previous'?panes[(paneFocus+(direction==='next'?1:panes.length-1))%panes.length]:TL.neighbor(rects,currentTerminal,direction);
    activateTerminal(id);saveView();
  }
  function resizePane(grip,ratio){
    const node=TL.at(workspace().tree,grip.dataset.path);if(!node||node.id)return;
    const box=grip.parentElement,pixels=(node.axis==='x'?box.clientWidth:box.clientHeight)-7;
    node.ratio=TL.resize(node,ratio,pixels);renderPanes();
  }
  document.addEventListener('pointerdown',event=>{
    const grip=event.target.closest('#terminal-panes .pane-grip');if(!grip)return;event.preventDefault();
    const node=TL.at(workspace().tree,grip.dataset.path),rect=grip.parentElement.getBoundingClientRect();
    grip.setPointerCapture(event.pointerId);
    const move=e=>resizePane(grip,(node.axis==='x'?e.clientX-rect.left:e.clientY-rect.top)/((node.axis==='x'?rect.width:rect.height)-7));
    grip.addEventListener('pointermove',move);grip.addEventListener('lostpointercapture',()=>{grip.removeEventListener('pointermove',move);saveView();},{once:true});
  });
  document.addEventListener('keydown',event=>{
    const grip=event.target.closest('#terminal-panes .pane-grip');if(!grip)return;
    const node=TL.at(workspace().tree,grip.dataset.path),keys=node.axis==='x'?['ArrowLeft','ArrowRight']:['ArrowUp','ArrowDown'];
    if(!keys.includes(event.key))return;event.preventDefault();resizePane(grip,node.ratio+(event.key===keys[0]?-.05:.05));saveView();
  });
  // Ctrl/Cmd+Shift avoids AltGr and the shell's unmodified navigation keys.
  function paneShortcut(event){
    if(event.type!=='keydown'||event.altKey||!event.shiftKey||!(state.platform==='darwin'?event.metaKey:event.ctrlKey)||$('#app-dialog')||$('#terminal-panel').hidden)return false;
    const directions={ArrowLeft:'left',ArrowRight:'right',ArrowUp:'above',ArrowDown:'below',BracketLeft:'previous',BracketRight:'next'};
    const direction=directions[event.code||event.key];
    if(direction)focusPane(direction);else if(event.code==='Enter'||event.key==='Enter')maximizePane();else return false;
    event.preventDefault();event.stopPropagation();return true;
  }
  document.addEventListener('keydown',event=>{if(event.target.closest('.terminal-pane,.terminal-toolbar'))paneShortcut(event);},true);
  // focus: false when the change comes from elsewhere (a session ended, was renamed or started again, the selected agent
  // changed in the background); the keyboard then stays where the user is typing. bring: show this window on the screen in
  // use (it was hidden, or opened from another screen).
  function activateTerminal(id,{focus=true,bring=false}={}){
    const view=id&&terminalViews.get(id);
    if(view){if(bring){view.ctx=termCtx();view.hiddenPane=false;}if((view.ctx||'')===termCtx()&&!view.hiddenPane)currentTerminal=id;}
    else if(!id)currentTerminal='';
    renderPanes();if(!panes.includes(currentTerminal))currentTerminal=panes[paneFocus]||'';paneFocus=Math.max(0,panes.indexOf(currentTerminal));markPanes();
    for(const shown of panes){const v=terminalViews.get(shown);if(v&&v.attention){v.attention=false;}}
    const active=terminalViews.get(currentTerminal);if(!active)closeTerminalSearch();
    if(focus&&active&&!active.poppedOut)requestAnimationFrame(()=>{if(currentTerminal===active.id&&(active.ctx||'')===termCtx()&&!active.element.hidden&&!$('#terminal-panel').hidden)active.term.focus();});
  }
  function showWindow(id){$('#terminal-panel').hidden=false;activateTerminal(id,{bring:true});saveView();render();}
  function hideWindow(id){
    const view=terminalViews.get(id);if(!view)return;view.hiddenPane=true;workspace().maximized='';if(currentTerminal===id)currentTerminal='';
    activateTerminal(currentTerminal,{focus:false});
    // The last window out of sight closes the panel; Terminal or the hidden windows bring it back.
    if(!panes.filter(Boolean).length&&!document.body.classList.contains('terminal-stage'))$('#terminal-panel').hidden=true;
    saveView();render();
  }
  async function endWindow(id){
    const view=terminalViews.get(id);if(!view)return;
    if(!view.exited&&!await ask(`End ${tabTitle(view)}?\n\nIts program stops. Hide the window instead to keep it running.`))return;
    await closeTerminalTab(id);render();
  }
  // Where the keyboard is: in a live terminal on screen (someone is typing there), or in another text field.
  function viewOf(element){const el=element?.closest?.('.terminal-view');return el?[...terminalViews.values()].find(v=>v.element===el):null;}
  function typingInTerminal(){const v=viewOf(document.activeElement);return !!v&&!v.exited&&!v.poppedOut&&!v.element.hidden&&!$('#terminal-panel').hidden;}
  function typingElsewhere(){const el=document.activeElement;return !!el&&el!==document.body&&!viewOf(el)&&(el.isContentEditable||/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));}
  function focusCurrent(){const v=terminalViews.get(currentTerminal);if(v&&!v.poppedOut&&!v.element.hidden&&!$('#terminal-panel').hidden)v.term.focus();}
  // The panel follows the selected context and restores that context's active pane, dock position and visibility.
  let termCtxShown=null;
  function syncTerminalContext(){
    const ctx=termCtx();if(ctx===termCtxShown)return;
    if(termCtxShown!==null)workspace(termCtxShown).active=currentTerminal;
    termCtxShown=ctx;const w=workspace(ctx);currentTerminal=w.active;layout.terminal=w.dock;
    $('#terminal-panel').hidden=!(document.body.classList.contains('terminal-stage')||w.visible);
    placePanes();activateTerminal(currentTerminal,{focus:false});
  }
  // The keyboard goes back to the terminal it was in when a menu over it closed by itself (the window lost focus) and the
  // window comes back: focus was left on the page, and typing went nowhere until the terminal was clicked again.
  let keyboardIn='';
  document.addEventListener('focusin',event=>{if(event.target.closest?.('.context-menu,.terminal-toolbar'))return;keyboardIn=viewOf(event.target)?.id||'';});
  document.addEventListener('pointerdown',event=>{if(!event.target.closest?.('.terminal-view,.context-menu,.terminal-toolbar'))keyboardIn='';},true);
  window.addEventListener('focus',()=>setTimeout(()=>{if(document.activeElement&&document.activeElement!==document.body||$('#app-dialog'))return;const v=terminalViews.get(keyboardIn);if(v&&!v.poppedOut&&!v.element.hidden&&!$('#terminal-panel').hidden)v.term.focus();},0));
  // Where a new terminal next to `view` opens: the same agent, the same machine, or this computer.
  function terminalTarget(view){
    const id=view?.agentId||'';
    if(state.agents.some(a=>a.id===id))return {agentId:id};
    if(id.startsWith('host_')&&state.hosts.some(h=>h.id===id.slice(5)))return {hostId:id.slice(5)};
    return {local:true};
  }
  // Tab names: an agent's CLI is just the agent; shells say so.
  const tabTitle=v=>String(v.title||'').replace(/ \/ agent$/,' · CLI').replace(/ \/ shell$/,' \u00b7 shell');
  const inAgentView=()=>!overview&&!opayaView&&!playgroundView&&!!selected();
  // What a new terminal can be: an agent's CLI (in the open chat's project), a shell for that agent, this computer or a
  // saved machine.
  function newTerminalItems(view=null){
    const a=view?state.agents.find(x=>x.id===view.agentId):inAgentView()?selected():null;
    const p=a&&!view?projectOf(currentConversation()):null,project=a&&p&&fitsProject(a,p)?p:null,where=project?` in ${project.name}`:'';
    const go=target=>openTerminal({...target,newSession:true});
    return [
      a&&hasCli(a)&&{icon:'&#10095;',label:`${title(a)} CLI${where}`,run:()=>go({agentId:a.id,mode:'agent',projectId:project?.id})},
      a&&{icon:'&gt;_',label:`Shell: ${title(a)}${where}`,run:()=>go({agentId:a.id,projectId:project?.id})},
      !a&&view&&view.agentId.startsWith('host_')&&{icon:'&gt;_',label:`Shell: ${tabTitle(view).replace(/ \u00b7 shell$/,'')}`,run:()=>go(terminalTarget(view))},
      {icon:'&#9635;',label:`Shell: ${localName()}`,run:()=>go({local:true})},
      ...state.hosts.filter(h=>!(view&&view.agentId==='host_'+h.id)).map(h=>({icon:'&#9635;',label:`Shell: ${h.name}`,run:()=>go({hostId:h.id})}))
    ];
  }
  // Sessions from before a restart keep their output; they wait here instead of opening a window each.
  const savedSessions=new Map();
  function terminalMoreMenu(){
    const view=terminalViews.get(currentTerminal),finished=[...terminalViews.values()].filter(v=>v.exited),zoom=step=>()=>{zoomTerminals(step);focusCurrent();};
    return [
      view&&{icon:'&#9906;',label:'Find...',hint:`${mod()}F`,run:()=>openTerminalSearch()},
      view&&{icon:'&#9998;',label:'Rename...',run:()=>renameTerminal(view.id)},
      view&&!view.exited&&{icon:'&#10697;',label:'Open in separate window',run:()=>popoutTerminal(view.id)},
      view&&{icon:'&#9645;',label:'Hide (keeps running)',run:()=>hideWindow(view.id)},
      savedSessions.size&&{icon:'&#9776;',label:'Saved output',submenu:[...savedSessions.values()].map(t=>({icon:'&gt;_',label:tabTitle(t),run:()=>{savedSessions.delete(t.id);return openTerminal({terminalId:t.id});}}))},
      windowsMenu().length&&{icon:'&#9776;',label:'Windows',submenu:windowsMenu()},
      finished.length&&{icon:'&#10003;',label:`Close ended windows (${finished.length})`,run:()=>closeFinished()},
      {icon:'A',label:'Text size',submenu:[{icon:'+',label:'Larger',hint:`${mod()}+`,run:zoom(1)},{icon:'-',label:'Smaller',hint:`${mod()}-`,run:zoom(-1)},{icon:'0',label:'Reset',hint:`${mod()}0`,run:zoom(0)}]},
      view&&'-',
      view&&{icon:'&#10005;',label:view.exited?'Close saved output':'End session',danger:!view.exited,run:()=>endWindow(view.id)}
    ];
  }
  async function closeFinished(){for(const v of [...terminalViews.values()])if(v.exited)await closeTerminalTab(v.id);}
  function zoomTerminals(step){
    const first=[...terminalViews.values()][0],size=step?Math.max(8,Math.min(28,(first?.term.options.fontSize||13)+step)):13;
    applyFont(size);
  }
  // The text size of every terminal, kept with the saved view.
  function applyFont(size){if(terminalFont!==size){terminalFont=size;saveView();}for(const v of terminalViews.values()){v.core.setFont(size);if(v.poppedOut||v.element.hidden)continue;requestAnimationFrame(()=>{if(v.exited){try{v.fit.fit();}catch{}}else v.core.fitAndReport(v.report);});}}
  // A toolbar menu opens under its button, right-aligned, or above it when there is no room below.
  function openToolbarMenu(button,items,label){
    const r=button.getBoundingClientRect();openMenu(r.left,r.bottom+4,items,label,button);
    const m=menu?.element;if(!m)return;const w=m.offsetWidth,h=m.offsetHeight,up=r.bottom+4+h>innerHeight-8;
    m.style.left=Math.max(8,Math.min(r.right-w,innerWidth-w-8))+'px';m.style.top=Math.max(8,up?r.top-4-h:r.bottom+4)+'px';m.style.transformOrigin=`100% ${up?'100%':'0'}`;
  }
  // Right-click inside a terminal: clipboard, a terminal beside this one, and the session. Shift + right-click keeps the
  // quick copy-or-paste. The selection is read when the menu opens: programs that redraw can clear it before Copy.
  function terminalContextMenu(event,view){
    const pane=event.target.closest('.terminal-pane'),index=pane?Number(pane.dataset.index):paneFocus;
    if(pane&&index!==paneFocus){paneFocus=index;currentTerminal=panes[index]||'';markPanes();}
    const text=view?view.core.selection():'';
    // The menu takes the keyboard while it is open; Copy, Paste, Select all and Clear give it back to the terminal.
    const back=run=>()=>{run();if(!view.poppedOut)view.term.focus();};
    const items=[
      view&&{icon:'&#10697;',label:'Copy',hint:text?`${mod()}Shift+C`:state.platform==='darwin'?'Option+drag selects':'Shift+drag selects',disabled:!text,run:back(()=>{view.core.copy(text);view.term.clearSelection();})},
      view&&!view.exited&&{icon:'&#8615;',label:'Paste',hint:`${mod()}V`,run:back(()=>view.core.paste())},
      view&&{icon:'&#9633;',label:'Select all',run:back(()=>view.term.selectAll())},
      view&&{icon:'&#9906;',label:'Find...',hint:`${mod()}F`,run:()=>openTerminalSearch()},
      view&&{icon:'&#8634;',label:'Clear',run:back(()=>view.term.clear())},
      ...(()=>{const who=view&&(state.agents.find(x=>x.id===view.agentId)||(inAgentView()?selected():null));return who&&who.protocol!=='terminal'&&who.surface!=='terminal'?[{icon:'&#9993;',label:`Ask ${title(who)} about this`,disabled:!text,hint:text?'':'Select text first',run:()=>action(()=>askInChat(who,text))}]:[];})(),
      '-',
      {icon:'&#9707;',label:'New window',submenu:newTerminalItems(view)},
      view&&{label:'Split terminal',submenu:splitItems(view.id)},
      view&&{label:workspace().maximized?'Restore panes':'Maximize pane',run:()=>maximizePane(view.id)},
      windowsMenu().length&&{icon:'&#9776;',label:'Windows',submenu:windowsMenu()},
      '-',
      view&&{icon:'&#9998;',label:'Rename...',run:()=>renameTerminal(view.id)},
      view&&!view.exited&&{icon:'&#10697;',label:'Open in separate window',run:()=>popoutTerminal(view.id)},
      view&&{icon:'&#9645;',label:'Hide (keeps running)',run:()=>hideWindow(view.id)},
      view&&{icon:'&#10005;',label:view.exited?'Close saved output':'End session',danger:!view.exited,run:()=>endWindow(view.id)}
    ];
    openMenu(event.clientX,event.clientY,items,view?tabTitle(view):'Terminal',pane);
  }
  // The agent's own CLI below the chat (a shell for API-only agents), in the chat's project folder: Ctrl+` and the
  // terminal switch's right-click menu.
  function agentTerminal(){
    if(!inAgentView())return openTerminal({local:true});
    const a=selected(),p=projectOf(currentConversation());
    return openTerminal({agentId:a.id,mode:hasCli(a)?'agent':'shell',projectId:p&&fitsProject(a,p)?p.id:undefined});
  }
  $('#terminal-views').addEventListener('contextmenu',event=>{
    if(event.target.closest('.terminal-pane-head'))return;
    const pane=event.target.closest('.terminal-pane');if(!pane)return;event.preventDefault();event.stopPropagation();
    terminalContextMenu(event,terminalViews.get(panes[Number(pane.dataset.index)]));
  });
  // A click on the panel around the terminals (a pane's title bar, the tab strip, a gap) keeps the keyboard in a terminal:
  // that pane's, or the one in use. Focus used to fall to the page there, and typing went nowhere.
  $('#terminal-panel').addEventListener('mousedown',event=>{
    if(event.button!==0||event.defaultPrevented||event.target.closest('.xterm,button,input,select,textarea,a,[tabindex],[contenteditable="true"],.pane-grip,.terminal-search'))return;
    const pane=event.target.closest('.terminal-pane'),view=terminalViews.get(pane?panes[Number(pane.dataset.index)]:currentTerminal);
    if(view&&!view.poppedOut){event.preventDefault();view.term.focus();}
  });
  // background: only add a tab (a terminal the service opened while someone types in another one). focus: false leaves the
  // keyboard, and an open dialog, where they are (someone typing in the chat box or a form).
  async function openTerminal({agentId=selected()?.id,hostId,mode='shell',local=false,terminalId,restoring=false,split=null,sourceId,newSession=false,projectId,background=false,focus=true,ctx}={}){
    const source=sourceId&&terminalViews.get(sourceId),context=ctx??source?.ctx??termCtx(),target=sourceId||currentTerminal;
    if(!agentId&&!hostId&&!local&&!terminalId&&!sourceId){toast('Select an agent, or open a machine from Machines.');return;}
    if(typeof window.Terminal!=='function'||!window.FitAddon||!window.OpayaTerminal){toast('The terminal UI did not load. Reinstall the complete Opaya build rather than moving the executable out of its installation folder.',true);return;}
    if(!restoring&&!background){if(focus)closeModal();$('#terminal-panel').hidden=false;}
    const a=local?null:state.agents.find(a=>a.id===agentId),h=state.hosts.find(h=>h.id===hostId);
    const active=terminalViews.get(currentTerminal),size=active&&!active.exited?{cols:active.term.cols,rows:active.term.rows}:{};
    const result=terminalId?await api.terminalAttach({id:terminalId}):await api.terminalOpen({agentId:hostId||local?undefined:agentId,hostId,mode,local,projectId,sourceId,newSession,...size});
    if(!terminalViews.has(result.id)){
      const element=document.createElement('div');element.className='terminal-view';$('#terminal-views').append(element);
      const archived=!!result.exited;
      const core=window.OpayaTerminal.create(element,{id:result.id,archived,fontSize:terminalFont,windowsBuild:result.windowsBuild||0,light:theme==='light',onSearch:()=>openTerminalSearch(),onContextMenu:event=>terminalContextMenu(event,terminalViews.get(result.id)),onZoom:applyFont,onRestart:()=>action(()=>restartTerminal(result.id)),onNotice:(text,error)=>toast(text,error)}),{term,fit}=core;
      const report=(cols,rows)=>action(()=>api.terminalResize({id:result.id,cols,rows}));
      const owner=result.agentId||a?.id||'',view={id:result.id,agentId:owner,ctx:restoring?(state.agents.some(x=>x.id===owner)?owner:''):context,order:++termOrder,hiddenPane:false,mode:result.mode||mode,remote:result.remote,title:result.title||`${a?title(a):h?.name||(local?'This computer':'SSH')} / ${mode}`,term,fit,core,report,element,exited:!!result.exited,lastSeq:result.seq||0};terminalViews.set(result.id,view);
      // Typing goes to the live session in pieces the service accepts (a large paste used to be refused whole), in order.
      // An ended session takes none until it starts again (Enter, restartTerminal).
      term.onData(data=>{if(view.exited||view.poppedOut)return;for(const part of window.OpayaTerminal.chunks(data))action(()=>api.terminalWrite({id:result.id,data:part}));});
      let timer;const observer=new ResizeObserver(()=>{clearTimeout(timer);timer=setTimeout(()=>{if(element.hidden||view.poppedOut||view.exited||$('#terminal-panel').hidden)return;core.fitAndReport(report);},60);});observer.observe(element);view.observer=observer;
      // Reattaching replays saved output drawn at another size. Nudge the size once so full-screen programs repaint.
      if(result.buffer)term.write(result.buffer,()=>{if(!archived&&(result.mode==='agent'||result.buffer.includes('\x1b[?1049h'))){requestAnimationFrame(()=>{if(!core.fitAndReport(report))return;});setTimeout(()=>{if(view.exited)return;report(term.cols,Math.max(5,term.rows-1));setTimeout(()=>report(term.cols,term.rows),120);},250);}});
      if(archived)term.write(window.OpayaTerminal.endedNote(view));
      for(const event of terminalPending.get(result.id)||[])terminalEvent(event);terminalPending.delete(result.id);
    }
    if(split){const w=workspace(context);w.tree=TL.split(w.tree,target,result.id,split);w.maximized='';}
    if(context!==termCtx()&&!restoring){render();saveView();return result.id;}
    // Opened in the background (someone types in another terminal): its window appears, marked, and takes no keyboard.
    if(background&&(terminalViews.get(result.id)?.ctx||'')!==termCtx()){terminalViews.get(result.id).attention=true;render();saveView();return result.id;}
    if(background){const view=terminalViews.get(result.id),keep=currentTerminal;view.attention=true;activateTerminal(result.id,{focus:false,bring:true});activateTerminal(keep,{focus:false});render();saveView();return result.id;}
    activateTerminal(result.id,{focus,bring:!restoring});if(!restoring){render();saveView();}
    return result.id;
  }
  // Enter in an ended session starts it again in its tab: a remote one reattaches to its tmux session, which usually kept
  // running on the host when the SSH connection dropped. Saved output from before a restart of Opaya works the same way.
  async function restartTerminal(id){
    const view=terminalViews.get(id);if(!view||!view.exited||view.poppedOut||view.restarting)return;view.restarting=true;
    try{
      const r=await api.terminalRestart({id,cols:view.term.cols,rows:view.term.rows});
      // Normally the 'restarted' event came first; this covers it arriving later.
      if(view.exited&&r.seq>view.lastSeq){view.exited=false;view.core.setLive(true);activateTerminal(currentTerminal,{focus:false});}
    }finally{view.restarting=false;}
  }
  function terminalEvent(event){
    // A terminal the service opens (an install, an update, a command of the Opaya Agent) is shown, but it no longer takes the
    // pane and the keyboard from someone typing in another terminal: it waits in a tab. Typing in the chat box or a form
    // keeps the keyboard there.
    if(event.type==='opened'){
      // A terminal opened for another screen (the Opaya Agent's command while you look at Hermes) stays on that screen.
      if(event.owner!==undefined&&event.owner!==termCtx()){const view=terminalViews.get(event.id),who=event.owner==='opaya'?'The Opaya Agent':title(state.agents.find(x=>x.id===event.owner)||{name:'An agent'});
        if(!view)action(()=>openTerminal({terminalId:event.id,background:true,focus:false,ctx:event.owner}));else{view.ctx=event.owner;view.attention=true;}
        toast(`${who} opened a terminal on its screen.`);return;}
      const typing=typingInTerminal()?viewOf(document.activeElement):null,busy=!!typing&&typing.id!==event.id,focus=!busy&&!typingElsewhere(),view=terminalViews.get(event.id);
      if(!view){action(()=>openTerminal({terminalId:event.id,background:busy,focus}));return;}
      if(busy){const keep=currentTerminal;view.attention=true;activateTerminal(event.id,{focus:false,bring:true});activateTerminal(keep,{focus:false});return;}
      $('#terminal-panel').hidden=false;activateTerminal(event.id,{focus,bring:true});return;
    }
    if(event.type==='renamed'){const view=terminalViews.get(event.id);if(view){view.title=event.title;activateTerminal(currentTerminal,{focus:false});}return;}
    if(event.type==='warning'){toast(event.error,true);return;}
    const view=terminalViews.get(event.id);
    if(!view){const pending=terminalPending.get(event.id)||[];if(pending.length<100)pending.push(event);terminalPending.set(event.id,pending);return;}
    if(event.seq&&event.seq<=view.lastSeq)return;view.lastSeq=event.seq||view.lastSeq;
    if(event.type==='data')view.term.write(event.data);
    if(event.type==='exit'){view.exited=true;view.core.setLive(false);view.term.write(window.OpayaTerminal.endedNote(view,event.exitCode));activateTerminal(currentTerminal,{focus:false});}
    // Started again (here or in its separate window): it takes typing again, except in the docked copy of a popped-out one.
    if(event.type==='restarted'){view.exited=false;view.core.setLive(true);view.term.options.disableStdin=!!view.poppedOut;activateTerminal(currentTerminal,{focus:false});}
  }
  document.addEventListener('click',event=>{
    const button=event.target.closest('[data-action]');if(!button)return;const {action:name,id,index}=button.dataset;
    if(name==='modal-close'){closeModal();return;}
    if(name==='opaya'){overview=false;opayaView=true;playgroundView=false;closeModal();render();saveView();$('#message-input')?.focus();return;}
    if(name==='opaya-config'){openOpayaConfig();return;}
    if(name==='opaya-free'){openFreeModel();return;}
    if(name==='guide-open'){closeModal();startGuide();return;}
    if(name==='toggle-group'){toggleGroup(button.dataset.group);return;}
    if(name==='diagnostics'){openDiagnostics(id);return;}
    if(name==='skills'){openSkills(id);return;}
    if(name==='updates'){openUpdates();return;}
    if(name==='tool-updates'){openToolUpdates();return;}
    if(name==='tool-check'){action(async()=>{button.disabled=true;button.textContent='Checking...';await api.toolCheckAll();await refresh();openToolUpdates();});return;}
    if(name==='tool-update'||name==='tool-update-selected'){
      const ids=name==='tool-update-selected'?[...(button.closest('.tool-machine')?.querySelectorAll('input.tool-pick:checked')||[])].map(x=>x.dataset.id):null;if(ids&&!ids.length)return;
      action(async()=>{const n=await api.toolUpdate(ids?{ids,hostId:button.dataset.host||undefined}:{id,hostId:button.dataset.host||undefined});if(n){closeModal();toast(`${n===1?'Update':`${n} updates`} running in the Updates terminal below. Opaya checks the versions afterwards; if one does not take, the Opaya Agent finishes it.`);}});return;}
    if(name==='dock-move'){moveDock(button.dataset.pane);return;}
    if(name==='new-vps'){openNewVps();return;}
    if(name==='job-restore'){const running=[...jobs.values()].filter(j=>j.status==='running');if(!jobs.has(jobShown))jobShown=(running[0]||[...jobs.values()].at(-1))?.id||'';jobMinimized=false;renderJobs();return;}
    if(name==='opaya-chat'){if(guideOn()){if(!opaya().configured){toast('Choose a model for the Opaya Agent first: the guide gets you one, or pick it in Model.');openOpayaConfig();return;}closeGuide();}overview=false;opayaView=true;playgroundView=false;render();saveView();$('#message-input')?.focus();return;}
    if(name==='opaya-session'){action(async()=>{await api.opayaSelectSession({id});opayaCount=-1;});return;}
    if(name==='opaya-new'){action(async()=>{await api.opayaNewSession();opayaCount=-1;$('#message-input')?.focus();});return;}
    if(name==='opaya-delete-session'){const o=opaya();action(async()=>{if(!await ask('Delete this chat with the Opaya Agent?'))return;await api.opayaDeleteSession({id:o.sessionId});opayaCount=-1;});return;}
    if(name==='discover-tab'){discover(id||undefined);return;}
    if(name==='discover-install'){if(button.dataset.host){confirmInstall(button.dataset.fw,button.dataset.host);return;}action(async()=>{const r=await api.installFramework({id:button.dataset.fw,hostId:button.dataset.host||undefined});closeModal();if(r?.kind==='toolchain'){onJob(r);toast('Opaya is installing it from the official download.');return;}toast('Installing in Terminal. Discover again when it finishes.');});return;}
    if(name==='clone-install'){action(async()=>{await api.installFramework({id:'hermes',hostId:button.dataset.host||undefined});toast('Installing Hermes in Terminal. Clone again when it finishes.');});return;}
    if(name==='itrust-agent'){const a=state.agents.find(x=>x.id===id);if(a)toggleAgentTrust(a);return;}
    if(name==='opaya-itrust'){action(async()=>{const on=!state.settings?.itrustOpaya;if(on&&!await ask('Turn on iTrust for the Opaya Agent?\n\nIt will install, connect and change things without asking each time. Removing connections or machines still asks.'))return;await api.saveSettings({itrustOpaya:on});await refresh();toast(on?'iTrust is on for the Opaya Agent.':'iTrust is off for the Opaya Agent.');});return;}
    if(name==='browser-open'||name==='browser-toggle'){const p=$('#browser-panel');if(name==='browser-toggle'&&!p.hidden){p.hidden=true;$('#browser-toggle')?.classList.remove('selected');return;}showBrowser();$('#browser-toggle')?.classList.add('selected');$('#browser-url').focus();return;}
    if(name==='projects-toggle'){toggleProjects();return;}
    if(name==='project-focus'){projectsExpanded.add(id);toggleProjects(true);return;}
    if(name==='mcp-manage'){openMcpManager();return;}
    if(name==='library'){openLibrary();return;}
    if(name==='history-toggle'){toggleHistory();return;}
    if(name==='transfer'){const a=state.agents.find(x=>x.id===button.dataset.id);if(a)openTransfer(a);return;}
    if(name==='playground'){overview=false;opayaView=false;playgroundView=true;closeModal();render();saveView();$('#message-input')?.focus();return;}
    if(name==='pg-swap'){pgAgents.reverse();render();return;}
    if(name==='tag-filter'){tagFilter=button.dataset.tag===tagFilter?'':button.dataset.tag;renderKey='';render();return;}
    if(name==='group-tags'){const a=state.agents.find(a=>a.id===id);if(a)openGroupTags(a);return;}
    if(name==='files-agent'){const a=state.agents.find(a=>a.id===id);if(a)openFiles({agentId:a.id,label:`${title(a)} / ${location(a)}`});return;}
    if(name==='files-local'){openFiles({label:'This computer'});return;}
    if(name==='host-files'){const h=state.hosts.find(h=>h.id===id);if(h){closeModal();openFiles({hostId:h.id,label:`${h.name} over SSH`});}return;}
    if(name==='opaya-starter'){const input=$('#message-input');if(input){input.value=button.dataset.text;opayaDraft=input.value;sendOpaya();}return;}
    if(name==='install-catalog'){openInstall(button.dataset.host||'');return;}
    if(name==='install-target'){openInstall(id||'');return;}
    if(name==='install-recheck'){action(async()=>{button.disabled=true;button.textContent='Checking...';await api.toolVersions({hostId:button.dataset.host||undefined,force:true});await refresh();openInstall(button.dataset.host||'',true);});return;}
    if(name==='install-framework'){confirmInstall(id,button.dataset.host||'');return;}
    if(name==='install-runtime'){confirmInstall(id,button.dataset.host||'',button.dataset.runtime||'');return;}
    if(name==='icon-picker'){const a=state.agents.find(a=>a.id===id);if(a)openIconPicker(a);return;}
    if(name==='overview'){overview=true;fleetView=false;opayaView=false;playgroundView=false;render();saveView();return;}
    if(name==='add'){openAdd();return;}
    if(name==='manual'){openAgentForm();return;}
    if(name==='edit'){openAgentForm(state.agents.find(a=>a.id===id));return;}
    if(name==='agent-menu'){const a=state.agents.find(a=>a.id===id);if(a){const r=button.getBoundingClientRect();openMenu(r.left,r.bottom+4,agentMenu(a),title(a),button.closest('[data-agent-id]'));}return;}
    if(name==='hosts'){openHosts();return;}
    if(name==='manage'){openManage(id);return;}
    if(name==='agent-machine'){const a=selected();if(a)openFleet(dockerKeyOf(a));return;}
    if(name==='chat-terminal'){openToolbarMenu(button,[{label:'Show terminal beside chat',run:()=>showTerminalWithChat('right')},{label:'Show terminal below chat',run:()=>showTerminalWithChat('bottom')}],'Terminal placement');return;}
    if(name==='agent-section'){const a=selected();if(a)action(()=>openManage(a.id,button.dataset.key||'overview'));return;}
    if(name==='an-sub'){const a=selected(),sec=button.dataset.section,k=button.dataset.key;if(!a)return;
      if(k==='export'){button.dataset.action='export';button.click();button.dataset.action='an-sub';return;}
      action(async()=>{const view=sec==='chat'||sec==='console';if(!view&&!(manageId===a.id&&mgSection===sec))await openManage(a.id,sec);
        // Its row on the page shows which setting this is; then the action runs (a dialog, a switch, a terminal).
        const row=!view&&document.querySelector(`#content .set-row[data-key="${CSS.escape(k)}"]`);if(row){row.scrollIntoView({block:'center',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});row.classList.remove('flash');void row.offsetWidth;row.classList.add('flash');}
        const item=(row&&manageKeyed[k])||manageActions(a)[k];if(item&&!item.disabled)await item.run();});return;}
    if(name==='an-term'){showWindow(id);return;}
    if(name==='an-pop'){const c=state.conversations.find(x=>x.id===id),a=c&&state.agents.find(x=>x.id===c.agentId);if(a)action(()=>openChatWindow(a,c.id));return;}
    if(name==='an-chat'){action(()=>openProjectChat(id));return;}
    if(name==='an-new-chat'){const a=state.agents.find(x=>x.id===id);if(a)action(async()=>{await api.newConversation({agentId:a.id});state=await api.snapshot();await setAgentMode(a,'chat');$('#message-input')?.focus();});return;}
    if(name==='an-connect'){const a=state.agents.find(x=>x.id===id),c=a&&agentActions(a).connect;if(c&&!c.disabled)action(()=>c.run());return;}
    if(name==='mg-jump'){const el=document.getElementById(button.dataset.target);if(el)el.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'start'});return;}
    if(name==='agent-mode'){const a=state.agents.find(x=>x.id===id);if(a)action(()=>setAgentMode(a,button.dataset.mode));return;}
    if(name==='chat-new'){const a=state.agents.find(x=>x.id===id);if(a)action(()=>newDockChat(a));return;}
    if(name==='chat-open'){const c=dockConv(id),a=c&&state.agents.find(x=>x.id===c.agentId);if(a)action(()=>openChatWindow(a,c.id));return;}
    if(name==='redeploy-copy'){const a=state.agents.find(x=>x.id===id);if(a)redeploy(a);return;}
    if(name==='deploy'){const a=state.agents.find(x=>x.id===id);if(a)action(()=>deployTo(a,button.dataset.deployHost||'',button.dataset.deployRuntime||'regular',$('.mg-card')||button,button));return;}
    if(name==='dockerize'){const a=state.agents.find(x=>x.id===id),cta=button.closest('.mg-dockerize');if(a)action(()=>deployTo(a,cta?.dataset.deployHost||'','docker',$('.mg-card')||button,cta||button));return;}
    if(name==='docker-inspect'){dockerInspect(id,button.dataset.name);return;}
    if(name==='docker-prune'){dockerDo(id,'','prune');return;}
    if(name==='docker-live'){const v=dockerViews.get(id);if(v){v.statsOff=!button.checked;if(button.checked)loadDockerStats(id);}return;}
    if(name==='git-run'){const p=(state.projects||[]).find(x=>x.id===id);if(p)action(()=>pushProject(p,button.dataset.git,button));return;}
    if(name==='git-more'){const p=(state.projects||[]).find(x=>x.id===id);if(p){const r=button.getBoundingClientRect();openMenu(r.left,r.bottom+4,gitMenu(p),p.name);}return;}
    if(name==='project-chat'){const p=(state.projects||[]).find(x=>x.id===id);if(p)action(()=>startProjectChat(p,button.dataset.agent));return;}
    if(name==='key-menu'){keyMenu(button,id);return;}
    if(name==='terminal-arrange'){setArrange(button.dataset.arrange);return;}
    if(name==='terminal-hidden'){openToolbarMenu(button,windowsMenu(),'Windows');return;}
    if(name==='send-key'){action(async()=>{await api.saveSettings({sendKey:button.dataset.value});await refresh();openSettings();toast(button.dataset.value==='mod-enter'?`${mod()}Enter sends; Enter starts a new line.`:'Enter sends; Shift+Enter starts a new line.');});return;}
    if(name==='font-step'){const size=Math.max(8,Math.min(28,terminalFont+Number(button.dataset.step)));applyFont(size);const out=$('#settings-font');if(out)out.textContent=size+'px';return;}
    if(name==='terminal-place'){if((layout.terminal==='right'?'right':'bottom')!==button.dataset.value)moveDock('terminal');openSettings();return;}
    if(name==='open-data-folder'){action(()=>api.openDataFolder());return;}
    if(name==='ws-status'){wsStatus=button.dataset.value||'';renderKey='';render();return;}
    if(name==='ws-place'){wsPlace=button.dataset.value||'';renderKey='';render();return;}
    if(name==='ws-clear'){wsQuery='';wsStatus='';wsPlace='';tagFilter='';renderKey='';render();return;}
    if(name==='card-connect'){const a=state.agents.find(x=>x.id===id);if(a)action(()=>a.status==='connected'?api.disconnect({id}):api.connect({id}));return;}
    if(name==='card-terminal'){const a=state.agents.find(x=>x.id===id);if(a)action(()=>openTerminal(hasCli(a)?{agentId:a.id,mode:'agent'}:{agentId:a.id}));return;}
    if(name==='card-fix'){const a=state.agents.find(x=>x.id===id);if(a)action(()=>askOpayaToFix(a));return;}
    if(name==='disconnect-all'){action(async()=>{const on=state.agents.filter(a=>a.status==='connected'||a.status==='connecting');for(const a of on)await api.disconnect({id:a.id}).catch(()=>{});toast(on.length?`${on.length} agent${on.length===1?'':'s'} disconnected. Chats stay.`:'No agent was connected.');});return;}
    if(name==='opaya-check-all'){const broken=state.agents.filter(a=>a.error);if(broken.length)action(async()=>{await api.opayaSend({text:`These agents have errors: ${broken.map(a=>`${title(a)} (agent_id ${a.id}, ${a.provider} on ${location(a)}): ${a.error}`).join('; ')}. Check each one end to end and fix what keeps it from working. Tell me what you found and what you changed.`});overview=false;opayaView=true;playgroundView=false;manageId='';render();saveView();});return;}
    if(name==='transfer-pick'){const a=selected()||state.agents[0];if(a)openTransfer(a);return;}
    if(name==='compose-secret'){const a=selected();if(a)openAgentKeys(a);return;}
    if(name==='dsh-web'){const a=selected();if(!a)return;button.disabled=true;toast('Starting the DeepSeek Harness Web UI...');action(async()=>{try{const r=await api.agentWeb({id:a.id});await openInBrowser(r.url);}finally{button.disabled=false;}});return;}
    if(name==='compose-attach'){action(async()=>{const files=await api.pickFiles();if(files?.length)addFiles(files);});return;}
    if(name==='compose-unattach'){const key=draftKey(),files=(composeFiles.get(key)||[]).slice();files.splice(Number(button.dataset.index),1);composeFiles.set(key,files);renderComposeFiles();render();return;}
    if(name==='compose-model'){if(pickerFor===button){closePicker();return;}openModelPicker(button);return;}
    if(name==='compose-effort'){if(pickerFor===button){closePicker();return;}openEffortPicker(button);return;}
    if(name==='manage-nav'){openManagePop(button);return;}
    if(name==='manage-agents'){const target=selected()||state.agents[0];if(target)openManage(target.id);else{toast('Add an agent first: Install agents or Discover.');openInstall('');}return;}
    if(name==='fleet-focus'){if(event.target.closest('[data-action="fleet-machine-menu"]'))return;fleetFocus=id;if(!dockerViews.has(id))loadDocker(id);render();return;}
    if(name==='fleet-agent-menu'){const a=state.agents.find(x=>x.id===id);if(a)fleetAgentMenu(a,button);return;}
    if(name==='fleet-machine-menu'){fleetMachineMenu(id,button);return;}
    if(name==='sidebar-hide'){toggleSidebar(true);return;}
    if(name==='sidebar-rail'){toggleRail();return;}
    if(name==='rail-set'){toggleRail(button.dataset.value==='rail');openSettings();return;}
    if(name==='fleet'){openFleet();return;}
    if(name==='project-remote'){const p=(state.projects||[]).find(x=>x.id===id);if(p)openProjectAgents(p);return;}
    if(name==='copy-send'||name==='copy-bring'){const p=(state.projects||[]).find(x=>x.id===id),a=state.agents.find(x=>x.id===button.dataset.agent);if(p&&a)action(()=>name==='copy-send'?sendToRemote(p,a):bringFromRemote(p,a));return;}
    if(name==='manage-run'){const item=manageKeyed[button.dataset.key];if(item&&!item.disabled)action(()=>item.run());return;}
    // The same actions for a given agent, from anywhere (its chat, a banner): looked up for that agent, never a cached screen.
    if(name==='agent-run'){const a=state.agents.find(x=>x.id===id),item=a&&manageActions(a)[button.dataset.key];if(item&&!item.disabled)action(()=>item.run());return;}
    if(name==='local-machine'){openLocalMachine();return;}
    if(name==='docker-manager'){openDocker(id);return;}
    if(name==='docker-refresh'){loadDocker(id);return;}
    if(name==='docker-machine'){const box=$('#docker-manager');if(box){box.dataset.key=id;box.innerHTML=dockerBody(id);loadDocker(id);dockerTick();}return;}
    if(name==='docker-logs'){dockerLogs(id,button.dataset.name);return;}
    if(name==='docker-logs-refresh'){dockerLogs(id,button.dataset.name,false);return;}
    if(name==='docker-port'){action(()=>api.openLink({url:`http://localhost:${Number(button.dataset.port)}`}));return;}
    if(name==='docker-do'){dockerDo(id,button.dataset.name,button.dataset.do);return;}
    if(name==='docker-terminal'){closeModal();action(()=>api.dockerTerminal({hostId:id==='local'?undefined:id,container:button.dataset.name,kind:button.dataset.kind}));return;}
    if(name==='update-all'){action(updateAll);return;}
    if(name==='backup-reveal'){action(()=>api.revealBackup({file:button.dataset.file}));return;}
    if(name==='backup-folder-open'){action(()=>api.revealBackup({folder:true}));return;}
    if(name==='backup-folder-change'){action(async()=>{const dir=await api.pick({kind:'directory'});if(!dir)return;await api.saveSettings({backupDir:dir});await refresh();backupLists.clear();const code=$('.backup-dest code');if(code)code.textContent=dir;toast('Backups now go to '+dir+'.');});return;}
    if(name==='backup-delete'){action(async()=>{if(!await ask('Delete this backup archive? This cannot be undone.'))return;await api.backupRemove({file:button.dataset.file});const a=state.agents.find(x=>x.id===id);if(a)await loadBackups(a);toast('Backup deleted.');});return;}
    if(name==='edit-host'){openHosts(state.hosts.find(h=>h.id===id));return;}
    if(name==='host-add'){openHosts({},{form:true});return;}
    if(name==='host-form-close'){closeModal();return;}
    if(name==='machine-add-menu'){const r=button.getBoundingClientRect();openMenu(r.left,r.bottom+4,[{icon:'+',label:'New VPS (creates its SSH key)',run:()=>openNewVps()},{icon:'@',label:'Add by its SSH address...',run:()=>openHosts({},{form:true})},{icon:'&#8615;',label:'Import ~/.ssh/config',run:()=>fire('import-hosts')}],'Add a machine');return;}
    if(name==='host-test'){testMachine(id);return;}
    if(name==='hosts-test-all'){testAllMachines();return;}
    if(name==='fleet-more'){openToolbarMenu(button,[{icon:'&#8635;',label:'Test all machines',disabled:!state.hosts.length,run:()=>testAllMachines()},{icon:'&#8679;',label:'Update all agents',run:()=>action(updateAll)},{icon:'&#9881;',label:'Name and backup folder of this computer',run:()=>fire('local-machine')}],'Machines');return;}
    if(name==='host-copy'){const h=state.hosts.find(x=>x.id===id);if(h)action(async()=>{await api.clipboardWrite({text:sshText(h)});toast('SSH command copied.');});return;}
    if(name==='machine-versions'){action(async()=>{button.disabled=true;button.textContent='Checking...';try{await api.toolVersions({hostId:button.dataset.host||undefined,force:true});await refresh();}finally{render();}toast('Versions checked.');});return;}
    if(name==='settings'){openSettings();return;}
    if(name==='find'){openFind();return;}
    if(name==='whats-new'){openWhatsNew();return;}
    if(name==='dismiss-note'){tipsSeen.add(id);saveView();button.closest('.terminal-chat-note')?.remove();return;}
    if(name==='nav-back'){action(navGoBack);return;}
    if(name==='vault'){openVault();return;}
    if(name==='schedules'){openSchedules();return;}
    if(name==='agent-schedules'){openSchedules(id);return;}
    if(name==='vault-import'){openVault({panel:'import'});return;}
    if(name==='vault-backup'){openVault({panel:'backup'});return;}
    if(name==='models'){action(openModels);return;}
    if(name==='gateway'){action(openGateway);return;}
    if(name==='theme'){applyTheme(button.dataset.theme);saveView();openSettings();toast(`${theme==='light'?'White':'Dark'} theme enabled.`);return;}
    if(name==='help'){openHelp();return;}
    if(name==='switcher'){switcher();return;}
    if(name==='discovered-add'){const candidate=window.__discovered?.[Number(index)];openAgentForm(candidate?.existingId?state.agents.find(a=>a.id===candidate.existingId):candidate);return;}
    if(name==='starter'){const input=$('#message-input');if(input){input.value=button.dataset.text;drafts.set(draftKey(),input.value);if(api.saveDraft)save(api.saveDraft({agentId:selected().id,conversationId:currentConversation()?.id||'',text:input.value}));input.focus();}return;}
    if(name==='terminal-hide'){$('#terminal-panel').hidden=true;saveView();render();return;}
    if(name==='terminal-search'){openTerminalSearch();return;}
    if(name==='terminal-new'){openToolbarMenu(button,newTerminalItems(),'New terminal');return;}
    if(name==='terminal-more'){openToolbarMenu(button,terminalMoreMenu(),'Terminal');return;}
    if(name==='terminal-split'){openToolbarMenu(button,splitItems(currentTerminal),'Split terminal');return;}
    if(name==='terminal-maximize'){maximizePane();return;}
    action(async()=>{
      if(name==='select'||name==='switch-select'){closeModal();await openChat(id);}
      else if(name==='connect-all')await connectAll();
      else if(name==='stop-agent')await api.stop({id});
      else if(name==='pg-connect')await api.connect({id});
      else if(name==='pg-stop'){for(const agentId of pgAgents)if(state.agents.find(a=>a.id===agentId)?.busy)await api.stop({id:agentId});}
      else if(name==='pg-open'){const c=state.conversations.find(x=>x.id===id);if(c)agentModes.set(c.agentId,'chat');await api.selectConversation({id});overview=false;opayaView=false;playgroundView=false;render();saveView();}
      else if(name==='opaya-clear')await api.opayaClear();
      else if(name==='opaya-stop')await api.opayaStop();
      else if(name==='opaya-forget-key'){await api.opayaForgetKey();openOpayaConfig();toast('Saved key removed.');}
      else if(name==='install-run'){closeModal();const r=await api.installFramework({id,hostId:button.dataset.host||undefined});if(r?.kind==='toolchain'){onJob(r);toast('Opaya is installing it from the official download. No administrator password needed.');}else toast('Installing in the terminal below. When it finishes, run Discover to add the agent.');}
      else if(name==='install-docs')await api.openDocs({topic:'framework:'+id});
      else if(name==='icon-pick'){await api.updateAgentDisplay({id,avatar:button.dataset.value});closeModal();toast('Icon updated.');}
      else if(name==='move-agent'){await api.reorderAgents({id,direction:button.dataset.direction});state=await api.snapshot();render();}
      else if(name==='discover')await discover();
      else if(name==='host-discover')await discover(id);
      else if(name==='scan-folder'){const extraHome=await api.pick({kind:'directory'});if(extraHome)await discover(undefined,extraHome);}
      else if(name==='connect'){const a=selected();if(a)await(a.status==='connected'?api.disconnect({id:a.id}):api.connect({id:a.id}));}
      else if(name==='clear-error'){await api.clearError({id});state=await api.snapshot();render();toast('Connection error cleared.');}
      else if(name==='new-conversation'){const a=selected();if(a)await api.newConversation({agentId:a.id});}
      else if(name==='export'){const c=currentConversation();if(c){if(await api.exportConversation({id:c.id}))toast('Conversation exported.');}else toast('Start a conversation first.');}
      else if(name==='stop')await api.stop({id:selected().id});
      else if(name==='remove'){if(await api.removeAgent({id})){closeModal();overview=true;opayaView=false;playgroundView=false;state=await api.snapshot();render();}}
      else if(name==='remove-host'){const h=state.hosts.find(x=>x.id===id);if(!h||!await ask(`Remove ${h.name} from Opaya?\n\nOnly Opaya forgets it. The server, its agents and your SSH keys stay as they are.`))return;await api.removeHost({id});hostChecks.delete(id);state=await api.snapshot();closeModal();if(fleetFocus===id)fleetFocus='local';render();toast(`${h.name} removed from Opaya.`);}
      else if(name==='import-hosts'){button.disabled=true;try{const result=await api.discover({});for(const h of result.hosts||[])await api.saveHost(h);state=await api.snapshot();openFleet();toast(`${result.hosts?.length||0} SSH aliases imported. No remote connections were opened.`);}finally{button.disabled=false;}}
      else if(name==='pick'){const value=await api.pick({kind:button.dataset.kind});if(value){const input=$(`[name="${button.dataset.fieldName}"]`,button.closest('form'));if(input)input.value=value;}}
      else if(name==='docs')await api.openDocs({topic:button.dataset.topic});
      else if(name==='terminal')await agentTerminal();
      else if(name==='terminal-shell')await openTerminal(inAgentView()?{}:{local:true});
      else if(name==='terminal-cli'){if(inAgentView())await agentTerminal();else toast('Select an agent to open its CLI.');}
      else if(name==='local-terminal')await openTerminal({local:true});
      else if(name==='host-terminal')await openTerminal({hostId:id});
      else if(name==='terminal-detach'&&currentTerminal)await popoutTerminal(currentTerminal);
      else if(name==='terminal-end'&&currentTerminal)await closeTerminalTab(currentTerminal);
    });
  });
  document.addEventListener('input',event=>{if(event.target.id==='ws-search'){wsQuery=event.target.value;render();}});
  document.addEventListener('change',event=>{const key=event.target.dataset?.sideToggle;if(!key)return;if(event.target.checked)sidebarHide.delete(key);else sidebarHide.add(key);applySidebar();saveView();});
  // Alt+Left and the mouse's back button go to the previous screen (a terminal keeps Alt+Left for its shell).
  document.addEventListener('keydown',event=>{if(event.altKey&&!event.ctrlKey&&!event.metaKey&&!event.shiftKey&&event.key==='ArrowLeft'&&!viewOf(document.activeElement)&&!event.target.closest?.('input,textarea,select,[contenteditable]')&&!$('#app-dialog')){event.preventDefault();action(navGoBack);}});
  document.addEventListener('mouseup',event=>{if(event.button===3&&!$('#app-dialog')){event.preventDefault();action(navGoBack);}});
  document.addEventListener('keydown',event=>{
    // AltGr is Ctrl+Alt on Windows and types characters (@ \ { } `): no shortcut here uses Alt, so a terminal gets them.
    if(!(event.ctrlKey||event.metaKey)||event.altKey)return;
    if(event.key.toLowerCase()==='k'){event.preventDefault();switcher();}
    // Cmd+B on a Mac, Ctrl+B elsewhere; a terminal keeps Ctrl+B (tmux, readline): xterm takes it before this runs.
    if(event.key.toLowerCase()==='b'&&!event.shiftKey&&(state.platform==='darwin'?event.metaKey:event.ctrlKey&&!viewOf(document.activeElement))&&!$('#app-dialog')){event.preventDefault();toggleSidebar();return;}
    if(event.shiftKey&&event.key.toLowerCase()==='m'&&selected()&&!$('#app-dialog')){event.preventDefault();openManage(selected().id);return;}
    if($('#app-dialog'))return;
    if(event.key.toLowerCase()==='n'&&selected()){event.preventDefault();const a=selected();if(a.protocol==='terminal'||a.surface==='terminal')return;action(async()=>{await api.newConversation({agentId:a.id});state=await api.snapshot();await setAgentMode(a,'chat');$('#message-input')?.focus();});}
    if(event.key==='`'){event.preventDefault();if(!$('#terminal-panel').hidden)$('#terminal-panel').hidden=true;else action(()=>currentTerminal&&terminalViews.has(currentTerminal)?($('#terminal-panel').hidden=false,activateTerminal(currentTerminal)):agentTerminal());}
    // Chosen from inside a terminal, the terminal panel still follows the choice (syncTerminalContext keeps a focused one).
    if(/^[1-9]$/.test(event.key)&&navOrder()[Number(event.key)-1]){event.preventDefault();overview=false;opayaView=false;playgroundView=false;const id=navOrder()[Number(event.key)-1].id;if(id!==state.activeAgentId&&viewOf(document.activeElement))document.activeElement.blur();action(()=>openChat(id));}
  });
  if(!api){$('#content').innerHTML='<div class="runtime-missing"><h1>Open Opaya as a desktop app.</h1><p>This workspace needs its native bridge to discover agents, use SSH and open terminals.</p><code>npm install &amp;&amp; npm start</code></div>';return;}
  // Scrollback search (Ctrl+F in a terminal, or the search button).
  function openTerminalSearch(){
    const view=terminalViews.get(currentTerminal);if(!view?.core?.search)return;const bar=$('#terminal-search');bar.hidden=false;const input=$('#terminal-search-input');input.focus();input.select();
  }
  function closeTerminalSearch(){const bar=$('#terminal-search');if(!bar||bar.hidden)return;bar.hidden=true;terminalViews.get(currentTerminal)?.core?.search?.clearDecorations?.();terminalViews.get(currentTerminal)?.term.focus();}
  function findInTerminal(back=false){
    const view=terminalViews.get(currentTerminal),q=$('#terminal-search-input').value;if(!view?.core?.search||!q)return;
    const opts={caseSensitive:false,decorations:{matchBackground:'#3d5a47',activeMatchBackground:'#b5f5cf',matchOverviewRuler:'#3d5a47',activeMatchColorOverviewRuler:'#b5f5cf'}};
    const found=back?view.core.search.findPrevious(q,opts):view.core.search.findNext(q,opts);$('#terminal-search').classList.toggle('missing',!found);
  }
  $('#terminal-search-input')?.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();findInTerminal(event.shiftKey);}else if(event.key==='Escape'){event.preventDefault();closeTerminalSearch();}});
  $('#terminal-search-input')?.addEventListener('input',()=>findInTerminal());
  $('#terminal-search')?.addEventListener('click',event=>{const b=event.target.closest('[data-find]');if(!b)return;if(b.dataset.find==='close')closeTerminalSearch();else findInTerminal(b.dataset.find==='prev');});
  async function closeTerminalTab(id){
    const view=terminalViews.get(id);if(!view||view.closing)return;view.closing=true;
    // The window goes away even if the service could not end the session (for example its agent was removed).
    try{try{const r=await api.terminalClose({id});if(r?.warning)toast(`Window closed. ${r.warning}`,true);}catch(error){toast(`Window closed. ${error.message}`,true);}
      view.observer.disconnect();view.core.dispose();view.element.remove();terminalViews.delete(id);if(currentTerminal===id)currentTerminal='';
      activateTerminal(currentTerminal,{focus:false});if(!panes.filter(Boolean).length&&!document.body.classList.contains('terminal-stage'))$('#terminal-panel').hidden=true;saveView();}finally{view.closing=false;}
  }

  async function popoutTerminal(id){
    // The window reports its own size; back in a pane, this copy reports its size again (resetSize).
    const view=terminalViews.get(id);if(!view)return;view.poppedOut=true;view.term.options.disableStdin=true;view.core.resetSize();
    try{await api.terminalPopout({id});if(panes.filter(x=>x&&x!==id).length)activateTerminal(panes.find(x=>x&&x!==id));else if(currentTerminal===id)$('#terminal-panel').hidden=true;render();saveView();}catch(error){view.poppedOut=false;view.term.options.disableStdin=view.exited;throw error;}
  }
  function renameTerminal(id){
    const view=terminalViews.get(id);if(!view)return;
    // The dialog gives the keyboard back to what had it when it opened: the terminal, not the menu that asked for it.
    if(id===currentTerminal&&!typingElsewhere())focusCurrent();
    modal('Rename terminal','',`<form id="terminal-rename-form"><label class="field"><span>Name</span><input name="title" value="${esc(view.title)}" required maxlength="80" autocomplete="off"></label><div class="modal-footer"><button type="button" class="secondary" data-action="modal-close">Cancel</button><button type="submit" class="primary">Rename</button></div></form>`);
    const form=$('#terminal-rename-form');form.elements.title.select();form.addEventListener('submit',event=>{event.preventDefault();action(async()=>{await api.terminalRename({id,title:form.elements.title.value});closeModal();});});
  }
  function renameAgent(a){
    modal('Rename agent','Only changes how it appears in Opaya. The real agent, profile and CLI keep their names.',`<form id="agent-rename-form"><label class="field"><span>Display name</span><input name="displayName" value="${esc(a.displayName||a.name)}" maxlength="80" autocomplete="off" placeholder="${esc(a.name)}"></label><div class="modal-footer"><button type="button" class="secondary" data-action="modal-close">Cancel</button><button type="submit" class="primary">Rename</button></div></form>`);
    const form=$('#agent-rename-form');form.elements.displayName.select();
    form.addEventListener('submit',event=>{event.preventDefault();const value=form.elements.displayName.value.trim();action(async()=>{await api.updateAgentDisplay({id:a.id,displayName:value===a.name?'':value});closeModal();toast('Agent renamed.');});});
  }
  async function refresh(){state=await api.snapshot();render();}
  async function selectAgent(id,mode='chat'){if(mode==='chat'){await openChat(id);return;}if(mode==='manage'){await openManage(id);return;}agentModes.set(id,mode);overview=false;opayaView=false;playgroundView=false;closeModal();await api.select({id});render();saveView();}
  // Every action for one agent, shared by the right-click menu and the Manage screen.
  function agentActions(a){
    const id=a.id,index=state.agents.findIndex(x=>x.id===id),connected=a.status==='connected',cap=a.install||{};
    const source=a.clone&&state.agents.find(x=>x.id===a.clone.from);
    return {
      open:a.protocol==='terminal'?{icon:'&gt;_',label:'Open terminal',run:()=>setAgentMode(a,'console')}:{icon:'&#9993;',label:'Open chat window',run:()=>openChatWindow(a)},
      surface:a.protocol==='terminal'?null:a.surface==='terminal'?{icon:'&#9993;',label:'Allow chat again',hint:'its vendor refused chats',run:async()=>{await api.updateAgentDisplay({id,surface:''});await refresh();toast(`${title(a)} chats in Opaya again.`);}}:{icon:'&#9634;',label:'Full chat view',run:()=>setAgentMode(a,'full')},
      console:a.protocol!=='terminal'&&{icon:'&gt;_',label:'Open terminal',run:()=>setAgentMode(a,'console')},
      newChat:{icon:'+',label:'New chat',hint:`${mod()}N`,disabled:a.protocol==='terminal',run:async()=>{await api.newConversation({agentId:id});state=await api.snapshot();await setAgentMode(a,'chat');$('#message-input')?.focus();}},
      connect:a.busy?{icon:'&#9632;',label:'Stop current turn',run:()=>api.stop({id})}:{icon:connected?'&#9675;':'&#9679;',label:connected?'Disconnect':a.status==='connecting'?'Connecting...':'Connect',disabled:a.status==='connecting',run:()=>connected?api.disconnect({id}):api.connect({id})},
      clearError:a.error&&{icon:'!',label:'Clear connection error',run:async()=>{await api.clearError({id});await refresh();}},
      manage:{icon:'&#9881;',label:'Manage...',run:()=>openManage(id)},
      history:{icon:'&#9719;',label:'Chat history',hint:`${mod()}Shift+H`,run:()=>toggleHistory(true,id)},
      projects:{icon:'&#9635;',label:'Projects...',run:()=>openAgentProjects(a)},
      files:{icon:'&#9656;',label:'Browse files',run:()=>openFiles({agentId:id,label:`${title(a)} / ${location(a)}`})},
      shell:{icon:'&gt;_',label:'Open shell',run:()=>openTerminal({agentId:id})},
      cli:{icon:'&#10095;',label:'Run native CLI',disabled:!hasCli(a),hint:hasCli(a)?'':'This connection has no native CLI.',run:()=>openTerminal({agentId:id,mode:'agent'})},
      log:{icon:'&#8801;',label:'Connection log...',run:()=>openDiagnostics(id)},
      skills:{icon:'&#10022;',label:'Skills & commands...',run:()=>openSkills(id)},
      transfer:{icon:'&#8644;',label:'Share with another agent...',disabled:state.agents.length<2,run:()=>openTransfer(a)},
      itrust:{icon:'&#9888;',label:a.itrust?'Turn off iTrust':'Turn on iTrust...',run:()=>toggleAgentTrust(a)},
      // The browser needs a model that can see images; text-only models (DeepSeek, Qwen3, gpt-oss...) do not get it.
      // Every model can browse: pages come back as text, links and form fields; a model that sees images also gets screenshots.
      browser:{icon:'&#9711;',label:hasBrowser(a)?'Take away Opaya browser':'Give Opaya browser',disabled:!browserCapable(a),hint:browserCapable(a)?'':'Only agents on this computer: the browser is here',run:async()=>{
        const had=hasBrowser(a);await api.updateAgentDisplay({id,browser:!had});await refresh();
        if(had)toast(`${title(a)} no longer has the Opaya browser.`);
        else toast(`${title(a)} has the Opaya browser now${a.protocol==='codex'?' (it reconnects after its current answer)':', in this chat too'}. ${a.vision?.vision===false?'Its model reads text, so it gets pages as text without screenshots.':'It reads pages and can take screenshots.'}`);}},
      pin:{icon:a.pinned?'&#9734;':'&#9733;',label:a.pinned?'Unpin':'Pin to top',run:async()=>{await api.updateAgentDisplay({id,pinned:!a.pinned});toast(a.pinned?`${title(a)} unpinned.`:`${title(a)} pinned to the top.`);}},
      rename:{icon:'&#9998;',label:'Rename...',run:()=>renameAgent(a)},
      icon:{icon:'&#9680;',label:'Change icon...',run:()=>openIconPicker(a)},
      groupTags:{icon:'&#9776;',label:'Group & tags...',run:()=>openGroupTags(a)},
      moveUp:{icon:'&#8593;',label:'Move up',disabled:index<=0,run:async()=>{await api.reorderAgents({id,direction:'up'});await refresh();}},
      moveDown:{icon:'&#8595;',label:'Move down',disabled:index>=state.agents.length-1,run:async()=>{await api.reorderAgents({id,direction:'down'});await refresh();}},
      update:{icon:'&#8635;',label:cap.kind==='docker'?'Update container...':cap.kind==='hermes-profile'?'Update Hermes...':'Update...',disabled:!cap.update,hint:cap.update?'':'This installation does not support updates.',run:()=>updateAgent(a)},
      backup:{icon:'&#8615;',label:'Back up to this computer...',disabled:!cap.backup,hint:cap.backup?'':'This installation does not support backups.',run:()=>openBackup(a)},
      clone:{icon:'&#10697;',label:'Clone...',disabled:!cloneable(a),hint:cloneable(a)?'':'This connection has no cloneable installation.',run:()=>openClone(a)},
      redeploy:a.clone&&{icon:'&#8634;',label:`Redeploy from ${title(source||{name:'source'})}`,run:()=>redeploy(a)},
      uninstall:{icon:'&#10006;',label:cap.kind==='hermes-profile'?'Delete Hermes profile...':cap.kind==='docker'?'Remove container...':'Uninstall...',danger:true,disabled:!cap.uninstall,hint:cap.uninstall?'':'This connection has no managed installation to uninstall.',run:()=>openUninstall(a)},
      settings:{icon:'&#9881;',label:'Connection settings...',run:()=>openAgentForm(a)},
      remove:{icon:'&#10005;',label:'Remove connection...',danger:true,run:async()=>{if(await api.removeAgent({id})){closeModal();if(state.activeAgentId===id)overview=true;opayaView=false;playgroundView=false;await refresh();toast('Connection removed.');}}}
    };
  }
  // The right-click menu mirrors the agent's sidebar: its quick actions, then one submenu per Manage section with the
  // same items in the same order, so every action is found in the same place both ways.
  function agentMenu(a){
    const x=agentActions(a);let acts={};try{acts=manageActions(a);}catch{}
    const section=s=>{const items=(AN_SUB[s.key]||[]).map(([k,label])=>acts[k]&&{...acts[k],label:acts[k].label||label}).filter(Boolean);
      return {icon:s.icon,label:s.name,danger:s.key==='danger',submenu:[{icon:'&#8599;',label:`Go to ${s.name}`,run:()=>openManage(a.id,s.key)},...(items.length?['-',...items]:[])]};};
    return [
      x.open,x.newChat,x.surface,x.console,x.connect,x.clearError,
      '-',
      {...x.manage,label:'Manage',icon:AN_ICON.overview},x.history,
      '-',
      ...AN_SECTIONS.filter(s=>s.key!=='overview').map(section)
    ];
  }
  // ---- Chat or terminal ---------------------------------------------------------------------------------------------
  // ---- Maintenance: update, back up, uninstall --------------------------------------------------------------------
  const installInfo=new Map(),backupLists=new Map();
  const fmtSize=n=>!n?'0 B':n<1024?`${n} B`:n<1048576?`${(n/1024).toFixed(1)} KB`:n<1073741824?`${(n/1048576).toFixed(1)} MB`:`${(n/1073741824).toFixed(2)} GB`;
  const whenText=iso=>{const d=new Date(iso);return isNaN(d)?'':d.toLocaleString([],{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});};
  // Other agents that use the same installation on the same machine (Hermes profiles share one Hermes).
  const andList=list=>list.length<2?list.join(''):`${list.slice(0,-1).join(', ')} and ${list.at(-1)}`;
  const sharedWith=a=>['docker','container-profile','remote-api'].includes(a.install?.kind)?[]:state.agents.filter(b=>b.id!==a.id&&b.transport===a.transport&&(b.hostId||'')===(a.hostId||'')&&!['docker','container-profile'].includes(b.install?.kind)&&b.install?.framework===a.install?.framework);
  async function loadInstallInfo(a,force=false){
    if(!force&&installInfo.has(a.id)&&installInfo.get(a.id)!=='loading')return installInfo.get(a.id);
    installInfo.set(a.id,'loading');if(manageId===a.id)render();
    try{installInfo.set(a.id,await api.agentInstallInfo({id:a.id}));}catch(e){installInfo.set(a.id,{error:e.message});}
    if(manageId===a.id)render();return installInfo.get(a.id);
  }
  async function loadBackups(a){try{backupLists.set(a.id,await api.agentBackups({id:a.id}));}catch(e){backupLists.set(a.id,{error:e.message,backups:[]});}if(manageId===a.id)render();return backupLists.get(a.id);}
  async function updateAgent(a){
    const started=await api.agentUpdate({id:a.id});if(!started)return;
    toast(`Updating in the terminal below. Reconnect ${title(a)} when it finishes.`);installInfo.delete(a.id);
  }
  async function updateAll(){const n=await api.agentUpdateAll();if(n)toast(`${n} update${n===1?'':'s'} started in the terminal. Reconnect your agents when they finish.`);installInfo.clear();}
  async function openBackup(a){
    const folder=state.settings?.backupDir||'';
    modal('Back up to this computer',`${title(a)} / ${location(a)}`,`<form id="backup-form" class="maintenance-form"><p class="field-help">Copies ${esc(title(a))}'s own data (${a.provider==='hermes'?'config, memory, skills, SOUL.md, cron jobs':'settings, instructions, skills'}) into a .tar.gz on ${esc(localName())}. The installation itself is not copied: install it again and restore these files.</p>
      <label class="switch-row"><input type="checkbox" name="history" checked><span class="switch" aria-hidden="true"></span><span>Chat history and sessions</span></label>
      <label class="switch-row"><input type="checkbox" name="keys" checked><span class="switch" aria-hidden="true"></span><span>API keys and logins <small>(${a.provider==='hermes'?'.env, auth.json':'credential files'})</small></span></label>
      <p class="field-help">Archives are readable only by your user account. Keep them private when they include keys.</p>
      <div class="backup-dest"><span>Saved in</span><code>${esc(folder||'Opaya Backups in your home folder')}</code><button type="button" class="subtle" data-action="backup-folder-change">Change</button><button type="button" class="subtle" data-action="backup-folder-open">Open</button></div>
      <div class="modal-footer"><span>Progress shows in its own window.</span><div><button type="button" class="secondary" data-action="modal-close">Cancel</button><button type="submit" class="primary">Back up now</button></div></div></form>`);
    $('#backup-form').addEventListener('submit',event=>{event.preventDefault();const f=event.target;action(async()=>{await api.agentBackup({id:a.id,history:f.elements.history.checked,keys:f.elements.keys.checked});closeModal();backupLists.delete(a.id);});});
  }
  async function openUninstall(a){
    const cap=a.install||{},shared=sharedWith(a),profile=cap.kind==='hermes-profile'||cap.kind==='container-profile',docker=cap.kind==='docker';
    const what=cap.kind==='container-profile'?'Delete this profile':profile?'Delete this Hermes profile':docker?'Remove this container':`Uninstall ${labels[cap.framework]||cap.label||'this agent'}`;
    modal(what,`${title(a)} / ${location(a)} / ${cap.label||''}`,`<form id="uninstall-form" class="maintenance-form">
      <div class="uninstall-kind"><span class="status-dot ${installInfo.get(a.id)&&installInfo.get(a.id)!=='loading'?'connected':'working'}"></span><div id="uninstall-detected">Checking how it is installed...</div></div>
      ${shared.length&&!profile&&!docker?`<div class="inline-notice error-notice"><span>!</span><div><strong>Shared installation</strong><p>${esc(shared.map(title).join(', '))} ${shared.length===1?'uses':'use'} the same ${esc(cap.label)} on ${esc(location(a))} and will stop working too.</p></div></div>`:''}
      <label class="switch-row"><input type="checkbox" name="backup" ${cap.backup?'checked':'disabled'}><span class="switch" aria-hidden="true"></span><span>Back up to this computer first <small>${cap.backup?'(with history and keys)':'(not available for this agent)'}</small></span></label>
      ${profile?`<p class="field-help">A profile is its data: deleting it removes its config, memory, skills and sessions. ${cap.kind==='container-profile'?'The container and its other agents stay.':'Hermes and other profiles stay.'}</p>`:docker&&!a.clone?.container?`<p class="field-help">${(a.args||[]).some(x=>/^opaya-/.test(x))?'Its data folder (~/opaya-agents or ~/opaya-hermes) stays on the machine; delete it there if you no longer need it.':'Opaya did not create this container, so its volumes and data stay where they are.'}</p>`:`<label class="switch-row"><input type="checkbox" name="data" checked><span class="switch" aria-hidden="true"></span><span>Remove everything, its data too <small>(${docker?'the container data folder':cap.framework==='hermes'?'the whole Hermes home, every profile':'settings, logins, memory'})</small></span></label>`}
      <label class="switch-row"><input type="checkbox" name="remove" checked><span class="switch" aria-hidden="true"></span><span>Remove the connection from Opaya when it finishes</span></label>
      <p class="field-help">This runs on ${esc(location(a))} in a visible terminal, where you answer the uninstaller's questions:</p><pre class="install-command" id="uninstall-command">Loading...</pre>
      <div class="modal-footer"><span>You confirm the exact command once more.</span><div><button type="button" class="secondary" data-action="modal-close">Cancel</button><button type="submit" class="primary danger-button">${esc(what)}</button></div></div></form>`);
    const form=$('#uninstall-form'),preview=async()=>{try{const c=await api.agentMaintenanceCommand({id:a.id,action:'uninstall',data:!!form.elements.data?.checked});if($('#uninstall-command'))$('#uninstall-command').textContent=c.preview;}catch(e){if($('#uninstall-command'))$('#uninstall-command').textContent=e.message;}};
    form.elements.data?.addEventListener('change',preview);preview();
    loadInstallInfo(a).then(info=>{const box=$('#uninstall-detected');if(box)box.innerHTML=installText(info,a);});
    form.addEventListener('submit',event=>{event.preventDefault();action(async()=>{const job=await api.agentUninstall({id:a.id,data:!!form.elements.data?.checked,backup:!!form.elements.backup.checked,removeConnection:form.elements.remove.checked});if(job){closeModal();installInfo.delete(a.id);}});});
  }
  function installText(info,a){
    if(!info||info==='loading')return 'Checking how it is installed...';
    if(info.error&&!info.kind)return `<strong>${esc(a.install?.label||'Unknown')}</strong><small>${esc(info.error)}</small>`;
    const bits=info.kind==='docker'?[info.image&&`image ${info.image}`,info.state]:[info.methodLabels?.length?`installed with ${info.methodLabels.join(' + ')}`:info.path?'installed':'not found on PATH',info.version];
    return `<strong>${esc(info.label||a.install?.label||'')}</strong><small>${esc(bits.filter(Boolean).join(' / ')||'')}${info.path?` <code>${esc(info.path)}</code>`:''}</small>`;
  }
  // The Opaya Agent checks one agent end to end (install, login, onboarding, gateway, connection) and fixes what it can.
  async function askOpayaToFix(a){
    await api.opayaSend({text:`Check ${title(a)} (agent_id ${a.id}, ${a.provider} on ${location(a)}) end to end and fix whatever keeps it from working: installation and version, sign-in and onboarding, its gateway if it has one, and the connection in Opaya.${a.error?` Its current error: ${a.error}`:''} Tell me what you found and what you changed.`});
    overview=false;opayaView=true;playgroundView=false;manageId='';render();saveView();
  }
  // ---- Manage screen: every option for one agent -----------------------------------------------------------------
  // ---- Manage: the agent's command center, the screen a left click on an agent opens ------------------------------
  // One screen per agent: a 3D stage with what it is connected to, quick actions, where it can run (drag the agent card
  // onto a machine or Docker to clone it there), keys (drag a vault key onto an agent to give it), Docker on its machine,
  // its projects with git, recent chats and every maintenance action. Chat opens in a window of the chat dock; Terminal
  // turns the main area into a grid of terminals.
  // mgSection: the Manage section open for the selected agent (overview or one of AN_SECTIONS).
  let mgSection='overview';
  const keyLists=new Map(),dockerStatsOf=new Map();let heroCtl=null,statsTimer=0,mgTimer=0;
  const stage=()=>window.OpayaStage;
  const dockerKeyOf=a=>a.transport==='ssh'?a.hostId:'local';
  // The container an agent runs in: Opaya's own record, else the container named in `docker exec ... <name> <program>`.
  const containerOf=a=>{if(a.install?.container)return a.install.container;if(a.command!=='docker'||(a.args||[])[0]!=='exec')return '';const args=a.args||[];for(let i=1;i<args.length;i++){const x=args[i];if(x.startsWith('-')){if(['-w','-e','-u','--workdir','--env','--user'].includes(x))i++;continue;}return x;}return '';};
  const canDocker=a=>a.provider==='hermes'||CLONE_DOCKER.includes(a.install?.framework||'');
  const agentProjects=a=>(state.projects||[]).filter(p=>(p.agentIds||[]).includes(a.id));
  const agentChats=a=>state.conversations.filter(c=>c.agentId===a.id).slice().sort((x,y)=>String(y.createdAt).localeCompare(String(x.createdAt)));
  function topbar(crumb,page='',screen=''){
    const a=selected(),chatty=a&&a.protocol!=='terminal'&&a.surface!=='terminal';
    const destinations=a&&screen?`<div class="agent-context"><strong>${esc(title(a))}</strong><button type="button" class="text-button" data-action="agent-machine" title="Open machine">${esc(location(a))}</button><span>${dot(a)} ${esc(status(a))}</span>${screen==='manage'?`<span class="ac-section" aria-label="Section in view" ${mgSection==='overview'?'hidden':''}>&#8250; ${esc((AN_SECTIONS.find(x=>x.key===mgSection)||{}).name||'')}</span>`:''}${screen==='chat'&&(crumb||page)?`<div class="agent-chat-context">${crumb}${page}</div>`:''}</div><nav class="agent-destinations" aria-label="Agent destinations">${(()=>{const live={chat:screen!=='chat'&&chatDock.some(d=>dockConv(d.id)?.agentId===a.id)?'Its chat window is open':'',console:screen!=='console'&&!$('#terminal-panel')?.hidden&&ctxWindows(a.id).some(v=>!v.hiddenPane)?'Its terminal is open beside this view':''};return (chatty?[['chat','Chat'],['console','Terminal'],['manage','Manage']]:[['console','Terminal'],['manage','Manage']]).map(([mode,label])=>`<button type="button" class="secondary dest-tab ${screen===mode?'selected':''}" data-action="agent-mode" data-mode="${mode}" data-id="${esc(a.id)}" ${screen===mode?'aria-current="page"':''} title="${esc({chat:'Chat with it in Opaya',console:'Its CLI and shells in terminals',manage:'Settings and actions: model, keys, machine, clone, updates...'}[mode])}">${{chat:AN_ICON.chat,console:AN_ICON.console,manage:AN_ICON.overview}[mode]}<span>${label}</span>${live[mode]?`<i class="dest-live" title="${live[mode]}"></i>`:''}</button>`).join('');})()}</nav>`:'';
    $('#topbar').innerHTML=`<button type="button" class="topbar-back" data-action="nav-back" ${navBack.length?'':'disabled'} title="${navBack.length?esc(`Back to ${navLabel(navBack.at(-1))} (Alt+Left)`):'Back'}" aria-label="Back"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg></button>${destinations||`<div class="breadcrumb">${crumb}</div>${page?`<div class="topbar-page">${page}</div>`:''}<div class="topbar-spacer"></div>`}<button type="button" class="topbar-search" data-action="find" title="Find anything: agents, settings, actions, machines, chats and keys"><span class="topbar-search-ico" aria-hidden="true">${dkIcon('inspect')}</span><span class="topbar-search-text">Search</span><kbd>${esc(mod().trim())}${state.platform==='darwin'?'':'+'}K</kbd></button><div class="topbar-actions"></div>`;
    placeBrowser();
  }
  async function openManage(id,section=manageSections.get(id)||'overview'){
    const a=state.agents.find(x=>x.id===id);if(!a)return;
    const target=AN_SECTIONS.some(s=>s.key===section)?section:'overview';
    // Its page is open: go to the section on it.
    if(manageId===id&&$('#mg-p-hero')){mgGo(target);return;}
    savedWorkspaces();
    mgSection=target;manageSections.set(id,mgSection);mgPinned=target;
    overview=false;opayaView=false;playgroundView=false;closeModal();closeMenu();agentModes.set(id,'manage');
    // The selection must be in state before rendering, or render() would show another agent.
    if(state.activeAgentId!==id){await api.select({id});state=await api.snapshot();}
    $('#terminal-panel').hidden=!workspace(a.id).visible;
    render();saveView();
    loadInstallInfo(a);loadBackups(a);loadKeys(a);if(a.install?.kind!=='remote-api')loadDocker(dockerKeyOf(a));for(const p of agentProjects(a))if(!projectGit.get(p.id)?.info)loadProjectGit(p);
  }
  async function openChat(id){const a=state.agents.find(x=>x.id===id);if(a)await setAgentMode(a,modeOf(a));}
  async function setAgentMode(a,mode){
    savedWorkspaces();
    if(mode==='manage'){await openManage(a.id);return;}
    if(mode==='full')mode='chat';
    if(mode==='chat'&&(a.protocol==='terminal'||a.surface==='terminal'))mode='console';
    agentModes.set(a.id,mode);overview=false;opayaView=false;playgroundView=false;closeModal();
    if(state.activeAgentId!==a.id){await api.select({id:a.id});state=await api.snapshot();}
    const w=workspace(a.id);layout.terminal=w.dock;$('#terminal-panel').hidden=mode!=='console'&&!w.visible;
    stageAgent='';render();saveView();
  }
  async function showTerminalWithChat(position){
    const a=selected();if(!a||a.protocol==='terminal'||a.surface==='terminal')return;
    await setAgentMode(a,'chat');
    const w=workspace(a.id);w.visible=true;w.dock=position;layout.terminal=position;$('#terminal-panel').hidden=false;placePanes();
    const own=ctxWindows(a.id).find(v=>v.id===w.active)||ctxWindows(a.id).find(v=>!v.hiddenPane);
    if(own){$('#terminal-panel').hidden=false;activateTerminal(own.id);}else await agentTerminal();
    saveView();
  }
  async function loadKeys(a,force=false){
    if(!force&&keyLists.has(a.id))return keyLists.get(a.id);
    try{keyLists.set(a.id,await api.agentKeys({agentId:a.id}));}catch(error){keyLists.set(a.id,{keys:[],vault:[],error:error.message});}
    if(manageId)render();return keyLists.get(a.id);
  }
  // The live parts of the screen (Docker stats, clone progress) refresh while it is visible, and stop when it is not.
  function manageTick(){
    clearTimeout(mgTimer);const a=selected(),fleet=fleetView&&overview&&!opayaView&&!playgroundView;
    if(!(manageId&&a||fleet)||document.hidden){mgTimer=0;return;}
    const key=fleet?fleetFocus:dockerKeyOf(a),v=dockerViews.get(key);
    const box=$(fleet?'#fl-docker':'#mg-docker'),near=box&&box.getBoundingClientRect().top<innerHeight+200;
    if(v?.result?.running&&near&&!v.statsOff&&(fleet||a.install?.kind!=='remote-api'))loadDockerStats(key);
    // Every 4 seconds on this computer; a machine over SSH every 10.
    mgTimer=setTimeout(manageTick,key==='local'?4000:10000);
  }
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&(manageId||fleetView&&overview))manageTick();});
  async function loadDockerStats(key){
    if(dockerStatsOf.get(key)?.loading)return;const prev=dockerStatsOf.get(key)||{};dockerStatsOf.set(key,{...prev,loading:true});
    try{const r=await api.dockerStats({hostId:key==='local'?undefined:key});dockerStatsOf.set(key,{at:Date.now(),by:Object.fromEntries((r?.stats||[]).map(s=>[s.name,s]))});}
    catch(error){dockerStatsOf.set(key,{...prev,loading:false,error:error.message});}
    patchDockerStats(key);
  }
  // New samples change only the gauges of the cards on screen, so a click or hover on a card is never lost to a redraw.
  // Without the cards (the fleet board, a card that just started) the view is painted as usual.
  function patchDockerStats(key){
    const st=dockerStatsOf.get(key)||{},boxes=[$('#docker-manager'),$('#mg-docker'),$('#fl-docker')].filter(b=>b&&b.dataset.key===key);let missing=!boxes.length;
    for(const box of boxes)for(const card of box.querySelectorAll('.dk-card.running')){const s=st.by?.[card.dataset.container],g=card.querySelector('.dk-gauges');if(!g){missing=true;continue;}
      const html=`${gauge('CPU',s?.cpu,s?.cpu)}${gauge('MEM',s?.memPercent,s?s.mem.split(' / ')[0]:'')}${s?`<div class="dk-io"><span title="Network in / out">NET ${esc(s.net||'')}</span><span title="Processes">${esc(s.pids||'0')} proc</span></div>`:''}`;
      // The bars keep their elements, so their widths animate to the new value.
      const bars=g.querySelectorAll('.mg-gauge');if(bars.length===2&&s){const vals=[[s.cpu,s.cpu],[s.memPercent,s.mem.split(' / ')[0]]];bars.forEach((b,i)=>{b.querySelector('i').style.setProperty('--v',`${pct(vals[i][0])}%`);b.querySelector('b').textContent=vals[i][1]||'--';});const io=g.querySelector('.dk-io');if(io)io.innerHTML=`<span title="Network in / out">NET ${esc(s.net||'')}</span><span title="Processes">${esc(s.pids||'0')} proc</span>`;else g.insertAdjacentHTML('beforeend',`<div class="dk-io"><span title="Network in / out">NET ${esc(s.net||'')}</span><span title="Processes">${esc(s.pids||'0')} proc</span></div>`);}
      else g.innerHTML=html;}
    if(missing||fleetView&&overview&&$("#fl-board"))paintDocker(key);
  }
  const pct=v=>Math.max(0,Math.min(100,parseFloat(v)||0));
  const gauge=(label,value,text)=>`<div class="mg-gauge"><span>${label}</span><i style="--v:${pct(value)}%"></i><b>${esc(text||value||'--')}</b></div>`;
  // For an agent (its machine, its own container first) or, with only a machine key, for the fleet's machine view.
  function dockerPanel(a,machineKey=''){
    const key=machineKey||dockerKeyOf(a),v=dockerViews.get(key)||{},r=v.result,machine=key==='local'?localName():hostName(key),mine=a?containerOf(a):'',st=dockerStatsOf.get(key)||{};
    const btn=(act,label,attrs='',cls='mg-icon-btn',hint='')=>`<button type="button" class="${cls}" data-action="${act}" data-id="${esc(key)}" ${attrs} ${hint?`title="${esc(hint)}"`:''}>${label}</button>`;
    const engine=v.loading&&!r?'<span class="status-dot working"></span> Reading Docker...':v.error?`<span class="status-dot error"></span> ${esc(v.error)}`:r?.running?`<span class="status-dot connected"></span> Engine ${esc(r.version)} <span class="mg-sep">/</span> ${r.containers.filter(c=>c.state==='running').length} of ${r.containers.length} running <span class="mg-sep">/</span> ${r.images.length} image${r.images.length===1?'':'s'}`:r?`<span class="status-dot error"></span> ${esc(r.error)}`:'<span class="status-dot"></span> Not checked yet';
    const head=`<header class="mg-section-head"><div><h2><span class="mg-h-icon docker-h" aria-hidden="true">${dkIcon('box')}</span>Docker on ${esc(machine)}</h2><p class="mg-engine">${engine}</p></div><div class="mg-head-actions">${r?.running?`<label class="mg-toggle" title="Live CPU and memory, every few seconds while this screen is open"><input type="checkbox" data-action="docker-live" data-id="${esc(key)}" ${v.statsOff?'':'checked'}><span class="switch" aria-hidden="true"></span>Live</label>`:''}${btn('docker-refresh','&#8635; Refresh',v.loading?'disabled':'','secondary small')}${btn('docker-manager','Open manager','','subtle small','All containers and images in a window')}</div></header>`;
    if(!r?.running)return head+`<div class="mg-docker-empty">${r&&!r.installed?`<p>Docker is not installed on ${esc(machine)}.</p><button type="button" class="primary" data-action="install-catalog" ${key!=='local'?`data-host="${esc(key)}"`:''}>&#8595; Install Docker</button>`:r?'<p>Start Docker there, then refresh.</p>':'<p>Opaya reads Docker when you open this screen.</p>'}</div>`;
    const list=r.containers.slice().sort((x,y)=>(y.name===mine)-(x.name===mine)||(y.state==='running')-(x.state==='running'));
    const cta=a&&!mine&&cloneable(a)&&canDocker(a)?`<article class="mg-container mg-dockerize" data-drop="agent" data-deploy-host="${a.transport==='ssh'?esc(a.hostId):''}" data-deploy-runtime="docker"><div class="mg-cube" aria-hidden="true"><i></i><i></i><i></i></div><div><strong>Dockerize ${esc(title(a))}</strong><p>Run a copy in its own container on ${esc(machine)}: isolated, restarts by itself, easy to move.</p></div><button type="button" class="primary" data-action="dockerize" data-id="${esc(a.id)}">Dockerize&#8230;</button></article>`:'';
    return `${head}<div class="dk-grid mg-containers">${cta}${list.map(c=>dockerCard(key,c,{mine,stats:st})).join('')||'<p class="field-help">No containers yet.</p>'}</div>${dockerImages(key,r,v)}`;
  }
  async function dockerInspect(key,name){
    const back=$('#docker-manager')?.dataset.key===key;
    modal(`Container ${name}`,`${key==='local'?localName():hostName(key)} / docker inspect, without environment values`,'<div id="docker-inspect"><p class="field-help">Reading...</p></div>');
    let r;try{r=await api.dockerInspect({hostId:key==='local'?undefined:key,container:name});}catch(error){const box=$('#docker-inspect');if(box)box.innerHTML=`<p class="field-help">${esc(error.message)}</p>`;return;}
    const box=$('#docker-inspect');if(!box)return;const row=(k,v)=>v?`<div><small>${k}</small><span>${v}</span></div>`:'';
    box.innerHTML=`<div class="mg-inspect">${row('Image',esc(r.image))}${row('State',esc(r.state+(r.health?` / ${r.health}`:'')+(r.restartCount?` / restarted ${r.restartCount}x`:'')))}${row('Restart policy',esc(r.restart))}${row('Created',esc(whenText(r.created)))}${row('Command',`<code>${esc(r.command)}</code>`)}${row('Working folder',esc(r.workdir))}${row('Ports',r.ports.map(p=>`<code>${esc(p)}</code>`).join(' '))}${row('Networks',esc(r.networks.join(', ')))}${row('Mounts',r.mounts.map(m=>`<code>${esc(m.source)} &#8594; ${esc(m.destination)}${m.rw?'':' (read-only)'}</code>`).join('<br>'))}${row('Environment',r.env.map(e=>`<span class="tag-chip">${esc(e)}</span>`).join(' '))}</div><div class="modal-footer"><span>Values of environment variables stay on the machine.</span>${back?`<button type="button" class="primary" data-action="docker-manager" data-id="${esc(key)}">Back to Docker manager</button>`:'<button type="button" class="primary" data-action="modal-close">Close</button>'}</div>`;
  }
  // Where the agent can run: one card per machine (this computer first), each with Install and Docker. Drop the agent
  // card on either, or click it. The place it runs now is marked, and a running clone shows its progress there.
  function deployTargets(a){
    if(!cloneable(a))return `<p class="field-help">${esc(title(a))} is an API connection: the provider runs it, so there is nothing to copy.</p>`;
    const here=a.transport==='ssh'?a.hostId:'',docker=canDocker(a),running=[...jobs.values()].filter(j=>j.kind==='clone'&&j.route?.from===a.name);
    const slot=(hostId,runtime,machine)=>{const job=running.find(j=>(j.route.toHostId||'')===hostId&&(runtime==='docker')===/ \/ /.test(j.route.toWhere||'')),isHere=hostId===here&&(runtime==='docker')===!!containerOf(a),label=runtime==='docker'?'Docker container':a.provider==='hermes'?'Hermes profile':'Install';
      return `<button type="button" class="mg-slot ${runtime} ${isHere?'here':''} ${job?'busy':''}" data-drop="agent" data-deploy-host="${esc(hostId)}" data-deploy-runtime="${runtime}" data-action="deploy" data-id="${esc(a.id)}" title="${esc(isHere?`${title(a)} runs here. Drop it here to make another copy.`:`${runtime==='docker'?'Dockerize':'Clone'} ${title(a)} on ${machine}`)}"><span class="mg-slot-icon" aria-hidden="true"></span><span class="mg-slot-text"><strong>${label}</strong><small>${job?`${job.status==='running'?'Cloning':job.status==='done'?'Cloned':'Failed'} ${jobPercent(job)}%`:isHere?'&#9679; Runs here':runtime==='docker'?'Isolated, restarts by itself':'Next to its other agents'}</small></span>${job?`<span class="mg-target-bar" style="--p:${jobPercent(job)}%"></span>`:''}</button>`;};
    const machine=(hostId,name,sub,kind)=>`<div class="mg-machine ${hostId===here?'current':''}"><header><span class="mg-target-icon ${kind}" aria-hidden="true"></span><span class="mg-target-text"><strong>${esc(name)}</strong><small>${esc(sub)}</small></span>${hostId===here?'<em class="mg-badge">it runs here</em>':''}</header><div class="mg-slots">${slot(hostId,'regular',name)}${docker?slot(hostId,'docker',name):''}</div></div>`;
    return `<div class="mg-machines">${machine('',localName(),localName()==='This computer'?(state.machine?.hostname||'Where Opaya runs'):'This computer','local-t')}${state.hosts.map(h=>machine(h.id,h.name,`${h.username?h.username+'@':''}${h.hostname||h.alias||''}`,'vps-t')).join('')}<button type="button" class="mg-machine add" data-action="new-vps"><span class="mg-target-icon add-t" aria-hidden="true"></span><span class="mg-target-text"><strong>New VPS</strong><small>Add a server: key and connection</small></span></button></div>`;
  }
  // Its clone family: the agent it was cloned from (Redeploy copies the same parts again) and its own copies.
  function clonesPanel(a){
    const source=a.clone&&state.agents.find(x=>x.id===a.clone.from),copies=state.agents.filter(x=>x.clone?.from===a.id);
    if(!source&&!copies.length&&!a.clone)return '';
    const scope=c=>CLONE_SCOPES.find(s=>s[0]===c.scope)?.[1]||c.scope||'';
    const item=(x,role)=>`<div class="mg-copy">${badge(x)}<span class="mg-copy-text"><strong>${esc(title(x))}</strong><small>${dot(x)}${esc(status(x))} / ${esc(location(x))}${containerOf(x)?' / Docker':''}${role==='copy'&&x.clone?.scope?` / ${esc(scope(x.clone))}`:''}</small></span><span class="mg-copy-actions">${role==='copy'?`<button type="button" class="mg-icon-btn" data-action="redeploy-copy" data-id="${esc(x.id)}" title="Copy ${esc(scope(x.clone))} from ${esc(title(a))} again">&#8634; Redeploy</button>`:''}<button type="button" class="mg-icon-btn" data-action="manage" data-id="${esc(x.id)}">Open</button></span></div>`;
    return `<section class="mg-section set-wide"><header class="mg-section-head"><div><h2>Clones</h2><p>${source?`${esc(title(a))} is a copy of ${esc(title(source))} (${esc(scope(a.clone))}). Redeploy copies the same parts from it again.`:a.clone?'It was cloned from an agent that has been removed.':`Copies of ${esc(title(a))}. Redeploy one to bring it up to date with this agent.`}</p></div>${source?`<div class="mg-head-actions"><button type="button" class="secondary small" data-action="manage-run" data-key="redeploy">&#8634; Redeploy from ${esc(title(source))}</button></div>`:''}</header>
      <div class="mg-copies">${source?item(source,'source'):''}${copies.map(x=>item(x,'copy')).join('')}</div></section>`;
  }
  function keysPanel(a){
    const held=(opaya().secrets||[]).filter(k=>k.kept||k.global||k.stored?.length),has=keyLists.get(a.id),others=state.agents.filter(x=>x.id!==a.id&&!x.ephemeral).slice(0,8);
    const chip=k=>{const mine=keyHolders(k).has(a.id);return `<button type="button" class="mg-key ${mine?'mine':''}" data-drag="key" data-drag-id="${esc(k.id)}" data-action="key-menu" data-id="${esc(k.id)}" title="Drag onto an agent to give it ${esc(k.name)} (or click)${mine?`. ${esc(title(a))} has it.`:''}"><span class="mg-key-glyph" aria-hidden="true">${KEY_SVG}</span><span><strong>${esc(k.name)}</strong><small>${esc(k.mask||'')}${mine?' · &#10003; has it':''}</small></span>${k.global?'<em>all</em>':''}</button>`;};
    const target=(x,big=false)=>`<div class="mg-key-target ${big?'big':''}" data-drop="key" data-agent-target="${esc(x.id)}">${badge(x)}<span><strong>${esc(title(x))}</strong><small>${esc(placeText(x))}</small></span><em class="mg-shared" aria-live="polite"></em></div>`;
    return `<header class="mg-section-head"><div><h2><span class="mg-h-icon key-h" aria-hidden="true">${AN_ICON.access}</span>Give a key</h2><p>Drag a key from the vault onto an agent, or click it. Opaya writes it where that agent reads keys; values never go into a chat.</p></div></header>
      <div class="mg-keys"><div class="mg-vault"><h3>Opaya Vault <small>${held.length}</small></h3>${held.length?`<div class="mg-key-list">${held.map(chip).join('')}</div>`:'<p class="field-help">No keys yet. <button type="button" class="text-button" data-action="vault">Add or import keys in the Vault</button></p>'}</div>
      <div class="mg-flow" aria-hidden="true"><i></i><i></i><i></i></div>
      <div class="mg-give"><h3>Give to</h3>${target(a,true)}<div class="mg-key-others">${others.map(x=>target(x)).join('')}</div></div>
      <div class="mg-has"><h3>${esc(title(a))} has <small>${has?.keys?.length??''}</small></h3>${!has?'<p class="field-help">Reading its keys...</p>':has.keys.length?`<div class="mg-has-list">${has.keys.map(k=>`<span class="mg-has-key" title="${esc(k.where||'')}"><span class="mg-key-glyph small" aria-hidden="true">${KEY_SVG}</span>${esc(k.name)}</span>`).join('')}</div>`:`<p class="field-help">${has.error?esc(has.error):has.kind?'No keys yet.':'Opaya does not know where this agent reads keys.'}</p>`}</div></div>`;
  }
  // A project's git state from projectInfo: git is {branch: "main...origin/main [ahead 2]", changes: [porcelain lines]}
  // (or null outside a repository); a remote copy's info has branch, dirty and unpushed already.
  const gitSummary=i=>{if(!i)return null;const g=i.git;
    if(g&&typeof g==='object'){const m=String(g.branch||'').match(/^(?:No commits yet on )?(\S+?)(?:\.\.\.(\S+))?(?:\s+\[([^\]]+)\])?$/)||[],ahead=/ahead (\d+)/.exec(m[3]||''),behind=/behind (\d+)/.exec(m[3]||'');
      return {git:true,branch:m[1]||'detached',upstream:m[2]||'',dirty:(g.changes||[]).length,unpushed:ahead?Number(ahead[1]):0,behind:behind?Number(behind[1]):0};}
    return g===true?{git:true,branch:i.branch||'detached',upstream:i.upstream||'',dirty:i.dirty||0,unpushed:i.unpushed||0,behind:0}:{git:false};};
  function gitPanel(a){
    const list=agentProjects(a);
    const card=p=>{const g=projectGit.get(p.id),i=gitSummary(g?.info);
      return `<article class="mg-project" data-project="${esc(p.id)}"><header><span class="project-folder" aria-hidden="true"></span><div><strong>${esc(p.name)}</strong><small title="${esc(p.path)}">${esc(p.path)}</small></div></header>
        <div class="mg-git-line">${!g?'<span class="field-help">Reading git...</span>':g.error?`<span class="field-help">${esc(g.error)}</span>`:i?.git?`<span class="mg-branch">&#5833; ${esc(i.branch)}</span>${i.dirty?`<span class="mg-pill warn">${i.dirty} changed</span>`:'<span class="mg-pill ok">clean</span>'}${i.unpushed?`<span class="mg-pill">${i.unpushed} to push</span>`:''}${i.behind?`<span class="mg-pill">${i.behind} to pull</span>`:''}${i.upstream?`<span class="mg-remote" title="Tracks ${esc(i.upstream)}">${esc(i.upstream)}</span>`:''}`:'<span class="field-help">Not a git repository</span>'}</div>
        <footer>${i?.git?`<button type="button" class="mg-icon-btn" data-action="git-run" data-git="pull" data-id="${esc(p.id)}" title="Pull">&#8595; Pull</button><button type="button" class="mg-icon-btn go" data-action="git-run" data-git="commitPush" data-id="${esc(p.id)}" title="Commit everything and push">&#10003; Commit & push</button><button type="button" class="mg-icon-btn" data-action="git-run" data-git="push" data-id="${esc(p.id)}" title="Push">&#8593; Push</button>`:''}<button type="button" class="mg-icon-btn" data-action="project-chat" data-id="${esc(p.id)}" data-agent="${esc(a.id)}" title="New chat with ${esc(title(a))} in ${esc(p.name)}">Chat here</button><button type="button" class="mg-icon-btn" data-action="git-more" data-id="${esc(p.id)}" title="Every git and GitHub action">&#8943;</button></footer><span class="mg-remote-node" aria-hidden="true"></span></article>`;};
    return `${list.length?`<div class="mg-projects">${list.map(card).join('')}</div>`:`<div class="mg-empty-row"><p>No projects yet. Add a folder and ${esc(title(a))} can work in it, here or on its machine.</p></div>`}`;
  }
  // Nodes of the 3D stage: what the agent is connected to.
  function stageNodes(a){
    const keys=keyLists.get(a.id)?.keys?.length||0,projects=agentProjects(a).length,chats=agentChats(a).length,box=containerOf(a);
    return [{kind:'machine',label:location(a),on:true},{kind:'docker',label:box||'No container',on:!!box},{kind:'key',label:keys?`${keys} key${keys===1?'':'s'}`:'No keys',on:!!keys},{kind:'git',label:projects?`${projects} project${projects===1?'':'s'}`:'No projects',on:!!projects},{kind:'skill',label:'Skills',on:a.status==='connected'},{kind:'chat',label:chats?`${chats} chat${chats===1?'':'s'}`:'No chats',on:!!chats}];
  }
  function mountStage(a){
    const S=stage(),slot=$('#mg-stage');if(!S||!slot)return;
    heroCtl=heroCtl||S.heroStage();if(heroCtl.el.parentElement!==slot)slot.append(heroCtl.el);
    heroCtl.set({agent:a.id,status:a.error?'error':a.status,busy:!!a.busy,nodes:stageNodes(a)});
  }
  window.addEventListener('opaya-stage',()=>{if(manageId)render();});
  // ---- The agent's own sidebar: its views, its chats and its Manage sections, in that order ---------------------------
  const anI=d=>`<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
  const AN_ICON={
    chat:anI('<path d="M4 5h16v11H9l-5 4z"/>'),console:anI('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m7 10 3 2-3 2M13 15h4"/>'),overview:anI('<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>'),
    power:anI('<path d="M12 3v8M6.3 7.3a8 8 0 1 0 11.4 0"/>'),plus:anI('<path d="M12 5v14M5 12h14"/>'),
    model:anI('<path d="M12 3 20 12l-8 9-8-9z"/>'),access:anI('<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M16 7l3 3"/>'),machine:anI('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>'),
    deploy:anI('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/>'),projects:anI('<path d="M3 7h7l2 2h9v10H3z"/>'),care:anI('<path d="M20 12a8 8 0 1 1-3-6.2M20 4v5h-5"/>'),
    profile:anI('<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/>'),danger:anI('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>')};
  Object.assign(AN_ICON,{pop:anI('<path d="M14 4h6v6M20 4l-8 8"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>'),export:anI('<path d="M12 4v11M7 10l5 5 5-5M4 19h16"/>'),history:anI('<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>'),
    search:anI('<circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5"/>')});
  // The agent sidebar's chat search (kept while you move between its chats).
  let anFilter='';
  document.addEventListener('input',event=>{if(event.target.id!=='an-chat-filter')return;anFilter=event.target.value;const a=selected();if(a)renderAgentNav(a,'chat');});
  document.addEventListener('keydown',event=>{if(event.target.id==='an-chat-filter'&&event.key==='Escape'&&anFilter){event.preventDefault();event.stopPropagation();anFilter='';const a=selected();if(a)renderAgentNav(a,'chat');}},true);
  // A chat's day group, as the sidebar and History list them.
  function dayLabel(iso){const t=new Date(iso).getTime(),today=new Date();today.setHours(0,0,0,0);const d=today.getTime(),day=864e5;return t>=d?'Today':t>=d-day?'Yesterday':t>=d-6*day?'This week':t>=d-29*day?'This month':'Older';}
  Object.assign(AN_ICON,{keys:AN_ICON.access,vault:AN_ICON.access,mcp:anI('<path d="M9 7V3M15 7V3M6 7h12v4a6 6 0 0 1-12 0z"/><path d="M12 17v4"/>'),machines:AN_ICON.machine,newVps:AN_ICON.plus,dockerize:anI('<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12 4 7.5"/>'),backups:AN_ICON.projects,surface:AN_ICON.chat,connect:AN_ICON.power,library:anI('<path d="m12 3 2 6 6 2-6 2-2 6-2-6-6-2 6-2z"/>'),shareSkills:anI('<path d="M4 8h13l-3-3M20 16H7l3 3"/>')});
  // From general to specific; each action of the agent is in exactly one of them. hk: its key on the Manage screens.
  const AN_SECTIONS=[
    {key:'overview',name:'Overview',desc:'Everything about it at a glance.',icon:AN_ICON.overview},
    {key:'model',name:'Model & skills',desc:'What it answers with and what it can do.',icon:AN_ICON.model,hk:'Q'},
    {key:'access',name:'Keys & tools',desc:'API keys, MCP servers and what it may do without asking.',icon:AN_ICON.access,hk:'W'},
    {key:'machine',name:'Machine & Docker',desc:'Where it runs: files, terminals and its container.',icon:AN_ICON.machine,hk:'E'},
    {key:'deploy',name:'Deploy & clone',desc:'Copy it to another machine or into Docker.',icon:AN_ICON.deploy,hk:'R'},
    {key:'projects',name:'Projects',desc:'Folders it works in, with git.',icon:AN_ICON.projects,hk:'A'},
    {key:'care',name:'Updates & backups',desc:'Keep it current, backed up and healthy.',icon:AN_ICON.care,hk:'S'},
    {key:'profile',name:'Profile & connection',desc:'Its name and look, and how Opaya reaches it.',icon:AN_ICON.profile,hk:'D'},
    {key:'danger',name:'Danger zone',desc:'Uninstall it, or remove it from Opaya.',icon:AN_ICON.danger,hk:'F'}];
  // Sub-menus: the actions of each view and section, in the order its page lists them. A key that the agent does not
  // have (no container, no gateway...) is left out.
  const AN_SUB={
    chat:[['chatWindow','Open in a window'],['export','Export this chat']],
    console:[['terminal','New CLI window'],['shell','New shell window'],['files','Files']],
    model:[['models','Model'],['effort','Reasoning'],['skills','Skills & commands'],['shareSkills','Share skills'],['library','Skills library']],
    access:[['keys','API keys'],['vault','Opaya Vault'],['mcp','MCP servers'],['transfer','Share with another agent'],['gateway','Gateway'],['itrust','iTrust'],['browser','Opaya browser']],
    machine:[['machines','Its machine in Machines'],['files','Files'],['terminal','CLI'],['shell','Shell'],['containerRestart','Restart container'],['containerLogs','Container logs']],
    deploy:[['clone','Clone'],['dockerize','Dockerize'],['redeploy','Redeploy'],['newVps','New VPS']],
    projects:[['projects','Add project']],
    care:[['update','Update'],['backup','Back up'],['backups','Backups folder'],['fix','Check & fix'],['log','Connection log']],
    profile:[['rename','Name'],['icon','Icon'],['groupTags','Group & tags'],['pin','Pin to top'],['moveUp','Move up'],['moveDown','Move down'],['restart','Reconnect'],['clearError','Clear error'],['settings','Connection settings'],['surface','Allow chat again'],['copyCommand','Copy launch command'],['copyId','Copy agent ID']],
    danger:[['uninstall','Uninstall'],['remove','Remove connection']]};
  // Clones, backups, uninstalls and redeploys running for an agent.
  const agentJobs=a=>[...jobs.values()].filter(j=>j.status==='running'&&(j.kind==='clone'&&j.route?.from===a.name||['backup','uninstall','redeploy'].includes(j.kind)&&String(j.title||'').includes(a.name)));
  let anHtml='';
  {let t=0;const off=()=>{clearTimeout(t);document.body.classList.remove('show-hk');};
    document.addEventListener('keydown',e=>{if((e.key==='Control'||e.key==='Meta')&&!e.repeat){clearTimeout(t);t=setTimeout(()=>document.body.classList.add('show-hk'),350);}else if(!e.ctrlKey&&!e.metaKey)off();});
    document.addEventListener('keyup',e=>{if(e.key==='Control'||e.key==='Meta')off();});window.addEventListener('blur',off);}
  // The Opaya Agent's own sidebar: its chat and setup guide, its chats, its settings and the tools it is for.
  function opayaSideHtml(){
    const o=opaya(),label=o.busy?'Working...':o.configured?opayaModelLabel(o):'Choose a model',G=guideOn();
    const item=(cls,attrs,icon,label,extra='')=>`<button type="button" class="an-item ${cls}" ${attrs}><span class="an-ico" aria-hidden="true">${icon}</span><span class="an-label">${esc(label)}</span>${extra}</button>`;
    const I2=anI;
    return `<div class="an-head">
        <button type="button" class="an-id" data-action="opaya" title="Opaya Agent"><span class="agent-avatar opaya-avatar"><span class="opaya-mark small"><img src="assets/opaya-logo.png" alt=""><i></i></span></span><span class="an-id-text"><strong>Opaya Agent</strong><small><span class="status-dot ${o.busy?'working':o.configured?'connected':'disconnected'}"></span>${esc(label)}</small></span></button>
      </div>
      <nav class="an-views" aria-label="Opaya Agent">
        ${item(G?'':'active','data-action="opaya-chat" title="Chat with the Opaya Agent"',AN_ICON.chat,'Chat')}
        ${item(G?'active':'','data-action="guide-open" title="A guided setup that needs no AI model"',I2('<path d="M4 19V5a2 2 0 0 1 2-2h12v18H6a2 2 0 0 1-2-2zM8 7h6M8 11h6"/>'),'Setup guide')}
      </nav>
      <div class="an-scroll">
        <section class="an-group"><header><span>Chats</span><button type="button" class="an-add" data-action="opaya-new" title="New chat" aria-label="New chat">${AN_ICON.plus}</button></header>
          ${(o.sessions||[]).length?o.sessions.slice(0,8).map(x=>`<button type="button" class="an-chat ${!G&&x.id===o.sessionId?'active':''}" data-action="opaya-session" data-id="${esc(x.id)}" title="${esc(x.title)}" ${o.busy?'disabled':''}><span>${esc(x.title)}</span></button>`).join(''):'<p class="an-empty">No chats yet</p>'}
        </section>
        <section class="an-group"><header><span>Settings</span></header>
          ${item('','data-action="opaya-config" title="The model the Opaya Agent thinks with"',AN_ICON.model,'Model',`<small class="an-val">${esc(o.configured?opayaModelLabel(o):'Not set')}</small>`)}
          ${item('','data-action="opaya-itrust" role="switch" aria-checked="'+(!!state.settings?.itrustOpaya)+'" title="Let it act without asking each time (removals still ask)"',I2('<path d="M12 3 20 6v6c0 5-4 8-8 9-4-1-8-4-8-9V6z"/>'),'iTrust',`<span class="an-switch ${state.settings?.itrustOpaya?'on':''}" aria-hidden="true"></span>`)}
          ${item('','data-action="vault" title="Every API key and token you keep in Opaya"',AN_ICON.access,'Opaya Vault')}
        </section>
        <section class="an-group"><header><span>Tools</span></header>
          ${item('','data-action="discover" title="Find agents installed here or on a machine"',I2('<circle cx="12" cy="12" r="8"/><path d="M12 12 17 7M12 4v2M20 12h-2"/>'),'Discover agents')}
          ${item('','data-action="install-catalog" title="Install agents and their dependencies"',I2('<path d="M12 4v11M7 10l5 5 5-5M4 19h16"/>'),'Install agents')}
          ${item('','data-action="opaya-check-all" title="Check every agent with a connection error"',AN_ICON.care,'Check & fix all')}
          ${item('','data-action="fleet" title="Every machine and its agents"',AN_ICON.machine,'Machines')}
          ${item('','data-action="schedules" title="Messages Opaya sends on a schedule"',I2('<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>'),'Schedules')}
        </section>
      </div>`;
  }
  let anFilterAgent='';
  function renderAgentNav(a,screen){
    const nav=$('#agent-side');if(!nav)return;
    if(a&&a.id!==anFilterAgent){anFilterAgent=a.id;anFilter='';}
    if(screen==='opaya'){const html=opayaSideHtml();if(nav.hidden){nav.hidden=false;document.body.classList.add('agent-open');requestAnimationFrame(()=>placePanes());}if(html!==anHtml){anHtml=html;nav.innerHTML=html;}return;}
    if(!a||!screen){if(!nav.hidden){nav.hidden=true;anHtml='';document.body.classList.remove('agent-open');requestAnimationFrame(()=>placePanes());}return;}
    // The sidebar follows the view open in the top bar's Chat / Terminal / Manage tabs (they are the only switch):
    // Chat lists the agent's chats, Terminal its terminal windows, Manage its sections.
    const chatty=a.protocol!=='terminal'&&a.surface!=='terminal',on=a.status==='connected';
    const item=(cls,attrs,icon,label,extra='')=>`<button type="button" class="an-item ${cls}" ${attrs}><span class="an-ico" aria-hidden="true">${icon}</span><span class="an-label">${esc(label)}</span>${extra}</button>`;
    const acts=manageActions(a);
    // The view's actions as rows: a label beside the sidebar's full width, an icon in the narrow sidebar.
    const actRow=(section,k,icon,label,hint,cls='')=>{const x=acts[k];if(!x)return '';return item(cls,`data-action="an-sub" data-section="${section}" data-key="${k}" ${x.disabled?`disabled`:''} title="${esc(x.disabled?x.hint||'Unavailable for this agent':hint)}"`,icon,label);};
    let body='',foot='';
    if(screen==='chat'&&chatty){
      const chats=agentChats(a),cur=currentConversation(),q=anFilter.trim().toLowerCase();
      const list=q?chats.filter(c=>`${chatLabel(c)} ${projectOf(c)?.name||''}`.toLowerCase().includes(q)):chats,groups=[];
      for(const c of list.slice(0,300)){const l=dayLabel(c.createdAt);let g=groups.find(x=>x[0]===l);if(!g)groups.push(g=[l,[]]);g[1].push(c);}
      const row=c=>`<div class="an-chat-row ${cur?.id===c.id?'active':''}" data-hist="${esc(c.id)}"><button type="button" class="an-chat ${cur?.id===c.id?'active':''}" data-action="an-chat" data-id="${esc(c.id)}" title="${esc(chatLabel(c))}" ${cur?.id===c.id?'aria-current="true"':''}><span>${esc(chatLabel(c))}</span><small>${a.busy&&cur?.id===c.id?'<span class="status-dot working"></span>':esc(ago(c.createdAt))}</small></button><button type="button" class="an-row-act" data-action="an-pop" data-id="${esc(c.id)}" title="Open in a window: it floats beside every screen while you work elsewhere" aria-label="Open ${esc(chatLabel(c))} in a window">${AN_ICON.pop}</button></div>`;
      body=`<section class="an-group an-chats"><header><span>Chats${chats.length?` <small>${chats.length}</small>`:''}</span><button type="button" class="an-add" data-action="an-new-chat" data-id="${esc(a.id)}" title="New chat (${mod()}N)" aria-label="New chat">${AN_ICON.plus}</button></header>
          ${chats.length>6?`<div class="an-search"><span aria-hidden="true">${AN_ICON.search}</span><input id="an-chat-filter" type="search" placeholder="Search chats" aria-label="Search ${esc(title(a))}'s chats" autocomplete="off" spellcheck="false"></div>`:''}
          <div class="an-chat-list">${groups.map(([l,items])=>`<div class="an-day">${esc(l)}</div>${items.map(row).join('')}`).join('')||`<p class="an-empty">${chats.length?'No chat matches.':'No chats yet. Start one with +.'}</p>`}</div></section>`;
      foot=[item('rail-only',`data-action="an-new-chat" data-id="${esc(a.id)}" title="New chat (${mod()}N)"`,AN_ICON.plus,'New chat'),
        item('',`data-action="an-pop" data-id="${esc(cur?.id||'')}" ${cur?'':'disabled'} title="Move this chat into a floating window. It stays open beside every screen; its expand button brings it back here."`,AN_ICON.pop,'Open in a window'),
        item('',`data-action="export" ${cur?'':'disabled'} title="Save this chat as a Markdown file"`,AN_ICON.export,'Export this chat'),
        item('',`data-action="history-toggle" title="Every agent's chats, with search (${mod()}Shift+H)"`,AN_ICON.history,'All history')].join('');
    }else if(screen==='console'){
      const wins=ctxWindows(a.id);
      body=`<section class="an-group an-terms"><header><span>Terminal windows${wins.length?` <small>${wins.length}</small>`:''}</span></header>
          ${wins.length?wins.map(v=>`<button type="button" class="an-chat an-win ${v.hiddenPane?'hidden':''} ${v.exited?'ended':''} ${v.id===currentTerminal&&!v.hiddenPane?'active':''}" data-action="an-term" data-id="${esc(v.id)}" title="${v.hiddenPane?'Hidden: click to show it':'Show this window'}"><span>${esc(tabTitle(v))}</span><small>${v.exited?'ended':v.hiddenPane?'hidden':'open'}</small></button>`).join(''):`<p class="an-empty">No terminal windows yet.</p>`}</section>`;
      // New windows come from the terminal's own + New; the sidebar adds what the terminal does not show.
      foot=actRow('console','files',AN_ICON.projects,'Files',`Browse files on ${location(a)}`);
    }else{
      const keys=keyLists.get(a.id),backAt=backupLists.get(a.id)?.backups?.[0]?.createdAt,running=agentJobs(a).length;
      const flag={access:keys&&!keys.keys.length?'warn':'',care:running?'busy':a.install?.backup&&backupLists.has(a.id)&&(!backAt||Date.now()-new Date(backAt)>7*864e5)?'warn':'',profile:a.error?'bad':''};
      body=`<section class="an-group"><header><span>Manage</span></header>
          ${item(mgSection==='overview'?'active':'','data-action="agent-section" data-key="overview" title="Overview: status, what it is connected to and quick actions (Esc)"',AN_ICON.overview,'Overview')}
          ${AN_SECTIONS.slice(1).map(x=>item(`${mgSection===x.key?'active':''} ${x.key==='danger'?'danger':''}`,`data-action="agent-section" data-key="${x.key}" title="${esc(x.desc)} (${x.hk})"`,x.icon,x.name,`${flag[x.key]?`<span class="an-flag ${flag[x.key]}"></span>`:''}<kbd>${x.hk}</kbd>`)).join('')}
        </section>`;
    }
    const html=`<div class="an-head">
        <button type="button" class="an-id" data-action="agent-section" data-key="overview" title="${esc(title(a))}: overview">${badge(a)}<span class="an-id-text"><strong>${esc(title(a))}</strong><small>${dot(a)}${esc(status(a))}</small><small class="an-where" title="${esc(location(a))}">${esc(location(a))}</small></span></button>
        <button type="button" class="an-power ${on?'on':''} ${a.status==='connecting'||a.busy?'busy':''}" data-action="an-connect" data-id="${esc(a.id)}" title="${esc(agentActions(a).connect.label)}" aria-label="${esc(agentActions(a).connect.label)}" aria-pressed="${on}">${AN_ICON.power}</button>
      </div>
      <div class="an-scroll an-mode-${esc(screen)}">${body}</div>${foot?`<div class="an-foot" role="group" aria-label="${screen==='chat'?'This chat':'Terminal'}">${foot}</div>`:''}`;
    // Typing in the chat search re-renders the list; the box keeps its text, focus and caret.
    const typing=document.activeElement?.id==='an-chat-filter'?[document.activeElement.selectionStart,document.activeElement.selectionEnd]:null;
    if(nav.hidden){nav.hidden=false;document.body.classList.add('agent-open');requestAnimationFrame(()=>placePanes());}
    if(html!==anHtml){anHtml=html;nav.innerHTML=html;}
    const f=$('#an-chat-filter');if(f){if(f.value!==anFilter)f.value=anFilter;if(typing){f.focus();f.setSelectionRange(...typing);}}
  }
  // Every action of an agent by key, as the Manage pages and the agent's sidebar offer them; manage-run runs them.
  function manageActions(a){
    const x=agentActions(a),cap=a.install||{},box=containerOf(a);
    const keyed=Object.fromEntries(Object.entries(x).filter(([,v])=>v).map(([k,v])=>[k,{...v,key:k}]));
    if(a.protocol!=='terminal')keyed.models={key:'models',icon:'&#9672;',label:'Choose model',run:()=>openModels()};
    if(Array.isArray(a.efforts)&&a.efforts.length)keyed.effort={key:'effort',icon:'&#9889;',label:`Reasoning effort: ${a.effort?EFFORT_LABELS[a.effort]||a.effort:'auto'}`,run:()=>openDefaultEffort(a)};
    if(['hermes','openclaw'].includes(a.provider))keyed.gateway={key:'gateway',icon:'&#9889;',label:'Gateway status',run:()=>openGateway()};
    // The CLI when the agent has one; an API agent has only the shell (its own "shell" action), not a second copy of it.
    keyed.terminal={key:'terminal',icon:'&gt;_',label:`Open ${title(a)} CLI`,disabled:!hasCli(a),hint:hasCli(a)?'':'This connection has no native CLI.',run:()=>openTerminal({agentId:a.id,mode:'agent'})};
    keyed.fix={key:'fix',icon:'&#10038;',label:'Check & fix with Opaya Agent',run:()=>askOpayaToFix(a)};
    keyed.keys={key:'keys',icon:'&#9919;',label:'Keys',run:()=>openAgentKeys(a)};
    keyed.fullChat={key:'fullChat',icon:'&#9634;',label:'Full chat view',run:()=>setAgentMode(a,'full')};
    keyed.console={key:'console',icon:'&gt;_',label:'Terminal',run:()=>setAgentMode(a,'console')};
    keyed.restart={key:'restart',icon:'&#8635;',label:'Reconnect',hint:'Disconnect and connect again',disabled:a.busy||a.status==='connecting',run:async()=>{if(a.status==='connected')await api.disconnect({id:a.id});await api.connect({id:a.id});toast(`${title(a)} reconnected.`);}};
    keyed.copyId={key:'copyId',icon:'#',label:'Copy agent ID',run:async()=>{await api.clipboardWrite({text:a.id});toast('Agent ID copied.');}};
    if(a.command)keyed.copyCommand={key:'copyCommand',icon:'&#10095;',label:'Copy launch command',run:async()=>{await api.clipboardWrite({text:[a.command,...(a.args||[])].join(' ')});toast('Launch command copied.');}};
    if(box)keyed.containerRestart={key:'containerRestart',icon:'&#8635;',label:'Restart container',run:()=>dockerDo(dockerKeyOf(a),box,'restart')};
    if(box)keyed.containerLogs={key:'containerLogs',icon:'&#8801;',label:'Container logs',run:()=>api.dockerTerminal({hostId:a.transport==='ssh'?a.hostId:undefined,container:box,kind:'logs'})};
    keyed.chat={key:'chat',icon:'&#9993;',label:'Chat',run:()=>setAgentMode(a,'chat')};
    keyed.chatWindow={key:'chatWindow',icon:'&#9993;',label:'Chat window',run:()=>openChatWindow(a)};
    keyed.vault={key:'vault',icon:'&#9919;',label:'Opaya Vault',run:()=>openVault()};
    keyed.newVps={key:'newVps',icon:'+',label:'New VPS',run:()=>openNewVps()};
    if(cloneable(a)&&canDocker(a)&&!box)keyed.dockerize={key:'dockerize',icon:'&#9635;',label:'Dockerize',run:()=>deployTo(a,a.transport==='ssh'?a.hostId:'','docker',$('.deploy-token')||$('.mg-card')||$('.an-head .agent-avatar'),$('.mg-dockerize')||$('.mg-target[data-deploy-runtime="docker"]')||$('.an-head .agent-avatar'))};
    // "surface" is either Allow chat again (its vendor refused chats) or the full chat view; only the first is a setting.
    if(keyed.surface&&!/^Allow/.test(keyed.surface.label))delete keyed.surface;
    keyed.machines={key:'machines',label:'Its machine in Machines',run:()=>openFleet(dockerKeyOf(a))};
    keyed.mcp={key:'mcp',label:'MCP servers',run:()=>openMcpManager()};
    if(cap.backup)keyed.backups={key:'backups',label:'Backups folder',run:()=>api.revealBackup({folder:true})};
    keyed.library={key:'library',label:'Skills library',run:()=>openLibrary()};
    keyed.shareSkills={key:'shareSkills',icon:'&#8644;',label:'Share skills',disabled:state.agents.length<2,run:()=>openTransfer(a,{skills:'all',keys:'none'})};
    keyed.history={...keyed.history,label:'Search chats'};
    return keyed;
  }
  function renderManage(a){
    const cap=a.install||{},info=installInfo.get(a.id),backs=backupLists.get(a.id),shared=sharedWith(a),box=containerOf(a);
    topbar(`<strong>${esc((AN_SECTIONS.find(s=>s.key===mgSection)||AN_SECTIONS[0]).name)}</strong>`,'','manage');
    contentKind('overview manage command-center');
    const keyed=manageActions(a),cliKey=hasCli(a)?'terminal':'shell';
    manageKeyed=keyed;
    const backupRows=backs?.backups?.length?`<div class="backup-list">${backs.backups.slice(0,4).map(b=>`<div class="backup-row"><span class="backup-file" title="${esc(b.file)}">${esc(whenText(b.createdAt))}</span><small>${esc(fmtSize(b.bytes))}${b.history===false?' / no history':''}${b.keys===false?' / no keys':''}</small><button type="button" class="text-button" data-action="backup-reveal" data-file="${esc(b.file)}">Show</button><button type="button" class="text-button danger-text" data-action="backup-delete" data-file="${esc(b.file)}" data-id="${esc(a.id)}">Delete</button></div>`).join('')}</div>`:'';
    const picker=sidebarHidden&&state.agents.length>1?`<nav class="manage-switch" aria-label="Agent to manage"><span>Agents</span>${state.agents.map(y=>`<button type="button" class="manage-pick ${y.id===a.id?'selected':''}" data-action="manage" data-id="${esc(y.id)}" title="${esc(title(y)+' / '+placeText(y)+' / '+status(y))}" ${y.id===a.id?'aria-current="page"':''}>${badge(y)}<span>${esc(title(y))}</span>${dot(y)}</button>`).join('')}</nav>`:'';
    const I=d=>`<svg viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`,circle='<circle cx="12" cy="12" r="8"/>';
    const ICON={chat:I('<path d="M4 5h16v11H9l-5 4z"/>'),fullChat:I('<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 9h16"/>'),console:I('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m7 10 3 2-3 2M13 15h4"/>'),terminal:I('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m7 10 3 2-3 2M13 15h4"/>'),shell:I('<path d="m5 7 5 5-5 5M12 17h7"/>'),files:I('<path d="M3 7h7l2 2h9v10H3z"/>'),history:I(circle+'<path d="M12 8v4l3 2"/>'),projects:I('<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18"/>'),models:I('<path d="M12 3 20 12l-8 9-8-9z"/>'),effort:I('<path d="M13 3 5 14h6l-1 7 8-11h-6z"/>'),skills:I('<path d="m12 3 2 6 6 2-6 2-2 6-2-6-6-2 6-2z"/>'),transfer:I('<path d="M4 8h13l-3-3M20 16H7l3 3"/>'),itrust:I('<path d="M12 3 20 6v6c0 5-4 8-8 9-4-1-8-4-8-9V6z"/>'),browser:I(circle+'<path d="M4 12h16M12 4c3 3 3 13 0 16-3-3-3-13 0-16"/>'),update:I('<path d="M20 12a8 8 0 1 1-3-6.2M20 4v5h-5"/>'),backup:I('<path d="M12 4v11M7 10l5 5 5-5M4 19h16"/>'),restart:I('<path d="M12 3v8M6.3 7.3a8 8 0 1 0 11.4 0"/>'),fix:I('<path d="m5 19 9-9M15 4l1.2 2.8L19 8l-2.8 1.2L15 12l-1.2-2.8L11 8l2.8-1.2z"/>'),log:I('<path d="M5 7h14M5 12h14M5 17h9"/>'),gateway:I('<path d="M13 3 5 14h6l-1 7 8-11h-6z"/>'),clone:I('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/>'),redeploy:I('<path d="M4 12a8 8 0 0 1 14-5.3M20 4v5h-5M20 12a8 8 0 0 1-14 5.3M4 20v-5h5"/>'),containerRestart:I('<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12 4 7.5"/>'),containerLogs:I('<path d="M5 7h14M5 12h14M5 17h9"/>'),rename:I('<path d="M4 20h4L19 9l-4-4L4 16z"/>'),icon:I(circle+'<path d="M9 10h.01M15 10h.01M8.5 14.5c2 2 5 2 7 0"/>'),groupTags:I('<path d="M3 12V4h8l10 10-8 8z"/><path d="M7.5 7.5h.01"/>'),pin:I('<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2-5.5-2.9-5.5 2.9 1-6.2L3 9.6l6.2-.9z"/>'),moveUp:I('<path d="M12 19V5M6 11l6-6 6 6"/>'),moveDown:I('<path d="M12 5v14M6 13l6 6 6-6"/>'),settings:I('<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>'),copyId:I('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4V4h11v1"/>'),copyCommand:I('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4V4h11v1"/>'),clearError:I(circle+'<path d="m9 9 6 6M15 9l-6 6"/>'),uninstall:I('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>'),remove:I('<path d="m6 6 12 12M18 6 6 18"/>')};
    const infoReady=info&&info!=='loading';
    // ---- Manage: an overview and eight sections, each listed once in the agent's own sidebar --------------------------
    // Every action lives in exactly one section, with one name. A row is one setting: what it is, its value, one action.
    const lastBack=backs?.backups?.[0],backAge=lastBack?(Date.now()-new Date(lastBack.createdAt))/86400000:Infinity;
    const running=agentJobs(a);
    const keyList=keyLists.get(a.id),mcps=(state.mcpServers||[]).filter(s=>usesMcp(s,a)),skillList=skillCache.get(a.id),projs=agentProjects(a);
    const hostKey=dockerKeyOf(a),check=hostChecks.get(hostKey)?.result,dv=dockerViews.get(hostKey)?.result,tools=(state.toolUpdates?.machines?.[hostKey]?.items||[]).filter(t=>t.installed);
    const OS={win32:'Windows',darwin:'macOS',linux:'Linux'};
    const sys=cap.kind==='remote-api'?'Provider server':hostKey==='local'?[OS[state.platform]||state.platform,state.machine?.hostname].filter(Boolean).join(' / '):check?[check.os||check.system,check.memory&&`memory ${check.memory}`,check.disk&&`disk ${check.disk}`].filter(Boolean).join(' / '):'Not checked yet';
    const proto=a.protocol==='openai'?'Gateway API':String(a.protocol||'').toUpperCase();
    // Tools print their version their own way ("Hermes Agent v0.21.5 (2026.9.24) · upstream 645da656"): show the number.
    const fullVersion=infoReady&&info.version?String(info.version).trim():'',vNum=/\bv?(\d+\.\d+(?:\.\d+)?(?:-[\w.]+)?)/.exec(fullVersion),version=fullVersion?vNum?`v${vNum[1]}`:fullVersion.slice(0,24):'';
    const ok=k=>keyed[k]&&!keyed[k].disabled;
    // A row: icon, label with help, value, then a chevron (one action), a switch, or nothing (read-only).
    const row=(k,label,help,value='',o={})=>{const can=o.act||ok(k),sw=o.sw!==undefined,tone=o.tone?` ${o.tone}`:'';
      const inner=`<span class="set-ico" aria-hidden="true">${o.icon||ICON[k]||AN_ICON[k]||''}</span><span class="set-text"><strong>${esc(label)}</strong>${help?`<small>${esc(help)}</small>`:''}</span>${value!==''?`<span class="set-val${tone}" title="${esc(value)}">${esc(value)}</span>`:''}${sw?`<span class="set-switch ${o.sw?'on':''}" aria-hidden="true"></span>`:can?`<span class="set-go" aria-hidden="true">${o.go||'&#8250;'}</span>`:''}`;
      if(!can)return keyed[k]?.disabled?`<div class="set-row unavailable" aria-disabled="true">${inner}<small class="unavailable-reason">${esc(keyed[k].hint||'Unavailable for this agent')}</small></div>`:o.always?`<div class="set-row${o.wrap?' wrap':''}">${inner}</div>`:'';
      const attrs=o.act?`data-action="${o.act}"${o.id?` data-id="${esc(o.id)}"`:''}`:`data-action="manage-run" data-key="${k}"`;
      return `<button type="button" class="set-row${o.danger?' danger':''}" ${attrs} ${sw?`role="switch" aria-checked="${!!o.sw}"`:''}>${inner}</button>`;};
    const card=(name,rows,note='')=>{const r=rows.filter(Boolean).join('');return r?`<section class="set-group">${name?`<h2>${esc(name)}</h2>`:''}<div class="set-card">${r}</div>${note?`<p class="set-note">${note}</p>`:''}</section>`:'';};
    // A section of the page: its icon, name and what it is for, its own buttons, then its cards (side by side when there
    // is room) and any wide panel (Docker, deploy targets, keys to give).
    const head=(s,actions='')=>`<header class="mg-sec-head"><span class="pg-ico" aria-hidden="true">${s.icon}</span><div class="pg-title"><h2>${esc(s.name)}</h2><p>${esc(s.desc)}</p></div>${actions?`<div class="pg-actions">${actions}</div>`:''}<kbd class="mg-sec-hk" title="Press ${s.hk} on this screen to come back here">${s.hk}</kbd></header>`;
    const sec=(key,actions,cards,wide='')=>{const s=AN_SECTIONS.find(x=>x.key===key),body=cards.filter(Boolean).join('');return `<section class="mg-sec ${key}" id="mgs-${key}" data-section="${key}" aria-labelledby="mgs-${key}-h">${head(s,actions).replace('<h2>',`<h2 id="mgs-${key}-h">`)}${body?`<div class="mg-cards">${body}</div>`:''}${wide}</section>`;};
    const pbtn=(k,label,cls='secondary small')=>keyed[k]?`<span class="manage-quick"><button type="button" class="${cls}" data-action="manage-run" data-key="${k}" ${keyed[k].disabled?'disabled':''}>${esc(label)}</button>${keyed[k].disabled?`<small>${esc(keyed[k].hint||'Unavailable for this agent')}</small>`:''}</span>`:'';
    const keysVal=keyList?keyList.keys.length?keyList.keys.map(k=>k.name).join(', '):'None':'Reading...';
    const statusTone=a.error?'bad':a.status==='connected'?'ok':'';
    // Agents on the same installation (Hermes profiles on one Hermes, two connections to one CLI): an update updates all
    // of them. Deleting a profile removes only that profile; uninstalling the program they run on stops all of them.
    const isProfile=cap.kind==='hermes-profile',dependents=shared.filter(b=>b.install?.kind==='hermes-profile'),names=andList(shared.map(title));
    const sharedHelp=!shared.length?'':isProfile?`A profile on the same ${cap.label?.replace(/ profile.*$/,'')||'Hermes'} as ${names}. Updating Hermes updates all of them; deleting this profile leaves them as they are.`:dependents.length?`${andList(dependents.map(title))} ${dependents.length===1?'is a profile':'are profiles'} on this ${labels[cap.framework]||cap.label||'installation'}. Updating it updates them too; uninstalling it stops them.`:`${names} ${shared.length===1?'uses':'use'} the same ${cap.label||'installation'}. Updating or uninstalling it affects them too.`;
    // The top: who it is and how it is, with the three ways to use it. Each fact opens the section about it.
    const fact=(text,key,tone='',hint='')=>text?`<button type="button" class="ov-chip ${tone}" data-action="agent-section" data-key="${key}" title="${esc(hint||AN_SECTIONS.find(x=>x.key===key)?.name||'')}">${esc(text)}</button>`:'';
    const facts=[fact(location(a),'machine','','Machine & Docker'),fact(version,'care','',fullVersion?`${fullVersion} / Updates & backups`:''),fact(shared.length?`${isProfile?'Profile on':'Shared'} ${labels[cap.framework]||'install'} \u00b7 ${shared.length+1} agents`:'','care','',sharedHelp),
      fact(keyList?plural(keyList.keys.length,'API key'):'','access',keyList&&!keyList.keys.length?'warn':''),fact(cap.backup&&backs?lastBack?`Backed up ${ago(lastBack.createdAt)} ago`:'Never backed up':'','care',cap.backup&&backs&&(!lastBack||backAge>7)?'warn':''),fact(a.itrust?'iTrust on':'','access','warn')].join('');
    const ovHero=`<section class="mg-hero ov-hero" data-drop="key" data-agent-target="${esc(a.id)}"><div class="mg-stage" id="mg-stage" aria-hidden="true"></div><span class="mg-stage-caption" aria-hidden="true">What ${esc(title(a))} is connected to. Click one to open it.</span>
          <div class="mg-card glass ov-card" data-drag="agent" data-drag-id="${esc(a.id)}" title="Drag onto a machine in Deploy & clone to copy ${esc(title(a))} there">
            <div class="mg-id">${badge(a,true)}<div class="mg-id-text"><h1>${esc(title(a))}</h1><p>${esc(description(a))}</p></div></div>
            <div class="ov-facts"><span class="ov-status ${esc(a.busy?'working':a.error?'error':a.status||'disconnected')}"><i></i>${esc(status(a))}</span>${facts}</div>
            <div class="ov-actions">${ok('connect')?`<button type="button" class="${a.status==='connected'?'secondary':'primary'}" data-action="manage-run" data-key="connect">${esc(keyed.connect.label.replace(/\.\.\.$/,''))}</button>`:''}${a.protocol!=='terminal'&&a.surface!=='terminal'?`<button type="button" class="secondary" data-action="agent-mode" data-mode="chat" data-id="${esc(a.id)}">Chat</button>`:''}<button type="button" class="secondary" data-action="agent-mode" data-mode="console" data-id="${esc(a.id)}">Terminal</button></div>
          </div></section>`;
    const alerts=`${a.error?`<div class="inline-notice error-notice"><span>!</span><div><strong>Connection needs attention</strong><p>${esc(a.error)}</p><div class="notice-actions"><button type="button" class="primary small" data-action="manage-run" data-key="fix">Let the Opaya Agent fix it</button>${ok('restart')?'<button type="button" class="secondary small" data-action="manage-run" data-key="restart">Try again</button>':''}<button type="button" class="text-button" data-action="manage-run" data-key="settings">Edit connection</button></div></div></div>`:''}
      ${running.length?`<div class="ov-jobs">${running.map(j=>`<button type="button" class="ov-job" data-action="job-restore" title="${esc(j.title)}"><span>${esc(j.title)}</span><i style="--p:${jobPercent(j)}%"></i><small>${jobPercent(j)}%</small></button>`).join('')}</div>`:''}
      <div class="ov-actions ov-manage-actions" aria-label="Management actions">${[['update','Update',AN_ICON.care,'Newest version, the way it was installed'],['clone','Clone',AN_ICON.deploy,'Copy it to another machine or Docker'],['backup','Back up',dkIcon('pull'),'Save a copy on this computer'],['settings','Connection settings',AN_ICON.profile,'How Opaya reaches it'],['machines','Open machine',AN_ICON.machine,'Its machine: agents, Docker, versions']].map(([k,label,icon,sub])=>keyed[k]?`<button type="button" class="ov-qa" data-action="manage-run" data-key="${k}" ${keyed[k].disabled?'disabled':''} title="${esc(keyed[k].disabled?keyed[k].hint||'Unavailable for this agent':keyed[k].label||label)}"><span class="ov-qa-ico" aria-hidden="true">${icon}</span><span class="ov-qa-text"><strong>${esc(label)}</strong><small>${esc(keyed[k].disabled?`Not available: ${keyed[k].hint||'not for this agent'}`:sub)}</small></span></button>`:'').join('')}</div>`;
    const sections={
      model:()=>sec('model','',[card('Model',[
          row('models','Model','The model it answers with',modelText(a.activeModel||a.model)||'Its own setting'),
          row('effort','Reasoning','How long it thinks before answering',a.effort?EFFORT_LABELS[a.effort]||a.effort:'Auto')],'A chat can use its own model and reasoning: pick them under the message box.'),
        card('Skills',[
          row('skills','Skills & commands','What it can do; install new skills',skillList?skillList.supported===false?'Not readable':`${skillList.skills?.length||0} skills${a.commands?.length?`, ${a.commands.length} commands`:''}`:'Reading...'),
          row('shareSkills','Share skills','Copy its skills to another agent, here or on another machine'),
          row('library','Skills library','Opaya\'s own skills, to install on any agent')])]),
      access:()=>sec('access',pbtn('vault','Open Vault'),[card('Keys',[
          row('keys','API keys','Keys it can use, by name only',keysVal,{tone:keyList&&!keyList.keys.length?'warn':''}),
          row('vault','Opaya Vault','Every key you keep in Opaya; import them from a .env or your tools',(()=>{const all=vaultKeys(),mine=all.filter(k=>keyHolders(k).has(a.id)).length;return all.length?`${plural(all.length,'key')}${mine?` / ${mine} given to ${title(a)}`:''}`:'Empty';})())]),
        card('Permissions',[
          row('itrust','iTrust','Approves its tool requests without asking','',{sw:!!a.itrust}),
          row('browser','Opaya browser',keyed.browser?.disabled?keyed.browser.hint||'Only agents on this computer':a.vision?.vision===false?'Opens, reads and uses web pages; pages come as text':'Lets it open, read and use web pages','',{sw:hasBrowser(a),always:true})]),
        card('Tools',[
          row('mcp','MCP servers','Tools such as GitHub, a browser or files',mcps.length?mcps.map(s=>s.name).join(', '):'None'),
          row('transfer','Share with another agent','Copy its skills, keys and MCP servers'),
          row('gateway','Gateway','Status and restart')])],
        `<div class="mg-section">${keysPanel(a)}</div>`),
      machine:()=>sec('machine',pbtn('machines','Open in Machines'),[card('Where it runs',[
          row('machines','Machine','Opens the board of all machines',location(a)),
          row('','System','',sys,{always:true,icon:AN_ICON.machine}),
          row('files','Files',infoReady&&info.data?`Data in ${info.data}`:'Browse its folders',''),
          row(cliKey,hasCli(a)?`${title(a)} CLI`:'Shell',hasCli(a)?'Its own command line':'On its machine'),
          hasCli(a)?row('shell','Shell','A terminal on its machine'):'',
          tools.length?row('','Installed tools',tools.map(t=>`${t.label||t.id} ${t.installed}`).join(', '),`${tools.length}${tools.some(t=>t.outdated)?`, ${tools.filter(t=>t.outdated).length} outdated`:''}`,{act:'tool-updates',icon:ICON.update,tone:tools.some(t=>t.outdated)?'warn':''}):'']),
        cap.kind==='remote-api'?'':card('Its container',[
          row('','Container','',box||'None: it runs directly on the machine',{always:true,icon:ICON.containerRestart}),
          row('containerRestart','Restart container',box),
          row('containerLogs','Container logs',box)])],
        cap.kind==='remote-api'?'':`<div class="mg-section"><div id="mg-docker" class="mg-docker-inline" data-key="${esc(dockerKeyOf(a))}">${dockerPanel(a)}</div></div>`),
      deploy:()=>sec('deploy',`<span class="deploy-token" data-drag="agent" data-drag-id="${esc(a.id)}" title="Drag onto a machine below">${badge(a)}<span>Drag me</span></span>`,[card('Copy it',[
          row('clone','Clone','Copy it to a machine: everything, skills, personality or memory'),
          row('dockerize','Dockerize','Run a copy in its own container'),
          row('redeploy','Redeploy','Copy the same parts from its source again'),
          row('newVps','New VPS','Set up a server to deploy to')])],
        `<div class="mg-section"><header class="mg-section-head"><div><h2>Where it can run</h2><p>Drag ${esc(title(a))} onto a machine, or click Install or Docker there. Opaya asks what to copy before it starts.</p></div></header>${deployTargets(a)}</div>${clonesPanel(a)}`),
      projects:()=>sec('projects',pbtn('projects','+ Add project','primary small'),[],`<div class="mg-section mg-projects-wrap"><p class="mg-lead">Folders ${esc(title(a))} works in, here or on its machine. Pull, commit and push without leaving this screen; Chat here starts a chat in that folder.</p>${gitPanel(a)}</div>`),
      care:()=>sec('care','',[card('Version',[
          row('update','Update','To the latest version, the way it was installed',version||'--'),
          row('','Installed as','',`${cap.label||'Unknown'}${infoReady&&info.methodLabels?.length?` / ${info.methodLabels.join(' + ')}`:''}`,{always:true,icon:ICON.settings}),
          shared.length?row('',isProfile?'Same Hermes as':'Also uses it',sharedHelp,names,{always:true,icon:ICON.groupTags,wrap:true}):'']),
        card('Backups',[
          row('backup','Back up','To this computer',lastBack?`Last ${ago(lastBack.createdAt)} ago`:'Never',{tone:!lastBack||backAge>7?'warn':''}),
          row('backups','Backups folder','Open the folder on this computer')]),
        card('Health',[
          row('fix','Check & fix','The Opaya Agent finds and repairs problems'),
          row('log','Connection log','What Opaya exchanged with it'),
          row('','Schedules','Messages Opaya sends it on a schedule, and its own cron jobs',String((state.schedules||[]).filter(x=>x.agentId===a.id).length||''),{act:'agent-schedules',id:a.id,icon:ICON.history})]),
        backupRows?`<section class="set-group"><h2>Saved backups</h2><div class="set-card set-list">${backupRows}</div></section>`:'']),
      profile:()=>sec('profile','',[card('Look',[
          row('rename','Name','How it shows in Opaya',title(a)),
          row('icon','Icon','Logo, icon library or your own picture'),
          row('groupTags','Group & tags','Sort it in the sidebar',a.group||((a.tags||[]).join(', ')||'None')),
          row('pin','Pin to top','Keep it first in the sidebar','',{sw:!!a.pinned}),
          row('moveUp','Move up','In the sidebar'),row('moveDown','Move down','In the sidebar')]),
        card('Connection',[
          row('restart','Reconnect','Disconnect and connect again',status(a),{tone:statusTone}),
          row('clearError','Clear error','Forget the last failure',a.error||'',{tone:'bad'}),
          row('settings','Connection settings','How Opaya reaches it',`${labels[a.provider]||a.provider} / ${proto}`),
          row('surface','Allow chat again','Its vendor refused chats from other apps'),
          row('copyCommand','Launch command','Copy it',[a.command,...(a.args||[])].join(' ')),
          row('copyId','Agent ID','Copy it',a.id)])]),
      danger:()=>sec('danger','',[card('',[
          row('uninstall',keyed.uninstall?.label.replace(/\.\.\.$/,'')||'Uninstall',isProfile?`Deletes this profile: its config, memory, skills and chats. Hermes and ${shared.length?names:'other profiles'} stay. Opaya offers a backup first.`:dependents.length?`Uninstalls ${labels[cap.framework]||cap.label} from ${location(a)}. ${andList(dependents.map(title))} ${dependents.length===1?'is a profile':'are profiles'} on it and stop working too. Opaya offers a backup first.`:`Removes it and its files from ${location(a)}. Opaya offers a backup first.${shared.length?` ${names} ${shared.length===1?'uses':'use'} the same installation and stop working too.`:''}`,'',{danger:true}),
          row('remove','Remove connection',`Opaya forgets it. Its files stay on ${location(a)}${shared.length?` and ${names} keep working`:''}.`,'',{danger:true})])])};
    const parts=[
      ['mg-p-picker',0,picker],
      ['mg-p-hero',0,ovHero],
      ['mg-p-alerts',1,alerts],
      ...AN_SECTIONS.slice(1).map((x,i)=>[`mg-p-${x.key}`,Math.min(i+2,6),sections[x.key]()])];
    const key=`manage:${a.id}`,entering=renderKey!==key||!$('#mg-p-hero');
    if(entering){manageHtml={};$('#content').innerHTML=parts.map(([id,i,html])=>{manageHtml[id]=html;return `<div id="${id}" style="--i:${i}">${html}</div>`;}).join('');}
    else for(const [id,,html] of parts)if(manageHtml[id]!==html){const el=document.getElementById(id);if(el){manageHtml[id]=html;el.innerHTML=html;}}
    // The parts have their own entrance, staggered after the hero; the generic view entrance would delay it. Entering
    // the page goes straight to the section asked for (or the one in view last time).
    if(entering){$('#content').classList.remove('view-enter');$('#content').scrollTop=0;$('#content').classList.add('mg-entering');clearTimeout(renderManage.t);renderManage.t=setTimeout(()=>$('#content')?.classList.remove('mg-entering'),1400);if(mgSection!=='overview'){const go=mgSection;requestAnimationFrame(()=>mgGo(go,false));}
      if(!keyLists.has(a.id))loadKeys(a);if(cap.kind!=='remote-api'&&!dockerViews.has(dockerKeyOf(a)))loadDocker(dockerKeyOf(a));for(const p of agentProjects(a))if(!projectGit.get(p.id))loadProjectGit(p);if(!skillCache.has(a.id))loadSkills(a.id).catch(()=>skillCache.set(a.id,{skills:[],supported:false})).then(()=>{if(manageId===a.id)render();});if(a.transport==='ssh'&&a.hostId&&!hostChecks.has(a.hostId))testMachine(a.hostId).then(()=>{if(manageId===a.id)render();});}
    renderKey=key;mountStage(a);if(!mgTimer)mgTimer=setTimeout(manageTick,600);
  }
  // ---- Manage is one page: the agent's sidebar lists its sections, a click (or its letter) scrolls there, and the
  // section in view is marked in the sidebar and the top bar as you scroll.
  let mgPinned='',mgSaveT=0;
  const reducedMotion=()=>matchMedia('(prefers-reduced-motion: reduce)').matches;
  function mgSetSection(key){
    if(!manageId||key===mgSection)return;mgSection=key;manageSections.set(manageId,key);
    for(const b of document.querySelectorAll('#agent-side [data-action="agent-section"]:not(.an-id)'))b.classList.toggle('active',b.dataset.key===key);
    const crumb=$('#topbar .ac-section');if(crumb){crumb.hidden=key==='overview';crumb.textContent=`› ${AN_SECTIONS.find(x=>x.key===key)?.name||''}`;}
    clearTimeout(mgSaveT);mgSaveT=setTimeout(saveView,800);
  }
  function mgGo(key,smooth=true){
    const box=$('#content'),el=key==='overview'?null:document.getElementById(`mgs-${key}`);if(!box||!manageId)return;
    mgPinned=key;mgSetSection(key);
    const top=el?el.getBoundingClientRect().top-box.getBoundingClientRect().top+box.scrollTop-14:0;
    box.scrollTo({top,behavior:smooth&&!reducedMotion()?'smooth':'auto'});
    if(el&&smooth){el.classList.remove('flash');void el.offsetWidth;el.classList.add('flash');}
  }
  function mgScroll(){
    const box=$('#content');if(!manageId||!box||!$('#mg-p-hero'))return;
    const r=box.getBoundingClientRect(),line=r.top+Math.min(180,box.clientHeight*.3);let current='overview';
    for(const x of AN_SECTIONS.slice(1)){const el=document.getElementById(`mgs-${x.key}`);if(el&&el.getBoundingClientRect().top<=line)current=x.key;}
    // At the bottom the last sections cannot scroll up to the top: the one asked for stays marked while it is in view.
    if(box.scrollTop+box.clientHeight>=box.scrollHeight-4&&mgPinned){const el=document.getElementById(`mgs-${mgPinned}`),t=el?.getBoundingClientRect().top;if(t!=null&&t>=r.top-4&&t<r.bottom)current=mgPinned;}
    mgSetSection(current);
  }
  $('#content')?.addEventListener('scroll',()=>{if(manageId)requestAnimationFrame(mgScroll);},{passive:true});
  // Scrolling by hand lets the marked section follow the page again.
  for(const type of ['wheel','touchmove'])$('#content')?.addEventListener(type,()=>{mgPinned='';},{passive:true});
  // The stage's labels open the section about them.
  document.addEventListener('click',event=>{const label=event.target.closest('.ov-hero .stage-label');const a=label&&selected();if(!a)return;
    if(label.dataset.kind==='chat'){action(()=>setAgentMode(a,'chat'));return;}
    const key={machine:'machine',docker:'machine',key:'access',git:'projects',skill:'model'}[label.dataset.kind];if(key)action(()=>openManage(a.id,key));});
  // On the Manage screen a letter goes to its section (shown in the agent's sidebar) and Esc back to the top, unless
  // something is being typed or a dialog or menu is open.
  document.addEventListener('keydown',event=>{if(!manageId||event.ctrlKey||event.metaKey||event.altKey||$('#app-dialog')||document.querySelector('dialog[open]')||$('.context-menu'))return;const el=document.activeElement;if(el&&(el.isContentEditable||/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)||viewOf(el)))return;
    if(event.key==='Escape'&&($('#content')?.scrollTop||0)>0){event.preventDefault();mgGo('overview');return;}
    const s=event.key.length===1&&AN_SECTIONS.find(x=>x.hk===event.key.toUpperCase());if(s){event.preventDefault();mgGo(s.key);}});
  // ---- Moves on the management screen: give a key, clone or dockerize, push ----------------------------------------
  const flash=(el,text)=>{if(!el)return;const tag=el.querySelector('.mg-shared');if(tag){tag.textContent=text;}el.classList.remove('flash');void el.offsetWidth;el.classList.add('flash');setTimeout(()=>el.classList.remove('flash'),2200);};
  async function giveKey(keyId,agentId,from,targetEl){
    const k=(opaya().secrets||[]).find(x=>x.id===keyId),a=state.agents.find(x=>x.id===agentId);if(!k||!a)return;
    const flight=stage()?.fly({from,to:targetEl,kind:'key'});
    targetEl?.classList.add('receiving');
    try{const r=await api.vaultGiveAgent({id:k.id,agentId});await flight;toast(`${r?.name||k.name} saved for ${r?.agent||title(a)}${r?.file?` in ${r.file}`:''}.`);heroCtl?.pulse('key');keyLists.delete(agentId);await refresh();if(selected()?.id===agentId)await loadKeys(a,true);
      // The screen may have been redrawn meanwhile: mark the agent's card as it is now.
      const now=targetEl?.isConnected?targetEl:document.querySelector(`.mg-key-target[data-agent-target="${CSS.escape(agentId)}"]`)||document.querySelector(`.agent-nav-row[data-agent-id="${CSS.escape(agentId)}"]`);flash(now,'✓ Key shared');stage()?.burst(now,'key');}
    catch(error){await flight;toast(error.message,true);}
    finally{targetEl?.classList.remove('receiving');}
  }
  // A ghost of the agent card flies to the target with a copy label (the 3D trail runs under it), then the clone
  // dialog opens with that target chosen. The job's progress then shows on the target.
  async function deployTo(a,hostId,runtime,from,targetEl,{migrate=false}={}){
    if(!cloneable(a)){toast('This is an API connection: there is nothing installed to clone.');return;}
    if(runtime==='docker'&&!canDocker(a)){toast(`${title(a)} cannot run in a Docker container Opaya sets up.`,true);return;}
    const fromRect=from?.getBoundingClientRect?from.getBoundingClientRect():from,to=targetEl?.getBoundingClientRect();
    if(fromRect&&to&&!matchMedia('(prefers-reduced-motion: reduce)').matches){
      const ghost=document.createElement('div');ghost.className='mg-ghost';ghost.innerHTML=`${badge(a)}<div><strong>${esc(title(a))} <em>${migrate?'moving':'copy'}</em></strong><small>${migrate?'Migrating':runtime==='docker'?'Dockerizing':'Cloning'}&#8230;</small></div>`;document.body.append(ghost);
      const sx=fromRect.left+fromRect.width/2-130,sy=fromRect.top+fromRect.height/2-32,ex=to.left+to.width/2-130,ey=to.top+to.height/2-32;
      const anim=ghost.animate([{transform:`translate(${sx}px,${sy}px) perspective(700px) rotateY(0deg) rotateX(0deg) scale(1)`,opacity:.0},{transform:`translate(${sx+40}px,${sy-30}px) perspective(700px) rotateY(-14deg) rotateX(8deg) scale(1.04)`,opacity:1,offset:.25},{transform:`translate(${ex}px,${ey}px) perspective(700px) rotateY(10deg) rotateX(-6deg) scale(.55)`,opacity:.15}],{duration:900,easing:'cubic-bezier(.5,0,.2,1)'});
      const trail=runtime==='docker'?stage()?.assemble({around:targetEl,into:targetEl}):stage()?.fly({from:fromRect,to:targetEl,kind:'clone'});
      await new Promise(r=>{anim.onfinish=anim.oncancel=r;});ghost.remove();await trail;stage()?.burst(targetEl,runtime==='docker'?'docker':'clone');
    }
    // A migration keeps the agent's name; a clone gets a new one.
    openClone(a,{hostId,runtime,migrate,...(migrate?{name:cloneSlug(a.name)}:{})});
  }
  async function pushProject(p,key,button){
    const card=button?.closest('.mg-project'),node=card?.querySelector('.mg-remote-node');
    if(['push','commitPush'].includes(key)&&card&&node)stage()?.fly({from:button,to:node,kind:'git',count:3});
    if(key==='pull'&&card&&node)stage()?.fly({from:node,to:button,kind:'git',count:2});
    await runGit(p,key);
  }
  // ---- Drag and drop: vault keys onto agents, the agent card onto a machine or Docker -------------------------------
  // Pointer-based, so the ghost can tilt with the movement. A plain click on a key still opens its menu.
  let drag=null,dropTarget=null,suppressClick=false;
  const dropFor=(kind,x,y)=>{const el=document.elementFromPoint(x,y);if(!el)return null;return kind==='key'?el.closest('[data-drop~="key"],.agent-nav-row[data-agent-id],.mini-agent[data-agent-id]'):el.closest(`[data-drop~="${kind}"]`);};
  document.addEventListener('pointerdown',event=>{
    if(event.button!==0)return;const src=event.target.closest('[data-drag]');if(!src)return;
    if(event.target.closest('button,input,select,textarea,a,label')&&event.target.closest('button,input,select,textarea,a,label')!==src)return;
    drag={src,kind:src.dataset.drag,id:src.dataset.dragId,x:event.clientX,y:event.clientY,lx:event.clientX,ly:event.clientY,started:false,pointer:event.pointerId};
  });
  document.addEventListener('pointermove',event=>{
    if(!drag||event.pointerId!==drag.pointer)return;
    if(!drag.started){if(Math.hypot(event.clientX-drag.x,event.clientY-drag.y)<6)return;drag.started=true;
      const r=drag.src.getBoundingClientRect(),g=document.createElement('div');g.className=`drag-ghost ${drag.kind}`;
      if(drag.kind==='agent'){const a=state.agents.find(x=>x.id===drag.id);g.innerHTML=`${badge(a)}<div><strong>${esc(title(a))}</strong><small>${fleetView&&overview?'Drop on a machine to clone or migrate, on an agent to share':'Drop on a machine or Docker'}</small></div>`;drag.ox=24;drag.oy=26;}
      else{g.innerHTML=drag.src.innerHTML;g.style.width=r.width+'px';drag.ox=event.clientX-r.left;drag.oy=event.clientY-r.top;}
      document.body.append(g);drag.ghost=g;document.body.classList.add('dragging',`dragging-${drag.kind}`);drag.src.classList.add('drag-source');}
    const vx=event.clientX-drag.lx,vy=event.clientY-drag.ly;drag.lx=event.clientX;drag.ly=event.clientY;
    drag.ghost.style.transform=`translate(${event.clientX-drag.ox}px,${event.clientY-drag.oy}px) perspective(500px) rotateY(${Math.max(-25,Math.min(25,vx*1.6))}deg) rotateX(${Math.max(-25,Math.min(25,-vy*1.6))}deg) scale(1.06)`;
    const t=dropFor(drag.kind,event.clientX,event.clientY);if(t!==dropTarget){dropTarget?.classList.remove('drop-over');dropTarget=t;t?.classList.add('drop-over');}
  });
  function endDrag(drop){
    if(!drag)return;const d=drag;drag=null;document.body.classList.remove('dragging','dragging-key','dragging-agent');d.src.classList.remove('drag-source');dropTarget?.classList.remove('drop-over');
    const target=drop?dropTarget:null;dropTarget=null;if(!d.started)return;suppressClick=true;setTimeout(()=>{suppressClick=false;},0);
    const rect=d.ghost.getBoundingClientRect();
    if(!target){const back=d.src.getBoundingClientRect();d.ghost.animate([{transform:d.ghost.style.transform,opacity:1},{transform:`translate(${back.left}px,${back.top}px) scale(.9)`,opacity:0}],{duration:280,easing:'ease-in'}).onfinish=()=>d.ghost.remove();return;}
    d.ghost.remove();
    if(d.kind==='key'){const agentId=target.dataset.agentTarget||target.dataset.agentId;if(agentId)giveKey(d.id,agentId,rect,target);}
    else if(d.kind==='agent'){const a=state.agents.find(x=>x.id===d.id);if(!a)return;
      if(target.dataset.agentTarget){if(target.dataset.agentTarget!==a.id)shareTo(a,target.dataset.agentTarget,rect,target);}
      else if(target.dataset.machine!==undefined)machineDrop(a,target.dataset.machine,rect,target);
      else deployTo(a,target.dataset.deployHost||'',target.dataset.deployRuntime||'regular',rect,target);}
  }
  document.addEventListener('pointerup',event=>{if(drag&&event.pointerId===drag.pointer)endDrag(true);});
  document.addEventListener('pointercancel',()=>endDrag(false));
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&drag?.started){event.preventDefault();endDrag(false);}});
  document.addEventListener('click',event=>{if(suppressClick){event.preventDefault();event.stopPropagation();suppressClick=false;}},true);
  // The same moves without dragging: a key's menu lists the agents to give it to.
  function keyMenu(button,keyId){
    const k=(opaya().secrets||[]).find(x=>x.id===keyId);if(!k)return;
    const r=button.getBoundingClientRect(),targetEl=id=>document.querySelector(`[data-agent-target="${CSS.escape(id)}"]`)||button;
    const has=keyHolders(k);
    openMenu(r.left,r.bottom+4,[...state.agents.filter(a=>!a.ephemeral).map(a=>({icon:has.has(a.id)?'&#10003;':'&#9919;',label:has.has(a.id)?`${title(a)} has it: save again`:`Give to ${title(a)}`,run:()=>giveKey(k.id,a.id,button,targetEl(a.id))})),{icon:'&#8734;',label:'Give to every agent',run:()=>action(()=>giveAll(k.id))},'-',{icon:'&#9635;',label:'Open Vault',run:()=>openVault()}],k.name);
  }
  // ---- Chat dock: chats in their own windows along the bottom, several at once ---------------------------------------
  // Like a desktop messenger: each window is one conversation. Click its header to minimize it, expand it to the full
  // chat view, or close it. Windows that do not fit collapse into round avatars on the right. The open windows are saved
  // with the view, and the session service sends their messages with every update.
  let chatDock=[];const dockSigs=new Map(),dockUnread=new Map(),dockSending=new Set();
  const dockConv=id=>state.conversations.find(c=>c.id===id);
  function dockRoot(){
    let root=$('#chat-dock');if(root)return root;
    root=document.createElement('div');root.id='chat-dock';root.className='chat-dock';root.setAttribute('aria-label','Chat window');($('.work-area')||document.body).append(root);
    root.addEventListener('click',event=>{
      const b=event.target.closest('[data-dock]');if(!b)return;
      if(b.dataset.dock==='launch-new'){event.stopPropagation();const r=b.getBoundingClientRect();openMenu(Math.max(8,r.right-260),Math.max(8,r.top-8-Math.min(360,state.agents.length*34+40)),state.agents.filter(a=>a.protocol!=='terminal').map(a=>({icon:'&#9993;',label:`${title(a)}${a.status==='connected'?'':` (${status(a).toLowerCase()})`}`,run:()=>action(()=>newDockChat(a))})),'New chat with');return;}
      if(b.dataset.dock==='launcher'){launcherOpen=!launcherOpen;renderDock();return;}
      if(b.dataset.dock==='launch-open'){const c=dockConv(b.dataset.conv),a=c&&state.agents.find(x=>x.id===c.agentId);if(a){launcherOpen=false;action(()=>openChatWindow(a,c.id));}return;}
      const win=event.target.closest('.chat-win'),id=win?.dataset.conv||b?.dataset.conv;if(!id)return;
      const act=b.dataset.dock,d=chatDock.find(x=>x.id===id),c=dockConv(id),a=c&&state.agents.find(x=>x.id===c.agentId);
      if(act==='toggle'&&!event.target.closest('button:not([data-dock="toggle"])')){if(d){d.min=!d.min;if(!d.min)dockUnread.delete(id);saveView();renderDock();if(!d.min)win.querySelector('textarea')?.focus();}return;}
      if(act==='min'&&d){d.min=true;saveView();renderDock();return;}
      if(act==='close'){closeChatWindow(id);return;}
      if(act==='bubble'){const at=chatDock.findIndex(x=>x.id===id);if(at>=0){const [x]=chatDock.splice(at,1);x.min=false;chatDock.unshift(x);dockUnread.delete(id);saveView();renderDock();}return;}
      if(act==='expand'&&a){closeChatWindow(id);action(async()=>{agentModes.set(a.id,'chat');overview=false;opayaView=false;playgroundView=false;await api.selectConversation({id});state=await api.snapshot();render();saveView();$('#message-input')?.focus();});return;}
      if(act==='connect'&&a){action(()=>api.connect({id:a.id}));return;}
      if(act==='stop'&&a){action(()=>api.stop({id:a.id}));return;}
      if(act==='manage'&&a){openManage(a.id);return;}
    });
    root.addEventListener('submit',event=>{const f=event.target.closest('.chat-win-compose');if(!f)return;event.preventDefault();dockSend(f.closest('.chat-win').dataset.conv);});
    root.addEventListener('keydown',event=>{if(event.key==='Escape'&&launcherOpen&&event.target.closest('.chat-launcher')){launcherOpen=false;renderDock();return;}if(event.target.tagName!=='TEXTAREA')return;if(sendKeyPressed(event)){event.preventDefault();dockSend(event.target.closest('.chat-win').dataset.conv);}else if(event.key==='Escape'){const id=event.target.closest('.chat-win').dataset.conv,d=chatDock.find(x=>x.id===id);if(d){d.min=true;saveView();renderDock();}}});
    root.addEventListener('input',event=>{const t=event.target;if(t.tagName!=='TEXTAREA')return;const id=t.closest('.chat-win').dataset.conv,c=dockConv(id);drafts.set(id,t.value);if(c&&api.saveDraft)save(api.saveDraft({agentId:c.agentId,conversationId:id,text:t.value}));t.style.height='auto';t.style.height=Math.min(t.scrollHeight,120)+'px';});
    window.addEventListener('resize',()=>renderDock());
    return root;
  }
  // The agent's window: the chat on screen, else an open window, else its latest chat, else a new chat that does not
  // change the selected agent.
  async function openChatWindow(a,conversationId=''){
    if(!a)return;if(a.protocol==='terminal'||a.surface==='terminal'&&!conversationId){await setAgentMode(a,'console');return;}
    const shown=!overview&&!opayaView&&!playgroundView&&selected()?.id===a.id&&modeOf(a)==='chat'?currentConversation()?.id:'';
    let id=conversationId||shown||chatDock.find(d=>dockConv(d.id)?.agentId===a.id)?.id||agentChats(a)[0]?.id;
    if(!id){const c=await api.newConversation({agentId:a.id,activate:false});id=c.id;state=await api.snapshot();}
    // A chat is never in the main view and its window at once (the dock hides a window whose chat fills the page), so
    // popping out the chat on screen shows the agent's Manage page behind its window.
    if(id===shown){await openManage(a.id);if(!tipsSeen.has('tip:chat-window')){tipsSeen.add('tip:chat-window');toast('The chat is in a window now. It stays beside every screen; its expand button brings it back full size.');}}
    const at=chatDock.findIndex(d=>d.id===id);if(at>=0)chatDock.splice(at,1);
    for(const d of chatDock)d.min=true;chatDock.unshift({id,min:false});chatDock=chatDock.slice(0,8);dockUnread.delete(id);
    saveView();renderDock();if(manageId)render();
    requestAnimationFrame(()=>$(`.chat-win[data-conv="${CSS.escape(id)}"] textarea`)?.focus());
  }
  async function newDockChat(a){if(!a)return;if(a.busy){toast('Wait for or stop this agent\'s current turn first.',true);return;}const c=await api.newConversation({agentId:a.id,activate:false});state=await api.snapshot();await openChatWindow(a,c.id);}
  function closeChatWindow(id){
    const el=$(`.chat-win[data-conv="${CSS.escape(id)}"]`);chatDock=chatDock.filter(d=>d.id!==id);dockSigs.delete(id);saveView();
    if(el){el.classList.add('leaving');setTimeout(()=>{el.remove();renderDock();},200);}else renderDock();
    if(manageId)render();
  }
  async function dockSend(id,text){
    const win=$(`.chat-win[data-conv="${CSS.escape(id)}"]`),box=win?.querySelector('textarea'),c=dockConv(id),a=c&&state.agents.find(x=>x.id===c.agentId);
    const value=text??box?.value??'';if(!a||!value.trim()||dockSending.has(id))return;
    if(a.status!=='connected'){toast(`Connect ${title(a)} before sending a message.`,true);return;}
    dockSending.add(id);renderDock();
    try{await api.send({agentId:a.id,conversationId:id,text:value});drafts.set(id,'');if(box&&text===undefined){box.value='';box.style.height='auto';}}
    catch(error){toast(error.message,true);}finally{dockSending.delete(id);renderDock();}
  }
  const dockMessage=(m,a)=>`<div class="dock-msg ${m.role==='user'?'mine':'theirs'} ${m.status==='error'?'failed':''}">${m.role==='user'?'':`<span class="dock-msg-avatar">${agentIcon(a)}</span>`}<div class="dock-bubble">${activityMarkup(m,4,m.status==='streaming'?a.id:'')}${m.content?`<div class="message-text">${format(m.content)}</div>`:m.status==='streaming'?'<div class="thinking-dots"><i></i><i></i><i></i></div>':''}${m.attachments?.length?`<small class="dock-files">${m.attachments.length} file${m.attachments.length===1?'':'s'}</small>`:''}${m.error?`<small class="dock-error">${esc(m.error)}</small>`:''}</div></div>`;
  // Chat windows docked at the bottom right (when Chat opens as a window, or a window is opened from Manage).
  // A window is open, minimized to its header, or waiting in the launcher when there is no room. The conversation
  // open in the full chat view is not shown twice. Replies that arrive while a window is minimized, waiting or hidden
  // count as unread on it and on the launcher.
  let launcherOpen=false;const dockSeen=new Map();
  function renderDock(){
    const root=dockRoot();chatDock=chatDock.filter(d=>dockConv(d.id));
    const talkers=state.agents.filter(a=>a.protocol!=='terminal');
    const fullId=!overview&&!opayaView&&!playgroundView&&selected()&&modeOf(selected())==='chat'?state.activeConversationId:'';
    // Opening the agent's chat is reading it: its new-reply counts clear (on the agent in the sidebar and in the tray).
    if(fullId){const ag=selected()?.id;for(const [id] of [...dockUnread])if(id===fullId||dockConv(id)?.agentId===ag)dockUnread.delete(id);}
    const visible=chatDock.filter(d=>d.id!==fullId),open=visible.find(d=>!d.min);
    // One window is open, as a column beside the page; the others wait in the status bar's tray.
    for(const d of visible)if(d!==open)d.min=true;
    const shown=open?[open]:[],rest=[];
    // Unread: a finished reply in a chat the user cannot see right now.
    for(const d of chatDock){
      const m=state.histories[d.id];if(!m)continue;const last=m.at(-1),sig=`${m.length}:${last?.status||''}`,prev=dockSeen.get(d.id);dockSeen.set(d.id,sig);
      const out=d.min||d.id===fullId?false:!shown.includes(d);
      if(prev&&prev!==sig&&last?.role==='assistant'&&last.status!=='streaming'&&(d.min||out))dockUnread.set(d.id,(dockUnread.get(d.id)||0)+1);
    }
    root.hidden=!shown.length;document.body.classList.toggle('chat-dock-shown',visible.length>0);
    document.body.classList.toggle('chat-dock-open',shown.length>0);renderTray(visible.filter(d=>d!==open));renderNavBadges();
    const keep=new Set(shown.map(d=>d.id));
    for(const el of root.querySelectorAll('.chat-win'))if(!keep.has(el.dataset.conv)&&!el.classList.contains('leaving')){el.remove();dockSigs.delete(el.dataset.conv);}
    shown.forEach((d,i)=>{
      const c=dockConv(d.id),a=state.agents.find(x=>x.id===c.agentId);if(!a)return;
      let el=root.querySelector(`.chat-win[data-conv="${CSS.escape(d.id)}"]`);
      if(!el){el=document.createElement('section');el.className='chat-win entering';el.dataset.conv=d.id;el.setAttribute('role','dialog');el.setAttribute('aria-label',`Chat with ${title(a)}`);
        el.innerHTML=`<header class="chat-win-head" data-dock="toggle" data-conv="${esc(d.id)}" title="Minimize or open"><span class="chat-win-avatar"></span><span class="chat-win-who"><strong></strong><small></small></span><em class="chat-win-unread" hidden></em><button type="button" class="chat-win-btn" data-dock="manage" title="Manage this agent" aria-label="Manage"><span class="mode-glyph manage-glyph" aria-hidden="true"></span></button><button type="button" class="chat-win-btn" data-dock="expand" title="Full chat view" aria-label="Expand"><span class="expand-glyph" aria-hidden="true"></span></button><button type="button" class="chat-win-btn chat-win-min" data-dock="min" title="Minimize (Esc)" aria-label="Minimize">&#8211;</button><button type="button" class="chat-win-btn" data-dock="close" title="Close" aria-label="Close">&#10005;</button></header>
          <div class="chat-win-body"><div class="chat-win-list" aria-live="polite"></div><div class="chat-win-note" hidden></div><form class="chat-win-compose"><textarea rows="1" maxlength="80000" placeholder="Message ${esc(title(a))}..." aria-label="Message ${esc(title(a))}"></textarea><button type="button" class="chat-win-stop" data-dock="stop" title="Stop" aria-label="Stop" hidden>&#9632;</button><button type="submit" class="chat-win-send" title="Send" aria-label="Send">&#8593;</button></form></div>`;
        root.append(el);el.querySelector('textarea').value=drafts.get(d.id)??state.drafts?.[d.id]??'';setTimeout(()=>el.classList.remove('entering'),420);}
      el.style.order=String(i+1);
      // Minimizing hands the keyboard back to the page; opening a window again clears its unread count.
      if(el.classList.contains('min')!==!!d.min){el.classList.toggle('min',!!d.min);if(d.min&&el.contains(document.activeElement))document.activeElement.blur();}
      if(!d.min)dockUnread.delete(d.id);
      el.querySelector('.chat-win-head').title=d.min?'Open':'Minimize';
      const head=`${badge(a)}${dot(a)}`;if(el.dataset.head!==head){el.querySelector('.chat-win-avatar').innerHTML=head;el.dataset.head=head;}
      el.querySelector('.chat-win-who strong').textContent=title(a);el.querySelector('.chat-win-who small').textContent=a.busy?'Working...':`${chatLabel(c)}`;
      const messages=state.histories[d.id],last=messages?.at(-1),sig=messages?`${messages.length}:${last?.content?.length||0}:${last?.status||''}:${last?.activity?.length||0}:${a.status}`:'loading';
      if(dockSigs.get(d.id)!==sig){
        const prev=dockSigs.get(d.id),list=el.querySelector('.chat-win-list'),atBottom=list.scrollHeight-list.scrollTop-list.clientHeight<60;
        dockSigs.set(d.id,sig);
        list.innerHTML=!messages?'<p class="chat-win-empty">Loading the chat...</p>':messages.length?messages.slice(-60).map(m=>dockMessage(m,a)).join(''):`<div class="chat-win-empty">${badge(a,true)}<strong>${esc(title(a))}</strong><span>${a.status==='connected'?'Say hello.':'Not connected.'}</span>${a.status==='connected'?'':`<button type="button" class="secondary small" data-dock="connect" data-conv="${esc(d.id)}">Connect</button>`}</div>`;
        if(atBottom||!prev||prev==='loading')list.scrollTop=list.scrollHeight;
      }
      const unread=dockUnread.get(d.id)||0,badgeEl=el.querySelector('.chat-win-unread');badgeEl.hidden=!unread;badgeEl.textContent=unread;el.classList.toggle('attention',!!unread);
      const note=el.querySelector('.chat-win-note'),off=a.status!=='connected';note.hidden=!off||!messages?.length;note.innerHTML=off?`${esc(status(a))} <button type="button" class="text-button" data-dock="connect" data-conv="${esc(d.id)}">Connect</button>`:'';
      el.querySelector('.chat-win-send').disabled=off||!!a.busy||dockSending.has(d.id);el.querySelector('.chat-win-send').hidden=!!a.busy;el.querySelector('.chat-win-stop').hidden=!a.busy;
    });
    // Windows without room wait as avatars on the right; the sidebar lists the agents, so there is no other list here.
    let more=root.querySelector('.chat-more');
    if(rest.length){if(!more){more=document.createElement('div');more.className='chat-more';root.append(more);}more.style.order='0';
      more.innerHTML=rest.map(d=>{const c=dockConv(d.id),a=state.agents.find(x=>x.id===c?.agentId);return a?`<button type="button" class="chat-bubble ${dockUnread.get(d.id)?'attention':''}" data-dock="bubble" data-conv="${esc(d.id)}" title="${esc(`${title(a)}: ${chatLabel(c)}`)}${dockUnread.get(d.id)?` (${dockUnread.get(d.id)} new)`:''}">${badge(a)}${dot(a)}</button>`:'';}).join('');}
    else more?.remove();
    root.querySelector('.chat-launcher')?.remove();
  }
  // The tray in the status bar: chats in the background, each with its agent, a spinner while it works and its new
  // replies. A click opens it beside the page; x closes it.
  // New replies in the background, on each agent in the sidebar (and the rail).
  function renderNavBadges(){
    const per=new Map();for(const [id,n] of dockUnread){const c=dockConv(id);if(c&&n)per.set(c.agentId,(per.get(c.agentId)||0)+n);}
    for(const b of document.querySelectorAll('#agent-list .agent-nav[data-id]')){const n=per.get(b.dataset.id)||0;let em=b.querySelector('.nav-unread');
      if(!n){em?.remove();continue;}if(!em){em=document.createElement('em');em.className='nav-unread';em.setAttribute('aria-label','new replies');b.append(em);}em.textContent=n>9?'9+':String(n);}
  }
  function renderTray(list){
    const tray=$('#status-tray');if(!tray)return;
    const html=list.map(d=>{const c=dockConv(d.id),a=c&&state.agents.find(x=>x.id===c.agentId);if(!a)return '';const n=dockUnread.get(d.id)||0;
      return `<span class="tray-chip ${n?'unread':''} ${a.busy?'working':''}"><button type="button" data-tray="open" data-conv="${esc(d.id)}" title="${esc(`${title(a)}: ${chatLabel(c)}`)}${a.busy?' (working)':''}${n?` (${n} new)`:''}">${badge(a)}<span class="tray-name">${esc(title(a))}</span>${a.busy?'<i class="tray-spin" aria-hidden="true"></i>':''}${n?`<em>${n}</em>`:''}</button><button type="button" class="tray-x" data-tray="close" data-conv="${esc(d.id)}" title="Close" aria-label="Close ${esc(title(a))} chat">&#10005;</button></span>`;}).join('');
    if(tray.dataset.html!==html){tray.dataset.html=html;tray.innerHTML=html;}tray.hidden=!html;
  }
  document.addEventListener('click',event=>{const b=event.target.closest('#status-tray [data-tray]');if(!b)return;const id=b.dataset.conv,d=chatDock.find(x=>x.id===id);
    if(b.dataset.tray==='close'){closeChatWindow(id);return;}
    if(d){for(const x of chatDock)x.min=x!==d;d.min=false;dockUnread.delete(id);saveView();renderDock();requestAnimationFrame(()=>$(`.chat-win[data-conv="${CSS.escape(id)}"] textarea`)?.focus());}});
  // The note about a new key, in the agent's window when no full chat is open.
  async function dockTell(a,note){await openChatWindow(a);const id=chatDock[0]?.id,box=$(`.chat-win[data-conv="${CSS.escape(id)}"] textarea`);if(!box)return;const typed=box.value.trim();if(!typed&&a.status==='connected'){await dockSend(id,note);return;}box.value=note+(typed?'\n\n'+box.value:'');box.dispatchEvent(new Event('input',{bubbles:true}));box.focus();}
  // ---- Manage menu: agents or machines -------------------------------------------------------------------------------
  // Manage in the sidebar opens a two-column menu: every agent (its management screen) and every machine (the fleet
  // board, where agents are cloned, migrated, shared and uninstalled across machines).
  let fleetView=false,fleetFocus='local',fleetHtml={};const migrations=new Map();
  const machineKeys=()=>['local',...state.hosts.map(h=>h.id)];
  const machineName=key=>key==='local'?localName():state.hosts.find(h=>h.id===key)?.name||'Machine';
  const machineOnline=key=>key==='local'||hostChecks.get(key)?.state==='ok';
  function openManagePop(button){
    if($('#manage-pop')){closeManagePop();return;}
    const pop=document.createElement('div');pop.id='manage-pop';pop.className='manage-pop';pop.setAttribute('role','dialog');pop.setAttribute('aria-label','Manage');
    const agentRow=a=>`<button type="button" class="mp-item ${manageId===a.id?'current':''}" data-mp="agent" data-id="${esc(a.id)}">${badge(a)}<span><strong>${esc(title(a))}</strong><small>${esc(placeText(a))} / ${esc(location(a))}</small></span>${dot(a)}</button>`;
    const machineRow=key=>{const n=machineAgents(key==='local'?'':key).length,c=hostChecks.get(key),h=state.hosts.find(x=>x.id===key);return `<button type="button" class="mp-item ${fleetView&&overview&&fleetFocus===key?'current':''}" data-mp="machine" data-id="${esc(key)}"><span class="mg-target-icon ${key==='local'?'local-t':'vps-t'}" aria-hidden="true"></span><span><strong>${esc(machineName(key))}</strong><small>${n} agent${n===1?'':'s'}${h?` / ${esc(h.alias||h.hostname)}`:''}</small></span><span class="status-dot ${machineOnline(key)?'connected':c?.state==='error'?'error':''}"></span></button>`;};
    pop.innerHTML=`<section class="mp-col"><header><span class="mp-h agents" aria-hidden="true"></span><div><strong>Agents</strong><small>One screen each: keys, Docker, git, maintenance</small></div></header><div class="mp-list">${state.agents.map(agentRow).join('')||'<p class="field-help">No agents yet.</p>'}</div></section>
      <section class="mp-col mp-machines"><header><span class="mp-h machines" aria-hidden="true"></span><div><strong>Machines</strong><small>Clone, migrate, share and uninstall agents across machines</small></div></header><button type="button" class="mp-fleet" data-mp="fleet"><span class="grid-ico" data-g="grid4" aria-hidden="true"><i></i><i></i><i></i><i></i></span><span><strong>All machines</strong><small>The fleet board</small></span></button><div class="mp-list">${machineKeys().map(machineRow).join('')}</div><button type="button" class="mp-add" data-mp="new-vps">+ New VPS</button></section>`;
    document.body.append(pop);
    const r=button.getBoundingClientRect();pop.style.left=`${Math.max(8,Math.min(r.left,innerWidth-pop.offsetWidth-12))}px`;pop.style.top=`${Math.max(8,Math.min(r.bottom+6,innerHeight-pop.offsetHeight-12))}px`;
    pop.addEventListener('click',event=>{const b=event.target.closest('[data-mp]');if(!b)return;const k=b.dataset.mp,id=b.dataset.id;closeManagePop();
      if(k==='agent')action(()=>openManage(id));else if(k==='machine')openFleet(id);else if(k==='fleet')openFleet();else if(k==='new-vps')openNewVps();else if(k==='install')openInstall(id==='local'?'':id);});
    // Hovering (or focusing) a machine opens a flyout with the agents on it.
    const fly=document.createElement('div');fly.className='mp-flyout';fly.hidden=true;pop.append(fly);let flyKey='';
    const showFly=item=>{const key=item.dataset.id;if(flyKey===key&&!fly.hidden)return;flyKey=key;const list=machineAgents(key==='local'?'':key);
      fly.innerHTML=`<header><strong>${esc(machineName(key))}</strong><small>${list.length} agent${list.length===1?'':'s'}</small></header>${list.map(a=>`<button type="button" class="mp-item" data-mp="agent" data-id="${esc(a.id)}">${badge(a)}<span><strong>${esc(title(a))}</strong><small>${esc(containerOf(a)?`Docker / ${containerOf(a)}`:a.install?.label||placeText(a))}</small></span>${dot(a)}</button>`).join('')||'<p class="field-help">No agents here yet.</p>'}<div class="mp-fly-actions"><button type="button" class="mp-add" data-mp="machine" data-id="${esc(key)}">Open on the fleet board &#8594;</button><button type="button" class="mp-add" data-mp="install" data-id="${esc(key)}">&#8595; Install agents here</button></div>`;
      fly.hidden=false;const pr=pop.getBoundingClientRect(),ir=item.getBoundingClientRect(),w=fly.offsetWidth,right=pr.right+8+w<innerWidth;
      fly.style.left=right?`${pr.width+8}px`:`${-w-8}px`;fly.style.top=`${Math.max(0,Math.min(ir.top-pr.top-8,innerHeight-pr.top-fly.offsetHeight-12))}px`;
      for(const b of pop.querySelectorAll('.mp-col [data-mp="machine"]'))b.classList.toggle('flying',b===item);};
    const hideFly=()=>{fly.hidden=true;flyKey='';for(const b of pop.querySelectorAll('.flying'))b.classList.remove('flying');};
    pop.addEventListener('pointerover',event=>{const item=event.target.closest('.mp-col [data-mp="machine"]');if(item)showFly(item);else if(!event.target.closest('.mp-flyout,.mp-machines'))hideFly();});
    pop.addEventListener('focusin',event=>{const item=event.target.closest('.mp-col [data-mp="machine"]');if(item)showFly(item);});
    pop.addEventListener('pointerleave',hideFly);
    setTimeout(()=>document.addEventListener('pointerdown',outsideManagePop,true),0);pop.querySelector('.mp-item.current,.mp-item')?.focus();
  }
  function outsideManagePop(event){if(!event.target.closest('#manage-pop,.manage-anchor,.agent-chip'))closeManagePop();}
  function closeManagePop(){$('#manage-pop')?.remove();document.removeEventListener('pointerdown',outsideManagePop,true);}
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&$('#manage-pop')){event.preventDefault();closeManagePop();$('#topbar .manage-anchor')?.focus();}});
  // ---- Fleet: every machine with its agents ----------------------------------------------------------------------------
  // Drag an agent onto another machine to clone or migrate it there (in Docker too), onto another agent to share its
  // skills, keys and MCP servers. Every agent and machine also has a menu with the same moves and the rest.
  function openFleet(key){
    overview=true;fleetView=true;opayaView=false;playgroundView=false;closeModal();closeMenu();if(key)fleetFocus=key;
    render();saveView();
    for(const h of state.hosts)if(!hostChecks.has(h.id))testMachine(h.id);
    if(!dockerViews.has(fleetFocus))loadDocker(fleetFocus);
  }
  function fleetAgent(a){
    const box=containerOf(a);
    return `<div class="fleet-agent" data-drag="agent" data-drag-id="${esc(a.id)}" data-drop="agent" data-agent-target="${esc(a.id)}" title="Drag onto another machine to clone or migrate ${esc(title(a))}, or onto another agent to share with it">${badge(a)}<span class="fleet-agent-text"><strong>${esc(title(a))}</strong><small>${esc(box?`Docker / ${box}`:a.install?.label||labels[a.provider]||'')}</small></span>${dot(a)}<button type="button" class="mg-icon-btn" data-action="fleet-agent-menu" data-id="${esc(a.id)}" aria-label="Actions for ${esc(title(a))}" title="Clone, migrate, share, update, uninstall">&#8943;</button></div>`;
  }
  function fleetColumn(key){
    const h=state.hosts.find(x=>x.id===key),host=key==='local'?'':key,agents=machineAgents(host),c=hostChecks.get(key),r=c?.result,d=dockerViews.get(key)?.result;
    const st=key==='local'?['connected','Online / Opaya runs here']:!c?['','Not checked yet']:c.state==='checking'?['working','Checking...']:c.state==='error'?['error','Unreachable']:['connected',`Online${r?.ms?` / ${(r.ms/1000).toFixed(1)} s`:''}`];
    const facts=key==='local'?[state.machine?.hostname,{win32:'Windows',darwin:'macOS',linux:'Linux'}[state.platform]||state.platform]:r?[r.os||r.system,r.memory&&`memory ${r.memory}`,r.disk&&`disk ${r.disk}`]:[h?.alias||h?.hostname];
    const copies=[...jobs.values()].filter(j=>j.kind==='clone'&&j.status==='running'&&(j.route?.toHostId||'')===host);
    return `<article class="fleet-col ${fleetFocus===key?'focused':''} ${st[0]==='error'?'down':''}" data-drop="agent" data-machine="${esc(key)}" data-action="fleet-focus" data-id="${esc(key)}" ${fleetFocus===key?'aria-current="true"':''}>
      <header class="fleet-col-head" data-action="fleet-focus" data-id="${esc(key)}" title="Details and Docker for ${esc(machineName(key))}"><span class="mg-target-icon ${key==='local'?'local-t':'vps-t'}" aria-hidden="true"></span><div><strong>${esc(machineName(key))}</strong><small><span class="status-dot ${st[0]}"></span> ${esc(st[1])}</small></div><button type="button" class="mg-icon-btn" data-action="fleet-machine-menu" data-id="${esc(key)}" aria-label="Actions for ${esc(machineName(key))}">&#8943;</button></header>
      ${facts.filter(Boolean).length?`<div class="fleet-facts">${facts.filter(Boolean).map(f=>`<span>${esc(f)}</span>`).join('')}</div>`:''}
      <div class="fleet-agents">${agents.map(fleetAgent).join('')}${copies.map(j=>`<div class="fleet-agent copying"><span class="fleet-agent-text"><strong>${esc(j.route.to)}</strong><small>${/ \/ /.test(j.route.toWhere||'')?'Into Docker':'Cloning'} from ${esc(j.route.from)} / ${jobPercent(j)}%</small></span><i style="--p:${jobPercent(j)}%"></i></div>`).join('')}${agents.length||copies.length?'':'<p class="fleet-empty">Drop an agent here to clone or migrate it to this machine.</p>'}</div>
      <footer class="fleet-col-foot"><button type="button" class="fleet-docker ${d?.running?'on':''}" data-action="${d?'docker-manager':'docker-refresh'}" data-id="${esc(key)}" title="${esc(d?.running?`Docker ${d.version}: open the Docker manager`:d?`${d.error||'No Docker'}. Open the Docker manager`:'Check for Docker on this machine')}"><span class="mg-image-icon" aria-hidden="true"></span>${d?.running?`Docker / ${d.containers.filter(x=>x.state==='running').length} of ${d.containers.length} running`:d?.installed===false?'No Docker':d?'Docker stopped':'Check Docker'}</button><button type="button" class="mg-icon-btn" data-action="install-catalog" ${host?`data-host="${esc(host)}"`:''} title="Install agents and tools on ${esc(machineName(key))}">+ Install</button></footer></article>`;
  }
  // The chosen machine, in one panel under the board: where it is and what you can do there, the tools installed on
  // it, then its Docker with every container as a card.
  function fleetDetail(key){
    const h=state.hosts.find(x=>x.id===key),host=key==='local'?'':key,tools=(state.toolUpdates?.machines?.[key]?.items||[]).filter(i=>i.installed),agents=machineAgents(host),out=tools.filter(i=>i.outdated).length,c=hostChecks.get(key),r=c?.result;
    const b=(act,label,attrs='',hint='',cls='secondary small')=>`<button type="button" class="${cls}" data-action="${act}" ${attrs} ${hint?`title="${esc(hint)}"`:''}>${label}</button>`,id=host?`data-id="${esc(host)}"`:'',hostAttr=host?`data-host="${esc(host)}"`:'';
    const st=key==='local'?['connected','Online / Opaya runs here']:!c?['','Not checked yet']:c.state==='checking'?['working','Checking...']:c.state==='error'?['error',`Unreachable${c.error?`: ${c.error}`:''}`]:['connected',`Online${r?.ms?` / answers in ${(r.ms/1000).toFixed(1)} s`:''}`];
    const facts=key==='local'?[['System',{win32:'Windows',darwin:'macOS',linux:'Linux'}[state.platform]||state.platform],['Name',state.machine?.hostname]]:[['System',r?.os||r?.system],['Memory',r?.memory],['Disk',r?.disk],['Address',h&&sshText(h)]];
    return `<section class="mg-section fleet-panel"><header class="fleet-panel-head"><span class="mg-target-icon ${key==='local'?'local-t':'vps-t'}" aria-hidden="true"></span><div class="fleet-panel-title"><h2>${esc(machineName(key))}</h2><p><span class="status-dot ${st[0]}"></span> ${esc(st[1])} <span class="mg-sep">/</span> ${agents.length} agent${agents.length===1?'':'s'}</p></div><div class="mg-head-actions">${host?b('host-test','&#8635; Test',id,'Test the SSH connection'):''}${b(host?'host-terminal':'local-terminal','&gt;_ Terminal',id)}${b(host?'host-files':'files-local','Files',id)}${b('install-catalog','&#8595; Install agents',hostAttr,'','primary small')}${host?b('edit-host','Edit',id):b('local-machine','Rename')}</div></header>
      <dl class="fleet-panel-facts">${facts.filter(f=>f[1]).map(([t,v])=>`<div><dt>${esc(t)}</dt><dd title="${esc(v)}">${esc(v)}</dd></div>`).join('')}</dl>
      <div class="fleet-panel-block"><h3>Installed tools</h3><div class="fleet-tools">${tools.length?tools.map(i=>`<span class="mg-pill ${i.outdated?'warn':'ok'}" title="${esc(`${i.label||i.id} ${i.installed}${i.outdated&&i.latest?`, ${i.latest} available`:''}`)}">${esc(i.label||i.id)} ${esc(i.installed)}${i.outdated?' &#8593;':''}</span>`).join(''):'<span class="field-help fleet-tools-empty">Check versions lists the agents and tools installed here.</span>'}${out?b('tool-updates',`&#8679; Update ${out}`):''}${b('machine-versions','Check versions',hostAttr,'','subtle small')}</div></div>
      <div class="fleet-panel-block fl-docker" id="fl-docker" data-key="${esc(key)}">${dockerPanel(null,key)}</div></section>`;
  }
  function renderFleet(){
    if(!machineKeys().includes(fleetFocus))fleetFocus='local';
    topbar('<strong>Machines</strong>');
    contentKind('overview manage command-center fleet');
    const keys=machineKeys(),docker=state.agents.filter(a=>containerOf(a)).length,down=keys.filter(k=>hostChecks.get(k)?.state==='error').length;
    const hero=`<section class="mg-hero fleet-hero"><div class="mg-stage" id="mg-stage" aria-hidden="true"></div><div class="mg-card glass fleet-card"><div class="mg-id"><span class="opaya-mark small" aria-hidden="true"><img src="assets/opaya-logo.png" alt=""><i></i></span><div class="mg-id-text"><h1>Machines</h1><p>${keys.length} machine${keys.length===1?'':'s'} <span class="mg-sep">/</span> ${state.agents.length} agent${state.agents.length===1?'':'s'} <span class="mg-sep">/</span> ${docker} in Docker${down?` <span class="mg-sep">/</span> <span class="danger-text">${down} unreachable</span>`:''}</p></div></div>
      <p class="fleet-lead">Every computer your agents run on. Pick one for its tools and Docker; drag an agent between machines to copy or move it.</p>
      <div class="mg-hero-actions"><button type="button" class="primary" data-action="new-vps">+ New VPS</button><button type="button" class="secondary" data-action="machine-add-menu" aria-haspopup="menu" title="A server you already use: by its SSH address or from ~/.ssh/config">Add existing &#9662;</button><button type="button" class="secondary" data-action="install-catalog">&#8595; Install agents</button><button type="button" class="secondary mg-more" data-action="fleet-more" aria-haspopup="menu" title="Test all machines, update all agents" aria-label="More">&#8943;</button></div></div></section>`;
    const tip=`<p class="fleet-tip"><b>Drag</b> an agent onto another machine to clone or migrate it, or onto another agent to share skills, keys and MCP servers. <b>&#8943;</b> on an agent: update, back up, uninstall.</p>`;
    const parts=[['fl-hero','',0,hero],['fl-board','mg-reveal',1,`<div class="fleet-board">${keys.map(fleetColumn).join('')}</div>${tip}`],['fl-detail','fleet-detail mg-reveal',2,fleetDetail(fleetFocus)]];
    const entering=renderKey!=='fleet'||!$('#fl-hero');
    if(entering){fleetHtml={};$('#content').innerHTML=parts.map(([id,cls,i,inner])=>{fleetHtml[id]=inner;return `<div id="${id}" class="${cls}" style="--i:${i}">${inner}</div>`;}).join('');$('#content').classList.remove('view-enter');$('#content').scrollTop=0;$('#content').classList.add('mg-entering');clearTimeout(renderFleet.t);renderFleet.t=setTimeout(()=>$('#content')?.classList.remove('mg-entering'),1400);}
    else for(const [id,,,inner] of parts)if(fleetHtml[id]!==inner){const el=document.getElementById(id);if(el){fleetHtml[id]=inner;el.innerHTML=inner;}}
    renderKey='fleet';
    const S=stage(),slot=$('#mg-stage');
    if(S&&slot){heroCtl=heroCtl||S.heroStage();if(heroCtl.el.parentElement!==slot)slot.append(heroCtl.el);heroCtl.set({agent:'fleet',status:down?'connecting':'connected',busy:state.agents.some(a=>a.busy),nodes:keys.slice(0,7).map(k=>({kind:hostChecks.get(k)?.state==='error'?'clone':'machine',label:`${machineName(k)} / ${machineAgents(k==='local'?'':k).length}`,on:machineOnline(k)}))});}
    if(!mgTimer)mgTimer=setTimeout(manageTick,600);
  }
  // Dropped on a machine: the moves that fit there.
  function machineDrop(a,key,from,target){
    const host=key==='local'?'':key,name=machineName(key),here=(a.transport==='ssh'?a.hostId:'')===host,r=target.getBoundingClientRect(),ok=cloneable(a),docker=ok&&canDocker(a);
    const go=(runtime,migrate)=>()=>deployTo(a,host,runtime,from,target,{migrate});
    const others=machineAgents(host).filter(x=>x.id!==a.id);
    openMenu(Math.min(r.left+24,innerWidth-300),Math.min(r.top+56,innerHeight-300),[
      !ok&&{icon:'!',label:'An API connection: nothing to copy',disabled:true,run:()=>{}},
      ok&&{icon:'&#10697;',label:here?`Another copy on ${name}`:`Clone to ${name}`,run:go('regular',false)},
      docker&&{icon:'&#9635;',label:`Clone into Docker on ${name}`,run:go('docker',false)},
      ok&&!here&&{icon:'&#8674;',label:`Migrate to ${name}`,run:go('regular',true)},
      docker&&{icon:'&#8674;',label:`Migrate into Docker on ${name}`,run:go('docker',true)},
      others.length?'-':'',
      others.length&&{icon:'&#8644;',label:'Share skills, keys and MCP with',submenu:others.map(x=>({icon:'&#8250;',label:title(x),run:()=>shareTo(a,x.id,from,target)}))}
    ],`${title(a)} to ${name}: migrating retires the original afterwards`);
  }
  async function shareTo(a,targetId,from,targetEl){
    const el=document.querySelector(`.fleet-agent[data-agent-target="${CSS.escape(targetId)}"]`)||targetEl;
    await stage()?.fly({from,to:el,kind:'skill',count:3});openTransfer(a,{targetId});
  }
  // Clone to, migrate to and share with, as submenus: the same moves without dragging.
  function moveItems(a,migrate){
    const ok=cloneable(a),docker=ok&&canDocker(a),from=$(`.fleet-agent[data-agent-target="${CSS.escape(a.id)}"]`)||$('.mg-card');
    return machineKeys().flatMap(key=>{const host=key==='local'?'':key,here=(a.transport==='ssh'?a.hostId:'')===host,to=()=>$(`.fleet-col[data-machine="${CSS.escape(key)}"]`)||$(`.mg-target[data-deploy-host="${CSS.escape(host)}"]`);
      return [!(migrate&&here)&&{icon:'&#9635;',label:machineName(key),run:()=>deployTo(a,host,'regular',from,to(),{migrate})},docker&&{icon:'&#9635;',label:`${machineName(key)} · Docker`,run:()=>deployTo(a,host,'docker',from,to(),{migrate})}].filter(Boolean);}).filter(()=>ok);
  }
  function fleetAgentMenu(a,button){
    const x=agentActions(a),r=button.getBoundingClientRect(),others=state.agents.filter(y=>y.id!==a.id);
    openMenu(r.left,r.bottom+4,[
      {icon:'&#9881;',label:'Manage',run:()=>openManage(a.id)},x.open,x.console,'-',
      cloneable(a)?{icon:'&#10697;',label:'Clone to',submenu:moveItems(a,false)}:{icon:'&#10697;',label:'Clone: an API connection has nothing to copy',disabled:true,run:()=>{}},
      cloneable(a)&&{icon:'&#8674;',label:'Migrate to',submenu:moveItems(a,true)},
      others.length&&{icon:'&#8644;',label:'Share with',submenu:others.map(y=>({icon:'&#8250;',label:`${title(y)} (${machineName(y.transport==='ssh'?y.hostId:'local')})`,run:()=>openTransfer(a,{targetId:y.id})}))},
      x.redeploy,'-',x.update,x.backup,x.connect,'-',x.uninstall,x.remove
    ],title(a));
  }
  function fleetMachineMenu(key,button){
    const host=key==='local'?'':key,h=state.hosts.find(x=>x.id===host),r=button.getBoundingClientRect(),agents=machineAgents(host);
    openMenu(r.left,r.bottom+4,[
      host&&{icon:'&#8635;',label:'Test connection',run:()=>testMachine(host)},
      {icon:'&gt;_',label:'Terminal',run:()=>openTerminal(host?{hostId:host}:{local:true})},
      {icon:'&#9656;',label:'Files',run:()=>openFiles(host?{hostId:host,label:`${h.name} over SSH`}:{label:'This computer'})},
      {icon:'&#9678;',label:'Discover agents here',run:()=>discover(host||undefined)},
      {icon:'&#8595;',label:'Install agents',run:()=>openInstall(host)},
      {icon:'&#9635;',label:'Docker manager',run:()=>openDocker(key)},'-',
      agents.length&&{icon:'&#9679;',label:`Connect its ${agents.length} agent${agents.length===1?'':'s'}`,run:async()=>{for(const a of agents)if(a.status!=='connected')await api.connect({id:a.id}).catch(()=>{});}},
      agents.some(a=>a.install?.update)&&{icon:'&#8635;',label:'Update its agents',run:async()=>{for(const a of agents)if(a.install?.update)await updateAgent(a);}},
      '-',
      host&&{icon:'&gt;',label:'Copy SSH command',run:async()=>{await api.clipboardWrite({text:sshText(h)});toast('SSH command copied.');}},
      host?{icon:'&#9998;',label:'Edit machine',run:()=>openHosts(h)}:{icon:'&#9998;',label:'Rename this computer',run:()=>openLocalMachine()},
      host&&{icon:'&#10005;',label:'Remove machine from Opaya',danger:true,disabled:agents.length>0,hint:agents.length?'has agents':'',run:async()=>{if(!await ask(`Remove ${h.name} from Opaya?\n\nOnly Opaya forgets it. The server, its agents and your SSH keys stay as they are.`))return;await api.removeHost({id:host});hostChecks.delete(host);await refresh();}}
    ],machineName(key));
  }
  // A migration is a clone, and then the original is retired once the copy is there.
  function finishMigration(src,j){
    modal(`${title(src)} migrated`,`The copy is ready on ${j.route?.toWhere||'its new machine'}. Retire the original on ${location(src)}?`,`<div class="migrate-done"><p class="field-help">Check the copy first if you like: open it, connect and send a message. The original keeps running until you choose.</p><div class="modal-footer"><button type="button" class="secondary" data-migrate="keep">Keep both</button><div><button type="button" class="secondary" data-migrate="remove">Remove its connection only</button><button type="button" class="primary danger-button" data-migrate="uninstall">Uninstall the original&#8230;</button></div></div></div>`);
    $('.migrate-done').addEventListener('click',event=>{const b=event.target.closest('[data-migrate]');if(!b)return;const how=b.dataset.migrate;
      if(how==='keep'){closeModal();return;}
      if(how==='uninstall'){closeModal();openUninstall(src);return;}
      action(async()=>{if(await api.removeAgent({id:src.id})){closeModal();await refresh();toast(`${title(src)}'s old connection is removed; the copy stays.`);}});});
  }
  // ---- Arranging terminal windows -----------------------------------------------------------------------------------
  // Side by side, stacked or a grid, in the panel next to or below the chat and in Terminal full screen alike.
  const ARRANGE_ICON={cols:'<span class="arr-ico cols" aria-hidden="true"><i></i><i></i></span>',rows:'<span class="arr-ico rows" aria-hidden="true"><i></i><i></i></span>',grid:'<span class="arr-ico grid" aria-hidden="true"><i></i><i></i><i></i><i></i></span>'};
  const arrangePicker=()=>`<div class="grid-picker arrange-picker" role="group" aria-label="Terminal layout presets">${Object.keys(ARRANGE).map(k=>`<button type="button" class="grid-pick" data-action="terminal-arrange" data-arrange="${k}" title="${esc(ARRANGE[k][0])}: ${esc(ARRANGE[k][1])}">${ARRANGE_ICON[k]}</button>`).join('')}</div>`;
  function setArrange(k){
    if(!ARRANGE[k])return;layout.arrange=k;const w=workspace();w.tree=TL.preset(panes.filter(Boolean),k);w.maximized='';renderPanes();saveView();
  }
  window.addEventListener('resize',()=>{if(!$('#terminal-panel').hidden)requestAnimationFrame(renderPanes);});
  // A window's own menu (right-click its title bar).
  function terminalMenu(id){
    const view=terminalViews.get(id);if(!view)return [];
    return [
      {icon:'&#9998;',label:'Rename...',run:()=>renameTerminal(id)},
      {icon:'&#9645;',label:'Hide (keeps running)',run:()=>hideWindow(id)},
      {icon:'&#10697;',label:'Open in separate window',disabled:view.exited,run:()=>popoutTerminal(id)},
      '-',
      {icon:'&#10005;',label:view.exited?'Close saved output':'End session',danger:!view.exited,run:()=>endWindow(id)}
    ];
  }
  // Windows that are hidden here, and the ones open on other screens (to bring here).
  function windowsMenu(){
    const here=termCtx(),hidden=ctxWindows(here).filter(v=>v.hiddenPane),elsewhere=[...terminalViews.values()].filter(v=>(v.ctx||'')!==here&&!v.poppedOut);
    const whose=v=>{const a=state.agents.find(x=>x.id===v.ctx);return a?title(a):'Home and other screens';};
    return [...hidden.map(v=>({icon:'&gt;_',label:`Show ${tabTitle(v)}`,run:()=>showWindow(v.id)})),
      elsewhere.length&&{icon:'&#8618;',label:'Bring here',submenu:elsewhere.map(v=>({icon:'&gt;_',label:`${tabTitle(v)} (${whose(v)})`,run:()=>showWindow(v.id)}))}].filter(Boolean);
  }
  function workspaceMenu(){
    return [
      {icon:'&#9679;',label:'Connect all agents',run:()=>connectAll()},
      {icon:'&#8644;',label:'Open Playground',run:()=>{overview=false;opayaView=false;playgroundView=true;render();saveView();}},
      {icon:'&#10038;',label:'Ask the Opaya Agent',run:()=>{overview=false;opayaView=true;render();saveView();}},
      {icon:'&#9678;',label:'Discover agents',run:()=>discover()},
      {icon:'&#8595;',label:'Install agents...',run:()=>openInstall()},
      {icon:'&#8679;',label:'Check for updates...',run:()=>openToolUpdates()},
      {icon:'&#8635;',label:'Update all agents...',disabled:!state.agents.some(a=>a.install?.update),run:()=>updateAll()},
      {icon:'+',label:'Add connection...',run:()=>openAdd()},
      {icon:'&#9635;',label:'Machines...',run:()=>openHosts()},
      {icon:'&gt;_',label:'Open local terminal',run:()=>openTerminal({local:true})},
      {icon:'&#10022;',label:'Skills library...',run:()=>openLibrary()},
      {icon:'&#9656;',label:'Browse files on this computer',run:()=>openFiles({label:'This computer'})},
      '-',
      {icon:'&#9681;',label:theme==='light'?'Switch to dark theme':'Switch to light theme',run:()=>{applyTheme(theme==='light'?'dark':'light');saveView();}},
      {icon:'&#9881;',label:'Settings...',run:()=>openSettings()}
    ];
  }
  // Context menus: one level of submenus (an item with `submenu`). Hover or ArrowRight opens it, ArrowLeft or Escape
  // goes back to the parent item.
  let menu=null,submenuTimer=0;
  const menuItems=items=>items.filter(Boolean).filter((item,i,all)=>item!=='-'||(i>0&&all[i-1]!=='-'&&i<all.length-1));
  const menuButtons=element=>[...element.querySelectorAll('button:not(:disabled)')];
  function closeSubmenu(){
    clearTimeout(submenuTimer);const child=menu?.child;if(!child)return;menu.child=null;
    child.button.classList.remove('submenu-open');child.button.setAttribute('aria-expanded','false');child.element.remove();
  }
  function closeMenu(restore=false){
    if(!menu)return;closeSubmenu();const {element,previous,owner}=menu;menu=null;owner?.classList.remove('menu-open');
    element.classList.add('closing');element.addEventListener('animationend',()=>element.remove(),{once:true});setTimeout(()=>element.remove(),200);
    window.removeEventListener('blur',dismiss);window.removeEventListener('resize',dismiss);document.removeEventListener('pointerdown',outside,true);document.removeEventListener('scroll',dismiss,true);
    if(restore)previous?.focus?.();
  }
  // A scroll closes the menu only when it moves what the menu is attached to: the page, or a panel holding the item
  // that was right-clicked. Other panels scrolling (a job log, a streaming chat) leave it open.
  const dismiss=event=>{if(event?.type==='scroll'&&event.target instanceof Element){if(event.target.closest('.context-menu'))return;if(!menu?.owner||!event.target.contains(menu.owner))return;}closeMenu();},outside=event=>{if(menu&&!menu.element.contains(event.target)&&!menu.child?.element.contains(event.target))closeMenu();};
  function buildMenu(list,label){
    const element=document.createElement('div');element.className='context-menu';element.setAttribute('role','menu');if(label)element.setAttribute('aria-label',label);
    element.innerHTML=list.map((item,i)=>item==='-'?'<div class="context-menu-separator" role="separator"></div>':`<button type="button" role="menuitem" data-menu-index="${i}" class="${item.danger?'danger':''} ${item.submenu?'has-submenu':''}" ${item.disabled?'disabled':''} ${item.submenu?'aria-haspopup="menu" aria-expanded="false"':''} style="--i:${i}"><span class="context-menu-icon" aria-hidden="true">${item.icon||''}</span><span class="context-menu-text">${esc(item.label)}</span>${item.hint?`<kbd>${esc(item.hint)}</kbd>`:''}${item.submenu?'<span class="context-menu-chevron" aria-hidden="true">&#8250;</span>':''}</button>`).join('');
    return element;
  }
  function openSubmenu(button,item,focus){
    if(!menu)return;clearTimeout(submenuTimer);
    if(menu.child?.button===button){if(focus)menuButtons(menu.child.element)[0]?.focus({preventScroll:true});return;}
    closeSubmenu();const list=menuItems(item.submenu||[]);if(!list.length)return;
    const element=buildMenu(list,item.label);element.classList.add('submenu');document.body.append(element);
    const r=button.getBoundingClientRect(),{width,height}=element.getBoundingClientRect(),edge=document.body.classList.contains('frameless')?44:8;
    const right=r.right+width+4<=innerWidth-8,left=right?r.right+2:Math.max(8,r.left-width-2),top=Math.max(edge,Math.min(r.top-6,innerHeight-height-8));
    element.style.left=left+'px';element.style.top=top+'px';element.style.transformOrigin=right?'0 0':'100% 0';
    button.classList.add('submenu-open');button.setAttribute('aria-expanded','true');
    menu.child={element,button};wireMenu(element,list,true);
    if(focus)menuButtons(element)[0]?.focus({preventScroll:true});
  }
  function wireMenu(element,list,sub){
    element.addEventListener('click',event=>{const button=event.target.closest('[data-menu-index]');if(!button||button.disabled)return;const item=list[Number(button.dataset.menuIndex)];if(item.submenu){openSubmenu(button,item,true);return;}closeMenu();action(()=>item.run());});
    element.addEventListener('keydown',event=>{
      const all=menuButtons(element),at=all.indexOf(document.activeElement),current=all[at],item=current&&list[Number(current.dataset.menuIndex)];
      if(event.key==='Tab')closeMenu(true);
      else if(event.key==='ArrowLeft'&&sub){event.preventDefault();const b=menu.child.button;closeSubmenu();b.focus({preventScroll:true});}
      else if(['ArrowRight','Enter',' '].includes(event.key)&&item?.submenu){event.preventDefault();openSubmenu(current,item,true);}
      else if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?all.length-1:(at+(event.key==='ArrowDown'?1:-1)+all.length)%all.length;all[next]?.focus();}
    });
    element.addEventListener('pointermove',event=>{
      const button=event.target.closest('button:not(:disabled)');if(!button||!menu)return;if(document.activeElement!==button)button.focus({preventScroll:true});
      if(sub)return;clearTimeout(submenuTimer);const item=list[Number(button.dataset.menuIndex)];
      if(item?.submenu){if(menu.child?.button!==button)submenuTimer=setTimeout(()=>{if(menu?.element===element)openSubmenu(button,item,false);},130);}
      else if(menu.child)submenuTimer=setTimeout(()=>{if(menu?.element===element&&!menu.child?.element.matches(':hover'))closeSubmenu();},260);
    });
    element.addEventListener('pointerleave',()=>{if(!sub)clearTimeout(submenuTimer);});
  }
  function openMenu(x,y,items,label='',owner=null){
    closeMenu();const list=menuItems(items);if(!list.length)return;
    const element=buildMenu(list,'');if(label){element.setAttribute('aria-label',label);element.insertAdjacentHTML('afterbegin',`<div class="context-menu-label">${esc(label)}</div>`);}
    document.body.append(element);
    const edge=document.body.classList.contains('frameless')?44:8;element.style.maxHeight=`${innerHeight-edge-8}px`;const {width,height}=element.getBoundingClientRect(),left=Math.max(8,Math.min(x,innerWidth-width-8)),flip=y+height>innerHeight-8,top=Math.max(edge,flip?y-height:y);
    element.style.left=left+'px';element.style.top=top+'px';element.style.transformOrigin=`${x-left}px ${flip?'100%':'0'}`;
    menu={element,previous:document.activeElement,owner,child:null};owner?.classList.add('menu-open');
    wireMenu(element,list,false);
    window.addEventListener('blur',dismiss);window.addEventListener('resize',dismiss);document.addEventListener('pointerdown',outside,true);document.addEventListener('scroll',dismiss,true);
    menuButtons(element)[0]?.focus({preventScroll:true});
  }
  document.addEventListener('contextmenu',event=>{
    const target=event.target;
    // Text fields, selections and terminals keep the native edit menu (copy/paste).
    if(target.closest('input,textarea,select,[contenteditable="true"],.terminal-views,.context-menu')||(String(window.getSelection?.()||'').trim()&&!target.closest('.sidebar')))return;
    if($('#app-dialog'))return;
    const point=element=>{if(event.clientX||event.clientY)return [event.clientX,event.clientY];const r=element.getBoundingClientRect();return [r.left+12,r.bottom-4];};
    const section=target.closest('.sidebar-section-label[data-group]');
    if(section){event.preventDefault();const [x,y]=point(section);openMenu(x,y,groupMenu(section.dataset.group,section.querySelector('.group-name')?.textContent||''),section.querySelector('.group-name')?.textContent||'Section');return;}
    const agentElement=target.closest('[data-agent-id]'),head=target.closest('.terminal-pane-head'),headId=head&&panes[Number(head.closest('.terminal-pane').dataset.index)];
    if(agentElement){const a=state.agents.find(a=>a.id===agentElement.dataset.agentId);if(!a)return;event.preventDefault();const [x,y]=point(agentElement);openMenu(x,y,agentMenu(a),title(a),agentElement);return;}
    if(headId){event.preventDefault();const [x,y]=point(head);openMenu(x,y,terminalMenu(headId),terminalViews.get(headId)?.title||'Terminal');return;}
    if(target.closest('.sidebar,.content.overview')){event.preventDefault();const [x,y]=point(target);openMenu(x,y,workspaceMenu(),'Workspace');}
  });
  document.addEventListener('keydown',event=>{if(event.key!=='Escape'||!menu)return;event.preventDefault();event.stopPropagation();if(menu.child){const b=menu.child.button;closeSubmenu();b.focus({preventScroll:true});}else closeMenu(true);},true);
  // ---- Opaya Agent -------------------------------------------------------------------------------------------
  const opaya=()=>state.opayaAgent||{configured:false,config:{},presets:{},messages:[]};
  const opayaModelLabel=o=>o.config?.model||o.presets?.[o.config?.preset]?.label||'Ready';
  let opayaDraft='',opayaSeen=new Map(),opayaCount=-1;
  function renderOpayaNav(){
    const o=opaya(),label=o.busy?'Working...':o.configured?opayaModelLabel(o):'Set up';document.body.classList.toggle('opaya-busy',!!o.busy);
    const el=$('#opaya-nav-status');if(el&&el.textContent!==label)el.textContent=label;
    $('.nav-opaya')?.classList.toggle('busy',!!o.busy);
  }
  const OPAYA_STARTERS=[['Why is an agent not connecting?','One of my agents is not working. Check my workspace, find what is wrong and help me fix it.'],['Install Codex on this computer','Install the Codex CLI on this computer and add it to Opaya when it is done.'],['Set up my VPS','Help me add my VPS as a machine, set up an SSH key for it and find the agents running there.'],['What do I have?','Give me a short overview of my agents, their status and my machines.']];
  // ---- Setup guide: a scripted conversation (no AI model needed) that gets this computer ready. The person picks; Opaya
  // installs. A model for the Opaya Agent comes first; once it has one, the Opaya Agent finishes the setup.
  const GUIDE_WAYS=[
    ['chatgpt','I have ChatGPT','Plus, Pro or a free account. Opaya installs Codex CLI and you sign in once.','codex'],
    ['claude','I have Claude','A Claude Pro or Max plan. Opaya installs Claude Code and you sign in once.','claude'],
    ['api','I have an API key','From OpenAI, Anthropic, Google, DeepSeek, Groq, OpenRouter, Mistral or any compatible service.',''],
    ['none','I have nothing yet','No problem: start with a free model, or set up the tools now and add AI later.','']];
  const GUIDE_GOALS=[['web','Websites and web apps','Git, Node.js, GitHub CLI'],['python','Python, data and automation','Git, Python, uv'],['agents','Just work with AI agents','Git'],['all','A bit of everything','All of the above']];
  const GUIDE_AGENTS=[['codex','Codex CLI','ChatGPT'],['claude','Claude Code','Claude'],['opencode','OpenCode','Many models']];
  const GUIDE_KEYS=['google','groq','openrouter','openai','anthropic','deepseek','mistral','xai','cerebras','ollama-cloud','custom'];
  let guide=null;const guideDismissed=()=>tipsSeen.has('guide-closed');
  const guideOn=()=>!!guide;
  function startGuide(){guide={step:'hello',way:'',goals:new Set(),agents:new Set(),trust:true,facts:null,plan:null,jobId:'',keyPreset:'google',keyError:'',answers:{}};opayaView=true;overview=false;playgroundView=false;render();saveView();
    api.guideScan().then(f=>{if(guide){guide.facts=f;if(opayaView)renderOpaya();}}).catch(e=>{if(guide){guide.facts={error:e.message,tools:{},signedIn:{}};if(opayaView)renderOpaya();}});}
  function closeGuide(){guide=null;if(!tipsSeen.has('guide-closed')){tipsSeen.add('guide-closed');saveView();}opayaCount=-1;renderOpaya();}
  const gBubble=(html,{you=false,cls=''}={})=>`<article class="message ${you?'user-message':'assistant-message'} guide-msg ${cls}"><div class="message-avatar ${you?'you-avatar':'opaya-avatar'}">${you?'S':'<span class="opaya-mark"><img src="assets/opaya-logo.png" alt=""></span>'}</div><div class="message-body"><div class="message-meta"><strong>${you?'You':'Opaya'}</strong>${you?'':'<span class="guide-tag">setup guide</span>'}</div><div class="message-text">${html}</div></div></article>`;
  const gAnswer=(text,back)=>gBubble(`${esc(text)} <button type="button" class="text-button guide-change" data-guide="back" data-to="${back}">Change</button>`,{you:true});
  const gTool=(id,label)=>{const v=guide.facts?.tools?.[id];return `<span class="guide-fact ${v?'ok':''}" title="${v?esc(v):'Not installed yet'}">${v?'&#10003;':'&#8226;'} ${label}</span>`;};
  function guideFactsHtml(){
    const f=guide.facts;if(!f)return '<p class="guide-scan"><span class="status-dot working"></span> Looking at this computer...</p>';
    if(f.error)return `<p class="guide-scan">I could not look at everything (${esc(f.error)}), but we can still go on.</p>`;
    return `<div class="guide-facts"><span class="guide-fact sys">${esc(f.system)} / ${f.memoryGb} GB memory</span>${gTool('git','Git')}${gTool('node','Node.js')}${gTool('python','Python')}${gTool('codex','Codex CLI')}${gTool('claude','Claude Code')}</div>`;
  }
  function guideWayCards(){
    const f=guide.facts||{};
    return `<div class="guide-cards">${GUIDE_WAYS.map(([id,t,text,tool])=>{const ready=tool&&f.tools?.[tool],signed=tool&&f.signedIn?.[tool];return `<button type="button" class="guide-card ${guide.way===id?'selected':''}" data-guide="way" data-value="${id}"><span class="guide-card-icon ${id}" aria-hidden="true">${tool?badge({provider:tool}):id==='api'?'&#9919;':'&#10022;'}</span><strong>${t}</strong><span>${text}</span>${signed?'<em class="guide-badge">Already signed in</em>':ready?'<em class="guide-badge">Already installed</em>':''}</button>`;}).join('')}</div>`;
  }
  function guideNoneCards(){
    const ok=guide.facts?.localModelOk!==false;
    return `<div class="guide-cards two"><button type="button" class="guide-card" data-guide="none" data-value="free"><span class="guide-card-icon" aria-hidden="true">&#8595;</span><strong>Free model on this computer</strong><span>Private and free, no account. About 2.5 GB to download.${ok?'':' This computer has little memory, so it will be slow.'}</span></button>
      <button type="button" class="guide-card" data-guide="none" data-value="freekey"><span class="guide-card-icon" aria-hidden="true">&#9919;</span><strong>Free key from Google</strong><span>One minute: sign in with a Google account, copy the key, paste it here. Fast and free.</span></button>
      <button type="button" class="guide-card" data-guide="none" data-value="later"><span class="guide-card-icon" aria-hidden="true">&#8987;</span><strong>Set up the tools now, AI later</strong><span>Opaya installs what you need; you connect AI when you are ready.</span></button></div>`;
  }
  function guideKeyForm(){
    const presets=opaya().presets||{},p=presets[guide.keyPreset]||{};
    return `<form class="guide-key" data-guide-form="key"><div class="guide-chips">${GUIDE_KEYS.filter(k=>presets[k]).map(k=>`<button type="button" class="marker-chip ${guide.keyPreset===k?'selected':''}" data-guide="key-preset" data-value="${k}">${esc(presets[k].label)}${presets[k].free?' <em class="preset-free">free</em>':''}</button>`).join('')}</div>
      ${guide.keyPreset==='custom'?'<label class="field"><span>Address (base URL)</span><input name="baseUrl" placeholder="https://.../v1" required></label>':''}
      <label class="field"><span>Paste your API key</span><input name="apiKey" type="password" autocomplete="off" placeholder="Your key stays in this computer's keychain" required></label>
      ${p.signup?`<p class="field-help">No key yet? <a href="#" data-action="open-link" data-external="1" data-url="${esc(p.signup)}">Get a free key from ${esc(p.label)} &#8599;</a>, then paste it here.</p>`:''}
      ${guide.keyError?`<div class="inline-notice error-notice">${esc(guide.keyError)}</div>`:''}
      <div class="guide-actions"><button type="submit" class="primary">Connect</button></div></form>`;
  }
  function guideGoalCards(){
    return `<div class="guide-cards goals">${GUIDE_GOALS.map(([id,t,tools])=>`<button type="button" class="guide-card small ${guide.goals.has(id)?'selected':''}" data-guide="goal" data-value="${id}" aria-pressed="${guide.goals.has(id)}"><strong>${t}</strong><span>${tools}</span></button>`).join('')}</div>
      <p class="guide-sub">Also install these AI agents <small>(optional; each works with its own account)</small></p>
      <div class="guide-chips">${GUIDE_AGENTS.map(([id,t,note])=>{const brain=({chatgpt:'codex',claude:'claude'})[guide.way]===id,has=guide.facts?.tools?.[id];return `<button type="button" class="marker-chip ${guide.agents.has(id)||brain?'selected':''}" data-guide="agent" data-value="${id}" ${brain?'disabled title="Installed as the Opaya Agent\'s brain"':''}>${badge({provider:id==='codex'||id==='claude'?id:'custom',avatar:id==='codex'||id==='claude'?'':`lib:${id}`})} ${t}${has?' <em>installed</em>':''} <small>${note}</small></button>`;}).join('')}</div>
      <div class="guide-actions"><button type="button" class="primary" data-guide="plan" ${guide.goals.size?'':'disabled'}>Continue</button></div>`;
  }
  function guidePlanHtml(){
    const p=guide.plan;if(!p)return '<p class="guide-scan"><span class="status-dot working"></span> Making a plan...</p>';
    if(p.error)return `<div class="inline-notice error-notice">${esc(p.error)}</div>`;
    const model=p.steps.filter(s=>s.phase==='model'),rest=p.steps.filter(s=>s.phase==='rest'),brain=model.length||opaya().configured;
    const row=(s,i)=>`<li><span class="guide-n">${i+1}</span><div><strong>${esc(s.title)}</strong><small>${esc(s.why)}</small></div></li>`;
    return `<ol class="guide-plan">${p.steps.map(row).join('')}</ol>
      ${brain&&rest.length?`<p class="field-help">${model.length?`After step ${model.length}, `:''}the Opaya Agent takes over and installs the rest, checking and fixing anything that goes wrong.</p><label class="check-row inline guide-trust"><input type="checkbox" data-guide="trust" ${guide.trust?'checked':''}> Let it install these without asking me each time</label>`:''}
      <div class="guide-actions"><button type="button" class="primary" data-guide="start">Start setup</button><span class="guide-note">You approve the plan once. Opaya downloads Node.js, Python and Git itself (official versions, no administrator password, no winget or Homebrew needed); agents install in a terminal you can watch.</span></div>`;
  }
  function guideRunHtml(){
    const j=jobs.get(guide.jobId);if(!j)return '<p class="guide-scan"><span class="status-dot working"></span> Starting...</p>';
    const last=[...(j.log||[])].reverse().find(l=>l.text&&l.text!=='Done.');const warn=last?.state==='warn';
    const steps=`<ol class="guide-plan live">${j.steps.map((s,i)=>`<li class="${s.state||'pending'}"><span class="guide-n">${s.state==='done'?'&#10003;':s.state==='error'?'!':i+1}</span><div><strong>${esc(s.label)}</strong>${s.state==='active'?`<small>${esc((j.log||[]).filter(l=>l.text).at(-1)?.text||'Working...')}</small>`:''}</div>${s.state==='active'?'<span class="status-dot working"></span>':''}</li>`).join('')}</ol>`;
    if(j.status==='running')return `${warn?`<div class="guide-callout">&#9888; ${esc(last.text)}</div>`:''}${steps}<p class="field-help">You can watch every step in the <strong>Opaya setup</strong> terminal below.</p>`;
    if(j.status==='error')return `${steps}<div class="inline-notice error-notice">${esc(j.error)}</div><div class="guide-actions"><button type="button" class="primary" data-guide="start">Try again</button>${opaya().configured?'<button type="button" class="secondary" data-guide="ask-fix">Ask the Opaya Agent to fix it</button>':''}<button type="button" class="secondary" data-guide="script">Continue without AI</button></div>`;
    if(j.result?.handoff)return `${steps}<p><strong>I have a brain now.</strong> The Opaya Agent is finishing the setup: installing the rest, checking versions and fixing problems. Follow along below.</p><div class="guide-actions"><button type="button" class="primary" data-guide="close">Watch the Opaya Agent</button></div>`;
    return `${steps}<p><strong>Your computer is ready.</strong>${opaya().configured?'':' When you get an AI account or key, come back here to connect it.'}</p><div class="guide-actions"><button type="button" class="primary" data-guide="projects">Start a project</button>${state.agents.length?`<button type="button" class="secondary" data-guide="chat">Chat with ${esc(title(state.agents[0]))}</button>`:''}<button type="button" class="secondary" data-guide="close">Close the guide</button></div>`;
  }
  function guideHtml(){
    const g=guide,parts=[gBubble(`<p><strong>Hi, I'm Opaya.</strong> I'll get this computer ready for building with AI. You don't need to know anything about code: you choose, I do the work.</p>${guideFactsHtml()}`)];
    const wayName=GUIDE_WAYS.find(w=>w[0]===g.way)?.[1];
    parts.push(gBubble(`<p>First: which of these do you have? The AI you already pay for (or a free one) becomes my brain, so I can finish the setup for you and fix anything that goes wrong.</p>${g.step==='hello'||g.step==='way'?guideWayCards():''}`));
    if(g.step==='hello'||g.step==='way')return parts.join('');
    parts.push(gAnswer(g.answers.way||wayName,'way'));
    if(g.way==='none'){
      parts.push(gBubble(`<p>Here are three ways to start without paying anything:</p>${g.step==='none'?guideNoneCards():''}`));
      if(g.step==='none')return parts.join('');
      parts.push(gAnswer(g.answers.none,'none'));
    }
    if(g.way==='api'||g.answers.none==='Free key from Google'){
      parts.push(gBubble(`<p>${g.way==='api'?'Which service is your key from?':'Open the link, sign in with Google, press <em>Create API key</em>, copy it and paste it below.'}</p>${g.step==='key'?guideKeyForm():''}`));
      if(g.step==='key')return parts.join('');
      parts.push(gAnswer(g.answers.key||'Connected','key'));
    }
    if(g.answers.none==='Free model on this computer'&&g.step==='free'){
      const fj=[...jobs.values()].reverse().find(j=>j.kind==='free-model');
      parts.push(gBubble(fj?.status==='error'?`<div class="inline-notice error-notice">${esc(fj.error)}</div><div class="guide-actions"><button type="button" class="primary" data-guide="free">Try again</button></div>`:`<p><span class="status-dot working"></span> Downloading and starting the free model. This takes a few minutes; I'll continue by myself when it is ready.</p>`));
      return parts.join('');
    }
    parts.push(gBubble(`<p>What would you like to make? Pick one or more.</p>${g.step==='goals'?guideGoalCards():''}`));
    if(g.step==='goals')return parts.join('');
    parts.push(gAnswer([...g.goals].map(id=>GUIDE_GOALS.find(x=>x[0]===id)?.[1]).join(', ')+(g.agents.size?` + ${[...g.agents].map(id=>GUIDE_AGENTS.find(x=>x[0]===id)?.[1]).join(', ')}`:''),'goals'));
    parts.push(gBubble(`<p>Here is my plan${g.facts?.system?` for your ${esc(g.facts.system)}`:''}:</p>${g.step==='plan'?guidePlanHtml():guideRunHtml()}`));
    return parts.join('');
  }
  const guideWayOf=()=>guide.way==='none'?(guide.answers.none==='Set up the tools now, AI later'?'none':guide.answers.none==='Free model on this computer'?'free':'api'):guide.way;
  async function guideMakePlan(){
    guide.step='plan';guide.plan=null;renderOpaya();
    try{guide.plan=await api.guidePlan({way:guideWayOf(),goals:[...guide.goals],agents:[...guide.agents]});}catch(e){guide.plan={error:e.message};}
    renderOpaya();
  }
  async function guideStart(scriptOnly=false){
    const job=await api.guideStart({way:guideWayOf(),goals:[...guide.goals],agents:[...guide.agents],trust:guide.trust,scriptOnly});
    guide.step='run';guide.jobId=job.id;onJob(job);renderOpaya();
  }
  function guideClick(b){
    const act=b.dataset.guide,v=b.dataset.value,g=guide;if(!g)return;
    if(act==='way'){g.way=v;g.answers.way=GUIDE_WAYS.find(w=>w[0]===v)[1];g.step=v==='none'?'none':v==='api'?'key':'goals';if(v==='api')g.keyPreset='openai';}
    else if(act==='none'){g.answers.none=b.querySelector('strong').textContent;if(v==='free'){g.step='free';action(async()=>{await api.opayaFreeSetup({});});}else if(v==='freekey'){g.keyPreset='google';g.step='key';}else g.step='goals';}
    else if(act==='free'){action(async()=>{await api.opayaFreeSetup({});});}
    else if(act==='key-preset'){g.keyPreset=v;g.keyError='';}
    else if(act==='goal'){if(g.goals.has(v))g.goals.delete(v);else{if(v==='all')g.goals.clear();else g.goals.delete('all');g.goals.add(v);}}
    else if(act==='agent'){if(g.agents.has(v))g.agents.delete(v);else g.agents.add(v);}
    else if(act==='plan'){guideMakePlan();return;}
    else if(act==='trust'){g.trust=b.checked;return;}
    else if(act==='start'){action(()=>guideStart(false));return;}
    else if(act==='script'){action(()=>guideStart(true));return;}
    else if(act==='ask-fix'){const j=jobs.get(g.jobId);closeGuide();action(()=>api.opayaSend({text:`The setup guide stopped with this problem: ${j?.error||'unknown'}. Look at the "Opaya setup" terminal, find out what went wrong and fix it, then finish the setup. Explain simply.`}));return;}
    else if(act==='back'){g.step=b.dataset.to==='way'?'way':b.dataset.to;if(b.dataset.to==='way'){g.way='';g.answers={};}g.plan=null;}
    else if(act==='close'){closeGuide();return;}
    else if(act==='projects'){closeGuide();toggleProjects(true);openProjectForm();return;}
    else if(act==='chat'){const a=state.agents[0];closeGuide();if(a)action(()=>selectAgent(a.id));return;}
    renderOpaya();
  }
  async function guideKeySubmit(form){
    const g=guide,preset=g.keyPreset,presets=opaya().presets||{},p=presets[preset]||{};g.keyError='';
    const values={preset,baseUrl:form.elements.baseUrl?.value.trim()||p.baseUrl||'',apiKey:form.elements.apiKey.value.trim(),model:p.model||'',remember:true};
    const btn=form.querySelector('[type=submit]');btn.disabled=true;btn.textContent='Connecting...';
    try{
      const r=await api.opayaTest(values);if(!values.model)values.model=(r.models||[])[0]||'';
      if(!values.model)throw new Error('Connected, but I could not find a model to use. Choose one in Model settings.');
      await api.opayaSaveConfig(values);await refresh();g.answers.key=`${p.label||'API'} connected`;g.step='goals';
    }catch(e){g.keyError=e.message;}
    renderOpaya();
  }
  function renderOpaya(){
    const o=opaya(),entering=renderKey!=='opaya';
    // Its model, iTrust, setup guide and chats are in its own sidebar.
    topbar('<strong>Opaya Agent</strong>');
    contentKind('conversation opaya-view');
    if(entering){
      $('#content').innerHTML=`<div class="conversation-heading"><div class="conversation-identity"><span class="agent-avatar large opaya-avatar"><span class="opaya-mark"><img src="assets/opaya-logo.png" alt=""><i></i></span></span><div><h1>Opaya Agent</h1><p>Installs, connects, maintains and troubleshoots your agents and machines.</p><div class="identity-meta"><span class="agent-meta"><span class="meta-icon local-mark" aria-hidden="true"></span><span>Lives in Opaya's home folder</span><span class="meta-divider">/</span><span>Changes only with your approval</span></span></div></div></div><div class="conversation-controls"><select id="opaya-sessions" aria-label="Opaya Agent chats" title="Earlier chats with the Opaya Agent"></select><button class="icon-button" data-action="opaya-new" title="New chat" aria-label="New chat">+</button><button class="icon-button" data-action="opaya-delete-session" title="Delete this chat" aria-label="Delete this chat">&#10005;</button></div></div><div id="opaya-banner"></div><div id="opaya-messages" class="message-list"></div><div class="compose-area"><form id="message-form" class="opaya-form"><textarea id="message-input" class="opaya-input" rows="2" maxlength="80000" aria-label="Message the Opaya Agent" placeholder="Ask the Opaya Agent to install, connect or fix an agent..."></textarea><div class="compose-bottom"><div><span class="compose-provider">Opaya Agent</span><span id="compose-hint"></span></div><button type="button" id="opaya-secret" class="icon-button compose-secret" title="Give a key, token or password: it stays in Opaya's vault and the model sees only a reference" aria-label="Give a key, token or password"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3 20 3M16 7l3 3M13.5 9.5l2 2"/></svg></button><button type="button" id="opaya-stop" class="stop-button" data-action="opaya-stop" hidden><span>&#9632;</span> Stop</button><button id="opaya-send" type="submit" class="send-button" aria-label="Send message">&#8593;</button></div></form><p class="compose-caption" id="opaya-caption"></p></div>`;
      const input=$('#message-input');input.value=opayaDraft;
      input.addEventListener('input',()=>{opayaDraft=input.value;input.style.height='auto';input.style.height=Math.min(input.scrollHeight,190)+'px';});
      input.addEventListener('keydown',event=>{if(sendKeyPressed(event)){event.preventDefault();sendOpaya();}});
      $('#message-form').addEventListener('submit',event=>{event.preventDefault();sendOpaya();});
      $('#opaya-secret').addEventListener('click',()=>openVault({chat:true}));
      $('#opaya-sessions').addEventListener('change',event=>action(async()=>{await api.opayaSelectSession({id:event.target.value});opayaCount=-1;}));
      $('#opaya-messages').addEventListener('click',event=>{const b=event.target.closest('[data-guide]');if(b&&guide&&!b.disabled)guideClick(b);});
      $('#opaya-messages').addEventListener('submit',event=>{const f=event.target.closest('[data-guide-form]');if(f&&guide){event.preventDefault();guideKeySubmit(f);}});
      enter($('#content'));opayaCount=-1;
    }
    renderKey='opaya';
    {const caption=$('#opaya-caption');if(caption)caption.textContent=state.settings?.itrustOpaya?'iTrust is on: it runs setup commands itself, in terminals you can watch':'Every change and command asks for your approval first';}
    {const sel=$('#opaya-sessions');if(sel){const html=(o.sessions||[]).map(x=>`<option value="${esc(x.id)}" ${x.id===o.sessionId?'selected':''}>${esc(x.title)}</option>`).join('');if(sel.dataset.html!==html){sel.innerHTML=html;sel.dataset.html=html;}sel.disabled=!!o.busy;}}
    if(guideOn()||!o.configured&&!o.messages.length&&!o.busy&&!guideDismissed()){
      if(!guide)startGuide();
      $('#opaya-banner').innerHTML='';const list=$('#opaya-messages'),html=guideHtml();
      if(list.dataset.guide!==html){const keep=list.querySelector('[name="apiKey"]')?.value||'',atEnd=list.scrollHeight-list.scrollTop-list.clientHeight<140;list.innerHTML=html;list.dataset.guide=html;const k=list.querySelector('[name="apiKey"]');if(k&&keep)k.value=keep;if(atEnd||entering)list.scrollTop=list.scrollHeight;}
      const send=$('#opaya-send');send.disabled=true;$('#opaya-stop').hidden=true;$('#message-input').disabled=true;$('#compose-hint').textContent=o.configured?'The setup guide is running. Close it to chat.':'Chat opens when the Opaya Agent has a model: the guide gets you one.';
      return;
    }
    $('#opaya-messages').dataset.guide='';
    $('#opaya-banner').innerHTML=!o.configured?`<div class="opaya-setup"><div class="opaya-setup-art" aria-hidden="true"><span class="opaya-mark large"><img src="assets/opaya-logo.png" alt=""><i></i></span></div><div><h2>Connect the Opaya Agent to a model.</h2><p><strong>Start free</strong>: Opaya installs Ollama and a free open model on this computer. No account, no key, nothing to type. Or use the Codex CLI, a free tier (Ollama Cloud, OpenRouter, Groq, Cerebras, Gemini) or any API: DeepSeek, OpenAI, xAI, Mistral, LM Studio or OpenAI-compatible. API keys stay in the OS keychain.</p><ul class="opaya-abilities"><li><strong>Install</strong> Hermes, Claude Code, Codex, OpenClaw and more, here or on a VPS</li><li><strong>Maintain</strong> connections, machines and SSH keys</li><li><strong>Troubleshoot</strong> agents that do not connect or answer</li></ul><div class="opaya-setup-actions"><button class="primary" data-action="opaya-free">Start free &#8594;</button><button class="secondary" data-action="opaya-config">Connect a model</button><button class="secondary" data-action="install-catalog">Install agents without the assistant</button></div></div></div>`:o.error&&!o.busy?`<div class="inline-notice error-notice"><span>!</span><div><strong>The last request failed</strong><p>${esc(o.error)}</p><button class="text-button" data-action="opaya-config">Model settings</button></div></div>`:'';
    const list=$('#opaya-messages'),atBottom=list.scrollHeight-list.scrollTop-list.clientHeight<110,now=performance.now();
    if(opayaCount<0)o.messages.forEach(m=>opayaSeen.set(m.id,-1e9));opayaCount=o.messages.length;
    const live=o.live||{content:'',activity:[],status:'streaming'};live.status='streaming';
    const busyRow=o.busy?`<article class="message assistant-message"><div class="message-avatar opaya-avatar"><span class="opaya-mark"><img src="assets/opaya-logo.png" alt=""><i></i></span></div><div class="message-body"><div class="message-meta"><strong>Opaya Agent</strong><span class="stream-label"><span class="status-dot working"></span> ${esc(o.status||'Working')}</span></div>${activityMarkup(live)}<div class="message-text">${format(live.content)}${!live.content?'<div class="thinking-dots"><i></i><i></i><i></i></div>':''}</div></div></article>`:'';
    list.innerHTML=o.messages.length||o.busy?o.messages.map(m=>`<article class="message ${m.role==='user'?'user-message':'assistant-message'} ${fresh(opayaSeen,m.id,now,450)?'message-enter':''}"><div class="message-avatar ${m.role==='user'?'you-avatar':'opaya-avatar'}">${m.role==='user'?'S':'<span class="opaya-mark"><img src="assets/opaya-logo.png" alt=""></span>'}</div><div class="message-body"><div class="message-meta"><strong>${m.role==='user'?'You':'Opaya Agent'}</strong><time>${esc(new Date(m.createdAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}))}</time></div>${activityMarkup(m)}<div class="message-text">${format(m.content)}</div>${m.role!=='user'?agentFiles(m.content,{id:'opaya',transport:'local',command:''}):''}${m.error?`<div class="message-error">${esc(m.error)}</div>`:''}</div></article>`).join('')+busyRow:o.configured?`<div class="chat-empty"><span class="agent-avatar large opaya-avatar"><span class="opaya-mark"><img src="assets/opaya-logo.png" alt=""><i></i></span></span><h2>How can I help with your agents?</h2><p>I can install frameworks, connect agents, manage machines and SSH keys, and find out why an agent is not working.</p><div class="starter-prompts">${OPAYA_STARTERS.map(([label,text])=>`<button data-action="opaya-starter" data-text="${esc(text)}">${esc(label)} <span>&#8599;</span></button>`).join('')}</div></div>`:'';
    if(atBottom||o.busy)list.scrollTop=list.scrollHeight;
    const send=$('#opaya-send');send.disabled=!o.configured||o.busy;send.hidden=!!o.busy;$('#opaya-stop').hidden=!o.busy;$('#message-input').disabled=!o.configured;
    $('#compose-hint').textContent=o.busy?(o.status||'Working'):o.configured?`${o.presets?.[o.config.preset]?.label||'Model'}${o.config.model?' / '+o.config.model:''}`:'Connect a model to start';
  }
  async function sendOpaya(){
    const input=$('#message-input'),text=input?.value.trim();if(!text||opaya().busy)return;
    await action(async()=>{await api.opayaSend({text});opayaDraft='';input.value='';input.style.height='auto';});
  }
  // The key button: the user gives the Opaya Agent a key, token or password. It goes straight into Opaya's vault and the
  // message box gets only its reference, so neither the model nor the saved chat ever has the value. Held secrets are
  // listed here and can be inserted again or forgotten.
  // New keys ask for a name and the key; an endpoint only when the user ticks that this API needs one.
  const endpointFields=()=>`<label class="check-row"><input type="checkbox" name="hasEndpoint"> This API needs an endpoint <small>For an OpenAI-compatible provider or a self-hosted API. Saved next to the key as NAME_BASE_URL (OPENROUTER_API_KEY gets OPENROUTER_BASE_URL).</small></label><label class="field" data-endpoint hidden><span>Endpoint (base URL)</span><input name="endpoint" type="url" autocomplete="off" spellcheck="false" maxlength="2048" placeholder="https://openrouter.ai/api/v1"></label>`;
  function bindEndpoint(form){const box=form.elements.hasEndpoint,field=form.querySelector('[data-endpoint]');if(!box||!field)return;box.addEventListener('change',()=>{field.hidden=!box.checked;form.elements.endpoint.required=box.checked;if(box.checked)form.elements.endpoint.focus();});}
  const endpointOf=form=>form.elements.hasEndpoint?.checked?form.elements.endpoint.value.trim():'';
  // ---- Opaya Vault: every key Opaya keeps, who has each one, and the agents' own connection tokens ------------------
  // Keys first, each with the agents it was given to; Give to opens the agents right under the key. Add a key and
  // Import (a .env or any text file, pasted text, or the tools on this computer) open above the list. From the Opaya
  // Agent's key button (chat) each key also has Insert, and a new key is inserted as a reference.
  // Keys pasted as text into an Opaya chat are temporary and not listed; everything given here stays until forgotten.
  // Keys, skills and MCP servers are shared by every agent: their windows carry the same tabs, so they read as one place
  // (the Library), opened from the sidebar's Vault or Skills & tools.
  const libTabs=active=>`<nav class="lib-tabs" aria-label="Library">${[['keys','vault','Keys',AN_ICON.access],['skills','library','Skills',AN_ICON.library],['mcp','mcp-manage','MCP servers',AN_ICON.mcp]].map(([k,act,label,icon])=>`<button type="button" class="lib-tab ${k===active?'active':''}" data-action="${act}" ${k===active?'aria-current="page"':''}>${icon}<span>${label}</span></button>`).join('')}<span class="lib-tabs-note">Shared by all your agents</span></nav>`;
  const vault={chat:false,panel:'',open:'',scan:null,paste:false,filter:'',fresh:new Set(),giveTo:'keep'};
  const vaultKeys=()=>(opaya().secrets||[]).filter(k=>k.kept||k.global||k.stored?.length);
  // The agents a key was saved for, by id (older records by name); agents removed since are left out.
  const keyHolders=k=>{const ids=new Set();for(const x of k.stored||[]){const a=x.agentId?state.agents.find(y=>y.id===x.agentId):state.agents.find(y=>y.name===x.agent);if(a)ids.add(a.id);}return ids;};
  const KEY_SVG='<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M16 7l3 3M19 4l2 2"/></svg>';
  function openVault({chat=false,panel=''}={}){
    Object.assign(vault,{chat,panel,open:'',scan:null,paste:false,filter:'',fresh:new Set()});
    modal('Opaya Vault','Your API keys, tokens and passwords, kept by Opaya and given to the agents you choose. Values are never shown here or sent into a chat.',`${libTabs('keys')}<div id="vault" class="vault"></div>`,true);
    const box=$('#vault');drawVault();
    box.addEventListener('click',vaultClick);box.addEventListener('input',vaultInput);box.addEventListener('change',vaultInput);
    box.addEventListener('submit',vaultSubmit);
    // A file dropped anywhere on the Vault is scanned for keys.
    const dlg=$('#app-dialog');
    dlg.addEventListener('dragover',event=>{if([...event.dataTransfer?.types||[]].includes('Files')){event.preventDefault();box.classList.add('drop-over');}});
    dlg.addEventListener('dragleave',event=>{if(!dlg.contains(event.relatedTarget))box.classList.remove('drop-over');});
    dlg.addEventListener('drop',event=>{const f=event.dataTransfer?.files?.[0];box.classList.remove('drop-over');if(!f)return;event.preventDefault();const file=api.pathForFile?.(f)||'';if(!file){toast('Opaya could not read where that file is. Use Import > From a file.',true);return;}vaultScan({file},`Reading ${f.name}...`);});
  }
  function drawVault(){
    const box=$('#vault');if(!box)return;const held=vaultKeys(),targets=state.agents.filter(a=>!a.ephemeral),q=vault.filter.trim().toLowerCase(),shown=held.filter(k=>!q||k.name.toLowerCase().includes(q));
    const tokens=state.agents.filter(a=>a.hasToken);
    const row=k=>{const has=keyHolders(k),open=vault.open===k.id,who=[...has].map(id=>state.agents.find(a=>a.id===id));
      return `<article class="vk ${open?'open':''} ${vault.fresh.has(k.name)?'fresh':''}" data-secret="${esc(k.id)}">
        <span class="vk-icon">${KEY_SVG}</span>
        <div class="vk-main"><div class="vk-title"><strong>${esc(k.name)}</strong><code>${esc(k.mask)}</code>${k.global?'<em class="vault-badge" title="Given to every agent that reads keys">all agents</em>':''}</div>
          <div class="vk-who">${who.length?`<span class="vk-avatars">${who.map(a=>`<span title="${esc(title(a))} has it">${badge(a)}</span>`).join('')}</span><small>${esc(who.map(a=>title(a)).join(', '))}</small>`:'<small>Not given to any agent yet</small>'}${k.endpoint?`<small class="vk-endpoint">Endpoint ${esc(k.endpoint)}</small>`:''}</div></div>
        <div class="vk-actions">${vault.chat?'<button type="button" class="secondary small" data-vault="insert" title="Put its reference into your message to the Opaya Agent">Insert</button>':''}${targets.length?`<button type="button" class="secondary small" data-vault="give-open" aria-expanded="${open}">Give to&#8230;</button>`:''}<button type="button" class="icon-button vk-forget" data-vault="forget" title="Forget ${esc(k.name)}" aria-label="Forget ${esc(k.name)}">&#10005;</button></div>
        ${open?`<div class="vk-give" role="group" aria-label="Give ${esc(k.name)} to"><p>Opaya writes it where each agent reads keys and tells it the name, never the value.</p><div class="vk-agents">${targets.map(a=>{const h=has.has(a.id);return `<button type="button" class="vk-agent ${h?'has':''}" data-vault="give" data-agent="${esc(a.id)}" title="${esc(h?`${title(a)} has it. Click to save it again.`:`Give ${k.name} to ${title(a)}`)}">${badge(a)}<span><strong>${esc(title(a))}</strong><small>${h?'&#10003; Has it':esc(placeText(a))}</small></span></button>`;}).join('')}<button type="button" class="vk-agent all" data-vault="all" title="Write it into every agent that reads keys"><span class="vk-all-icon" aria-hidden="true">&#8734;</span><span><strong>Every agent</strong><small>Now and each that reads keys</small></span></button></div></div>`:''}
      </article>`;};
    const empty=!held.length&&!vault.panel?`<div class="vault-empty"><span class="vault-empty-icon">${KEY_SVG}</span><h3>The vault is empty</h3><p>Add a key, or import the ones you already have: from a .env or any text file, or from the tools and agents on this computer.</p><div><button type="button" class="primary" data-vault="panel" data-panel="import">Import keys</button><button type="button" class="secondary" data-vault="panel" data-panel="add">+ Add a key</button></div></div>`:'';
    // Backed up? Keys added after the last backup are not in it.
    const bk=opaya().vaultBackup,newest=held.reduce((m,k)=>Math.max(m,Date.parse(k.createdAt||0)||0),0),stale=held.length&&(!bk||Date.parse(bk.at)<newest);
    const backupChip=held.length?`<button type="button" class="vault-backup-state ${stale?'warn':'ok'}" data-vault="panel" data-panel="backup" title="${esc(bk?`Last backup ${whenText(bk.at)}: ${bk.count} keys in ${bk.file}`:'No backup of the Vault yet')}">${stale?(bk?'&#9888; New keys since the last backup':'&#9888; Not backed up'):`&#10003; Backed up ${esc(ago(bk.at))} ago`}</button>`:'';
    box.innerHTML=`<div class="vault-bar"><div class="vault-sum"><strong>${held.length}</strong> key${held.length===1?'':'s'} <span>${state.secureStorage===false?'kept in memory until Opaya closes (no OS encryption here)':'encrypted by your OS'}</span>${backupChip}</div>${held.length>5?`<input type="search" class="vault-filter" data-vault-filter placeholder="Filter keys" aria-label="Filter keys" value="${esc(vault.filter)}">`:''}<button type="button" class="secondary small ${vault.panel==='import'?'active':''}" data-vault="panel" data-panel="import" aria-expanded="${vault.panel==='import'}">&#8615; Import</button><button type="button" class="secondary small ${vault.panel==='backup'?'active':''}" data-vault="panel" data-panel="backup" aria-expanded="${vault.panel==='backup'}">Back up &amp; restore</button><button type="button" class="primary small ${vault.panel==='add'?'active':''}" data-vault="panel" data-panel="add" aria-expanded="${vault.panel==='add'}">+ Add key</button></div>
      ${vault.panel==='add'?vaultAddForm(targets):vault.panel==='import'?vaultImportPanel():vault.panel==='backup'?vaultBackupPanel(held.length,bk):''}
      ${!vault.panel&&held.length?`<ol class="vault-steps" aria-label="How the Vault works"><li><b>1</b>Add or import your keys</li><li><b>2</b>Give each one to the agents that need it</li><li><b>3</b>Back up the Vault to a file</li></ol>`:''}
      ${empty}${held.length?`<section class="vault-keys" aria-label="Keys">${shown.map(row).join('')||'<p class="field-help">No key matches.</p>'}</section>`:''}
      ${held.length&&!vault.panel?`<label class="switch-row vault-mcp"><input type="checkbox" data-setting="vaultMcp" ${state.settings?.vaultMcp===false?'':'checked'}><span class="switch" aria-hidden="true"></span><span>Agents on this computer can ask for a key from their chat <small>(you approve each one; they get the key, never the other keys)</small></span></label>`:''}
      ${tokens.length?`<section class="vault-tokens"><h3>Connection tokens <small>${tokens.length}</small></h3><p class="field-help">Some agents are an <strong>API connection</strong> (a Hermes or OpenClaw gateway, OpenAI, OpenRouter...): Opaya talks to them over HTTP and sends this token (the API key or gateway password) with each message. It belongs to that one connection, it is not one of your Vault keys, and agents never see it. Change it in the connection's settings; Remove forgets it (the connection then works only if its API needs no token).</p>${tokens.map(a=>`<div class="vk token">${badge(a)}<div class="vk-main"><strong>${esc(title(a))}</strong><small>${esc(a.endpoint||'its API')}</small></div><div class="vk-actions"><button type="button" class="secondary small" data-action="edit" data-id="${esc(a.id)}">Change</button><button type="button" class="icon-button vk-forget" data-vault="token-remove" data-agent="${esc(a.id)}" title="Remove the token of ${esc(title(a))}" aria-label="Remove the token of ${esc(title(a))}">&#10005;</button></div></div>`).join('')}</section>`:''}
      <p class="vault-drop-hint" aria-hidden="true">Drop a file to find keys in it</p>`;
    if(vault.panel==='add'){const f=$('#vault-form');bindEndpoint(f);}
    // New keys glow once, not on every redraw.
    if(vault.fresh.size){const was=vault.fresh;setTimeout(()=>{if(vault.fresh===was)vault.fresh=new Set();},2600);}
  }
  function vaultAddForm(targets){
    const pick=vault.giveTo;
    return `<form id="vault-form" class="vault-panel vault-add"><h3>Add a key</h3><div class="form-grid"><label class="field"><span>Name <em>optional, guessed when empty</em></span><input name="name" maxlength="80" autocomplete="off" spellcheck="false" placeholder="OPENROUTER_API_KEY"></label><label class="field"><span>Key, token or password</span><input name="value" type="password" autocomplete="off" spellcheck="false" maxlength="12000" required></label></div>${endpointFields()}
      <div class="vault-give-to"><span>Then</span><div class="segmented transfer-mode" role="radiogroup" aria-label="After saving">${[['keep','Keep it in the Vault'],['some','Give to agents'],['all','Give to every agent']].map(([v,l])=>`<label class="${pick===v?'selected':''}"><input type="radio" name="giveTo" value="${v}" ${pick===v?'checked':''}>${l}</label>`).join('')}</div></div>
      ${pick==='some'?`<div class="vk-agents pick">${targets.map(a=>`<label class="vk-agent"><input type="checkbox" name="agent" value="${esc(a.id)}">${badge(a)}<span><strong>${esc(title(a))}</strong><small>${esc(placeText(a))}</small></span></label>`).join('')}</div>`:''}
      ${pick==='all'?'<p class="field-help">Opaya writes it into each agent that reads keys (Hermes, OpenClaw, DeepSeek Harness, Claude Code, Codex) and tells the connected ones.</p>':''}
      <div class="vault-add-foot"><button type="button" class="secondary" data-vault="panel" data-panel="">Cancel</button><button type="submit" class="primary">${vault.chat?'Save and insert':'Save key'}</button></div></form>`;
  }
  // ---- Schedules: messages Opaya sends to an agent (or the Opaya Agent) on a schedule, and agents' own cron jobs ------
  const SCH_WEEK=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  function cronOf(f){const [h,m]=(f.time||'09:00').split(':').map(Number),hm=`${m||0} ${h||0}`;
    return f.when==='hour'?`${m||0} * * * *`:f.when==='minutes'?`*/${Math.max(1,Math.min(59,Number(f.every)||15))} * * * *`:f.when==='weekdays'?`${hm} * * 1-5`:f.when==='week'?`${hm} * * ${Number(f.day)||1}`:f.when==='custom'?String(f.cron||'').trim():`${hm} * * *`;}
  function cronText(c){const p=String(c||'').trim().split(/\s+/);if(p.length!==5)return c;const [m,h,dom,mon,dow]=p,t=/^\d+$/.test(m)&&/^\d+$/.test(h)?`${h.padStart(2,'0')}:${m.padStart(2,'0')}`:'';
    if(/^\*\/\d+$/.test(m)&&h==='*'&&dom==='*'&&dow==='*')return `Every ${m.slice(2)} minutes`;if(/^\d+$/.test(m)&&h==='*'&&dom==='*'&&dow==='*')return m==='0'?'Every hour':`Every hour at :${m.padStart(2,'0')}`;
    if(t&&dom==='*'&&mon==='*'&&dow==='*')return `Every day at ${t}`;if(t&&dom==='*'&&mon==='*'&&dow==='1-5')return `Weekdays at ${t}`;if(t&&dom==='*'&&mon==='*'&&/^[0-7]$/.test(dow))return `Every ${SCH_WEEK[Number(dow)%7]} at ${t}`;return c;}
  let schedEdit=null;
  function openSchedules(focusAgent=''){
    schedEdit=null;const who=id=>id==='opaya'?'Opaya Agent':title(state.agents.find(a=>a.id===id)||{name:'Removed agent'});
    const draw=()=>{const box=$('#schedules');if(!box)return;const list=(state.schedules||[]).filter(x=>!focusAgent||x.agentId===focusAgent),talkers=state.agents.filter(a=>a.protocol!=='terminal'),e=schedEdit;
      const form=e?`<form id="sched-form" class="vault-panel sched-form"><h3>${e.id?'Edit schedule':'New schedule'}</h3>
        <div class="form-grid"><label class="field"><span>Who</span><select name="agentId"><option value="opaya" ${e.agentId==='opaya'?'selected':''}>Opaya Agent</option>${talkers.map(a=>`<option value="${esc(a.id)}" ${e.agentId===a.id?'selected':''}>${esc(title(a))}</option>`).join('')}</select></label>
        <label class="field"><span>Name <em>optional</em></span><input name="name" value="${esc(e.name||'')}" maxlength="80" placeholder="Morning lead report"></label></div>
        <label class="field"><span>What it should do</span><textarea name="prompt" rows="3" maxlength="8000" placeholder="Find 10 new SaaS leads and add them to leads.csv" required>${esc(e.prompt||'')}</textarea></label>
        <div class="sched-when"><label class="field"><span>When</span><select name="when">${[['day','Every day'],['weekdays','Weekdays'],['week','Every week on'],['hour','Every hour'],['minutes','Every few minutes'],['custom','Custom (cron)']].map(([v,l])=>`<option value="${v}" ${e.when===v?'selected':''}>${l}</option>`).join('')}</select></label>
          <label class="field sched-day" ${e.when==='week'?'':'hidden'}><span>Day</span><select name="day">${SCH_WEEK.map((d,i)=>`<option value="${i}" ${Number(e.day)===i?'selected':''}>${d}</option>`).join('')}</select></label>
          <label class="field sched-time" ${['day','weekdays','week','hour'].includes(e.when)?'':'hidden'}><span>${e.when==='hour'?'Minute':'Time'}</span><input name="time" type="time" value="${esc(e.time||'09:00')}"></label>
          <label class="field sched-every" ${e.when==='minutes'?'':'hidden'}><span>Every</span><input name="every" type="number" min="1" max="59" value="${esc(e.every||15)}"></label>
          <label class="field sched-cron" ${e.when==='custom'?'':'hidden'}><span>Cron <em>minute hour day month weekday</em></span><input name="cron" value="${esc(e.cron||'0 9 * * 1-5')}" spellcheck="false"></label></div>
        <p class="field-help">Opaya sends it while it runs (the window can be closed; the session service keeps running). Each schedule has its own chat with that agent, so you can read what it did.</p>
        <div class="vault-add-foot"><button type="button" class="secondary" data-sched="cancel">Cancel</button><button type="submit" class="primary">${e.id?'Save':'Add schedule'}</button></div></form>`:'';
      box.innerHTML=`<div class="vault-bar"><div class="vault-sum"><strong>${list.length}</strong> schedule${list.length===1?'':'s'} <span>run by Opaya</span></div><button type="button" class="primary small" data-sched="new">+ New schedule</button></div>${form}
        ${list.length?`<section class="sched-list">${list.map(x=>`<article class="sched ${x.enabled?'':'off'}" data-id="${esc(x.id)}"><div class="sched-main"><strong>${esc(x.name)}</strong><small>${esc(who(x.agentId))} &#183; ${esc(cronText(x.cron))}${x.lastRun?` &#183; last ${esc(ago(x.lastRun))} ago: ${esc(x.lastStatus)}${x.lastError?` (${esc(x.lastError)})`:''}`:''}</small><p>${esc(x.prompt.slice(0,160))}${x.prompt.length>160?'&#8230;':''}</p></div>
          <div class="sched-actions"><label class="mg-toggle" title="${x.enabled?'On':'Off'}"><input type="checkbox" data-sched-toggle ${x.enabled?'checked':''}><span class="switch" aria-hidden="true"></span></label><button type="button" class="secondary small" data-sched="run">Run now</button>${x.conversationId?'<button type="button" class="secondary small" data-sched="chat">Its chat</button>':''}<button type="button" class="secondary small" data-sched="edit">Edit</button><button type="button" class="icon-button" data-sched="remove" title="Delete" aria-label="Delete">&#10005;</button></div></article>`).join('')}</section>`:e?'':'<p class="field-help sched-empty">No schedules yet. Add one: who, what, and when.</p>'}
        <section class="sched-native"><h3>Agents' own schedules</h3><p class="field-help">What agents schedule themselves: Hermes cron jobs, OpenClaw cron and the crontab where they run.</p>
          ${state.agents.filter(a=>!focusAgent||a.id===focusAgent).filter(a=>a.protocol!=='openai').map(a=>`<div class="sched-agent" data-agent="${esc(a.id)}"><div class="sched-agent-head">${badge(a)}<strong>${esc(title(a))}</strong><small>${esc(location(a))}</small><button type="button" class="secondary small" data-sched="native">Show</button></div><pre class="sched-out" hidden></pre></div>`).join('')}</section>`;
    };
    modal('Schedules','Tasks that run on their own: Opaya sends a message to an agent on a schedule, and agents keep their own cron jobs.','<div id="schedules" class="vault schedules"></div>',true);
    const box=$('#schedules');draw();
    const formState=()=>{const f=$('#sched-form');if(!f)return;const el=f.elements;Object.assign(schedEdit,{agentId:el.agentId.value,name:el.name.value,prompt:el.prompt.value,when:el.when.value,day:el.day.value,time:el.time.value,every:el.every.value,cron:el.cron.value});};
    box.addEventListener('change',event=>{const t=event.target;
      if(t.name==='when'){formState();draw();return;}
      if(t.matches('[data-sched-toggle]')){const id=t.closest('[data-id]').dataset.id,x=state.schedules.find(y=>y.id===id);action(async()=>{await api.scheduleSave({...x,enabled:t.checked});await refresh();draw();});}});
    box.addEventListener('click',event=>{const b=event.target.closest('[data-sched]');if(!b)return;const act=b.dataset.sched,id=b.closest('[data-id]')?.dataset.id,x=id&&state.schedules.find(y=>y.id===id);
      if(act==='new'){schedEdit={agentId:focusAgent||selected()?.id||'opaya',when:'day',time:'09:00',day:1,every:15};draw();$('#sched-form [name=prompt]')?.focus();return;}
      if(act==='cancel'){schedEdit=null;draw();return;}
      if(act==='edit'&&x){const p=x.cron.split(/\s+/),simple=/^\d+$/.test(p[0])&&/^\d+$/.test(p[1])&&p[2]==='*'&&p[3]==='*';schedEdit={...x,when:simple&&p[4]==='*'?'day':simple&&p[4]==='1-5'?'weekdays':simple&&/^[0-6]$/.test(p[4])?'week':'custom',day:p[4],time:simple?`${p[1].padStart(2,'0')}:${p[0].padStart(2,'0')}`:'09:00'};draw();return;}
      if(act==='run'&&x){b.disabled=true;action(async()=>{try{await api.scheduleRun({id});await refresh();draw();toast(`Sent: ${x.name}.`);}finally{b.disabled=false;}});return;}
      if(act==='chat'&&x){closeModal();action(async()=>{if(x.agentId==='opaya'){fire('opaya');return;}await api.selectConversation?.({id:x.conversationId});await refresh();await openChat(x.agentId);});return;}
      if(act==='remove'&&x){action(async()=>{if(!await ask(`Delete the schedule ${x.name}?\n\nIts chat stays.`))return;await api.scheduleRemove({id});await refresh();draw();});return;}
      if(act==='native'){const row=b.closest('[data-agent]'),out=row.querySelector('.sched-out');b.disabled=true;b.textContent='Reading...';
        action(async()=>{try{const r=await api.agentSchedules({id:row.dataset.agent});out.hidden=false;out.textContent=r.error?`Could not read: ${r.error}`:(r.text||'').trim()||'(none)';}finally{b.disabled=false;b.textContent='Show';}});}});
    box.addEventListener('submit',event=>{event.preventDefault();formState();const e=schedEdit,cron=cronOf(e);
      action(async()=>{await api.scheduleSave({id:e.id,agentId:e.agentId,name:e.name,prompt:e.prompt,cron,enabled:e.enabled??true});schedEdit=null;await refresh();draw();toast(`Scheduled: ${cronText(cron)}.`);});});
  }
  // Back up the Vault to a file encrypted with a password the user chooses, or restore one (on this or a new computer).
  function vaultBackupPanel(count,bk){
    return `<section class="vault-panel vault-backup"><div class="vb-cols">
      <form class="vb-col" data-vault-form="backup"><h3>Back up</h3><p class="field-help">One file with your ${plural(count,'key')}, encrypted with a password you choose. With the file and the password you can restore them here or on a new computer. Opaya cannot recover a forgotten password.</p>
        <p class="vb-last ${bk?'':'none'}">${bk?`Last backup ${esc(whenText(bk.at))}: ${plural(bk.count,'key')}<br><small title="${esc(bk.file)}">${esc(bk.file)}</small>`:'No backup yet.'}</p>
        <label class="field"><span>Password <em>at least 8 characters</em></span><input name="password" type="password" minlength="8" maxlength="1024" autocomplete="new-password" required></label>
        <label class="field"><span>Repeat it</span><input name="again" type="password" maxlength="1024" autocomplete="new-password" required></label>
        <div class="vault-add-foot"><button type="submit" class="primary" ${count?'':'disabled'}>Save backup&#8230;</button></div></form>
      <form class="vb-col" data-vault-form="restore"><h3>Restore</h3><p class="field-help">Keys from an Opaya Vault backup come back into the Vault. Keys already in it are left as they are.</p>
        <div class="vb-file"><button type="button" class="secondary small" data-vault="restore-pick">Choose a backup&#8230;</button><small title="${esc(vault.restoreFile||'')}">${esc(vault.restoreFile?vault.restoreFile.split(/[\\/]/).pop():'No file chosen')}</small></div>
        <label class="field"><span>Its password</span><input name="password" type="password" maxlength="1024" autocomplete="current-password" required></label>
        <div class="vault-add-foot"><button type="submit" class="primary" ${vault.restoreFile?'':'disabled'}>Restore keys</button></div></form>
      </div><div class="vault-add-foot"><button type="button" class="secondary" data-vault="panel" data-panel="">Close</button></div></section>`;
  }
  function vaultImportPanel(){
    const s=vault.scan;
    if(s?.loading)return `<section class="vault-panel vault-import"><p class="vi-loading"><span class="status-dot working"></span> ${esc(s.loading)}</p></section>`;
    if(!s)return `<section class="vault-panel vault-import"><h3>Import keys</h3><p class="field-help">Opaya looks for keys and you choose which to keep. Values stay with Opaya and are never shown.</p>
      <div class="vi-ways"><button type="button" class="vi-way" data-vault="import-file"><span class="vi-icon file" aria-hidden="true"></span><strong>From a file</strong><small>A .env, JSON, YAML or any text file. You can also drop it here.</small></button>
      <button type="button" class="vi-way" data-vault="import-tools"><span class="vi-icon tools" aria-hidden="true"></span><strong>From my tools</strong><small>Your agents' key files, shell profiles, environment, GitHub CLI, npm, AWS and Hugging Face.</small></button>
      <button type="button" class="vi-way ${vault.paste?'active':''}" data-vault="import-paste"><span class="vi-icon paste" aria-hidden="true"></span><strong>Paste text</strong><small>The contents of a .env, or a note with keys in it.</small></button></div>
      ${vault.paste?`<form class="vi-paste" data-vault-form="paste"><textarea name="text" rows="5" spellcheck="false" autocomplete="off" placeholder="OPENAI_API_KEY=sk-...&#10;GITHUB_TOKEN=ghp_..." aria-label="Text with keys" required></textarea><div class="vault-add-foot"><button type="submit" class="primary small">Find keys</button></div></form>`:''}</section>`;
    const items=s.sources.flatMap(x=>x.items),picked=items.filter(i=>s.picked.has(i.key)).length,places=s.sources.filter(x=>x.items.length).length;
    const item=i=>{const dup=i.inVault||i.also;return `<label class="vi-item ${dup?'dup':''}"><input type="checkbox" data-vi-key="${esc(i.key)}" ${s.picked.has(i.key)?'checked':''} ${i.inVault?'disabled':''}><input class="vi-name" data-vi-name="${esc(i.key)}" value="${esc(s.names.get(i.key)??i.name)}" maxlength="80" spellcheck="false" aria-label="Name for ${esc(i.mask)}"><code>${esc(i.mask)}</code>${i.inVault?`<em>in the Vault as ${esc(i.inVault)}</em>`:i.also?`<em>same key as in ${esc(i.also)}</em>`:''}</label>`;};
    return `<section class="vault-panel vault-import"><header class="vi-head"><h3>${items.length?`Found ${plural(items.length,'key')}${places>1?` in ${places} places`:''}`:'No keys found'}</h3>${items.length?'<div><button type="button" class="text-button" data-vault="pick-all">Select all</button><button type="button" class="text-button" data-vault="pick-none">None</button></div>':''}</header>
      ${s.sources.map(x=>`<div class="vi-group"><div class="vi-src">${x.agentId&&state.agents.find(a=>a.id===x.agentId)?badge(state.agents.find(a=>a.id===x.agentId)):'<span class="vi-icon file small" aria-hidden="true"></span>'}<strong>${esc(x.label)}</strong>${x.path?`<small title="${esc(x.path)}">${esc(x.path)}</small>`:''}</div>${x.error?`<p class="vi-err">Could not read it: ${esc(x.error)}</p>`:x.items.length?x.items.map(item).join(''):'<p class="field-help">No keys in it.</p>'}</div>`).join('')}
      ${!items.length?`<p class="field-help">Opaya looks for NAME=value lines with names like API_KEY, TOKEN, SECRET or PASSWORD, and for known key formats (sk-..., ghp_..., AIza...).</p>`:''}
      <div class="vault-add-foot"><button type="button" class="secondary" data-vault="import-back">Back</button>${items.length?`<button type="button" class="primary" data-vault="import-commit" ${picked?'':'disabled'}>Import ${plural(picked,'key')}</button>`:''}</div></section>`;
  }
  async function vaultScan(input,loading){
    vault.panel='import';vault.scan={loading};drawVault();
    try{const r=await api.vaultImportScan(input);if(vault.scan?.loading!==loading)return;
      const items=r.sources.flatMap(x=>x.items);vault.scan={...r,picked:new Set(items.filter(i=>!i.inVault&&!i.also).map(i=>i.key)),names:new Map()};}
    catch(error){vault.scan=null;toast(error.message,true);}
    drawVault();
  }
  function vaultInput(event){
    const t=event.target;
    if(t.matches('[data-vault-filter]')){vault.filter=t.value;const at=t.selectionStart;drawVault();const f=$('[data-vault-filter]');if(f){f.focus();f.setSelectionRange(at,at);}return;}
    if(t.matches('[data-vi-key]')&&event.type==='change'){t.checked?vault.scan.picked.add(t.dataset.viKey):vault.scan.picked.delete(t.dataset.viKey);const b=$('[data-vault="import-commit"]');if(b){const n=vault.scan.picked.size;b.disabled=!n;b.textContent=`Import ${plural(n,'key')}`;}return;}
    if(t.matches('[data-vi-name]')){vault.scan.names.set(t.dataset.viName,t.value);return;}
    if(t.name==='giveTo'&&event.type==='change'){const f=$('#vault-form'),keep={name:f.elements.name.value,value:f.elements.value.value,endpoint:f.elements.endpoint?.value,hasEndpoint:f.elements.hasEndpoint?.checked};vault.giveTo=t.value;drawVault();const g=$('#vault-form');g.elements.name.value=keep.name;g.elements.value.value=keep.value;if(keep.hasEndpoint){g.elements.hasEndpoint.checked=true;g.elements.hasEndpoint.dispatchEvent(new Event('change'));g.elements.endpoint.value=keep.endpoint||'';}}
  }
  function vaultSubmit(event){
    const f=event.target;event.preventDefault();
    if(f.dataset.vaultForm==='paste'){const text=f.elements.text.value;f.elements.text.value='';if(text.trim())vaultScan({text},'Looking for keys in the text...');return;}
    if(f.dataset.vaultForm==='backup'){const password=f.elements.password.value,again=f.elements.again.value;
      if(password.length<8){toast('Choose a password of at least 8 characters.',true);return;}if(password!==again){toast('The two passwords are not the same.',true);f.elements.again.focus();return;}
      const b=f.querySelector('[type=submit]');b.disabled=true;
      action(async()=>{try{const r=await api.vaultBackupSave({password});if(!r)return;f.elements.password.value='';f.elements.again.value='';await refresh();drawVault();toast(`Backed up ${plural(r.count,'key')} to ${r.file}. Keep the password somewhere else than the file.`);}finally{b.disabled=false;}});return;}
    if(f.dataset.vaultForm==='restore'){const password=f.elements.password.value,file=vault.restoreFile;if(!file)return;const b=f.querySelector('[type=submit]');b.disabled=true;
      action(async()=>{try{const r=await api.vaultBackupRestore({file,password});f.elements.password.value='';vault.restoreFile='';vault.panel='';vault.fresh=new Set(r.restored.map(x=>x.name));await refresh();drawVault();
        toast(r.restored.length?`Restored ${plural(r.restored.length,'key')}${r.skipped.length?`; ${r.skipped.length} already in the Vault`:''}. Give them to your agents with Give to.`:`Nothing to restore: all ${plural(r.total,'key')} are already in the Vault.`);}finally{b.disabled=false;}});return;}
    if(f.id!=='vault-form')return;
    const value=f.elements.value.value,name=f.elements.name.value.trim(),endpoint=endpointOf(f),giveTo=vault.giveTo,agents=[...f.querySelectorAll('[name="agent"]:checked')].map(i=>i.value);
    if(giveTo==='some'&&!agents.length){toast('Choose the agents, or keep it in the Vault.',true);return;}
    f.elements.value.value='';const submit=f.querySelector('[type="submit"]');submit.disabled=true;
    action(async()=>{
      let r;try{r=await api.opayaHoldSecret({name,value,endpoint});}catch(error){submit.disabled=false;throw error;}
      await refresh();
      if(vault.chat){closeModal();vaultInsert(r.reference);if(giveTo==='all')await giveAll(r.id);else toast(`${r.name} is in the Opaya Vault; its reference is in your message.`);return;}
      vault.panel='';vault.fresh=new Set([r.name]);
      if(giveTo==='all'){await giveAll(r.id,{back:true});return;}
      const done=[];for(const id of agents){try{const g=await api.vaultGiveAgent({id:r.id,agentId:id});done.push(g.agent);}catch(error){toast(`${title(state.agents.find(a=>a.id===id)||{name:'Agent'})}: ${error.message}`,true);}}
      await refresh();drawVault();toast(done.length?`${r.name} saved for ${done.join(', ')}.`:`${r.name} is in the Opaya Vault.`);
    });
  }
  const vaultInsert=ref=>{const input=$('#message-input');if(!input||input.disabled)return;const at=input.selectionStart??input.value.length,end=input.selectionEnd??at,before=input.value.slice(0,at);input.value=before+(before&&!/\s$/.test(before)?' ':'')+ref+' '+input.value.slice(end);input.dispatchEvent(new Event('input'));input.focus();};
  function vaultClick(event){
    const b=event.target.closest('[data-vault]');if(!b)return;const what=b.dataset.vault,rowEl=b.closest('[data-secret]'),k=rowEl&&vaultKeys().find(x=>x.id===rowEl.dataset.secret);
    if(what==='panel'){const p=b.dataset.panel;vault.panel=vault.panel===p?'':p;if(vault.panel!=='import'){vault.scan=null;vault.paste=false;}drawVault();if(vault.panel==='add')$('#vault-form')?.elements.value.focus();return;}
    if(what==='import-file'){api.pickSecretFile?.().then(file=>{if(file)vaultScan({file},`Reading ${file.split(/[\\/]/).pop()}...`);},error=>toast(error.message,true));return;}
    if(what==='token-remove'){const ag=state.agents.find(x=>x.id===b.dataset.agent);if(ag)action(async()=>{if(!await ask(`Remove the token of ${title(ag)}?\n\nOpaya forgets the key it sends to ${ag.endpoint||'this API'}. ${title(ag)} disconnects and works again only with a new token (Change) or if its API needs none.`))return;await api.tokenRemove({id:ag.id});await refresh();drawVault();toast(`The token of ${title(ag)} is removed.`);});return;}
    if(what==='restore-pick'){api.pickVaultBackup?.().then(file=>{if(file){vault.restoreFile=file;drawVault();$('[data-vault-form="restore"] [name=password]')?.focus();}},error=>toast(error.message,true));return;}
    if(what==='import-tools'){vaultScan({tools:true},'Looking at your agents and tools...');return;}
    if(what==='import-paste'){vault.paste=!vault.paste;drawVault();$('.vi-paste textarea')?.focus();return;}
    if(what==='import-back'){vault.scan=null;drawVault();return;}
    if(what==='pick-all'||what==='pick-none'){for(const i of vault.scan.sources.flatMap(x=>x.items))if(!i.inVault){what==='pick-all'?vault.scan.picked.add(i.key):vault.scan.picked.delete(i.key);}drawVault();return;}
    if(what==='import-commit'){const s=vault.scan,picks=[...s.picked].map(key=>({key,name:(s.names.get(key)??s.sources.flatMap(x=>x.items).find(i=>i.key===key)?.name??'').trim()}));b.disabled=true;b.textContent='Importing...';
      action(async()=>{let r;try{r=await api.vaultImportCommit({id:s.id,picks});}catch(error){b.disabled=false;b.textContent='Import';throw error;}
        await refresh();vault.scan=null;vault.panel='';vault.fresh=new Set(r.imported.map(x=>x.name));drawVault();
        toast(r.imported.length?`Imported ${plural(r.imported.length,'key')}${r.skipped.length?`; ${r.skipped.length} skipped (${r.skipped.map(x=>`${x.name}: ${x.why}`).join(', ')})`:''}. Give them to your agents with Give to.`:`Nothing imported: ${r.skipped.map(x=>`${x.name}: ${x.why}`).join(', ')||'no keys chosen'}.`,!r.imported.length);});return;}
    if(!k)return;
    if(what==='insert'){closeModal();vaultInsert(k.reference);return;}
    if(what==='give-open'){vault.open=vault.open===k.id?'':k.id;drawVault();return;}
    if(what==='all'){action(()=>giveAll(k.id,{back:true}));return;}
    if(what==='give'){const agentId=b.dataset.agent;b.disabled=true;b.classList.add('busy');
      action(async()=>{try{const r=await api.vaultGiveAgent({id:k.id,agentId});await refresh();drawVault();toast(`${r.name} saved for ${r.agent}${r.file?` in ${r.file}`:''}. Send the note from its chat so it knows.`);}finally{b.disabled=false;b.classList.remove('busy');}});return;}
    if(what==='forget')action(async()=>{if(!await ask(`Forget ${k.name} (${k.mask})?\n\nOpaya removes it from its vault. Agents it was saved for keep their copy.`))return;await api.opayaForgetSecret({id:k.id});await refresh();drawVault();toast(`${k.name} forgotten.`);});
  }
  // A global key: Opaya writes it for every agent it can and shows where it went and what was skipped.
  async function giveAll(id,{back=false}={}){
    toast('Giving the key to every agent...');
    const r=await api.opayaGiveAll({id});
    const list=(items,fn)=>items.map(x=>`<div class="secret-row"><span><strong>${esc(x.agent)}</strong> <small>${esc(fn(x))}</small></span></div>`).join('');
    modal(`${r.name} is global`,`${r.stored.length} agent${r.stored.length===1?'':'s'} got it${r.told?`, ${r.told} connected agent${r.told===1?' was':'s were'} told in its chat`:''}. Agents that were not connected learn about it when you send the note from their chat (key button) or when they read their env.`,`<div class="secret-list">${r.stored.length?`<p class="field-help">Saved</p>${list(r.stored,x=>`${x.file||''} ${x.where}`.trim())}`:''}${r.skipped.length?`<p class="field-help">Skipped</p>${list(r.skipped,x=>x.reason)}`:''}</div><div class="modal-footer"><span>The value never went into a chat or a command line.</span>${back?'<button type="button" class="primary" data-action="vault">Back to the Vault</button>':'<button type="button" class="primary" data-action="modal-close">Done</button>'}</div>`);
  }
  // The key button in an agent's chat: Opaya saves the key where this agent reads keys (its .env, Claude Code's
  // settings, Codex's login, or its API token) and then tells the agent in the chat what was added and where. The value
  // goes from the password field to Opaya's vault and the file; the chat only gets the note.
  function openAgentSecret(a){
    const where={hermes:'the .env of its Hermes home',openclaw:'OpenClaw\'s .env (in its container when it runs in Docker)',claude:'env in Claude Code\'s settings.json',codex:'Codex\'s .env (an OpenAI key signs Codex in instead)'}[a.provider]||(a.install?.framework==='dsh'?'DeepSeek Harness\'s key store (~/.dsh/.credentials.yaml, and ~/.dsh/.env for its tools)':'')||(a.protocol==='openai'?'the API token Opaya sends when it connects':'');
    modal(`Give ${title(a)} a secret`,`An API key, token or password. Opaya keeps it in its encrypted vault, writes it into ${where||'the place this agent reads keys'}${a.transport==='ssh'?' on its machine':''}, and then tells the agent in this chat which variable was added and where. The value never goes into the chat.`,`<form id="agent-secret-form"><label class="field"><span>Variable name <em>optional, guessed when empty</em></span><input name="name" maxlength="80" autocomplete="off" spellcheck="false" placeholder="OPENROUTER_API_KEY"></label><label class="field"><span>Key, token or password</span><input name="value" type="password" autocomplete="off" spellcheck="false" maxlength="12000" required></label>${endpointFields()}<label class="check-row"><input type="checkbox" name="tell" checked> Tell ${esc(title(a))} about it in this chat <small>Sends a short note with the variable name and the file, never the value. When you have a message typed, the note goes in front of it and you send it.</small></label><div class="modal-footer"><button type="button" class="text-button" data-action="vault" title="Every key Opaya keeps, and which agents have it">Open Opaya Vault &#8594;</button><div><button type="button" class="secondary" data-action="modal-close">Cancel</button><button type="submit" class="primary">Save for ${esc(title(a))}</button></div></div></form>`);
    const form=$('#agent-secret-form');bindEndpoint(form);form.elements.name.focus();
    form.onsubmit=event=>{event.preventDefault();const value=form.elements.value.value,name=form.elements.name.value.trim(),tell=form.elements.tell.checked;form.elements.value.value='';
      const submit=form.querySelector('[type="submit"]');submit.disabled=true;submit.textContent='Saving...';
      action(async()=>{
        let r;try{r=await api.agentGiveSecret({agentId:a.id,name,value,endpoint:endpointOf(form)});}catch(error){submit.disabled=false;submit.textContent=`Save for ${title(a)}`;throw error;}
        closeModal();toast(`${r.name} saved for ${title(a)}${r.file?` in ${r.file}`:''}.`);
        if(tell)await tellAgent(a,r.note);
      });
    };
  }
  // The note about a new key goes into the agent's chat: sent at once when nothing is typed, else put in front.
  async function tellAgent(a,note){
    if(!note)return;
    // No full chat open for this agent (its management screen, say): the note goes to its chat window.
    const input=selected()?.id===a.id?$('#message-input'):null;if(!input){await dockTell(a,note);return;}const typed=input.value.trim();
    input.value=note+(typed?'\n\n'+input.value:'');input.dispatchEvent(new Event('input'));
    if(!typed&&selected()?.status==='connected')await sendMessage();
    else{input.focus();toast(selected()?.status==='connected'?'The note is in front of your message: send it so the agent knows.':'Connect the agent and send the note so it knows about the key.');}
  }
  // The key button in an agent's chat: the keys this agent has (names only, read from the file it reads keys from),
  // each with Insert, which puts $NAME into the message; vault keys it does not have yet, with Give; and a new key.
  async function openAgentKeys(a){
    modal(`${title(a)}'s keys`,'The API keys, tokens and passwords this agent can use. Values are never shown. Insert puts the key\'s name into your message, so you can tell the agent which one to use.','<div id="agent-keys"><p class="field-help">Reading its keys...</p></div>',true);
    let r;try{r=await api.agentKeys({agentId:a.id});}catch(error){const box=$('#agent-keys');if(box)box.innerHTML=`<p class="field-help">${esc(error.message)}</p>`;return;}
    const box=$('#agent-keys');if(!box)return;
    const keyRow=k=>`<div class="vault-row"><div class="vault-main"><strong>${esc(k.name)}</strong>${k.global?'<em class="vault-badge">global</em>':k.fromOpaya?'<em class="vault-badge">from Opaya</em>':''}${k.where?`<small>${esc(k.where)}</small>`:''}</div><div class="vault-actions"><button type="button" class="secondary docker-btn" data-keys="insert" data-name="${esc(k.name)}" title="Put $${esc(k.name)} into your message">Insert</button></div></div>`;
    const vaultRow=k=>`<div class="vault-row"><div class="vault-main"><strong>${esc(k.name)}</strong>${k.global?'<em class="vault-badge">global</em>':''}${k.endpoint?`<small>Endpoint ${esc(k.endpoint)}</small>`:''}</div><div class="vault-actions"><button type="button" class="secondary docker-btn" data-keys="give" data-id="${esc(k.id)}" title="Save it where ${esc(title(a))} reads keys and tell it">Give</button></div></div>`;
    const token=a.protocol==='openai'&&a.hasToken?`<div class="vault-row"><div class="vault-main"><strong>Connection token</strong><small>Opaya sends it to ${esc(a.endpoint||'its API')}</small></div></div>`:'';
    box.innerHTML=`<section class="docker-group"><h3>Has <small>${r.keys.length+(token?1:0)}</small></h3>${r.keys.length||token?`<div class="docker-list">${r.keys.map(keyRow).join('')}${token}</div>`:`<p class="field-help">${r.kind?`No keys yet${r.file?` in ${esc(r.file)}`:''}.`:'Opaya does not know where this agent reads keys, so it lists only its connection token.'}</p>`}${r.error?`<p class="field-help">Could not read ${esc(r.file||'its key file')}: ${esc(r.error)}</p>`:''}</section>
      ${r.vault.length&&r.kind?`<section class="docker-group"><h3>In the Opaya Vault <small>${r.vault.length}</small></h3><div class="docker-list">${r.vault.map(vaultRow).join('')}</div></section>`:''}
      <div class="modal-footer"><button type="button" class="text-button" data-action="vault">Open Opaya Vault &#8594;</button><div><button type="button" class="secondary" data-action="modal-close">Close</button><button type="button" class="primary" data-keys="new">New key</button></div></div>`;
    box.addEventListener('click',event=>{
      const b=event.target.closest('[data-keys]');if(!b)return;
      if(b.dataset.keys==='new'){openAgentSecret(a);return;}
      if(b.dataset.keys==='insert'){closeModal();const input=$('#message-input');if(!input||input.disabled)return;const ref='$'+b.dataset.name,at=input.selectionStart??input.value.length,end=input.selectionEnd??at,before=input.value.slice(0,at);input.value=before+(before&&!/\s$/.test(before)?' ':'')+ref+' '+input.value.slice(end);input.dispatchEvent(new Event('input'));input.focus();return;}
      if(b.dataset.keys==='give'){b.disabled=true;b.textContent='Saving...';
        action(async()=>{let g;try{g=await api.vaultGiveAgent({id:b.dataset.id,agentId:a.id});}finally{b.disabled=false;b.textContent='Give';}await refresh();closeModal();toast(`${g.name} saved for ${title(a)}${g.file?` in ${g.file}`:''}.`);await tellAgent(a,g.note);});}
    });
  }
  // Free local model: one click installs Ollama (if needed) and a small open model, then connects the Opaya Agent.
  async function openFreeModel(){
    let info;try{info=await api.opayaFreeModels();}catch(error){toast(error.message,true);return;}
    const have=info.installed||[];
    modal('Start free','A free, open model that runs on this computer through Ollama. No account and no API key. Opaya installs and sets up everything.',`<form id="free-form" class="mcp-form">
      <fieldset class="clone-choice"><legend>Model</legend>${info.models.map(m=>`<label class="choice-card"><input type="radio" name="model" value="${esc(m.id)}" ${m.id===info.recommended?'checked':''}><span><strong>${esc(m.label)} <em class="free-size">${have.includes(m.id)?'downloaded':esc(m.size)}</em>${m.id===info.recommended?' <em class="free-pick">best for this computer</em>':''}</strong><small>${esc(m.note)}</small></span></label>`).join('')}</fieldset>
      <p class="field-help">${have.length?'Ollama is already running here.':'Ollama (free, open source) is installed first'+(state.platform==='win32'?' with winget':state.platform==='darwin'?' with Homebrew or into your Applications folder':'')+'.'} Local models are private and cost nothing, but they are slower and less capable than large cloud models. You can switch any time in Model settings.</p>
      <div class="modal-footer"><div><button type="button" class="text-button" data-action="opaya-config">Other models and free tiers</button></div><div><button type="button" class="secondary" data-action="modal-close">Cancel</button><button class="primary" type="submit">Set up free model</button></div></div></form>`);
    const f=$('#free-form');f.onsubmit=event=>{event.preventDefault();const model=f.querySelector('[name="model"]:checked')?.value;action(async()=>{await api.opayaFreeSetup({model});closeModal();});};
  }
  function openOpayaConfig(){
    const o=opaya(),presets=o.presets||{},c=o.config||{},current=Object.hasOwn(presets,c.preset)?c.preset:'codex';
    const initial=presets[current]||{},models=[...new Set([...(initial.models||[]),c.model].filter(Boolean))];
    modal('Opaya Agent model','Run through Codex CLI or Claude Code on this computer, or connect an OpenAI-compatible provider. Models are selected from provider results.',`<form id="opaya-config-form"><div class="preset-grid">${Object.entries(presets).map(([id,p])=>`<label class="preset-option"><input type="radio" name="preset" value="${esc(id)}" ${id===current?'checked':''}><span><strong>${esc(p.label)}${p.free?` <em class="preset-free">${esc(p.free)}</em>`:''}</strong><small>${esc(p.kind==='codex'||p.kind==='claude'?'Signed-in CLI / no API key':p.baseUrl||'Any /v1 endpoint')}</small>${p.signup?`<a href="#" class="preset-signup" data-action="open-link" data-external="1" data-url="${esc(p.signup)}">Get a free key &#8599;</a>`:''}</span></label>`).join('')}</div><p class="field-help">No account? <button type="button" class="text-button" data-action="opaya-free">Start free with a local model</button>: Opaya installs everything.</p><div class="form-grid"><label class="field" data-opaya-http><span>API base URL</span><input name="baseUrl" value="${esc(c.baseUrl||initial.baseUrl||'')}" placeholder="https://.../v1"></label><label class="field"><span>Model</span><select name="model"><option value="">${current==='codex'?'Use Codex CLI default':'Test connection to load models'}</option>${models.map(m=>`<option value="${esc(m)}" ${m===c.model?'selected':''}>${esc(m)}</option>`).join('')}</select></label></div><label class="field" data-opaya-key><span>API key ${o.hasKey?'<em>stored securely</em>':''}</span><input name="apiKey" type="password" autocomplete="new-password" placeholder="${o.hasKey?'Leave empty to keep the saved key':'Not needed for local providers'}"></label><label class="check-row" data-opaya-key><input type="checkbox" name="remember" ${state.secureStorage?'checked':''}> Remember key with OS encryption <small>${state.secureStorage?'Protected by your OS keychain':'Unavailable here: the key stays in memory only'}</small></label><div class="opaya-boundary"><strong>Safety boundary</strong><p>The Opaya Agent works through Opaya's tools for installs, onboarding, connections, machines and diagnostics, and runs commands in terminals you can watch. With iTrust on it does this without asking; turn iTrust off to approve every change and command. Removing connections or machines always asks. API tokens are never sent to it. Chat and notes live in <code>${esc(o.home||'opaya-agent')}</code>.</p></div><p id="opaya-test-result" class="field-help"></p><div class="modal-footer"><div>${o.hasKey?'<button type="button" class="danger-text" data-action="opaya-forget-key">Forget saved key</button>':''}</div><div><button type="button" class="secondary" id="opaya-test">Test &amp; load models</button><button type="submit" class="primary">Save</button></div></div></form>`,true);
    const form=$('#opaya-config-form');
    const fillModels=(items,chosen='')=>{const list=[...new Set((items||[]).filter(Boolean))];form.elements.model.innerHTML=`<option value="">${form.elements.preset.value==='codex'?'Use Codex CLI default':form.elements.preset.value==='claude'?'Use Claude Code default':'Select a model'}</option>`+list.map(m=>`<option value="${esc(m)}">${esc(m)}</option>`).join('');if(list.includes(chosen))form.elements.model.value=chosen;else if(list.length)form.elements.model.value=list[0];};
    const syncPreset=(reset=false)=>{const id=form.elements.preset.value,p=presets[id]||{},codex=id==='codex'||id==='claude';form.querySelectorAll('[data-opaya-http],[data-opaya-key]').forEach(el=>el.hidden=codex);form.elements.baseUrl.required=!codex;form.elements.model.required=!codex;if(reset){form.elements.baseUrl.value=p.baseUrl||'';fillModels(p.models||[],p.model||'');}};
    form.addEventListener('change',event=>{if(event.target.name==='preset')syncPreset(true);});
    syncPreset(false);
    const values=()=>({preset:form.elements.preset.value,baseUrl:form.elements.baseUrl.value.trim(),model:form.elements.model.value.trim(),apiKey:form.elements.apiKey.value,remember:form.elements.remember.checked});
    $('#opaya-test').onclick=()=>action(async()=>{const out=$('#opaya-test-result');out.textContent='Testing...';try{const selected=form.elements.model.value,r=await api.opayaTest(values());out.textContent=r.message;fillModels(r.models,selected); }catch(e){out.textContent=e.message;}});
    form.addEventListener('submit',event=>{event.preventDefault();action(async()=>{await api.opayaSaveConfig(values());closeModal();opayaView=true;overview=false;render();saveView();toast('Opaya Agent is ready.');});});
  }
  // ---- Update checks: installed agents and tools per machine, with newer versions -----------------------------------
  const toolMachines=()=>Object.entries(state.toolUpdates?.machines||{}).map(([key,m])=>({key,...m})).sort((a,b)=>a.key==='local'?-1:b.key==='local'?1:a.name.localeCompare(b.name));
  const outdatedTools=()=>toolMachines().flatMap(m=>(m.items||[]).filter(i=>i.outdated).map(i=>({...i,machine:m.name,hostId:m.hostId})));
  const toolFor=(hostId,id)=>(state.toolUpdates?.machines?.[hostId||'local']?.items||[]).find(i=>i.id===id);
  const versionText=i=>`${i.installed}${i.outdated&&i.latest?` &#8594; <b>${esc(i.latest)}</b>`:''}${i.note?` <small>(${esc(i.note)})</small>`:''}`;
  function openToolUpdates(){
    const machines=toolMachines(),out=outdatedTools();
    for(const i of out)tipsSeen.add(`upd:${i.hostId||'local'}/${i.id}/${i.latest||'git'}`);saveView();if($('#opaya-nudge')&&String(nudgeId).startsWith('upd:'))$('#opaya-nudge').remove();
    // Tick several (the outdated ones start ticked) and run them as one batch; the method shows what an update will use.
    const updatable=i=>(state.frameworks||[]).some(f=>f.id===i.id),picks=m=>(m.items||[]).filter(i=>i.outdated&&updatable(i)).length;
    const pick=i=>updatable(i)?`<input type="checkbox" class="tool-pick" data-id="${esc(i.id)}" aria-label="Select ${esc(i.name)}" ${i.outdated?'checked':''}>`:'<span class="tool-pick"></span>';
    const rows=m=>(m.items||[]).map(i=>`<div class="tool-row ${i.outdated?'outdated':''}">${pick(i)}<span class="tool-name">${esc(i.name)}${i.dependency?' <small>dependency</small>':''}${i.how&&i.method!=='none'?` <small class="tool-how" title="${esc(i.path||'')}">${esc(i.how)}</small>`:''}</span><span class="tool-version">${versionText(i)}</span>${i.outdated?`<button type="button" class="secondary" data-action="tool-update" data-id="${esc(i.id)}" data-host="${esc(m.hostId||'')}">Update</button>`:`<span class="tool-ok">${i.latest?'Up to date':'Installed'}</span>`}</div>`).join('')||'<p class="field-help">Nothing found yet.</p>';
    modal('Updates',out.length?`${out.length} update${out.length===1?'':'s'} available`:'Everything checked is up to date',`${machines.length?machines.map(m=>`<section class="tool-machine"><h3>${esc(m.name)} <small>${m.checkedAt?`checked ${esc(new Date(m.checkedAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}))}`:''}</small>${(m.items||[]).some(updatable)?`<button type="button" class="secondary" data-action="tool-update-selected" data-host="${esc(m.hostId||'')}" ${picks(m)?'':'disabled'}>Update selected (${picks(m)})</button>`:''}${(m.items||[]).some(i=>i.outdated)?`<button type="button" class="primary" data-action="tool-update" data-id="outdated" data-host="${esc(m.hostId||'')}">Update all here</button>`:''}</h3>${m.error?`<p class="field-help">Could not check: ${esc(m.error)}</p>`:''}${rows(m)}</section>`).join(''):'<p class="field-help">Opaya checks this computer and every machine with an agent once an hour.</p>'}
      <div class="modal-footer"><span>Checked every hour. Change this in Settings.</span><button type="button" class="secondary" data-action="tool-check" ${state.toolUpdates?.checking?'disabled':''}>${state.toolUpdates?.checking?'Checking...':'Check now'}</button></div>`,true);
    $('#app-dialog')?.addEventListener('change',e=>{
      const box=e.target.closest?.('.tool-pick'),section=box?.closest('.tool-machine');if(!section)return;
      const n=section.querySelectorAll('input.tool-pick:checked').length,button=section.querySelector('[data-action="tool-update-selected"]');
      if(button){button.textContent=`Update selected (${n})`;button.disabled=!n;}
    });
  }
  function renderToolChip(){
    const chip=$('#status-tools');if(!chip)return;const n=outdatedTools().length;
    chip.hidden=!n;if(n)chip.textContent=`${n} update${n===1?'':'s'} available`;
  }
  // Notices from the service: update checks, automatic fixes, and fixes that need the user.
  api.onOpen?.(target=>action(async()=>{
    closeModal();
    if(target?.opaya){overview=false;playgroundView=false;opayaView=true;manageId='';render();saveView();return;}
    if(!state.agents.some(a=>a.id===target?.agentId))return;
    // A reply opens in the agent's chat window, over whatever screen is open.
    const a=state.agents.find(x=>x.id===target.agentId);await openChatWindow(a,state.conversations.some(c=>c.id===target.conversationId&&c.agentId===a.id)?target.conversationId:'');
  }));
  api.onNotice?.(n=>{
    if(n.kind==='updates'){renderToolChip();return;}
    if(n.kind==='surface'){stageAgent='';if(n.agentId&&agentModes.get(n.agentId)==='chat')agentModes.set(n.agentId,'console');refresh().catch(()=>{});}
    if(n.level!=='error'){toast(n.text?`${n.title}. ${n.text}`:n.title);return;}
    document.getElementById('opaya-nudge')?.remove();
    const card=document.createElement('div');card.id='opaya-nudge';card.className='opaya-nudge urgent-notice';card.setAttribute('role','alert');
    card.innerHTML=`<span class="opaya-mark small" aria-hidden="true"><img src="assets/opaya-logo.png" alt=""><i></i></span><div><strong>${esc(n.title)}</strong><p class="notice-error">${esc(n.text)}</p><div class="nudge-actions"><button type="button" class="text-button" data-notice="copy">Copy error</button>${n.agentId?'<button type="button" class="text-button" data-notice="log">Connection log</button>':''}${n.prompt?'<button type="button" class="text-button" data-notice="ask">Ask the Opaya Agent</button>':'<button type="button" class="text-button" data-notice="opaya">Opaya Agent</button>'}<button type="button" class="text-button" data-notice="close">Close</button></div></div>`;
    card.addEventListener('click',e=>{const b=e.target.closest('[data-notice]');if(!b)return;const act=b.dataset.notice;
      if(act==='copy'){action(()=>api.clipboardWrite({text:`${n.title}\n\n${n.text}`}));toast('Error copied.');return;}
      if(act==='log')openDiagnostics(n.agentId);
      if(act==='opaya'){overview=false;playgroundView=false;opayaView=true;render();saveView();}
      // Updates that failed: the service wrote the hand-off (secrets hidden); the user sends it with this button.
      if(act==='ask'){action(async()=>{await api.opayaSend({text:n.prompt});overview=false;playgroundView=false;opayaView=true;render();saveView();});}
      card.classList.add('leaving');setTimeout(()=>card.remove(),220);});
    document.body.append(card);
  });
  // ---- Install catalog ----------------------------------------------------------------------------------------
  function openInstall(hostId='',fetched=false){
    const all=state.frameworks||[],host=state.hosts.find(h=>h.id===hostId);
    // What is already installed there decides the button: Install, Update, or installed and up to date.
    if(!fetched)api.toolVersions({hostId:hostId||undefined}).then(async()=>{await refresh();if($('#install-grid-root')?.dataset.host===(hostId||''))openInstall(hostId,true);}).catch(()=>{});
    const checked=!!state.toolUpdates?.machines?.[hostId||'local']?.checkedAt;
    const essentials=['node','python','git','uv',...(state.platform==='win32'&&!host?[]:['tmux'])];
    const actionFor=(f,ok)=>{
      if(!ok)return `<button class="subtle" disabled title="Not available for this system.">Not on this system</button>`;
      if(f.kind==='bundle'){
        const missing=essentials.filter(id=>!toolFor(hostId,id)),old=essentials.map(id=>toolFor(hostId,id)).filter(i=>i?.outdated);
        if(checked&&!missing.length)return old.length?`<button class="primary" data-action="tool-update" data-id="outdated" data-host="${esc(hostId)}">Update ${old.length}</button>`:'<span class="install-state">All installed</span>';
        return `<button class="primary" data-action="install-framework" data-id="${esc(f.id)}" data-host="${esc(hostId)}">${checked?`Install ${missing.length} missing`:'Install'}</button>`;
      }
      const v=toolFor(hostId,f.id);
      if(v)return v.outdated?`<button class="primary" data-action="tool-update" data-id="${esc(f.id)}" data-host="${esc(hostId)}" title="${esc(`${v.installed} installed`)}">Update to ${esc(v.latest||'latest')}</button>`:`<span class="install-state" title="${v.latest?'The newest version':'Installed'}">Installed ${esc(v.installed)}</span><button class="subtle" data-action="install-recheck" data-host="${esc(hostId)}">Check for update</button>`;
      return `<button class="${f.kind==='bundle'?'primary':'secondary'}" data-action="install-framework" data-id="${esc(f.id)}" data-host="${esc(hostId)}">Install</button>`;
    };
    const card=f=>{const ok=host?f.remote:f.local;const logo=f.icon&&ICONS[f.icon]?iconImg(ICONS[f.icon][1]):f.kind==='dependency'||f.kind==='bundle'?`<span class="dep-glyph">${esc(f.kind==='bundle'?'✦':f.name.slice(0,2))}</span>`:'<span class="mark custom-mark"><i></i></span>';
      return `<article class="install-card ${ok?'':'unavailable'} ${f.kind}"><div class="install-card-top"><span class="agent-avatar large ${esc(f.provider)} ${f.icon?'':'no-logo'}">${logo}</span><div><h3>${esc(f.name)}</h3>${f.requires?`<small>Requires ${esc(f.requires)}</small>`:f.runtime?'<small>Model runtime</small>':f.kind==='dependency'?'<small>Dependency</small>':''}</div></div><p>${esc(f.description)}</p><div class="install-card-actions">${actionFor(f,ok)}</div></article>`;};
    const section=(label,items,note='')=>items.length?`<h3 class="install-section">${label}${note?`<small>${note}</small>`:''}</h3><div class="install-grid">${items.map(card).join('')}</div>`:'';
    modal('Install an agent.',host?`Installs on ${host.name} over SSH, in a visible terminal.`:'Installs on this computer, in a visible terminal. You see the exact command first.',`<div class="install-target"><span>Install on</span><button class="target-chip ${host?'':'selected'}" data-action="install-target" data-id="">This computer</button>${state.hosts.map(h=>`<button class="target-chip ${h.id===hostId?'selected':''}" data-action="install-target" data-id="${esc(h.id)}">${esc(h.name)}</button>`).join('')}<button class="target-chip add" data-action="hosts">+ Machine</button></div>${section('Start here',all.filter(f=>f.kind==='bundle'),'Installs only what is missing')}${section('Agents',all.filter(f=>f.kind==='agent'))}${section('Dependencies',all.filter(f=>f.kind==='dependency'),'Each one skips itself when already installed')}<div class="modal-note" id="install-grid-root" data-host="${esc(hostId)}"><span class="status-dot ${checked?'connected':'working'}"></span> ${checked?'Installed tools show their version; update them here.':'Checking what is installed...'} After an install, run Discover to add the agent, or ask the Opaya Agent to do it for you.</div>`,true);
  }
  // On a machine, an agent can go in as a regular install or as a Docker container; the user chooses first.
  function confirmInstall(id,hostId,runtime=''){
    const f=(state.frameworks||[]).find(f=>f.id===id),host=state.hosts.find(h=>h.id===hostId);if(!f)return;
    const docs=`<a class="text-button" data-action="install-docs" data-id="${esc(f.id)}">From the official instructions</a>`;
    if(host&&f.kind==='agent'&&!runtime){
      const docker=toolFor(hostId,'docker');
      modal(`Install ${f.name} on ${host.name}`,'How should it run there?',`<div class="runtime-choice">
        <button type="button" class="runtime-option" data-action="install-runtime" data-id="${esc(f.id)}" data-host="${esc(hostId)}" data-runtime="regular"><strong>Regular install</strong><span>Installed for the SSH user, like on your own computer. Simple, shares the machine's files and tools.</span><small>${esc(f.requires?`Requires ${f.requires}`:'Official installer')}</small></button>
        <button type="button" class="runtime-option" data-action="install-runtime" data-id="${esc(f.id)}" data-host="${esc(hostId)}" data-runtime="docker" ${f.docker?'':'disabled'}><strong>Docker container</strong><span>${f.docker?'Runs isolated in its own container that restarts with the server. Its data stays in a folder in your home. Easy to remove or run several.':`${esc(f.name)} has no container install yet. Use the regular install.`}</span><small>${f.docker?docker?`Docker ${esc(docker.installed)} is installed`:state.toolUpdates?.machines?.[hostId]?'Docker is not installed there yet':'Needs Docker on the machine':'Not available'}</small></button>
      </div><div class="modal-footer">${docs}<button class="secondary" data-action="install-catalog" data-host="${esc(hostId)}">Back</button></div>`);
      return;
    }
    if(runtime==='docker'){
      const docker=toolFor(hostId,'docker'),checked=!!state.toolUpdates?.machines?.[hostId]?.checkedAt;
      modal(`Install ${f.name} in Docker`,`On ${host.name}`,`<form id="docker-install-form"><label class="field"><span>Name</span><input name="name" value="${esc(f.id.replace(/-cli$/,''))}" maxlength="40" required pattern="[A-Za-z0-9][A-Za-z0-9 _-]*"></label><p class="field-help">${f.id==='openclaw'?`The container is called opaya-&lt;name&gt; and runs the official OpenClaw image with its gateway. Its data stays in the Docker volume opaya-&lt;name&gt;-data on ${esc(host.name)}, and the gateway listens only on that server's 127.0.0.1 (Opaya reaches it through SSH). After the install you finish OpenClaw's onboarding in the terminal, then Opaya imports the gateway token, adds the agent and connects.`:`The container is called opaya-&lt;name&gt; and keeps its data in ~/${f.id==='hermes'?'opaya-hermes':'opaya-agents'}/&lt;name&gt; on ${esc(host.name)}. It restarts with the server. After the install you sign in in the terminal, then Opaya adds it as an agent and connects.`}</p>
        ${checked&&!docker?`<div class="inline-notice error-notice"><span>!</span><div><strong>Docker is not installed on ${esc(host.name)}</strong><p>Install it first, then come back.</p><button type="button" class="text-button" data-action="install-framework" data-id="docker" data-host="${esc(hostId)}">Install Docker there</button></div></div>`:''}
        <div class="modal-footer">${docs}<div><button type="button" class="secondary" data-action="install-runtime" data-id="${esc(f.id)}" data-host="${esc(hostId)}" data-runtime="">Back</button><button type="submit" class="primary">Install in Docker</button></div></div></form>`);
      $('#docker-install-form').addEventListener('submit',event=>{event.preventDefault();const name=event.target.elements.name.value.trim();action(async()=>{const job=await api.installFramework({id:f.id,hostId,runtime:'docker',name});if(job){closeModal();toast(`Installing ${f.name} in Docker on ${host.name}. Sign in in the terminal when it asks.`);}});});
      return;
    }
    const command=host?f.remoteCommand:f.localCommand;
    modal(`Install ${f.name}?`,host?`On ${host.name} over SSH`:'On this computer',`${!host&&f.builtin?`<p class="field-help">Opaya downloads the official ${esc(f.name)}, checks it against its published checksum and installs it for your user. No administrator password, and no winget, Homebrew or npm needed. It is added to your PATH, so terminals and agents find it.</p>`:`<p class="field-help">This command runs in a new terminal where you can watch it and answer prompts:</p><pre class="install-command">${esc(command)}</pre>`}${f.requires?`<p class="field-help">Requires ${esc(f.requires)}.</p>`:''}<p class="field-help">Afterwards: ${esc(f.after)}</p><div class="modal-footer">${docs}<div><button class="secondary" data-action="${host&&f.kind==='agent'?'install-runtime':'install-catalog'}" data-id="${esc(f.id)}" data-host="${esc(hostId||'')}" data-runtime="">Back</button><button class="primary" data-action="install-run" data-id="${esc(f.id)}" data-host="${esc(hostId||'')}">Run in terminal</button></div></div>`);
  }
  // ---- Icon picker ------------------------------------------------------------------------------------------
  function openIconPicker(a){
    const current=a.avatar||'';
    modal('Choose an icon',`For ${title(a)}. Only changes how it looks in Opaya.`,`<div class="icon-library"><button class="icon-choice ${current?'':'selected'}" data-action="icon-pick" data-id="${esc(a.id)}" data-value=""><span class="agent-avatar large ${esc(a.provider)}"><span class="provider-icon">${providerIcon(a.provider)}</span></span><small>Default</small></button>${Object.entries(ICONS).map(([id,[label,src]])=>`<button class="icon-choice ${current==='lib:'+id?'selected':''}" data-action="icon-pick" data-id="${esc(a.id)}" data-value="lib:${esc(id)}" title="${esc(label)}"><span class="agent-avatar large has-avatar"><span class="provider-icon">${iconImg(src)}</span></span><small>${esc(label)}</small></button>`).join('')}</div><div class="modal-footer"><label class="secondary upload-button">Upload image<input type="file" id="icon-upload" accept="image/png,image/jpeg,image/webp,image/gif" hidden></label><span class="field-help">PNG, JPEG or WebP. Resized to 128 px.</span></div>`,true);
    $('#icon-upload').addEventListener('change',event=>{const file=event.target.files?.[0];if(!file)return;if(file.size>8*1024*1024){toast('Choose an image under 8 MB.',true);return;}
      const url=URL.createObjectURL(file),img=new Image();img.onload=()=>{const c=document.createElement('canvas');c.width=c.height=128;const g=c.getContext('2d'),s=Math.min(img.width,img.height);g.drawImage(img,(img.width-s)/2,(img.height-s)/2,s,s,0,0,128,128);URL.revokeObjectURL(url);const data=c.toDataURL('image/png');action(async()=>{await api.updateAgentDisplay({id:a.id,avatar:data});closeModal();toast('Icon updated.');});};img.onerror=()=>{URL.revokeObjectURL(url);toast('That image could not be read.',true);};img.src=url;});
  }
  // ---- Window controls (frameless window on every platform) ------------------------------------------------------
  let windowState={maximized:false,fullscreen:false,focused:true};
  function renderWindowControls(){
    const box=$('#window-controls');if(!box||!api.windowControl)return;const mac=state.platform==='darwin';
    document.body.classList.toggle('frameless',true);document.body.classList.toggle('window-blurred',!windowState.focused);document.body.classList.toggle('window-fullscreen',!!windowState.fullscreen);
    const max=windowState.maximized||windowState.fullscreen;
    box.className=`window-controls ${mac?'mac':'win'}`;
    box.innerHTML=mac?`<button class="wc-close" data-window="close" aria-label="Close window" title="Close (sessions keep running)"><svg viewBox="0 0 10 10"><path d="M3 3l4 4M7 3l-4 4"/></svg></button><button class="wc-min" data-window="minimize" aria-label="Minimize" title="Minimize"><svg viewBox="0 0 10 10"><path d="M2.5 5h5"/></svg></button><button class="wc-max" data-window="fullscreen" aria-label="${windowState.fullscreen?'Exit full screen':'Full screen'}" title="${windowState.fullscreen?'Exit full screen':'Full screen'}"><svg viewBox="0 0 10 10"><path d="M3 6.5V3h3.5M7 3.5V7H3.5"/></svg></button>`:`<button data-window="minimize" aria-label="Minimize" title="Minimize"><svg viewBox="0 0 12 12"><path d="M2 6h8"/></svg></button><button data-window="maximize" aria-label="${max?'Restore':'Maximize'}" title="${max?'Restore':'Maximize'}">${max?'<svg viewBox="0 0 12 12"><path d="M3.5 4.5h4v4h-4zM5 3h4v4"/></svg>':'<svg viewBox="0 0 12 12"><rect x="2.5" y="2.5" width="7" height="7"/></svg>'}</button><button class="wc-close" data-window="close" aria-label="Close" title="Close (sessions keep running)"><svg viewBox="0 0 12 12"><path d="M3 3l6 6M9 3l-6 6"/></svg></button>`;
  }
  $('#window-controls')?.addEventListener('click',event=>{const b=event.target.closest('[data-window]');if(b)action(async()=>{windowState={...windowState,...await api.windowControl({action:b.dataset.window})};renderWindowControls();});});
  $('#topbar').addEventListener('dblclick',event=>{if(state.platform==='darwin'&&!event.target.closest('button,select,input,a'))action(()=>api.windowControl({action:'maximize'}));});
  api.onWindowState?.(value=>{windowState=value;renderWindowControls();});
  // ---- Title bar: the sidebar toggle and the chat / terminal switch, next to the window buttons ----------------------
  // The switch shows how the selected agent is open and changes it (the agent remembers it). It replaces the Terminal,
  // Chat and Open chat buttons that sat in the middle of the top bars. Right-click the terminal half for the other ways.
  // sidebarRail: the agents' sidebar as a strip of icons (its toggle at the bottom, or Settings > Sidebar) or full width.
  let sidebarHidden=false,sidebarRail=true,railAnchor=null,railMuted=null,titleHtml='';
  const TITLE_ICONS={sidebar:'<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2"/><path d="M6.25 3v10"/></svg>'};
  // The sidebar toggle lives at the bottom of the sidebar; while the sidebar is hidden, a small button in the title
  // bar brings it back (so does Ctrl/Cmd+B).
  function renderTitleControls(){
    const box=$('#title-controls');if(!box)return;const mac=state.platform==='darwin';
    const html=sidebarHidden?`<button type="button" class="title-btn" data-title="sidebar" aria-pressed="false" title="Show the sidebar (${mac?'&#8984;':'Ctrl+'}B)" aria-label="Show the sidebar">${TITLE_ICONS.sidebar}</button>`:'';
    const hide=$('.sidebar-hide-btn');if(hide)hide.title=`Hide the sidebar (${mac?'\u2318':'Ctrl+'}B)`;
    box.className=`title-controls ${mac?'mac':'win'}`;if(html!==titleHtml){titleHtml=html;box.innerHTML=html;}
    document.body.classList.toggle('sidebar-hidden',sidebarHidden);document.body.classList.toggle('sidebar-rail',sidebarRail);
    const rail=$('.sidebar-rail-btn');if(rail){rail.title=sidebarRail?'Show names':'Icons only';rail.setAttribute('aria-pressed',String(sidebarRail));const label=rail.querySelector('.rail-label');if(label)label.textContent=sidebarRail?'Show names':'Icons only';}
  }
  function toggleRail(force){sidebarRail=force??!sidebarRail;renderTitleControls();requestAnimationFrame(()=>placePanes());hideRailCard();saveView();}
  // Icons only: hovering or focusing an icon shows its card at once (no native tooltip delay). An agent's card holds its name,
  // state and the machine it runs on; any other icon shows its label. The card lives outside the scrolling list, so it is never clipped.
  const railCard=Object.assign(document.createElement('div'),{id:'rail-card',className:'rail-card',hidden:true});railCard.setAttribute('role','tooltip');document.body.append(railCard);
  const RAIL_TARGETS='.agent-nav,.brand-opaya,.nav-overview,.sidebar-bottom>button,.sidebar-section-label';
  const railTarget=el=>sidebarRail&&!sidebarHidden&&el?.closest?.('.sidebar')?el.closest(RAIL_TARGETS):null;
  function railCardHtml(el){
    const a=el.matches('.agent-nav')&&state.agents.find(x=>x.id===el.dataset.id);
    if(a){const hk=navOrder().slice(0,9).findIndex(x=>x.id===a.id),kind=[(a.transport==='ssh'?'Remote':'Local')+(isDocker(a)?' Docker':''),labels[a.provider]||a.provider].filter(Boolean).join(' · '),unread=el.querySelector('.nav-unread')?.textContent;
      return `<div class="rc-head">${badge(a)}<span class="rc-name"><strong>${esc(title(a))}</strong><small>${dot(a)}${esc(status(a))}${unread?` · ${esc(unread)} unread`:''}</small></span>${hk>=0?`<kbd>${esc(mod())}${hk+1}</kbd>`:''}</div><div class="rc-machine"><span class="rc-ico" aria-hidden="true">${AN_ICON.machine||''}</span><span><strong>${esc(location(a))}</strong><small>${esc(kind)}</small></span></div>`;}
    const text=el.dataset.railTitle||el.getAttribute('title')||el.getAttribute('aria-label')||el.textContent.trim(),[head,...rest]=text.split(/:\s+/);
    return `<div class="rc-tip"><strong>${esc(head)}</strong>${rest.length?`<small>${esc(rest.join(': '))}</small>`:''}</div>`;
  }
  function showRailCard(el){
    if(railAnchor&&railAnchor!==el)hideRailCard();
    // The card replaces the native tooltip, which would otherwise show a second later on top of it.
    if(el.hasAttribute('title')){el.dataset.railTitle=el.title;el.removeAttribute('title');}
    railAnchor=el;railCard.innerHTML=railCardHtml(el);railCard.hidden=false;placeRailCard();
  }
  function placeRailCard(){
    if(!railAnchor)return;const r=railAnchor.getBoundingClientRect(),side=$('.sidebar').getBoundingClientRect(),h=railCard.offsetHeight;
    const top=Math.max(8,Math.min(innerHeight-h-8,r.top+r.height/2-h/2));
    railCard.style.left=`${Math.round(side.right+8)}px`;railCard.style.top=`${Math.round(top)}px`;railCard.style.setProperty('--arrow',`${Math.round(r.top+r.height/2-top)}px`);
  }
  function hideRailCard(){
    if(railAnchor?.dataset.railTitle){railAnchor.title=railAnchor.dataset.railTitle;delete railAnchor.dataset.railTitle;}
    railAnchor=railMuted=null;railCard.hidden=true;
  }
  // The list re-renders as agents change state; a hovered icon that was replaced gets its card refreshed from the new one.
  function refreshRailCard(){
    if(!railAnchor)return;if(!sidebarRail||sidebarHidden)return hideRailCard();if(railMuted){if(!railAnchor.isConnected)railAnchor=null;return;}if(railAnchor.isConnected){railCard.innerHTML=railCardHtml(railAnchor);placeRailCard();return;}
    const id=railAnchor.dataset.id,next=id&&$(`.sidebar .agent-nav[data-id="${CSS.escape(id)}"]`);railAnchor=null;
    if(next&&next.matches(':hover,:focus-visible'))showRailCard(next);else railCard.hidden=true;
  }
  // A re-render replaces the elements; an agent's icon stays the same icon by its id.
  const sameRailIcon=(x,y)=>x===y||!!(x&&y&&x.dataset.id&&x.dataset.id===y.dataset.id);
  const sidebarEl=$('.sidebar');
  sidebarEl.addEventListener('mouseover',event=>{const el=railTarget(event.target);if(!sameRailIcon(el,railMuted))railMuted=null;if(el&&el!==railAnchor&&!railMuted)showRailCard(el);else if(!el&&railAnchor)hideRailCard();});
  // A click opens the agent's own sidebar right where the card was, so the card steps aside until the pointer moves to another icon.
  sidebarEl.addEventListener('pointerdown',event=>{if(railAnchor&&railTarget(event.target)===railAnchor){railMuted=railAnchor;railCard.hidden=true;}});
  sidebarEl.addEventListener('mouseleave',()=>{railMuted=null;if(railAnchor&&!railAnchor.matches(':focus-visible'))hideRailCard();});
  sidebarEl.addEventListener('focusin',event=>{const el=railTarget(event.target);if(el&&el.matches(':focus-visible'))showRailCard(el);});
  sidebarEl.addEventListener('focusout',()=>{if(railAnchor&&!railAnchor.matches(':hover'))hideRailCard();});
  sidebarEl.addEventListener('scroll',()=>{if(railAnchor)placeRailCard();},true);
  addEventListener('blur',()=>hideRailCard());
  function toggleSidebar(force){sidebarHidden=force??!sidebarHidden;renderTitleControls();requestAnimationFrame(()=>placePanes());saveView();}
  // Chat or terminal for the selected agent, leaving the Workspace, Manage, the Opaya Agent or the Playground. From a
  // project chat the CLI starts in the project's folder, as the Terminal button did (the service reuses a running one).
  $('#title-controls')?.addEventListener('click',event=>{const b=event.target.closest('[data-title]');if(!b)return;if(b.dataset.title==='sidebar')toggleSidebar();});
  // ---- Files panel: read-only folders, file previews and project info, on this computer or over SSH ----------------
  let files=null;
  const filesScope=()=>files.agentId?{agentId:files.agentId}:files.hostId?{hostId:files.hostId}:{};
  const sepOf=p=>/^[a-zA-Z]:\\|\\/.test(p)&&!p.startsWith('/')?'\\':'/';
  const joinPath=(dir,name)=>{const sep=sepOf(dir);return dir.endsWith(sep)?dir+name:dir+sep+name;};
  const sizeText=n=>n<1024?`${n} B`:n<1048576?`${(n/1024).toFixed(1)} KB`:`${(n/1048576).toFixed(1)} MB`;
  function openFiles(context){files={hidden:false,...context,path:context.path||'',list:null,info:null,preview:null,error:'',loading:false};$('#files-panel').hidden=false;loadDir(files.path);}
  async function loadDir(folder){
    const ctx=files;if(!ctx)return;ctx.loading=true;ctx.error='';renderFiles();
    try{const list=await api.files({...filesScope(),op:'list',path:folder});if(files!==ctx)return;ctx.list=list;ctx.path=list.path;ctx.preview=null;ctx.info=await api.files({...filesScope(),op:'project',path:list.path}).catch(()=>null);}
    catch(error){if(files===ctx)ctx.error=error.message;}finally{if(files===ctx){ctx.loading=false;renderFiles();}}
  }
  async function previewFile(name){
    const ctx=files,file=joinPath(ctx.path,name);ctx.loading=true;renderFiles();
    try{ctx.preview=await api.files({...filesScope(),op:'read',path:file});}catch(error){ctx.error=error.message;}finally{ctx.loading=false;renderFiles();}
  }
  function renderFiles(){
    const box=$('#files-panel');if(!files){box.hidden=true;return;}
    const f=files,sep=sepOf(f.path||'/'),parts=(f.path||'').split(sep).filter(Boolean),root=sep==='/'?'/':'';
    const crumbs=parts.map((part,i)=>{const full=(sep==='/'?'/':'')+parts.slice(0,i+1).join(sep)+(sep==='\\'&&i===0?'\\':'');return `<button data-action="files-go" data-path="${esc(full)}">${esc(part)}</button>`;}).join(`<span>${esc(sep)}</span>`);
    const entries=(f.list?.entries||[]).filter(e=>f.hidden||!e.name.startsWith('.')).sort((a,b)=>(a.type==='dir'?0:1)-(b.type==='dir'?0:1)||a.name.localeCompare(b.name));
    const info=f.info,git=info?.git;
    box.innerHTML=`<header class="files-header"><div><strong>Files</strong><small>${esc(f.label)}</small></div><div><button class="icon-button" data-action="files-refresh" title="Refresh" aria-label="Refresh">&#8635;</button><button class="icon-button" data-action="files-close" title="Close files" aria-label="Close files">&#10005;</button></div></header>
      <nav class="files-path">${f.list?.parent?`<button class="icon-button" data-action="files-go" data-path="${esc(f.list.parent)}" title="Up one folder" aria-label="Up one folder">&#8593;</button>`:''}<div class="files-crumbs">${root?`<button data-action="files-go" data-path="/">/</button>`:''}${crumbs}</div><button class="icon-button" data-action="files-home" title="Home folder" aria-label="Home folder">&#8962;</button></nav>
      ${f.error?`<div class="inline-notice error-notice files-error"><p>${esc(f.error)}</p></div>`:''}
      ${f.preview?`<section class="files-preview"><div class="files-preview-head"><button class="text-button" data-action="files-back">&#8592; ${esc(f.list?.path?parts.at(-1)||f.list.path:'Back')}</button><strong title="${esc(f.preview.path)}">${esc(f.preview.path.split(sepOf(f.preview.path)).pop())}</strong><small>${sizeText(f.preview.size)}${f.preview.truncated?' / first 256 KB':''}</small></div><div class="files-actions"><button class="secondary" data-action="files-mention" data-path="${esc(f.preview.path)}" title="Type this path into the message box">Mention in chat</button><button class="secondary" data-action="files-mention-term" data-path="${esc(f.preview.path)}" title="Type this path into a terminal on the same machine">Mention in terminal</button></div>${f.preview.binary?'<p class="field-help">Binary file. Preview is not available.</p>':`<pre class="files-code">${esc(f.preview.text)}</pre>`}</section>`:`
      ${info&&(info.markers?.length||git)?`<section class="files-project">${git?`<div class="files-git"><span class="git-branch">&#5833; ${esc(git.branch||'git')}</span><span>${git.changes.length?`${git.changes.length}${git.changes.length>=60?'+':''} changed`:'clean'}</span></div>${git.changes.length?`<details><summary>Changes</summary><pre>${esc(git.changes.join('\n'))}</pre></details>`:''}${git.recent?.length?`<details><summary>Recent commits</summary><pre>${esc(git.recent.join('\n'))}</pre></details>`:''}`:''}${info.markers?.length?`<div class="files-markers">${info.markers.filter(m=>m!=='.git').map(m=>`<button class="marker-chip" data-action="files-open" data-name="${esc(m)}">${esc(m)}</button>`).join('')}</div>`:''}</section>`:''}
      <div class="files-toolbar"><span>${f.list?`${entries.length} item${entries.length===1?'':'s'}`:''}</span><label><input type="checkbox" data-action="files-hidden" ${f.hidden?'checked':''}> Hidden files</label><button class="text-button" data-action="files-terminal">&gt;_ Terminal here</button><span class="files-mention-folder">Mention folder in <button class="text-button" data-action="files-mention" data-path="${esc(f.path)}" title="Type this folder's path into the message box">chat</button> or <button class="text-button" data-action="files-mention-term" data-path="${esc(f.path)}" title="Type this folder's path into a terminal on the same machine">terminal</button></span></div>
      <ul class="files-list">${entries.map(e=>`<li><button class="file-row ${e.type} ${e.name.startsWith('.')?'hidden-file':''}" data-action="${e.type==='dir'?'files-go':'files-open'}" ${e.type==='dir'?`data-path="${esc(joinPath(f.path,e.name))}"`:`data-name="${esc(e.name)}"`}><span class="file-glyph" aria-hidden="true">${e.type==='dir'?'&#9656;':e.type==='broken'?'!':''}</span><span class="file-name">${esc(e.name)}${e.link?' <em>&#8599;</em>':''}</span><small>${e.type==='dir'?'':sizeText(e.size)}</small></button></li>`).join('')||(f.loading?'':'<li class="files-empty">This folder is empty.</li>')}</ul>`}
      ${f.loading?'<div class="files-loading"><span class="status-dot working"></span> Loading...</div>':''}`;
  }
  function mention(text){
    const input=$('#message-input');if(!input||input.disabled){toast('Open a chat to mention this path.');return;}
    const quoted=/\s/.test(text)?`"${text}"`:text,start=input.selectionStart??input.value.length;
    input.value=input.value.slice(0,start)+(start&&!/\s$/.test(input.value.slice(0,start))?' ':'')+quoted+' '+input.value.slice(input.selectionEnd??start);
    input.dispatchEvent(new Event('input'));input.focus();
  }
  // Mention in terminal: the quoted path goes into a terminal on the machine the files are on (the one in front when it
  // is, then the agent's CLI, then any open one there, else a new shell), without Enter. An agent's files are on its
  // machine; a Docker agent's terminals run inside its container, so they do not count for its machine.
  const hostKey=a=>a?.transport==='ssh'?`host:${a.hostId}`:'local';
  const filesMachine=()=>files.agentId?hostKey(state.agents.find(a=>a.id===files.agentId)):files.hostId?`host:${files.hostId}`:'local';
  const viewMachine=v=>v.agentId==='local-shell'?'local':String(v.agentId).startsWith('host_')?`host:${v.agentId.slice(5)}`:(a=>!a?'':a.command==='docker'?`container:${a.id}`:hostKey(a))(state.agents.find(a=>a.id===v.agentId));
  async function mentionInTerminal(text){
    if(!files||!text)return;const where=filesMachine(),live=v=>!!v&&!v.exited&&viewMachine(v)===where,all=[...terminalViews.values()].filter(live);
    let view=live(terminalViews.get(currentTerminal))?terminalViews.get(currentTerminal):all.find(v=>files.agentId&&v.agentId===files.agentId&&v.mode==='agent')||all.find(v=>panes.includes(v.id))||all[0];
    if(!view){const id=await openTerminal(where==='local'?{local:true}:{hostId:where.slice(5)});view=terminalViews.get(id);if(!view)return;}
    const quoted=where==='local'&&state.platform==='win32'?(/^[\w@%+=:,.\\/-]+$/.test(text)?text:`"${text}"`):/^[\w@%+=:,./-]+$/.test(text)?text:`'${text.replace(/'/g,`'\\''`)}'`;
    // A popped-out terminal gets it in its own window; a docked one through xterm, which brackets the paste for TUIs.
    if(view.poppedOut){await api.terminalWrite({id:view.id,data:quoted+' '});toast(`Typed in ${tabTitle(view)}, in its own window.`);return;}
    if($('#terminal-panel').hidden)$('#terminal-panel').hidden=false;activateTerminal(view.id);view.term.paste(quoted+' ');view.term.focus();
  }
  async function terminalHere(){
    const f=files,dir=f.path,windowsLocal=!f.agentId&&!f.hostId?state.platform==='win32':f.agentId?state.platform==='win32'&&state.agents.find(a=>a.id===f.agentId)?.transport!=='ssh':false;
    await openTerminal(f.agentId?{agentId:f.agentId}:f.hostId?{hostId:f.hostId}:{local:true});
    if(currentTerminal)await api.terminalWrite({id:currentTerminal,data:(windowsLocal?`Set-Location -LiteralPath '${dir.replace(/'/g,"''")}'`:`cd -- '${dir.replace(/'/g,"'\\''")}'`)+'\r'});
  }
  $('#files-panel').addEventListener('click',event=>{
    const b=event.target.closest('[data-action]');if(!b||!files)return;const act=b.dataset.action;
    if(act==='files-close'){files=null;renderFiles();}
    else if(act==='files-go')loadDir(b.dataset.path);
    else if(act==='files-home')loadDir(files.list?.home||'~');
    else if(act==='files-refresh')files.preview?previewFile(files.preview.path.split(sepOf(files.preview.path)).pop()):loadDir(files.path);
    else if(act==='files-open')previewFile(b.dataset.name);
    else if(act==='files-back'){files.preview=null;renderFiles();}
    else if(act==='files-mention')mention(b.dataset.path);
    else if(act==='files-mention-term')action(()=>mentionInTerminal(b.dataset.path));
    else if(act==='files-terminal')action(terminalHere);
  });
  // Right-click a file or folder: open it, mention it in the chat or a terminal, or copy its path.
  $('#files-panel').addEventListener('contextmenu',event=>{const row=event.target.closest('.file-row');if(!row||!files)return;event.preventDefault();
    const dir=row.classList.contains('dir'),p=row.dataset.path||joinPath(files.path,row.dataset.name);
    openMenu(event.clientX,event.clientY,[
      {icon:dir?'&#9656;':'&#9636;',label:dir?'Open folder':'Preview',run:()=>dir?loadDir(p):previewFile(row.dataset.name)},'-',
      {icon:'&#9993;',label:'Mention in chat',run:()=>mention(p)},
      {icon:'&gt;_',label:'Mention in terminal',run:()=>action(()=>mentionInTerminal(p))},
      {icon:'&#10697;',label:'Copy path',run:()=>action(async()=>{await api.clipboardWrite({text:p});toast('Path copied.');})}
    ],row.querySelector('.file-name')?.textContent||'',row);
  });
  $('#files-panel').addEventListener('change',event=>{if(event.target.dataset.action==='files-hidden'&&files){files.hidden=event.target.checked;renderFiles();}});
  // ---- Groups, tags, drag and drop, connect all ---------------------------------------------------------------
  const allGroups=()=>[...new Set(state.agents.map(a=>a.group).filter(Boolean))];
  const allTags=()=>[...new Set(state.agents.flatMap(a=>a.tags||[]))].sort((a,b)=>a.localeCompare(b));
  const tagChips=(a,limit=4)=>(a.tags||[]).slice(0,limit).map(t=>`<span class="tag-chip">${esc(t)}</span>`).join('');
  let tagFilter='';
  function toggleGroup(key){if(collapsedGroups.has(key))collapsedGroups.delete(key);else collapsedGroups.add(key);navHtml='';render();saveView();}
  function sectionAgents(key){return state.agents.filter(a=>key==='pinned'?a.pinned:key.startsWith('group:')?!a.pinned&&a.group===key.slice(6):!a.pinned&&!a.group&&(key==='remote')===(a.transport==='ssh'));}
  async function connectAll(ids){
    toast(ids?'Connecting this group...':'Connecting all agents...');
    const r=await api.connectAll(ids?{ids}:{});
    if(!r.attempted)toast('Every agent is already connected.');
    else if(!r.failed.length)toast(`${r.connected} agent${r.connected===1?'':'s'} connected.`);
    else toast(`${r.connected} connected, ${r.failed.length} need attention: ${r.failed.map(f=>`${f.name} (${f.error})`).join('; ').slice(0,400)}`,true);
  }
  function groupMenu(key,name){
    const agents=sectionAgents(key),custom=key.startsWith('group:');
    return [
      {icon:collapsedGroups.has(key)?'&#9656;':'&#9662;',label:collapsedGroups.has(key)?'Expand':'Collapse',run:()=>toggleGroup(key)},
      {icon:'&#8801;',label:'Collapse all groups',run:()=>{for(const g of ['pinned','local','remote',...allGroups().map(g=>'group:'+g)])collapsedGroups.add(g);navHtml='';render();saveView();}},
      {icon:'&#8801;',label:'Expand all groups',run:()=>{collapsedGroups.clear();navHtml='';render();saveView();}},
      '-',
      {icon:'&#9679;',label:`Connect all in ${custom?name:'this section'}`,run:()=>connectAll(agents.map(a=>a.id))},
      custom&&'-',
      custom&&{icon:'&#9998;',label:'Rename group...',run:()=>renameGroup(name)},
      custom&&{icon:'&#10005;',label:'Ungroup',danger:true,run:async()=>{for(const a of agents)await api.updateAgentDisplay({id:a.id,group:''});toast(`${name} ungrouped.`);}}
    ];
  }
  function renameGroup(name){
    modal('Rename group','',`<form id="group-rename-form"><label class="field"><span>Group name</span><input name="group" value="${esc(name)}" maxlength="40" required autocomplete="off"></label><div class="modal-footer"><button type="button" class="secondary" data-action="modal-close">Cancel</button><button type="submit" class="primary">Rename</button></div></form>`);
    const form=$('#group-rename-form');form.elements.group.select();
    form.addEventListener('submit',event=>{event.preventDefault();const next=form.elements.group.value.trim();action(async()=>{for(const a of state.agents.filter(a=>a.group===name))await api.updateAgentDisplay({id:a.id,group:next});if(collapsedGroups.delete('group:'+name))collapsedGroups.add('group:'+next);saveView();closeModal();});});
  }
  function openGroupTags(a){
    const groups=allGroups(),tags=allTags();
    modal('Group & tags',`For ${title(a)}. Groups organise the sidebar; tags help you filter and search.`,`<form id="group-tags-form"><label class="field"><span>Group</span><input name="group" value="${esc(a.group||'')}" maxlength="40" list="group-options" placeholder="e.g. Clients, Research, VPS fleet" autocomplete="off"></label><datalist id="group-options">${groups.map(g=>`<option value="${esc(g)}">`).join('')}</datalist>${groups.length?`<div class="chip-picker">${groups.map(g=>`<button type="button" class="tag-chip pick" data-group-pick="${esc(g)}">${esc(g)}</button>`).join('')}</div>`:''}<label class="field"><span>Tags</span><input name="tags" value="${esc((a.tags||[]).join(', '))}" placeholder="comma separated, e.g. prod, coding, hermes" autocomplete="off"></label>${tags.length?`<div class="chip-picker">${tags.map(t=>`<button type="button" class="tag-chip pick" data-tag-pick="${esc(t)}">+ ${esc(t)}</button>`).join('')}</div>`:''}<div class="modal-footer"><div>${a.group||a.tags?.length?'<button type="button" class="danger-text" id="clear-group-tags">Clear group and tags</button>':''}</div><div><button type="button" class="secondary" data-action="modal-close">Cancel</button><button type="submit" class="primary">Save</button></div></div></form>`);
    const form=$('#group-tags-form');
    form.addEventListener('click',event=>{const g=event.target.closest('[data-group-pick]'),t=event.target.closest('[data-tag-pick]');if(g)form.elements.group.value=g.dataset.groupPick;if(t){const list=form.elements.tags.value.split(',').map(x=>x.trim()).filter(Boolean);if(!list.includes(t.dataset.tagPick))list.push(t.dataset.tagPick);form.elements.tags.value=list.join(', ');}});
    $('#clear-group-tags')?.addEventListener('click',()=>action(async()=>{await api.updateAgentDisplay({id:a.id,group:'',tags:[]});closeModal();}));
    form.addEventListener('submit',event=>{event.preventDefault();action(async()=>{await api.updateAgentDisplay({id:a.id,group:form.elements.group.value.trim(),tags:form.elements.tags.value.split(',').map(x=>x.trim()).filter(Boolean)});closeModal();toast('Group and tags saved.');});});
  }
  // Drag and drop in the sidebar: drop on an agent to place it before or after, or on a section header to move it there.
  let dragId='';
  const list=$('#agent-list');
  const clearDrop=()=>list.querySelectorAll('.drop-before,.drop-after,.drop-into').forEach(el=>el.classList.remove('drop-before','drop-after','drop-into'));
  const sectionTarget=key=>key==='pinned'?{pinned:true}:key.startsWith('group:')?{pinned:false,group:key.slice(6)}:{pinned:false,group:''};
  list.addEventListener('dragstart',event=>{const row=event.target.closest('.agent-nav-row');if(!row)return;dragId=row.dataset.agentId;event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain',dragId);requestAnimationFrame(()=>row.classList.add('dragging'));closeMenu();});
  list.addEventListener('dragend',()=>{dragId='';clearDrop();list.querySelectorAll('.dragging').forEach(el=>el.classList.remove('dragging'));});
  list.addEventListener('dragover',event=>{
    if(!dragId)return;const row=event.target.closest('.agent-nav-row'),head=event.target.closest('.sidebar-section-label');if(!row&&!head)return;
    event.preventDefault();event.dataTransfer.dropEffect='move';clearDrop();
    if(head)head.classList.add('drop-into');else if(row.dataset.agentId!==dragId){const r=row.getBoundingClientRect();row.classList.add(event.clientY<r.top+r.height/2?'drop-before':'drop-after');}
  });
  list.addEventListener('drop',event=>{
    if(!dragId)return;event.preventDefault();const id=dragId,row=event.target.closest('.agent-nav-row'),head=event.target.closest('.sidebar-section-label');clearDrop();dragId='';
    if(head){action(()=>api.moveAgent({id,...sectionTarget(head.dataset.group)}));collapsedGroups.delete(head.dataset.group);return;}
    if(!row||row.dataset.agentId===id)return;const r=row.getBoundingClientRect();
    action(()=>api.moveAgent({id,targetId:row.dataset.agentId,position:event.clientY<r.top+r.height/2?'before':'after',...sectionTarget(row.dataset.section)}));
  });
  // ---- Playground: one question, two agents, side by side ------------------------------------------------------
  let pgAgents=[],pgKeep=false,pgDraft='';
  function playgroundPair(){
    const ids=state.agents.map(a=>a.id),last=state.playground?.agentIds||[];
    pgAgents=pgAgents.filter(id=>ids.includes(id));
    for(const id of [...last,...state.agents.filter(a=>a.status==='connected').map(a=>a.id),...ids])if(pgAgents.length<2&&!pgAgents.includes(id))pgAgents.push(id);
    return pgAgents;
  }
  function renderPlayground(){
    const entering=renderKey!=='playground',[left,right]=playgroundPair(),run=state.playground;
    topbar('<strong>Playground</strong>',`<label class="check-row inline" title="Continue the previous playground conversations instead of starting fresh"><input type="checkbox" id="pg-keep" ${pgKeep?'checked':''}> Keep context</label><button class="subtle" data-action="pg-swap" title="Swap sides">&#8646; Swap</button><button class="subtle" data-action="connect-all">Connect all</button>`);
    $('#pg-keep').onchange=event=>{pgKeep=event.target.checked;};
    contentKind('conversation playground-view');
    if(entering){
      $('#content').innerHTML=`<div class="pg-columns"><section class="pg-column" data-side="0"></section><section class="pg-column" data-side="1"></section></div><div class="compose-area"><form id="message-form" class="pg-form"><textarea id="message-input" rows="2" maxlength="80000" aria-label="Ask both agents" placeholder="Ask both agents the same question..."></textarea><div class="compose-bottom"><div><span class="compose-provider">Playground</span><span id="compose-hint"></span></div><button type="button" id="pg-stop" class="stop-button" data-action="pg-stop" hidden><span>&#9632;</span> Stop both</button><button id="pg-send" type="submit" class="send-button" aria-label="Ask both">&#8593;</button></div></form><p class="compose-caption">Each question starts fresh conversations unless Keep context is on <span>&#183;</span> Answers also appear in each agent's chat history</p></div>`;
      const input=$('#message-input');input.value=pgDraft;input.addEventListener('input',()=>{pgDraft=input.value;});
      input.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();sendPlayground();}});
      $('#message-form').addEventListener('submit',event=>{event.preventDefault();sendPlayground();});
      $('#content').addEventListener('change',event=>{const select=event.target.closest('.pg-select');if(select){pgAgents[Number(select.dataset.side)]=select.value;render();}});
      enter($('#content'));
    }
    renderKey='playground';
    [left,right].forEach((id,side)=>{
      const a=state.agents.find(a=>a.id===id),col=$(`.pg-column[data-side="${side}"]`);if(!col)return;
      const conv=run?.conversations?.[id],messages=conv?state.histories[conv]||[]:[],answer=messages.filter(m=>m.role==='assistant').at(-1),error=run?.errors?.[id];
      const scroller=col.querySelector('.pg-answer'),atBottom=!scroller||scroller.scrollHeight-scroller.scrollTop-scroller.clientHeight<80;
      col.innerHTML=`<header class="pg-head">${a?badge(a):''}<select class="pg-select" data-side="${side}" aria-label="Agent ${side+1}">${state.agents.map(x=>`<option value="${esc(x.id)}" ${x.id===id?'selected':''} ${x.id===[left,right][1-side]?'disabled':''}>${esc(title(x))}</option>`).join('')}</select>${a?`<span class="status-pill ${esc(a.busy?'connecting':a.status)}">${dot(a)}${status(a)}</span>${a.status!=='connected'&&a.protocol!=='terminal'?`<button class="text-button" data-action="pg-connect" data-id="${esc(a.id)}">Connect</button>`:''}`:''}</header>
        <div class="pg-meta">${a?`${esc(labels[a.provider]||'Agent')} / ${esc(conv&&state.conversations.find(c=>c.id===conv)?.model||a.model||'default model')}`:'Add an agent to compare'}${answer?.content?` <span>&#183;</span> ${answer.content.length.toLocaleString()} characters`:''}${conv?` <button class="text-button" data-action="pg-open" data-id="${esc(conv)}">Open in chat &#8599;</button>`:''}</div>
        <div class="pg-answer">${error?`<div class="message-error">${esc(error)}</div>`:''}${answer?`${activityMarkup(answer,12,id)}<div class="message-text">${format(answer.content)}${answer.status==='streaming'&&!answer.content?'<div class="thinking-dots"><i></i><i></i><i></i></div>':''}</div>${answer.error?`<div class="message-error">${esc(answer.error)}</div>`:''}`:!error?`<div class="pg-empty">${a?`${badge(a,true)}<p>${esc(title(a))} answers here.</p>`:'<p>Choose an agent.</p>'}</div>`:''}</div>`;
      const next=col.querySelector('.pg-answer');if(atBottom)next.scrollTop=next.scrollHeight;
    });
    const busy=[left,right].some(id=>state.agents.find(a=>a.id===id)?.busy);
    if(run?.prompt)$('#compose-hint').textContent=`Last question: ${run.prompt.slice(0,80)}`;else $('#compose-hint').textContent='Pick two agents and ask';
    $('#pg-send').hidden=busy;$('#pg-stop').hidden=!busy;$('#pg-send').disabled=!left||!right;
  }
  async function sendPlayground(){
    const input=$('#message-input'),text=input?.value.trim(),[left,right]=pgAgents;if(!text||!left||!right)return;
    await action(async()=>{await api.playground({agentIds:[left,right],text,keepContext:pgKeep});pgDraft='';input.value='';});
  }
  // ---- Live turn watch and connection log -------------------------------------------------------------------------
  const duration=ms=>{const s=Math.max(0,Math.round(ms/1000));return s<60?`${s}s`:`${Math.floor(s/60)}m ${String(s%60).padStart(2,'0')}s`;};
  function updateTurnWatch(){
    const now=Date.now();
    for(const el of document.querySelectorAll('[data-turn-watch]')){
      const a=state.agents.find(x=>x.id===el.dataset.turnWatch);
      if(!a?.busy||!a.turnStartedAt){el.innerHTML='';continue;}
      const since=now-(a.lastEventAt||a.turnStartedAt),stalled=since>45000;
      el.classList.toggle('stalled',stalled);
      const text=stalled?`No update from ${title(a)} for ${duration(since)}${a.lastEvent?` / last: ${a.lastEvent}`:''}`:`Running ${duration(now-a.turnStartedAt)} / last update ${duration(since)} ago`;
      const html=`<span>${esc(text)}</span><button class="text-button" data-action="diagnostics" data-id="${esc(a.id)}">Connection log</button>${stalled?`<button class="text-button danger-text" data-action="stop-agent" data-id="${esc(a.id)}">Stop</button>`:''}`;
      if(el.dataset.html!==html){el.innerHTML=html;el.dataset.html=html;}
    }
  }
  setInterval(updateTurnWatch,1000);
  let diagTimer=0;
  async function openDiagnostics(id){
    const a=state.agents.find(x=>x.id===id);if(!a)return;clearInterval(diagTimer);
    const load=async()=>{
      const d=await api.agentDiagnostics({id});if(!$('#diag-body'))return;
      const ad=d.adapter,time=t=>new Date(t).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'});
      const rows=[['Status',`${d.status}${d.error?` / ${d.error}`:''}`],['Protocol',ad?.protocol?.toUpperCase()||d.agent.protocol],['Process',ad?.pid?`PID ${ad.pid}${ad.closed?' (closed)':''}`:'n/a'],
        ['Current answer',d.turn?`running ${duration(d.turn.runningSeconds*1000)}, last update ${duration(d.turn.secondsSinceLastEvent*1000)} ago`:'idle'],
        ['Last message from agent',ad?.lastIn?`${time(ad.lastIn)} (${duration(Date.now()-ad.lastIn)} ago)`:'none yet'],
        ['Waiting for approval',ad?.waitingForApproval?`${ad.waitingForApproval.title} (${duration(ad.waitingForApproval.seconds*1000)})`:'no'],
        ['Running tools',ad?.runningTools?.length?ad.runningTools.map(t=>`${t.title} (${t.status}, ${duration(t.seconds*1000)})`).join('; '):'none'],
        ...(ad?.agentVersion?[['Agent version',ad.agentVersion]]:[]),...(ad?.terminalStarting?[['Terminal starting',`${duration(ad.terminalStarting*1000)}`]]:[])];
      $('#diag-body').innerHTML=`${ad?.hint?`<div class="diag-hint">${esc(ad.hint)}</div>`:''}<dl class="diag-summary">${rows.map(([k,v])=>`<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
        <h3 class="diag-heading">Protocol log <small>newest last, secrets redacted</small></h3><pre class="diag-log">${esc((ad?.entries||[]).slice(-250).map(e=>`${time(e.at)} ${e.direction==='in'?'<-':e.direction==='out'?'->':e.direction==='stderr'?'!!':'--'} ${e.text}`).join('\n')||'No messages recorded yet. Connect the agent and send a message.')}</pre>
        ${ad?.stderr?`<h3 class="diag-heading">Agent stderr</h3><pre class="diag-log">${esc(ad.stderr.slice(-6000))}</pre>`:''}
        ${d.hermesLogs?.length?d.hermesLogs.map(l=>`<h3 class="diag-heading">${esc(l.path)} <small>${esc(l.modified||'')}</small></h3><pre class="diag-log">${esc(l.tail)}</pre>`).join(''):d.agent.provider==='hermes'?'<p class="field-help">No Hermes log files found in the Hermes home folder.</p>':''}`;
      for(const pre of document.querySelectorAll('.diag-log'))pre.scrollTop=pre.scrollHeight;
    };
    modal('Connection log',`${title(a)} / live view of what Opaya and the agent exchange`,`<div id="diag-body"><p class="field-help">Loading...</p></div><div class="modal-footer"><div><label class="check-row inline"><input type="checkbox" id="diag-live" checked> Refresh every 2 s</label></div><div><button class="secondary" id="diag-ask">Ask the Opaya Agent</button>${a.busy?`<button class="secondary danger-text" data-action="stop-agent" data-id="${esc(a.id)}">Stop answer</button>`:''}<button class="primary" id="diag-refresh">Refresh</button></div></div>`,true);
    $('#diag-refresh').onclick=()=>action(load);
    $('#diag-ask').onclick=()=>{closeModal();overview=false;playgroundView=false;opayaView=true;opayaDraft=`${title(a)} is not answering. Run agent_diagnostics for it and tell me exactly what is wrong and how to fix it.`;renderKey='';render();saveView();};
    diagTimer=setInterval(()=>{if(!$('#diag-body')){clearInterval(diagTimer);return;}if($('#diag-live')?.checked)load().catch(()=>{});},2000);
    await action(load);
  }
  // ---- Skills, tools and MCP servers ------------------------------------------------------------------------------
  const skillCache=new Map();
  // How each agent gets Opaya's MCP servers: with each ACP session, per message (Claude Code here), or written into its
  // own config where it runs (Claude Code elsewhere, Codex, OpenClaw), which asks first.
  const mcpSupport=a=>a.provider==='openclaw'?'Written to OpenClaw\'s own config (mcp.servers) where it runs; its gateway picks them up.':a.protocol==='acp'?'Passed to new sessions. Start a new conversation after changing them.':a.protocol==='claude'?(a.transport==='ssh'||a.command==='docker'?'Written to ~/.claude.json where it runs (Opaya asks first). New Claude sessions load them.':'Passed to Claude with every message.'):a.protocol==='codex'?'Written to ~/.codex/config.toml [mcp_servers] where it runs (Opaya asks first); program and HTTP servers, not SSE. Reconnect Codex to load them.':a.provider==='hermes'?'This Hermes connection uses its gateway API, which takes MCP servers from its own config. Use hermes mcp on that machine.':(a.install?.framework||'')==='goose'?'Goose keeps extensions in its own config: add them with goose configure.':(a.install?.framework||'')==='aider'?'Aider does not use MCP servers.':'This connection type does not accept MCP servers from Opaya.';
  const mcpPassed=a=>['acp','claude','codex'].includes(a.protocol)||a.provider==='openclaw';
  const usesMcp=(s,a)=>s.enabled&&(s.agents==='all'||s.agents.includes(a.id));
  async function loadSkills(id,force=false){if(!force&&skillCache.has(id))return skillCache.get(id);const r=await api.agentSkills({id});skillCache.set(id,r);return r;}
  function useCommand(a,name){
    closeModal();
    agentModes.set(a.id,'chat');const put=()=>{const input=$('#message-input');if(!input)return;input.value=`/${name} `;drafts.set(draftKey(),input.value);input.focus();input.setSelectionRange(input.value.length,input.value.length);};
    if(state.activeAgentId!==a.id||overview||opayaView||playgroundView){overview=false;opayaView=false;playgroundView=false;action(async()=>{await api.select({id:a.id});await refresh();put();});}else put();
  }
  // Hermes and other ACP agents anywhere (a relay brings the browser to a machine or container); Claude Code and Codex here.
  const browserCapable=a=>a.protocol==='acp'||a.transport!=='ssh'&&a.command!=='docker'&&['claude','codex'].includes(a.protocol);
  // On for every agent unless taken away (browserOff).
  const hasBrowser=a=>!!a&&browserCapable(a)&&!a.browserOff;
  async function toggleAgentTrust(a){
    if(state.settings?.itrustAll&&a.itrust===false){toast('iTrust is on for all agents in Settings.');return;}
    const on=!a.itrust;
    if(on&&!await ask(`Turn on iTrust for ${title(a)}?\n\nIts tool requests (commands, file edits and other actions) will be approved automatically, without asking you.`))return;
    await action(async()=>{await api.updateAgentDisplay({id:a.id,itrust:on});await refresh();toast(on?`iTrust is on for ${title(a)}.`:`iTrust is off for ${title(a)}.`);});
  }
  document.addEventListener('change',async event=>{const box=event.target,key=box.dataset?.setting;if(!key)return;const on=box.checked;
    if(on&&key==='itrustAll'&&!await ask('Turn on iTrust for all agents?\n\nEvery agent\'s tool requests will be approved automatically.')){box.checked=false;return;}
    action(async()=>{await api.saveSettings({[key]:on});await refresh();});});
  async function openSkills(id){
    const a=state.agents.find(x=>x.id===id);if(!a)return;
    modal('Skills, tools & MCP',`${title(a)} / ${labels[a.provider]||a.provider}${a.agentVersion?` ${a.agentVersion}`:''}`,`<div id="skills-body"><p class="field-help">Loading skills...</p></div>`,true);
    const draw=async(force=false)=>{
      let r;try{r=await loadSkills(id,force);}catch(error){r={skills:[],dirs:[],supported:true,error:error.message};}
      const body=$('#skills-body');if(!body)return;const live=state.agents.find(x=>x.id===id)||a;
      const q=($('#skills-search')?.value||'').toLowerCase();
      const list=r.skills.filter(s=>`${s.name} ${s.description} ${s.category}`.toLowerCase().includes(q));
      const commands=live.commands||[];
      body.innerHTML=`<section class="skills-section"><div class="skills-head"><h3>Skills <small>${r.skills.length}</small></h3><div><input id="skills-search" class="skills-search" placeholder="Filter skills..." aria-label="Filter skills" value="${esc(q)}"><button class="text-button" id="skills-refresh">Refresh</button></div></div>
        ${r.error?`<div class="message-error">${esc(r.error)}</div>`:''}
        ${!r.supported?'<p class="field-help">Opaya does not know where this agent keeps skills.</p>':list.length?`<div class="skill-list">${list.slice(0,200).map(s=>`<div class="skill-row"><div><strong>/${esc(s.name)}</strong>${s.category?`<em>${esc(s.category)}</em>`:''}<p>${esc(s.description||'No description.')}</p></div><button class="secondary small" data-skill-use="${esc(s.name)}">Use</button></div>`).join('')}</div>`:`<p class="field-help">${r.skills.length?'No skills match this filter.':'No skills installed yet.'}</p>`}
        ${r.dirs?.length?`<p class="field-help">Skill folders: ${r.dirs.map(d=>`<code>${esc(d)}</code>`).join(', ')}. Each skill is a folder with a SKILL.md.${a.transport!=='ssh'?' <button class="text-button" id="skills-open-folder">Open folder</button>':''}</p>`:''}
        <div class="skill-move"><button class="secondary small" data-action="transfer" data-id="${esc(a.id)}">&#8644; Share with another agent</button><button class="secondary small" id="skills-to-library" ${r.skills.length?'':'disabled'}>Add to skills library</button><button class="text-button" data-action="library">Skills library</button></div>
        ${a.provider==='hermes'?`<div class="skill-install"><input id="skill-id" placeholder="official/security/1password or https://.../SKILL.md" aria-label="Skill id or link"><button class="primary" id="skill-install">Install</button><button class="secondary" id="skill-browse">Browse Hermes hub</button></div>`:a.provider==='openclaw'?`<div class="skill-install"><input id="skill-id" placeholder="@owner/skill, skills-sh:owner/repo/skill or git:owner/repo" aria-label="ClawHub skill"><button class="primary" id="skill-install">Install</button><button class="secondary" id="skill-browse">Search ClawHub</button></div>`:''}
      </section>
      <section class="skills-section"><div class="skills-head"><h3>Commands <small>${commands.length}</small></h3></div>
        ${commands.length?`<div class="skill-list">${commands.map(c=>`<div class="skill-row"><div><strong>/${esc(c.name)}</strong><p>${esc(c.description||'')}${c.hint?` <em>${esc(c.hint)}</em>`:''}</p></div><button class="secondary small" data-skill-use="${esc(c.name)}">Use</button></div>`).join('')}</div>`:`<p class="field-help">${a.protocol==='acp'?'The agent announces its commands after its first session. Send a message or refresh models.':'Type / in the message box to use skills.'}</p>`}
        ${a.protocol==='acp'&&a.provider==='hermes'?`<p class="field-help">Tools: <button class="text-button" id="skills-tools" ${live.status!=='connected'||live.busy?'disabled':''}>Ask Hermes for its tool list (/tools)</button></p>`:''}
      </section>
      <section class="skills-section"><div class="skills-head"><h3>MCP servers <small>${(state.mcpServers||[]).length}</small></h3><button class="secondary small" data-action="mcp-manage">Manage MCP servers</button></div>
        <p class="field-help">${esc(mcpSupport(a))}</p>
        ${(state.mcpServers||[]).length?`<div class="skill-list">${state.mcpServers.map(s=>`<label class="skill-row mcp-row"><div><strong>${esc(s.name)}</strong><em>${esc(s.type)}</em><p>${esc(s.type==='stdio'?`${s.command} ${s.args.join(' ')}`:s.url)}${s.note?` / ${esc(s.note)}`:''}</p></div><input type="checkbox" data-mcp-toggle="${esc(s.id)}" ${usesMcp(s,a)?'checked':''} ${mcpPassed(a)?'':'disabled'} aria-label="Use ${esc(s.name)} with ${esc(title(a))}"></label>`).join('')}</div>`:'<p class="field-help">No MCP servers yet. Add one to give your agents tools such as GitHub, a browser or a database.</p>'}
      </section>`;
      const search=$('#skills-search');search.addEventListener('input',()=>draw());if(q){search.focus();search.setSelectionRange(q.length,q.length);}
      $('#skills-refresh').onclick=()=>draw(true);
      $('#skills-to-library')&&($('#skills-to-library').onclick=()=>openLibraryImport(a,r.skills));
      for(const b of body.querySelectorAll('[data-skill-use]'))b.onclick=()=>useCommand(a,b.dataset.skillUse);
      for(const c of body.querySelectorAll('[data-mcp-toggle]'))c.onchange=()=>action(async()=>{await api.agentMcp({agentId:a.id,serverId:c.dataset.mcpToggle,enabled:c.checked});await refresh();toast(a.protocol==='acp'?'Saved. Start a new conversation to use it.':'Saved.');});
      $('#skills-open-folder')&&($('#skills-open-folder').onclick=()=>{closeModal();openFiles({agentId:a.id,path:r.dirs[0],label:`${title(a)} / skills`});});
      $('#skill-install')&&($('#skill-install').onclick=()=>action(async()=>{const skill=$('#skill-id').value.trim();if(!skill)return;await api.skillAction({agentId:a.id,action:'install',skill});skillCache.delete(a.id);toast('Installing in Terminal. Refresh when it finishes.');}));
      $('#skill-browse')&&($('#skill-browse').onclick=()=>action(()=>api.skillAction({agentId:a.id,action:'browse'})));
      $('#skills-tools')&&($('#skills-tools').onclick=()=>action(async()=>{closeModal();await api.send({agentId:a.id,conversationId:currentConversation()?.agentId===a.id?currentConversation().id:'',text:'/tools'});}));
    };
    await draw();
  }
  function openMcpManager(editId=''){
    const list=state.mcpServers||[],s=list.find(x=>x.id===editId)||null,adding=editId==='new';
    const form=adding||s?`<form id="mcp-form" class="mcp-form">
      <div class="form-grid"><label>Name<input name="name" required maxlength="40" pattern="[a-zA-Z0-9][a-zA-Z0-9_-]*" value="${esc(s?.name||'')}" placeholder="github"></label>
      <label>Type<select name="type"><option value="stdio" ${s?.type==='stdio'||!s?'selected':''}>Program (stdio)</option><option value="http" ${s?.type==='http'?'selected':''}>HTTP</option><option value="sse" ${s?.type==='sse'?'selected':''}>SSE</option></select></label></div>
      <div data-mcp="stdio"><label>Command<input name="command" value="${esc(s?.command||'')}" placeholder="npx"></label><label>Arguments <small>one per line</small><textarea name="args" rows="3" placeholder="-y&#10;@modelcontextprotocol/server-github">${esc((s?.args||[]).join('\n'))}</textarea></label>
        <label>Environment variables <small>NAME=value, one per line. Stored encrypted. ${s?.envNames?.length?`Saved: ${esc(s.envNames.join(', '))}. Leave empty to keep them.`:''}</small><textarea name="env" rows="2" class="secret-text" autocomplete="off" spellcheck="false" placeholder="GITHUB_PERSONAL_ACCESS_TOKEN=..."></textarea></label></div>
      <div data-mcp="remote"><label>URL<input name="url" value="${esc(s?.url||'')}" placeholder="https://mcp.example.com/mcp"></label>
        <label>Headers <small>Name: value, one per line. Stored encrypted. ${s?.headerNames?.length?`Saved: ${esc(s.headerNames.join(', '))}. Leave empty to keep them.`:''}</small><textarea name="headers" rows="2" class="secret-text" autocomplete="off" spellcheck="false" placeholder="Authorization: Bearer ..."></textarea></label></div>
      <fieldset class="mcp-agents"><legend>Use with</legend><label class="check-row inline"><input type="radio" name="scope" value="all" ${!s||s.agents==='all'?'checked':''}> All agents</label><label class="check-row inline"><input type="radio" name="scope" value="some" ${s&&s.agents!=='all'?'checked':''}> Chosen agents</label>
        <div class="mcp-agent-list">${state.agents.map(x=>`<label class="check-row inline"><input type="checkbox" name="agent" value="${esc(x.id)}" ${s&&s.agents!=='all'&&s.agents.includes(x.id)?'checked':''}> ${esc(title(x))}</label>`).join('')}</div></fieldset>
      <label>Note<input name="note" maxlength="300" value="${esc(s?.note||'')}" placeholder="What this server is for"></label>
      <label class="check-row inline"><input type="checkbox" name="enabled" ${!s||s.enabled?'checked':''}> Enabled</label>
      <div class="modal-footer"><div></div><div><button type="button" class="secondary" id="mcp-cancel">Back</button><button class="primary" type="submit">Save server</button></div></div></form>`:'';
    const added=new Set(list.map(x=>x.name)),cat=mcpCatalogCache||[];
    const oneClick=cat.length?`<h3 class="mcp-head">Add with one click</h3><div class="mcp-catalog">${cat.map(c=>{const on=c.own?state.agents.filter(x=>hasBrowser(x)).length:added.has(c.name);return `<div class="mcp-card${c.own?' own':''}"><div><strong>${esc(c.title)}</strong>${c.own?'<em>Opaya</em>':c.secret&&!c.secret.optional?'<em>needs a key</em>':''}<p>${esc(c.description)}</p>${c.needs?`<small>Needs ${esc(c.needs)} where the agent runs.</small>`:''}</div><button class="secondary small ${on?'is-on':''}" data-mcp-install="${esc(c.id)}">${c.own?(on?`On for ${on}`:'Turn on'):on?'Added':'Add'}</button></div>`;}).join('')}</div><h3 class="mcp-head">Your MCP servers</h3>`:'';
    modal('MCP servers','Tools your agents can call. Add one with a click: Opaya passes it to Hermes and other ACP agents and writes it into Claude Code, Codex and OpenClaw configs.',`${adding||s?form:`${libTabs('mcp')}${oneClick}<div class="skill-list">${list.map(x=>`<div class="skill-row"><div><strong>${esc(x.name)}</strong><em>${esc(x.type)}${x.enabled?'':' / off'}</em><p>${esc(x.type==='stdio'?`${x.command} ${x.args.join(' ')}`:x.url)}</p><p>${x.agents==='all'?'All agents':`${x.agents.length} agent${x.agents.length===1?'':'s'}`}${x.envNames.length||x.headerNames.length?` / secrets: ${esc([...x.envNames,...x.headerNames].join(', '))}`:''}</p></div><div class="row-actions"><button class="secondary small" data-mcp-edit="${esc(x.id)}">Edit</button><button class="text-button danger-text" data-mcp-remove="${esc(x.id)}">Remove</button></div></div>`).join('')||'<p class="field-help">No MCP servers yet.</p>'}</div>
      <div class="mcp-examples"><p class="field-help">Another server: <code>npx -y some-mcp-server</code>, <code>uvx mcp-server-fetch</code>, or an HTTPS server such as <code>https://mcp.example.com/mcp</code>.</p></div>
      <div class="modal-footer"><div></div><div><button class="secondary" id="mcp-add">Add another server by hand</button></div></div>`}`,true);
    $('#mcp-add')&&($('#mcp-add').onclick=()=>openMcpManager('new'));
    if(!mcpCatalogCache&&!adding&&!s)api.mcpCatalog?.().then(c=>{mcpCatalogCache=c||[];if(!$('#mcp-form')&&document.querySelector('[data-mcp-edit],#mcp-add'))openMcpManager();}).catch(()=>{mcpCatalogCache=[];});
    for(const b of document.querySelectorAll('[data-mcp-install]'))b.onclick=()=>{const c=cat.find(x=>x.id===b.dataset.mcpInstall);if(c)openMcpInstall(c);};
    for(const b of document.querySelectorAll('[data-mcp-edit]'))b.onclick=()=>openMcpManager(b.dataset.mcpEdit);
    for(const b of document.querySelectorAll('[data-mcp-remove]'))b.onclick=()=>action(async()=>{const x=list.find(y=>y.id===b.dataset.mcpRemove);if(!await ask(`Remove MCP server ${x?.name}? Its saved secrets are deleted.`))return;await api.mcpRemove({id:b.dataset.mcpRemove});await refresh();openMcpManager();});
    const f=$('#mcp-form');if(!f)return;const el=n=>f.elements[n];
    const sync=()=>{const stdio=el('type').value==='stdio';f.querySelector('[data-mcp="stdio"]').hidden=!stdio;f.querySelector('[data-mcp="remote"]').hidden=stdio;f.querySelector('.mcp-agent-list').hidden=el('scope').value!=='some';};
    el('type').onchange=sync;for(const r of f.querySelectorAll('[name="scope"]'))r.onchange=sync;sync();
    $('#mcp-cancel').onclick=()=>openMcpManager();
    f.onsubmit=event=>{event.preventDefault();action(async()=>{
      const agents=el('scope').value==='all'?'all':[...f.querySelectorAll('[name="agent"]:checked')].map(c=>c.value);
      modalBusy=true;try{await api.mcpSave({server:{id:s?.id,name:el('name').value.trim(),type:el('type').value,command:el('command').value.trim(),args:el('args').value,url:el('url').value.trim(),agents,note:el('note').value,enabled:el('enabled').checked},env:el('env').value,headers:el('headers').value});}finally{modalBusy=false;}
      await refresh();toast('MCP server saved. New conversations use it.');openMcpManager();
    });};
  }
  let mcpCatalogCache=null;
  // One click: the server comes from Opaya's catalog; the user only picks agents and, when needed, types a key (masked,
  // straight to the vault) or a folder. Opaya's own browser is turned on per agent instead.
  // A key the MCP server needs can come from the Opaya Vault instead of being pasted: the matching name is chosen first.
  const MCP_KEY_NAMES={github:['GITHUB_PERSONAL_ACCESS_TOKEN','GITHUB_TOKEN','GH_TOKEN'],'brave-search':['BRAVE_API_KEY'],context7:['CONTEXT7_API_KEY']};
  function mcpVaultPick(c){
    const keys=vaultKeys();if(!keys.length)return '';const want=MCP_KEY_NAMES[c.id]||[c.secret?.name].filter(Boolean),match=keys.find(k=>want.includes(k.name));
    const sorted=[...keys].sort((x,y)=>want.includes(y.name)-want.includes(x.name)||x.name.localeCompare(y.name));
    return `<label class="mcp-vault-pick">Or use a key from the Opaya Vault<select name="vaultKey"><option value="">Paste it above instead</option>${sorted.map(k=>`<option value="${esc(k.id)}" ${k===match?'selected':''}>${esc(k.name)} (${esc(k.mask)})</option>`).join('')}</select></label>`;
  }
  function openMcpInstall(c){
    const own=c.own,agents=own?state.agents.filter(x=>browserCapable(x)):state.agents,existing=(state.mcpServers||[]).find(x=>x.name===c.name);
    modal(own?'Opaya browser':`Add ${c.title}`,c.description,`<form id="mcp-install" class="mcp-form">
      ${c.secret?`<label>${esc(c.secret.label)}<input name="secret" type="password" autocomplete="off" spellcheck="false" ${c.secret.optional||existing?.envNames?.length||existing?.headerNames?.length?'':'required'} placeholder="${existing&&(existing.envNames.length||existing.headerNames.length)?'Saved. Leave empty to keep it.':'Paste it here'}"><small class="field-help">Stored encrypted in Opaya's vault; it is never shown again.</small></label>${mcpVaultPick(c)}`:''}
      ${c.folder?`<label>${esc(c.folder.label)}<span class="input-row"><input name="folder" required placeholder="/home/you/projects" value="${esc(existing?.args?.at(-1)||'')}"><button type="button" class="secondary small" id="mcp-folder">Browse...</button></span></label>`:''}
      ${own?'':`<fieldset class="mcp-agents"><legend>Use with</legend><label class="check-row inline"><input type="radio" name="scope" value="some" checked> Chosen agents</label><label class="check-row inline"><input type="radio" name="scope" value="all"> All agents</label></fieldset>`}
      <div class="pick-list">${agents.map(x=>`<label class="pick-item"><input type="checkbox" name="agent" value="${esc(x.id)}" ${own?(hasBrowser(x)?'checked':''):(existing?usesMcp(existing,x):x.id===selected()?.id)?'checked':''} ${!own&&!mcpPassed(x)?'disabled':''}><span><strong>${esc(title(x))}</strong><small>${esc(own?(x.vision?.vision===false?'Pages as text (its model reads text only)':'Pages as text and screenshots'):mcpSupport(x))}</small></span></label>`).join('')||'<p class="field-help">No agent on this computer can use the Opaya browser.</p>'}</div>
      ${own?'<p class="field-help">Every agent on this computer (Hermes and other ACP agents, Claude Code, Codex) has its own Opaya browser, on by default. Untick one to take it away.</p>':`<p class="field-help">${c.type==='stdio'?`Runs <code>${esc(c.command)}</code> on the machine where each agent runs. `:`Connects to ${esc(c.url||'')}. `}Opaya asks before it writes anything into an agent's config.</p>`}
      <div class="modal-footer"><div><button type="button" class="text-button" id="mcp-back">Back</button></div><div><button type="button" class="secondary" data-action="modal-close">Cancel</button><button class="primary" type="submit">${own?'Save':existing?'Update':'Add'}</button></div></div></form>`,true);
    const f=$('#mcp-install');$('#mcp-back').onclick=()=>openMcpManager();
    const vk=f.elements.vaultKey,sec=f.elements.secret;if(vk&&sec){const need=sec.required,syncKey=()=>{sec.required=need&&!vk.value;sec.disabled=!!vk.value;sec.placeholder=vk.value?'Using the key from the Vault':'Paste it here';};vk.addEventListener('change',syncKey);syncKey();}
    $('#mcp-folder')&&($('#mcp-folder').onclick=()=>action(async()=>{const dir=await api.pick({kind:'directory'});if(dir)f.elements.folder.value=dir;}));
    const sync=()=>{const all=f.querySelector('[name="scope"]:checked')?.value==='all';for(const i of f.querySelectorAll('[name="agent"]'))i.closest('label').hidden=all&&!own;};
    for(const r of f.querySelectorAll('[name="scope"]'))r.onchange=sync;sync();
    f.onsubmit=event=>{event.preventDefault();const picked=[...f.querySelectorAll('[name="agent"]:checked')].map(i=>i.value);
      action(async()=>{
        if(own){for(const x of agents)if(hasBrowser(x)!==picked.includes(x.id))await api.updateAgentDisplay({id:x.id,browser:picked.includes(x.id)});await refresh();toast(picked.length?`The Opaya browser is on for ${plural(picked.length,'agent')} from their next conversation.`:'The Opaya browser is off.');openMcpManager();return;}
        const scope=f.querySelector('[name="scope"]:checked')?.value==='all'?'all':picked;
        if(Array.isArray(scope)&&!scope.length){toast('Choose at least one agent.',true);return;}
        modalBusy=true;let r;try{r=await api.mcpInstall({id:c.id,secret:f.elements.secret?.value||'',vaultKey:f.elements.vaultKey?.value||'',folder:f.elements.folder?.value||'',agents:scope});}finally{modalBusy=false;}
        if(f.elements.secret)f.elements.secret.value='';
        await refresh();toast(r?.warnings?.length?`${c.title} saved, with problems: ${r.warnings.join(' ')}`:`${c.title} added. New conversations use it.`,!!r?.warnings?.length);openMcpManager();
      });};
  }
  // "/" in the message box lists the agent's commands and installed skills.
  let slash={items:[],index:0,open:false};
  function slashItems(a,query){
    const skills=skillCache.get(a.id)?.skills||[],seen=new Set(),out=[];
    for(const x of [...(a.commands||[]).map(c=>({name:c.name,description:c.description,kind:'command'})),...skills.map(s=>({name:s.name,description:s.description,kind:'skill'}))]){if(seen.has(x.name))continue;seen.add(x.name);if(x.name.toLowerCase().includes(query))out.push(x);}
    return out.sort((x,y)=>(y.name.toLowerCase().startsWith(query))-(x.name.toLowerCase().startsWith(query))).slice(0,8);
  }
  function closeSlash(){slash.open=false;$('#slash-menu')?.remove();}
  function updateSlash(){
    const a=selected(),input=$('#message-input');if(!a||!input||opayaView||playgroundView||overview){closeSlash();return;}
    const m=/^\/([\w.:-]*)$/.exec(input.value);if(!m){closeSlash();return;}
    if(!skillCache.has(a.id))loadSkills(a.id).then(()=>updateSlash()).catch(()=>skillCache.set(a.id,{skills:[],dirs:[],supported:false}));
    slash.items=slashItems(a,m[1].toLowerCase());slash.index=Math.min(slash.index,Math.max(0,slash.items.length-1));
    if(!slash.items.length){closeSlash();return;}
    let menu=$('#slash-menu');if(!menu){menu=document.createElement('div');menu.id='slash-menu';menu.className='slash-menu';menu.setAttribute('role','listbox');$('#message-form').prepend(menu);}
    slash.open=true;
    menu.innerHTML=slash.items.map((x,i)=>`<button type="button" role="option" class="${i===slash.index?'active':''}" aria-selected="${i===slash.index}" data-slash="${i}"><strong>/${esc(x.name)}</strong><em>${x.kind}</em><span>${esc(x.description||'')}</span></button>`).join('');
    for(const b of menu.querySelectorAll('[data-slash]'))b.onmousedown=event=>{event.preventDefault();pickSlash(Number(b.dataset.slash));};
  }
  function pickSlash(i){const x=slash.items[i],input=$('#message-input');if(!x||!input)return;input.value=`/${x.name} `;drafts.set(draftKey(),input.value);closeSlash();input.focus();}
  function slashKey(event){
    if(!slash.open)return false;
    if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();slash.index=(slash.index+(event.key==='ArrowDown'?1:-1)+slash.items.length)%slash.items.length;updateSlash();return true;}
    if(event.key==='Enter'||event.key==='Tab'){event.preventDefault();pickSlash(slash.index);return true;}
    if(event.key==='Escape'){event.preventDefault();closeSlash();return true;}
    return false;
  }
  // ---- Projects panel: folders, the agents that work in them and their chats, with git actions --------------------
  let projectFilter='',projectsHtml='';const projectGit=new Map();
  const projectOf=c=>c?.projectId?(state.projects||[]).find(p=>p.id===c.projectId):null;
  const hostName=id=>id?(state.hosts.find(h=>h.id===id)?.name||'Machine'):localName();
  // Runs on the same machine as the folder (containers use their own paths); or has its own copy of the project.
  const fitsHere=(a,p)=>a.command!=='docker'&&(p.hostId?a.transport==='ssh'&&a.hostId===p.hostId:a.transport!=='ssh');
  const fitsProject=(a,p)=>!!(p.remotes||[]).some(r=>r.agentId===a.id)||fitsHere(a,p);
  const ago=iso=>{const s=Math.max(0,(Date.now()-new Date(iso).getTime())/1000);return s<60?'now':s<3600?`${Math.floor(s/60)}m`:s<86400?`${Math.floor(s/3600)}h`:s<604800?`${Math.floor(s/86400)}d`:new Date(iso).toLocaleDateString([],{month:'short',day:'numeric'});};
  const saveProjectsView=()=>saveView();
  function toggleProjects(force){projectsOpen=force??!projectsOpen;if(projectsOpen&&historyOpen){historyOpen=false;renderHistory();}renderProjects();saveProjectsView();if(projectsOpen)refreshProjectGit();}
  async function loadProjectGit(p){
    const entry=projectGit.get(p.id)||{};if(entry.loading)return;entry.loading=true;projectGit.set(p.id,entry);
    try{const info=await api.projectInfo({id:p.id});projectGit.set(p.id,{info,at:Date.now()});}catch(error){projectGit.set(p.id,{error:error.message,at:Date.now()});}
    renderProjects();
  }
  function refreshProjectGit(force=false){for(const p of state.projects||[]){const e=projectGit.get(p.id);if(force||!e||Date.now()-(e.at||0)>60000)loadProjectGit(p);}}
  function projectChats(p){return state.conversations.filter(c=>c.projectId===p.id).slice().sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)));}
  function renderProjects(){
    const box=$('#projects-panel');if(!box)return;
    box.hidden=!projectsOpen;document.body.classList.toggle('projects-open',projectsOpen);
    $('#projects-toggle')?.classList.toggle('selected',projectsOpen);
    if(!projectsOpen)return;
    const list=(state.projects||[]).filter(p=>!projectFilter||`${p.name} ${p.path}`.toLowerCase().includes(projectFilter));
    const active=currentConversation()?.projectId||'';
    const card=p=>{
      const open=projectsExpanded.has(p.id),g=projectGit.get(p.id),git=g?.info?.git,agents=p.agentIds.map(id=>state.agents.find(a=>a.id===id)).filter(Boolean),chats=projectChats(p);
      const working=agents.some(a=>a.busy);
      return `<section class="project-card ${open?'open':''} ${active===p.id?'current':''}" data-project-id="${esc(p.id)}">
        <div class="project-row">
          <button type="button" class="project-head" data-action="project-toggle" data-id="${esc(p.id)}" aria-expanded="${open}"><span class="project-chevron" aria-hidden="true">&#9656;</span><span class="project-folder" aria-hidden="true"></span><span class="project-name">${esc(p.name)}</span>${working?'<span class="status-dot working" title="An agent is working"></span>':''}</button>
          ${git?`<button type="button" class="project-branch ${git.changes.length?'dirty':''}" data-action="project-git" data-id="${esc(p.id)}" title="Git actions">&#5833; ${esc((git.branch||'').split('...')[0].slice(0,24)||'git')}${git.changes.length?` <b>${git.changes.length>=60?'60+':git.changes.length}</b>`:''}</button>`:g?.error?'<span class="project-branch muted" title="Folder not found or not reachable">!</span>':''}
        </div>
        ${open?`<div class="project-body">
          <div class="project-path" title="${esc(p.path)}">${esc(hostName(p.hostId))} <span>/</span> ${esc(p.path)}</div>
          ${remoteAgents(p).map(a=>{const r=remoteOf(a,p);return `<div class="project-link" data-pa-agent="${esc(a.id)}"><span class="project-link-who">${esc(title(a))} <small>${esc(agentPlace(a))} / ${remoteState(r)}</small></span><span><button type="button" class="text-button" data-action="copy-send" data-id="${esc(p.id)}" data-agent="${esc(a.id)}" title="Send your latest changes to ${esc(title(a))}">&#8593; Send</button><button type="button" class="text-button" data-action="copy-bring" data-id="${esc(p.id)}" data-agent="${esc(a.id)}" title="Bring ${esc(title(a))}'s changes back for review">&#8595; Bring back</button></span></div>`;}).join('')}
          ${!p.hostId&&!(p.remotes||[]).length&&state.agents.some(a=>remoteCapable(a,p))?`<button type="button" class="text-button project-share" data-action="project-remote" data-id="${esc(p.id)}">&#8599; Let an agent on a server work on it</button>`:''}
          <div class="project-agents">${agents.map(a=>`<button type="button" class="project-agent" data-action="project-chat" data-id="${esc(p.id)}" data-agent="${esc(a.id)}" data-pa-agent="${esc(a.id)}" title="New chat with ${esc(title(a))} in ${esc(p.name)}${remoteOf(a,p)?` (its copy ${esc(agentPlace(a))})`:''}">${badge(a)}<span>${esc(title(a))}</span>${remoteOf(a,p)?'<small class="project-agent-where">&#8646;</small>':''}${dot(a)}</button>`).join('')}<button type="button" class="project-agent add" data-action="project-add-agent" data-id="${esc(p.id)}" title="Add or remove agents">+ Agent</button></div>
          <div class="project-chats">${chats.slice(0,8).map(c=>{const a=state.agents.find(x=>x.id===c.agentId);return `<button type="button" class="project-chat ${c.id===state.activeConversationId&&!overview&&!opayaView&&!playgroundView?'selected':''}" data-action="project-open-chat" data-id="${esc(c.id)}">${a?badge(a):''}<span class="project-chat-title">${esc(c.title)}</span>${a?.busy&&state.activeConversationId===c.id?'<span class="status-dot working"></span>':`<small>${esc(ago(c.createdAt))}</small>`}</button>`;}).join('')||`<p class="project-empty">${agents.length?'No chats yet. Pick an agent above to start one.':'Add an agent to start a chat in this folder.'}</p>`}${chats.length>8?`<p class="project-empty">${chats.length-8} older chats in each agent's history.</p>`:''}</div>
          <div class="project-tools"><button type="button" class="text-button" data-action="project-files" data-id="${esc(p.id)}">Files</button><button type="button" class="text-button" data-action="project-terminal" data-id="${esc(p.id)}">&gt;_ Terminal</button><button type="button" class="text-button" data-action="project-git" data-id="${esc(p.id)}">Git</button></div>
        </div>`:''}
      </section>`;
    };
    const html=`<header class="projects-header"><strong>Projects</strong><small>${(state.projects||[]).length||''}</small></header>
      <div class="projects-toolbar">${(state.projects||[]).length>5?`<input id="projects-filter" placeholder="Filter projects..." aria-label="Filter projects" value="${esc(projectFilter)}">`:'<span></span>'}<button class="icon-button" data-action="project-refresh" title="Refresh git status" aria-label="Refresh git status">&#8635;</button><button class="icon-button" data-action="project-new" title="Add project" aria-label="Add project">+</button><button class="icon-button" data-action="projects-close" title="Close projects (${mod()}Shift+P)" aria-label="Close projects">&#10005;</button></div>
      <div class="projects-list">${list.map(card).join('')||((state.projects||[]).length?'<p class="project-empty">No project matches.</p>':`<div class="projects-intro"><span class="project-folder big" aria-hidden="true"></span><strong>Keep work together.</strong><p>A project is a folder with the agents that work in it. Their chats, git status and actions live here.</p><button class="primary" data-action="project-new">Add project</button></div>`)}</div>
      <footer class="projects-footer">Right-click a project for git and GitHub</footer>`;
    if(projectsHtml===html)return;projectsHtml=html;box.innerHTML=html;
    const filter=$('#projects-filter');if(filter)filter.oninput=()=>{projectFilter=filter.value.toLowerCase();const at=filter.selectionStart;renderProjects();const f=$('#projects-filter');f?.focus();f?.setSelectionRange(at,at);};
  }
  // ---- Chat history: a right-side panel per agent with project, regular and playground chats ---------------------
  let historyOpen=false,historyFilter='',historyTab='all',historyAgent='',historyHtml='',historyFollow='';
  const chatKind=c=>c.projectId?'project':c.kind==='playground'||/^Playground: /.test(c.title||'')?'playground':'chat';
  const chatChip=c=>{const k=chatKind(c),p=projectOf(c);return k==='project'?`<span class="chat-chip project" title="Project chat: ${esc(p?.name||'removed project')}"><span class="project-folder" aria-hidden="true"></span>${esc(p?.name||'Project')}</span>`:k==='playground'?'<span class="chat-chip playground" title="Playground chat">Playground</span>':'';};
  const chatLabel=c=>{const p=projectOf(c);return p?`[${p.name}] ${c.title}`:chatKind(c)==='playground'?c.title:c.title;};
  function toggleHistory(force,agentId){
    historyOpen=force??!historyOpen;
    if(!historyOpen)tipsSeen.add('history-closed');else tipsSeen.delete('history-closed');saveView();
    if(historyOpen){historyAgent=agentId??selected()?.id??'';historyFollow=selected()?.id||'';if(projectsOpen){projectsOpen=false;renderProjects();saveProjectsView();}}
    historyHtml='';renderHistory();
  }
  function renderHistory(){
    const box=$('#history-panel');if(!box)return;
    box.hidden=!historyOpen;document.body.classList.toggle('history-panel-open',historyOpen);
    for(const b of document.querySelectorAll('[data-action="history-toggle"]'))b.classList.toggle('selected',historyOpen);
    if(!historyOpen)return;
    if(historyAgent&&!state.agents.some(a=>a.id===historyAgent))historyAgent='';
    const all=state.conversations.filter(c=>!historyAgent||c.agentId===historyAgent).slice().sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)));
    const counts={all:all.length,chat:0,project:0,playground:0};for(const c of all)counts[chatKind(c)]++;
    const list=all.filter(c=>(historyTab==='all'||chatKind(c)===historyTab)&&(!historyFilter||`${c.title} ${projectOf(c)?.name||''}`.toLowerCase().includes(historyFilter)));
    const busyIn=c=>state.agents.find(a=>a.id===c.agentId)?.busy&&state.activeConversationId===c.id;
    const row=c=>{const a=state.agents.find(x=>x.id===c.agentId);return `<div class="history-row ${c.id===state.activeConversationId&&!overview&&!opayaView&&!playgroundView?'current':''}" data-hist="${esc(c.id)}">
      <button type="button" class="history-open" data-hist-act="open" title="${esc(c.title)}">${!historyAgent&&a?badge(a):''}<span class="history-text"><span class="history-title">${esc(c.title)}</span><span class="history-meta">${chatChip(c)}${c.essence?`<span class="essence-mark" title="Condensed by ${esc(c.essence.by||'')}">&#10022; Essence</span>`:''}<small>${busyIn(c)?'<span class="status-dot working"></span>':esc(ago(c.createdAt))}</small></span></span></button>
      <div class="history-actions"><button type="button" class="term-icon" data-hist-act="condense" title="Condense to the essence" aria-label="Condense"><span aria-hidden="true">&#8860;</span></button><button type="button" class="term-icon" data-hist-act="share" title="Share" aria-label="Share"><span aria-hidden="true">&#8599;</span></button><button type="button" class="term-icon danger" data-hist-act="delete" title="Delete chat" aria-label="Delete chat"><span aria-hidden="true">&#10005;</span></button></div></div>`;};
    const group=(label,items)=>items.length?`<div class="history-group"><div class="history-group-label">${esc(label)}<small>${items.length}</small></div>${items.map(row).join('')}</div>`:'';
    const buckets=[];
    for(const c of list){const label=dayLabel(c.createdAt);let b=buckets.find(x=>x[0]===label);if(!b)buckets.push(b=[label,[]]);b[1].push(c);}
    const tabs=[['all','All'],['chat','Chats'],['project','Projects'],['playground','Playground']];
    const html=`<header class="projects-header"><strong>History</strong><small>${all.length||''}</small></header>
      <div class="history-toolbar"><select id="history-agent" aria-label="Agent"><option value="">All agents</option>${state.agents.map(a=>`<option value="${esc(a.id)}" ${a.id===historyAgent?'selected':''}>${esc(title(a))}</option>`).join('')}</select><button class="icon-button" data-action="history-toggle" title="Close history" aria-label="Close history">&#10005;</button></div>
      <div class="history-tabs" role="tablist">${tabs.map(([k,l])=>`<button type="button" role="tab" class="${historyTab===k?'selected':''}" data-hist-tab="${k}">${l}${counts[k]?` <small>${counts[k]}</small>`:''}</button>`).join('')}</div>
      <div class="history-search"><input id="history-filter" placeholder="Search chats..." aria-label="Search chats" value="${esc(historyFilter)}"></div>
      <div class="history-list">${buckets.map(([l,items])=>group(l,items)).join('')||`<div class="history-empty"><span aria-hidden="true">&#9719;</span><p>${all.length?'No chat matches.':'No chats yet.'}</p></div>`}</div>
      <footer class="projects-footer">Right-click a chat for more</footer>`;
    if(historyHtml===html)return;historyHtml=html;box.innerHTML=html;
    const f=$('#history-filter');f.oninput=()=>{historyFilter=f.value.toLowerCase();const at=f.selectionStart;renderHistory();const n=$('#history-filter');n?.focus();n?.setSelectionRange(at,at);};
    $('#history-agent').onchange=e=>{historyAgent=e.target.value;renderHistory();};
  }
  function historyMenu(c){
    return [
      {icon:'&#8599;',label:'Open',run:()=>openProjectChat(c.id)},
      {icon:'&#9998;',label:'Rename...',run:()=>renameChat(c)},
      '-',
      {icon:'&#8860;',label:c.essence?'Condense again...':'Condense...',run:()=>condenseChat(c)},
      c.essence&&{icon:'&#10022;',label:'View essence',run:()=>openEssence(c.id)},
      '-',
      ...shareItems(c),
      '-',
      {icon:'&#10005;',label:'Delete chat...',danger:true,run:()=>deleteChat(c)}
    ];
  }
  function shareItems(c){
    return [
      {icon:'&#10697;',label:'Copy as Markdown',run:async()=>{await api.clipboardWrite({text:await api.conversationMarkdown({id:c.id})});toast('Chat copied as Markdown.');}},
      c.essence&&{icon:'&#10022;',label:'Copy essence',run:async()=>{await api.clipboardWrite({text:await api.conversationMarkdown({id:c.id,essence:true})});toast('Essence copied.');}},
      {icon:'&#8595;',label:'Save as Markdown file...',run:async()=>{if(await api.exportConversation({id:c.id}))toast('Chat saved.');}},
      {icon:'&#8644;',label:'Send to another agent...',disabled:state.agents.length<2&&!c.essence,run:()=>sendChatTo(c)}
    ];
  }
  document.addEventListener('click',event=>{
    const tab=event.target.closest('[data-hist-tab]');if(tab){historyTab=tab.dataset.histTab;renderHistory();return;}
    const b=event.target.closest('[data-hist-act]');if(!b)return;const id=b.closest('[data-hist]')?.dataset.hist,c=state.conversations.find(x=>x.id===id);if(!c)return;
    const act=b.dataset.histAct;
    if(act==='open')action(()=>openProjectChat(c.id));
    else if(act==='condense')condenseChat(c);
    else if(act==='delete')deleteChat(c);
    else if(act==='share'){const r=b.getBoundingClientRect();openMenu(r.left-180,r.bottom+4,shareItems(c),'Share',b);}
  });
  document.addEventListener('contextmenu',event=>{const r=event.target.closest('#history-panel [data-hist],#agent-side [data-hist]'),pc=event.target.closest('[data-action="project-open-chat"]');if(!r&&!pc)return;const c=state.conversations.find(x=>x.id===(r?r.dataset.hist:pc.dataset.id));if(!c)return;event.preventDefault();event.stopPropagation();openMenu(event.clientX,event.clientY,historyMenu(c),c.title);},true);
  function renameChat(c){
    modal('Rename chat','',`<form id="chat-rename-form"><label class="field"><span>Title</span><input name="title" value="${esc(c.title)}" maxlength="120" autocomplete="off" required></label><div class="modal-footer"><div></div><div><button type="button" class="secondary" data-action="modal-close">Cancel</button><button class="primary" type="submit">Rename</button></div></div></form>`);
    const f=$('#chat-rename-form');f.elements.title.select();
    f.onsubmit=event=>{event.preventDefault();action(async()=>{await api.renameConversation({id:c.id,title:f.elements.title.value});closeModal();await refresh();});};
  }
  async function deleteChat(c){
    const a=state.agents.find(x=>x.id===c.agentId);
    if(!await ask(`Delete "${c.title}"?\n\nOpaya deletes this ${chatKind(c)==='project'?'project chat':chatKind(c)==='playground'?'playground chat':'chat'} and its transcript${a?` with ${title(a)}`:''}. This cannot be undone.`))return;
    await action(async()=>{await api.deleteConversation({id:c.id});await refresh();toast('Chat deleted.');});
  }
  // Condense: reads the whole chat and keeps only its essence. Uses the Opaya Agent's model API when it has a key,
  // otherwise the chat's own agent. Either way it costs tokens, so the user confirms first.
  async function condenseChat(c){
    const a=state.agents.find(x=>x.id===c.agentId),o=opaya(),local=['ollama','lmstudio'].includes(o.config?.preset);
    const model=o.configured&&!['codex','claude'].includes(o.config?.preset)&&(o.hasKey||local)?`${o.presets?.[o.config.preset]?.label||'Model API'} / ${o.config.model}`:'';
    let size=0;try{size=(await api.conversationMarkdown({id:c.id})).length;}catch{}
    const tokens=Math.round(size/4);
    modal('Condense chat',c.title,`<div class="condense-body">
      <div class="condense-warning"><span aria-hidden="true">!</span><div><strong>This uses tokens.</strong><p>Opaya sends the whole chat, about <b>${tokens.toLocaleString()}</b> tokens${size>120000?' (very long chats are trimmed to the start and the latest part)':''}, and keeps only the essence: goal, key points, decisions and open items.</p></div></div>
      <div class="condense-engine ${model?'model':'agent'}"><strong>${model?`With the Opaya model: ${esc(model)}`:`With ${esc(a?title(a):'the agent')} itself`}</strong><p>${model?'Its API key pays for it. The agent\'s own session is not touched.':`No Opaya model API key is set, so ${esc(a?title(a):'the agent')} condenses its own chat. Its answer also appears in this chat. <button type="button" class="text-button" data-action="opaya-config">Set an Opaya model API key</button>`}</p></div>
      <div class="modal-footer"><div></div><div><button type="button" class="secondary" data-action="modal-close">Cancel</button><button type="button" class="primary" id="condense-go">Condense</button></div></div></div>`);
    $('#condense-go').onclick=()=>action(async()=>{await api.condenseConversation({id:c.id});closeModal();});
  }
  async function openEssence(id){
    const c=state.conversations.find(x=>x.id===id);if(!c)return;
    let text='';try{text=await api.conversationMarkdown({id,essence:true});}catch(error){toast(error.message,true);return;}
    const body=text.replace(/^# .*\n\n.*\n\n/,'');
    modal('Essence',`${c.title}${c.essence?.by?` / condensed by ${c.essence.by}`:''}`,`<div class="essence-body message-content">${format(body)}</div>
      <div class="modal-footer"><div><button type="button" class="text-button" id="essence-again">Condense again</button></div><div><button type="button" class="secondary" id="essence-copy">Copy</button><button type="button" class="secondary" id="essence-send">Send to agent...</button><button type="button" class="primary" id="essence-new">New chat from essence</button></div></div>`,true);
    $('#essence-copy').onclick=()=>action(async()=>{await api.clipboardWrite({text});toast('Essence copied.');});
    $('#essence-again').onclick=()=>condenseChat(c);
    $('#essence-send').onclick=()=>sendChatTo(c,true);
    $('#essence-new').onclick=()=>action(()=>startChatWith(c.agentId,essencePrompt(c,body),c.projectId));
  }
  const essencePrompt=(c,body)=>`Context from an earlier chat ("${c.title}"):\n\n${body.trim()}\n\n---\n\n`;
  async function startChatWith(agentId,text,projectId=''){
    const a=state.agents.find(x=>x.id===agentId),p=projectId&&(state.projects||[]).find(x=>x.id===projectId);
    const fits=p&&(p.hostId||'')===(a?.transport==='ssh'?a.hostId:'');
    const c=await api.newConversation({agentId,projectId:fits?projectId:''});agentModes.set(agentId,'chat');
    closeModal();overview=false;opayaView=false;playgroundView=false;drafts.set(c.id,text);await api.saveDraft({agentId,conversationId:c.id,text});await refresh();
    const input=$('#message-input');if(input&&currentConversation()?.id===c.id){input.value=text;input.focus();input.setSelectionRange(text.length,text.length);input.dispatchEvent(new Event('input'));}
  }
  function sendChatTo(c,essenceOnly=false){
    const others=state.agents;const a=state.agents.find(x=>x.id===c.agentId);
    modal('Send to another agent',`Start a chat with the context of "${c.title}".`,`<form id="send-chat-form" class="mcp-form"><label>Agent<select name="agentId">${others.map(x=>`<option value="${esc(x.id)}" ${x.id===others.find(y=>y.id!==c.agentId)?.id?'selected':''}>${esc(title(x))} / ${esc(labels[x.provider]||x.provider)} / ${esc(location(x))}</option>`).join('')}</select></label>
      <fieldset class="clone-choice"><legend>What to send</legend><div class="clone-where">${c.essence?`<label class="choice-card small"><input type="radio" name="what" value="essence" checked><span><strong>Essence</strong><small>Short, saves tokens</small></span></label>`:''}${essenceOnly?'':`<label class="choice-card small"><input type="radio" name="what" value="full" ${c.essence?'':'checked'}><span><strong>Whole chat</strong><small>Everything ${esc(a?title(a):'')} and you said</small></span></label>`}</div></fieldset>
      ${c.essence?'':'<p class="field-help">Tip: condense the chat first to send only its essence.</p>'}
      <p class="field-help">Opaya opens a new chat with the context in the message box. Review it, then send.</p>
      <div class="modal-footer"><div></div><div><button type="button" class="secondary" data-action="modal-close">Cancel</button><button class="primary" type="submit">Open chat</button></div></div></form>`);
    const f=$('#send-chat-form');
    f.onsubmit=event=>{event.preventDefault();action(async()=>{const what=f.querySelector('[name="what"]:checked')?.value||'essence';
      let text;if(what==='essence'){text=essencePrompt(c,(await api.conversationMarkdown({id:c.id,essence:true})).replace(/^# .*\n\n.*\n\n/,''));}
      else{const md=await api.conversationMarkdown({id:c.id});text=`Context from an earlier chat ("${c.title}"):\n\n${md.length>60000?md.slice(-60000):md}\n\n---\n\n`;}
      await startChatWith(f.elements.agentId.value,text,c.projectId);});};
  }
  function ensureProjectsToggle(){
    const bar=$('#topbar');if(!bar||$('#projects-toggle',bar))return;
    const button=document.createElement('button');button.id='projects-toggle';button.type='button';button.className='icon-button projects-toggle';button.dataset.action='projects-toggle';
    button.title=`Projects (${mod()}Shift+P)`;button.setAttribute('aria-label','Projects');button.innerHTML='<span class="project-folder" aria-hidden="true"></span>';
    button.classList.toggle('selected',projectsOpen);
    const web=document.createElement('button');web.id='browser-toggle';web.type='button';web.className='icon-button projects-toggle';web.dataset.action='browser-toggle';web.title='Opaya browser';web.setAttribute('aria-label','Opaya browser');web.innerHTML='<span class="globe-glyph" aria-hidden="true"></span>';
    web.classList.toggle('selected',!$('#browser-panel').hidden);
    // One group at the right end, after the view's own actions.
    const tools=document.createElement('div');tools.className='topbar-tools';
    tools.append(web,button);bar.append(tools);
  }
  async function startProjectChat(p,agentId){
    await api.newConversation({agentId,projectId:p.id});agentModes.set(agentId,'chat');overview=false;opayaView=false;playgroundView=false;await refresh();$('#message-input')?.focus();
  }
  async function openProjectChat(id){const c=state.conversations.find(x=>x.id===id);if(c)agentModes.set(c.agentId,'chat');await api.selectConversation({id});overview=false;opayaView=false;playgroundView=false;await refresh();}
  async function projectTerminal(p){
    await openTerminal({...(p.hostId?{hostId:p.hostId}:{local:true}),projectId:p.id});
  }
  // A git action from the menu: ask for input when it needs one, then run it in the project's terminal.
  async function runGit(p,key){
    const a=(state.gitActions||[]).find(x=>x.key===key);if(!a)return;
    const go=async extra=>{await api.projectGit({id:p.id,action:key,...extra});closeModal();toast(`${a.label}: running in Terminal.`);for(const ms of [3000,10000])setTimeout(()=>loadProjectGit(p),ms);};
    if(!a.input)return go({});
    const fields={message:`<label>Commit message<input name="message" required maxlength="500" placeholder="Describe the change" autocomplete="off"></label>`,
      branch:`<label>New branch name<input name="branch" required maxlength="120" placeholder="feature/projects-panel" autocomplete="off"></label>`,
      number:`<label>Pull request number<input name="number" required inputmode="numeric" pattern="[0-9]+" placeholder="12"></label>`,
      title:`<label>Title <small>leave empty to use the commits</small><input name="title" maxlength="200" placeholder="Add the Projects panel"></label><label>Description <small>optional</small><textarea name="body" rows="3" maxlength="2000"></textarea></label>`,
      pick:`<label>Branch<select name="branch" required><option value="">Loading branches...</option></select></label>`}[a.input];
    modal(a.label,`${p.name} / ${p.path}`,`<form id="git-form" class="mcp-form">${fields}<div class="modal-footer"><div></div><div><button type="button" class="secondary" data-action="modal-close">Cancel</button><button class="primary" type="submit">${esc(a.label)}</button></div></div></form>`);
    const f=$('#git-form');f.querySelector('input,select,textarea')?.focus();
    if(a.input==='pick'){try{const r=await api.projectBranches({id:p.id});const sel=f.elements.branch;sel.innerHTML=r.branches.filter(b=>b!==r.current).map(b=>`<option value="${esc(key==='switch'?b.replace(/^origin\//,''):b)}">${esc(b)}</option>`).join('')||'<option value="">No other branches</option>';}catch(error){toast(error.message,true);}}
    f.onsubmit=event=>{event.preventDefault();const data=Object.fromEntries(new FormData(f));action(()=>go(data));};
  }
  function gitMenu(p,withHeader=false){
    const acts=state.gitActions||[],item=(key,icon)=>{const a=acts.find(x=>x.key===key);return a&&{icon,label:a.label+(a.input?'...':''),run:()=>runGit(p,key)};};
    return [item('status','&#9679;'),item('pull','&#8595;'),item('push','&#8593;'),item('fetch','&#8635;'),item('commit','&#10003;'),item('commitPush','&#10003;'),item('stash','&#8615;'),item('stashPop','&#8613;'),'-',
      item('branchNew','+'),item('switch','&#5833;'),item('merge','&#8644;'),item('log','&#8801;'),'-',
      item('prCreate','&#10549;'),item('prList','&#9776;'),item('prStatus','&#9673;'),item('prView','&#8599;'),item('prCheckout','&#8618;'),item('prMerge','&#8644;'),item('ghLogin','&#9919;')];
  }
  function projectMenu(p){
    const agents=p.agentIds.map(id=>state.agents.find(a=>a.id===id)).filter(Boolean);
    return [...agents.slice(0,4).map(a=>({icon:'+',label:`New chat with ${title(a)}`,run:()=>startProjectChat(p,a.id)})),{icon:'&#9786;',label:'Agents...',run:()=>openProjectAgents(p)},'-',
      !p.hostId&&{icon:'&#8599;',label:'Share with an agent on a server...',run:()=>openProjectAgents(p)},
      ...remoteAgents(p).map(a=>({icon:'&#8646;',label:`${title(a)} (${agentPlace(a)})`,submenu:remoteMenu(p,a)})),'-',
      ...gitMenu(p),'-',
      {icon:'&#9656;',label:'Browse files',run:()=>openFiles({hostId:p.hostId||undefined,path:p.path,label:`${p.name} / ${hostName(p.hostId)}`})},
      {icon:'&gt;_',label:'Terminal here',run:()=>projectTerminal(p)},
      {icon:'&#9998;',label:'Edit project...',run:()=>openProjectForm(p)},
      {icon:'&#10005;',label:'Remove project',danger:true,run:async()=>{if(!await ask(`Remove project ${p.name}? Its chats stay with their agents; the folder is not touched.`))return;await api.projectRemove({id:p.id});await refresh();toast('Project removed.');}}];
  }
  // ---- Remote agents on local projects: one project; each agent on a machine or in a container gets its own copy -----
  const remoteOf=(a,p)=>(p.remotes||[]).find(r=>r.agentId===a.id)||null;
  // Agents that can work on this local project through their own copy.
  const remoteCapable=(a,p)=>!p.hostId&&!fitsHere(a,p)&&a.protocol!=='openai'&&a.transport!=='http'&&a.protocol!=='terminal';
  const agentPlace=a=>a.command==='docker'?`container on ${hostName(a.transport==='ssh'?a.hostId:'')}`:hostName(a.transport==='ssh'?a.hostId:'');
  const remoteAgents=p=>(p.remotes||[]).map(r=>state.agents.find(a=>a.id===r.agentId)).filter(Boolean);
  const remoteState=r=>`${r.mode==='copy'?'plain copy':esc(r.branch)}${r.fetchedAt?` / brought back ${esc(ago(r.fetchedAt))}`:r.sentAt?` / sent ${esc(ago(r.sentAt))}`:''}`;
  const remoteMenu=(p,a)=>{const r=remoteOf(a,p);return [{icon:'+',label:`New chat in ${p.name}`,run:()=>startProjectChat(p,a.id)},{icon:'&#8593;',label:'Send my latest changes',run:()=>sendToRemote(p,a)},{icon:'&#8595;',label:'Bring changes back...',run:()=>bringFromRemote(p,a)},'-',
    a.command!=='docker'&&r&&{icon:'&#9656;',label:'Browse its copy',run:()=>openFiles({hostId:a.hostId||undefined,path:r.dir,label:`${p.name} / ${title(a)}`})},
    {icon:'&#10005;',label:'Stop sharing...',danger:true,run:()=>stopSharing(p,a)}];};
  async function sendToRemote(p,a){
    const r=remoteOf(a,p);if(!r)return;let includeChanges=false;
    if(r.mode==='git'){const info=await api.projectRemoteInfo({id:p.id}).catch(()=>null);if(info?.dirty)includeChanges=await ask(`You have ${info.dirty} uncommitted change${info.dirty===1?'':'s'}. Send them too?\n\nOK sends them along (your folder stays as it is); Cancel sends only your commits.`);}
    else if(r.mode==='copy'&&!await ask(`Copy your folder to ${title(a)} again? Its files are replaced by yours; bring its changes back first if you have not.`))return;
    await api.projectRemoteSend({id:p.id,agentId:a.id,includeChanges});
  }
  async function bringFromRemote(p,a){await api.projectRemoteBring({id:p.id,agentId:a.id});}
  function stopSharing(p,a){
    const r=remoteOf(a,p);if(!r)return;
    modal(`Stop sharing with ${title(a)}?`,`${p.name} / ${agentPlace(a)}`,`<form id="stop-share" class="mcp-form"><p class="field-help">${esc(title(a))} leaves ${esc(p.name)}. Bring its changes back first if you want them; its chats stay in its history.</p>
      <label class="check-row inline"><input type="checkbox" name="remove"> Also delete its copy <code>${esc(r.dir)}</code></label>
      <div class="modal-footer"><span></span><div><button type="button" class="secondary" data-action="modal-close">Cancel</button><button class="primary" type="submit">Stop sharing</button></div></div></form>`);
    $('#stop-share').onsubmit=event=>{event.preventDefault();const deleteCopy=event.target.elements.remove.checked;action(async()=>{closeModal();const res=await api.projectRemoteStop({id:p.id,agentId:a.id,deleteCopy});if(res?.stopped){await refresh();toast(`${title(a)} left ${p.name}${res.deleted?'; its copy was deleted':''}.`);}});};
  }
  // Share with one agent: how the project gets to it. Nothing in your folder changes until you apply its work.
  async function openShare(p,a,step={}){
    const where=agentPlace(a),inContainer=a.command==='docker',head=`Share ${p.name} with ${title(a)}`;
    modal(head,where,`<p class="clone-progress"><span class="status-dot working"></span> Looking at ${esc(p.name)}...</p>`);
    let info;try{info=await api.projectRemoteInfo({id:p.id});}catch(e){modal(head,where,`<div class="inline-notice error-notice">${esc(e.message)}</div>`);return;}
    if(!$('#app-dialog'))return;
    const best=info.git&&info.branch?'git':'copy',mode=step.mode||best,machine=hostName(a.transport==='ssh'?a.hostId:'');
    const method=(value,titleText,text,ok,note='')=>`<label class="remote-method ${ok?'':'off'}"><input type="radio" name="mode" value="${value}" ${mode===value&&ok?'checked':''} ${ok?'':'disabled'}><span><strong>${titleText}</strong>${value===best&&ok?' <em>Recommended</em>':''}<small>${text}</small>${note?`<small class="remote-note">${note}</small>`:''}</span></label>`;
    const slug=v=>String(v||'').toLowerCase().replace(/[^a-z0-9_-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,40)||'project';
    modal(head,`${p.name} / ${info.git?`git, branch ${info.branch||'(detached)'}`:'plain folder'}`,`<form id="remote-work-form">
      <div class="share-agent">${badge(a)}<div><strong>${esc(title(a))}</strong><small>${esc(labels[a.provider]||a.provider)} / ${esc(where)}</small></div></div>
      <p class="field-help">${esc(title(a))} runs ${inContainer?'in a container':`on ${esc(machine)}`}, so it cannot see your folder. It gets its own copy of ${esc(p.name)} and joins the project; you send your changes and bring its work back when you want.</p>
      <div class="remote-step"><span class="remote-step-n">&#8646;</span><div><strong>How the project gets there</strong>
        ${method('git','Git over SSH',`Your branch ${esc(info.branch||'')} goes straight to ${esc(title(a))} with git. It works on its own branch; you review what it did before anything reaches your folder. No GitHub needed.`,info.git&&!!info.branch,info.dirty?`<label class="check-row inline"><input type="checkbox" name="includeChanges" checked> Include my ${info.dirty} uncommitted change${info.dirty===1?'':'s'} (your folder stays as it is)</label>`:'')}
        ${method('github','Through GitHub',inContainer?'Agents in a container use Git over SSH or a plain copy.':info.github?`${esc(machine)} clones ${esc(info.origin)} and the agent pushes its own branch; you fetch it or open a pull request.`:'This project has no GitHub remote (origin).',!inContainer&&info.github&&!!info.branch,!inContainer&&info.github?`${info.unpushed||!info.upstream?`Opaya pushes your ${info.unpushed?`${info.unpushed} unpushed commit${info.unpushed===1?'':'s'}`:'branch'} first. `:''}${esc(machine)} needs access to the repository; if it has none, Opaya opens a GitHub sign-in there.`:'')}
        ${method('copy','Plain copy','The folder is copied (without node_modules, .venv, build output and the like). Bringing back updates changed and new files, and keeps a backup of every file it replaces.',true)}
      </div></div>
      <p class="field-help remote-where">Its copy: ${inContainer?`opaya-projects/${esc(slug(p.name))} in the container's data folder`:`~/opaya-projects/${esc(`${slug(p.name)}-${slug(a.name)}`)} on ${esc(machine)}`}.</p>
      <div class="modal-footer"><button type="button" class="subtle" data-share-back>&#8592; Agents</button><div><button type="button" class="secondary" data-action="modal-close">Cancel</button><button type="submit" class="primary">Share with ${esc(title(a))}</button></div></div></form>`,true);
    const form=$('#remote-work-form');
    form.querySelector('[data-share-back]').onclick=()=>openProjectAgents(p);
    form.addEventListener('submit',event=>{event.preventDefault();const f=event.target;action(async()=>{await api.projectRemoteStart({id:p.id,agentId:a.id,mode:f.elements.mode.value,includeChanges:!!f.elements.includeChanges?.checked});closeModal();});});
  }
  // Review what the agent did before anything touches your folder.
  function openBringReview(r){
    const local=(state.projects||[]).find(x=>x.id===r.projectId),where=r.agentName||'the agent';
    if(r.mode==='copy'){
      modal(`Changes from ${where}`,local?.name||'',r.upToDate?'<p class="field-help">Nothing new: your folder already matches its copy.</p>':`<p class="field-help">Your folder is updated: ${r.changed.length} changed and ${r.added.length} new file${r.added.length===1?'':'s'}. Nothing was deleted.</p><div class="bring-files">${[...r.changed.map(f=>['M',f]),...r.added.map(f=>['A',f])].slice(0,200).map(([k,f])=>`<div><b class="bring-${k}">${k}</b> ${esc(f)}</div>`).join('')}</div>${r.backup?`<p class="field-help">Your previous versions are saved in <code>${esc(r.backup)}</code>. <button type="button" class="text-button" data-action="backup-reveal" data-file="${esc(r.backup)}">Show</button></p>`:''}`+'<div class="modal-footer"><span></span><button class="primary" data-action="modal-close">Done</button></div>',true);
      return;
    }
    if(r.upToDate){modal(`Changes from ${where}`,local?.name||'','<p class="field-help">Nothing new from the agent since you last brought changes back.</p><div class="modal-footer"><span></span><button class="primary" data-action="modal-close">Close</button></div>');return;}
    const kind={M:'changed',A:'new',D:'deleted',R:'renamed'};
    modal(`Changes from ${where}`,`${local?.name||''} / ${r.stat||''}`,`<div class="bring-grid"><section><h3>Commits</h3><div class="bring-commits">${r.commits.map(c=>`<div><code>${esc(c.slice(0,7))}</code> ${esc(c.slice(8))}</div>`).join('')}</div></section>
      <section><h3>Files</h3><div class="bring-files">${r.files.map(f=>{const [k,...rest]=f.split('\t');return `<div title="${esc(kind[k[0]]||k)}"><b class="bring-${esc(k[0])}">${esc(k[0])}</b> ${esc(rest.join(' > '))}</div>`;}).join('')}</div></section></div>
      <p class="field-help"><strong>Apply to my folder</strong> puts these changes into ${esc(local?.name||'your project')} as uncommitted edits, next to your own work, so you can look at them in your editor and commit what you like.${r.canMerge?` <strong>Merge</strong> adds the agent's commits to ${esc(r.branch||'your branch')} as they are.`:''}</p>
      <div class="modal-footer"><div><button type="button" class="subtle" data-bring="diff">Full diff</button><button type="button" class="subtle" data-bring="branch">New branch...</button></div><div>${r.canMerge?'<button type="button" class="secondary" data-bring="merge">Merge commits</button>':''}<button type="button" class="primary" data-bring="apply">Apply to my folder</button></div></div>`,true);
    $('#app-dialog').addEventListener('click',async event=>{const b=event.target.closest('[data-bring]');if(!b)return;const act=b.dataset.bring;
      let branch='';if(act==='branch'){branch=await opayaAsk({title:'Name for the new branch',input:`review/${(r.ref.split('/').pop()||'agent')}`,ok:'Create branch'})||'';if(!branch)return;}
      action(async()=>{await api.projectRemoteApply({id:r.projectId,agentId:r.agentId,action:act,branch});closeModal();toast(act==='apply'?'Applying the changes to your folder in the terminal below.':act==='merge'?'Merging in the terminal below.':act==='branch'?`Creating ${branch} in the terminal below.`:'Showing the diff in the terminal below.');});});
  }
  function agentChecks(p,hostId){
    return state.agents.filter(a=>a.protocol!=='terminal').map(a=>{const ok=fitsHere(a,{hostId});return `<label class="check-row inline project-agent-check ${ok?'':'off'}" title="${ok?'':'Runs on another machine than this folder'}"><input type="checkbox" name="agent" value="${esc(a.id)}" ${p?.agentIds?.includes(a.id)&&ok?'checked':''} ${ok?'':'disabled'}> ${badge(a)} ${esc(title(a))}</label>`;}).join('')||'<p class="field-help">Add an agent first.</p>';
  }
  // The project's agents: those on this computer work in the folder itself; agents on each machine (and in containers)
  // are listed from what exists there, and each one is shared with on its own.
  function openProjectAgents(input){
    const p=(state.projects||[]).find(x=>x.id===input.id)||input;
    const save=form=>action(async()=>{const on=[...form.querySelectorAll('[name="agent"]:checked')].map(c=>c.value);await api.projectSave({...p,agentIds:[...new Set([...on,...(p.remotes||[]).map(r=>r.agentId)])]});closeModal();await refresh();});
    if(p.hostId){
      modal('Agents in this project',`${p.name} / ${hostName(p.hostId)}`,`<form id="project-agents" class="mcp-form"><div class="project-agent-grid">${agentChecks(p,p.hostId)}</div><p class="field-help">Chats you start from the project open these agents in ${esc(p.path)}.</p><div class="modal-footer"><div></div><div><button type="button" class="secondary" data-action="modal-close">Cancel</button><button class="primary" type="submit">Save</button></div></div></form>`);
      $('#project-agents').onsubmit=event=>{event.preventDefault();save(event.target);};return;
    }
    const here=state.agents.filter(a=>a.protocol!=='terminal'&&fitsHere(a,p));
    const localBoxes=state.agents.filter(a=>a.transport!=='ssh'&&a.command==='docker'&&remoteCapable(a,p));
    const groups=[...(localBoxes.length?[{id:'',name:`${localName()} / containers`,agents:localBoxes}]:[]),...state.hosts.map(h=>({id:h.id,name:h.name,host:true,agents:state.agents.filter(a=>a.transport==='ssh'&&a.hostId===h.id&&remoteCapable(a,p))}))];
    const row=a=>{const r=remoteOf(a,p);return `<div class="share-row ${r?'shared':''}">${badge(a)}<div class="share-who"><strong>${esc(title(a))}</strong><small>${a.command==='docker'?'Docker container':esc(labels[a.provider]||a.provider)}${r?` / ${remoteState(r)}`:''}</small></div>${r?`<span class="share-on">Shared</span><div class="share-actions"><button type="button" class="text-button" data-share="send" data-agent="${esc(a.id)}" title="Send your latest changes">&#8593; Send</button><button type="button" class="text-button" data-share="bring" data-agent="${esc(a.id)}" title="Bring its changes back for review">&#8595; Bring back</button><button type="button" class="icon-button" data-share="stop" data-agent="${esc(a.id)}" title="Stop sharing" aria-label="Stop sharing with ${esc(title(a))}">&#10005;</button></div>`:`<button type="button" class="secondary" data-share="start" data-agent="${esc(a.id)}">Share...</button>`}</div>`;};
    modal('Agents in this project',`${p.name} / ${p.path}`,`<form id="project-agents" class="mcp-form share-form">
      <section class="share-group"><h3>${esc(localName())}<small>work in your folder directly</small></h3>${here.length?`<div class="project-agent-grid">${here.map(a=>`<label class="check-row inline project-agent-check"><input type="checkbox" name="agent" value="${esc(a.id)}" ${p.agentIds.includes(a.id)?'checked':''}> ${badge(a)} ${esc(title(a))}</label>`).join('')}</div>`:'<p class="field-help">No agent runs on this computer.</p>'}</section>
      ${groups.map(g=>`<section class="share-group"><h3>${esc(g.name)}<small>${g.agents.length?'each agent works in its own copy':''}</small>${g.host&&g.agents.length?`<button type="button" class="text-button" data-share="find" data-host="${esc(g.id)}" title="Look for agents on ${esc(g.name)}">Find agents</button>`:''}</h3>${g.agents.length?g.agents.map(row).join(''):`<div class="share-empty">No agents on ${esc(g.name)} in Opaya yet. <button type="button" class="text-button" data-share="find" data-host="${esc(g.id)}">Find agents there</button> or <button type="button" class="text-button" data-share="install" data-host="${esc(g.id)}">install one</button>.</div>`}</section>`).join('')}
      ${state.hosts.length?'':`<p class="field-help">Agents on your servers can work on this project too, each in its own copy. <button type="button" class="text-button" data-share="hosts">Add a machine</button></p>`}
      <div class="modal-footer"><div></div><div><button type="button" class="secondary" data-action="modal-close">Cancel</button><button class="primary" type="submit">Save</button></div></div></form>`,true);
    const form=$('#project-agents');
    form.onsubmit=event=>{event.preventDefault();save(event.target);};
    form.addEventListener('click',event=>{
      const b=event.target.closest('[data-share]');if(!b)return;const a=state.agents.find(x=>x.id===b.dataset.agent),act=b.dataset.share;
      if(act==='start'&&a)openShare(p,a);
      else if(act==='send'&&a)action(async()=>{closeModal();await sendToRemote(p,a);});
      else if(act==='bring'&&a)action(async()=>{closeModal();await bringFromRemote(p,a);});
      else if(act==='stop'&&a)stopSharing(p,a);
      else if(act==='find')discover(b.dataset.host);
      else if(act==='install')openInstall(b.dataset.host);
      else if(act==='hosts')openHosts();
    });
  }
  function openProjectForm(p=null,mode='folder'){
    const known=new Set((state.projects||[]).map(x=>`${x.hostId}|${x.path}`));
    const suggestions=[...new Map(state.agents.filter(a=>a.cwd&&a.command!=='docker').map(a=>{const hostId=a.transport==='ssh'?a.hostId:'';return [`${hostId}|${a.cwd}`,{path:a.cwd,hostId}];})).values()].filter(s=>!known.has(`${s.hostId}|${s.path}`)).slice(0,6);
    const machines=`<option value="">This computer</option>${state.hosts.map(h=>`<option value="${esc(h.id)}" ${p?.hostId===h.id?'selected':''}>${esc(h.name)}</option>`).join('')}`;
    modal(p?'Edit project':'Add a project',p?p.path:'A project is a folder. Pick it, then choose the agents that work in it.',`${p?'':`<div class="segmented" role="tablist"><button type="button" role="tab" class="${mode==='folder'?'selected':''}" data-project-mode="folder">Existing folder</button><button type="button" role="tab" class="${mode==='clone'?'selected':''}" data-project-mode="clone">Clone repository</button></div>`}
      <form id="project-form" class="mcp-form">
        ${!p&&mode==='folder'&&suggestions.length?`<div class="project-suggest"><span>From your agents</span>${suggestions.map(s=>`<button type="button" class="marker-chip" data-suggest-path="${esc(s.path)}" data-suggest-host="${esc(s.hostId)}">${esc(s.path)}${s.hostId?` / ${esc(hostName(s.hostId))}`:''}</button>`).join('')}</div>`:''}
        ${mode==='clone'&&!p?`<label>Repository<input name="url" required placeholder="https://github.com/owner/repo.git" autocomplete="off"></label>`:''}
        <div class="form-grid"><label>Machine<select name="hostId">${machines}</select></label><label>Name<input name="name" maxlength="60" value="${esc(p?.name||'')}" placeholder="${mode==='clone'?'From the repository':'Folder name'}"></label></div>
        <label>${mode==='clone'&&!p?'Clone into folder':'Folder'}<span class="input-with-button"><input name="path" required value="${esc(p?.path||'')}" placeholder="${state.platform==='win32'?'C:\\Projects\\app':'/home/me/app'}" autocomplete="off"><button type="button" class="secondary" id="project-browse">Browse</button></span></label>
        ${mode==='clone'&&!p?'<label>Folder name <small>optional</small><input name="folder" maxlength="100" placeholder="repo name"></label>':''}
        <fieldset class="mcp-agents"><legend>Agents that work here</legend><div class="project-agent-grid" id="project-agent-grid">${agentChecks(p,p?.hostId||'')}</div></fieldset>
        <div class="modal-footer"><div></div><div><button type="button" class="secondary" data-action="modal-close">Cancel</button><button class="primary" type="submit">${p?'Save':mode==='clone'?'Clone and add':'Add project'}</button></div></div>
      </form>`);
    for(const b of document.querySelectorAll('[data-project-mode]'))b.onclick=()=>openProjectForm(null,b.dataset.projectMode);
    const f=$('#project-form'),el=n=>f.elements[n];
    const syncHost=()=>{$('#project-browse').hidden=!!el('hostId').value;const chosen=[...f.querySelectorAll('[name="agent"]:checked')].map(c=>c.value);$('#project-agent-grid').innerHTML=agentChecks({agentIds:chosen},el('hostId').value);};
    el('hostId').onchange=syncHost;$('#project-browse').hidden=!!el('hostId').value;
    $('#project-browse').onclick=()=>action(async()=>{const v=await api.pick({kind:'directory'});if(v)el('path').value=v;});
    for(const b of f.querySelectorAll('[data-suggest-path]'))b.onclick=()=>{el('path').value=b.dataset.suggestPath;el('hostId').value=b.dataset.suggestHost;syncHost();for(const c of f.querySelectorAll('[name="agent"]'))if(!c.disabled&&state.agents.find(a=>a.id===c.value)?.cwd===b.dataset.suggestPath)c.checked=true;};
    f.querySelector('input')?.focus();
    f.onsubmit=event=>{event.preventDefault();action(async()=>{
      const agentIds=[...f.querySelectorAll('[name="agent"]:checked')].map(c=>c.value),hostId=el('hostId').value;
      const saved=mode==='clone'&&!p?await api.projectClone({url:el('url').value,parent:el('path').value,folder:el('folder').value,name:el('name').value,hostId,agentIds}):await api.projectSave({...(p||{}),name:el('name').value,path:el('path').value.trim(),hostId,agentIds});
      closeModal();projectsExpanded.add(saved.id);projectsOpen=true;await refresh();saveProjectsView();loadProjectGit(saved);toast(mode==='clone'&&!p?'Cloning in Terminal. The project is ready when it finishes.':p?'Project saved.':'Project added.');
    });};
  }
  function openAgentProjects(a){
    const list=(state.projects||[]).filter(p=>fitsHere(a,p)),shared=(state.projects||[]).filter(p=>remoteOf(a,p)),open=(state.projects||[]).filter(p=>remoteCapable(a,p)&&!remoteOf(a,p));
    if(!list.length&&!shared.length&&!open.length){toast('No project yet. Add one in the Projects panel.');toggleProjects(true);return;}
    modal('Projects',`${title(a)} works in`,`<form id="agent-projects" class="mcp-form share-form">${list.length?`<div class="project-agent-grid">${list.map(p=>`<label class="check-row inline"><input type="checkbox" name="project" value="${esc(p.id)}" ${p.agentIds.includes(a.id)?'checked':''}> ${esc(p.name)} <small>${esc(p.path)}</small></label>`).join('')}</div>`:''}
      ${shared.length||open.length?`<section class="share-group"><h3>Projects on ${esc(localName())}<small>${esc(title(a))} works in its own copy</small></h3>${[...shared,...open].map(p=>{const r=remoteOf(a,p);return `<div class="share-row ${r?'shared':''}"><span class="project-folder" aria-hidden="true"></span><div class="share-who"><strong>${esc(p.name)}</strong><small>${r?remoteState(r):esc(p.path)}</small></div>${r?'<span class="share-on">Shared</span>':`<button type="button" class="secondary" data-share-project="${esc(p.id)}">Share...</button>`}</div>`;}).join('')}</section>`:''}
      <div class="modal-footer"><div></div><div><button type="button" class="secondary" data-action="modal-close">Cancel</button><button class="primary" type="submit">Save</button></div></div></form>`,true);
    $('#agent-projects').addEventListener('click',event=>{const b=event.target.closest('[data-share-project]');const p=b&&(state.projects||[]).find(x=>x.id===b.dataset.shareProject);if(p)openShare(p,a);});
    $('#agent-projects').onsubmit=event=>{event.preventDefault();action(async()=>{const on=new Set([...event.target.querySelectorAll('[name="project"]:checked')].map(c=>c.value));for(const p of list){const has=p.agentIds.includes(a.id);if(on.has(p.id)!==has)await api.projectSave({...p,agentIds:has?p.agentIds.filter(x=>x!==a.id):[...p.agentIds,a.id]});}closeModal();await refresh();});};
  }
  $('#projects-panel').addEventListener('click',event=>{
    const b=event.target.closest('[data-action]');if(!b)return;const act=b.dataset.action,p=b.dataset.id&&(state.projects||[]).find(x=>x.id===b.dataset.id);
    if(act==='projects-close')toggleProjects(false);
    else if(act==='project-new')openProjectForm();
    else if(act==='project-refresh')refreshProjectGit(true);
    else if(act==='project-toggle'&&p){if(projectsExpanded.has(p.id))projectsExpanded.delete(p.id);else{projectsExpanded.add(p.id);loadProjectGit(p);}renderProjects();saveProjectsView();}
    else if(act==='project-chat'&&p)action(()=>startProjectChat(p,b.dataset.agent));
    else if(act==='project-open-chat')action(()=>openProjectChat(b.dataset.id));
    else if(act==='project-add-agent'&&p)openProjectAgents(p);
    else if(act==='project-files'&&p)openFiles({hostId:p.hostId||undefined,path:p.path,label:`${p.name} / ${hostName(p.hostId)}`});
    else if(act==='project-terminal'&&p)action(()=>projectTerminal(p));
    else if(act==='project-git'&&p){const r=b.getBoundingClientRect();openMenu(r.left,r.bottom+4,gitMenu(p),`${p.name} / git`,b);}
  });
  $('#projects-panel').addEventListener('contextmenu',event=>{
    const el=event.target.closest('[data-project-id]');if(!el||event.target.closest('input'))return;const p=(state.projects||[]).find(x=>x.id===el.dataset.projectId);if(!p)return;
    event.preventDefault();event.stopPropagation();
    const agent=event.target.closest('[data-pa-agent]');
    if(agent){const a=state.agents.find(x=>x.id===agent.dataset.paAgent);if(!a)return;if(remoteOf(a,p)){openMenu(event.clientX,event.clientY,remoteMenu(p,a),`${title(a)} / ${agentPlace(a)}`);return;}openMenu(event.clientX,event.clientY,[{icon:'+',label:`New chat in ${p.name}`,run:()=>startProjectChat(p,a.id)},{icon:'&#10005;',label:'Remove from project',danger:true,run:async()=>{await api.projectSave({...p,agentIds:p.agentIds.filter(x=>x!==a.id)});await refresh();}}],title(a));return;}
    openMenu(event.clientX,event.clientY,projectMenu(p),p.name,el);
  });
  document.addEventListener('keydown',event=>{if((event.ctrlKey||event.metaKey)&&event.shiftKey&&event.key.toLowerCase()==='p'&&!$('#app-dialog')){event.preventDefault();toggleProjects();}});
  document.addEventListener('keydown',event=>{if((event.ctrlKey||event.metaKey)&&event.shiftKey&&event.key.toLowerCase()==='h'&&!$('#app-dialog')){event.preventDefault();toggleHistory();}});
  // ---- A proactive Opaya Agent, gently: one small card at a time, at most every 20 minutes, each tip once ------------
  let nudgeShownAt=0,nudgeId='';
  function nudgeCandidates(){
    const now=Date.now(),out=[],today=new Date().toISOString().slice(0,10),hour=new Date().getHours();
    for(const a of state.agents)if(a.busy&&a.turnStartedAt&&now-a.turnStartedAt>5*60000)out.push({id:`long:${a.id}:${a.turnStartedAt}`,urgent:true,text:`${title(a)} has been working for ${Math.round((now-a.turnStartedAt)/60000)} minutes. I'm keeping an eye on it.`,actions:[['Open',()=>{overview=false;opayaView=false;playgroundView=false;action(async()=>{await api.select({id:a.id});await refresh();});}],['Connection log',()=>openDiagnostics(a.id)]]});
    if(greeted!==today&&state.agents.length){const on=state.agents.filter(a=>a.status==='connected').length;out.push({id:`greet:${today}`,greet:today,text:`${hour<12?'Good morning':hour<18?'Good afternoon':'Good evening'}! ${state.agents.length} agent${state.agents.length===1?'':'s'} here, ${on} connected.${state.hosts.length?` ${state.hosts.length} machine${state.hosts.length===1?'':'s'} ready.`:''}`,actions:on<state.agents.length?[['Connect all',()=>action(()=>connectAll())]]:[]});}
    if(state.hosts.length>=1&&state.agents.some(a=>a.provider==='hermes')&&!state.agents.some(a=>a.clone))out.push({id:'tip:clone',text:`You have ${state.hosts.length} machine${state.hosts.length===1?'':'s'}. Open a Hermes agent's Deploy & clone (R) and drag it onto a VPS to copy it there, as a profile or a Docker container.`,actions:[]});
    if(state.agents.length)out.push({id:'tip:find',text:`Looking for a setting or an action? Press ${mod().trim()}${state.platform==='darwin'?'':'+'}K or Search at the top: it finds anything and shows where it lives. Back (Alt+Left) returns to the previous screen.`,actions:[['Search',()=>openFind()]]});
    if(state.agents.length&&!vaultKeys().length)out.push({id:'tip:vault-import',text:'Already have API keys in .env files or your tools? Import them into the Opaya Vault and give each to the agents that need it.',actions:[['Import keys',()=>openVault({panel:'import'})]]});
    if(!state.hosts.length&&state.agents.length>=2)out.push({id:'tip:vps',text:'Want an agent running around the clock? Add a new VPS: I create the SSH key and check the connection.',actions:[['New VPS',()=>openNewVps()]]});
    
    if(!(state.projects||[]).length&&state.agents.some(a=>a.cwd))out.push({id:'tip:projects',text:'Keep folders, their agents, chats and git together in Projects. Press Ctrl+Shift+P.',actions:[['Open Projects',()=>toggleProjects(true)]]});
    // Updates: each outdated tool is announced once per new version. Closing the note (or letting it fade) dismisses
    // those versions; the note comes back only when something newer appears. Hermes counts commits behind, which grow
    // every hour, so it is keyed without the count.
    const updateKey=i=>`upd:${i.hostId||'local'}/${i.id}/${i.latest||'git'}`;
    const fresh=outdatedTools().filter(i=>!tipsSeen.has(updateKey(i)));
    if(fresh.length)out.unshift({id:updateKey(fresh[0]),keys:fresh.map(updateKey),text:`Update${fresh.length===1?'':'s'} available: ${fresh.slice(0,3).map(i=>`${i.name} ${i.installed}${i.latest?` to ${i.latest}`:''}${state.hosts.length?` on ${i.machine}`:''}`).join(', ')}${fresh.length>3?` and ${fresh.length-3} more`:''}. You should update.`,actions:[['See updates',()=>openToolUpdates()]]});
    return out.filter(n=>!tipsSeen.has(n.id));
  }
  function checkNudges(){
    if(!state?.agents||$('#opaya-nudge')||document.querySelector('dialog[open]')||state.settings?.tips===false)return;
    const list=nudgeCandidates(),n=list.find(x=>x.urgent)||(Date.now()-nudgeShownAt>20*60000?list[0]:null);if(!n)return;
    nudgeShownAt=Date.now();nudgeId=n.id;if(n.greet)greeted=n.greet;
    const card=document.createElement('div');card.id='opaya-nudge';card.className='opaya-nudge';card.setAttribute('role','status');
    card.innerHTML=`<span class="opaya-mark small" aria-hidden="true"><img src="assets/opaya-logo.png" alt=""><i></i></span><div><strong>Opaya</strong><p>${esc(n.text)}</p>${n.actions.length?`<div class="nudge-actions">${n.actions.map((x,i)=>`<button type="button" class="text-button" data-nudge="${i}">${esc(x[0])}</button>`).join('')}</div>`:''}</div><button type="button" class="icon-button" data-nudge="close" aria-label="Dismiss">&#10005;</button>`;
    const close=()=>{tipsSeen.add(n.id);for(const k of n.keys||[])tipsSeen.add(k);saveView();card.classList.add('leaving');setTimeout(()=>card.remove(),220);};
    card.addEventListener('click',e=>{const b=e.target.closest('[data-nudge]');if(!b)return;if(b.dataset.nudge!=='close')n.actions[Number(b.dataset.nudge)]?.[1]();close();});
    document.body.append(card);if(!n.urgent)setTimeout(()=>{if(card.isConnected)close();},30000);
  }
  setInterval(checkNudges,30000);
  // ---- Job window: live progress for clones and redeploys; minimizes to a chip in the status bar ------------------
  const jobs=new Map();let jobShown='',jobMinimized=false;const jobRate=new Map();
  const fmtBytes=n=>!n?'0 B':n<1024?`${n} B`:n<1048576?`${(n/1024).toFixed(1)} KB`:n<1073741824?`${(n/1048576).toFixed(1)} MB`:`${(n/1073741824).toFixed(2)} GB`;
  const fmtTime=s=>!Number.isFinite(s)||s<0?'--':s<60?`${Math.round(s)}s`:`${Math.floor(s/60)}m ${String(Math.round(s%60)).padStart(2,'0')}s`;
  function jobPercent(j){
    if(j.status==='done')return 100;
    const steps=j.steps||[],done=steps.filter(s=>['done','skipped','warn'].includes(s.state)).length,copyIndex=steps.findIndex(s=>s.key==='copy'||s.key==='download');
    // Copying is most of the work: it spans 15% to 85%; the other steps share the rest.
    const copy=steps[copyIndex];const copyShare=copy?.state==='done'?1:copy?.state==='active'&&j.total?Math.min(1,j.bytes/j.total):0;
    const others=steps.length-1||1,otherDone=done-(copy?.state==='done'?1:0);
    return Math.round(Math.min(99,(otherDone/others)*30+copyShare*70));
  }
  function trackRate(j){
    const now=Date.now(),r=jobRate.get(j.id)||{samples:[]};r.samples.push([now,j.bytes||0]);r.samples=r.samples.filter(([t])=>now-t<5000);jobRate.set(j.id,r);
    const [t0,b0]=r.samples[0],rate=now>t0?((j.bytes||0)-b0)/((now-t0)/1000):0;return rate;
  }
  function onJob(j){
    const prev=jobs.get(j.id);jobs.set(j.id,j);
    if(!prev&&j.status==='running'){jobShown=j.id;jobMinimized=j.kind==='guide'||j.kind==='free-model'&&guideOn();}
    // The guide shows its own progress, and continues by itself when the free model is ready.
    if(guide){if(j.kind==='free-model'&&j.status==='done'&&guide.step==='free'){guide.step='goals';refresh().then(()=>renderOpaya());}if(opayaView&&(j.kind==='guide'||j.kind==='free-model'))renderOpaya();}
    if(prev?.status==='running'&&j.status!=='running'){
      if(j.status==='done'){const r=j.result||{},bits=[r.copied&&`Copied: ${r.copied.join(', ')}`,r.skills&&`${r.skills.length} skill${r.skills.length===1?'':'s'}`,r.keys&&`${r.keys.length} API key${r.keys.length===1?'':'s'}`,r.mcp&&`MCP: ${r.mcp.join(', ')}`,r.token&&'API token',r.file&&`saved as ${r.file}`,r.after?.removed&&'connection removed'].filter(Boolean);if(j.kind==='backup'||j.kind==='uninstall'){backupLists.clear();installInfo.clear();}
        toast(`${j.title.replace(/^Cloning/,'Cloned').replace(/^Redeploying/,'Redeployed').replace(/^Transferring/,'Transferred').replace(/^Installing skills/,'Installed skills').replace(/^Installing /,'Installed ').replace(/^Setting up/,'Set up').replace(/^Adding skills/,'Added skills').replace(/^Backing up/,'Backed up').replace(/^Uninstalling/,'Uninstalled')}. ${bits.join(', ')}${bits.length?'.':''}`);if(j.kind!=='library')skillCache.clear();refresh();if(j.kind==='library'&&$('#library-body'))drawLibrary?.();if(j.kind==='free-model'){overview=false;playgroundView=false;opayaView=true;refresh().then(()=>{render();saveView();$('#message-input')?.focus();});}if(j.kind==='condense'&&j.result?.conversationId)refresh().then(()=>openEssence(j.result.conversationId));if(j.kind==='project-bring'&&j.result)refresh().then(()=>openBringReview(j.result));if(j.kind==='project-remote'&&j.result?.dir)refresh().then(()=>{projectsExpanded.add(j.result.projectId);toggleProjects(true);const c=(state.projects||[]).find(x=>x.id===j.result.projectId);if(c&&j.result.agentId)startProjectChat(c,j.result.agentId);});}
      else toast(`${j.title} failed: ${j.error}`,true);
    }
    renderJobs();
    if(migrations.has(j.id)&&j.status!=='running'){const src=state.agents.find(x=>x.id===migrations.get(j.id));migrations.delete(j.id);if(j.status==='done'&&src)setTimeout(()=>finishMigration(src,j),600);}
    // Clone progress shows on the deploy targets of the management screen and on the fleet board.
    if(fleetView&&overview&&j.kind==='clone'&&(!prev||prev.status!==j.status||jobPercent(prev)!==jobPercent(j)))render();
    if(manageId&&j.kind==='clone'&&(!prev||prev.status!==j.status||jobPercent(prev)!==jobPercent(j)))render();
  }
  function renderJobs(){
    const running=[...jobs.values()].filter(j=>j.status==='running');
    const chip=$('#status-jobs');
    if(chip){const current=jobs.get(jobShown)||running[0];const show=!!current&&(jobMinimized||!$('#job-window'))&&(running.length||current.status!=='running');chip.hidden=!(current&&(jobMinimized&&current));
      if(current)chip.innerHTML=`<span class="job-chip-ring" style="--p:${jobPercent(current)}"></span>${esc(current.status==='running'?current.title:current.status==='done'?'Finished: '+current.title.replace(/^Cloning |^Redeploying /,''):'Failed: '+current.title.replace(/^Cloning |^Redeploying /,''))} ${current.status==='running'?`${jobPercent(current)}%`:''}${running.length>1?` <b>+${running.length-1}</b>`:''}`;}
    const j=jobs.get(jobShown);let win=$('#job-window');
    document.body.classList.toggle('job-open',!!j&&!jobMinimized);
    if(!j||jobMinimized){win?.remove();return;}
    if(!win){win=document.createElement('section');win.id='job-window';win.className='job-window';win.setAttribute('role','dialog');win.setAttribute('aria-label',j.title);document.body.append(win);
      win.addEventListener('click',event=>{const b=event.target.closest('[data-job]');if(!b)return;const act=b.dataset.job,job=jobs.get(jobShown);
        if(act==='min'){jobMinimized=true;renderJobs();}
        else if(act==='close'){if(job?.status==='running'){jobMinimized=true;}else{api.jobDismiss({id:jobShown}).catch(()=>{});jobs.delete(jobShown);jobShown=[...jobs.values()].find(x=>x.status==='running')?.id||'';}renderJobs();}
        else if(act==='open'&&job?.result?.agent){overview=false;opayaView=false;playgroundView=false;action(async()=>{await api.select({id:job.result.agent.id});await refresh();});jobMinimized=true;renderJobs();}
        else if(act==='install'){action(async()=>{await api.installFramework({id:'hermes',hostId:job?.route?.toHostId||undefined});toast('Installing Hermes in Terminal. Clone again when it finishes.');});}
        else if(act==='gh-login'&&job?.route?.hostId){action(()=>api.projectRemoteGithubLogin({hostId:job.route.hostId}));}
        else if(act==='reveal'&&job?.result?.file){action(()=>api.revealBackup({file:job.result.file}));}
        else if(act==='copy'){action(()=>api.clipboardWrite({text:job.log.map(l=>`${new Date(l.at).toLocaleTimeString()} ${l.text}`).join('\n')}));toast('Log copied.');}
      });}
    const pct=jobPercent(j),rate=j.status==='running'?trackRate(j):0,eta=rate>0&&j.total?(j.total-j.bytes)/rate:NaN,elapsed=((j.finishedAt||Date.now())-j.startedAt)/1000;
    const copying=j.steps.find(s=>s.key==='copy'||s.key==='download')?.state==='active',r=j.route||{};
    const icon=s=>({done:'<span class="job-step-icon done">&#10003;</span>',active:'<span class="job-step-icon active"></span>',error:'<span class="job-step-icon error">&#10005;</span>',warn:'<span class="job-step-icon warn">!</span>',skipped:'<span class="job-step-icon skipped">&#8211;</span>'}[s]||'<span class="job-step-icon"></span>');
    const head=`<div class="job-title"><strong>${esc(j.title)}</strong><small>${esc(j.detail||'')}</small></div><button type="button" class="icon-button" data-job="min" title="Minimize" aria-label="Minimize">&#8211;</button><button type="button" class="icon-button" data-job="close" title="${j.status==='running'?'Hide (keeps running)':'Close'}" aria-label="Close">&#10005;</button>`;
    const route=`<div class="job-node"><span class="job-node-icon">${badge({provider:r.provider||'hermes'})}</span><strong>${esc(r.from||'')}</strong><small>${esc(r.fromWhere||'')}</small></div><div class="job-wire ${copying?'flowing':''}"><i></i><i></i><i></i><i></i></div><div class="job-node"><span class="job-node-icon target"><span class="machine-icon"></span></span><strong>${esc(r.to||'')}</strong><small>${esc(r.toWhere||'')}</small></div>`;
    const status=j.status==='done'?'Complete':j.status==='error'?'Stopped':copying?`${fmtBytes(j.bytes)} of ${fmtBytes(j.total)}`:j.steps.find(s=>s.state==='active')?.label||'Working';
    const stats=`<span>Speed <b>${copying&&rate>0?fmtBytes(rate)+'/s':'--'}</b></span><span>Left <b>${copying?fmtTime(eta):'--'}</b></span><span>Elapsed <b>${fmtTime(elapsed)}</b></span>`;
    const foot=j.status!=='running'?`${j.status==='error'?`<p class="job-error">${esc(j.error)}</p>${/Hermes is not installed/.test(j.error)?'<button type="button" class="secondary" data-job="install">Install Hermes there</button>':''}${/Sign in to GitHub there/.test(j.error)&&r.hostId?'<button type="button" class="secondary" data-job="gh-login">Sign in to GitHub there</button>':''}`:''}<button type="button" class="text-button" data-job="copy">Copy log</button>${j.status==='done'&&j.result?.agent?`<button type="button" class="primary" data-job="open">Open ${esc(j.result.agent.name)}</button>`:''}${j.status==='done'&&j.result?.file?'<button type="button" class="secondary" data-job="reveal">Show in folder</button>':''}<button type="button" class="secondary" data-job="close">Close</button>`:'';
    // Progress arrives several times a second. Rebuilding the window restarted every animation (flicker), and moving
    // the log scrolled the page, which closed any open context menu. Build the frame once per job, then change only
    // the parts that differ; new log lines are appended.
    if(win.dataset.job!==j.id){
      win.dataset.job=j.id;win.dataset.log='';
      win.innerHTML=`<header class="job-head"></header><div class="job-route"></div><div class="job-progress"><div class="job-percent"><span><b class="job-pct"></b><small>%</small></span><em></em></div><div class="job-bar"><span></span></div><div class="job-stats"></div></div><ol class="job-steps"></ol><div class="job-log" id="job-log"></div><footer class="job-foot" hidden></footer>`;
    }
    const part=(selector,html)=>{const el=$(selector,win);if(el&&el.dataset.html!==html){el.innerHTML=html;el.dataset.html=html;}return el;};
    const text=(selector,value)=>{const el=$(selector,win);if(el&&el.textContent!==String(value))el.textContent=value;};
    win.classList.toggle('finished',j.status!=='running');
    part('.job-head',head);
    const routeEl=part('.job-route',route);routeEl.className=`job-route ${j.status}`;
    text('.job-pct',pct);text('.job-percent em',status);part('.job-stats',stats);
    const bar=$('.job-bar',win);bar.className=`job-bar ${j.status}`;const fill=$('.job-bar span',win);if(fill.style.width!==pct+'%')fill.style.width=pct+'%';
    // Steps: change a step only when its state does, so finished steps do not replay their animation.
    const list=$('.job-steps',win);
    if(list.children.length!==j.steps.length)list.innerHTML=j.steps.map(()=>'<li><span class="job-step-icon"></span><span></span></li>').join('');
    j.steps.forEach((step,i)=>{const li=list.children[i];if(li.dataset.state===step.state&&li.dataset.label===step.label)return;li.dataset.state=step.state;li.dataset.label=step.label;li.className=step.state;li.innerHTML=`${icon(step.state)}<span>${esc(step.label)}</span>`;});
    // Log: append what is new; rebuild only when the job's log was trimmed past what is shown.
    const log=$('#job-log',win),atBottom=log.scrollHeight-log.scrollTop-log.clientHeight<30,shown=j.log.slice(-120),key=l=>`${l.at}|${l.text}`;
    const line=l=>`<p class="${esc(l.state||'')}"><time>${new Date(l.at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'})}</time>${esc(l.text)}</p>`;
    const lastIndex=win.dataset.log?shown.findIndex(l=>key(l)===win.dataset.log):-1;
    if(win.dataset.log&&lastIndex<0&&shown.length){log.innerHTML=shown.map(line).join('');}
    else if(lastIndex<shown.length-1)log.insertAdjacentHTML('beforeend',shown.slice(lastIndex+1).map(line).join(''));
    while(log.children.length>120)log.firstElementChild.remove();
    win.dataset.log=shown.length?key(shown.at(-1)):'';
    if(atBottom&&log.scrollHeight-log.clientHeight-log.scrollTop>1)log.scrollTop=log.scrollHeight;
    const footer=part('.job-foot',foot);footer.hidden=!foot;
  }
  api.onJob?.(onJob);
  api.jobs?.().then(list=>{for(const j of list||[]){jobs.set(j.id,j);if(j.status==='running'){jobShown=j.id;jobMinimized=true;}}renderJobs();}).catch(()=>{});
  setInterval(()=>{if([...jobs.values()].some(j=>j.status==='running'))renderJobs();},1000);
  // ---- Transfer between agents and the global skills library -----------------------------------------------------
  const pickList=(name,items,checked=false)=>`<div class="pick-list">${items.map(i=>`<label class="pick-item"><input type="checkbox" name="${name}" value="${esc(i.value)}" ${checked?'checked':''}><span><strong>${esc(i.label)}</strong>${i.help?`<small>${esc(i.help)}</small>`:''}</span></label>`).join('')}</div>`;
  const modeRow=(name,value,extra='')=>`<div class="segmented transfer-mode" role="radiogroup">${[['none','None'],['all','All'],['some','Selected']].map(([v,l])=>`<label class="${value===v?'selected':''}"><input type="radio" name="${name}" value="${v}" ${value===v?'checked':''} ${extra}>${l}</label>`).join('')}</div>`;
  function openTransfer(a,preset={}){
    const others=state.agents.filter(x=>x.id!==a.id);if(!others.length){toast('Add another agent first.');return;}
    const mcps=(state.mcpServers||[]).filter(s=>usesMcp(s,a));
    modal(`Share from ${title(a)}`,'Copy skills, API keys and tools to another agent. Nothing is removed from this one.',`<form id="transfer-form" class="mcp-form">
      <fieldset class="transfer-part transfer-to"><legend>To</legend><div class="vk-agents pick">${others.map((x,i)=>`<label class="vk-agent"><input type="radio" name="targetId" value="${esc(x.id)}" ${(preset.targetId?preset.targetId===x.id:i===0)?'checked':''}>${badge(x)}<span><strong>${esc(title(x))}</strong><small>${esc([labels[x.provider]&&!title(x).toLowerCase().includes(String(labels[x.provider]).toLowerCase())?labels[x.provider]:'',location(x)].filter(Boolean).join(' / '))}</small></span></label>`).join('')}</div></fieldset>
      <fieldset class="transfer-part"><legend>Skills <small id="transfer-skill-count"></small></legend>${modeRow('skillsMode',preset.skills||'all')}<div id="transfer-skills"><p class="field-help">Loading skills...</p></div></fieldset>
      <fieldset class="transfer-part" id="transfer-keys-part"><legend>API keys <small>names only, values are never shown</small></legend><div id="transfer-keys"></div></fieldset>
      <fieldset class="transfer-part"><legend>Tools &amp; MCP servers</legend>${mcps.length?pickList('mcp',mcps.map(s=>({value:s.id,label:s.name,help:s.type==='stdio'?s.command:s.url})),true):`<p class="field-help">${esc(title(a))} uses no Opaya MCP servers. <button type="button" class="text-button" data-action="mcp-manage">Manage MCP servers</button></p>`}<p class="field-help" id="transfer-mcp-note"></p></fieldset>
      ${a.hasToken?`<label class="check-row inline"><input type="checkbox" name="token"> Also copy the saved gateway API token <small>(stays encrypted, never shown)</small></label>`:''}
      <p class="field-help">Skills are folders with a SKILL.md, so they work across Hermes, Claude Code, Codex and OpenClaw. Existing skills with the same folder name are replaced.</p>
      <div class="modal-footer"><div></div><div><button type="button" class="secondary" data-action="modal-close">Cancel</button><button class="primary" type="submit">Share</button></div></div></form>`,true);
    const f=$('#transfer-form'),target=()=>state.agents.find(x=>x.id===f.elements.targetId.value);let skills=[],keys=null;
    const mode=n=>f.querySelector(`[name="${n}"]:checked`)?.value||'none';
    const syncMode=()=>{for(const l of f.querySelectorAll('.transfer-mode label'))l.classList.toggle('selected',l.querySelector('input').checked);
      $('#transfer-skills').classList.toggle('collapsed',mode('skillsMode')!=='some');$('#transfer-keys-list')?.classList.toggle('collapsed',mode('keysMode')!=='some');};
    // Keys move between any agents: each goes where the target reads it (.env, settings.json, codex login, OpenCode
    // auth.json or the connection token); the service reads and writes the values, the page only sees names.
    const drawKeys=()=>{const t=target(),box=$('#transfer-keys');
      if(!keys){box.innerHTML='<p class="field-help">Reading key names...</p>';return;}
      if(keys.error){box.innerHTML=`<div class="message-error">${esc(keys.error)}</div>`;return;}
      if(!keys.source?.kind){box.innerHTML=`<p class="field-help">Opaya does not know where ${esc(title(a))} keeps API keys, so it cannot copy them.</p>`;return;}
      if(!keys.target?.kind){box.innerHTML=`<p class="field-help">Opaya does not know where ${esc(title(t))} reads API keys. Use its own sign-in, or give the key to the Opaya Agent.</p>`;return;}
      if(!keys.keys.length){box.innerHTML=`<p class="field-help">${esc(title(a))} has no API keys Opaya can read.</p>`;return;}
      const plan=new Map(keys.target.plan.map(p=>[p.name,p]));
      box.innerHTML=`${modeRow('keysMode',preset.keys||'none')}<div id="transfer-keys-list" class="collapsed">${pickList('key',keys.keys.map(k=>{const p=plan.get(k.name);return {value:k.name,label:k.name,help:`From ${k.from}. ${p?.to?`Goes to ${p.to}.`:`Not copied: ${p?.why||'unknown'}.`}`};}))}</div><p class="field-help">Values are copied by the session service and never shown. A key ${esc(title(t))} already has is replaced; keys it cannot use are left out.</p>`;
      syncMode();};
    const loadKeys=()=>{keys=null;drawKeys();const id=f.elements.targetId.value;api.agentEnvKeys({id:a.id,targetId:id}).then(r=>{if(f.elements.targetId.value!==id)return;keys=r;drawKeys();},e=>{keys={error:e.message};drawKeys();});};
    const drawNote=()=>{const t=target();$('#transfer-mcp-note').textContent=t&&!mcpPassed(t)&&mcps.length?`${title(t)}: ${mcpSupport(t)}`:'';};
    f.addEventListener('change',event=>{if(event.target.name==='targetId'){loadKeys();drawNote();}syncMode();$('#transfer-skill-count').textContent=mode('skillsMode')==='some'?`${f.querySelectorAll('[name="skill"]:checked').length} of ${skills.length} selected`:skills.length?plural(skills.length,'skill'):'';});
    drawKeys();drawNote();syncMode();
    // Bundled skills (OpenClaw's own) come with the agent and have no folder to copy.
    loadSkills(a.id).then(r=>{skills=(r.skills||[]).filter(s=>s.path);const box=$('#transfer-skills');if(!box)return;
      box.innerHTML=skills.length?`<input class="skills-search" id="transfer-filter" placeholder="Filter skills..." aria-label="Filter skills">${pickList('skill',skills.map(s=>({value:s.name,label:'/'+s.name,help:s.description})),false)}`:'<p class="field-help">No skills installed.</p>';
      $('#transfer-skill-count').textContent=skills.length?plural(skills.length,'skill'):'';
      if(!skills.length)for(const i of f.querySelectorAll('[name="skillsMode"]'))i.checked=i.value==='none';
      $('#transfer-filter')?.addEventListener('input',e=>{const q=e.target.value.toLowerCase();for(const l of box.querySelectorAll('.pick-item'))l.hidden=!l.textContent.toLowerCase().includes(q);});
      for(const n of preset.names||[]){const c=box.querySelector(`[name="skill"][value="${CSS.escape(n)}"]`);if(c)c.checked=true;}syncMode();
    },error=>{$('#transfer-skills').innerHTML=`<div class="message-error">${esc(error.message)}</div>`;});
    loadKeys();
    f.onsubmit=async event=>{event.preventDefault();const t=target(),picked=n=>[...f.querySelectorAll(`[name="${n}"]:checked`)].map(i=>i.value);
      const sm=mode('skillsMode'),km=f.querySelector('[name="keysMode"]')?mode('keysMode'):'none';
      const x={sourceId:a.id,targetId:t.id,skills:sm==='all'?'all':sm==='some'?picked('skill'):false,keys:km==='all'?'all':km==='some'?picked('key'):false,mcp:picked('mcp'),token:!!f.elements.token?.checked};
      if(Array.isArray(x.skills)&&!x.skills.length){toast('Select skills, or choose All or None.',true);return;}
      if(Array.isArray(x.keys)&&!x.keys.length){toast('Select API keys, or choose All or None.',true);return;}
      if(!x.skills&&!x.keys&&!x.mcp.length&&!x.token){toast('Choose what to transfer.',true);return;}
      const places=[...new Set((keys?.target?.plan||[]).filter(p=>p.to&&(x.keys==='all'||x.keys?.includes?.(p.name))).map(p=>p.to.replace(/ as .*| env .*/,'')))];
      if(x.keys&&!await ask(`Copy ${x.keys==='all'?'all':x.keys.length} API key${x.keys.length===1?'':'s'} from ${title(a)} to ${title(t)}?\n\nThey go to ${places.join(', ')||'where it reads them'} on ${location(t)}. ${title(t)} will be able to use the same accounts and spend on them.`))return;
      action(async()=>{await api.transferStart(x);closeModal();});
    };
  }
  let drawLibrary=null;
  function openLibrary(){
    modal('Skills library','Global skills kept by Opaya. Install them to any agent on this computer or a VPS.',`${libTabs('skills')}<div id="library-body"><p class="field-help">Loading...</p></div>`,true);
    drawLibrary=async()=>{
      const body=$('#library-body');if(!body)return;let list=[];try{list=await api.libraryList();}catch(error){body.innerHTML=`<div class="message-error">${esc(error.message)}</div>`;return;}
      const q=($('#library-search')?.value||'').toLowerCase(),shown=list.filter(s=>`${s.name} ${s.description} ${s.category}`.toLowerCase().includes(q));
      body.innerHTML=`<div class="skills-head"><h3>Library <small>${list.length}</small></h3><div><input id="library-search" class="skills-search" placeholder="Filter..." aria-label="Filter library" value="${esc(q)}"><button class="secondary small" id="library-from-agent">Add from agent</button><button class="secondary small" id="library-from-folder">Add from folder</button></div></div>
        ${list.length?`<div class="library-bar"><label class="check-row inline"><input type="checkbox" id="library-all"> Select all</label><span id="library-count"></span><button class="primary small" id="library-install" disabled>Install to agents...</button></div>
        <div class="skill-list">${shown.map(s=>`<label class="skill-row library-row"><input type="checkbox" data-lib="${esc(s.name)}"><div><strong>/${esc(s.name)}</strong>${s.category?`<em>${esc(s.category)}</em>`:''}<p>${esc(s.description||'No description.')}</p></div><button type="button" class="icon-button" data-lib-remove="${esc(s.name)}" title="Remove from library" aria-label="Remove ${esc(s.name)} from library">&#10005;</button></label>`).join('')||'<p class="field-help">No skills match this filter.</p>'}</div>`:`<div class="library-empty"><span aria-hidden="true">&#10022;</span><p>The library is empty. Add skills from an agent you already set up, or from a folder with SKILL.md files, then install them anywhere.</p></div>`}`;
      const search=$('#library-search');search.addEventListener('input',()=>drawLibrary());if(q){search.focus();search.setSelectionRange(q.length,q.length);}
      const boxes=()=>[...body.querySelectorAll('[data-lib]')],count=()=>{const n=boxes().filter(b=>b.checked).length;$('#library-count')&&($('#library-count').textContent=n?`${n} selected`:'');$('#library-install')&&($('#library-install').disabled=!n);};
      $('#library-all')?.addEventListener('change',e=>{for(const b of boxes())b.checked=e.target.checked;count();});
      for(const b of boxes())b.addEventListener('change',count);
      for(const b of body.querySelectorAll('[data-lib-remove]'))b.onclick=async event=>{event.preventDefault();const n=b.dataset.libRemove;if(!await ask(`Remove ${n} from the library?\n\nAgents that already have it keep their copy.`))return;action(async()=>{await api.libraryRemove({name:n});await drawLibrary();toast(`${n} removed from the library.`);});};
      $('#library-install')&&($('#library-install').onclick=()=>openLibraryInstall(boxes().filter(b=>b.checked).map(b=>b.dataset.lib)));
      $('#library-from-agent').onclick=()=>{const withSkills=state.agents;if(!withSkills.length){toast('Add an agent first.');return;}openLibraryImport();};
      $('#library-from-folder').onclick=()=>action(async()=>{const dir=await api.pick({kind:'directory'});if(!dir)return;const r=await api.libraryAddFolder({path:dir});await drawLibrary();toast(`Added ${plural(r.skills.length,'skill')} to the library.`);});
    };
    drawLibrary();
  }
  function openLibraryInstall(names){
    modal('Install skills',`${plural(names.length,'skill')} from the library: ${names.slice(0,6).join(', ')}${names.length>6?'...':''}`,`<form id="library-install-form" class="mcp-form"><fieldset class="transfer-part"><legend>Agents that receive them</legend>${pickList('agent',state.agents.map(x=>({value:x.id,label:title(x),help:`${labels[x.provider]||x.provider} / ${location(x)}`})))}</fieldset>
      <p class="field-help">Skills with the same folder name are replaced. New conversations load them.</p>
      <div class="modal-footer"><div><button type="button" class="text-button" data-action="library">Back to library</button></div><div><button type="button" class="secondary" data-action="modal-close">Cancel</button><button class="primary" type="submit">Install</button></div></div></form>`,true);
    const f=$('#library-install-form');
    f.onsubmit=event=>{event.preventDefault();const agentIds=[...f.querySelectorAll('[name="agent"]:checked')].map(i=>i.value);if(!agentIds.length){toast('Choose at least one agent.',true);return;}action(async()=>{await api.libraryInstall({names,agentIds});closeModal();});};
  }
  function openLibraryImport(agent=null,known=null){
    modal('Add to skills library','Copy skills from an agent into Opaya\'s global library.',`<form id="library-import-form" class="mcp-form"><label>From agent<select name="agentId">${state.agents.map(x=>`<option value="${esc(x.id)}" ${agent?.id===x.id?'selected':''}>${esc(title(x))} / ${esc(location(x))}</option>`).join('')}</select></label>
      <fieldset class="transfer-part"><legend>Skills <small id="import-count"></small></legend>${modeRow('mode','all')}<div id="import-skills"></div></fieldset>
      <div class="modal-footer"><div><button type="button" class="text-button" data-action="library">Back to library</button></div><div><button type="button" class="secondary" data-action="modal-close">Cancel</button><button class="primary" type="submit">Add to library</button></div></div></form>`,true);
    const f=$('#library-import-form'),mode=()=>f.querySelector('[name="mode"]:checked')?.value;
    const sync=()=>{for(const l of f.querySelectorAll('.transfer-mode label'))l.classList.toggle('selected',l.querySelector('input').checked);$('#import-skills').classList.toggle('collapsed',mode()!=='some');};
    for(const i of f.querySelectorAll('[name="mode"]'))if(i.value==='none')i.closest('label').remove();
    const load=async(list)=>{const box=$('#import-skills');box.innerHTML='<p class="field-help">Loading skills...</p>';
      try{const skills=list||(await loadSkills(f.elements.agentId.value)).skills||[];box.innerHTML=skills.length?pickList('skill',skills.map(s=>({value:s.name,label:'/'+s.name,help:s.description}))):'<p class="field-help">No skills on this agent.</p>';$('#import-count').textContent=plural(skills.length,'skill');}
      catch(error){box.innerHTML=`<div class="message-error">${esc(error.message)}</div>`;}sync();};
    f.addEventListener('change',event=>{if(event.target.name==='agentId')load();sync();});
    load(agent&&known?known:null);
    f.onsubmit=event=>{event.preventDefault();const names=mode()==='all'?'all':[...f.querySelectorAll('[name="skill"]:checked')].map(i=>i.value);if(Array.isArray(names)&&!names.length){toast('Select skills or choose All.',true);return;}
      action(async()=>{await api.libraryImport({agentId:f.elements.agentId.value,names});closeModal();});};
  }
  // ---- Clone and redeploy (Hermes) --------------------------------------------------------------------------------
  const CLONE_SCOPES=[['everything','Everything','Config, skills, memory, personality and plugins. No chat history.'],['personality','Skills + personality','Skills, SOUL.md and USER.md (who you are), plus config.'],['skills','Skills','Installed skills and config.'],['memory','Memory','MEMORY.md and USER.md, plus config.']];
  // Hermes and the CLI agents Opaya knows (their program plus their folders) can be cloned; API connections cannot.
  const CLONE_CLI={claude:'Claude Code',codex:'Codex CLI',opencode:'OpenCode',dsh:'DeepSeek Harness',openclaw:'OpenClaw',goose:'Goose'},CLONE_DOCKER=['claude','codex','opencode','dsh'];
  const cloneable=a=>a.provider==='hermes'||Object.hasOwn(CLONE_CLI,a.install?.framework||'');
  // Containers Opaya runs an agent in, and whether a framework can live there as a profile (the service checks again).
  const CLONE_NPM=['claude','codex','opencode','dsh'],fwName=f=>f==='hermes'?'Hermes':CLONE_CLI[f]||f||'Unknown';
  const cloneFit=(from,into)=>from==='hermes'?(into==='hermes'?'':'Needs a Hermes container'):from==='openclaw'?(into==='openclaw'?'':'Needs an OpenClaw gateway container'):CLONE_NPM.includes(from)?(CLONE_NPM.includes(into)?'':'Needs a Claude Code, Codex, OpenCode or DeepSeek Harness container'):`${fwName(from)} cannot run as a profile in a container`;
  function cloneContainers(){
    const out=new Map();
    for(const x of state.agents){const c=x.install?.container;if(!c)continue;const key=`${x.transport==='ssh'?x.hostId:''}|${c}`,base=x.clone?.runtime!=='profile';if(!out.has(key)||base&&!out.get(key).base)out.set(key,{key,hostId:x.transport==='ssh'?x.hostId:'',container:c,framework:x.install.framework,agent:x,base});}
    return [...out.values()];
  }
  const PROFILE_HOW={hermes:'a Hermes profile (its own HERMES_HOME in the container)',openclaw:'another agent of the same OpenClaw gateway (openclaw agents add)',claude:'Claude Code with its own home folder in the container',codex:'Codex with its own home folder in the container',opencode:'OpenCode with its own home folder in the container',dsh:'DeepSeek Harness with its own home folder in the container'};
  // A clone's default name: the agent's name as letters, digits and dashes, with -clone, -clone-2... so it is new.
  const cloneSlug=n=>String(n||'').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9_]+/g,'-').replace(/^-+|-+$/g,'').slice(0,32)||'agent';
  const cloneName=a=>{const base=`${cloneSlug(a.name)}-clone`,taken=new Set(state.agents.map(x=>cloneSlug(x.name)));let n=base,i=2;while(taken.has(n))n=`${base}-${i++}`;return n;};
  function openClone(a,preset={}){
    if(!cloneable(a)){toast('This is an API connection: there is nothing installed to clone.');return;}
    const local=state.hosts.length===0,hermes=a.provider==='hermes',fw=a.install?.framework||'',cliName=CLONE_CLI[fw]||'',docker=hermes||CLONE_DOCKER.includes(fw);
    const here=a.transport==='ssh'?a.hostId:'',from=hermes?'hermes':fw,boxes=cloneContainers();
    const scopes=hermes?CLONE_SCOPES:CLONE_SCOPES.map(([id,label])=>[id,label,{everything:'Settings, skills, memory and instructions. No chat history.',personality:'Skills, instructions and personality files, plus settings.',skills:'Skills, commands and agents, plus settings.',memory:'Memory and instruction files, plus settings.'}[id]]);
    modal(`${preset.migrate?'Migrate':'Clone'} ${title(a)}`,preset.migrate?`Copy ${title(a)} to its new place. When the copy is there, Opaya offers to retire the original on ${location(a)}.`:hermes?'Copy this agent to this computer or a VPS, as a Hermes profile or a Docker container.':`Copy ${cliName} with its settings, skills and memory to another machine (Opaya installs it there if needed)${docker?' or into a Docker container':''}.`,`<form id="clone-form" class="mcp-form">
      <label>${preset.migrate?'Name in its new place':'Name of the clone'}<input name="name" required maxlength="40" value="${esc(preset.name||cloneName(a))}" autocomplete="off"></label>
      <fieldset class="clone-choice"><legend>Where</legend><div class="clone-where"><label class="choice-card small"><input type="radio" name="hostId" value="" ${!preset.hostId?'checked':''}><span><strong>This computer</strong><small>${!hermes&&!here?'Docker only (it is already here)':'Local'}</small></span></label>${state.hosts.map(h=>`<label class="choice-card small"><input type="radio" name="hostId" value="${esc(h.id)}" ${preset.hostId===h.id?'checked':''}><span><strong>${esc(h.name)}</strong><small>Remote / ${esc(h.alias||h.hostname)}</small></span></label>`).join('')}<button type="button" class="choice-card small add" data-action="new-vps"><span><strong>+ New VPS</strong><small>Create a key and connect</small></span></button></div></fieldset>
      <fieldset class="clone-choice"><legend>Run as</legend><div class="clone-where"><label class="choice-card small"><input type="radio" name="runtime" value="regular" ${preset.runtime!=='docker'?'checked':''}><span><strong>${hermes?'Hermes profile':'Regular install'}</strong><small>${hermes?'Needs Hermes installed there':`Installs ${esc(cliName)} there if missing`}</small></span></label>${docker?`<label class="choice-card small"><input type="radio" name="runtime" value="docker" ${preset.runtime==='docker'?'checked':''}><span><strong>Docker container</strong><small>${hermes?esc('nousresearch/hermes-agent'):'Node.js container'}, auto-restarts</small></span></label>`:''}${boxes.length?`<label class="choice-card small"><input type="radio" name="runtime" value="profile" ${preset.runtime==='profile'?'checked':''}><span><strong>Profile in a container</strong><small>Next to an agent in a container you already have</small></span></label>`:''}</div></fieldset>
      <fieldset class="clone-choice" id="clone-containers" hidden><legend>Container</legend><div class="clone-where">${boxes.map(t=>{const why=cloneFit(from,t.framework),h=state.hosts.find(x=>x.id===t.hostId);return `<label class="choice-card small"><input type="radio" name="container" value="${esc(t.key)}" ${why?'disabled':''} ${preset.container===t.key&&!why?'checked':''}><span><strong>${esc(t.container)}</strong><small>${esc(h?h.name:'This computer')} / ${esc(title(t.agent))} (${esc(fwName(t.framework))})</small>${why?`<small>${esc(why)}</small>`:''}</span></label>`;}).join('')}</div>
        <p class="field-help">${PROFILE_HOW[from]?`${esc(fwName(from))} joins the container as ${esc(PROFILE_HOW[from])}, inside its data folder, so it survives an image update. The container and its agent keep running; Opaya asks once more before it changes anything.`:`${esc(fwName(from))} cannot live as a profile in someone else's container. Clone it to a machine instead.`}</p></fieldset>
      <fieldset class="clone-choice clone-scopes"><legend>What to copy</legend>${scopes.map(([id,label,help])=>`<label class="choice-card"><input type="radio" name="scope" value="${id}" ${(preset.scope||'everything')===id?'checked':''}><span><strong>${label}</strong><small>${help}</small></span></label>`).join('')}</fieldset>
      <label class="check-row inline"><input type="checkbox" name="keys" ${preset.keys===false?'':'checked'}> ${hermes?'Include API keys (.env)':'Include logins and API keys'} so the clone works right away</label>
      <label class="check-row inline clone-cron" ${hermes?'':'hidden'}><input type="checkbox" name="cron" ${preset.cron??(preset.scope||'everything')==='everything'?'checked':''}> Include cron jobs (scheduled tasks) <small>They will run on both agents, for example posting to Slack twice.</small></label>
      <p class="field-help">${hermes?'Chat history and OAuth logins are not copied.':`Chat history is not copied. ${esc(cliName)} keeps one setup per computer account, so a regular clone goes to another machine; what is already there is kept as a .before-clone copy.`} Later, Redeploy (Deploy &amp; clone of either agent) copies the same parts again.${local?' Add a VPS to clone to a server.':''}</p>
      <p class="clone-summary" id="clone-summary" aria-live="polite"></p>
      <div id="clone-status"></div>
      <div class="modal-footer"><div></div><div><button type="button" class="secondary" data-action="modal-close">Cancel</button><button class="primary" type="submit">${preset.migrate?'Migrate':'Clone'}</button></div></div></form>`,true);
    const f=$('#clone-form');let cronTouched=preset.cron!==undefined;
    // One line that says what will happen, kept in step with the choices.
    const summary=()=>{const d=Object.fromEntries(new FormData(f)),h=state.hosts.find(x=>x.id===d.hostId),box=d.runtime==='profile'?boxes.find(t=>t.key===d.container):null,what=(scopes.find(x=>x[0]===d.scope)||[])[1]||'';
      $('#clone-summary').innerHTML=`${preset.migrate?'Moves':'Copies'} <strong>${esc(what.toLowerCase())}</strong> of ${esc(title(a))} to <strong>${esc(box?`${box.container} (a profile next to ${title(box.agent)})`:h?h.name:'this computer')}</strong>${box?'':d.runtime==='docker'?' in a new <strong>Docker container</strong>':hermes?' as a Hermes profile':''}, named <strong>${esc(d.name||'')}</strong>${d.keys?', with its API keys':', without API keys'}${hermes?d.cron?' and cron jobs':', without cron jobs':''}.${hermes&&!box&&d.runtime!=='docker'?`<small class="clone-note">A profile has its own config, memory and chats but runs on the Hermes installed on ${esc(h?h.name:'this computer')}: deleting one profile later leaves the others, uninstalling Hermes there stops them all. A Docker container is fully on its own.</small>`:''}`;};
    f.addEventListener('input',summary);f.addEventListener('change',summary);
    const syncRun=()=>{const profile=f.querySelector('[name="runtime"]:checked')?.value==='profile';$('#clone-containers').hidden=!profile;f.querySelector('.clone-where').closest('fieldset').hidden=profile;};
    for(const r of f.querySelectorAll('[name="runtime"]'))r.addEventListener('change',syncRun);syncRun();
    summary();
    f.elements.cron.addEventListener('change',()=>{cronTouched=true;});
    for(const r of f.querySelectorAll('[name="scope"]'))r.addEventListener('change',()=>{if(!cronTouched)f.elements.cron.checked=r.value==='everything';});
    f.onsubmit=event=>{event.preventDefault();const data=Object.fromEntries(new FormData(f));
      // The clone runs as a background job with its own window; this dialog closes right away.
      const box=data.runtime==='profile'?boxes.find(t=>t.key===data.container):null;
      if(data.runtime==='profile'&&!box){toast('Choose a container for the profile.',true);return;}
      action(async()=>{const job=await api.cloneAgent({id:a.id,name:data.name,hostId:box?box.hostId:data.hostId||'',runtime:data.runtime,container:box?.container||'',scope:data.scope,keys:!!data.keys,cron:!!data.cron});closeModal();if(preset.migrate&&job?.id)migrations.set(job.id,a.id);onJob(job);});
    };
  }
  async function redeploy(a){
    const src=state.agents.find(x=>x.id===a.clone?.from);if(!src){toast('The source agent of this clone was removed.',true);return;}
    if(!await ask(`Redeploy ${title(a)} from ${title(src)}?\n\nCopies ${CLONE_SCOPES.find(s=>s[0]===a.clone.scope)?.[1]||a.clone.scope}${(a.clone.cron??a.clone.scope==='everything')?' (with cron jobs)':' (without cron jobs)'} again over the clone${a.clone.container&&a.clone.runtime!=='profile'?' and restarts its container':''}. Chat history on the clone is kept.`))return;
    await action(async()=>{const job=await api.redeployAgent({id:a.id});onJob(job);});
  }
  // ---- New VPS: key, public key for the provider, connection test, save ------------------------------------------
  function openNewVps(){
    modal('Add a new VPS','Opaya creates an SSH key for this server, you add the public key to it, and Opaya checks the connection.',`<form id="vps-form" class="mcp-form">
      <div class="form-grid"><label>Name<input name="name" required maxlength="40" placeholder="vps-1" autocomplete="off"></label><label>IP address or hostname<input name="hostname" required placeholder="203.0.113.10" autocomplete="off"></label></div>
      <div class="form-grid"><label>User<input name="username" value="root" autocomplete="off"></label><label>Port<input name="port" type="number" min="1" max="65535" value="22"></label></div>
      <div class="vps-step" id="vps-key"><div><strong>1. SSH key</strong><small>A new key in ~/.ssh just for this server (reused if it exists).</small></div><button type="button" class="secondary" id="vps-make-key">Create key</button></div>
      <div id="vps-public" hidden></div>
      <div class="vps-step"><div><strong>3. Connect</strong><small>Trusts the server the first time and checks for Docker and Hermes.</small></div><button type="button" class="secondary" id="vps-test" disabled>Test connection</button></div>
      <div id="vps-status"></div>
      <div class="modal-footer"><div></div><div><button type="button" class="secondary" data-action="modal-close">Cancel</button><button class="primary" type="submit" id="vps-save" disabled>Save machine</button></div></div></form>`);
    const f=$('#vps-form'),el=n=>f.elements[n];let key=null,tested=null;
    const hostInput=()=>({name:el('name').value.trim(),hostname:el('hostname').value.trim(),username:el('username').value.trim(),port:el('port').value,identityFile:key?.identityFile||''});
    $('#vps-make-key').onclick=()=>action(async()=>{
      if(!el('name').value.trim()){el('name').focus();throw new Error('Name the VPS first.');}
      key=await api.sshKeyCreate({name:el('name').value});
      $('#vps-make-key').textContent=key.created?'Key created':'Key ready';$('#vps-make-key').disabled=true;
      const box=$('#vps-public');box.hidden=false;
      box.innerHTML=`<div class="vps-step column"><div><strong>2. Add this public key to the VPS</strong><small>In your provider's panel (SSH keys, when creating the server), or on the server: <code>echo '...' &gt;&gt; ~/.ssh/authorized_keys</code></small></div><pre class="vps-key">${esc(key.publicKey)}</pre><div class="vps-key-actions"><button type="button" class="secondary small" id="vps-copy">Copy public key</button><button type="button" class="text-button" id="vps-password">I only have a password: install it for me</button><small>${esc(key.identityFile)}</small></div></div>`;
      $('#vps-copy').onclick=()=>action(async()=>{await api.clipboardWrite({text:key.publicKey});$('#vps-copy').textContent='Copied';});
      $('#vps-password').onclick=()=>action(async()=>{const h=hostInput();if(!h.hostname)throw new Error('Enter the address first.');
        const dest=`${h.username?h.username+'@':''}${h.hostname}`,cmd=state.platform==='win32'?`type "${key.identityFile}.pub" | ssh -p ${Number(h.port)||22} -o StrictHostKeyChecking=accept-new ${dest} "umask 077; mkdir -p ~/.ssh; cat >> ~/.ssh/authorized_keys"`:`ssh-copy-id -o StrictHostKeyChecking=accept-new -i '${key.identityFile}.pub' -p ${Number(h.port)||22} ${dest}`;
        if(!/^[\w.@:-]+$/.test(dest))throw new Error('Check the user and address.');
        await openTerminal({local:true});if(currentTerminal)await api.terminalWrite({id:currentTerminal,data:cmd+'\r'});toast('Type the server password in the terminal, then test the connection.');});
      $('#vps-test').disabled=false;
    });
    $('#vps-test').onclick=()=>action(async()=>{
      $('#vps-status').innerHTML='<div class="clone-progress"><span class="status-dot working"></span> Connecting...</div>';
      try{tested=await api.hostTest({host:hostInput()});$('#vps-status').innerHTML=`<div class="inline-notice ok-notice"><p>Connected${tested.system?` to ${esc(tested.system)}`:''}. Docker: ${tested.docker?'yes':'no'}. Hermes: ${tested.hermes?'installed':'not installed'}.</p></div>`;$('#vps-save').disabled=false;}
      catch(error){$('#vps-status').innerHTML=`<div class="inline-notice error-notice"><p>${esc(error.message)}</p></div>`;}
    });
    f.onsubmit=event=>{event.preventDefault();action(async()=>{const h=await api.saveHost(hostInput());closeModal();await refresh();toast(`${h.name} saved.${tested&&!tested.hermes?' Install Hermes on it from Install agents, or clone an agent there as a Docker container.':''}`);if(tested?.hermes)discover(h.id);});};
    el('name').focus();
  }
  // ---- Updates: check GitHub releases, download, verify and install in place ------------------------------------
  let update={status:'idle'};
  function renderUpdate(){
    const chip=$('#status-update');if(chip){const show=['available','downloading','ready','failed'].includes(update.status);chip.hidden=!show;chip.textContent=update.status==='downloading'?`Downloading update ${update.progress||0}%`:update.status==='ready'?'Restart to update':update.status==='failed'?`Update ${update.latest?.version||''} did not install`:`Update ${update.latest?.version||''} available`;chip.classList.toggle('ready',update.status==='ready');chip.classList.toggle('failed',update.status==='failed');}
    const body=$('#update-body');if(!body)return;
    const u=update,l=u.latest,busy=['checking','downloading'].includes(u.status);
    const line={idle:'Not checked yet.',checking:'Checking GitHub releases...',current:`You have the latest version${u.checkedAt?` (checked ${new Date(u.checkedAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})})`:''}.`,available:`Opaya ${l?.version} is available.`,downloading:`Downloading Opaya ${l?.version}...`,ready:`Opaya ${l?.version} is downloaded and verified.`,error:u.error||'Update failed.',unsupported:u.error||'Updates are not available on this system.'}[u.status]||'';
    body.innerHTML=`<div class="update-versions"><div><small>Installed</small><strong>${esc(u.current||'')}</strong></div>${l?`<div><small>Latest</small><strong>${esc(l.version)}</strong></div>`:''}</div>
      <p class="update-line ${['error','failed'].includes(u.status)?'error':''}">${esc(line)}</p>
      ${u.status==='downloading'?`<div class="update-progress" role="progressbar" aria-valuenow="${u.progress||0}" aria-valuemin="0" aria-valuemax="100"><span style="width:${u.progress||0}%"></span></div>`:''}
      ${l&&['available','downloading','ready'].includes(u.status)&&l.notes?`<div class="update-notes">${esc(l.notes)}</div>`:''}
      <p class="field-help">Downloads come from this app's GitHub releases and are checked against the release's SHA-256 list before anything installs.${state.platform==='darwin'?' On macOS, Opaya must be in Applications.':''}</p>
      <div class="modal-footer"><div>${l?.url?`<button type="button" class="text-button" data-update="page">Release page</button>`:''}</div><div>
        <button type="button" class="secondary" data-update="check" ${busy?'disabled':''}>Check again</button>
        ${u.status==='available'?'<button type="button" class="primary" data-update="download">Download update</button>':''}
        ${u.status==='ready'?'<button type="button" class="primary" data-update="install">Restart and update</button>':''}
        ${u.status==='failed'&&u.file&&state.platform==='win32'?'<button type="button" class="primary" data-update="installer">Run installer</button>':''}
      </div></div>`;
  }
  function openUpdates(){
    modal('Updates','Get new Opaya versions without reinstalling.',`<div id="update-body"></div>`);renderUpdate();
    $('#update-body').addEventListener('click',event=>{const b=event.target.closest('[data-update]');if(!b)return;const act=b.dataset.update;
      if(act==='check')action(()=>api.updateCheck());
      else if(act==='download')action(()=>api.updateDownload());
      else if(act==='install')action(async()=>{modalBusy=false;if(!await opayaAsk({title:`Install Opaya ${update.latest?.version||''} now?`,text:'Opaya closes, installs the update and opens again. Local agent processes and local shells end; remote tmux sessions keep running. Saved chats and settings stay.',ok:'Restart and update'}))return;await api.updateInstall({confirmed:true});});
      else if(act==='installer')action(async()=>{if(!await opayaAsk({title:`Install Opaya ${update.latest?.version||''} with the installer?`,text:'Opaya closes so the installer can replace its files. Follow the installer, then open Opaya again.',ok:'Open installer'}))return;await api.updateRunInstaller({confirmed:true});});
      else if(act==='page'&&update.latest?.url)action(()=>api.openLink({url:update.latest.url}));});
    if(['idle','error','current'].includes(update.status)&&(!update.checkedAt||Date.now()-update.checkedAt>60000))action(()=>api.updateCheck());
  }
  api.onUpdate?.(value=>{const was=update.status;update=value||{status:'idle',failed:u.error};renderUpdate();if(was!=='available'&&update.status==='available'&&!$('#app-dialog'))toast(`Opaya ${update.latest?.version} is available. Click the notice in the status bar to update.`);});
  api.updateState?.().then(value=>{update=value||update;renderUpdate();
    // Confirm a finished update after the restart.
    const confirm=()=>{if(!initialized){setTimeout(confirm,500);return;}const before=lastVersion;if(update.current&&before!==update.current){if(before&&compareVersions(update.current,before)>0){if(WHATS_NEW[update.current])openWhatsNew(update.current);else toast(`Opaya updated to ${update.current}.`);}lastVersion=update.current;saveView();}};confirm();
  }).catch(()=>{});
  function compareVersions(a,b){const x=String(a).split('.').map(Number),y=String(b).split('.').map(Number);for(let i=0;i<3;i++){if((x[i]||0)!==(y[i]||0))return (x[i]||0)>(y[i]||0)?1:-1;}return 0;}
  // ---- Layout: the terminal and the browser dock at the bottom (side by side) or on the right (stacked) -------------
  const saveLayout=()=>saveView();
  const clampBottom=h=>Math.max(160,Math.min(window.innerHeight-200,h)),clampRight=w=>Math.max(300,Math.min(window.innerWidth-560,w));
  function placePanes(){
    const stage=document.body.classList.contains('terminal-stage');
    for(const name of ['terminal','browser']){const where=name==='terminal'&&stage?'bottom':layout[name];const pane=$(`[data-pane="${name}"].dock-pane`),dock=$(`#dock-${where==='right'?'right':'bottom'} .dock-panes`);if(pane&&pane.parentElement!==dock)dock.append(pane);}
    for(const v of terminalViews.values())if(!v.element.hidden&&!v.exited)requestAnimationFrame(()=>v.core?.fitAndReport(v.report));
    syncDocks();
  }
  function syncDocks(){
    for(const id of ['dock-bottom','dock-right']){const dock=$('#'+id),any=[...dock.querySelectorAll('.dock-pane')].some(p=>!p.hidden);dock.hidden=!any;}
    $('#dock-bottom').style.height=clampBottom(layout.bottomHeight)+'px';$('#dock-right').style.width=clampRight(layout.rightWidth)+'px';
    for(const b of document.querySelectorAll('[data-action="dock-move"]')){const where=layout[b.dataset.pane];b.title=where==='right'?'Move to the bottom':'Move to the side';b.classList.toggle('to-bottom',where==='right');}
    placeBrowser();
  }
  function moveDock(name){layout[name]=layout[name]==='right'?'bottom':'right';saveLayout();placePanes();for(const v of terminalViews.values())requestAnimationFrame(()=>{if(!v.exited)v.core?.fitAndReport(v.report);});}
  for(const grip of document.querySelectorAll('.dock-grip')){
    const side=grip.dataset.grip;
    grip.addEventListener('pointerdown',e=>{const start=side==='bottom'?e.clientY:e.clientX,size=side==='bottom'?$('#dock-bottom').offsetHeight:$('#dock-right').offsetWidth;grip.setPointerCapture(e.pointerId);document.body.classList.add('dock-resizing');
      const move=event=>{if(side==='bottom')layout.bottomHeight=clampBottom(size+start-event.clientY);else layout.rightWidth=clampRight(size+start-event.clientX);syncDocks();};
      grip.addEventListener('pointermove',move);grip.addEventListener('lostpointercapture',()=>{grip.removeEventListener('pointermove',move);document.body.classList.remove('dock-resizing');saveLayout();},{once:true});});
    grip.addEventListener('keydown',e=>{const step=e.key==='ArrowUp'||e.key==='ArrowLeft'?32:e.key==='ArrowDown'||e.key==='ArrowRight'?-32:0;if(!step)return;e.preventDefault();if(side==='bottom')layout.bottomHeight=clampBottom(layout.bottomHeight+step);else layout.rightWidth=clampRight(layout.rightWidth+step);syncDocks();saveLayout();});
  }
  // Panes show and hide through their hidden attribute (many places toggle the terminal); keep the docks in step.
  new MutationObserver(syncDocks).observe($('#terminal-panel'),{attributes:true,attributeFilter:['hidden']});
  new MutationObserver(syncDocks).observe($('#browser-panel'),{attributes:true,attributeFilter:['hidden']});
  const expand=document.createElement('button');expand.type='button';expand.className='term-icon';expand.innerHTML='<span class="term-expand-glyph" aria-hidden="true"></span>';expand.title='Expand / restore';expand.setAttribute('aria-label',expand.title);let savedSize=0;
  expand.onclick=()=>{const right=layout.terminal==='right';if(savedSize){if(right)layout.rightWidth=savedSize;else layout.bottomHeight=savedSize;savedSize=0;}else{savedSize=right?layout.rightWidth:layout.bottomHeight;if(right)layout.rightWidth=window.innerWidth;else layout.bottomHeight=window.innerHeight;}syncDocks();saveLayout();};
  $('.terminal-actions [data-action="dock-move"]').before(expand);
  // ---- Opaya browser pane -------------------------------------------------------------------------------------------
  let browserState={url:''},browserFrame=0,agentBrowsingTimer=0,browserShown='user';
  // Each agent has its own browser tab; the pane shows the tab of the agent on screen, else the user's own.
  function browserOwner(){const a=selected();return !overview&&!opayaView&&!playgroundView&&a&&hasBrowser(a)?a.id:'user';}
  function placeBrowser(){
    cancelAnimationFrame(browserFrame);
    browserFrame=requestAnimationFrame(()=>{
      if(!api.browserPlace)return;const panel=$('#browser-panel'),view=$('#browser-view'),owner=browserOwner();
      if(owner!==browserShown){browserShown=owner;browserState={url:''};api.browserState?.({owner}).then(st=>{if(browserShown===owner){browserState=st||{url:''};renderBrowser();}}).catch(()=>{});}
      $('#browser-panel').dataset.owner=owner;const who=$('#browser-owner');if(who){const a=owner==='user'?null:state.agents.find(x=>x.id===owner);who.textContent=a?`${title(a)}'s browser`:'Your browser';}
      const covered=!!document.querySelector('dialog[open],.context-menu')||document.body.classList.contains('dock-resizing');
      const shown=!panel.hidden&&!covered&&!!browserState.url;const r=view.getBoundingClientRect();
      $('.browser-empty').hidden=!!browserState.url;
      api.browserPlace({x:r.left,y:r.top,width:r.width,height:r.height,visible:shown,owner}).catch(()=>{});
    });
  }
  // Cookies from Chrome or Edge (or a file exported from a browser) into the browsers the user picks.
  async function openCookieImport(){
    const owner=browserOwner(),agents=state.agents.filter(a=>hasBrowser(a));let sources=[];
    try{sources=await api.cookieSources?.()||[];}catch(error){toast(error.message,true);}
    const tick=(v,label,small,checked)=>`<label class="pick-item"><input type="checkbox" name="owner" value="${esc(v)}" ${checked?'checked':''}><span><strong>${esc(label)}</strong><small>${esc(small)}</small></span></label>`;
    modal('Import cookies','So the Opaya browser is signed in where you are. Cookies stay on this computer; each browser keeps its own.',`<form id="cookie-form" class="cookie-form">
      <h3>From</h3><div class="pick-list">${sources.map((x,i)=>`<label class="pick-item"><input type="radio" name="source" value="${i}" ${i?'':'checked'}><span><strong>${esc(x.label)}</strong><small>${esc(x.name===x.profile?x.profile:`${x.name} (${x.profile})`)}</small></span></label>`).join('')}<label class="pick-item"><input type="radio" name="source" value="file" ${sources.length?'':'checked'}><span><strong>A cookies.txt or JSON file</strong><small>Exported from any browser, for example with the Get cookies.txt or Cookie-Editor extension</small></span></label></div>
      ${sources.length?'':'<p class="field-help">No Chrome or Edge profile was found on this computer.</p>'}
      <label class="field"><span>Only these sites <em>optional, separated by commas</em></span><input name="domains" placeholder="youtube.com, google.com, github.com" autocomplete="off" spellcheck="false"></label>
      <h3>Into</h3><div class="pick-list">${tick('user','Your browser','On Home and the other shared screens',owner==='user')}${agents.map(a=>tick(a.id,`${title(a)}'s browser`,placeText(a),owner===a.id)).join('')}</div>
      <p class="field-help">Close Chrome or Edge first if it says the cookie file is in use. Chrome and Edge 127 and later on Windows lock some cookies so only they can read them; for those sites, export a cookies.txt from the browser and import the file.</p>
      <div class="modal-footer"><span></span><div><button type="button" class="secondary" data-action="modal-close">Cancel</button><button type="submit" class="primary">Import cookies</button></div></div></form>`,true);
    $('#cookie-form').addEventListener('submit',event=>{event.preventDefault();const f=event.target,src=f.elements.source.value,owners=[...f.querySelectorAll('[name="owner"]:checked')].map(i=>i.value),domains=f.elements.domains.value.split(/[\s,;]+/).map(x=>x.trim().replace(/^https?:\/\//,'').replace(/\/.*$/,'')).filter(Boolean);
      if(!owners.length){toast('Choose at least one browser to import into.',true);return;}
      action(async()=>{let input;if(src==='file'){const file=await api.pickCookieFile?.();if(!file)return;input={file};}else{const x=sources[Number(src)];input={browser:x.browser,profile:x.profile};}
        const b=f.querySelector('[type=submit]');b.disabled=true;b.textContent='Importing...';
        try{const r=await api.cookieImport({...input,domains,owners});closeModal();
          toast(`${r.set?`Imported ${plural(r.found,'cookie')} from ${r.label} into ${plural(r.owners.length,'browser')}.`:`No cookies imported from ${r.label}.`}${r.unreadable?` ${r.unreadable} could not be read (locked by the browser${r.locked.length?`: ${r.locked.slice(0,4).join(', ')}${r.locked.length>4?'...':''}`:''}); export those sites as cookies.txt and import the file.`:''}`,!r.set);
          if(owners.includes(browserOwner())&&browserState.url)api.browserNav({action:'reload',owner:browserOwner()}).catch(()=>{});}
        finally{b.disabled=false;b.textContent='Import cookies';}});});
  }
  function showBrowser(){$('#browser-panel').hidden=false;syncDocks();}
  async function openInBrowser(url){showBrowser();try{browserState=await api.browserOpen({url,owner:browserOwner()});}catch(error){toast(error.message,true);}renderBrowser();}
  function renderBrowser(){
    const input=$('#browser-url');if(document.activeElement!==input)input.value=browserState.url?.startsWith('data:')?'Preview':browserState.url||'';
    $('[data-browser="back"]').disabled=!browserState.canGoBack;$('[data-browser="forward"]').disabled=!browserState.canGoForward;
    $('#browser-panel').classList.toggle('loading',!!browserState.loading);$('.browser-lock').classList.toggle('secure',String(browserState.url).startsWith('https:'));
    placeBrowser();
  }
  new ResizeObserver(placeBrowser).observe($('#browser-view'));window.addEventListener('resize',placeBrowser);
  new MutationObserver(placeBrowser).observe(document.body,{childList:true,subtree:false});
  new MutationObserver(placeBrowser).observe($('#modal-root'),{childList:true,subtree:true,attributes:true,attributeFilter:['open']});
  api.onBrowser?.(value=>{
    // Another agent's tab (it works while you are elsewhere) does not take over this screen's browser.
    if(value?.owner&&value.owner!==browserOwner())return;
    browserState=value||browserState;
    if(value?.request==='hide'){browserState={url:''};$('#browser-panel').hidden=true;renderBrowser();return;}
    if(value?.request==='show'){showBrowser();if(value.agent){const badge=$('#browser-agent');badge.hidden=false;clearTimeout(agentBrowsingTimer);agentBrowsingTimer=setTimeout(()=>{badge.hidden=true;},8000);}}
    renderBrowser();
  });
  $('#browser-form').addEventListener('submit',event=>{event.preventDefault();const v=$('#browser-url').value.trim();if(v)openInBrowser(v);});
  $('#browser-panel').addEventListener('click',event=>{
    const b=event.target.closest('[data-browser]');if(!b)return;const act=b.dataset.browser;
    // Close forgets the page (logins stay): the next open starts empty, for you and for the agent.
    if(act==='close'){$('#browser-panel').hidden=true;const owner=browserOwner();browserState={url:''};api.browserClose?.({owner}).catch(()=>{});return;}
    if(act==='cookies'){openCookieImport();return;}
    if(act==='external'){if(browserState.url&&!browserState.url.startsWith('data:'))action(()=>api.openLink({url:browserState.url}));return;}
    action(async()=>{browserState=await api.browserNav({action:act,owner:browserOwner()});renderBrowser();});
  });
  // ---- Rich message actions: links, copy and preview -----------------------------------------------------------------
  document.addEventListener('click',event=>{
    const el=event.target.closest('[data-action="open-link"],[data-action="md-copy"],[data-action="md-preview"],[data-action="md-run"]');if(!el)return;event.preventDefault();event.stopPropagation();
    const act=el.dataset.action;
    if(act==='open-link'){const url=el.dataset.url;if(!url)return;if(url.startsWith('mailto:')||el.dataset.external||event.ctrlKey||event.metaKey||event.shiftKey)action(()=>api.openLink({url}));else openInBrowser(url);return;}
    const code=el.closest('.code-block')?.querySelector('pre')?.textContent||'';
    if(act==='md-copy'){action(async()=>{await api.clipboardWrite({text:code});el.textContent='Copied';setTimeout(()=>{el.textContent='Copy';},1400);});return;}
    if(act==='md-preview'){showBrowser();action(async()=>{browserState=await api.browserPreview({html:code,owner:browserOwner()});renderBrowser();});}
    if(act==='md-run'){const win=el.closest('.chat-win'),c=win&&dockConv(win.dataset.conv),a=c?state.agents.find(x=>x.id===c.agentId):selected();if(a)action(()=>runInShell(a,code));}
  },true);
  // Run in console: the command goes into the agent's shell window as a paste (lines wait for Enter where the shell
  // supports bracketed paste), so nothing runs before the user looks at it. "$ " prompts copied with it are dropped.
  async function runInShell(a,code){
    const text=code.replace(/\n$/,'').split('\n').map(l=>l.replace(/^\s*[$>]\s+/,'')).join('\n');
    let view=ctxWindows(a.id).find(v=>v.mode!=='agent'&&!v.exited)||[...terminalViews.values()].find(v=>v.agentId===a.id&&v.mode!=='agent'&&!v.exited);
    if(view)showWindow(view.id);else{const id=await openTerminal({agentId:a.id});view=terminalViews.get(id);}
    if(!view)return;view.term.paste(text);view.term.focus();toast(`In ${tabTitle(view)}: press Enter to run it.`);
  }
  // Ask the agent: text selected in a terminal goes into the agent's chat box as a quote, to send with a question.
  async function askInChat(a,text){
    if(state.activeAgentId!==a.id||modeOf(a)!=='chat'||overview||opayaView||playgroundView)await setAgentMode(a,'chat');
    const box=$('#message-input');if(!box)return;const quote='```\n'+text.replace(/\s+$/,'')+'\n```\n';
    box.value=(box.value.trim()?box.value.replace(/\s+$/,'')+'\n\n':'')+quote;drafts.set(draftKey(),box.value);box.dispatchEvent(new Event('input',{bubbles:true}));box.focus();box.setSelectionRange(box.value.length,box.value.length);
  }
  placePanes();
  const approvalQueue=[];let approvalVisible=false;
  function showApproval(){
    if(approvalVisible||!approvalQueue.length)return;approvalVisible=true;const request=approvalQueue.shift(),dialog=document.createElement('dialog');dialog.className='approval-dialog';
    // A secure prompt (the Opaya Agent's request_secret): a password field. The value goes back only with this answer,
    // into Opaya's vault; the chat and the model get a reference.
    if(request.kind==='secret'){
      const s=request.secret||{};dialog.classList.add('secret-prompt');
      dialog.innerHTML=`<form><h2>${esc(request.title)}</h2>${s.why?`<p>${esc(s.why)}</p>`:''}${s.for?`<p class="secret-for">For ${esc(s.for)}</p>`:''}<label class="field"><span>${esc(s.name||'Secret')}</span><input name="value" type="password" autocomplete="off" spellcheck="false" maxlength="12000" required></label><p class="field-help">Opaya keeps it in its encrypted vault. The Opaya Agent gets only a reference, so its model never sees the value.</p><footer><button type="button" class="secondary" data-choice="deny">Cancel</button><button type="submit" class="primary">Give to Opaya</button></footer></form>`;
      const form=dialog.querySelector('form'),done=value=>{api.approvalAnswer(value?{id:request.id,choice:'once',value}:{id:request.id,choice:'deny'}).catch(error=>toast(error.message,true));dialog.close();dialog.remove();approvalVisible=false;showApproval();};
      form.addEventListener('submit',e=>{e.preventDefault();const value=form.elements.value.value.trim();form.elements.value.value='';if(value)done(value);});
      dialog.addEventListener('click',e=>{if(e.target.closest('[data-choice="deny"]'))done('');});dialog.addEventListener('cancel',e=>{e.preventDefault();done('');});
      document.body.append(dialog);dialog.showModal();form.elements.value.focus();return;
    }
    dialog.innerHTML=`<h2>${esc(request.title)}</h2><p>${esc(request.agent?.name||'Agent')}</p><pre>${esc(request.detail)}</pre><footer><button class="secondary" data-choice="deny">Deny</button><button class="secondary" data-choice="always">Allow always</button><button class="primary" data-choice="once">Allow once</button></footer>`;
    const finish=choice=>{api.approvalAnswer({id:request.id,choice}).catch(error=>toast(error.message,true));
      // The Opaya Agent's commands differ every time, so Allow always turns on iTrust for it.
      if(choice==='always'&&request.agent?.name==='Opaya Agent'&&!state.settings?.itrustOpaya)api.saveSettings({itrustOpaya:true}).then(()=>{toast('iTrust is on for the Opaya Agent: it will not ask again.');refresh();}).catch(error=>toast(error.message,true));dialog.close();dialog.remove();approvalVisible=false;showApproval();};
    dialog.addEventListener('click',e=>{const choice=e.target.closest('[data-choice]');if(choice)finish(choice.dataset.choice);});dialog.addEventListener('cancel',e=>{e.preventDefault();finish('deny');});document.body.append(dialog);dialog.showModal();dialog.querySelector('button').focus();
  }
  api.onApproval?.(request=>{approvalQueue.push(request);showApproval();});
  api.onTerminalDocked?.(({id})=>{const view=terminalViews.get(id);if(view){view.poppedOut=false;view.term.options.disableStdin=view.exited;view.hiddenPane=false;if((view.ctx||'')===termCtx()){$('#terminal-panel').hidden=false;activateTerminal(id);}render();saveView();}});
  api.onState(applyState);api.onTerminal(terminalEvent);api.onServiceError?.(message=>toast(message,true));
  action(async()=>{
    const initial=await api.snapshot();applyState(initial);
    for(const t of initial.terminals||[]){if(t.exited)savedSessions.set(t.id,t);else await openTerminal({terminalId:t.id,restoring:true});}
    $('#terminal-panel').hidden=!initial.view?.terminalVisible;
    // Each window back on its screen, hidden or not, with its size; then the panel for the screen in use.
    for(const [id,ctx,hidden] of initial.view?.windows||[]){const v=terminalViews.get(id);if(v){v.ctx=ctx==='opaya'||state.agents.some(a=>a.id===ctx)?ctx:'';v.hiddenPane=!!hidden;}}
    terminalWorkspaces.clear();
    for(const w of TL.workspaces(initial.view?.terminalWorkspaces))if(!w.ctx||state.agents.some(a=>a.id===w.ctx))terminalWorkspaces.set(w.ctx,w);
    for(const ctx of new Set([...terminalViews.values()].map(v=>v.ctx||''))){
      if(terminalWorkspaces.has(ctx))continue;
      const ids=ctxWindows(ctx).filter(v=>!v.hiddenPane).map(v=>v.id),old=(initial.view?.panes||[]).filter(id=>ids.includes(id));
      const ordered=[...old,...ids.filter(id=>!old.includes(id))],weights=ordered.map(id=>initial.view?.paneSizes?.[(initial.view?.panes||[]).indexOf(id)]||1);
      terminalWorkspaces.set(ctx,{ctx,tree:TL.preset(ordered,layout.arrange,weights),active:ids.includes(initial.view?.terminalId)?initial.view.terminalId:ordered[0]||'',visible:!!initial.view?.terminalVisible,dock:layout.terminal});
    }
    restoringWorkspace=false;termCtxShown=null;currentTerminal='';render();saveView();

  });
})();
