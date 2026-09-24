/* Opaya renderer. No Node access, remote HTML, tokens in storage or generic IPC. */
'use strict';
(() => {
  const api = window.agenthub;
  const $ = (selector, root = document) => root.querySelector(selector);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const labels = {hermes:'Hermes',codex:'Codex',claude:'Claude Code',openclaw:'OpenClaw',deepseek:'DeepSeek',openai:'OpenAI',google:'Google Gemini',openrouter:'OpenRouter',xai:'xAI',groq:'Groq',mistral:'Mistral',ollama:'Ollama',lmstudio:'LM Studio',custom:'Custom agent'};
  const title = a => a?.displayName || a?.name || 'Agent';
  const description = a => a?.description || a?.note || labels[a?.provider] || 'Agent';
  // Icon library: the four website logos plus curated LobeHub icons (ui/assets/icons, MIT). Agents default to their provider's logo.
  const ICONS={hermes:['Hermes','assets/agents/hermes.png'],codex:['Codex','assets/agents/codex.svg'],claude:['Claude','assets/agents/claude.png'],openclaw:['OpenClaw','assets/agents/openclaw.svg'],
    ...Object.fromEntries([['hermes-agent','Hermes Agent'],['nous-research','Nous Research'],['claude-code','Claude Code'],['anthropic','Anthropic'],['gemini-cli','Gemini CLI'],['gemini','Gemini'],['opencode','OpenCode'],['goose','Goose'],['openhands','OpenHands'],['cline','Cline'],['kilo-code','Kilo Code'],['roo-code','Roo Code'],['amp','Amp'],['cursor','Cursor'],['windsurf','Windsurf'],['junie','Junie'],['github-copilot','GitHub Copilot'],['copilot','Copilot'],['openai','OpenAI'],['qwen','Qwen'],['deepseek','DeepSeek'],['kimi','Kimi'],['mistral','Mistral'],['ollama','Ollama'],['lm-studio','LM Studio'],['openrouter','OpenRouter'],['grok','Grok'],['meta-ai','Meta AI'],['manus','Manus'],['zhipu','Zhipu']].map(([id,label])=>[id,[label,`assets/icons/${id}.svg`]]))};
  const agentLogos={hermes:ICONS.hermes[1],codex:ICONS.codex[1],claude:ICONS.claude[1],openclaw:ICONS.openclaw[1],deepseek:ICONS.deepseek[1],openai:ICONS.openai[1],google:ICONS.gemini[1],openrouter:ICONS.openrouter[1],xai:ICONS.grok[1],groq:ICONS['gpt-oss']?.[1],mistral:ICONS.mistral[1],ollama:ICONS.ollama[1],lmstudio:ICONS['lm-studio'][1]};
  const iconImg=(src,cls='')=>`<img class="agent-logo ${cls}" src="${esc(src)}" alt="" draggable="false">`;
  const avatarSrc=a=>{const v=a?.avatar||'';if(v.startsWith('lib:'))return ICONS[v.slice(4)]?.[1]||'';if(v.startsWith('data:image/'))return v;return '';};
  const providerIcon = provider => agentLogos[provider]?`<img class="agent-logo ${provider}-logo" src="${agentLogos[provider]}" alt="" draggable="false">`:'<span class="mark custom-mark"><i></i></span>';
  let state = {agents:[],hosts:[],conversations:[],histories:{},secureStorage:false}, overview = true, opayaView = false, playgroundView = false, renderKey = '', initialized = false, theme = 'dark';
  let toastTimer, returnFocus, currentTerminal = '', lastSelected = '', modalBusy = false;
  const pendingWrites = new Set();
  const draftKey = () => currentConversation()?.id || selected()?.id || '';
  const save = promise => { pendingWrites.add(promise); promise.catch(error=>toast(error.message,true)).finally(()=>pendingWrites.delete(promise)); return promise; };
  window.agenthubFlush = () => Promise.allSettled([...pendingWrites]);
  const saveView = () => { if(api.saveView)save(api.saveView({overview,opaya:opayaView,playground:playgroundView,collapsed:[...collapsedGroups],terminalVisible:!$('#terminal-panel').hidden,terminalId:currentTerminal,theme,projects:projectsOpen,projectsOpen:[...projectsExpanded],layout,tips:[...tipsSeen].slice(-60),greeted})); };
  const drafts = new Map(), pendingSends = new Set(), terminalViews = new Map(), terminalPending = new Map();
  const selected = () => state.agents.find(a => a.id === state.activeAgentId);
  const currentConversation = () => state.conversations.find(c => c.id === state.activeConversationId && c.agentId === state.activeAgentId);
  const location = a => a.transport === 'ssh' ? (state.hosts.find(h=>h.id===a.hostId)?.name || 'SSH host') : 'This computer';
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
  // Motion bookkeeping: state updates re-render often, so entrance animations are keyed to first appearance, not to every render.
  let tipsSeen=new Set(),greeted='',collapsedGroups=new Set(),projectsOpen=false,projectsExpanded=new Set(),layout={terminal:'bottom',browser:'right',bottomHeight:280,rightWidth:520};
  const navSeen=new Map(),messageSeen=new Map();let navHtml='',navSelected='',navSelectedAt=0,messageConversation=null,overviewHtml='';
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
  async function action(fn) { try { return await fn(); } catch(error) {toast(error.message,true); return undefined;} }
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
    if(!initialized){overview=state.view?.overview??!state.activeAgentId;opayaView=!!state.view?.opaya;playgroundView=!!state.view?.playground&&!opayaView;collapsedGroups=new Set(state.view?.collapsed||[]);projectsOpen=!!state.view?.projects;tipsSeen=new Set(state.view?.tips||[]);greeted=state.view?.greeted||'';setTimeout(checkNudges,4000);if(state.view?.layout)layout={...layout,...state.view.layout};queueMicrotask(()=>placePanes());projectsExpanded=new Set(state.view?.projectsOpen||[]);if(projectsOpen)setTimeout(()=>refreshProjectGit(),300);applyTheme(state.view?.theme||'dark');for(const [key,value]of Object.entries(state.drafts||{}))drafts.set(key,value);initialized=true;if(state.recoveryNotice)toast(state.recoveryNotice,true);renderWindowControls();api.windowControl?.({action:'state'}).then(v=>{windowState=v;renderWindowControls();}).catch(()=>{});$('.search-trigger kbd').textContent=`${mod()}K`;}
    render();
  }
  function render() {
    queueMicrotask(()=>{ensureProjectsToggle();renderProjects();});
    $('#agent-count').textContent=state.agents.length;
    $('#host-count').textContent=state.hosts.length;
    $('.nav-overview').classList.toggle('selected',overview&&!opayaView&&!playgroundView);$('.nav-playground')?.classList.toggle('selected',playgroundView);$('.nav-opaya').classList.toggle('selected',opayaView);renderOpayaNav();
    // Sections: pinned, each custom group in first-seen order, then ungrouped local and remote agents. Every section collapses.
    const customGroups=[...new Set(state.agents.filter(a=>!a.pinned&&a.group).map(a=>a.group))];
    const groups=[['pinned','PINNED',state.agents.filter(a=>a.pinned)],...customGroups.map(g=>[`group:${g}`,g,state.agents.filter(a=>!a.pinned&&a.group===g)]),['local','ON THIS COMPUTER',state.agents.filter(a=>!a.pinned&&!a.group&&a.transport!=='ssh')],['remote','REMOTE AGENTS',state.agents.filter(a=>!a.pinned&&!a.group&&a.transport==='ssh')]];
    const now=performance.now(),current=overview||opayaView||playgroundView?'':state.activeAgentId||'';let row=0;
    if(current!==navSelected){navSelected=current;navSelectedAt=now;}
    const nav=groups.filter(g=>g[2].length).map(([key,name,all])=>{const closed=collapsedGroups.has(key),agents=closed?all.filter(a=>a.id===current):all,busy=closed&&all.some(a=>a.busy);return `<button class="sidebar-section-label ${closed?'collapsed':''} ${key.startsWith('group:')?'custom-group':''}" data-action="toggle-group" data-group="${esc(key)}" aria-expanded="${!closed}" title="${closed?'Expand':'Collapse'} ${esc(name)} (right-click for group actions)"><span class="group-chevron" aria-hidden="true">&#9662;</span><span class="group-name">${esc(name)}</span>${busy?'<span class="status-dot working"></span>':''}<span class="group-count">${all.length}</span></button><div class="sidebar-group ${closed?'closed':''}">${agents.map(a=>`<div class="agent-nav-row ${fresh(navSeen,a.id,now,650)?'enter':''}" style="--i:${row++}" data-agent-id="${esc(a.id)}" data-section="${esc(key)}" draggable="true"><button class="agent-nav ${!overview&&!opayaView&&!playgroundView&&a.id===state.activeAgentId?'selected':''} ${a.id===navSelected&&now-navSelectedAt<500?'just-selected':''}" data-action="select" data-id="${esc(a.id)}" title="${esc(title(a)+' / '+placeText(a)+' / '+status(a))}">${badge(a)}<span class="agent-nav-text"><strong>${esc(title(a))}${trusted(a)?'<span class="itrust-mark" title="iTrust: approved automatically">iT</span>':''}</strong><small>${esc(description(a))}</small></span>${dot(a)}</button></div>`).join('')}</div>`;}).join('')||'<div class="sidebar-empty"><span class="connection-dots"><i></i><i></i><i></i></span>Your agents will<br>feel at home here.</div>';
    if(nav!==navHtml){navHtml=nav;$('#agent-list').innerHTML=nav;}
    const a=selected();
    if(opayaView)renderOpaya();else if(playgroundView)renderPlayground();else if(overview||!a)renderOverview();else renderAgent(a);
    $('#status-left').textContent=playgroundView?'Playground / ask two agents the same question':opayaView?'Opaya Agent / installs, connects and troubleshoots your agents':a&&!overview?`${labels[a.provider]} / ${a.protocol==='openai'?'Gateway API':a.protocol.toUpperCase()} / ${location(a)}`:'One place. All your agents.';
    $('#status-right').textContent=state.agents.some(a=>a.busy)?`${state.agents.filter(a=>a.busy).length} agent working`:(state.service?.persistent?'Sessions protected / safe to close window':'Local workspace / no cloud account');
    updateTurnWatch();
    if(lastSelected!==state.activeAgentId){lastSelected=state.activeAgentId;if(!$('#terminal-panel').hidden){const match=[...terminalViews.values()].find(v=>v.agentId===state.activeAgentId&&!v.exited);activateTerminal(match?.id||'');}}
  }
  function renderOverview() {
    $('#topbar').innerHTML='<div class="breadcrumb">Workspace <span>/</span> Overview</div><div class="topbar-actions"><button class="subtle" data-action="connect-all" title="Connect every agent at once">Connect all</button><button class="subtle" data-action="hosts">Manage machines</button><button class="secondary" data-action="discover"><span class="radar-icon"></span> Discover agents</button></div>';
    const connected=state.agents.filter(a=>a.status==='connected').length,entering=renderKey!=='overview';
    contentKind('overview');
    const html=`<div class="workspace-heading"><div><div class="eyebrow"><span class="tiny-square"></span> YOUR AGENT WORKSPACE</div><h1>One place.<br>All your agents.</h1><p>From the machine in front of you to the server across the world.<br>Connect, switch, and keep the conversation going.</p></div><div class="workspace-art" aria-hidden="true"><div class="orbit orbit-one"></div><div class="orbit orbit-two"></div><div class="art-center"><span class="opaya-mark large"><img src="assets/opaya-logo.png" alt=""><i></i></span></div><span class="art-node node-one">${providerIcon('hermes')}</span><span class="art-node node-two">${providerIcon('codex')}</span><span class="art-node node-three">${providerIcon('claude')}</span><span class="art-node node-four">${providerIcon('openclaw')}</span><span class="orbit-signal"></span></div></div><div class="workspace-stats"><div><span class="status-dot connected"></span><strong>${connected}</strong> connected</div><div><span class="machine-icon"></span><strong>${state.hosts.length}</strong> remote machines</div><div><span class="terminal-glyph">&gt;_</span> Native terminal built in</div><div class="stats-private"><span class="lock-symbol">&#9906;</span> Private by default</div></div><div class="section-heading"><div><h2>Your agents <span>${state.agents.length}</span></h2><p>Different runtimes. One familiar workspace.</p>${allTags().length?`<div class="tag-filter">${allTags().map(t=>`<button class="tag-chip ${t===tagFilter?'active':''}" data-action="tag-filter" data-tag="${esc(t)}">${esc(t)}</button>`).join('')}</div>`:''}</div><div class="section-actions"><button class="text-button" data-action="install-catalog">&#8595; Install agents</button><button class="text-button" data-action="add">+ Add connection</button></div></div><div class="agent-grid">${state.agents.filter(a=>!tagFilter||(a.tags||[]).includes(tagFilter)).map((a,i)=>`<article class="agent-card" data-agent-id="${esc(a.id)}" style="--i:${i}"><div class="card-top">${badge(a,true)}<span class="status-pill ${esc(a.status)}">${dot(a)}${status(a)}</span></div><h3>${esc(title(a))}</h3><div class="agent-card-meta">${meta(a)}</div><p>${esc(description(a))}</p>${a.tags?.length?`<div class="card-tags">${tagChips(a)}</div>`:''}<div class="card-connection">${envIcon(a)}${esc(connectionLabel(a))}</div><div class="card-bottom"><button class="text-button" data-action="select" data-id="${esc(a.id)}">Open workspace <span>&#8599;</span></button>${a.group?`<span class="card-group">${esc(a.group)}</span>`:''}</div></article>`).join('')}<button class="add-card" data-action="add" style="--i:${state.agents.length}"><span class="add-card-plus">+</span><strong>${state.agents.length?'Make room for another.':'Meet your first agent.'}</strong><small>Hermes, Codex, Claude, OpenClaw<br>or any ACP / compatible API agent.</small><span class="add-card-link">Add an agent &#8594;</span></button></div>${!state.agents.length?'<div class="getting-started"><span class="step-number">01</span><div><strong>Already have agents installed?</strong><p>Discover checks known install folders, CLI tools and local API ports. Review what it finds before connecting.</p></div><button class="secondary" data-action="discover">Discover this computer</button></div>':''}<div class="workspace-footnote">No account to create. No credentials to route through someone else\'s server. Just your agents, connected.</div>`;
    if(entering||html!==overviewHtml){overviewHtml=html;$('#content').innerHTML=html;}
    if(entering)enter($('#content'));
    renderKey='overview';
  }
  function renderAgent(a) {
    const proj=projectOf(currentConversation());$('#topbar').innerHTML=`<div class="breadcrumb">${proj?`<button type="button" class="crumb-project" data-action="project-focus" data-id="${esc(proj.id)}" title="${esc(proj.path)}"><span class="project-folder" aria-hidden="true"></span>${esc(proj.name)}</button>`:'Agents'} <span>/</span> <strong>${esc(title(a))}</strong></div><div class="topbar-actions"><span class="status-pill ${esc(a.status)}">${dot(a)}${status(a)}</span>${trusted(a)?`<button type="button" class="itrust-pill" data-action="itrust-agent" data-id="${esc(a.id)}" title="iTrust is on: ${esc(title(a))}'s tool requests are approved automatically. Click to change.">iTrust</button>`:''}<button class="subtle" data-action="skills" data-id="${esc(a.id)}" title="Skills, tools and MCP servers"><span aria-hidden="true">&#10022;</span> Skills</button><button class="subtle" data-action="files-agent" data-id="${esc(a.id)}" title="Browse this agent's folders and project"><span class="folder-glyph" aria-hidden="true"></span> Files</button><button class="subtle" data-action="terminal" title="Open terminal (Ctrl + backtick)"><span class="terminal-glyph">&gt;_</span> Terminal</button><button class="icon-button" data-action="edit" data-id="${esc(a.id)}" title="Edit connection settings" aria-label="Connection settings">&#9881;</button></div>`;
    contentKind('conversation');
    $('.topbar-actions').insertAdjacentHTML('beforeend',`${a.protocol!=='terminal'?'<button class="secondary" data-action="models" title="Choose agent model">Models</button>':''}${['hermes','openclaw'].includes(a.provider)?'<button class="secondary" data-action="gateway" title="Gateway status and restart">Gateway</button>':''}`);
    if(renderKey!==JSON.stringify([a.id,title(a),a.description,a.icon,a.provider,location(a),state.activeConversationId])) {
      $('#content').innerHTML=`<div class="conversation-heading"><div class="conversation-identity">${badge(a,true)}<div><h1>${esc(title(a))}</h1><p>${esc(description(a))}</p><div class="identity-meta">${meta(a)}${a.tags?.length?`<span class="heading-tags">${tagChips(a,6)}</span>`:''}</div></div></div><div class="conversation-controls"><select id="conversation-picker" aria-label="Conversation history" title="Switch between this agent's conversations"></select><button class="icon-button" data-action="new-conversation" title="New conversation (Ctrl + N)" aria-label="New conversation">+</button><button class="icon-button" data-action="export" title="Export this conversation as Markdown" aria-label="Export conversation">&#8595;</button><button id="connect-button" class="secondary" data-action="connect"></button></div></div><div id="connection-banner"></div><div id="message-list" class="message-list"></div><div class="compose-area"><form id="message-form"><textarea id="message-input" placeholder="Message ${esc(title(a))}..." aria-label="Message ${esc(title(a))}" rows="2" maxlength="80000"></textarea><div class="compose-bottom"><div><span class="compose-provider">${esc(labels[a.provider])}</span><span id="compose-hint"></span></div><button type="button" id="stop-button" class="stop-button" data-action="stop" title="Stop this turn" hidden><span>&#9632;</span> Stop</button><button id="send-button" type="submit" class="send-button" title="Send message (Enter)" aria-label="Send message">&#8593;</button></div></form><p class="compose-caption">Enter to send <span>&#183;</span> Shift + Enter for a new line <span>&#183;</span> Conversations stay on this computer</p></div>`;
      if(!String(renderKey).startsWith(`["${a.id}"`))enter($('#content'));
      renderKey=JSON.stringify([a.id,title(a),a.description,a.icon,a.provider,location(a),state.activeConversationId]);$('#message-input').value=drafts.get(draftKey())??state.drafts?.[draftKey()]??'';
      $('#message-input').addEventListener('input',event=>{drafts.set(draftKey(),event.target.value);if(api.saveDraft)save(api.saveDraft({agentId:a.id,conversationId:currentConversation()?.id||'',text:event.target.value}));event.target.style.height='auto';event.target.style.height=Math.min(event.target.scrollHeight,190)+'px';updateSlash();});
      $('#message-input').addEventListener('blur',()=>setTimeout(closeSlash,120));
      $('#message-input').addEventListener('keydown',event=>{if(slashKey(event))return;if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();sendMessage();}});
      $('#message-form').addEventListener('submit',event=>{event.preventDefault();sendMessage();});
      $('#conversation-picker').addEventListener('change',event=>action(()=>api.selectConversation({id:event.target.value})));
    }
    const convs=state.conversations.filter(c=>c.agentId===a.id).slice().reverse();
    $('#conversation-picker').innerHTML=convs.length?convs.map(c=>`<option value="${esc(c.id)}" ${c.id===state.activeConversationId?'selected':''}>${esc(c.title)}</option>`).join(''):'<option>New conversation</option>';
    const connect=$('#connect-button');connect.textContent=a.status==='connected'?'Disconnect':a.status==='connecting'?'Connecting...':'Connect';connect.disabled=a.status==='connecting';
    $('#connection-banner').innerHTML=a.error?`<div class="inline-notice error-notice"><span>!</span><div><strong>Connection needs attention</strong><p>${esc(a.error)}</p><button class="text-button" data-action="edit" data-id="${esc(a.id)}">Edit connection</button><button class="text-button" data-action="terminal">Open terminal</button><button class="text-button" data-action="clear-error" data-id="${esc(a.id)}">Clear error</button></div></div>`:a.protocol==='terminal'?'<div class="inline-notice"><span>&gt;_</span><p>This is a terminal-only agent. Use its native CLI in the integrated terminal.</p></div>':a.status==='disconnected'?'<div class="inline-notice"><span class="local-icon"></span><p>This agent is not connected. Your saved conversations are still here.</p><button class="text-button" data-action="connect">Connect now &#8594;</button></div>':'';
    const c=currentConversation(),messages=c?state.histories[c.id]||[]:[],now=performance.now(),conversationKey=`${a.id}/${c?.id||''}`;
    // Existing history appears at once; only messages that arrive while this conversation is open animate in.
    if(messageConversation!==conversationKey){const continuing=messageConversation===`${a.id}/`;messageSeen.clear();messageConversation=conversationKey;if(!continuing)messages.forEach((m,i)=>messageSeen.set(m.id||i,-1e9));}
    const list=$('#message-list'),atBottom=list.scrollHeight-list.scrollTop-list.clientHeight<110;
    list.innerHTML=messages.length?messages.map((m,i)=>`<article class="message ${m.role==='user'?'user-message':'assistant-message'} ${fresh(messageSeen,m.id||i,now,450)?'message-enter':''}"><div class="message-avatar ${m.role==='user'?'you-avatar':esc(a.provider)}">${m.role==='user'?'S':agentIcon(a)}</div><div class="message-body"><div class="message-meta"><strong>${m.role==='user'?'You':esc(title(a))}</strong><time>${esc(new Date(m.createdAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}))}</time>${m.status==='streaming'?'<span class="stream-label"><span class="status-dot working"></span> Working</span>':''}</div>${activityMarkup(m,20,a.id)}<div class="message-text">${format(m.content)}${m.status==='streaming'&&!m.content?'<div class="thinking-dots"><i></i><i></i><i></i></div>':''}</div>${m.error?`<div class="message-error">${esc(m.error)}</div>`:''}</div></article>`).join(''):`<div class="chat-empty">${badge(a,true)}<h2>A direct line to ${esc(title(a))}.</h2><p>${a.transport==='ssh'?'The agent runs on your remote machine. Opaya is the window into it.':'Your agent stays on your computer. Opaya brings the conversation together.'}</p><div class="starter-prompts"><button data-action="starter" data-text="What can you help me with, and which tools do you have?">What can you help me with? <span>&#8599;</span></button><button data-action="starter" data-text="Tell me about your current workspace. Please only inspect it; do not change anything.">Get to know this workspace <span>&#8599;</span></button></div><span class="chat-empty-note">${a.status==='connected'?'Connected and ready for your first message.':'Connect above when you are ready.'}</span></div>`;
    if(atBottom||!messages.length)list.scrollTop=list.scrollHeight;
    $('#send-button').disabled=a.status!=='connected'||a.busy||a.protocol==='terminal'||pendingSends.has(a.id);$('#send-button').hidden=!!a.busy;$('#stop-button').hidden=!a.busy;
    const chatModel=currentConversation()?.model;$('#compose-hint').textContent=a.busy?'Agent is working':a.status==='connected'?(chatModel?`${chatModel} (this chat)`:a.model?`${a.model} (default)`:'Uses the agent\'s own settings'):'Connect to start chatting';
  }
  async function sendMessage() {
    const a=selected(),input=$('#message-input');if(!a||!input||!input.value.trim()||pendingSends.has(a.id))return;
    if(a.status!=='connected'){toast('Connect this agent before sending a message.',true);return;}
    const text=input.value,key=draftKey();pendingSends.add(a.id);$('#send-button').disabled=true;
    try{await api.send({agentId:a.id,conversationId:currentConversation()?.id||'',text});drafts.set(key,'');if(selected()?.id===a.id){input.value='';input.style.height='auto';}}
    catch(error){toast(error.message,true);}finally{pendingSends.delete(a.id);render();}
  }
  function modal(title,subtitle,body,wide=false) {
    returnFocus=document.activeElement;
    $('#modal-root').innerHTML=`<dialog class="modal ${wide?'wide':''}" id="app-dialog"><div class="modal-header"><div><h2>${esc(title)}</h2><p>${esc(subtitle)}</p></div><button class="icon-button" data-action="modal-close" aria-label="Close dialog">&#10005;</button></div><div class="modal-body">${body}</div></dialog>`;
    const d=$('#app-dialog');d.addEventListener('cancel',event=>{if(modalBusy)event.preventDefault();else closeModal();});d.showModal();
  }
  function closeModal(){if(modalBusy)return;$('#app-dialog')?.close();$('#modal-root').innerHTML='';returnFocus?.focus?.();}
  function openAdd(){
    modal('Bring your agents together.','Choose where to look. Nothing connects until you approve it.',`<div class="connect-options"><button data-action="discover"><span class="option-symbol"><span class="radar-icon"></span></span><strong>Discover this computer</strong><p>Find Hermes profiles, Codex, Claude Code and local gateways.</p><small>Recommended to get started &#8594;</small></button><button data-action="hosts"><span class="option-symbol"><span class="machine-icon"></span></span><strong>Connect a remote machine</strong><p>Use your saved SSH config, key files or ssh-agent. No public API ports.</p><small>VPS, server or remote computer &#8594;</small></button><button data-action="install-catalog"><span class="option-symbol install-glyph">&#8595;</span><strong>Install a new agent</strong><p>One click installs Hermes, Claude Code, Codex, OpenClaw and more, here or on a VPS.</p><small>Local or remote &#8594;</small></button><button data-action="manual"><span class="option-symbol">+</span><strong>Add a connection manually</strong><p>Choose an agent preset, API endpoint, ACP command or native terminal.</p><small>For custom installations &#8594;</small></button></div><div class="modal-note"><span class="status-dot connected"></span> No Opaya account. No third-party routing. Your provider login stays where the agent runs.</div>`,true);
  }
  const LIB_ICONS=new Set(['gemini-cli','opencode','goose','ollama','openclaw','codex','claude','hermes-agent']);
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
      const missing=(state.frameworks||[]).filter(f=>f.kind==='agent'&&!f.runtime&&(host?f.remote:f.local)&&!found.has(f.provider==='custom'?f.command:f.provider)&&!found.has(f.id));
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
    modal(a.id?'Connection settings':'Add an agent',a.id?'Rename it in Opaya, add notes, or change where this connection runs.':'A name, a connection, and you are in.',`<form id="agent-form" data-id="${esc(a.id||'')}"><div class="form-grid">${inputField('name','Connection name',a.name,'e.g. Hermes / Research','required maxlength="80"')}${inputField('displayName','Display name in Opaya',a.displayName,'Leave empty to use connection name','maxlength="80"')}${inputField('description','Description',a.description,'e.g. Lead gen on Hostinger','maxlength="500"')}${inputField('icon','Text icon',a.icon,'Optional, e.g. HC or *','maxlength="16"')}${inputField('group','Group',a.group,'Optional, e.g. Clients','maxlength="40"')}${inputField('tags','Tags',(a.tags||[]).join(', '),'Comma separated, e.g. prod, coding','')}<label class="field"><span>Agent / API provider</span><select name="provider">${options(providerEntries,a.provider)}</select></label><label class="field"><span>Connection protocol</span><select name="protocol">${options([['openai','Gateway / OpenAI-compatible API'],['codex','Codex app server'],['claude','Claude Code (streamed CLI)'],['acp','Agent Client Protocol (ACP)'],['terminal','Native terminal only']],a.protocol)}</select></label><label class="field"><span>Where it runs</span><select name="transport">${options([['http','Direct API (local or HTTPS)'],['local','Local executable'],['ssh','Remote machine over SSH']],a.transport)}</select></label></div>${a.id?`<p class="field-help"><button type="button" class="text-button" data-action="icon-picker" data-id="${esc(a.id)}">Choose an icon from the library or upload one &#8594;</button></p>`:''}<p class="field-help">Display name, description and custom icon are only for Opaya. They do not rename the real agent, container, profile or CLI.</p><div data-field="ssh"><label class="field"><span>Remote machine</span><select name="hostId"><option value="">Select a saved SSH host</option>${state.hosts.map(h=>`<option value="${esc(h.id)}" ${a.hostId===h.id?'selected':''}>${esc(h.name)} (${esc(h.alias||h.hostname)})</option>`).join('')}</select></label><p class="field-help">The endpoint below is on the remote host. Opaya creates a loopback-only SSH tunnel. Add machines from the sidebar first.</p></div><div data-field="api">${inputField('endpoint','API base URL',a.endpoint,'http://127.0.0.1:8642/v1')}<p class="field-help">The provider fills its official base URL. Use Models after connecting to refresh the live catalog.</p><div class="form-grid"><label class="field"><span>Model / agent ID</span><select name="model">${modelOptions(a.provider,a.model)}</select></label><label class="field"><span>Gateway API token ${a.hasToken?'<em>stored securely</em>':''}</span><input name="token" type="password" autocomplete="new-password" placeholder="${a.hasToken?'Leave empty to keep the saved token':'Only if the gateway requires one'}"></label></div><label class="check-row"><input type="checkbox" name="remember" ${state.secureStorage?'checked':''}> Remember token with OS encryption <small>${state.secureStorage?'Protected by your OS keychain':'Unavailable here: keep tokens in memory only'}</small></label><label class="check-row" data-field="hermes-import"><input type="checkbox" name="importToken" ${a.hermesHome&&!a.hasToken?'checked':''}> Import API_SERVER_KEY from this Hermes profile <small>A native confirmation is required. Provider keys are never imported.</small></label></div><div data-field="command"><div class="path-field">${inputField('command','Executable',a.command,'hermes, codex, claude or an absolute path')}<button type="button" class="secondary" data-action="pick" data-kind="executable" data-field-name="command" title="Choose a local executable">Browse</button></div>${inputField('args','Arguments (JSON array)',JSON.stringify(a.args||[]),'[]')}<p class="field-help">No shell interpolation. Hermes adds acp; Codex adds app-server. For a custom ACP Docker agent, use docker with ["exec","-i","container","hermes","acp"].</p></div><details class="advanced-fields" ${a.hermesHome?'open':''}><summary>Workspace, profile & advanced</summary><div class="path-field">${inputField('cwd','Working directory',a.cwd,'Absolute path on the selected machine')}<button type="button" class="secondary" data-action="pick" data-kind="directory" data-field-name="cwd">Browse</button></div><div data-field="hermes">${inputField('hermesHome','Hermes profile home',a.hermesHome,'e.g. /home/ubuntu/.hermes/profiles/research')}<p class="field-help">Existing gateway API is recommended for running agents. ACP creates a separate process; never point two writers at the same active profile.</p></div>${inputField('note','Connection note',a.note,'Optional technical context for this connection')}<label class="check-row"><input type="checkbox" name="pinned" ${a.pinned?'checked':''}> Pin to the top of the sidebar</label></details><div class="inline-notice" data-field="claude"><p>Claude keeps its CLI login and native permission defaults. When a headless tool is denied, use Run CLI in Terminal to approve it interactively.</p></div><div class="inline-notice" data-field="acp"><p>Only use trusted agent executables. ACP tool requests are shown in native approval dialogs and are denied by default. This does not sandbox the agent's own process.</p></div><div class="modal-footer"><div>${a.id?`<button type="button" class="danger-text" data-action="remove" data-id="${esc(a.id)}">Delete connection</button>`:'<span>Stored only on this computer.</span>'}</div><div><button type="submit" class="secondary" value="save">Save connection</button><button type="submit" class="primary" value="connect">Save & connect &#8594;</button></div></div></form>`,true);
    const form=$('#agent-form');
    form.elements.token.addEventListener('input',()=>{if(form.elements.token.value)form.elements.importToken.checked=false;});
    function sync(){const p=form.elements.protocol.value,t=form.elements.transport.value,v=form.elements.provider.value;for(const node of form.querySelectorAll('[data-field]')){const f=node.dataset.field;node.hidden=!(f==='ssh'?t==='ssh':f==='api'?p==='openai':f==='command'?p!=='openai':f==='hermes'?v==='hermes':f==='hermes-import'?v==='hermes'&&p==='openai':f==='claude'?p==='claude':f==='acp'?p==='acp':true);}for(const button of form.querySelectorAll('[data-action="pick"]'))button.hidden=t==='ssh';}
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
      try{const saved=await api.saveAgent({agent,token,remember:form.elements.remember.checked,importToken:form.elements.importToken.checked&&values.provider==='hermes'&&values.protocol==='openai'});modalBusy=false;overview=false;opayaView=false;playgroundView=false;closeModal();if(event.submitter?.value==='connect')await action(()=>api.connect({id:saved.id}));else toast('Connection saved.');render();}
      catch(error){modalBusy=false;for(const b of form.querySelectorAll('button[type="submit"]'))b.disabled=false;toast(error.message,true);}
    });
  }
  function openHosts(edit={}){
    modal('Your machines.','OpenSSH handles your saved keys, ssh-agent, jump hosts and host verification.',`<div class="hosts-header"><span>Local and remote machines</span><div><button class="secondary" data-action="import-hosts">Import ~/.ssh/config aliases</button><button class="primary" data-action="new-vps">+ New VPS</button></div></div>
      <h3 class="host-section">Local</h3><div class="host-list"><div class="host-row local"><span class="host-symbol"><span class="machine-icon"></span></span><div><strong class="host-name">This computer</strong><code>${esc(state.machine?.hostname||'')} / ${esc({win32:'Windows',darwin:'macOS',linux:'Linux'}[state.platform]||state.platform||'')} / ${state.agents.filter(a=>a.transport!=='ssh').length} agent${state.agents.filter(a=>a.transport!=='ssh').length===1?'':'s'}</code></div><button class="subtle" data-action="local-terminal">&gt;_ Terminal</button><button class="secondary" data-action="discover">Discover agents</button><button class="secondary" data-action="files-local">Files</button><span class="host-spacer"></span></div></div>
      <h3 class="host-section">Remote <small>${state.hosts.length}</small></h3><div class="host-list">${state.hosts.map(h=>`<div class="host-row"><span class="host-symbol"><span class="machine-icon"></span></span><div><button class="text-button host-name" data-action="edit-host" data-id="${esc(h.id)}">${esc(h.name)}</button><code>${esc(h.alias?`ssh ${h.alias}`:`${h.username?h.username+'@':''}${h.hostname}:${h.port}`)}</code></div><button class="subtle" data-action="host-terminal" data-id="${esc(h.id)}" title="Verify this host and open an interactive SSH shell">&gt;_ Terminal</button><button class="secondary" data-action="host-discover" data-id="${esc(h.id)}">Discover agents</button><button class="secondary" data-action="host-files" data-id="${esc(h.id)}">Files</button><button class="icon-button danger-text" data-action="remove-host" data-id="${esc(h.id)}" title="Remove this saved host" aria-label="Remove ${esc(h.name)}">&#10005;</button></div>`).join('')||'<div class="blank-state"><strong>Your servers belong here.</strong><p>Add a new VPS (Opaya makes the SSH key), import the aliases you already use, or add a host below. Importing aliases does not contact those hosts.</p></div>'}</div><details class="advanced-fields" open><summary>${edit.id?'Edit machine':'Add a machine manually'}</summary><form id="host-form">${inputField('address','Quick connect',edit.alias||'','user@server:22, ssh://user@server:2222, or saved-alias')}<p class="field-help">Paste your SSH address. Existing keys and ssh-agent stay on this computer. Or use the individual fields below.</p><div class="form-grid">${inputField('name','Display name',edit.name,'e.g. Hetzner / Production')}${inputField('alias','Existing SSH config alias',edit.alias,'e.g. production')}</div><div class="field-divider">OR CONNECT DIRECTLY</div><div class="form-grid">${inputField('hostname','Hostname or IP',edit.hostname,'203.0.113.10')}${inputField('username','SSH username',edit.username,'ubuntu')}${inputField('port','SSH port',edit.port||22,'22','type="number" min="1" max="65535"')}<div class="path-field">${inputField('identityFile','SSH identity file (optional)',edit.identityFile,'Use ssh-agent / SSH config')}<button type="button" class="secondary" data-action="pick" data-kind="identityFile" data-field-name="identityFile">Browse</button></div></div><p class="field-help">A config alias takes precedence over hostname, username and port. Private keys are never uploaded or copied into Opaya. Encrypted keys should be unlocked in your OS ssh-agent.</p><div class="modal-footer"><span>Only hosts you select are inspected.</span><button type="submit" class="primary">${edit.id?'Update machine':'Save machine'}</button></div></form></details>`,true);
    $('#host-form').addEventListener('submit',async event=>{event.preventDefault();await action(async()=>{await api.saveHost({...edit,...Object.fromEntries(new FormData(event.target))});state=await api.snapshot();render();openHosts();toast('Machine saved.');});});
  }
  function openHelp(){
    modal('A little help, right here.','Choose the connection that fits how your agent already runs.',`<div class="help-grid"><section><h3>Hermes already running?</h3><p>Connect to its gateway API, not a second ACP process using the same profile. Each independent profile needs its own API port.</p><pre>API_SERVER_ENABLED=true\nAPI_SERVER_PORT=8642\nAPI_SERVER_KEY=your-long-random-secret</pre><p>Add those settings to that profile's .env and start or restart its gateway yourself. Then Discover and choose Import gateway token.</p><button class="text-button" data-action="docs" data-topic="hermes">Hermes API setup &#8599;</button></section><section><h3>Your first SSH connection</h3><p>Machines &rarr; import your SSH aliases &rarr; Terminal. Verify the host fingerprint against a trusted source. Use Local shell to unlock your key in this computer's ssh-agent, then run Discover agents.</p><p>Unknown or changed host keys block automated connections. Opaya never disables host verification or forwards your SSH agent.</p></section><section><h3>Codex & Claude Code</h3><p>Use the same CLI installation and login you already use. Log in through the integrated terminal if necessary.</p><p>Codex uses its app server. Claude streams its CLI and resumes specific sessions. Claude's interactive approvals remain in its native terminal.</p><button class="text-button" data-action="docs" data-topic="codex">Codex integration &#8599;</button><button class="text-button" data-action="docs" data-topic="claude">Claude CLI &#8599;</button></section><section><h3>OpenClaw & other agents</h3><p>Enable OpenClaw's chatCompletions HTTP endpoint and enter its gateway token. Select an agent with openclaw/agent-id.</p><p>Other agents can use an OpenAI-compatible gateway, ACP executable, or native terminal. Container and WSL installations need an explicit command or endpoint in this release.</p><button class="text-button" data-action="docs" data-topic="openclaw">OpenClaw setup &#8599;</button></section></div><div class="privacy-box"><h3>What stays where</h3><p>Provider credentials and agent memory stay with the agent. Saved gateway tokens use OS encryption; when unavailable, choose memory-only tokens. Chat transcripts are local plaintext files in your OS application-data folder. Terminal scrollback is saved locally. A separate session service keeps live terminals and chat streams running when the window closes. Remote shells use tmux, so they can survive losing this computer's SSH connection. Local processes do not survive a computer reboot; saved history does. No analytics or automatic cloud sync.</p><p>Disconnect and Stop close the local connection. A remote job may continue after a network break; verify its status before resending a task. HTTP gateways enforce their own tool permissions.</p></div><div class="shortcuts"><span><kbd>${mod()}K</kbd> Switch agent</span><span><kbd>${mod()}N</kbd> New conversation</span><span><kbd>${mod()}&#96;</kbd> Terminal</span><span><kbd>Shift Enter</kbd> New line</span><span><kbd>Right-click</kbd> Agent, tab &amp; workspace actions</span></div>`,true);
  }
  async function openModels(){
    const a=selected();if(!a)return;const c=currentConversation();
    modal('Model',title(a),'<p>Loading available models...</p>');
    try{
      const result=await api.agentModels({id:a.id});
      if(!$('#app-dialog'))return;
      const models=[...new Set([...(result.models||[]),a.model,c?.model].filter(Boolean))],current=c?.model||a.model||'';
      modal('Model',title(a),`<form id="model-form"><div class="model-scope"><div><small>Agent default</small><strong>${esc(a.model||'Agent\'s own setting')}</strong><span>Used by every chat with ${esc(title(a))}.</span></div><div><small>This chat</small><strong>${esc(c?.model||'Uses the default')}</strong><span>${c?esc(c.title):'Start a conversation to set a chat model.'}</span></div></div><label class="field"><span>Model</span><select name="model"><option value="">Agent's own setting</option>${models.map(m=>`<option value="${esc(m)}" ${m===current?'selected':''}>${esc(m)}</option>`).join('')}</select></label><p class="field-help">This list comes from the connected agent or provider. Refresh after changing credentials or endpoint.</p><div class="modal-footer"><div><button type="button" class="secondary" data-action="models">Refresh</button>${c?.model?'<button type="submit" class="subtle" value="clear-chat">Clear chat override</button>':''}</div><div>${c?'<button class="secondary" type="submit" value="conversation">Use in this chat</button>':''}<button class="primary" type="submit" value="default">Set as agent default</button></div></div></form>`);
      $('#model-form').addEventListener('submit',event=>{event.preventDefault();const form=event.target,scope=event.submitter?.value||'default',model=scope==='clear-chat'?'':form.elements.model.value;
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
  function openSettings(){
    const localCount=state.agents.filter(a=>a.transport!=='ssh').length,remoteCount=state.agents.filter(a=>a.transport==='ssh').length,dockerCount=state.agents.filter(isDocker).length;
    modal('Settings.','Tune the workspace without changing any agent credentials.',`<div class="settings-grid"><section><h3>Theme</h3><div class="theme-options"><button class="theme-option ${theme==='dark'?'selected':''}" data-action="theme" data-theme="dark"><span class="theme-swatch dark-swatch"></span><strong>Dark</strong><small>Original Opaya look</small></button><button class="theme-option ${theme==='light'?'selected':''}" data-action="theme" data-theme="light"><span class="theme-swatch light-swatch"></span><strong>White</strong><small>Bright workspace</small></button></div></section><section><h3>Agent badges</h3><p class="settings-copy">Provider marks identify Hermes, OpenClaw, Codex and Claude. Environment chips show Local, VPS and Docker at a glance.</p><div class="settings-badges">${Object.keys(labels).filter(k=>k!=='custom').map(provider=>badge({provider})).join('')}</div></section><section><h3>Workspace</h3><div class="settings-stats"><span>${localCount} local</span><span>${remoteCount} VPS</span><span>${dockerCount} Docker</span><span>${state.hosts.length} machines</span></div></section><section class="itrust-settings"><h3>iTrust mode</h3><p class="settings-copy">Approve tool requests automatically: commands, file edits and other actions agents ask permission for. Works for Hermes and other ACP agents, Codex and Claude Code. Turn it on only for agents you trust with this computer.</p><label class="switch-row"><input type="checkbox" data-setting="itrustAll" ${state.settings?.itrustAll?'checked':''}><span class="switch" aria-hidden="true"></span><span>All agents</span></label><label class="switch-row"><input type="checkbox" data-setting="itrustOpaya" ${state.settings?.itrustOpaya?'checked':''}><span class="switch" aria-hidden="true"></span><span>Opaya Agent <small>(removals still ask)</small></span></label><p class="field-help">Per agent: right-click an agent &gt; Turn on iTrust.</p></section><section><h3>Updates</h3><p class="settings-copy">Installed: Opaya ${esc(update.current||'')}. ${update.status==='available'?`Version ${esc(update.latest?.version||'')} is ready to download.`:'Opaya checks GitHub for new versions.'}</p><button class="secondary" data-action="updates">${update.status==='available'?'Update now':'Check for updates'}</button></section><section><h3>MCP servers</h3><p class="settings-copy">${(state.mcpServers||[]).length} saved. Tools such as GitHub, a browser or a database that Opaya passes to Hermes (ACP) and Claude Code.</p><button class="secondary" data-action="mcp-manage">Manage MCP servers</button></section><section><h3>Terminal restore</h3><p class="settings-copy">Closed terminals now reopen as read-only saved output. Use New shell when you want a live prompt again.</p></section></div>`,true);
  }
  function switcher(){
    modal('Jump to an agent.','Search by name, provider or machine.',`<input id="switcher-search" class="switcher-search" placeholder="Search agents..." aria-label="Search agents"><div id="switcher-list"></div>`);
    const update=()=>{const q=$('#switcher-search').value.toLowerCase();$('#switcher-list').innerHTML=state.agents.filter(a=>`${title(a)} ${description(a)} ${labels[a.provider]} ${location(a)} ${placeText(a)} ${a.group||''} ${(a.tags||[]).join(' ')}`.toLowerCase().includes(q)).map(a=>`<button class="switcher-row" data-action="switch-select" data-id="${esc(a.id)}">${badge(a)}<span><strong>${esc(title(a))}</strong><small>${esc(description(a))}</small></span>${dot(a)}</button>`).join('')||'<p class="field-help">No matching agents. Add a connection to get started.</p>';};
    $('#switcher-search').addEventListener('input',update);update();$('#switcher-search').focus();
  }
  function activateTerminal(id){
    currentTerminal=id;
    for(const view of terminalViews.values())view.element.hidden=view.id!==id;
    const active=terminalViews.get(id);
    $('[data-action="terminal-detach"]').disabled=!active||active.poppedOut;
    $('[data-action="terminal-detach"]').title='Open terminal in a separate window';
    $('[data-action="terminal-end"]').disabled=!active;
    $('[data-action="terminal-search"]').disabled=!active;
    $('#terminal-tabs').innerHTML=[...terminalViews.values()].map(v=>`<div class="terminal-tab ${v.id===id?'selected':''} ${v.exited?'archived':''}"><button type="button" data-action="terminal-tab" data-id="${esc(v.id)}" title="${esc(v.title)}${v.exited?' (saved output)':''}"><span class="terminal-tab-dot" aria-hidden="true"></span><span class="terminal-tab-title">${esc(v.title)}</span></button><button type="button" class="terminal-tab-close" data-action="terminal-tab-close" data-id="${esc(v.id)}" aria-label="Close ${esc(v.title)}" title="Close">&#10005;</button></div>`).join('')||'<span class="terminal-tabs-empty"><span class="terminal-glyph">&gt;_</span> Terminal</span>';
    if(!active)closeTerminalSearch();
    let placeholder=$('#terminal-placeholder');if(!placeholder){placeholder=document.createElement('div');placeholder.id='terminal-placeholder';placeholder.className='terminal-placeholder';placeholder.textContent='Open a shell or launch the native agent CLI. Switching agents keeps existing terminal sessions alive.';$('#terminal-views').append(placeholder);}placeholder.hidden=!!id;
    const view=terminalViews.get(id);if(view&&!view.poppedOut){requestAnimationFrame(()=>{if(!view.exited)view.core.fitAndReport(view.report);else{try{view.fit.fit();}catch{}}view.term.focus();});}
  }
  async function openTerminal({agentId=selected()?.id,hostId,mode='shell',local=false,terminalId,restoring=false}={}){
    if(!agentId&&!hostId&&!local&&!terminalId){toast('Select an agent, or open a machine from Machines.');return;}
    if(typeof window.Terminal!=='function'||!window.FitAddon||!window.OpayaTerminal){toast('The terminal UI did not load. Reinstall the complete Opaya build rather than moving the executable out of its installation folder.',true);return;}
    if(!restoring){closeModal();$('#terminal-panel').hidden=false;}
    const a=local?null:state.agents.find(a=>a.id===agentId),h=state.hosts.find(h=>h.id===hostId);
    const active=terminalViews.get(currentTerminal),size=active&&!active.exited?{cols:active.term.cols,rows:active.term.rows}:{};
    const result=terminalId?await api.terminalAttach({id:terminalId}):await api.terminalOpen({agentId:hostId||local?undefined:agentId,hostId,mode,local,...size});
    if(!terminalViews.has(result.id)){
      const element=document.createElement('div');element.className='terminal-view';$('#terminal-views').append(element);
      const archived=!!result.exited;
      const core=window.OpayaTerminal.create(element,{archived,windowsBuild:result.windowsBuild||0,light:theme==='light',onSearch:()=>openTerminalSearch()}),{term,fit}=core;
      const report=(cols,rows)=>action(()=>api.terminalResize({id:result.id,cols,rows}));
      const view={id:result.id,agentId:result.agentId||a?.id||'',remote:result.remote,title:result.title||`${a?title(a):h?.name||(local?'This computer':'SSH')} / ${mode}`,term,fit,core,report,element,exited:!!result.exited,lastSeq:result.seq||0};terminalViews.set(result.id,view);
      if(!archived)term.onData(data=>action(()=>api.terminalWrite({id:result.id,data})));
      let timer;const observer=new ResizeObserver(()=>{clearTimeout(timer);timer=setTimeout(()=>{if(element.hidden||view.poppedOut||view.exited||$('#terminal-panel').hidden)return;core.fitAndReport(report);},60);});observer.observe(element);view.observer=observer;
      // Reattaching replays saved output drawn at another size. Nudge the size once so full-screen programs repaint.
      if(result.buffer)term.write(result.buffer,()=>{if(!archived&&(result.mode==='agent'||result.buffer.includes('\x1b[?1049h'))){requestAnimationFrame(()=>{if(!core.fitAndReport(report))return;});setTimeout(()=>{if(view.exited)return;report(term.cols,Math.max(5,term.rows-1));setTimeout(()=>report(term.cols,term.rows),120);},250);}});
      if(archived)term.write('\r\n\x1b[90m[Saved output from a closed session. Open New shell to reconnect.]\x1b[0m\r\n');
      for(const event of terminalPending.get(result.id)||[])terminalEvent(event);terminalPending.delete(result.id);
    }
    activateTerminal(result.id);if(!restoring)saveView();
  }
  function terminalEvent(event){
    if(event.type==='opened'){if(terminalViews.has(event.id)){$('#terminal-panel').hidden=false;activateTerminal(event.id);}else action(()=>openTerminal({terminalId:event.id}));return;}
    if(event.type==='renamed'){const view=terminalViews.get(event.id);if(view){view.title=event.title;activateTerminal(currentTerminal);}return;}
    if(event.type==='warning'){toast(event.error,true);return;}
    const view=terminalViews.get(event.id);
    if(!view){const pending=terminalPending.get(event.id)||[];if(pending.length<100)pending.push(event);terminalPending.set(event.id,pending);return;}
    if(event.seq&&event.seq<=view.lastSeq)return;view.lastSeq=event.seq||view.lastSeq;
    if(event.type==='data')view.term.write(event.data);
    if(event.type==='exit'){view.exited=true;view.term.options.disableStdin=true;view.term.write(`\r\n\x1b[90m[Session ${event.exitCode==='detached'?'detached':'ended: '+event.exitCode}]\x1b[0m\r\n`);activateTerminal(currentTerminal);}
  }
  document.addEventListener('click',event=>{
    const button=event.target.closest('[data-action]');if(!button)return;const {action:name,id,index}=button.dataset;
    if(name==='modal-close'){closeModal();return;}
    if(name==='opaya'){overview=false;opayaView=true;playgroundView=false;closeModal();render();saveView();$('#message-input')?.focus();return;}
    if(name==='opaya-config'){openOpayaConfig();return;}
    if(name==='toggle-group'){toggleGroup(button.dataset.group);return;}
    if(name==='diagnostics'){openDiagnostics(id);return;}
    if(name==='skills'){openSkills(id);return;}
    if(name==='updates'){openUpdates();return;}
    if(name==='dock-move'){moveDock(button.dataset.pane);return;}
    if(name==='new-vps'){openNewVps();return;}
    if(name==='opaya-new'){action(async()=>{await api.opayaNewSession();opayaCount=-1;$('#message-input')?.focus();});return;}
    if(name==='opaya-delete-session'){const o=opaya();if(!confirm('Delete this chat with the Opaya Agent?'))return;action(async()=>{await api.opayaDeleteSession({id:o.sessionId});opayaCount=-1;});return;}
    if(name==='discover-tab'){discover(id||undefined);return;}
    if(name==='discover-install'){action(async()=>{await api.installFramework({id:button.dataset.fw,hostId:button.dataset.host||undefined});closeModal();toast('Installing in Terminal. Discover again when it finishes.');});return;}
    if(name==='clone-install'){action(async()=>{await api.installFramework({id:'hermes',hostId:button.dataset.host||undefined});toast('Installing Hermes in Terminal. Clone again when it finishes.');});return;}
    if(name==='itrust-agent'){const a=state.agents.find(x=>x.id===id);if(a)toggleAgentTrust(a);return;}
    if(name==='opaya-itrust'){action(async()=>{const on=!state.settings?.itrustOpaya;if(on&&!confirm('Turn on iTrust for the Opaya Agent?\n\nIt will install, connect and change things without asking each time. Removing connections or machines still asks.'))return;await api.saveSettings({itrustOpaya:on});await refresh();toast(on?'iTrust is on for the Opaya Agent.':'iTrust is off for the Opaya Agent.');});return;}
    if(name==='browser-open'||name==='browser-toggle'){const p=$('#browser-panel');if(name==='browser-toggle'&&!p.hidden){p.hidden=true;$('#browser-toggle')?.classList.remove('selected');return;}showBrowser();$('#browser-toggle')?.classList.add('selected');$('#browser-url').focus();return;}
    if(name==='projects-toggle'){toggleProjects();return;}
    if(name==='project-focus'){projectsExpanded.add(id);toggleProjects(true);return;}
    if(name==='mcp-manage'){openMcpManager();return;}
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
    if(name==='install-framework'){confirmInstall(id,button.dataset.host||'');return;}
    if(name==='icon-picker'){const a=state.agents.find(a=>a.id===id);if(a)openIconPicker(a);return;}
    if(name==='overview'){overview=true;opayaView=false;playgroundView=false;render();saveView();return;}
    if(name==='add'){openAdd();return;}
    if(name==='manual'){openAgentForm();return;}
    if(name==='edit'){openAgentForm(state.agents.find(a=>a.id===id));return;}
    if(name==='agent-menu'){const a=state.agents.find(a=>a.id===id);if(a){const r=button.getBoundingClientRect();openMenu(r.left,r.bottom+4,agentMenu(a),title(a),button.closest('[data-agent-id]'));}return;}
    if(name==='hosts'){openHosts();return;}
    if(name==='edit-host'){openHosts(state.hosts.find(h=>h.id===id));return;}
    if(name==='settings'){openSettings();return;}
    if(name==='models'){action(openModels);return;}
    if(name==='gateway'){action(openGateway);return;}
    if(name==='theme'){applyTheme(button.dataset.theme);saveView();openSettings();toast(`${theme==='light'?'White':'Dark'} theme enabled.`);return;}
    if(name==='help'){openHelp();return;}
    if(name==='switcher'){switcher();return;}
    if(name==='discovered-add'){const candidate=window.__discovered?.[Number(index)];openAgentForm(candidate?.existingId?state.agents.find(a=>a.id===candidate.existingId):candidate);return;}
    if(name==='starter'){const input=$('#message-input');if(input){input.value=button.dataset.text;drafts.set(draftKey(),input.value);if(api.saveDraft)save(api.saveDraft({agentId:selected().id,conversationId:currentConversation()?.id||'',text:input.value}));input.focus();}return;}
    if(name==='terminal-hide'){$('#terminal-panel').hidden=true;saveView();return;}
    if(name==='terminal-tab'){activateTerminal(id);saveView();return;}
    if(name==='terminal-tab-close'){action(()=>closeTerminalTab(id));return;}
    if(name==='terminal-search'){openTerminalSearch();return;}
    action(async()=>{
      if(name==='select'||name==='switch-select'){overview=false;opayaView=false;playgroundView=false;closeModal();await api.select({id});render();saveView();}
      else if(name==='connect-all')await connectAll();
      else if(name==='stop-agent')await api.stop({id});
      else if(name==='pg-connect')await api.connect({id});
      else if(name==='pg-stop'){for(const agentId of pgAgents)if(state.agents.find(a=>a.id===agentId)?.busy)await api.stop({id:agentId});}
      else if(name==='pg-open'){await api.selectConversation({id});overview=false;opayaView=false;playgroundView=false;render();saveView();}
      else if(name==='opaya-clear')await api.opayaClear();
      else if(name==='opaya-stop')await api.opayaStop();
      else if(name==='opaya-forget-key'){await api.opayaForgetKey();openOpayaConfig();toast('Saved key removed.');}
      else if(name==='install-run'){closeModal();await api.installFramework({id,hostId:button.dataset.host||undefined});toast('Installing in the terminal below. When it finishes, run Discover to add the agent.');}
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
      else if(name==='remove-host'){await api.removeHost({id});state=await api.snapshot();openHosts();render();}
      else if(name==='import-hosts'){button.disabled=true;try{const result=await api.discover({});for(const h of result.hosts||[])await api.saveHost(h);state=await api.snapshot();openHosts();render();toast(`${result.hosts?.length||0} SSH aliases imported. No remote connections were opened.`);}finally{button.disabled=false;}}
      else if(name==='pick'){const value=await api.pick({kind:button.dataset.kind});if(value){const input=$(`[name="${button.dataset.fieldName}"]`,button.closest('form'));if(input)input.value=value;}}
      else if(name==='docs')await api.openDocs({topic:button.dataset.topic});
      else if(name==='terminal'||name==='terminal-shell')await openTerminal();
      else if(name==='terminal-cli')await openTerminal({mode:'agent'});
      else if(name==='local-terminal')await openTerminal({local:true});
      else if(name==='host-terminal')await openTerminal({hostId:id});
      else if(name==='terminal-detach'&&currentTerminal)await popoutTerminal(currentTerminal);
      else if(name==='terminal-end'&&currentTerminal)await closeTerminalTab(currentTerminal);
    });
  });
  document.addEventListener('keydown',event=>{
    if(!(event.ctrlKey||event.metaKey))return;
    if(event.key.toLowerCase()==='k'){event.preventDefault();switcher();}
    if($('#app-dialog'))return;
    if(event.key.toLowerCase()==='n'&&selected()){event.preventDefault();action(()=>api.newConversation({agentId:selected().id}));}
    if(event.key==='`'){event.preventDefault();if(!$('#terminal-panel').hidden)$('#terminal-panel').hidden=true;else action(()=>openTerminal());}
    if(/^[1-9]$/.test(event.key)&&state.agents[Number(event.key)-1]){event.preventDefault();overview=false;opayaView=false;playgroundView=false;action(()=>api.select({id:state.agents[Number(event.key)-1].id}));}
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
    try{await api.terminalClose({id});const ids=[...terminalViews.keys()],index=ids.indexOf(id);view.observer.disconnect();view.term.dispose();view.element.remove();terminalViews.delete(id);activateTerminal(currentTerminal===id?(ids[index+1]||ids[index-1]||''):currentTerminal);saveView();}finally{view.closing=false;}
  }
  $('#terminal-tabs').addEventListener('mousedown',event=>{if(event.button===1)event.preventDefault();});
  $('#terminal-tabs').addEventListener('auxclick',event=>{const tab=event.target.closest('[data-action="terminal-tab"]');if(event.button===1&&tab){event.preventDefault();action(()=>closeTerminalTab(tab.dataset.id));}});
  async function popoutTerminal(id){
    const view=terminalViews.get(id);if(!view)return;view.poppedOut=true;view.term.options.disableStdin=true;
    try{await api.terminalPopout({id});if(currentTerminal===id)$('#terminal-panel').hidden=true;}catch(error){view.poppedOut=false;view.term.options.disableStdin=view.exited;throw error;}
  }
  function renameTerminal(id){
    const view=terminalViews.get(id);if(!view)return;
    modal('Rename terminal','',`<form id="terminal-rename-form"><label class="field"><span>Name</span><input name="title" value="${esc(view.title)}" required maxlength="80" autocomplete="off"></label><div class="modal-footer"><button type="button" class="secondary" data-action="modal-close">Cancel</button><button type="submit" class="primary">Rename</button></div></form>`);
    const form=$('#terminal-rename-form');form.elements.title.select();form.addEventListener('submit',event=>{event.preventDefault();action(async()=>{await api.terminalRename({id,title:form.elements.title.value});closeModal();});});
  }
  function renameAgent(a){
    modal('Rename agent','Only changes how it appears in Opaya. The real agent, profile and CLI keep their names.',`<form id="agent-rename-form"><label class="field"><span>Display name</span><input name="displayName" value="${esc(a.displayName||a.name)}" maxlength="80" autocomplete="off" placeholder="${esc(a.name)}"></label><div class="modal-footer"><button type="button" class="secondary" data-action="modal-close">Cancel</button><button type="submit" class="primary">Rename</button></div></form>`);
    const form=$('#agent-rename-form');form.elements.displayName.select();
    form.addEventListener('submit',event=>{event.preventDefault();const value=form.elements.displayName.value.trim();action(async()=>{await api.updateAgentDisplay({id:a.id,displayName:value===a.name?'':value});closeModal();toast('Agent renamed.');});});
  }
  async function refresh(){state=await api.snapshot();render();}
  async function selectAgent(id){overview=false;opayaView=false;playgroundView=false;closeModal();await api.select({id});render();saveView();}
  function agentMenu(a){
    const id=a.id,index=state.agents.findIndex(x=>x.id===id),connected=a.status==='connected';
    return [
      {icon:'&#8599;',label:'Open',run:()=>selectAgent(id)},
      {icon:'+',label:'New conversation',hint:`${mod()}N`,run:async()=>{await selectAgent(id);await api.newConversation({agentId:id});}},
      a.busy?{icon:'&#9632;',label:'Stop current turn',run:()=>api.stop({id})}:{icon:connected?'&#9675;':'&#9679;',label:connected?'Disconnect':a.status==='connecting'?'Connecting...':'Connect',disabled:a.status==='connecting',run:()=>connected?api.disconnect({id}):api.connect({id})},
      a.error&&{icon:'!',label:'Clear connection error',run:async()=>{await api.clearError({id});await refresh();}},
      '-',
      {icon:'&#9656;',label:'Browse files',run:()=>openFiles({agentId:id,label:`${title(a)} / ${location(a)}`})},
      {icon:'&gt;_',label:'Open shell',run:()=>openTerminal({agentId:id})},
      {icon:'&#10095;',label:'Run native CLI',run:()=>openTerminal({agentId:id,mode:'agent'})},
      '-',
      {icon:a.pinned?'&#9734;':'&#9733;',label:a.pinned?'Unpin':'Pin to top',run:async()=>{await api.updateAgentDisplay({id,pinned:!a.pinned});toast(a.pinned?`${title(a)} unpinned.`:`${title(a)} pinned to the top.`);}},
      {icon:'&#9998;',label:'Rename...',run:()=>renameAgent(a)},
      {icon:'&#9680;',label:'Change icon...',run:()=>openIconPicker(a)},
      {icon:'&#9776;',label:'Group & tags...',run:()=>openGroupTags(a)},
      {icon:'&#10022;',label:'Skills, tools & MCP...',run:()=>openSkills(id)},
      {icon:'&#9635;',label:'Projects...',run:()=>openAgentProjects(a)},
      {icon:'&#10697;',label:'Clone...',disabled:a.provider!=='hermes',hint:a.provider==='hermes'?'':'Hermes',run:()=>openClone(a)},
      a.clone&&{icon:'&#8635;',label:`Redeploy from ${title(state.agents.find(x=>x.id===a.clone.from)||{name:'source'})}`,run:()=>redeploy(a)},
      {icon:'&#9888;',label:a.itrust?'Turn off iTrust':'Turn on iTrust...',run:()=>toggleAgentTrust(a)},
      {icon:'&#9711;',label:a.browser?'Take away Opaya browser':'Give Opaya browser',disabled:!browserCapable(a),hint:browserCapable(a)?'':'local only',run:async()=>{await api.updateAgentDisplay({id,browser:!a.browser});await refresh();toast(a.browser?`${title(a)} no longer has the Opaya browser.`:`${title(a)} can use the Opaya browser from its next conversation.`);}},
      {icon:'&#8801;',label:'Connection log...',run:()=>openDiagnostics(id)},
      {icon:'&#8593;',label:'Move up',disabled:index<=0,run:async()=>{await api.reorderAgents({id,direction:'up'});await refresh();}},
      {icon:'&#8595;',label:'Move down',disabled:index>=state.agents.length-1,run:async()=>{await api.reorderAgents({id,direction:'down'});await refresh();}},
      {icon:'&#9881;',label:'Connection settings...',run:()=>openAgentForm(a)},
      '-',
      {icon:'&#10005;',label:'Remove connection...',danger:true,run:async()=>{if(await api.removeAgent({id})){closeModal();if(state.activeAgentId===id)overview=true;opayaView=false;playgroundView=false;await refresh();toast('Connection removed.');}}}
    ];
  }
  function terminalMenu(id){
    const view=terminalViews.get(id);if(!view)return [];
    return [
      {icon:'&#9998;',label:'Rename...',run:()=>renameTerminal(id)},
      {icon:'&#10697;',label:'Open in separate window',disabled:view.exited,run:()=>{activateTerminal(id);return popoutTerminal(id);}},
      '-',
      {icon:'&#10005;',label:view.exited?'Close saved output':'End session',danger:!view.exited,run:()=>closeTerminalTab(id)}
    ];
  }
  function workspaceMenu(){
    return [
      {icon:'&#9679;',label:'Connect all agents',run:()=>connectAll()},
      {icon:'&#8644;',label:'Open Playground',run:()=>{overview=false;opayaView=false;playgroundView=true;render();saveView();}},
      {icon:'&#10038;',label:'Ask the Opaya Agent',run:()=>{overview=false;opayaView=true;render();saveView();}},
      {icon:'&#9678;',label:'Discover agents',run:()=>discover()},
      {icon:'&#8595;',label:'Install agents...',run:()=>openInstall()},
      {icon:'+',label:'Add connection...',run:()=>openAdd()},
      {icon:'&#9635;',label:'Machines...',run:()=>openHosts()},
      {icon:'&gt;_',label:'Open local terminal',run:()=>openTerminal({local:true})},
      {icon:'&#9656;',label:'Browse files on this computer',run:()=>openFiles({label:'This computer'})},
      '-',
      {icon:'&#9681;',label:theme==='light'?'Switch to dark theme':'Switch to light theme',run:()=>{applyTheme(theme==='light'?'dark':'light');saveView();}},
      {icon:'&#9881;',label:'Settings...',run:()=>openSettings()}
    ];
  }
  let menu=null;
  function closeMenu(restore=false){
    if(!menu)return;const {element,previous,owner}=menu;menu=null;owner?.classList.remove('menu-open');
    element.classList.add('closing');element.addEventListener('animationend',()=>element.remove(),{once:true});setTimeout(()=>element.remove(),200);
    window.removeEventListener('blur',dismiss);window.removeEventListener('resize',dismiss);document.removeEventListener('pointerdown',outside,true);document.removeEventListener('scroll',dismiss,true);
    if(restore)previous?.focus?.();
  }
  const dismiss=()=>closeMenu(),outside=event=>{if(menu&&!menu.element.contains(event.target))closeMenu();};
  function openMenu(x,y,items,label='',owner=null){
    closeMenu();const list=items.filter(Boolean).filter((item,i,all)=>item!=='-'||(i>0&&all[i-1]!=='-'&&i<all.length-1));if(!list.length)return;
    const element=document.createElement('div');element.className='context-menu';element.setAttribute('role','menu');if(label)element.setAttribute('aria-label',label);
    element.innerHTML=(label?`<div class="context-menu-label">${esc(label)}</div>`:'')+list.map((item,i)=>item==='-'?'<div class="context-menu-separator" role="separator"></div>':`<button type="button" role="menuitem" data-menu-index="${i}" class="${item.danger?'danger':''}" ${item.disabled?'disabled':''} style="--i:${i}"><span class="context-menu-icon" aria-hidden="true">${item.icon||''}</span><span class="context-menu-text">${esc(item.label)}</span>${item.hint?`<kbd>${esc(item.hint)}</kbd>`:''}</button>`).join('');
    document.body.append(element);
    const edge=document.body.classList.contains('frameless')?44:8;element.style.maxHeight=`${innerHeight-edge-8}px`;const {width,height}=element.getBoundingClientRect(),left=Math.max(8,Math.min(x,innerWidth-width-8)),flip=y+height>innerHeight-8,top=Math.max(edge,flip?y-height:y);
    element.style.left=left+'px';element.style.top=top+'px';element.style.transformOrigin=`${x-left}px ${flip?'100%':'0'}`;
    menu={element,previous:document.activeElement,owner};owner?.classList.add('menu-open');
    const buttons=()=>[...element.querySelectorAll('button:not(:disabled)')];
    element.addEventListener('click',event=>{const button=event.target.closest('[data-menu-index]');if(!button||button.disabled)return;const item=list[Number(button.dataset.menuIndex)];closeMenu();action(()=>item.run());});
    element.addEventListener('keydown',event=>{
      const all=buttons(),at=all.indexOf(document.activeElement);
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeMenu(true);}
      else if(event.key==='Tab')closeMenu(true);
      else if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?all.length-1:(at+(event.key==='ArrowDown'?1:-1)+all.length)%all.length;all[next]?.focus();}
    });
    element.addEventListener('pointermove',event=>{const button=event.target.closest('button:not(:disabled)');if(button&&document.activeElement!==button)button.focus({preventScroll:true});});
    window.addEventListener('blur',dismiss);window.addEventListener('resize',dismiss);document.addEventListener('pointerdown',outside,true);document.addEventListener('scroll',dismiss,true);
    buttons()[0]?.focus({preventScroll:true});
  }
  document.addEventListener('contextmenu',event=>{
    const target=event.target;
    // Text fields, selections and terminals keep the native edit menu (copy/paste).
    if(target.closest('input,textarea,select,[contenteditable="true"],.terminal-views,.context-menu')||(String(window.getSelection?.()||'').trim()&&!target.closest('.sidebar')))return;
    if($('#app-dialog'))return;
    const point=element=>{if(event.clientX||event.clientY)return [event.clientX,event.clientY];const r=element.getBoundingClientRect();return [r.left+12,r.bottom-4];};
    const section=target.closest('.sidebar-section-label[data-group]');
    if(section){event.preventDefault();const [x,y]=point(section);openMenu(x,y,groupMenu(section.dataset.group,section.querySelector('.group-name')?.textContent||''),section.querySelector('.group-name')?.textContent||'Section');return;}
    const agentElement=target.closest('[data-agent-id]'),tab=target.closest('[data-action="terminal-tab"]');
    if(agentElement){const a=state.agents.find(a=>a.id===agentElement.dataset.agentId);if(!a)return;event.preventDefault();const [x,y]=point(agentElement);openMenu(x,y,agentMenu(a),title(a),agentElement);return;}
    if(tab){event.preventDefault();const [x,y]=point(tab);openMenu(x,y,terminalMenu(tab.dataset.id),terminalViews.get(tab.dataset.id)?.title||'Terminal');return;}
    if(target.closest('.sidebar,.content.overview')){event.preventDefault();const [x,y]=point(target);openMenu(x,y,workspaceMenu(),'Workspace');}
  });
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&menu){event.preventDefault();closeMenu(true);}},true);
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
  function renderOpaya(){
    const o=opaya(),entering=renderKey!=='opaya';
    $('#topbar').innerHTML=`<div class="breadcrumb">Opaya <span>/</span> <strong>Opaya Agent</strong></div><div class="topbar-actions"><button type="button" class="itrust-toggle ${state.settings?.itrustOpaya?'on':''}" data-action="opaya-itrust" title="iTrust: let the Opaya Agent act without asking each time (removals still ask)"><span class="itrust-switch" aria-hidden="true"></span>iTrust</button>${o.configured?`<span class="status-pill ${o.busy?'connecting':'connected'}">${o.busy?'<span class="status-dot working"></span>Working':'<span class="status-dot connected"></span>'+esc(opayaModelLabel(o))}</span>`:''}<button class="subtle" data-action="files-local" title="Browse folders on this computer"><span class="folder-glyph" aria-hidden="true"></span> Files</button><button class="subtle" data-action="install-catalog" title="Install agent frameworks locally or on a machine"><span class="install-glyph">&#8595;</span> Install agents</button><button class="secondary" data-action="opaya-config" title="Choose the model the Opaya Agent uses">Model settings</button></div>`;
    contentKind('conversation opaya-view');
    if(entering){
      $('#content').innerHTML=`<div class="conversation-heading"><div class="conversation-identity"><span class="agent-avatar large opaya-avatar"><span class="opaya-mark"><img src="assets/opaya-logo.png" alt=""><i></i></span></span><div><h1>Opaya Agent</h1><p>Installs, connects, maintains and troubleshoots your agents and machines.</p><div class="identity-meta"><span class="agent-meta"><span class="meta-icon local-mark" aria-hidden="true"></span><span>Lives in Opaya's home folder</span><span class="meta-divider">/</span><span>Changes only with your approval</span></span></div></div></div><div class="conversation-controls"><select id="opaya-sessions" aria-label="Opaya Agent chats" title="Earlier chats with the Opaya Agent"></select><button class="icon-button" data-action="opaya-new" title="New chat" aria-label="New chat">+</button><button class="icon-button" data-action="opaya-delete-session" title="Delete this chat" aria-label="Delete this chat">&#10005;</button></div></div><div id="opaya-banner"></div><div id="opaya-messages" class="message-list"></div><div class="compose-area"><form id="message-form" class="opaya-form"><textarea id="message-input" class="opaya-input" rows="2" maxlength="80000" aria-label="Message the Opaya Agent" placeholder="Ask the Opaya Agent to install, connect or fix an agent..."></textarea><div class="compose-bottom"><div><span class="compose-provider">Opaya Agent</span><span id="compose-hint"></span></div><button type="button" id="opaya-stop" class="stop-button" data-action="opaya-stop" hidden><span>&#9632;</span> Stop</button><button id="opaya-send" type="submit" class="send-button" aria-label="Send message">&#8593;</button></div></form><p class="compose-caption">Every change and command asks for your approval <span>&#183;</span> It never sees your API tokens <span>&#183;</span> It cannot modify the app itself</p></div>`;
      const input=$('#message-input');input.value=opayaDraft;
      input.addEventListener('input',()=>{opayaDraft=input.value;input.style.height='auto';input.style.height=Math.min(input.scrollHeight,190)+'px';});
      input.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();sendOpaya();}});
      $('#message-form').addEventListener('submit',event=>{event.preventDefault();sendOpaya();});
      $('#opaya-sessions').addEventListener('change',event=>action(async()=>{await api.opayaSelectSession({id:event.target.value});opayaCount=-1;}));
      enter($('#content'));opayaCount=-1;
    }
    renderKey='opaya';
    {const sel=$('#opaya-sessions');if(sel){const html=(o.sessions||[]).map(x=>`<option value="${esc(x.id)}" ${x.id===o.sessionId?'selected':''}>${esc(x.title)}</option>`).join('');if(sel.dataset.html!==html){sel.innerHTML=html;sel.dataset.html=html;}sel.disabled=!!o.busy;}}
    $('#opaya-banner').innerHTML=!o.configured?`<div class="opaya-setup"><div class="opaya-setup-art" aria-hidden="true"><span class="opaya-mark large"><img src="assets/opaya-logo.png" alt=""><i></i></span></div><div><h2>Connect the Opaya Agent to a model.</h2><p>Use the Codex CLI already installed on this computer, or choose DeepSeek, OpenAI, Gemini, OpenRouter, xAI, Groq, Mistral, Ollama, LM Studio or any OpenAI-compatible API. API keys stay in the OS keychain.</p><ul class="opaya-abilities"><li><strong>Install</strong> Hermes, Claude Code, Codex, OpenClaw and more, here or on a VPS</li><li><strong>Maintain</strong> connections, machines and SSH keys</li><li><strong>Troubleshoot</strong> agents that do not connect or answer</li></ul><div class="opaya-setup-actions"><button class="primary" data-action="opaya-config">Connect a model &#8594;</button><button class="secondary" data-action="install-catalog">Install agents without the assistant</button></div></div></div>`:o.error&&!o.busy?`<div class="inline-notice error-notice"><span>!</span><div><strong>The last request failed</strong><p>${esc(o.error)}</p><button class="text-button" data-action="opaya-config">Model settings</button></div></div>`:'';
    const list=$('#opaya-messages'),atBottom=list.scrollHeight-list.scrollTop-list.clientHeight<110,now=performance.now();
    if(opayaCount<0)o.messages.forEach(m=>opayaSeen.set(m.id,-1e9));opayaCount=o.messages.length;
    const live=o.live||{content:'',activity:[],status:'streaming'};live.status='streaming';
    const busyRow=o.busy?`<article class="message assistant-message"><div class="message-avatar opaya-avatar"><span class="opaya-mark"><img src="assets/opaya-logo.png" alt=""><i></i></span></div><div class="message-body"><div class="message-meta"><strong>Opaya Agent</strong><span class="stream-label"><span class="status-dot working"></span> ${esc(o.status||'Working')}</span></div>${activityMarkup(live)}<div class="message-text">${format(live.content)}${!live.content?'<div class="thinking-dots"><i></i><i></i><i></i></div>':''}</div></div></article>`:'';
    list.innerHTML=o.messages.length||o.busy?o.messages.map(m=>`<article class="message ${m.role==='user'?'user-message':'assistant-message'} ${fresh(opayaSeen,m.id,now,450)?'message-enter':''}"><div class="message-avatar ${m.role==='user'?'you-avatar':'opaya-avatar'}">${m.role==='user'?'S':'<span class="opaya-mark"><img src="assets/opaya-logo.png" alt=""></span>'}</div><div class="message-body"><div class="message-meta"><strong>${m.role==='user'?'You':'Opaya Agent'}</strong><time>${esc(new Date(m.createdAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}))}</time></div>${activityMarkup(m)}<div class="message-text">${format(m.content)}</div>${m.error?`<div class="message-error">${esc(m.error)}</div>`:''}</div></article>`).join('')+busyRow:o.configured?`<div class="chat-empty"><span class="agent-avatar large opaya-avatar"><span class="opaya-mark"><img src="assets/opaya-logo.png" alt=""><i></i></span></span><h2>How can I help with your agents?</h2><p>I can install frameworks, connect agents, manage machines and SSH keys, and find out why an agent is not working.</p><div class="starter-prompts">${OPAYA_STARTERS.map(([label,text])=>`<button data-action="opaya-starter" data-text="${esc(text)}">${esc(label)} <span>&#8599;</span></button>`).join('')}</div></div>`:'';
    if(atBottom||o.busy)list.scrollTop=list.scrollHeight;
    const send=$('#opaya-send');send.disabled=!o.configured||o.busy;send.hidden=!!o.busy;$('#opaya-stop').hidden=!o.busy;$('#message-input').disabled=!o.configured;
    $('#compose-hint').textContent=o.busy?(o.status||'Working'):o.configured?`${o.presets?.[o.config.preset]?.label||'Model'}${o.config.model?' / '+o.config.model:''}`:'Connect a model to start';
  }
  async function sendOpaya(){
    const input=$('#message-input'),text=input?.value.trim();if(!text||opaya().busy)return;
    await action(async()=>{await api.opayaSend({text});opayaDraft='';input.value='';input.style.height='auto';});
  }
  function openOpayaConfig(){
    const o=opaya(),presets=o.presets||{},c=o.config||{},current=Object.hasOwn(presets,c.preset)?c.preset:'codex';
    const initial=presets[current]||{},models=[...new Set([...(initial.models||[]),c.model].filter(Boolean))];
    modal('Opaya Agent model','Run through the local Codex CLI, or connect an OpenAI-compatible provider. Models are selected from provider results.',`<form id="opaya-config-form"><div class="preset-grid">${Object.entries(presets).map(([id,p])=>`<label class="preset-option"><input type="radio" name="preset" value="${esc(id)}" ${id===current?'checked':''}><span><strong>${esc(p.label)}</strong><small>${esc(p.kind==='codex'?'Local CLI / no API key':p.baseUrl||'Any /v1 endpoint')}</small></span></label>`).join('')}</div><div class="form-grid"><label class="field" data-opaya-http><span>API base URL</span><input name="baseUrl" value="${esc(c.baseUrl||initial.baseUrl||'')}" placeholder="https://.../v1"></label><label class="field"><span>Model</span><select name="model"><option value="">${current==='codex'?'Use Codex CLI default':'Test connection to load models'}</option>${models.map(m=>`<option value="${esc(m)}" ${m===c.model?'selected':''}>${esc(m)}</option>`).join('')}</select></label></div><label class="field" data-opaya-key><span>API key ${o.hasKey?'<em>stored securely</em>':''}</span><input name="apiKey" type="password" autocomplete="new-password" placeholder="${o.hasKey?'Leave empty to keep the saved key':'Not needed for local providers'}"></label><label class="check-row" data-opaya-key><input type="checkbox" name="remember" ${state.secureStorage?'checked':''}> Remember key with OS encryption <small>${state.secureStorage?'Protected by your OS keychain':'Unavailable here: the key stays in memory only'}</small></label><div class="opaya-boundary"><strong>Safety boundary</strong><p>Codex runs locally in a read-only sandbox. The Opaya Agent can use only Opaya's scoped tools for connections, machines, discovery, diagnostics and vendor installs; every change or command still opens an approval dialog. API tokens are never sent to its tools. Chat and notes live in <code>${esc(o.home||'opaya-agent')}</code>.</p></div><p id="opaya-test-result" class="field-help"></p><div class="modal-footer"><div>${o.hasKey?'<button type="button" class="danger-text" data-action="opaya-forget-key">Forget saved key</button>':''}</div><div><button type="button" class="secondary" id="opaya-test">Test &amp; load models</button><button type="submit" class="primary">Save</button></div></div></form>`,true);
    const form=$('#opaya-config-form');
    const fillModels=(items,chosen='')=>{const list=[...new Set((items||[]).filter(Boolean))];form.elements.model.innerHTML=`<option value="">${form.elements.preset.value==='codex'?'Use Codex CLI default':'Select a model'}</option>`+list.map(m=>`<option value="${esc(m)}">${esc(m)}</option>`).join('');if(list.includes(chosen))form.elements.model.value=chosen;else if(list.length)form.elements.model.value=list[0];};
    const syncPreset=(reset=false)=>{const id=form.elements.preset.value,p=presets[id]||{},codex=id==='codex';form.querySelectorAll('[data-opaya-http],[data-opaya-key]').forEach(el=>el.hidden=codex);form.elements.baseUrl.required=!codex;form.elements.model.required=!codex;if(reset){form.elements.baseUrl.value=p.baseUrl||'';fillModels(p.models||[],p.model||'');}};
    form.addEventListener('change',event=>{if(event.target.name==='preset')syncPreset(true);});
    syncPreset(false);
    const values=()=>({preset:form.elements.preset.value,baseUrl:form.elements.baseUrl.value.trim(),model:form.elements.model.value.trim(),apiKey:form.elements.apiKey.value,remember:form.elements.remember.checked});
    $('#opaya-test').onclick=()=>action(async()=>{const out=$('#opaya-test-result');out.textContent='Testing...';try{const selected=form.elements.model.value,r=await api.opayaTest(values());out.textContent=r.message;fillModels(r.models,selected); }catch(e){out.textContent=e.message;}});
    form.addEventListener('submit',event=>{event.preventDefault();action(async()=>{await api.opayaSaveConfig(values());closeModal();opayaView=true;overview=false;render();saveView();toast('Opaya Agent is ready.');});});
  }
  // ---- Install catalog ----------------------------------------------------------------------------------------
  function openInstall(hostId=''){
    const all=state.frameworks||[],host=state.hosts.find(h=>h.id===hostId);
    const card=f=>{const ok=host?f.remote:f.local;const logo=f.icon&&ICONS[f.icon]?iconImg(ICONS[f.icon][1]):f.kind==='dependency'||f.kind==='bundle'?`<span class="dep-glyph">${esc(f.kind==='bundle'?'✦':f.name.slice(0,2))}</span>`:'<span class="mark custom-mark"><i></i></span>';
      return `<article class="install-card ${ok?'':'unavailable'} ${f.kind}"><div class="install-card-top"><span class="agent-avatar large ${esc(f.provider)} ${f.icon?'':'no-logo'}">${logo}</span><div><h3>${esc(f.name)}</h3>${f.requires?`<small>Requires ${esc(f.requires)}</small>`:f.runtime?'<small>Model runtime</small>':f.kind==='dependency'?'<small>Dependency</small>':''}</div></div><p>${esc(f.description)}</p><button class="${ok?(f.kind==='bundle'?'primary':'secondary'):'subtle'}" data-action="install-framework" data-id="${esc(f.id)}" data-host="${esc(hostId)}" ${ok?'':'disabled title="Not available for this system."'}>${ok?'Install':'Not on this system'}</button></article>`;};
    const section=(label,items,note='')=>items.length?`<h3 class="install-section">${label}${note?`<small>${note}</small>`:''}</h3><div class="install-grid">${items.map(card).join('')}</div>`:'';
    modal('Install an agent.',host?`Installs on ${host.name} over SSH, in a visible terminal.`:'Installs on this computer, in a visible terminal. You see the exact command first.',`<div class="install-target"><span>Install on</span><button class="target-chip ${host?'':'selected'}" data-action="install-target" data-id="">This computer</button>${state.hosts.map(h=>`<button class="target-chip ${h.id===hostId?'selected':''}" data-action="install-target" data-id="${esc(h.id)}">${esc(h.name)}</button>`).join('')}<button class="target-chip add" data-action="hosts">+ Machine</button></div>${section('Start here',all.filter(f=>f.kind==='bundle'),'Installs only what is missing')}${section('Agents',all.filter(f=>f.kind==='agent'))}${section('Dependencies',all.filter(f=>f.kind==='dependency'),'Each one skips itself when already installed')}<div class="modal-note"><span class="status-dot connected"></span> After an install, run Discover to add the agent, or ask the Opaya Agent to check prerequisites and do it for you.</div>`,true);
  }
  function confirmInstall(id,hostId){
    const f=(state.frameworks||[]).find(f=>f.id===id),host=state.hosts.find(h=>h.id===hostId);if(!f)return;
    const command=host?f.remoteCommand:f.localCommand;
    modal(`Install ${f.name}?`,host?`On ${host.name} over SSH`:'On this computer',`<p class="field-help">This command runs in a new terminal where you can watch it and answer prompts:</p><pre class="install-command">${esc(command)}</pre>${f.requires?`<p class="field-help">Requires ${esc(f.requires)}.</p>`:''}<p class="field-help">Afterwards: ${esc(f.after)}</p><div class="modal-footer"><a class="text-button" data-action="install-docs" data-id="${esc(f.id)}">From the official instructions</a><div><button class="secondary" data-action="install-catalog" data-host="${esc(hostId||'')}">Back</button><button class="primary" data-action="install-run" data-id="${esc(f.id)}" data-host="${esc(hostId||'')}">Run in terminal</button></div></div>`);
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
      ${f.preview?`<section class="files-preview"><div class="files-preview-head"><button class="text-button" data-action="files-back">&#8592; ${esc(f.list?.path?parts.at(-1)||f.list.path:'Back')}</button><strong title="${esc(f.preview.path)}">${esc(f.preview.path.split(sepOf(f.preview.path)).pop())}</strong><small>${sizeText(f.preview.size)}${f.preview.truncated?' / first 256 KB':''}</small></div><div class="files-actions"><button class="secondary" data-action="files-mention" data-path="${esc(f.preview.path)}">Mention in message</button></div>${f.preview.binary?'<p class="field-help">Binary file. Preview is not available.</p>':`<pre class="files-code">${esc(f.preview.text)}</pre>`}</section>`:`
      ${info&&(info.markers?.length||git)?`<section class="files-project">${git?`<div class="files-git"><span class="git-branch">&#5833; ${esc(git.branch||'git')}</span><span>${git.changes.length?`${git.changes.length}${git.changes.length>=60?'+':''} changed`:'clean'}</span></div>${git.changes.length?`<details><summary>Changes</summary><pre>${esc(git.changes.join('\n'))}</pre></details>`:''}${git.recent?.length?`<details><summary>Recent commits</summary><pre>${esc(git.recent.join('\n'))}</pre></details>`:''}`:''}${info.markers?.length?`<div class="files-markers">${info.markers.filter(m=>m!=='.git').map(m=>`<button class="marker-chip" data-action="files-open" data-name="${esc(m)}">${esc(m)}</button>`).join('')}</div>`:''}</section>`:''}
      <div class="files-toolbar"><span>${f.list?`${entries.length} item${entries.length===1?'':'s'}`:''}</span><label><input type="checkbox" data-action="files-hidden" ${f.hidden?'checked':''}> Hidden files</label><button class="text-button" data-action="files-terminal">&gt;_ Terminal here</button><button class="text-button" data-action="files-mention" data-path="${esc(f.path)}">Mention folder</button></div>
      <ul class="files-list">${entries.map(e=>`<li><button class="file-row ${e.type} ${e.name.startsWith('.')?'hidden-file':''}" data-action="${e.type==='dir'?'files-go':'files-open'}" ${e.type==='dir'?`data-path="${esc(joinPath(f.path,e.name))}"`:`data-name="${esc(e.name)}"`}><span class="file-glyph" aria-hidden="true">${e.type==='dir'?'&#9656;':e.type==='broken'?'!':''}</span><span class="file-name">${esc(e.name)}${e.link?' <em>&#8599;</em>':''}</span><small>${e.type==='dir'?'':sizeText(e.size)}</small></button></li>`).join('')||(f.loading?'':'<li class="files-empty">This folder is empty.</li>')}</ul>`}
      ${f.loading?'<div class="files-loading"><span class="status-dot working"></span> Loading...</div>':''}`;
  }
  function mention(text){
    const input=$('#message-input');if(!input||input.disabled){toast('Open a chat to mention this path.');return;}
    const quoted=/\s/.test(text)?`"${text}"`:text,start=input.selectionStart??input.value.length;
    input.value=input.value.slice(0,start)+(start&&!/\s$/.test(input.value.slice(0,start))?' ':'')+quoted+' '+input.value.slice(input.selectionEnd??start);
    input.dispatchEvent(new Event('input'));input.focus();
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
    else if(act==='files-terminal')action(terminalHere);
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
    $('#topbar').innerHTML=`<div class="breadcrumb">Workspace <span>/</span> <strong>Playground</strong></div><div class="topbar-actions"><label class="check-row inline" title="Continue the previous playground conversations instead of starting fresh"><input type="checkbox" id="pg-keep" ${pgKeep?'checked':''}> Keep context</label><button class="subtle" data-action="pg-swap" title="Swap sides">&#8646; Swap</button><button class="secondary" data-action="connect-all">Connect all</button></div>`;
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
  const mcpSupport=a=>a.protocol==='acp'?'Passed to new sessions. Start a new conversation after changing them.':a.protocol==='claude'?(a.transport==='ssh'?'Not passed over SSH. Add them on that machine with claude mcp add.':'Passed to Claude with every message.'):a.provider==='hermes'?'This Hermes connection uses its gateway API, which takes MCP servers from its own config. Use hermes mcp on that machine.':a.protocol==='codex'?'Codex reads MCP servers from ~/.codex/config.toml.':'This connection type does not accept MCP servers from Opaya.';
  const mcpPassed=a=>a.protocol==='acp'||a.protocol==='claude'&&a.transport!=='ssh';
  const usesMcp=(s,a)=>s.enabled&&(s.agents==='all'||s.agents.includes(a.id));
  async function loadSkills(id,force=false){if(!force&&skillCache.has(id))return skillCache.get(id);const r=await api.agentSkills({id});skillCache.set(id,r);return r;}
  function useCommand(a,name){
    closeModal();
    const put=()=>{const input=$('#message-input');if(!input)return;input.value=`/${name} `;drafts.set(draftKey(),input.value);input.focus();input.setSelectionRange(input.value.length,input.value.length);};
    if(state.activeAgentId!==a.id||overview||opayaView||playgroundView){overview=false;opayaView=false;playgroundView=false;action(async()=>{await api.select({id:a.id});await refresh();put();});}else put();
  }
  const browserCapable=a=>a.transport!=='ssh'&&a.command!=='docker'&&['acp','claude'].includes(a.protocol);
  async function toggleAgentTrust(a){
    if(state.settings?.itrustAll&&a.itrust===false){toast('iTrust is on for all agents in Settings.');return;}
    const on=!a.itrust;
    if(on&&!confirm(`Turn on iTrust for ${title(a)}?\n\nIts tool requests (commands, file edits and other actions) will be approved automatically, without asking you.`))return;
    await action(async()=>{await api.updateAgentDisplay({id:a.id,itrust:on});await refresh();toast(on?`iTrust is on for ${title(a)}.`:`iTrust is off for ${title(a)}.`);});
  }
  document.addEventListener('change',event=>{const key=event.target.dataset?.setting;if(!key)return;const on=event.target.checked;
    if(on&&key==='itrustAll'&&!confirm('Turn on iTrust for all agents?\n\nEvery agent\'s tool requests will be approved automatically.')){event.target.checked=false;return;}
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
        ${a.provider==='hermes'?`<div class="skill-install"><input id="skill-id" placeholder="official/security/1password or https://.../SKILL.md" aria-label="Skill id or link"><button class="primary" id="skill-install">Install</button><button class="secondary" id="skill-browse">Browse Hermes hub</button></div>`:''}
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
    modal('MCP servers','Tools your agents can call. Opaya passes them to ACP agents such as Hermes and to Claude Code.',`${adding||s?form:`<div class="skill-list">${list.map(x=>`<div class="skill-row"><div><strong>${esc(x.name)}</strong><em>${esc(x.type)}${x.enabled?'':' / off'}</em><p>${esc(x.type==='stdio'?`${x.command} ${x.args.join(' ')}`:x.url)}</p><p>${x.agents==='all'?'All agents':`${x.agents.length} agent${x.agents.length===1?'':'s'}`}${x.envNames.length||x.headerNames.length?` / secrets: ${esc([...x.envNames,...x.headerNames].join(', '))}`:''}</p></div><div class="row-actions"><button class="secondary small" data-mcp-edit="${esc(x.id)}">Edit</button><button class="text-button danger-text" data-mcp-remove="${esc(x.id)}">Remove</button></div></div>`).join('')||'<p class="field-help">No MCP servers yet.</p>'}</div>
      <div class="mcp-examples"><p class="field-help">Examples: <code>npx -y @modelcontextprotocol/server-filesystem C:\\Projects</code>, <code>uvx mcp-server-fetch</code>, or an HTTPS server such as <code>https://mcp.context7.com/mcp</code>.</p></div>
      <div class="modal-footer"><div></div><div><button class="primary" id="mcp-add">Add MCP server</button></div></div>`}`,true);
    $('#mcp-add')&&($('#mcp-add').onclick=()=>openMcpManager('new'));
    for(const b of document.querySelectorAll('[data-mcp-edit]'))b.onclick=()=>openMcpManager(b.dataset.mcpEdit);
    for(const b of document.querySelectorAll('[data-mcp-remove]'))b.onclick=()=>action(async()=>{const x=list.find(y=>y.id===b.dataset.mcpRemove);if(!confirm(`Remove MCP server ${x?.name}? Its saved secrets are deleted.`))return;await api.mcpRemove({id:b.dataset.mcpRemove});await refresh();openMcpManager();});
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
  const hostName=id=>id?(state.hosts.find(h=>h.id===id)?.name||'Machine'):'This computer';
  const fitsProject=(a,p)=>a.command!=='docker'&&(p.hostId?a.transport==='ssh'&&a.hostId===p.hostId:a.transport!=='ssh');
  const ago=iso=>{const s=Math.max(0,(Date.now()-new Date(iso).getTime())/1000);return s<60?'now':s<3600?`${Math.floor(s/60)}m`:s<86400?`${Math.floor(s/3600)}h`:s<604800?`${Math.floor(s/86400)}d`:new Date(iso).toLocaleDateString([],{month:'short',day:'numeric'});};
  const saveProjectsView=()=>saveView();
  function toggleProjects(force){projectsOpen=force??!projectsOpen;renderProjects();saveProjectsView();if(projectsOpen)refreshProjectGit();}
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
          <div class="project-agents">${agents.map(a=>`<button type="button" class="project-agent" data-action="project-chat" data-id="${esc(p.id)}" data-agent="${esc(a.id)}" data-pa-agent="${esc(a.id)}" title="New chat with ${esc(title(a))} in ${esc(p.name)}">${badge(a)}<span>${esc(title(a))}</span>${dot(a)}</button>`).join('')}<button type="button" class="project-agent add" data-action="project-add-agent" data-id="${esc(p.id)}" title="Add or remove agents">+ Agent</button></div>
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
  function ensureProjectsToggle(){
    const bar=$('#topbar');if(!bar||$('#projects-toggle',bar))return;
    const button=document.createElement('button');button.id='projects-toggle';button.type='button';button.className='icon-button projects-toggle';button.dataset.action='projects-toggle';
    button.title=`Projects (${mod()}Shift+P)`;button.setAttribute('aria-label','Projects');button.innerHTML='<span class="project-folder" aria-hidden="true"></span>';
    button.classList.toggle('selected',projectsOpen);
    const web=document.createElement('button');web.id='browser-toggle';web.type='button';web.className='icon-button projects-toggle';web.dataset.action='browser-toggle';web.title='Opaya browser';web.setAttribute('aria-label','Opaya browser');web.innerHTML='<span class="globe-glyph" aria-hidden="true"></span>';
    web.classList.toggle('selected',!$('#browser-panel').hidden);bar.append(web,button);
  }
  async function startProjectChat(p,agentId){
    await api.newConversation({agentId,projectId:p.id});overview=false;opayaView=false;playgroundView=false;await refresh();$('#message-input')?.focus();
  }
  async function openProjectChat(id){await api.selectConversation({id});overview=false;opayaView=false;playgroundView=false;await refresh();}
  async function projectTerminal(p){
    const windows=!p.hostId&&state.platform==='win32';
    await openTerminal(p.hostId?{hostId:p.hostId}:{local:true});
    if(currentTerminal)await api.terminalWrite({id:currentTerminal,data:(windows?`Set-Location -LiteralPath '${p.path.replace(/'/g,"''")}'`:`cd -- '${p.path.replace(/'/g,"'\\''")}'`)+'\r'});
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
      ...gitMenu(p),'-',
      {icon:'&#9656;',label:'Browse files',run:()=>openFiles({hostId:p.hostId||undefined,path:p.path,label:`${p.name} / ${hostName(p.hostId)}`})},
      {icon:'&gt;_',label:'Terminal here',run:()=>projectTerminal(p)},
      {icon:'&#9998;',label:'Edit project...',run:()=>openProjectForm(p)},
      {icon:'&#10005;',label:'Remove project',danger:true,run:async()=>{if(!confirm(`Remove project ${p.name}? Its chats stay with their agents; the folder is not touched.`))return;await api.projectRemove({id:p.id});await refresh();toast('Project removed.');}}];
  }
  function agentChecks(p,hostId){
    return state.agents.filter(a=>a.protocol!=='terminal').map(a=>{const ok=fitsProject(a,{hostId});return `<label class="check-row inline project-agent-check ${ok?'':'off'}" title="${ok?'':'Runs on another machine than this folder'}"><input type="checkbox" name="agent" value="${esc(a.id)}" ${p?.agentIds?.includes(a.id)&&ok?'checked':''} ${ok?'':'disabled'}> ${badge(a)} ${esc(title(a))}</label>`;}).join('')||'<p class="field-help">Add an agent first.</p>';
  }
  function openProjectAgents(p){
    modal('Agents in this project',`${p.name} / ${hostName(p.hostId)}`,`<form id="project-agents" class="mcp-form"><div class="project-agent-grid">${agentChecks(p,p.hostId)}</div><p class="field-help">Chats you start from the project open these agents in ${esc(p.path)}.</p><div class="modal-footer"><div></div><div><button type="button" class="secondary" data-action="modal-close">Cancel</button><button class="primary" type="submit">Save</button></div></div></form>`);
    $('#project-agents').onsubmit=event=>{event.preventDefault();action(async()=>{await api.projectSave({...p,agentIds:[...event.target.querySelectorAll('[name="agent"]:checked')].map(c=>c.value)});closeModal();await refresh();});};
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
    const list=(state.projects||[]).filter(p=>fitsProject(a,p));
    if(!list.length){toast('No project on this agent\'s machine yet. Add one in the Projects panel.');toggleProjects(true);return;}
    modal('Projects',`${title(a)} works in`,`<form id="agent-projects" class="mcp-form"><div class="project-agent-grid">${list.map(p=>`<label class="check-row inline"><input type="checkbox" name="project" value="${esc(p.id)}" ${p.agentIds.includes(a.id)?'checked':''}> ${esc(p.name)} <small>${esc(p.path)}</small></label>`).join('')}</div><div class="modal-footer"><div></div><div><button type="button" class="secondary" data-action="modal-close">Cancel</button><button class="primary" type="submit">Save</button></div></div></form>`);
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
    if(agent){const a=state.agents.find(x=>x.id===agent.dataset.paAgent);openMenu(event.clientX,event.clientY,[{icon:'+',label:`New chat in ${p.name}`,run:()=>startProjectChat(p,a.id)},{icon:'&#10005;',label:'Remove from project',danger:true,run:async()=>{await api.projectSave({...p,agentIds:p.agentIds.filter(x=>x!==a.id)});await refresh();}}],title(a));return;}
    openMenu(event.clientX,event.clientY,projectMenu(p),p.name,el);
  });
  document.addEventListener('keydown',event=>{if((event.ctrlKey||event.metaKey)&&event.shiftKey&&event.key.toLowerCase()==='p'&&!$('#app-dialog')){event.preventDefault();toggleProjects();}});
  // ---- A proactive Opaya Agent, gently: one small card at a time, at most every 20 minutes, each tip once ------------
  let nudgeShownAt=0,nudgeId='';
  function nudgeCandidates(){
    const now=Date.now(),out=[],today=new Date().toISOString().slice(0,10),hour=new Date().getHours();
    for(const a of state.agents)if(a.busy&&a.turnStartedAt&&now-a.turnStartedAt>5*60000)out.push({id:`long:${a.id}:${a.turnStartedAt}`,urgent:true,text:`${title(a)} has been working for ${Math.round((now-a.turnStartedAt)/60000)} minutes. I'm keeping an eye on it.`,actions:[['Open',()=>{overview=false;opayaView=false;playgroundView=false;action(async()=>{await api.select({id:a.id});await refresh();});}],['Connection log',()=>openDiagnostics(a.id)]]});
    if(greeted!==today&&state.agents.length){const on=state.agents.filter(a=>a.status==='connected').length;out.push({id:`greet:${today}`,greet:today,text:`${hour<12?'Good morning':hour<18?'Good afternoon':'Good evening'}! ${state.agents.length} agent${state.agents.length===1?'':'s'} here, ${on} connected.${state.hosts.length?` ${state.hosts.length} machine${state.hosts.length===1?'':'s'} ready.`:''}`,actions:on<state.agents.length?[['Connect all',()=>action(()=>connectAll())]]:[]});}
    if(state.hosts.length>=1&&state.agents.some(a=>a.provider==='hermes')&&!state.agents.some(a=>a.clone))out.push({id:'tip:clone',text:`You have ${state.hosts.length} machine${state.hosts.length===1?'':'s'}. Right-click a Hermes agent > Clone to copy it to a VPS, as a profile or a Docker container.`,actions:[]});
    if(!state.hosts.length&&state.agents.length>=2)out.push({id:'tip:vps',text:'Want an agent running around the clock? Add a new VPS: I create the SSH key and check the connection.',actions:[['New VPS',()=>openNewVps()]]});
    const browserable=state.agents.find(a=>browserCapable(a)&&!a.browser);if(browserable)out.push({id:'tip:browser',text:`${title(browserable)} can browse the web with you watching. Right-click it > Give Opaya browser.`,actions:[]});
    if(!(state.projects||[]).length&&state.agents.some(a=>a.cwd))out.push({id:'tip:projects',text:'Keep folders, their agents, chats and git together in Projects. Press Ctrl+Shift+P.',actions:[['Open Projects',()=>toggleProjects(true)]]});
    return out.filter(n=>!tipsSeen.has(n.id));
  }
  function checkNudges(){
    if(!state?.agents||$('#opaya-nudge')||document.querySelector('dialog[open]'))return;
    const list=nudgeCandidates(),n=list.find(x=>x.urgent)||(Date.now()-nudgeShownAt>20*60000?list[0]:null);if(!n)return;
    nudgeShownAt=Date.now();nudgeId=n.id;if(n.greet)greeted=n.greet;
    const card=document.createElement('div');card.id='opaya-nudge';card.className='opaya-nudge';card.setAttribute('role','status');
    card.innerHTML=`<span class="opaya-mark small" aria-hidden="true"><img src="assets/opaya-logo.png" alt=""><i></i></span><div><strong>Opaya</strong><p>${esc(n.text)}</p>${n.actions.length?`<div class="nudge-actions">${n.actions.map((x,i)=>`<button type="button" class="text-button" data-nudge="${i}">${esc(x[0])}</button>`).join('')}</div>`:''}</div><button type="button" class="icon-button" data-nudge="close" aria-label="Dismiss">&#10005;</button>`;
    const close=()=>{tipsSeen.add(n.id);saveView();card.classList.add('leaving');setTimeout(()=>card.remove(),220);};
    card.addEventListener('click',e=>{const b=e.target.closest('[data-nudge]');if(!b)return;if(b.dataset.nudge!=='close')n.actions[Number(b.dataset.nudge)]?.[1]();close();});
    document.body.append(card);if(!n.urgent)setTimeout(()=>{if(card.isConnected)close();},30000);
  }
  setInterval(checkNudges,30000);
  // ---- Clone and redeploy (Hermes) --------------------------------------------------------------------------------
  const CLONE_SCOPES=[['everything','Everything','Config, skills, memory, personality, plugins and cron jobs. No chat history.'],['personality','Skills + personality','Skills, SOUL.md and USER.md (who you are), plus config.'],['skills','Skills','Installed skills and config.'],['memory','Memory','MEMORY.md and USER.md, plus config.']];
  function openClone(a,preset={}){
    if(a.provider!=='hermes'){toast('Cloning is available for Hermes agents.');return;}
    const local=state.hosts.length===0;
    modal(`Clone ${title(a)}`,'Copy this agent to this computer or a VPS, as a Hermes profile or a Docker container.',`<form id="clone-form" class="mcp-form">
      <label>Name of the clone<input name="name" required maxlength="40" value="${esc(preset.name||`${a.name}-clone`.replace(/\s+/g,'-').toLowerCase())}" autocomplete="off"></label>
      <fieldset class="clone-choice"><legend>What to copy</legend>${CLONE_SCOPES.map(([id,label,help])=>`<label class="choice-card"><input type="radio" name="scope" value="${id}" ${(preset.scope||'everything')===id?'checked':''}><span><strong>${label}</strong><small>${help}</small></span></label>`).join('')}</fieldset>
      <label class="check-row inline"><input type="checkbox" name="keys" ${preset.keys===false?'':'checked'}> Include API keys (.env) so the clone works right away</label>
      <fieldset class="clone-choice"><legend>Where</legend><div class="clone-where"><label class="choice-card small"><input type="radio" name="hostId" value="" ${!preset.hostId?'checked':''}><span><strong>This computer</strong><small>Local</small></span></label>${state.hosts.map(h=>`<label class="choice-card small"><input type="radio" name="hostId" value="${esc(h.id)}" ${preset.hostId===h.id?'checked':''}><span><strong>${esc(h.name)}</strong><small>Remote / ${esc(h.alias||h.hostname)}</small></span></label>`).join('')}<button type="button" class="choice-card small add" data-action="new-vps"><span><strong>+ New VPS</strong><small>Create a key and connect</small></span></button></div></fieldset>
      <fieldset class="clone-choice"><legend>Run as</legend><div class="clone-where"><label class="choice-card small"><input type="radio" name="runtime" value="regular" ${preset.runtime!=='docker'?'checked':''}><span><strong>Hermes profile</strong><small>Needs Hermes installed there</small></span></label><label class="choice-card small"><input type="radio" name="runtime" value="docker" ${preset.runtime==='docker'?'checked':''}><span><strong>Docker container</strong><small>${esc('nousresearch/hermes-agent')}, auto-restarts</small></span></label></div></fieldset>
      <p class="field-help">Chat history and OAuth logins are not copied. Later, right-click the clone &gt; Redeploy to copy the same parts again.${local?' Add a VPS to clone to a server.':''}</p>
      <div id="clone-status"></div>
      <div class="modal-footer"><div></div><div><button type="button" class="secondary" data-action="modal-close">Cancel</button><button class="primary" type="submit">Clone</button></div></div></form>`,true);
    const f=$('#clone-form');
    f.onsubmit=event=>{event.preventDefault();const data=Object.fromEntries(new FormData(f));
      const where=data.hostId?state.hosts.find(h=>h.id===data.hostId)?.name:'this computer';
      $('#clone-status').innerHTML=`<div class="clone-progress"><span class="status-dot working"></span> Copying ${esc(title(a))} to ${esc(where)}${data.runtime==='docker'?' and starting its container':''}... This can take a minute.</div>`;
      for(const el of f.elements)el.disabled=true;modalBusy=true;
      api.cloneAgent({id:a.id,name:data.name,hostId:data.hostId||'',runtime:data.runtime,scope:data.scope,keys:!!data.keys}).then(async r=>{modalBusy=false;closeModal();await refresh();toast(`${r.agent.name} is ready on ${where}. Copied: ${r.copied.join(', ')}.`);},error=>{modalBusy=false;for(const el of f.elements)el.disabled=false;
        const install=/not installed/i.test(error.message)&&/Hermes/.test(error.message);
        $('#clone-status').innerHTML=`<div class="inline-notice error-notice"><p>${esc(error.message)}</p>${install?`<button type="button" class="secondary small" data-action="clone-install" data-host="${esc(data.hostId||'')}">Install Hermes there</button>`:''}</div>`;});
    };
  }
  async function redeploy(a){
    const src=state.agents.find(x=>x.id===a.clone?.from);if(!src){toast('The source agent of this clone was removed.',true);return;}
    if(!confirm(`Redeploy ${title(a)} from ${title(src)}?\n\nCopies ${CLONE_SCOPES.find(s=>s[0]===a.clone.scope)?.[1]||a.clone.scope} again over the clone${a.clone.container?' and restarts its container':''}. Chat history on the clone is kept.`))return;
    toast(`Redeploying ${title(a)}...`);
    await action(async()=>{const r=await api.redeployAgent({id:a.id});await refresh();toast(`${title(a)} redeployed. Copied: ${r.copied.join(', ')}.`);});
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
    const chip=$('#status-update');if(chip){const show=['available','downloading','ready'].includes(update.status);chip.hidden=!show;chip.textContent=update.status==='downloading'?`Downloading update ${update.progress||0}%`:update.status==='ready'?'Restart to update':`Update ${update.latest?.version||''} available`;chip.classList.toggle('ready',update.status==='ready');}
    const body=$('#update-body');if(!body)return;
    const u=update,l=u.latest,busy=['checking','downloading'].includes(u.status);
    const line={idle:'Not checked yet.',checking:'Checking GitHub releases...',current:`You have the latest version${u.checkedAt?` (checked ${new Date(u.checkedAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})})`:''}.`,available:`Opaya ${l?.version} is available.`,downloading:`Downloading Opaya ${l?.version}...`,ready:`Opaya ${l?.version} is downloaded and verified.`,error:u.error||'Update failed.',unsupported:u.error||'Updates are not available on this system.'}[u.status]||'';
    body.innerHTML=`<div class="update-versions"><div><small>Installed</small><strong>${esc(u.current||'')}</strong></div>${l?`<div><small>Latest</small><strong>${esc(l.version)}</strong></div>`:''}</div>
      <p class="update-line ${u.status==='error'?'error':''}">${esc(line)}</p>
      ${u.status==='downloading'?`<div class="update-progress" role="progressbar" aria-valuenow="${u.progress||0}" aria-valuemin="0" aria-valuemax="100"><span style="width:${u.progress||0}%"></span></div>`:''}
      ${l&&['available','downloading','ready'].includes(u.status)&&l.notes?`<div class="update-notes">${esc(l.notes)}</div>`:''}
      <p class="field-help">Downloads come from this app's GitHub releases and are checked against the release's SHA-256 list before anything installs.${state.platform==='darwin'?' On macOS, Opaya must be in Applications.':''}</p>
      <div class="modal-footer"><div>${l?.url?`<button type="button" class="text-button" data-update="page">Release page</button>`:''}</div><div>
        <button type="button" class="secondary" data-update="check" ${busy?'disabled':''}>Check again</button>
        ${u.status==='available'?'<button type="button" class="primary" data-update="download">Download update</button>':''}
        ${u.status==='ready'?'<button type="button" class="primary" data-update="install">Restart and update</button>':''}
      </div></div>`;
  }
  function openUpdates(){
    modal('Updates','Get new Opaya versions without reinstalling.',`<div id="update-body"></div>`);renderUpdate();
    $('#update-body').addEventListener('click',event=>{const b=event.target.closest('[data-update]');if(!b)return;const act=b.dataset.update;
      if(act==='check')action(()=>api.updateCheck());
      else if(act==='download')action(()=>api.updateDownload());
      else if(act==='install')action(async()=>{modalBusy=false;await api.updateInstall();});
      else if(act==='page'&&update.latest?.url)action(()=>api.openLink({url:update.latest.url}));});
    if(['idle','error','current'].includes(update.status)&&(!update.checkedAt||Date.now()-update.checkedAt>60000))action(()=>api.updateCheck());
  }
  api.onUpdate?.(value=>{const was=update.status;update=value||{status:'idle'};renderUpdate();if(was!=='available'&&update.status==='available'&&!$('#app-dialog'))toast(`Opaya ${update.latest?.version} is available. Click the notice in the status bar to update.`);});
  api.updateState?.().then(value=>{update=value||update;renderUpdate();}).catch(()=>{});
  // ---- Layout: the terminal and the browser dock at the bottom (side by side) or on the right (stacked) -------------
  const saveLayout=()=>saveView();
  const clampBottom=h=>Math.max(160,Math.min(window.innerHeight-200,h)),clampRight=w=>Math.max(300,Math.min(window.innerWidth-560,w));
  function placePanes(){
    for(const name of ['terminal','browser']){const pane=$(`[data-pane="${name}"].dock-pane`),dock=$(`#dock-${layout[name]==='right'?'right':'bottom'} .dock-panes`);if(pane&&pane.parentElement!==dock)dock.append(pane);}
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
  let browserState={url:''},browserFrame=0,agentBrowsingTimer=0;
  function placeBrowser(){
    cancelAnimationFrame(browserFrame);
    browserFrame=requestAnimationFrame(()=>{
      if(!api.browserPlace)return;const panel=$('#browser-panel'),view=$('#browser-view');
      const covered=!!document.querySelector('dialog[open],.context-menu')||document.body.classList.contains('dock-resizing');
      const shown=!panel.hidden&&!covered&&!!browserState.url;const r=view.getBoundingClientRect();
      $('.browser-empty').hidden=!!browserState.url;
      api.browserPlace({x:r.left,y:r.top,width:r.width,height:r.height,visible:shown}).catch(()=>{});
    });
  }
  function showBrowser(){$('#browser-panel').hidden=false;syncDocks();}
  async function openInBrowser(url){showBrowser();try{browserState=await api.browserOpen({url});}catch(error){toast(error.message,true);}renderBrowser();}
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
    browserState=value||browserState;
    if(value?.request==='show'){showBrowser();if(value.agent){const badge=$('#browser-agent');badge.hidden=false;clearTimeout(agentBrowsingTimer);agentBrowsingTimer=setTimeout(()=>{badge.hidden=true;},8000);}}
    renderBrowser();
  });
  $('#browser-form').addEventListener('submit',event=>{event.preventDefault();const v=$('#browser-url').value.trim();if(v)openInBrowser(v);});
  $('#browser-panel').addEventListener('click',event=>{
    const b=event.target.closest('[data-browser]');if(!b)return;const act=b.dataset.browser;
    if(act==='close'){$('#browser-panel').hidden=true;return;}
    if(act==='external'){if(browserState.url&&!browserState.url.startsWith('data:'))action(()=>api.openLink({url:browserState.url}));return;}
    action(async()=>{browserState=await api.browserNav({action:act});renderBrowser();});
  });
  // ---- Rich message actions: links, copy and preview -----------------------------------------------------------------
  document.addEventListener('click',event=>{
    const el=event.target.closest('[data-action="open-link"],[data-action="md-copy"],[data-action="md-preview"]');if(!el)return;event.preventDefault();event.stopPropagation();
    const act=el.dataset.action;
    if(act==='open-link'){const url=el.dataset.url;if(!url)return;if(url.startsWith('mailto:')||event.ctrlKey||event.metaKey||event.shiftKey)action(()=>api.openLink({url}));else openInBrowser(url);return;}
    const code=el.closest('.code-block')?.querySelector('pre')?.textContent||'';
    if(act==='md-copy'){action(async()=>{await api.clipboardWrite({text:code});el.textContent='Copied';setTimeout(()=>{el.textContent='Copy';},1400);});return;}
    if(act==='md-preview'){showBrowser();action(async()=>{browserState=await api.browserPreview({html:code});renderBrowser();});}
  },true);
  placePanes();
  const approvalQueue=[];let approvalVisible=false;
  function showApproval(){
    if(approvalVisible||!approvalQueue.length)return;approvalVisible=true;const request=approvalQueue.shift(),dialog=document.createElement('dialog');dialog.className='approval-dialog';
    dialog.innerHTML=`<h2>${esc(request.title)}</h2><p>${esc(request.agent?.name||'Agent')}</p><pre>${esc(request.detail)}</pre><footer><button class="secondary" data-choice="deny">Deny</button><button class="secondary" data-choice="always">Allow always</button><button class="primary" data-choice="once">Allow once</button></footer>`;
    const finish=choice=>{api.approvalAnswer({id:request.id,choice}).catch(error=>toast(error.message,true));dialog.close();dialog.remove();approvalVisible=false;showApproval();};
    dialog.addEventListener('click',e=>{const choice=e.target.closest('[data-choice]');if(choice)finish(choice.dataset.choice);});dialog.addEventListener('cancel',e=>{e.preventDefault();finish('deny');});document.body.append(dialog);dialog.showModal();dialog.querySelector('button').focus();
  }
  api.onApproval?.(request=>{approvalQueue.push(request);showApproval();});
  api.onTerminalDocked?.(({id})=>{const view=terminalViews.get(id);if(view){view.poppedOut=false;view.term.options.disableStdin=view.exited;$('#terminal-panel').hidden=false;activateTerminal(id);}});
  api.onState(applyState);api.onTerminal(terminalEvent);api.onServiceError?.(message=>toast(message,true));
  action(async()=>{
    const initial=await api.snapshot();applyState(initial);
    for(const t of initial.terminals||[])await openTerminal({terminalId:t.id,restoring:true});
    $('#terminal-panel').hidden=!initial.view?.terminalVisible;
    if(initial.view?.terminalId&&terminalViews.has(initial.view.terminalId))activateTerminal(initial.view.terminalId);
  });
})();
