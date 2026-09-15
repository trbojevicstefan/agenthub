/* AgentHub renderer. No Node access, remote HTML, tokens in storage or generic IPC. */
'use strict';
(() => {
  const api = window.agenthub;
  const $ = (selector, root = document) => root.querySelector(selector);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const labels = {hermes:'Hermes', codex:'Codex', claude:'Claude Code', openclaw:'OpenClaw', custom:'Custom agent'};
  const icons = {hermes:'H',codex:'>_',claude:'C',openclaw:'O',custom:'A'};
  let state = {agents:[],hosts:[],conversations:[],histories:{},secureStorage:false}, overview = true, renderKey = '', initialized = false, theme = 'dark';
  let toastTimer, returnFocus, currentTerminal = '', lastSelected = '', modalBusy = false;
  const pendingWrites = new Set();
  const draftKey = () => currentConversation()?.id || selected()?.id || '';
  const save = promise => { pendingWrites.add(promise); promise.catch(error=>toast(error.message,true)).finally(()=>pendingWrites.delete(promise)); return promise; };
  window.agenthubFlush = () => Promise.allSettled([...pendingWrites]);
  const saveView = () => { if(api.saveView)save(api.saveView({overview,terminalVisible:!$('#terminal-panel').hidden,terminalId:currentTerminal,theme})); };
  const drafts = new Map(), pendingSends = new Set(), terminalViews = new Map(), terminalPending = new Map();
  const selected = () => state.agents.find(a => a.id === state.activeAgentId);
  const currentConversation = () => state.conversations.find(c => c.id === state.activeConversationId && c.agentId === state.activeAgentId);
  const location = a => a.transport === 'ssh' ? (state.hosts.find(h=>h.id===a.hostId)?.name || 'SSH host') : 'This computer';
  const isDocker = a => a?.command === 'docker' || a?.args?.includes?.('docker') || /docker/i.test(`${a?.name||''} ${a?.detail||''}`);
  const environmentLabel = a => isDocker(a) ? 'Docker' : a.transport === 'ssh' ? 'VPS' : 'Local';
  const placeText = a => isDocker(a) ? `${a.transport === 'ssh' ? 'VPS' : 'Local'} Docker` : environmentLabel(a);
  const badge = (a, large=false) => `<span class="agent-avatar ${esc(a.provider)} ${large?'large':''}" aria-label="${esc(labels[a.provider]||'Agent')} icon"><span class="provider-icon">${esc(icons[a.provider]||'A')}</span></span>`;
  const envIcon = a => `<span class="meta-icon ${isDocker(a)?'docker-mark':a.transport==='ssh'?'vps-mark':'local-mark'}" aria-hidden="true"></span>`;
  const meta = a => `<span class="agent-meta">${envIcon(a)}<span>${esc(placeText(a))}</span><span class="meta-divider">/</span><span>${esc(location(a))}</span></span>`;
  const connectionLabel = a => isDocker(a) ? 'Containerized agent runtime' : a.transport === 'ssh' ? 'SSH encrypted connection' : a.protocol === 'openai' ? 'Gateway API' : 'Native CLI connection';
  const status = a => a.busy?'Working':({connected:'Connected',connecting:'Connecting',disconnected:'Disconnected',error:'Needs attention'}[a.status]||'Not connected');
  const dot = a => `<span class="status-dot ${esc(a.busy?'working':a.status||'disconnected')}"></span>`;
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
  function applyState(next) {
    state=next;document.body.dataset.platform=state.platform;
    if(!initialized){overview=state.view?.overview??!state.activeAgentId;applyTheme(state.view?.theme||'dark');for(const [key,value]of Object.entries(state.drafts||{}))drafts.set(key,value);initialized=true;if(state.recoveryNotice)toast(state.recoveryNotice,true);}
    render();
  }
  function render() {
    $('#agent-count').textContent=state.agents.length;
    $('#host-count').textContent=state.hosts.length;
    $('.nav-overview').classList.toggle('selected',overview);
    const groups=[['PINNED',state.agents.filter(a=>a.pinned)],['ON THIS COMPUTER',state.agents.filter(a=>!a.pinned&&a.transport!=='ssh')],['REMOTE AGENTS',state.agents.filter(a=>!a.pinned&&a.transport==='ssh')]];
    $('#agent-list').innerHTML=groups.filter(g=>g[1].length).map(([name,agents])=>`<div class="sidebar-section-label">${name}<span>${agents.length}</span></div>${agents.map(a=>`<button class="agent-nav ${!overview&&a.id===state.activeAgentId?'selected':''}" data-action="select" data-id="${esc(a.id)}" title="${esc(a.name+' / '+placeText(a)+' / '+status(a))}">${badge(a)}<span class="agent-nav-text"><strong>${esc(a.name)}</strong><small>${meta(a)}</small></span>${dot(a)}</button>`).join('')}`).join('')||'<div class="sidebar-empty"><span class="connection-dots">&#183; &#183; &#183;</span>Your agents will<br>feel at home here.</div>';
    const a=selected();
    if(overview||!a)renderOverview();else renderAgent(a);
    $('#status-left').textContent=a&&!overview?`${labels[a.provider]} / ${a.protocol==='openai'?'Gateway API':a.protocol.toUpperCase()} / ${location(a)}`:'Your agents, without the tab switching.';
    $('#status-right').textContent=state.agents.some(a=>a.busy)?`${state.agents.filter(a=>a.busy).length} agent working`:(state.service?.persistent?'Sessions protected / safe to close window':'Local workspace / no cloud account');
    if(lastSelected!==state.activeAgentId){lastSelected=state.activeAgentId;if(!$('#terminal-panel').hidden){const match=[...terminalViews.values()].find(v=>v.agentId===state.activeAgentId&&!v.exited);activateTerminal(match?.id||'');}}
  }
  function renderOverview() {
    $('#topbar').innerHTML='<div class="breadcrumb">Workspace <span>/</span> Overview</div><div class="topbar-actions"><button class="subtle" data-action="hosts">Manage machines</button><button class="secondary" data-action="discover"><span class="radar-icon"></span> Discover agents</button></div>';
    const connected=state.agents.filter(a=>a.status==='connected').length;
    $('#content').className='content overview';
    $('#content').innerHTML=`<div class="workspace-heading"><div><div class="eyebrow"><span class="tiny-square"></span> YOUR AGENT WORKSPACE</div><h1>One place.<br>All your agents.</h1><p>From the machine in front of you to the server across the world.<br>Connect, switch, and keep the conversation going.</p></div><div class="workspace-art" aria-hidden="true"><div class="orbit orbit-one"></div><div class="orbit orbit-two"></div><div class="art-center">a<span>h</span></div><span class="art-node node-one">H</span><span class="art-node node-two">&gt;_</span><span class="art-node node-three">C</span><span class="art-node node-four">O</span><span class="orbit-signal"></span></div></div><div class="workspace-stats"><div><span class="status-dot connected"></span><strong>${connected}</strong> connected</div><div><span class="machine-icon"></span><strong>${state.hosts.length}</strong> remote machines</div><div><span class="terminal-glyph">&gt;_</span> Native terminal built in</div><div class="stats-private"><span class="lock-symbol">&#9906;</span> Private by default</div></div><div class="section-heading"><div><h2>Your agents <span>${state.agents.length}</span></h2><p>Different runtimes. One familiar workspace.</p></div><button class="text-button" data-action="add">+ Add connection</button></div><div class="agent-grid">${state.agents.map(a=>`<article class="agent-card"><div class="card-top">${badge(a,true)}<span class="status-pill ${esc(a.status)}">${dot(a)}${status(a)}</span></div><h3>${esc(a.name)}</h3><div class="agent-card-meta">${meta(a)}</div><p>${esc(labels[a.provider])}</p><div class="card-connection">${envIcon(a)}${esc(connectionLabel(a))}</div><div class="card-bottom"><button class="text-button" data-action="select" data-id="${esc(a.id)}">Open workspace <span>&#8599;</span></button><button class="icon-button" data-action="edit" data-id="${esc(a.id)}" aria-label="Edit ${esc(a.name)}" title="Edit connection">&#8943;</button></div></article>`).join('')}<button class="add-card" data-action="add"><span class="add-card-plus">+</span><strong>${state.agents.length?'Make room for another.':'Meet your first agent.'}</strong><small>Hermes, Codex, Claude, OpenClaw<br>or any ACP / compatible API agent.</small><span class="add-card-link">Add an agent &#8594;</span></button></div>${!state.agents.length?'<div class="getting-started"><span class="step-number">01</span><div><strong>Already have agents installed?</strong><p>Discover checks known install folders, CLI tools and local API ports. Review what it finds before connecting.</p></div><button class="secondary" data-action="discover">Discover this computer</button></div>':''}<div class="workspace-footnote">No account to create. No credentials to route through someone else\'s server. Just your agents, connected.</div>`;
    renderKey='overview';
  }
  function renderAgent(a) {
    $('#topbar').innerHTML=`<div class="breadcrumb">Agents <span>/</span> <strong>${esc(a.name)}</strong></div><div class="topbar-actions"><span class="status-pill ${esc(a.status)}">${dot(a)}${status(a)}</span><button class="subtle" data-action="terminal" title="Open terminal (Ctrl + backtick)"><span class="terminal-glyph">&gt;_</span> Terminal</button><button class="icon-button" data-action="edit" data-id="${esc(a.id)}" title="Edit connection settings" aria-label="Connection settings">&#9881;</button></div>`;
    $('#content').className='content conversation';
    $('.topbar-actions').insertAdjacentHTML('beforeend',`${a.protocol!=='terminal'?'<button class="secondary" data-action="models" title="Choose agent model">Models</button>':''}${['hermes','openclaw'].includes(a.provider)?'<button class="secondary" data-action="gateway" title="Gateway status and restart">Gateway</button>':''}`);
    if(renderKey!==JSON.stringify([a.id,a.name,a.provider,location(a),state.activeConversationId])) {
      $('#content').innerHTML=`<div class="conversation-heading"><div class="conversation-identity">${badge(a,true)}<div><h1>${esc(a.name)}</h1><p>${esc(labels[a.provider])}</p><div class="identity-meta">${meta(a)}</div></div></div><div class="conversation-controls"><select id="conversation-picker" aria-label="Conversation history" title="Switch between this agent's conversations"></select><button class="icon-button" data-action="new-conversation" title="New conversation (Ctrl + N)" aria-label="New conversation">+</button><button class="icon-button" data-action="export" title="Export this conversation as Markdown" aria-label="Export conversation">&#8595;</button><button id="connect-button" class="secondary" data-action="connect"></button></div></div><div id="connection-banner"></div><div id="message-list" class="message-list"></div><div class="compose-area"><form id="message-form"><textarea id="message-input" placeholder="Message ${esc(a.name)}..." aria-label="Message ${esc(a.name)}" rows="2" maxlength="80000"></textarea><div class="compose-bottom"><div><span class="compose-provider">${esc(labels[a.provider])}</span><span id="compose-hint"></span></div><button type="button" id="stop-button" class="stop-button" data-action="stop" title="Stop this turn" hidden><span>&#9632;</span> Stop</button><button id="send-button" type="submit" class="send-button" title="Send message (Enter)" aria-label="Send message">&#8593;</button></div></form><p class="compose-caption">Enter to send <span>&#183;</span> Shift + Enter for a new line <span>&#183;</span> Conversations stay on this computer</p></div>`;
      renderKey=JSON.stringify([a.id,a.name,a.provider,location(a),state.activeConversationId]);$('#message-input').value=drafts.get(draftKey())??state.drafts?.[draftKey()]??'';
      $('#message-input').addEventListener('input',event=>{drafts.set(draftKey(),event.target.value);if(api.saveDraft)save(api.saveDraft({agentId:a.id,conversationId:currentConversation()?.id||'',text:event.target.value}));event.target.style.height='auto';event.target.style.height=Math.min(event.target.scrollHeight,190)+'px';});
      $('#message-input').addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();sendMessage();}});
      $('#message-form').addEventListener('submit',event=>{event.preventDefault();sendMessage();});
      $('#conversation-picker').addEventListener('change',event=>action(()=>api.selectConversation({id:event.target.value})));
    }
    const convs=state.conversations.filter(c=>c.agentId===a.id).slice().reverse();
    $('#conversation-picker').innerHTML=convs.length?convs.map(c=>`<option value="${esc(c.id)}" ${c.id===state.activeConversationId?'selected':''}>${esc(c.title)}</option>`).join(''):'<option>New conversation</option>';
    const connect=$('#connect-button');connect.textContent=a.status==='connected'?'Disconnect':a.status==='connecting'?'Connecting...':'Connect';connect.disabled=a.status==='connecting';
    $('#connection-banner').innerHTML=a.error?`<div class="inline-notice error-notice"><span>!</span><div><strong>Connection needs attention</strong><p>${esc(a.error)}</p><button class="text-button" data-action="edit" data-id="${esc(a.id)}">Edit connection</button><button class="text-button" data-action="terminal">Open terminal</button><button class="text-button" data-action="clear-error" data-id="${esc(a.id)}">Clear error</button></div></div>`:a.protocol==='terminal'?'<div class="inline-notice"><span>&gt;_</span><p>This is a terminal-only agent. Use its native CLI in the integrated terminal.</p></div>':a.status==='disconnected'?'<div class="inline-notice"><span class="local-icon"></span><p>This agent is not connected. Your saved conversations are still here.</p><button class="text-button" data-action="connect">Connect now &#8594;</button></div>':'';
    const c=currentConversation(),messages=c?state.histories[c.id]||[]:[];
    const list=$('#message-list'),atBottom=list.scrollHeight-list.scrollTop-list.clientHeight<110;
    list.innerHTML=messages.length?messages.map(m=>`<article class="message ${m.role==='user'?'user-message':'assistant-message'}"><div class="message-avatar ${m.role==='user'?'you-avatar':esc(a.provider)}">${m.role==='user'?'S':esc(icons[a.provider]||'A')}</div><div class="message-body"><div class="message-meta"><strong>${m.role==='user'?'You':esc(a.name)}</strong><time>${esc(new Date(m.createdAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}))}</time>${m.status==='streaming'?'<span class="stream-label"><span class="status-dot working"></span> Working</span>':''}</div>${m.activity?.length?`<details class="activity-detail" ${m.status==='streaming'?'open':''}><summary>${esc(m.activity.at(-1))}</summary><div>${m.activity.slice(-8).map(t=>`<p>${esc(t)}</p>`).join('')}</div></details>`:''}<div class="message-text">${format(m.content)}${m.status==='streaming'&&!m.content?'<div class="thinking-dots"><i></i><i></i><i></i></div>':''}</div>${m.error?`<div class="message-error">${esc(m.error)}</div>`:''}</div></article>`).join(''):`<div class="chat-empty">${badge(a,true)}<h2>A direct line to ${esc(a.name)}.</h2><p>${a.transport==='ssh'?'The agent runs on your remote machine. AgentHub is the window into it.':'Your agent stays on your computer. AgentHub brings the conversation together.'}</p><div class="starter-prompts"><button data-action="starter" data-text="What can you help me with, and which tools do you have?">What can you help me with? <span>&#8599;</span></button><button data-action="starter" data-text="Tell me about your current workspace. Please only inspect it; do not change anything.">Get to know this workspace <span>&#8599;</span></button></div><span class="chat-empty-note">${a.status==='connected'?'Connected and ready for your first message.':'Connect above when you are ready.'}</span></div>`;
    if(atBottom||!messages.length)list.scrollTop=list.scrollHeight;
    $('#send-button').disabled=a.status!=='connected'||a.busy||a.protocol==='terminal'||pendingSends.has(a.id);$('#send-button').hidden=!!a.busy;$('#stop-button').hidden=!a.busy;
    $('#compose-hint').textContent=a.busy?'Agent is working':a.status==='connected'?(a.model||'Uses the agent\'s own settings'):'Connect to start chatting';
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
    modal('Bring your agents together.','Choose where to look. Nothing connects until you approve it.',`<div class="connect-options"><button data-action="discover"><span class="option-symbol"><span class="radar-icon"></span></span><strong>Discover this computer</strong><p>Find Hermes profiles, Codex, Claude Code and local gateways.</p><small>Recommended to get started &#8594;</small></button><button data-action="hosts"><span class="option-symbol"><span class="machine-icon"></span></span><strong>Connect a remote machine</strong><p>Use your saved SSH config, key files or ssh-agent. No public API ports.</p><small>VPS, server or remote computer &#8594;</small></button><button data-action="manual"><span class="option-symbol">+</span><strong>Add a connection manually</strong><p>Choose an agent preset, API endpoint, ACP command or native terminal.</p><small>For custom installations &#8594;</small></button></div><div class="modal-note"><span class="status-dot connected"></span> No AgentHub account. No third-party routing. Your provider login stays where the agent runs.</div>`,true);
  }
  async function discover(hostId,extraHome){
    const host=state.hosts.find(h=>h.id===hostId);
    modal('Looking for your agents...',host?`Read-only discovery on ${host.name}.`:'Checking known install folders, CLI tools and loopback API ports.',`<div class="scan-progress"><span class="radar-icon"></span><h3>${host?'Verifying SSH and inspecting the selected account':'Exploring this computer'}</h3><p>No subnet scanning. No services installed or restarted.</p></div>`);
    modalBusy=true;
    try{
      const result=await api.discover({hostId,extraHome});modalBusy=false;
      const items=result.agents||[];window.__discovered=items;
      modal(items.length?`${items.length} agent connection${items.length===1?'':'s'} found.`:'No agents found in the standard locations.',result.scope||'Review each connection before adding it.',`<div class="discovery-results">${items.map((a,i)=>`<div class="discovery-row">${badge(a)}<div><strong>${esc(a.name)}</strong><p>${esc(a.detail)}</p><div class="discovery-meta">${meta(a)}</div><code>${esc(a.hermesHome||a.endpoint||a.command)}</code></div><span class="discovery-state">${esc(a.readiness)}</span><button class="secondary" data-action="discovered-add" data-index="${i}">Review & add</button></div>`).join('')||'<div class="blank-state"><p>Your agent may be in a custom directory, a container or WSL. Add its executable or API endpoint manually. AgentHub does not scan every directory or start containers automatically.</p></div>'}</div>${result.warnings?.length?`<details class="discovery-warnings"><summary>Discovery notes (${result.warnings.length})</summary>${result.warnings.map(w=>`<p>${esc(w)}</p>`).join('')}</details>`:''}<div class="modal-footer"><span>${esc(result.machine?.hostname||'')} ${!host&&result.hosts?.length?`/ ${result.hosts.length} saved SSH aliases available`:''}</span><div>${!host?'<button class="subtle" data-action="scan-folder">Scan another Hermes home</button>':''}<button class="secondary" data-action="manual">Add manually</button></div></div>`,true);
    }catch(error){modalBusy=false;modal('Discovery needs attention','No changes were made to your agents.',`<div class="inline-notice error-notice"><p>${esc(error.message)}</p></div><div class="modal-footer"><button class="secondary" data-action="${host?'host-terminal':'manual'}" ${host?`data-id="${esc(host.id)}"`:''}>${host?'Open SSH terminal':'Add manually'}</button><button class="subtle" data-action="help">Connection help</button></div>`);}
  }
  function inputField(name,label,value='',placeholder='',extra='') {return `<label class="field"><span>${label}</span><input name="${name}" value="${esc(value)}" placeholder="${esc(placeholder)}" ${extra}></label>`;}
  function openAgentForm(input={}) {
    const a={provider:'hermes',protocol:'openai',transport:'http',name:'',endpoint:'http://127.0.0.1:8642/v1',model:'hermes-agent',command:'hermes',args:[],...input};
    const options=(values,current)=>values.map(([id,label])=>`<option value="${id}" ${id===current?'selected':''}>${label}</option>`).join('');
    modal(a.id?'Connection settings':'Add an agent',a.id?'Change where this agent runs, not who it is.':'A name, a connection, and you are in.',`<form id="agent-form" data-id="${esc(a.id||'')}"><div class="form-grid">${inputField('name','Agent name',a.name,'e.g. Hermes / Research','required maxlength="80"')}<label class="field"><span>Agent</span><select name="provider">${options(Object.entries(labels),a.provider)}</select></label><label class="field"><span>Connection protocol</span><select name="protocol">${options([['openai','Gateway / OpenAI-compatible API'],['codex','Codex app server'],['claude','Claude Code (streamed CLI)'],['acp','Agent Client Protocol (ACP)'],['terminal','Native terminal only']],a.protocol)}</select></label><label class="field"><span>Where it runs</span><select name="transport">${options([['http','Direct API (local or HTTPS)'],['local','Local executable'],['ssh','Remote machine over SSH']],a.transport)}</select></label></div><div data-field="ssh"><label class="field"><span>Remote machine</span><select name="hostId"><option value="">Select a saved SSH host</option>${state.hosts.map(h=>`<option value="${esc(h.id)}" ${a.hostId===h.id?'selected':''}>${esc(h.name)} (${esc(h.alias||h.hostname)})</option>`).join('')}</select></label><p class="field-help">The endpoint below is on the remote host. AgentHub creates a loopback-only SSH tunnel. Add machines from the sidebar first.</p></div><div data-field="api">${inputField('endpoint','API base URL',a.endpoint,'http://127.0.0.1:8642/v1')}<p class="field-help">Use the base URL ending in /v1, not /chat/completions. Remote plain HTTP requires SSH.</p><div class="form-grid">${inputField('model','Model / agent ID',a.model,'Use the gateway default')}<label class="field"><span>Gateway API token ${a.hasToken?'<em>stored securely</em>':''}</span><input name="token" type="password" autocomplete="new-password" placeholder="${a.hasToken?'Leave empty to keep the saved token':'Only if the gateway requires one'}"></label></div><label class="check-row"><input type="checkbox" name="remember" ${state.secureStorage?'checked':''}> Remember token with OS encryption <small>${state.secureStorage?'Protected by your OS keychain':'Unavailable here: keep tokens in memory only'}</small></label><label class="check-row" data-field="hermes-import"><input type="checkbox" name="importToken" ${a.hermesHome&&!a.hasToken?'checked':''}> Import API_SERVER_KEY from this Hermes profile <small>A native confirmation is required. Provider keys are never imported.</small></label></div><div data-field="command"><div class="path-field">${inputField('command','Executable',a.command,'hermes, codex, claude or an absolute path')}<button type="button" class="secondary" data-action="pick" data-kind="executable" data-field-name="command" title="Choose a local executable">Browse</button></div>${inputField('args','Arguments (JSON array)',JSON.stringify(a.args||[]),'[]')}<p class="field-help">No shell interpolation. Hermes adds acp; Codex adds app-server. For a custom ACP Docker agent, use docker with ["exec","-i","container","hermes","acp"].</p></div><details class="advanced-fields" ${a.hermesHome?'open':''}><summary>Workspace, profile & advanced</summary><div class="path-field">${inputField('cwd','Working directory',a.cwd,'Absolute path on the selected machine')}<button type="button" class="secondary" data-action="pick" data-kind="directory" data-field-name="cwd">Browse</button></div><div data-field="hermes">${inputField('hermesHome','Hermes profile home',a.hermesHome,'e.g. /home/ubuntu/.hermes/profiles/research')}<p class="field-help">Existing gateway API is recommended for running agents. ACP creates a separate process; never point two writers at the same active profile.</p></div>${inputField('note','Connection note',a.note,'Optional context for this agent')}<label class="check-row"><input type="checkbox" name="pinned" ${a.pinned?'checked':''}> Pin to the top of the sidebar</label></details><div class="inline-notice" data-field="claude"><p>Claude keeps its CLI login and native permission defaults. When a headless tool is denied, use Run CLI in Terminal to approve it interactively.</p></div><div class="inline-notice" data-field="acp"><p>Only use trusted agent executables. ACP tool requests are shown in native approval dialogs and are denied by default. This does not sandbox the agent's own process.</p></div><div class="modal-footer"><div>${a.id?`<button type="button" class="danger-text" data-action="remove" data-id="${esc(a.id)}">Remove connection</button>`:'<span>Stored only on this computer.</span>'}</div><div><button type="submit" class="secondary" value="save">Save connection</button><button type="submit" class="primary" value="connect">Save & connect &#8594;</button></div></div></form>`,true);
    const form=$('#agent-form');
    form.elements.token.addEventListener('input',()=>{if(form.elements.token.value)form.elements.importToken.checked=false;});
    function sync(){const p=form.elements.protocol.value,t=form.elements.transport.value,v=form.elements.provider.value;for(const node of form.querySelectorAll('[data-field]')){const f=node.dataset.field;node.hidden=!(f==='ssh'?t==='ssh':f==='api'?p==='openai':f==='command'?p!=='openai':f==='hermes'?v==='hermes':f==='hermes-import'?v==='hermes'&&p==='openai':f==='claude'?p==='claude':f==='acp'?p==='acp':true);}for(const button of form.querySelectorAll('[data-action="pick"]'))button.hidden=t==='ssh';}
    form.elements.provider.addEventListener('change',()=>{const p=form.elements.provider.value;form.elements.command.value=p==='custom'?'':p;form.elements.protocol.value=p==='codex'?'codex':p==='claude'?'claude':'openai';if(form.elements.transport.value!=='ssh')form.elements.transport.value=['codex','claude'].includes(p)?'local':'http';form.elements.endpoint.value=p==='openclaw'?'http://127.0.0.1:18789/v1':p==='hermes'?'http://127.0.0.1:8642/v1':'http://127.0.0.1:1234/v1';form.elements.model.value=p==='hermes'?'hermes-agent':p==='openclaw'?'openclaw/default':'';sync();});
    form.elements.protocol.addEventListener('change',()=>{if(form.elements.transport.value!=='ssh')form.elements.transport.value=form.elements.protocol.value==='openai'?'http':'local';sync();});
    form.elements.transport.addEventListener('change',sync);sync();
    form.addEventListener('submit',async event=>{
      event.preventDefault();if(modalBusy)return;
      const values=Object.fromEntries(new FormData(form));
      let args;try{args=JSON.parse(values.args||'[]');}catch{toast('Arguments must be a JSON array, for example ["acp"].',true);return;}
      const agent={...a,...values,args,pinned:form.elements.pinned.checked};delete agent.token;delete agent.importToken;delete agent.remember;
      const token=values.token||undefined;
      modalBusy=true;for(const b of form.querySelectorAll('button[type="submit"]'))b.disabled=true;
      try{const saved=await api.saveAgent({agent,token,remember:form.elements.remember.checked,importToken:form.elements.importToken.checked&&values.provider==='hermes'&&values.protocol==='openai'});modalBusy=false;overview=false;closeModal();if(event.submitter?.value==='connect')await action(()=>api.connect({id:saved.id}));else toast('Connection saved.');render();}
      catch(error){modalBusy=false;for(const b of form.querySelectorAll('button[type="submit"]'))b.disabled=false;toast(error.message,true);}
    });
  }
  function openHosts(edit={}){
    modal('Your machines.','OpenSSH handles your saved keys, ssh-agent, jump hosts and host verification.',`<div class="hosts-header"><span>${state.hosts.length} saved machine${state.hosts.length===1?'':'s'}</span><div><button class="subtle" data-action="local-terminal">&gt;_ Local shell</button><button class="secondary" data-action="import-hosts">Import ~/.ssh/config aliases</button></div></div><div class="host-list">${state.hosts.map(h=>`<div class="host-row"><span class="host-symbol"><span class="machine-icon"></span></span><div><button class="text-button host-name" data-action="edit-host" data-id="${esc(h.id)}">${esc(h.name)}</button><code>${esc(h.alias?`ssh ${h.alias}`:`${h.username?h.username+'@':''}${h.hostname}:${h.port}`)}</code></div><button class="subtle" data-action="host-terminal" data-id="${esc(h.id)}" title="Verify this host and open an interactive SSH shell">&gt;_ Terminal</button><button class="secondary" data-action="host-discover" data-id="${esc(h.id)}">Discover agents</button><button class="icon-button danger-text" data-action="remove-host" data-id="${esc(h.id)}" title="Remove this saved host" aria-label="Remove ${esc(h.name)}">&#10005;</button></div>`).join('')||'<div class="blank-state"><strong>Your servers belong here.</strong><p>Import the aliases you already use in your terminal, or add a host below. Importing aliases does not contact those hosts.</p></div>'}</div><details class="advanced-fields" open><summary>${edit.id?'Edit machine':'Add a machine manually'}</summary><form id="host-form">${inputField('address','Quick connect',edit.alias||'','user@server:22, ssh://user@server:2222, or saved-alias')}<p class="field-help">Paste your SSH address. Existing keys and ssh-agent stay on this computer. Or use the individual fields below.</p><div class="form-grid">${inputField('name','Display name',edit.name,'e.g. Hetzner / Production')}${inputField('alias','Existing SSH config alias',edit.alias,'e.g. production')}</div><div class="field-divider">OR CONNECT DIRECTLY</div><div class="form-grid">${inputField('hostname','Hostname or IP',edit.hostname,'203.0.113.10')}${inputField('username','SSH username',edit.username,'ubuntu')}${inputField('port','SSH port',edit.port||22,'22','type="number" min="1" max="65535"')}<div class="path-field">${inputField('identityFile','SSH identity file (optional)',edit.identityFile,'Use ssh-agent / SSH config')}<button type="button" class="secondary" data-action="pick" data-kind="identityFile" data-field-name="identityFile">Browse</button></div></div><p class="field-help">A config alias takes precedence over hostname, username and port. Private keys are never uploaded or copied into AgentHub. Encrypted keys should be unlocked in your OS ssh-agent.</p><div class="modal-footer"><span>Only hosts you select are inspected.</span><button type="submit" class="primary">${edit.id?'Update machine':'Save machine'}</button></div></form></details>`,true);
    $('#host-form').addEventListener('submit',async event=>{event.preventDefault();await action(async()=>{await api.saveHost({...edit,...Object.fromEntries(new FormData(event.target))});state=await api.snapshot();render();openHosts();toast('Machine saved.');});});
  }
  function openHelp(){
    modal('A little help, right here.','Choose the connection that fits how your agent already runs.',`<div class="help-grid"><section><h3>Hermes already running?</h3><p>Connect to its gateway API, not a second ACP process using the same profile. Each independent profile needs its own API port.</p><pre>API_SERVER_ENABLED=true\nAPI_SERVER_PORT=8642\nAPI_SERVER_KEY=your-long-random-secret</pre><p>Add those settings to that profile's .env and start or restart its gateway yourself. Then Discover and choose Import gateway token.</p><button class="text-button" data-action="docs" data-topic="hermes">Hermes API setup &#8599;</button></section><section><h3>Your first SSH connection</h3><p>Machines &rarr; import your SSH aliases &rarr; Terminal. Verify the host fingerprint against a trusted source. Use Local shell to unlock your key in this computer's ssh-agent, then run Discover agents.</p><p>Unknown or changed host keys block automated connections. AgentHub never disables host verification or forwards your SSH agent.</p></section><section><h3>Codex & Claude Code</h3><p>Use the same CLI installation and login you already use. Log in through the integrated terminal if necessary.</p><p>Codex uses its app server. Claude streams its CLI and resumes specific sessions. Claude's interactive approvals remain in its native terminal.</p><button class="text-button" data-action="docs" data-topic="codex">Codex integration &#8599;</button><button class="text-button" data-action="docs" data-topic="claude">Claude CLI &#8599;</button></section><section><h3>OpenClaw & other agents</h3><p>Enable OpenClaw's chatCompletions HTTP endpoint and enter its gateway token. Select an agent with openclaw/agent-id.</p><p>Other agents can use an OpenAI-compatible gateway, ACP executable, or native terminal. Container and WSL installations need an explicit command or endpoint in this release.</p><button class="text-button" data-action="docs" data-topic="openclaw">OpenClaw setup &#8599;</button></section></div><div class="privacy-box"><h3>What stays where</h3><p>Provider credentials and agent memory stay with the agent. Saved gateway tokens use OS encryption; when unavailable, choose memory-only tokens. Chat transcripts are local plaintext files in your OS application-data folder. Terminal scrollback is saved locally. A separate session service keeps live terminals and chat streams running when the window closes. Remote shells use tmux, so they can survive losing this computer's SSH connection. Local processes do not survive a computer reboot; saved history does. No analytics or automatic cloud sync.</p><p>Disconnect and Stop close the local connection. A remote job may continue after a network break; verify its status before resending a task. HTTP gateways enforce their own tool permissions.</p></div><div class="shortcuts"><span><kbd>Ctrl K</kbd> Switch agent</span><span><kbd>Ctrl N</kbd> New conversation</span><span><kbd>Ctrl &#96;</kbd> Terminal</span><span><kbd>Shift Enter</kbd> New line</span></div>`,true);
  }
  async function openModels(){
    const a=selected();if(!a)return;
    modal('Model',a.name,'<p>Loading available models...</p>');
    try{
      const result=await api.agentModels({id:a.id});
      if(!$('#app-dialog'))return;
      const models=[...new Set([...(result.models||[]),a.model].filter(Boolean))];
      modal('Model',a.name,`<form id="model-form"><label class="field"><span>Model</span><select name="model"><option value="">Agent default</option>${models.map(m=>`<option value="${esc(m)}" ${m===a.model?'selected':''}>${esc(m)}</option>`).join('')}</select></label>${a.protocol!=='acp'?inputField('custom','Custom model ID','','Optional'):''}<div class="modal-footer"><button type="button" class="secondary" data-action="models">Refresh</button><button class="primary" type="submit">Apply model</button></div></form>`);
      $('#model-form').addEventListener('submit',event=>{event.preventDefault();const form=event.target;action(async()=>{await api.selectModel({id:a.id,model:form.elements.custom?.value.trim()||form.elements.model.value});closeModal();toast('Model updated.');});});
    }catch(e){if($('#app-dialog'))modal('Model',a.name,`<div class="inline-notice error-notice">${esc(e.message)}</div>`);}
  }
  async function openGateway(){
    const a=selected();if(!a)return;
    modal('Gateway',`${a.name} / ${location(a)}`,`<pre id="gateway-output">Checking gateway status...</pre><div class="modal-footer"><button class="secondary" data-action="gateway">Refresh status</button><button class="primary" id="gateway-restart">Restart gateway</button></div>`);
    const output=$('#gateway-output'),restart=$('#gateway-restart');
    const run=async operation=>{restart.disabled=true;output.textContent=operation==='restart'?'Restarting gateway...':'Checking gateway status...';try{const result=await api.gateway({id:a.id,operation});output.textContent=result.output;}catch(e){output.textContent=e.message;}finally{restart.disabled=false;}};
    restart.onclick=()=>run('restart');await run('status');
  }
  function openSettings(){
    const localCount=state.agents.filter(a=>a.transport!=='ssh').length,remoteCount=state.agents.filter(a=>a.transport==='ssh').length,dockerCount=state.agents.filter(isDocker).length;
    modal('Settings.','Tune the workspace without changing any agent credentials.',`<div class="settings-grid"><section><h3>Theme</h3><div class="theme-options"><button class="theme-option ${theme==='dark'?'selected':''}" data-action="theme" data-theme="dark"><span class="theme-swatch dark-swatch"></span><strong>Dark</strong><small>Original AgentHub look</small></button><button class="theme-option ${theme==='light'?'selected':''}" data-action="theme" data-theme="light"><span class="theme-swatch light-swatch"></span><strong>White</strong><small>Bright workspace</small></button></div></section><section><h3>Agent badges</h3><p class="settings-copy">Provider marks identify Hermes, OpenClaw, Codex and Claude. Environment chips show Local, VPS and Docker at a glance.</p><div class="settings-badges">${Object.keys(labels).filter(k=>k!=='custom').map(provider=>badge({provider})).join('')}</div></section><section><h3>Workspace</h3><div class="settings-stats"><span>${localCount} local</span><span>${remoteCount} VPS</span><span>${dockerCount} Docker</span><span>${state.hosts.length} machines</span></div></section><section><h3>Terminal restore</h3><p class="settings-copy">Closed terminals now reopen as read-only saved output. Use New shell when you want a live prompt again.</p></section></div>`,true);
  }
  function switcher(){
    modal('Jump to an agent.','Search by name, provider or machine.',`<input id="switcher-search" class="switcher-search" placeholder="Search agents..." aria-label="Search agents"><div id="switcher-list"></div>`);
    const update=()=>{const q=$('#switcher-search').value.toLowerCase();$('#switcher-list').innerHTML=state.agents.filter(a=>`${a.name} ${labels[a.provider]} ${location(a)} ${placeText(a)}`.toLowerCase().includes(q)).map(a=>`<button class="switcher-row" data-action="switch-select" data-id="${esc(a.id)}">${badge(a)}<span><strong>${esc(a.name)}</strong><small>${meta(a)}</small></span>${dot(a)}</button>`).join('')||'<p class="field-help">No matching agents. Add a connection to get started.</p>';};
    $('#switcher-search').addEventListener('input',update);update();$('#switcher-search').focus();
  }
  function activateTerminal(id){
    currentTerminal=id;
    for(const view of terminalViews.values())view.element.hidden=view.id!==id;
    const active=terminalViews.get(id);
    $('[data-action="terminal-detach"]').disabled=!active||active.poppedOut;
    $('[data-action="terminal-detach"]').title='Open terminal in a separate window';
    $('[data-action="terminal-end"]').disabled=!active;
    $('#terminal-title').textContent=active?.title||`Terminal / ${selected()?.name||'no session'}`;
    $('.terminal-hint').textContent=active?.exited?'Saved output only / open a new shell to reconnect':'Persistent session / close window safely';
    $('#terminal-tabs').innerHTML=[...terminalViews.values()].map(v=>`<button class="${v.id===id?'selected':''} ${v.exited?'archived':''}" data-action="terminal-tab" data-id="${esc(v.id)}">${v.exited?'&#9633;':'&#9679;'} ${esc(v.title)}</button>`).join('');
    let placeholder=$('#terminal-placeholder');if(!placeholder){placeholder=document.createElement('div');placeholder.id='terminal-placeholder';placeholder.className='terminal-placeholder';placeholder.textContent='Open a shell or launch the native agent CLI. Switching agents keeps existing terminal sessions alive.';$('#terminal-views').append(placeholder);}placeholder.hidden=!!id;
    const view=terminalViews.get(id);if(view&&!view.poppedOut){requestAnimationFrame(()=>{view.fit.fit();if(!view.exited)action(()=>api.terminalResize({id:view.id,cols:view.term.cols,rows:view.term.rows}));view.term.focus();});}
  }
  async function openTerminal({agentId=selected()?.id,hostId,mode='shell',local=false,terminalId,restoring=false}={}){
    if(!agentId&&!hostId&&!local&&!terminalId){toast('Select an agent, or open a machine from Machines.');return;}
    if(typeof window.Terminal!=='function'||!window.FitAddon){toast('The terminal UI did not load. Reinstall the complete AgentHub build rather than moving the executable out of its installation folder.',true);return;}
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
      const view={id:result.id,agentId:result.agentId||a?.id||'',remote:result.remote,title:result.title||`${a?.name||h?.name||(local?'This computer':'SSH')} / ${mode}`,term,fit,element,exited:!!result.exited,lastSeq:result.seq||0};terminalViews.set(result.id,view);
      if(!archived)term.onData(data=>action(()=>api.terminalWrite({id:result.id,data})));
      let timer;const observer=new ResizeObserver(()=>{clearTimeout(timer);timer=setTimeout(()=>{if(element.hidden||view.poppedOut||view.exited||$('#terminal-panel').hidden)return;fit.fit();action(()=>api.terminalResize({id:result.id,cols:term.cols,rows:term.rows}));},80);});observer.observe(element);view.observer=observer;
      if(result.buffer)term.write(result.buffer);
      if(archived)term.write('\r\n\x1b[90m[Saved output from a closed session. Open New shell to reconnect.]\x1b[0m\r\n');
      for(const event of terminalPending.get(result.id)||[])terminalEvent(event);terminalPending.delete(result.id);
    }
    activateTerminal(result.id);if(!restoring)saveView();
  }
  function terminalEvent(event){
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
    if(name==='overview'){overview=true;render();saveView();return;}
    if(name==='add'){openAdd();return;}
    if(name==='manual'){openAgentForm();return;}
    if(name==='edit'){openAgentForm(state.agents.find(a=>a.id===id));return;}
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
      if(name==='select'||name==='switch-select'){overview=false;closeModal();await api.select({id});render();saveView();}
      else if(name==='discover')await discover();
      else if(name==='host-discover')await discover(id);
      else if(name==='scan-folder'){const extraHome=await api.pick({kind:'directory'});if(extraHome)await discover(undefined,extraHome);}
      else if(name==='connect'){const a=selected();if(a)await(a.status==='connected'?api.disconnect({id:a.id}):api.connect({id:a.id}));}
      else if(name==='clear-error'){await api.clearError({id});state=await api.snapshot();render();toast('Connection error cleared.');}
      else if(name==='new-conversation'){const a=selected();if(a)await api.newConversation({agentId:a.id});}
      else if(name==='export'){const c=currentConversation();if(c){if(await api.exportConversation({id:c.id}))toast('Conversation exported.');}else toast('Start a conversation first.');}
      else if(name==='stop')await api.stop({id:selected().id});
      else if(name==='remove'){if(await api.removeAgent({id})){closeModal();overview=true;state=await api.snapshot();render();}}
      else if(name==='remove-host'){await api.removeHost({id});state=await api.snapshot();openHosts();render();}
      else if(name==='import-hosts'){button.disabled=true;try{const result=await api.discover({});for(const h of result.hosts||[])await api.saveHost(h);state=await api.snapshot();openHosts();render();toast(`${result.hosts?.length||0} SSH aliases imported. No remote connections were opened.`);}finally{button.disabled=false;}}
      else if(name==='pick'){const value=await api.pick({kind:button.dataset.kind});if(value){const input=$(`[name="${button.dataset.fieldName}"]`,button.closest('form'));if(input)input.value=value;}}
      else if(name==='docs')await api.openDocs({topic:button.dataset.topic});
      else if(name==='terminal'||name==='terminal-shell')await openTerminal();
      else if(name==='terminal-cli')await openTerminal({mode:'agent'});
      else if(name==='local-terminal')await openTerminal({local:true});
      else if(name==='host-terminal')await openTerminal({hostId:id});
      else if(name==='terminal-detach'&&currentTerminal){const view=terminalViews.get(currentTerminal);view.poppedOut=true;view.term.options.disableStdin=true;try{await api.terminalPopout({id:currentTerminal});$('#terminal-panel').hidden=true;}catch(error){view.poppedOut=false;view.term.options.disableStdin=view.exited;throw error;}}
      else if(name==='terminal-end'&&currentTerminal)await closeTerminalTab(currentTerminal);
    });
  });
  document.addEventListener('keydown',event=>{
    if(!(event.ctrlKey||event.metaKey))return;
    if(event.key.toLowerCase()==='k'){event.preventDefault();switcher();}
    if($('#app-dialog'))return;
    if(event.key.toLowerCase()==='n'&&selected()){event.preventDefault();action(()=>api.newConversation({agentId:selected().id}));}
    if(event.key==='`'){event.preventDefault();if(!$('#terminal-panel').hidden)$('#terminal-panel').hidden=true;else action(()=>openTerminal());}
    if(/^[1-9]$/.test(event.key)&&state.agents[Number(event.key)-1]){event.preventDefault();overview=false;action(()=>api.select({id:state.agents[Number(event.key)-1].id}));}
  });
  if(!api){$('#content').innerHTML='<div class="runtime-missing"><h1>Open AgentHub as a desktop app.</h1><p>This workspace needs its native bridge to discover agents, use SSH and open terminals.</p><code>npm install &amp;&amp; npm start</code></div>';return;}
  async function closeTerminalTab(id){
    const view=terminalViews.get(id);if(!view||view.closing)return;view.closing=true;
    try{await api.terminalClose({id});const ids=[...terminalViews.keys()],index=ids.indexOf(id);view.observer.disconnect();view.term.dispose();view.element.remove();terminalViews.delete(id);activateTerminal(currentTerminal===id?(ids[index+1]||ids[index-1]||''):currentTerminal);saveView();}finally{view.closing=false;}
  }
  $('#terminal-tabs').addEventListener('mousedown',event=>{if(event.button===1)event.preventDefault();});
  $('#terminal-tabs').addEventListener('auxclick',event=>{const tab=event.target.closest('[data-action="terminal-tab"]');if(event.button===1&&tab){event.preventDefault();action(()=>closeTerminalTab(tab.dataset.id));}});
  $('#terminal-tabs').addEventListener('contextmenu',event=>{
    const tab=event.target.closest('[data-action="terminal-tab"]');if(!tab)return;event.preventDefault();const id=tab.dataset.id,view=terminalViews.get(id);if(!view)return;
    modal('Rename terminal','',`<form id="terminal-rename-form"><label class="field"><span>Name</span><input name="title" value="${esc(view.title)}" required maxlength="80" autocomplete="off"></label><div class="modal-footer"><button type="button" class="secondary" data-action="modal-close">Cancel</button><button type="submit" class="primary">Rename</button></div></form>`);
    const form=$('#terminal-rename-form');form.elements.title.select();form.addEventListener('submit',event=>{event.preventDefault();action(async()=>{await api.terminalRename({id,title:form.elements.title.value});closeModal();});});
  });
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
