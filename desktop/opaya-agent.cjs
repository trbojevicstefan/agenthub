'use strict';
// Opaya Agent: a built-in assistant that helps install, connect, maintain and troubleshoot agents and machines.
// Safety boundary:
// - It only acts through the tools below. There is no generic shell, file or network tool.
// - Connections and machines change only through the broker, so the same schema validation applies as in the UI.
// - Every change and every command asks for native approval first. Commands come from fixed templates (catalog.cjs,
//   DIAGNOSTICS, SSH key templates) with validated parameters, and they run in a visible terminal.
// - Its only writable files are in its home folder: <userData>/opaya-agent (config, chat, notes). API keys stay in the vault.
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const schema=require('./schema.cjs');
const catalog=require('./catalog.cjs');
const files=require('./files.cjs');
const skills=require('./skills.cjs');
const {atomicJson,readJson}=require('./store.cjs');
const {quote,target,launch,primeShellPath,findExecutable}=require('./process.cjs');
const {Rpc}=require('./rpc.cjs');
const {PROVIDERS}=require('./providers.cjs');

const PRESETS={
  codex:{label:'Codex CLI (this computer)',kind:'codex',baseUrl:'',model:'',models:[]},
  deepseek:{label:'DeepSeek',baseUrl:PROVIDERS.deepseek.endpoint,model:'deepseek-v4-pro',models:PROVIDERS.deepseek.models},
  openai:{label:'OpenAI',baseUrl:PROVIDERS.openai.endpoint,model:'',models:[]},
  google:{label:'Google Gemini',baseUrl:PROVIDERS.google.endpoint,model:PROVIDERS.google.models[0],models:PROVIDERS.google.models,free:'Free tier',signup:'https://aistudio.google.com/apikey'},
  openrouter:{label:'OpenRouter',baseUrl:PROVIDERS.openrouter.endpoint,model:'deepseek/deepseek-chat-v3.1:free',models:['deepseek/deepseek-chat-v3.1:free','qwen/qwen3-coder:free','meta-llama/llama-3.3-70b-instruct:free',...PROVIDERS.openrouter.models],free:'Free models (:free)',signup:'https://openrouter.ai/keys'},
  'ollama-cloud':{label:'Ollama Cloud',baseUrl:'https://ollama.com/v1',model:'gpt-oss:120b',models:['gpt-oss:120b','gpt-oss:20b','qwen3-coder:480b','deepseek-v3.1:671b'],free:'Free tier',signup:'https://ollama.com/settings/keys'},
  cerebras:{label:'Cerebras',baseUrl:'https://api.cerebras.ai/v1',model:'gpt-oss-120b',models:['gpt-oss-120b','qwen-3-235b-a22b-instruct-2507','llama-3.3-70b'],free:'Free tier',signup:'https://cloud.cerebras.ai'},
  xai:{label:'xAI',baseUrl:PROVIDERS.xai.endpoint,model:PROVIDERS.xai.models[0],models:PROVIDERS.xai.models},
  groq:{label:'Groq',baseUrl:PROVIDERS.groq.endpoint,model:PROVIDERS.groq.models[0],models:PROVIDERS.groq.models,free:'Free tier',signup:'https://console.groq.com/keys'},
  mistral:{label:'Mistral',baseUrl:PROVIDERS.mistral.endpoint,model:PROVIDERS.mistral.models[0],models:PROVIDERS.mistral.models,free:'Free tier',signup:'https://console.mistral.ai/api-keys'},
  ollama:{label:'Ollama (this computer)',baseUrl:PROVIDERS.ollama.endpoint,model:'',models:['qwen3:4b','llama3.2:3b','qwen3:8b'],free:'Free, local'},
  lmstudio:{label:'LM Studio (this computer)',baseUrl:PROVIDERS.lmstudio.endpoint,model:'',models:[],free:'Free, local'},
  hermes:{label:'Hermes gateway',baseUrl:PROVIDERS.hermes.endpoint,model:'hermes-agent',models:PROVIDERS.hermes.models},
  custom:{label:'Custom OpenAI-compatible API',baseUrl:'',model:'',models:[]}
};
const KEY='opaya-agent',MAX_STEPS=40,TIMEOUT=120000;
const DIAGNOSTICS={
  versions:{label:'Installed agent tools',
    posix:"for c in hermes claude codex openclaw gemini opencode goose aider ollama node npm python3 tmux ssh; do printf '%s: ' \"$c\"; if command -v \"$c\" >/dev/null 2>&1; then \"$c\" --version 2>&1 | head -1; else echo 'not installed'; fi; done",
    windows:"foreach($c in 'hermes','claude','codex','openclaw','gemini','opencode','ollama','node','npm','python','ssh'){ $p=Get-Command $c -ErrorAction SilentlyContinue; if($p){ \"${c}: \"+$p.Source } else { \"${c}: not installed\" } }"},
  ports:{label:'Listening agent ports',
    posix:"(ss -ltn 2>/dev/null || netstat -an 2>/dev/null) | grep -E ':(8642|8643|8644|8645|18789|11434|1234|8000|8080)\\b' || echo 'No known agent ports are listening.'",
    windows:"Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in 8642,8643,8644,8645,18789,11434,1234,8000,8080 } | Format-Table LocalAddress,LocalPort,OwningProcess -AutoSize"},
  hermes:{label:'Hermes status',posix:"hermes status 2>&1 | tail -40; ls -1 ~/.hermes/profiles 2>/dev/null | sed 's/^/profile: /'",windows:"hermes status"},
  docker:{label:'Running containers',posix:"docker ps --format '{{.Names}}  {{.Image}}  {{.Status}}' 2>&1 | head -40",windows:"docker ps --format '{{.Names}}  {{.Image}}  {{.Status}}'"},
  resources:{label:'Disk and memory',posix:"df -h ~ | tail -1; (free -h 2>/dev/null || vm_stat 2>/dev/null) | head -3; uptime",windows:"Get-PSDrive C | Format-Table Used,Free -AutoSize; Get-CimInstance Win32_OperatingSystem | Format-List FreePhysicalMemory,TotalVisibleMemorySize"}
};
// What an install terminal is doing now, from its output: finished (with exit code), asking a question or a password.
function promptState(output){
  const text=stripAnsi(String(output||'')),tail=text.slice(-600),lastLines=tail.split(/\r?\n/).filter(l=>l.trim()).slice(-3).join('\n');
  const done=[...text.matchAll(/\[opaya\] finished with exit code (\d+)/g)].pop();
  const password=/(password|passphrase|passcode)[^\n]*:\s*$/i.test(lastLines)||/\[sudo\] password/i.test(lastLines);
  const question=!password&&(/(\[[yY]\/[nN]\]|\([yY]\/[nN]\)|\[[yY]es\/[nN]o\]|\(yes\/no[^)]*\)|press (enter|return|any key)|continue\?|proceed\?|select|choose|enter (a )?(number|choice|option))[^\n]*\s*$/i.test(lastLines)||/[?:]\s*$/.test(lastLines.split('\n').pop()||''));
  return done?{finished:true,exit_code:Number(done[1])}:{finished:false,question,password};
}
// How the Opaya Agent installs and updates things end to end, without the user typing in the terminal.
const INSTALL_PROCEDURE=[
  'Installing and updating: do the whole job yourself. The user should not have to type anything in a terminal.',
  'Never ask the user to type or paste commands into a terminal. You have tools for installing, updating, checks, answering installer questions, connections, machines, SSH keys and skills: use them. If something truly has no tool, say so plainly and point to the Opaya feature that does it (for example right-click an agent > Run native CLI for a first sign-in), instead of handing over shell commands.',
  '1. run_diagnostic versions on the target (this computer or the machine) to see what is installed and which versions.',
  '2. Install missing dependencies first with install_framework (node, python, git, uv, tmux, gh, homebrew on macOS; or essentials when several are missing). Check list_frameworks for each agent\'s requires.',
  '3. install_framework for the agent, or update_framework to bring an installed agent or dependency to its latest version (essentials updates all of them).',
  '4. Follow every terminal with wait_for_terminal until finished=true. When it reports question=true, read the output and answer with answer_prompt (usually enter for the default, or y). Keep waiting and answering until it finishes. When it fails (exit code not 0), read the output, fix the cause (usually a missing dependency or PATH) and retry once.',
  '5. Only two things need the user: a password prompt (password=true; sudo or SSH), and signing in to an account (browser login, API keys). Say exactly what to do and where, then continue.',
  '6. Afterwards: discover_agents on that target, save_connection for the new agent (for Hermes prefer its gateway API when it runs, otherwise ACP), connect_agent, and report the result.',
  'On Windows, tools installed by winget appear on PATH in terminals opened afterwards; a new install terminal picks them up. npm tools that cannot install globally go to ~/.npm-global.'
].join('\n');
// Everything in the Opaya desktop app, so the Opaya Agent can explain it and point to the right place.
const APP_GUIDE=`Opaya app guide (tell the user where things are; you cannot click for them):
- Sidebar: the Opaya Agent at the top, Workspace (cards for every agent, Connect all), Playground (two agents answer the same question side by side), agents grouped as Pinned, custom groups, This computer and Remote; under each agent's name is the machine it runs on (or the provider's server for API connections). Right-click an agent: Open chat, New conversation, Connect or Disconnect, Manage, Chat history, then submenus Files & terminal (Browse files, Open shell, Run native CLI, Connection log), Skills & tools (Skills tools & MCP, Projects, Transfer to another agent, iTrust, Opaya browser), Name & look (Rename, Change icon, Group & tags, Pin, Move up or down) and Maintenance (Update, Back up to this computer, Clone for Hermes, Redeploy for clones, Uninstall), plus Connection settings and Remove connection. Drag agents to reorder or into a group. Right-click empty sidebar space for Discover, Install agents, Update all agents, Add connection, Machines, local terminal, Skills library, theme and Settings.
- Manage (right-click > Manage, or the Manage button above a chat): one screen with every option for an agent: where it runs, how it is installed (npm, Homebrew, uv, pipx, official installer, Hermes profile or Docker container), its version and data size, all actions, its local backups and a danger zone (Uninstall, Remove connection).
- Updates: Opaya checks every agent, CLI and tool (Node.js, Python, Git, uv, gh...) on this computer and on machines with agents once an hour; a status bar chip and a note show what to update (Updates dialog: Update, Update all here, Check now). Install agents shows installed tools with their version and Update instead of Install. When a connection fails because something is too old, Opaya updates it automatically, reconnects, then hands it to you (the Opaya Agent) and finally shows the user the error (Settings > Agents and tools).
- Update, back up, uninstall: Update runs the right updater for the installation (hermes update, claude update, npm, Docker image pull and recreate). Update all agents (Machines, or right-click the workspace) updates each installation once per machine. Back up to this computer saves the agent's data (Hermes home without the installation; ~/.claude, ~/.codex, ~/.openclaw and so on) as a .tar.gz with or without chat history and API keys, local or remote, into the backup folder. Uninstall finds how the agent was installed and removes it in a visible terminal, optionally backs up first, deletes its data and removes the connection; for a Hermes profile it deletes the profile, for a container it removes the container. Agents that share one installation (Hermes profiles) are named before anything is removed.
- Chat: Markdown replies with tables, code blocks (Copy, Preview for HTML and SVG) and images; / in the message box lists commands and skills; Models sets the default model or one for this chat; Stop cancels only the current answer; the chat picker switches conversations (project chats show [project] first).
- Chat history (clock button next to a chat, Ctrl/Cmd+Shift+H, or right-click an agent > Chat history): right panel with All, Chats, Projects and Playground tabs, search and one or all agents. Per chat: Condense (keeps the essence: goal, key points, decisions, open items; uses tokens, with your model API key when set, otherwise the chat's agent), Share (copy Markdown, copy essence, save .md, send to another agent), Rename, Delete (deletes the chat and its transcript in Opaya, not the agent's own sessions).
- Projects (folder button in the top bar or Ctrl/Cmd+Shift+P): a folder on this computer or a machine plus the agents working in it; clicking an agent starts a chat in that folder. Right-click a project for git (status, pull, push, commit, stash, branches, merge, history) and GitHub CLI (create PR, list PRs, checks, open, check out, merge, sign in).
- Terminal (Ctrl+\`): tabs, search (Ctrl+F), rename, pop out to a window, end; sessions keep running when Opaya closes; remote terminals use tmux. Terminal and browser dock at the bottom or on the right and resize; the layout is remembered.
- Opaya browser (globe button): links open inside Opaya. Right-click an agent > Give Opaya browser lets local ACP (Hermes) and Claude Code agents open pages, read, click and type from their next conversation. Only for models that can see images (Claude, GPT-4o and later, Gemini, Grok, Qwen-VL, Llama 3.2 Vision, Pixtral and similar); text-only models such as DeepSeek, Qwen3 or gpt-oss do not get it, and Manage shows why. Page dialogs are answered automatically and every browser action returns within 45 seconds.
- Skills, tools & MCP (Skills button or right-click): lists skills and commands, installs Hermes skills, MCP servers per agent. Settings > MCP servers adds stdio or HTTP servers once for all agents (secrets stay encrypted). Transfer to another agent copies all or selected skills, Hermes API keys by name (values never shown), MCP servers and the gateway token, and runs in the progress window. Skills library (Settings, sidebar right-click or Skills panel) keeps global skills: add from an agent or a folder, install to many agents, remove.
- Clone (Hermes, right-click > Clone): copy Everything, Skills + personality, Skills or Memory (optionally API keys) to this computer or a VPS, as a Hermes profile or a Docker container; progress window with speed and time left, minimizable to the status bar. Redeploy copies the same parts again.
- Machines: This computer (click its name or the pencil to rename it in Opaya, add a note and choose the backup folder) plus SSH machines. Add a new VPS creates an SSH key in ~/.ssh, shows the public key to add at the provider (or installs it with the password), tests the connection and checks Docker and Hermes. Discover finds agents per machine; installed ones are hidden, missing ones have Install buttons. Install agents installs agents and dependencies on this computer or a machine. On a machine, Install agents asks whether to install an agent regularly or as a Docker container (Hermes from its official image; Claude Code, Codex, Gemini CLI and OpenCode in a Node.js container, data in ~/opaya-agents/<name>); the Docker install signs in and adds the agent by itself. Your install_framework does the regular install; for a container, send the user to Install agents > the machine > the agent > Docker container. Docker itself is installable as a dependency (id docker).
- iTrust: Settings > iTrust mode for all agents or the Opaya Agent, or right-click an agent: its tool requests are approved automatically. For you, removals still ask.
- Settings: theme (dark or light), iTrust, Updates, Skills library, MCP servers. Updates: Opaya checks GitHub releases, downloads with checksum verification and installs in place (Update in the status bar, then Install and restart).
- Connection log (right-click an agent): protocol messages, stderr, running tools, pending approvals and Hermes log tail; your agent_diagnostics tool reads the same.
- Your chats: New chat and earlier chats at the top of your panel; Model settings chooses your model and API key.`;
const fn=(name,description,properties={},required=[])=>({type:'function',function:{name,description,parameters:{type:'object',properties,required,additionalProperties:false}}});
const TOOLS=[
  fn('get_workspace','Read all saved agent connections (with live status and last error), SSH machines and open terminals. Start here.'),
  fn('list_frameworks','List everything that can be installed: agent frameworks (kind agent), dependencies such as Node.js, Python, Git, uv, tmux, OpenSSH and Homebrew (kind dependency), and the essentials bundle that installs whatever of Node.js, Python, Git, uv and tmux is missing (kind bundle).'),
  fn('discover_agents','Read-only scan for installed agents on this computer, or on a saved SSH machine. Returns candidates; it does not add them.',{machine_id:{type:'string',description:'Saved machine id; omit for this computer.'}}),
  fn('connect_agent','Connect (or reconnect) a saved agent and report its status or error.',{agent_id:{type:'string'}},['agent_id']),
  fn('disconnect_agent','Disconnect a saved agent.',{agent_id:{type:'string'}},['agent_id']),
  fn('clear_agent_error','Clear a stale connection error on a saved agent.',{agent_id:{type:'string'}},['agent_id']),
  fn('read_terminal','Read the recent output of a terminal, for example an install or diagnostic.',{terminal_id:{type:'string'},max_chars:{type:'integer'}},['terminal_id']),
  fn('read_app_logs','Read Opaya startup diagnostics and every agent connection error.'),
  fn('agent_diagnostics','Read-only: why an agent is slow or not answering. Returns its status, how long the current answer has run and since the last update, the tools it is running, a pending approval, the last protocol messages between Opaya and the agent, its stderr and, for Hermes, the end of its own log files.',{agent_id:{type:'string'}},['agent_id']),
  fn('run_diagnostic','Run a fixed read-only check in a visible terminal and return its output.',{check:{type:'string',enum:Object.keys(DIAGNOSTICS)},machine_id:{type:'string',description:'Saved machine id; omit for this computer.'}},['check']),
  fn('save_connection','Add or update an agent connection. The user approves it first. Never include API tokens; the user enters tokens in the connection form.',{connection:{type:'object',description:'Fields: id (to update), name, provider (hermes|codex|claude|openclaw|custom), protocol (openai|acp|codex|claude|terminal), transport (http|local|ssh), hostId, endpoint, model, command, args, cwd, hermesHome, displayName, description, note, group (sidebar group name), tags (array of labels). Gemini CLI: provider custom, protocol acp, command gemini, args ["--acp"]. OpenCode: provider custom, protocol acp, command opencode, args ["acp"]. Codex CLI: provider codex, protocol codex, command codex. Prefer discover_agents, which fills these in.'}},['connection']),
  fn('remove_connection','Remove a saved agent connection and its local chats. The user approves it first.',{agent_id:{type:'string'}},['agent_id']),
  fn('save_machine','Add or update a saved SSH machine. The user approves it first.',{machine:{type:'object',description:'Fields: id (to update), name, alias, hostname, username, port, identityFile.'}},['machine']),
  fn('remove_machine','Remove a saved SSH machine that no agent uses. The user approves it first.',{machine_id:{type:'string'}},['machine_id']),
  fn('install_framework','Install an agent framework, a dependency or the essentials bundle in a visible terminal, on this computer or a saved machine. The user approves the exact command first. Dependency commands skip what is already installed.',{framework_id:{type:'string',description:'An id from list_frameworks, for example codex, node, python or essentials.'},machine_id:{type:'string',description:'Saved machine id; omit for this computer.'}},['framework_id']),
  fn('update_framework','Update an installed agent framework or dependency (or every essential) to its latest version, in a visible terminal, on this computer or a saved machine. The user approves the exact command first. Check versions first with run_diagnostic versions.',{framework_id:{type:'string',description:'An id from list_frameworks, for example hermes, claude, codex, node or essentials.'},machine_id:{type:'string',description:'Saved machine id; omit for this computer.'}},['framework_id']),
  fn('wait_for_terminal','Wait for an install, update or check you started to finish (up to 180 seconds) and return its latest output. Returns finished=true with the exit code when the command ended, question=true when the program is waiting for an answer (then use answer_prompt), or password=true when it asks for a password (only the user can type that).',{terminal_id:{type:'string'},seconds:{type:'integer',description:'Maximum seconds to wait, 5 to 180. Default 90.'}},['terminal_id']),
  fn('answer_prompt','Answer a question from an installer in a terminal you started (install_framework, update_framework, run_diagnostic, install_skill): press Enter for the default, y/n, yes/no, a menu number, arrow keys, space, tab, q or Ctrl+C. Only these fixed answers are possible: never passwords, keys, tokens or commands. Read the output first and pick the safe default unless the user said otherwise.',{terminal_id:{type:'string'},answer:{type:'string',enum:['enter','y','n','yes','no','1','2','3','4','5','6','7','8','9','up','down','space','tab','q','ctrl_c']}},['terminal_id','answer']),
  fn('ssh_key','Create an ed25519 SSH key on this computer, or install a public key on a saved machine, in a visible terminal. The user approves it first and types any passphrase or password.',{action:{type:'string',enum:['generate','install']},key_name:{type:'string',description:'File name in ~/.ssh, letters, numbers, _ and -.'},machine_id:{type:'string'}},['action','key_name']),
  fn('list_directory','Read-only: list a folder on this computer or a saved machine (default: home folder).',{path:{type:'string'},machine_id:{type:'string'}}),
  fn('read_file','Read-only: read up to 256 KB of a text file on this computer or a saved machine. Secret files such as .env, keys and tokens are refused.',{path:{type:'string'},machine_id:{type:'string'}},['path']),
  fn('project_info','Read-only: project markers, git branch, uncommitted changes and recent commits for a folder.',{path:{type:'string'},machine_id:{type:'string'}},['path']),
  fn('list_skills','Read-only: the skills installed for an agent (folders with a SKILL.md) and where they live. Users run a skill with /name in the chat.',{agent_id:{type:'string'}},['agent_id']),
  fn('install_skill','Install a Hermes skill with `hermes skills install` in a visible terminal. The user approves it first. Use hub ids such as official/security/1password or skills-sh/owner/repo/skill, or an https link to a SKILL.md.',{agent_id:{type:'string'},skill:{type:'string'}},['agent_id','skill']),
  fn('list_projects','Read-only: saved projects (a folder on this computer or a machine, and the agents that work in it). Use project_info with the folder for git state. The user runs git actions from the Projects panel.'),
  fn('list_mcp_servers','Read-only: MCP servers saved in Opaya and which agents use them. Values of environment variables and headers are never shown. The user adds or edits servers in Settings > MCP servers.'),
  fn('read_notes','Read your notes file in your home folder.'),
  fn('write_notes','Replace your notes file in your home folder (max 20000 characters). Use it to remember setup decisions.',{content:{type:'string'}},['content'])
];
const stripAnsi=text=>String(text||'').replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)/g,'').replace(/\r/g,'');

