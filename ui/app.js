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
  const saveView = () => { if(api.saveView)save(api.saveView({overview,opaya:opayaView,playground:playgroundView,collapsed:[...collapsedGroups],terminalVisible:!$('#terminal-panel').hidden,terminalId:currentTerminal,theme})); };
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
  const dot = a => `<span class="status-dot ${esc(a.busy?'working':a.status||'disconnected')}"></span>`;
  const mod=()=>state.platform==='darwin'?'\u2318':'Ctrl ';
  // Motion bookkeeping: state updates re-render often, so entrance animations are keyed to first appearance, not to every render.
  let collapsedGroups=new Set();
  const navSeen=new Map(),messageSeen=new Map();let navHtml='',navSelected='',navSelectedAt=0,messageConversation=null,overviewHtml='';
  const fresh=(map,key,now,ms)=>{if(!map.has(key))map.set(key,now);return now-map.get(key)<ms;};
  function enter(element){element.classList.remove('view-enter');void element.offsetWidth;element.classList.add('view-enter');clearTimeout(element.enterTimer);element.enterTimer=setTimeout(()=>element.classList.remove('view-enter'),900);}
  function contentKind(kind){const c=$('#content');c.className=`content ${kind}${c.classList.contains('view-enter')?' view-enter':''}`;}
  function applyTheme(value) {
    theme=value==='light'?'light':'dark';
    document.body.dataset.theme=theme;
  }
  function toast(message, error=false) {
    const box=$('#toast');box.textContent=message;box.classList.toggle('error',error);box.hidden=false;
    clearTimeout(toastTimer);toastTimer=setTimeout(()=>box.hidden=true,error?8500:4500);
  }
  async function action(fn) { try { return await fn(); } catch(error) {toast(error.message,true); return undefined;} }
  function format(text) {
    return String(text||'').split(/```/).map((part,i)=>{
      if(i%2){const nl=part.indexOf('\n');const lang=nl>=0?part.slice(0,nl):'';const code=nl>=0?part.slice(nl+1):part;return `<div class="code-block"><div>${esc(lang||'code')}</div><pre><code>${esc(code)}</code></pre></div>`;}
      return esc(part).split(/\n\n+/).filter(Boolean).map(p=>`<p>${p.replace(/\*\*([^*\n]+)\*\*/g,'<strong>$1</strong>').replace(/`([^`\n]+)`/g,'<code>$1</code>').replace(/\n/g,'<br>')}</p>`).join('');
    }).join('');
  }
  // agentId adds a live line (running time, time since the last update) that updateTurnWatch() refreshes every second.
  function activityMarkup(message,limit=20,agentId=''){
    const watch=message?.status==='streaming'&&agentId?`<footer class="turn-watch" data-turn-watch="${esc(agentId)}"></footer>`:'';
    const items=(message?.activity||[]).slice(-limit);if(!items.length)return watch?`<section class="activity-live solo">${watch}</section>`:'';
    if(message.status==='streaming')return `<section class="activity-live"><header><span class="status-dot working"></span><strong>Live activity</strong><small>${items.length} update${items.length===1?'':'s'}</small></header><div>${items.map((t,i)=>`<p class="${i===items.length-1?'current':''}"><span>${i===items.length-1?'&#9656;':'&#10003;'}</span>${esc(t)}</p>`).join('')}</div>${watch}</section>`;
    return `<details class="activity-detail"><summary>${esc(items.length+' step'+(items.length===1?'':'s')+': '+items.at(-1))}</summary><div>${items.map(t=>`<p>${esc(t)}</p>`).join('')}</div></details>`;
  }
  function applyState(next) {
    state=next;document.body.dataset.platform=state.platform;
    if(!initialized){overview=state.view?.overview??!state.activeAgentId;opayaView=!!state.view?.opaya;playgroundView=!!state.view?.playground&&!opayaView;collapsedGroups=new Set(state.view?.collapsed||[]);applyTheme(state.view?.theme||'dark');for(const [key,value]of Object.entries(state.drafts||{}))drafts.set(key,value);initialized=true;if(state.recoveryNotice)toast(state.recoveryNotice,true);renderWindowControls();api.windowControl?.({action:'state'}).then(v=>{windowState=v;renderWindowControls();}).catch(()=>{});$('.search-trigger kbd').textContent=`${mod()}K`;}
    render();
  }
  function render() {
    $('#agent-count').textContent=state.agents.length;
    $('#host-count').textContent=state.hosts.length;
    $('.nav-overview').classList.toggle('selected',overview&&!opayaView&&!playgroundView);$('.nav-playground')?.classList.toggle('selected',playgroundView);$('.nav-opaya').classList.toggle('selected',opayaView);renderOpayaNav();
    // Sections: pinned, each custom group in first-seen order, then ungrouped local and remote agents. Every section collapses.
    const customGroups=[...new Set(state.agents.filter(a=>!a.pinned&&a.group).map(a=>a.group))];
    const groups=[['pinned','PINNED',state.agents.filter(a=>a.pinned)],...customGroups.map(g=>[`group:${g}`,g,state.agents.filter(a=>!a.pinned&&a.group===g)]),['local','ON THIS COMPUTER',state.agents.filter(a=>!a.pinned&&!a.group&&a.transport!=='ssh')],['remote','REMOTE AGENTS',state.agents.filter(a=>!a.pinned&&!a.group&&a.transport==='ssh')]];
    const now=performance.now(),current=overview||opayaView||playgroundView?'':state.activeAgentId||'';let row=0;
    if(current!==navSelected){navSelected=current;navSelectedAt=now;}
    const nav=groups.filter(g=>g[2].length).map(([key,name,all])=>{const closed=collapsedGroups.has(key),agents=closed?all.filter(a=>a.id===current):all,busy=closed&&all.some(a=>a.busy);return `<button class="sidebar-section-label ${closed?'collapsed':''} ${key.startsWith('group:')?'custom-group':''}" data-action="toggle-group" data-group="${esc(key)}" aria-expanded="${!closed}" title="${closed?'Expand':'Collapse'} ${esc(name)} (right-click for group actions)"><span class="group-chevron" aria-hidden="true">&#9662;</span><span class="group-name">${esc(name)}</span>${busy?'<span class="status-dot working"></span>':''}<span class="group-count">${all.length}</span></button><div class="sidebar-group ${closed?'closed':''}">${agents.map(a=>`<div class="agent-nav-row ${fresh(navSeen,a.id,now,650)?'enter':''}" style="--i:${row++}" data-agent-id="${esc(a.id)}" data-section="${esc(key)}" draggable="true"><button class="agent-nav ${!overview&&!opayaView&&!playgroundView&&a.id===state.activeAgentId?'selected':''} ${a.id===navSelected&&now-navSelectedAt<500?'just-selected':''}" data-action="select" data-id="${esc(a.id)}" title="${esc(title(a)+' / '+placeText(a)+' / '+status(a))}">${badge(a)}<span class="agent-nav-text"><strong>${esc(title(a))}</strong><small>${esc(description(a))}</small></span>${dot(a)}</button></div>`).join('')}</div>`;}).join('')||'<div class="sidebar-empty"><span class="connection-dots"><i></i><i></i><i></i></span>Your agents will<br>feel at home here.</div>';
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
    $('#topbar').innerHTML=`<div class="breadcrumb">Agents <span>/</span> <strong>${esc(title(a))}</strong></div><div class="topbar-actions"><span class="status-pill ${esc(a.status)}">${dot(a)}${status(a)}</span><button class="subtle" data-action="files-agent" data-id="${esc(a.id)}" title="Browse this agent's folders and project"><span class="folder-glyph" aria-hidden="true"></span> Files</button><button class="subtle" data-action="terminal" title="Open terminal (Ctrl + backtick)"><span class="terminal-glyph">&gt;_</span> Terminal</button><button class="icon-button" data-action="edit" data-id="${esc(a.id)}" title="Edit connection settings" aria-label="Connection settings">&#9881;</button></div>`;
    contentKind('conversation');
    $('.topbar-actions').insertAdjacentHTML('beforeend',`${a.protocol!=='terminal'?'<button class="secondary" data-action="models" title="Choose agent model">Models</button>':''}${['hermes','openclaw'].includes(a.provider)?'<button class="secondary" data-action="gateway" title="Gateway status and restart">Gateway</button>':''}`);
    if(renderKey!==JSON.stringify([a.id,title(a),a.description,a.icon,a.provider,location(a),state.activeConversationId])) {
      $('#content').innerHTML=`<div class="conversation-heading"><div class="conversation-identity">${badge(a,true)}<div><h1>${esc(title(a))}</h1><p>${esc(description(a))}</p><div class="identity-meta">${meta(a)}${a.tags?.length?`<span class="heading-tags">${tagChips(a,6)}</span>`:''}</div></div></div><div class="conversation-controls"><select id="conversation-picker" aria-label="Conversation history" title="Switch between this agent's conversations"></select><button class="icon-button" data-action="new-conversation" title="New conversation (Ctrl + N)" aria-label="New conversation">+</button><button class="icon-button" data-action="export" title="Export this conversation as Markdown" aria-label="Export conversation">&#8595;</button><button id="connect-button" class="secondary" data-action="connect"></button></div></div><div id="connection-banner"></div><div id="message-list" class="message-list"></div><div class="compose-area"><form id="message-form"><textarea id="message-input" placeholder="Message ${esc(title(a))}..." aria-label="Message ${esc(title(a))}" rows="2" maxlength="80000"></textarea><div class="compose-bottom"><div><span class="compose-provider">${esc(labels[a.provider])}</span><span id="compose-hint"></span></div><button type="button" id="stop-button" class="stop-button" data-action="stop" title="Stop this turn" hidden><span>&#9632;</span> Stop</button><button id="send-button" type="submit" class="send-button" title="Send message (Enter)" aria-label="Send message">&#8593;</button></div></form><p class="compose-caption">Enter to send <span>&#183;</span> Shift + Enter for a new line <span>&#183;</span> Conversations stay on this computer</p></div>`;
      if(!String(renderKey).startsWith(`["${a.id}"`))enter($('#content'));
      renderKey=JSON.stringify([a.id,title(a),a.description,a.icon,a.provider,location(a),state.activeConversationId]);$('#message-input').value=drafts.get(draftKey())??state.drafts?.[draftKey()]??'';
      $('#message-input').addEventListener('input',event=>{drafts.set(draftKey(),event.target.value);if(api.saveDraft)save(api.saveDraft({agentId:a.id,conversationId:currentConversation()?.id||'',text:event.target.value}));event.target.style.height='auto';event.target.style.height=Math.min(event.target.scrollHeight,190)+'px';});
      $('#message-input').addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();sendMessage();}});
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
  async function discover(hostId,extraHome){
    const host=state.hosts.find(h=>h.id===hostId);
    modal('Looking for your agents...',host?`Read-only discovery on ${host.name}.`:'Checking known install folders, CLI tools and loopback API ports.',`<div class="scan-progress"><span class="radar-icon"></span><h3>${host?'Verifying SSH and inspecting the selected account':'Exploring this computer'}</h3><p>No subnet scanning. No services installed or restarted.</p></div>`);
    modalBusy=true;
    try{
      const result=await api.discover({hostId,extraHome});modalBusy=false;
      const items=result.agents||[];window.__discovered=items;
      modal(items.length?`${items.length} agent connection${items.length===1?'':'s'} found.`:'No agents found in the standard locations.',result.scope||'Review each connection before adding it.',`<div class="discovery-results">${items.map((a,i)=>`<div class="discovery-row">${badge(a)}<div><strong>${esc(a.name)}</strong><p>${esc(a.detail)}</p><div class="discovery-meta">${meta(a)}</div><code>${esc(a.hermesHome||a.endpoint||a.command)}</code></div><span class="discovery-state">${esc(a.readiness)}</span><button class="secondary" data-action="discovered-add" data-index="${i}">Review & add</button></div>`).join('')||'<div class="blank-state"><p>Your agent may be in a custom directory, a container or WSL. Add its executable or API endpoint manually. Opaya does not scan every directory or start containers automatically.</p></div>'}</div>${result.warnings?.length?`<details class="discovery-warnings"><summary>Discovery notes (${result.warnings.length})</summary>${result.warnings.map(w=>`<p>${esc(w)}</p>`).join('')}</details>`:''}<div class="modal-footer"><span>${esc(result.machine?.hostname||'')} ${!host&&result.hosts?.length?`/ ${result.hosts.length} saved SSH aliases available`:''}</span><div>${!host?'<button class="subtle" data-action="scan-folder">Scan another Hermes home</button>':''}<button class="secondary" data-action="manual">Add manually</button></div></div>`,true);
    }catch(error){modalBusy=false;modal('Discovery needs attention','No changes were made to your agents.',`<div class="inline-notice error-notice"><p>${esc(error.message)}</p></div><div class="modal-footer"><button class="secondary" data-action="${host?'host-terminal':'manual'}" ${host?`data-id="${esc(host.id)}"`:''}>${host?'Open SSH terminal':'Add manually'}</button><button class="subtle" data-action="help">Connection help</button></div>`);}
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
    modal('Your machines.','OpenSSH handles your saved keys, ssh-agent, jump hosts and host verification.',`<div class="hosts-header"><span>${state.hosts.length} saved machine${state.hosts.length===1?'':'s'}</span><div><button class="subtle" data-action="local-terminal">&gt;_ Local shell</button><button class="secondary" data-action="import-hosts">Import ~/.ssh/config aliases</button></div></div><div class="host-list">${state.hosts.map(h=>`<div class="host-row"><span class="host-symbol"><span class="machine-icon"></span></span><div><button class="text-button host-name" data-action="edit-host" data-id="${esc(h.id)}">${esc(h.name)}</button><code>${esc(h.alias?`ssh ${h.alias}`:`${h.username?h.username+'@':''}${h.hostname}:${h.port}`)}</code></div><button class="subtle" data-action="host-terminal" data-id="${esc(h.id)}" title="Verify this host and open an interactive SSH shell">&gt;_ Terminal</button><button class="secondary" data-action="host-discover" data-id="${esc(h.id)}">Discover agents</button><button class="secondary" data-action="host-files" data-id="${esc(h.id)}">Files</button><button class="icon-button danger-text" data-action="remove-host" data-id="${esc(h.id)}" title="Remove this saved host" aria-label="Remove ${esc(h.name)}">&#10005;</button></div>`).join('')||'<div class="blank-state"><strong>Your servers belong here.</strong><p>Import the aliases you already use in your terminal, or add a host below. Importing aliases does not contact those hosts.</p></div>'}</div><details class="advanced-fields" open><summary>${edit.id?'Edit machine':'Add a machine manually'}</summary><form id="host-form">${inputField('address','Quick connect',edit.alias||'','user@server:22, ssh://user@server:2222, or saved-alias')}<p class="field-help">Paste your SSH address. Existing keys and ssh-agent stay on this computer. Or use the individual fields below.</p><div class="form-grid">${inputField('name','Display name',edit.name,'e.g. Hetzner / Production')}${inputField('alias','Existing SSH config alias',edit.alias,'e.g. production')}</div><div class="field-divider">OR CONNECT DIRECTLY</div><div class="form-grid">${inputField('hostname','Hostname or IP',edit.hostname,'203.0.113.10')}${inputField('username','SSH username',edit.username,'ubuntu')}${inputField('port','SSH port',edit.port||22,'22','type="number" min="1" max="65535"')}<div class="path-field">${inputField('identityFile','SSH identity file (optional)',edit.identityFile,'Use ssh-agent / SSH config')}<button type="button" class="secondary" data-action="pick" data-kind="identityFile" data-field-name="identityFile">Browse</button></div></div><p class="field-help">A config alias takes precedence over hostname, username and port. Private keys are never uploaded or copied into Opaya. Encrypted keys should be unlocked in your OS ssh-agent.</p><div class="modal-footer"><span>Only hosts you select are inspected.</span><button type="submit" class="primary">${edit.id?'Update machine':'Save machine'}</button></div></form></details>`,true);
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
    modal('Settings.','Tune the workspace without changing any agent credentials.',`<div class="settings-grid"><section><h3>Theme</h3><div class="theme-options"><button class="theme-option ${theme==='dark'?'selected':''}" data-action="theme" data-theme="dark"><span class="theme-swatch dark-swatch"></span><strong>Dark</strong><small>Original Opaya look</small></button><button class="theme-option ${theme==='light'?'selected':''}" data-action="theme" data-theme="light"><span class="theme-swatch light-swatch"></span><strong>White</strong><small>Bright workspace</small></button></div></section><section><h3>Agent badges</h3><p class="settings-copy">Provider marks identify Hermes, OpenClaw, Codex and Claude. Environment chips show Local, VPS and Docker at a glance.</p><div class="settings-badges">${Object.keys(labels).filter(k=>k!=='custom').map(provider=>badge({provider})).join('')}</div></section><section><h3>Workspace</h3><div class="settings-stats"><span>${localCount} local</span><span>${remoteCount} VPS</span><span>${dockerCount} Docker</span><span>${state.hosts.length} machines</span></div></section><section><h3>Terminal restore</h3><p class="settings-copy">Closed terminals now reopen as read-only saved output. Use New shell when you want a live prompt again.</p></section></div>`,true);
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
    $('#terminal-title').textContent=active?.title||`Terminal / ${selected()?title(selected()):'no session'}`;
    $('.terminal-hint').textContent=active?.exited?'Saved output only / open a new shell to reconnect':'Persistent session / close window safely';
    $('#terminal-tabs').innerHTML=[...terminalViews.values()].map(v=>`<button class="${v.id===id?'selected':''} ${v.exited?'archived':''}" data-action="terminal-tab" data-id="${esc(v.id)}">${v.exited?'&#9633;':'&#9679;'} ${esc(v.title)}</button>`).join('');
    let placeholder=$('#terminal-placeholder');if(!placeholder){placeholder=document.createElement('div');placeholder.id='terminal-placeholder';placeholder.className='terminal-placeholder';placeholder.textContent='Open a shell or launch the native agent CLI. Switching agents keeps existing terminal sessions alive.';$('#terminal-views').append(placeholder);}placeholder.hidden=!!id;
    const view=terminalViews.get(id);if(view&&!view.poppedOut){requestAnimationFrame(()=>{view.fit.fit();if(!view.exited)action(()=>api.terminalResize({id:view.id,cols:view.term.cols,rows:view.term.rows}));view.term.focus();});}
  }
  async function openTerminal({agentId=selected()?.id,hostId,mode='shell',local=false,terminalId,restoring=false}={}){
    if(!agentId&&!hostId&&!local&&!terminalId){toast('Select an agent, or open a machine from Machines.');return;}
    if(typeof window.Terminal!=='function'||!window.FitAddon){toast('The terminal UI did not load. Reinstall the complete Opaya build rather than moving the executable out of its installation folder.',true);return;}
    if(!restoring){closeModal();$('#terminal-panel').hidden=false;}
    const a=local?null:state.agents.find(a=>a.id===agentId),h=state.hosts.find(h=>h.id===hostId);
    const active=terminalViews.get(currentTerminal),size=active&&!active.exited?{cols:active.term.cols,rows:active.term.rows}:{};
    const result=terminalId?await api.terminalAttach({id:terminalId}):await api.terminalOpen({agentId:hostId||local?undefined:agentId,hostId,mode,local,...size});
    if(!terminalViews.has(result.id)){
      const element=document.createElement('div');element.className='terminal-view';$('#terminal-views').append(element);
      const archived=!!result.exited;
      const term=new window.Terminal({cursorBlink:!archived,disableStdin:archived,fontFamily:'"Cascadia Code", "SFMono-Regular", Consolas, monospace',fontSize:13,lineHeight:1.25,scrollback:4000,allowProposedApi:false,theme:{background:'#111315',foreground:'#d9dde0',cursor:'#a7f3c6',selectionBackground:'#3c4f46'}});
      const fit=new window.FitAddon.FitAddon();term.loadAddon(fit);term.open(element);
      // OSC 52 must not modify the clipboard. No automatic URL/file open addons.
      term.parser.registerOscHandler(52,()=>true);
      const view={id:result.id,agentId:result.agentId||a?.id||'',remote:result.remote,title:result.title||`${a?title(a):h?.name||(local?'This computer':'SSH')} / ${mode}`,term,fit,element,exited:!!result.exited,lastSeq:result.seq||0};terminalViews.set(result.id,view);
      if(!archived)term.onData(data=>action(()=>api.terminalWrite({id:result.id,data})));
      let timer;const observer=new ResizeObserver(()=>{clearTimeout(timer);timer=setTimeout(()=>{if(element.hidden||view.poppedOut||view.exited||$('#terminal-panel').hidden)return;fit.fit();action(()=>api.terminalResize({id:result.id,cols:term.cols,rows:term.rows}));},80);});observer.observe(element);view.observer=observer;
      if(result.buffer)term.write(result.buffer);
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
    const {width,height}=element.getBoundingClientRect(),left=Math.max(8,Math.min(x,innerWidth-width-8)),flip=y+height>innerHeight-8,top=Math.max(8,flip?y-height:y);
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
    const o=opaya(),label=o.busy?'Working...':o.configured?opayaModelLabel(o):'Set up';
    const el=$('#opaya-nav-status');if(el&&el.textContent!==label)el.textContent=label;
    $('.nav-opaya')?.classList.toggle('busy',!!o.busy);
  }
  const OPAYA_STARTERS=[['Why is an agent not connecting?','One of my agents is not working. Check my workspace, find what is wrong and help me fix it.'],['Install Codex on this computer','Install the Codex CLI on this computer and add it to Opaya when it is done.'],['Set up my VPS','Help me add my VPS as a machine, set up an SSH key for it and find the agents running there.'],['What do I have?','Give me a short overview of my agents, their status and my machines.']];
  function renderOpaya(){
    const o=opaya(),entering=renderKey!=='opaya';
    $('#topbar').innerHTML=`<div class="breadcrumb">Opaya <span>/</span> <strong>Opaya Agent</strong></div><div class="topbar-actions">${o.configured?`<span class="status-pill ${o.busy?'connecting':'connected'}">${o.busy?'<span class="status-dot working"></span>Working':'<span class="status-dot connected"></span>'+esc(opayaModelLabel(o))}</span>`:''}<button class="subtle" data-action="files-local" title="Browse folders on this computer"><span class="folder-glyph" aria-hidden="true"></span> Files</button><button class="subtle" data-action="install-catalog" title="Install agent frameworks locally or on a machine"><span class="install-glyph">&#8595;</span> Install agents</button>${o.messages.length?'<button class="subtle" data-action="opaya-clear" title="Start a new chat with the Opaya Agent">New chat</button>':''}<button class="secondary" data-action="opaya-config" title="Choose the model the Opaya Agent uses">Model settings</button></div>`;
    contentKind('conversation opaya-view');
    if(entering){
      $('#content').innerHTML=`<div class="conversation-heading"><div class="conversation-identity"><span class="agent-avatar large opaya-avatar"><span class="opaya-mark"><img src="assets/opaya-logo.png" alt=""><i></i></span></span><div><h1>Opaya Agent</h1><p>Installs, connects, maintains and troubleshoots your agents and machines.</p><div class="identity-meta"><span class="agent-meta"><span class="meta-icon local-mark" aria-hidden="true"></span><span>Lives in Opaya's home folder</span><span class="meta-divider">/</span><span>Changes only with your approval</span></span></div></div></div></div><div id="opaya-banner"></div><div id="opaya-messages" class="message-list"></div><div class="compose-area"><form id="message-form" class="opaya-form"><textarea id="message-input" class="opaya-input" rows="2" maxlength="80000" aria-label="Message the Opaya Agent" placeholder="Ask the Opaya Agent to install, connect or fix an agent..."></textarea><div class="compose-bottom"><div><span class="compose-provider">Opaya Agent</span><span id="compose-hint"></span></div><button type="button" id="opaya-stop" class="stop-button" data-action="opaya-stop" hidden><span>&#9632;</span> Stop</button><button id="opaya-send" type="submit" class="send-button" aria-label="Send message">&#8593;</button></div></form><p class="compose-caption">Every change and command asks for your approval <span>&#183;</span> It never sees your API tokens <span>&#183;</span> It cannot modify the app itself</p></div>`;
      const input=$('#message-input');input.value=opayaDraft;
      input.addEventListener('input',()=>{opayaDraft=input.value;input.style.height='auto';input.style.height=Math.min(input.scrollHeight,190)+'px';});
      input.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();sendOpaya();}});
      $('#message-form').addEventListener('submit',event=>{event.preventDefault();sendOpaya();});
      enter($('#content'));opayaCount=-1;
    }
    renderKey='opaya';
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
        ['Running tools',ad?.runningTools?.length?ad.runningTools.map(t=>`${t.title} (${t.status}, ${duration(t.seconds*1000)})`).join('; '):'none']];
      $('#diag-body').innerHTML=`<dl class="diag-summary">${rows.map(([k,v])=>`<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
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
  const panel=$('#terminal-panel'),grip=document.createElement('div');
  grip.className='terminal-resize-grip';grip.tabIndex=0;grip.role='separator';grip.setAttribute('aria-label','Resize terminal');grip.setAttribute('aria-orientation','horizontal');grip.title='Drag to resize terminal';panel.prepend(grip);
  const setHeight=h=>{panel.style.height=Math.max(180,Math.min(window.innerHeight-140,h))+'px';};
  grip.addEventListener('pointerdown',e=>{const y=e.clientY,height=panel.offsetHeight;grip.setPointerCapture(e.pointerId);const move=event=>setHeight(height+y-event.clientY);grip.addEventListener('pointermove',move);grip.addEventListener('lostpointercapture',()=>grip.removeEventListener('pointermove',move),{once:true});});
  grip.addEventListener('keydown',e=>{if(['ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();setHeight(panel.offsetHeight+(e.key==='ArrowUp'?32:-32));}});
  const expand=document.createElement('button');expand.className='icon-button';expand.innerHTML='&#8597;';expand.title='Expand / restore terminal';expand.setAttribute('aria-label',expand.title);let savedHeight=0;
  expand.onclick=()=>{if(savedHeight){setHeight(savedHeight);savedHeight=0;}else{savedHeight=panel.offsetHeight;setHeight(window.innerHeight-140);}};
  $('.terminal-toolbar>div').prepend(expand);
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