class OpayaAgent{
  constructor({root,vault,broker,terminals,approve,emit,runInTerminal,platform=process.platform,fetchImpl=globalThis.fetch,spawnAgent=launch,trusted=()=>false}){
    Object.assign(this,{home:path.join(root,'opaya-agent'),root,vault,broker,terminals,approve,emit,runInTerminal,platform,fetch:fetchImpl,spawnAgent,trusted});this.ownTerminals=new Set();
    this.config={preset:'',baseUrl:'',model:''};this.messages=[];this.busy=false;this.status='';this.error='';this.controller=null;this.liveReply=null;this.codexRpc=null;this.codexThreadId='';this.codexActive=null;
  }
  async init(){
    await fs.mkdir(this.home,{recursive:true,mode:0o700});
    const config=await readJson(path.join(this.home,'config.json'),{});this.config={...this.config,...config};
    // Chat sessions: an index plus one file per session. The single history.json of older versions becomes the first session.
    await fs.mkdir(path.join(this.home,'sessions'),{recursive:true,mode:0o700});
    const index=await readJson(path.join(this.home,'sessions.json'),null);
    if(Array.isArray(index?.sessions)&&index.sessions.length){this.sessions=index.sessions.filter(x=>/^[\w-]{1,80}$/.test(x.id)).slice(-100);this.sessionId=this.sessions.some(x=>x.id===index.current)?index.current:this.sessions.at(-1).id;}
    else{
      const history=await readJson(path.join(this.home,'history.json'),[]);const id=randomUUID(),first=Array.isArray(history)?history.find(m=>m.role==='user'):null;
      this.sessions=[{id,title:first?String(first.content).slice(0,60).replace(/\s+/g,' '):'New chat',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}];this.sessionId=id;
      await atomicJson(path.join(this.home,'sessions',`${id}.json`),Array.isArray(history)?history.slice(-200):[]);await this.saveIndex();
    }
    const messages=await readJson(path.join(this.home,'sessions',`${this.sessionId}.json`),[]);this.messages=Array.isArray(messages)?messages.slice(-200):[];
  }
  saveIndex(){return atomicJson(path.join(this.home,'sessions.json'),{current:this.sessionId,sessions:this.sessions});}
  async newSession(){
    if(this.busy)throw new Error('Stop the current answer first.');
    if(!this.messages.length){this.emit();return this.sessionId;}
    await this.persist();const id=randomUUID();
    this.sessions.push({id,title:'New chat',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});if(this.sessions.length>100)this.sessions.splice(0,this.sessions.length-100);
    this.sessionId=id;this.messages=[];this.error='';this.codexThreadId='';await this.persist();this.emit();return id;
  }
  async selectSession(id){
    if(this.busy)throw new Error('Stop the current answer first.');if(!this.sessions.some(x=>x.id===id))throw new Error('Chat not found.');
    await this.persist();this.sessionId=id;const m=await readJson(path.join(this.home,'sessions',`${id}.json`),[]);this.messages=Array.isArray(m)?m.slice(-200):[];this.error='';this.codexThreadId='';await this.saveIndex();this.emit();return true;
  }
  async deleteSession(id){
    if(this.busy)throw new Error('Stop the current answer first.');if(!this.sessions.some(x=>x.id===id))throw new Error('Chat not found.');
    this.sessions=this.sessions.filter(x=>x.id!==id);await fs.rm(path.join(this.home,'sessions',`${id}.json`),{force:true});
    if(!this.sessions.length)this.sessions.push({id:randomUUID(),title:'New chat',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
    if(id===this.sessionId){this.sessionId=this.sessions.at(-1).id;const m=await readJson(path.join(this.home,'sessions',`${this.sessionId}.json`),[]);this.messages=Array.isArray(m)?m:[];this.codexThreadId='';}
    await this.saveIndex();this.emit();return true;
  }
  configured(){return this.config.preset==='codex'||!!(this.config.baseUrl&&this.config.model);}
  describe(){
    const shown=this.messages.filter(m=>m.role==='user'||m.summary).slice(-80).map(({id,role,content,activity,createdAt,error})=>({id,role,content:content||'',activity:activity||[],createdAt,error}));
    return {configured:this.configured(),config:this.config,hasKey:this.config.preset!=='codex'&&this.vault.has(KEY),presets:PRESETS,busy:this.busy,status:this.status,error:this.error,messages:shown,live:this.liveReply?{...this.liveReply}:null,home:this.home,sessionId:this.sessionId,sessions:(this.sessions||[]).slice().reverse().map(({id,title,updatedAt})=>({id,title,updatedAt}))};
  }
  async saveConfig({preset='custom',baseUrl,model,apiKey,remember=true}){
    if(!Object.hasOwn(PRESETS,preset))throw new Error('Unknown model provider.');
    const codex=preset==='codex';
    const config={preset,baseUrl:codex?'':schema.endpoint(baseUrl||PRESETS[preset].baseUrl),model:schema.text(model,'model',256).trim()};
    if(!codex&&!config.model)throw new Error('Choose a model from the provider list.');
    if(!codex&&apiKey!==undefined&&apiKey!=='')await this.vault.set(KEY,schema.text(apiKey,'API key',16000).trim(),Boolean(remember));
    if(this.config.preset!==config.preset||this.config.model!==config.model||this.config.baseUrl!==config.baseUrl)await this.closeCodex();
    this.config=config;await atomicJson(path.join(this.home,'config.json'),config);this.error='';this.emit();return this.describe();
  }
  async forgetKey(){await this.vault.set(KEY,'',true);this.emit();return true;}
  headers(candidateKey){const key=candidateKey||(this.vault.has(KEY)?this.vault.get(KEY):'');return {'Content-Type':'application/json',...(key?{Authorization:`Bearer ${key}`}:{}),'X-Title':'Opaya'};}
  async test(candidate={}){
    const preset=candidate.preset||this.config.preset;
    if(preset==='codex'){
      const rpc=await this.ensureCodex(),result=await rpc.request('model/list',{limit:200});
      const models=(result.data||[]).map(m=>m.model||m.id).filter(m=>typeof m==='string');
      return {ok:true,models,message:`Codex CLI connected. ${models.length} models available.`};
    }
    const baseUrl=schema.endpoint(candidate.baseUrl||this.config.baseUrl||PRESETS[preset]?.baseUrl);
    if(!baseUrl)throw new Error('Choose a model provider first.');
    const response=await this.fetch(`${baseUrl}/models`,{headers:this.headers(candidate.apiKey),signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new Error(`The model API answered ${response.status}. Check the base URL and API key.`);
    const data=await response.json().catch(()=>({}));const models=(data.data||[]).map(m=>m.id).filter(Boolean).slice(0,200);
    return {ok:true,models,message:models.length?`Connected. ${models.length} models available.`:'Connected.'};
  }
  async clear(){if(this.busy)throw new Error('Stop the current answer first.');this.messages=[];this.error='';this.codexThreadId='';await this.persist();this.emit();return true;}
  stop(){
    this.controller?.abort();const active=this.codexActive,rpc=this.codexRpc;
    if(active){this.codexRpc=null;this.codexThreadId='';this.codexActive=null;if(rpc&&!rpc.closed)rpc.close();active.reject(new Error('Stopped.'));}
    return true;
  }
  async persist(){
    const s=this.sessions?.find(x=>x.id===this.sessionId);
    if(s){const first=this.messages.find(m=>m.role==='user');if(first&&s.title==='New chat')s.title=String(first.content).slice(0,60).replace(/\s+/g,' ');if(this.messages.length)s.updatedAt=new Date().toISOString();}
    await atomicJson(path.join(this.home,'sessions',`${this.sessionId}.json`),this.messages.slice(-200));await this.saveIndex();
  }
  system(){
    const s=this.broker.snapshot();
    return [
      'You are the Opaya Agent, the built-in assistant of the Opaya desktop app ("One place. All your agents.").',
      'Opaya connects Hermes, Claude Code, Codex, OpenClaw and other agents on this computer and on SSH machines, keeps their chats and terminals, and lets the user switch between them.',
      'Your job: help install new agents, connect and maintain existing ones, manage SSH machines and keys, and troubleshoot agents that do not work.',
      'Work only through your tools. Check the workspace before changing anything. Prefer the smallest change. Explain briefly what you will do before a change; every change and command is approved by the user in a native dialog, and a declined approval is final.',
      'You cannot edit the app itself, its code or files outside your home folder, and you never see or handle API tokens: ask the user to enter tokens in the connection form.',
      'Projects: list_projects shows saved project folders and their agents; chats started from a project open the agent in that folder. Git and GitHub CLI actions are in the Projects panel (right-click a project). '+
      'Skills: list_skills shows what an agent has; users run one with /name in its chat. Install Hermes skills with install_skill. MCP servers are added by the user in Settings > MCP servers (list_mcp_servers shows them); Opaya passes them to Hermes over ACP and to Claude Code. ',
      'When an agent hangs or does not answer, call agent_diagnostics first and explain what it shows: a pending approval, a tool that is still running, stderr errors or Hermes log errors. A Hermes log full of repeated "slack_bolt ... Session is closed" tracebacks is a known Hermes gateway bug in its Slack reconnect (NousResearch/hermes-agent#83662); it only affects the gateway and Slack, and restarting the Hermes gateway clears it. For agents that fail: read the connection and error, run diagnostics, check that the endpoint/port or executable exists, reconnect, and only then propose an edited connection. Do not remove connections unless asked.',
      INSTALL_PROCEDURE,
      'To understand a project or config, use list_directory, read_file and project_info (read-only).',
      APP_GUIDE,
      `Platform: ${this.platform}. Saved agents: ${s.agents.length}. Saved machines: ${s.hosts.length}. Your home folder: ${this.home}.`,
      'Answer in the language the user writes in. Be concise.'
    ].join('\n');
  }
  // Starts a request and returns at once; progress and the answer arrive through state updates.
  begin(text){if(this.busy)throw new Error('The Opaya Agent is already working.');if(!this.configured())throw new Error('Connect the Opaya Agent to a model first.');schema.prompt(text);this.send(text).catch(()=>{});return true;}
  async send(text){
    if(this.busy)throw new Error('The Opaya Agent is already working.');
    if(!this.configured())throw new Error('Connect the Opaya Agent to a model first.');
    text=schema.prompt(text);
    this.messages.push({id:randomUUID(),role:'user',content:text,createdAt:new Date().toISOString()});
    const reply={id:randomUUID(),role:'assistant',content:'',activity:[],createdAt:new Date().toISOString()};this.current=reply;
    this.busy=true;this.error='';this.status='Thinking...';this.controller=new AbortController();this.liveReply=reply;this.emit();
    let recent=this.messages.filter(m=>!m.summary).slice(-40);const start=recent.findIndex(m=>m.role==='user');recent=start<0?[]:recent.slice(start);
    const context=recent.map(({role,content,tool_calls,tool_call_id})=>({role,content:content??'',...(tool_calls?{tool_calls}:{}),...(tool_call_id?{tool_call_id}:{})}));
    const conversation=[{role:'system',content:this.system()},...context];
    try{
      if(this.config.preset==='codex')await this.runCodex(text,reply);
      else for(let step=0;step<MAX_STEPS;step++){
        const message=await this.complete(conversation);
        const calls=message.tool_calls||[];
        conversation.push({role:'assistant',content:message.content||'',...(calls.length?{tool_calls:calls}:{})});
        this.messages.push({role:'assistant',content:message.content||'',internal:true,...(calls.length?{tool_calls:calls}:{})});
        if(message.content)reply.content=message.content;
        if(!calls.length)break;
        for(const call of calls.slice(0,8)){
          const name=call.function?.name||'';let args={};try{args=JSON.parse(call.function?.arguments||'{}');}catch{}
          this.status=`Using ${name.replace(/_/g,' ')}...`;reply.activity.push(this.status.replace('...',''));this.emit();
          let result;try{result=await this.tool(name,args);}catch(error){result={error:String(error.message||error).slice(0,1000)};}
          const content=JSON.stringify(result).slice(0,24000);
          conversation.push({role:'tool',tool_call_id:call.id,content});this.messages.push({role:'tool',tool_call_id:call.id,content,internal:true});
        }
        if(step===MAX_STEPS-1)reply.content=(reply.content?reply.content+'\n\n':'')+'I stopped after the maximum number of steps. Ask me to continue if needed.';
      }
    }catch(error){reply.error=this.controller.signal.aborted?'Stopped.':String(error.message||error).slice(0,600);this.error=reply.error;}
    finally{
      // Internal tool turns stay in history for context; the chat shows one reply per request.
      this.messages.push({...reply,summary:true});
      // Save before reporting idle, so nothing still writes to the home folder once a request is finished.
      await this.persist().catch(()=>{});this.busy=false;this.status='';this.controller=null;this.liveReply=null;this.emit();
    }
    return {ok:!reply.error};
  }
  async complete(messages){
    const signal=AbortSignal.any([this.controller.signal,AbortSignal.timeout(TIMEOUT)]);
    const response=await this.fetch(`${this.config.baseUrl}/chat/completions`,{method:'POST',headers:this.headers(),signal,body:JSON.stringify({model:this.config.model,messages,tools:TOOLS,tool_choice:'auto'})});
    const data=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(data?.error?.message?`Model API: ${String(data.error.message).slice(0,300)}`:`The model API answered ${response.status}.`);
    const message=data.choices?.[0]?.message;if(!message)throw new Error('The model API returned no answer.');
    return message;
  }
  // A plain, tool-free completion with the Opaya Agent's own model API, for condensing chats. Needs an API key
  // (or a local model server); the Codex CLI preset is not used for this.
  summarizer(){if(this.config.preset==='codex'||!this.configured())return null;const local=['ollama','lmstudio'].includes(this.config.preset);return local||this.vault.has(KEY)?`${PRESETS[this.config.preset]?.label||'Model API'} / ${this.config.model}`:null;}
  async summarize(messages,{signal}={}){
    const s=AbortSignal.any([signal||new AbortController().signal,AbortSignal.timeout(5*60*1000)]);
    const response=await this.fetch(`${this.config.baseUrl}/chat/completions`,{method:'POST',headers:this.headers(),signal:s,body:JSON.stringify({model:this.config.model,messages})});
    const data=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(data?.error?.message?`Model API: ${String(data.error.message).slice(0,300)}`:`The model API answered ${response.status}.`);
    const text=data.choices?.[0]?.message?.content;if(!text)throw new Error('The model API returned no answer.');
    return {text:String(text),usage:data.usage||null};
  }
  dynamicTools(){return TOOLS.map(t=>({type:'function',name:t.function.name,description:t.function.description,inputSchema:t.function.parameters}));}
  async ensureCodex(){
    if(this.codexRpc&&!this.codexRpc.closed)return this.codexRpc;
    await primeShellPath();
    if(this.spawnAgent===launch&&!findExecutable('codex'))throw new Error('The Codex CLI was not found on this computer. Install it (Install agents > Codex CLI, or ask with another model), run codex once in Terminal to sign in, then try again.');
    await fs.mkdir(this.home,{recursive:true}).catch(()=>{});
    const agent={id:'opaya-local-codex',name:'Local Codex CLI',provider:'codex',protocol:'codex',transport:'local',command:'codex',args:[],cwd:this.home,hermesHome:''};
    const rpc=new Rpc(this.spawnAgent(agent,['app-server'],null),{jsonrpc:false,onRequest:(method,params)=>this.codexRequest(method,params)});
    this.codexRpc=rpc;rpc.on('notification',(method,params)=>this.codexNotification(method,params));rpc.on('closed',error=>{if(this.codexActive)this.codexActive.reject(error);});
    await rpc.request('initialize',{clientInfo:{name:'opaya',title:'Opaya Agent',version:'0.14.1'},capabilities:{experimentalApi:true}});rpc.notify('initialized',{});return rpc;
  }
  async codexRequest(method,params){
    if(method!=='item/tool/call')throw new Error('Unsupported Codex request.');
    const active=this.codexActive;if(!active||params.threadId!==active.threadId||this.controller?.signal.aborted)throw new Error('This Opaya turn is no longer active.');
    const name=String(params.tool||'');this.status=`Using ${name.replace(/_/g,' ')}...`;active.reply.activity.push(this.status.replace('...',''));this.emit();
    try{const result=await this.tool(name,params.arguments&&typeof params.arguments==='object'?params.arguments:{});return {contentItems:[{type:'inputText',text:JSON.stringify(result).slice(0,24000)}],success:true};}
    catch(error){return {contentItems:[{type:'inputText',text:JSON.stringify({error:String(error.message||error).slice(0,1000)})}],success:false};}
  }
  codexNotification(method,p){
    const a=this.codexActive;if(!a||p.threadId!==a.threadId)return;
    if(method==='turn/started')a.turnId=p.turn?.id;
    if(method==='item/agentMessage/delta'){a.deltaItems.add(p.itemId||'unknown');a.reply.content+=p.delta||'';this.emit();}
    if(method==='item/started'&&p.item?.type!=='agentMessage'){
      const label=String(p.item?.tool||p.item?.type||'working').replace(/([a-z])([A-Z])/g,'$1 $2');this.status=`Codex: ${label}`;if(a.reply.activity.at(-1)!==this.status)a.reply.activity.push(this.status);this.emit();
    }
    if(method==='item/completed'&&p.item?.type==='agentMessage'&&!a.deltaItems.has(p.item.id||'unknown')&&p.item.text){a.reply.content+=p.item.text;this.emit();}
    if(method==='turn/completed'){
      if(p.turn?.status==='failed')a.reject(new Error(p.turn?.error?.message||'Codex turn failed.'));
      else if(p.turn?.status==='interrupted')a.reject(new Error('Stopped.'));
      else a.resolve();
    }
    if(method==='error'&&!p.willRetry)a.reject(new Error(p.error?.message||'Codex reported an error.'));
  }
  async runCodex(text,reply){
    const rpc=await this.ensureCodex();
    if(!this.codexThreadId){
      const started=await rpc.request('thread/start',{cwd:this.home,model:this.config.model||null,sandbox:'read-only',approvalPolicy:'never',developerInstructions:this.system(),dynamicTools:this.dynamicTools(),ephemeral:false});
      this.codexThreadId=started.thread?.id||'';if(!this.codexThreadId)throw new Error('Codex did not return a thread ID.');
    }
    await new Promise((resolve,reject)=>{
      let done=false;const finish=error=>{if(done)return;done=true;clearTimeout(timer);this.codexActive=null;error?reject(error):resolve();};
      const timer=setTimeout(()=>{this.stop();finish(new Error('Codex turn timed out.'));},10*60*1000);timer.unref?.();
      this.codexActive={threadId:this.codexThreadId,turnId:'',reply,deltaItems:new Set(),resolve:()=>finish(),reject:finish};
      if(this.controller.signal.aborted){finish(new Error('Stopped.'));return;}
      rpc.request('turn/start',{threadId:this.codexThreadId,input:[{type:'text',text}],...(this.config.model?{model:this.config.model}:{})},60000).then(result=>{if(this.codexActive)this.codexActive.turnId=result.turn?.id||this.codexActive.turnId;},finish);
    });
  }
  async closeCodex(){const rpc=this.codexRpc,active=this.codexActive;this.codexRpc=null;this.codexThreadId='';this.codexActive=null;if(rpc&&!rpc.closed)rpc.close();active?.reject(new Error('Codex stopped.'));}
  async close(){await this.closeCodex();}
  host(id){return id?this.broker.host(id):null;}
  // iTrust for the Opaya Agent skips the dialog, except for removals, which always ask.
  async ask(title,detail,{always=false}={}){if(!always&&this.trusted?.()){this.status=`iTrust approved: ${title}`;this.current?.activity?.push(this.status);this.emit();return;}if(!await this.approve({name:'Opaya Agent'},title,detail))throw new Error('The user declined this action.');}
  // Terminals the Opaya Agent started; answer_prompt works only in these. Marked commands print an end line with the
  // exit code, so wait_for_terminal knows when an install is done.
  async runOwn({label,key,host,command,marked=false}){
    const posix=!!host||this.platform!=='win32';
    const full=marked?(posix?`${command}; echo "[opaya] finished with exit code $?"`:`${command}; Write-Host "[opaya] finished with exit code $(if ($?) { 0 } else { 1 })"`):command;
    const view=await this.runInTerminal({label,key,host,command:full});this.ownTerminals.add(view.id);return view;
  }
  async terminalOutput(id,wait=0){
    const deadline=Date.now()+wait;
    for(;;){const view=this.terminals.attach(id);if(view.exited||Date.now()>=deadline)return stripAnsi(view.buffer).slice(-6000);await new Promise(r=>setTimeout(r,800));}
  }
  async tool(name,args){
    const b=this.broker;
    switch(name){
      case 'get_workspace':{const s=b.snapshot();return {platform:this.platform,agents:s.agents.map(({id,name,displayName,provider,protocol,transport,hostId,endpoint,model,command,args,cwd,hermesHome,status,error,busy,hasToken,note,group,tags,pinned})=>({id,name,displayName,provider,protocol,transport,hostId,endpoint,model,command,args,cwd,hermesHome,status,error,busy,hasToken,note,group,tags,pinned})),machines:s.hosts,terminals:this.terminals.describe()};}
      case 'list_frameworks':return catalog.list().map(({id,kind,name,description,requires,after,local,remote,localCommand,remoteCommand})=>({id,kind,name,description,requires,after,installableHere:local,installableOnMachines:remote,localCommand,remoteCommand}));
      case 'discover_agents':{const r=await b.discover({hostId:args.machine_id?schema.id(args.machine_id):undefined});return {scope:r.scope,agents:(r.agents||[]).map(({name,provider,protocol,transport,endpoint,command,args,hermesHome,detail,readiness,existingId,hostId})=>({name,provider,protocol,transport,endpoint,command,args,hermesHome,detail,readiness,existingId,hostId})),warnings:r.warnings||[]};}
      case 'connect_agent':{const id=schema.id(args.agent_id);await b.connect(id).catch(()=>{});const r=b.runtimeFor(id);return {status:r.status,error:r.error||''};}
      case 'disconnect_agent':{const id=schema.id(args.agent_id);await b.disconnect(id);return {status:b.runtimeFor(id).status};}
      case 'clear_agent_error':return {cleared:b.clearError(schema.id(args.agent_id))};
      case 'read_terminal':return {output:(await this.terminalOutput(schema.id(args.terminal_id))).slice(-Math.min(Math.max(Number(args.max_chars)||4000,200),6000))};
      case 'agent_diagnostics':{const d=await b.diagnostics(schema.id(args.agent_id));if(d.adapter)d.adapter={...d.adapter,entries:(d.adapter.entries||[]).slice(-60),stderr:String(d.adapter.stderr||'').slice(-3000)};d.hermesLogs=(d.hermesLogs||[]).map(l=>({...l,tail:String(l.tail).slice(-3000)}));return d;}
      case 'read_app_logs':{
        const read=file=>fs.readFile(path.join(this.root,file),'utf8').then(t=>t.slice(-4000)).catch(()=>'');
        return {startup:await read('startup-error.txt'),service:await read('service-startup-error.txt'),agentErrors:b.snapshot().agents.filter(a=>a.error).map(a=>({id:a.id,name:a.name,status:a.status,error:a.error}))};
      }
      case 'run_diagnostic':{
        const check=DIAGNOSTICS[args.check];if(!check)throw new Error('Unknown diagnostic.');const host=this.host(args.machine_id);
        const command=host||this.platform!=='win32'?check.posix:check.windows;
        const view=await this.runOwn({label:`Check / ${check.label}`,key:`check_${args.check}`,host,command});
        return {terminal_id:view.id,output:await this.terminalOutput(view.id,host?9000:5000)};
      }
      case 'save_connection':{
        const input=args.connection&&typeof args.connection==='object'?args.connection:{};
        const existing=input.id?b.agent(input.id):null;
        const {token,apiKey,importToken,...clean}=input;
        const agent=schema.agent({...(existing||{}),...clean});
        await this.ask(existing?`Update connection "${existing.name}"?`:`Add connection "${agent.name}"?`,JSON.stringify(Object.fromEntries(Object.entries(agent).filter(([k,v])=>v!==''&&!(Array.isArray(v)&&!v.length)&&!['createdAt','avatar'].includes(k))),null,2));
        const saved=await b.saveAgent({agent});return {saved:{id:saved.id,name:saved.name},note:'Ask the user to add an API token in the connection form if the agent needs one.'};
      }
      case 'remove_connection':{const a=b.agent(args.agent_id);await this.ask(`Remove connection "${a.name}"?`,'Deletes the saved connection and its local chats in Opaya, not the agent installation.',{always:true});this.terminals.closeAgent(a.id);await b.removeAgent(a.id);return {removed:a.id};}
      case 'save_machine':{
        const input=args.machine&&typeof args.machine==='object'?args.machine:{};const existing=input.id?b.host(input.id):null;
        const host=schema.host({...(existing||{}),...input});
        await this.ask(existing?`Update machine "${existing.name}"?`:`Add machine "${host.name}"?`,JSON.stringify(host,null,2));
        const saved=await b.saveHost(host);return {saved:{id:saved.id,name:saved.name}};
      }
      case 'remove_machine':{const h=b.host(args.machine_id);await this.ask(`Remove machine "${h.name}"?`,'Only the saved machine entry is removed. Nothing changes on the machine.',{always:true});await b.removeHost(h.id);return {removed:h.id};}
      case 'install_framework':case 'update_framework':{
        const update=name==='update_framework',host=this.host(args.machine_id);const {framework,command}=catalog.command(String(args.framework_id||''),{remote:!!host,update});
        await this.ask(`${update?'Update':'Install'} ${framework.name} ${host?`on ${host.name}`:'on this computer'}?`,`Runs in a visible terminal:\n\n${command}\n\n${framework.requires&&!update?`Requires ${framework.requires}.\n`:''}Afterwards: ${framework.after}`);
        const view=await this.runOwn({label:`${update?'Update':'Install'} ${framework.name}`,key:`${update?'update':'install'}_${framework.id}`,host,command,marked:true});
        return {terminal_id:view.id,started:true,next:framework.after,hint:'Call wait_for_terminal with this terminal_id to follow it to the end; answer installer questions with answer_prompt.',output:await this.terminalOutput(view.id,4000)};
      }
      case 'wait_for_terminal':{
        const id=schema.id(args.terminal_id),limit=Math.min(Math.max(Number(args.seconds)||90,5),180)*1000,start=Date.now();
        let last='',quietSince=Date.now(),state;
        for(;;){
          const output=await this.terminalOutput(id),tail=output.slice(-1500);state=promptState(output);
          if(output!==last){last=output;quietSince=Date.now();}
          const quiet=Date.now()-quietSince;
          if(state.finished||state.exited||((state.question||state.password)&&quiet>=2500)||Date.now()-start>=limit)break;
          await new Promise(r=>setTimeout(r,1500));
        }
        return {...state,waited_seconds:Math.round((Date.now()-start)/1000),output:last.slice(-4000),
          next:state.password?'It asks for a password. Only the user can type it: tell them which terminal and what it is for, then wait_for_terminal again.':state.question?'Answer with answer_prompt.':state.finished?(state.exit_code===0?'Done. Continue with the next step.':'It failed. Read the output, fix the cause (often a missing dependency) and try again.'):'Still running. Call wait_for_terminal again.'};
      }
      case 'answer_prompt':{
        const id=schema.id(args.terminal_id);if(!this.ownTerminals.has(id))throw new Error('You can only answer prompts in terminals you started.');
        const keys={enter:'\r',y:'y\r',n:'n\r',yes:'yes\r',no:'no\r',up:'\u001b[A',down:'\u001b[B',space:' ',tab:'\t',q:'q',ctrl_c:'\u0003'};
        const answer=String(args.answer||''),data=keys[answer]??(/^[1-9]$/.test(answer)?answer+'\r':null);if(data===null)throw new Error('Unsupported answer.');
        const before=await this.terminalOutput(id);if(promptState(before).password&&answer!=='ctrl_c')throw new Error('The terminal is asking for a password. Only the user can type it.');
        this.terminals.write(id,data);this.status=`Answered ${answer} in the terminal`;this.emit();
        return {sent:answer,output:(await this.terminalOutput(id,2500)).slice(-2500)};
      }
      case 'ssh_key':{
        const name=String(args.key_name||'');if(!/^[a-zA-Z0-9_-]{1,40}$/.test(name))throw new Error('Use a key name with letters, numbers, _ and -.');
        const win=this.platform==='win32',file=win?`$HOME\\.ssh\\${name}`:`~/.ssh/${name}`;
        let command,title;
        if(args.action==='generate'){title=`Create SSH key ${name}?`;command=win?`ssh-keygen -t ed25519 -C opaya -f "${file}"`:`mkdir -p ~/.ssh && chmod 700 ~/.ssh && ssh-keygen -t ed25519 -C opaya -f ${file}`;}
        else if(args.action==='install'){
          const host=this.host(schema.id(String(args.machine_id||'')));const dest=(host.username&&!host.alias?`${host.username}@`:'')+target(host),port=host.alias?'':` -p ${host.port||22}`;
          title=`Install public key ${name}.pub on ${host.name}?`;
          command=win?`type "${file}.pub" | ssh${port} ${dest} "umask 077; mkdir -p ~/.ssh; cat >> ~/.ssh/authorized_keys"`:`ssh-copy-id -i ${file}.pub${port} ${quote(dest)}`;
        }else throw new Error('Unknown SSH key action.');
        await this.ask(title,`Runs in a visible terminal on this computer. You type any passphrase or password there.\n\n${command}`);
        const view=await this.runInTerminal({label:`SSH key ${name}`,key:`sshkey_${name}`,host:null,command});
        return {terminal_id:view.id,output:await this.terminalOutput(view.id,3000),identity_file:win?path.join(require('node:os').homedir(),'.ssh',name):`~/.ssh/${name}`};
      }
      case 'list_directory':{const r=await files.browse({op:'list',path:String(args.path||''),host:this.host(args.machine_id)});return {...r,entries:r.entries.slice(0,300)};}
      case 'read_file':{const p=String(args.path||'');if(files.isSecret(p))throw new Error('That file may contain secrets, so the Opaya Agent does not read it. Ask the user to check it in the Files panel.');const r=await files.browse({op:'read',path:p,host:this.host(args.machine_id)});if(files.isSecret(r.path))throw new Error('That file may contain secrets.');return {...r,text:r.text.slice(0,24000)};}
      case 'project_info':return files.browse({op:'project',path:String(args.path||''),host:this.host(args.machine_id)});
      case 'list_skills':{const r=await b.skills(schema.id(args.agent_id));return {...r,skills:r.skills.slice(0,150).map(({name,description,category})=>({name,description,category}))};}
      case 'install_skill':{
        const a=b.agent(args.agent_id),host=a.transport==='ssh'?b.host(a.hostId):null;
        const command=skills.hermesSkillCommand(a,{action:'install',skill:String(args.skill||''),remote:!!host,windows:this.platform==='win32'});
        await this.ask(`Install skill ${args.skill} for ${a.name}?`,`Runs in a visible terminal ${host?'on '+host.name:'on this computer'}:\n\n${command}`);
        const view=await this.runOwn({label:`Skill ${args.skill}`,key:`skills_${a.id}`.slice(0,60),host,command,marked:true});
        return {terminal_id:view.id,output:await this.terminalOutput(view.id,6000),next:'Start a new conversation with the agent to use the skill.'};
      }
      case 'list_projects':return {projects:(b.data.projects||[]).map(p=>({id:p.id,name:p.name,path:p.path,machine:p.hostId?b.data.hosts.find(h=>h.id===p.hostId)?.name||p.hostId:'this computer',machine_id:p.hostId||undefined,agents:p.agentIds.map(id=>b.data.agents.find(a=>a.id===id)?.name||id),conversations:b.data.conversations.filter(c=>c.projectId===p.id).length}))};
      case 'list_mcp_servers':return {servers:b.snapshot().mcpServers.map(({name,type,command,args,url,envNames,headerNames,agents,enabled})=>({name,type,command,args,url,envNames,headerNames,enabled,agents:agents==='all'?'all':agents.map(id=>b.data.agents.find(x=>x.id===id)?.name||id)}))};
      case 'read_notes':return {notes:await fs.readFile(path.join(this.home,'notes.md'),'utf8').catch(()=>'')};
      case 'write_notes':{const content=String(args.content??'');if(content.length>20000||content.includes('\0'))throw new Error('Notes must be under 20000 characters.');await fs.writeFile(path.join(this.home,'notes.md'),content,{mode:0o600});return {saved:true};}
      default:throw new Error('Unknown tool.');
    }
  }
}
module.exports={OpayaAgent,PRESETS,TOOLS,DIAGNOSTICS,stripAnsi,promptState,INSTALL_PROCEDURE,APP_GUIDE};
