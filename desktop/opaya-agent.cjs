'use strict';
// Opaya Agent: a built-in assistant that helps install, connect, maintain and troubleshoot agents and machines.
// Safety boundary:
// - It acts through the tools below, and its commands run in visible terminals. With iTrust on (the default) it runs
//   them without asking; with iTrust off every change and command asks first. Removals always ask.
// - Connections and machines change only through the broker, so the same schema validation applies as in the UI.
// - Commands come from fixed templates (catalog.cjs,
//   DIAGNOSTICS, SSH key templates) with validated parameters, and they run in a visible terminal.
// - Its only writable files are in its home folder: <userData>/opaya-agent (config, chat, notes). API keys stay in the vault.
// - Secrets the user gives it (pasted in the chat, typed in Opaya's secure prompt or the key button) go to the vault at
//   once; the model, the chat on disk and the UI only get references such as [secret S1 · OPENAI_API_KEY · sk-p…9f3a].
//   Its tools put a held value where an agent reads it (store_secret) or into a terminal's password prompt
//   (answer_prompt secret), and everything tools return has held values replaced by their reference.
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const schema=require('./schema.cjs');
const catalog=require('./catalog.cjs');
const updates=require('./updates.cjs');
const {previewOf}=require('./maintenance.cjs');
const files=require('./files.cjs');
const skills=require('./skills.cjs');
const {atomicJson,readJson}=require('./store.cjs');
const {quote,target,launch,primeShellPath,findExecutable,environment,terminate,dockerExecContainerIndex,collect,opayaToolsRoot}=require('./process.cjs');
const {Rpc}=require('./rpc.cjs');
const {PROVIDERS}=require('./providers.cjs');
const screen=require('./screen.cjs');
const secrets=require('./secrets.cjs');
const {place,sourceHome,isLocal}=require('./clone.cjs');
const {codexEnv,SHELL_ENV}=require('./adapters/codex.cjs');
const dockerManager=require('./docker-manager.cjs');
const transfer=require('./transfer.cjs');
const vaultImport=require('./vault-import.cjs');
const vaultBackup=require('./vault-backup.cjs');
const MAX_IMPORT_TEXT=1048576;

const PRESETS={
  codex:{label:'Codex CLI (this computer)',kind:'codex',baseUrl:'',model:'',models:[]},
  claude:{label:'Claude Code (this computer)',kind:'claude',baseUrl:'',model:'',models:['sonnet','opus','haiku']},
  anthropic:{label:'Anthropic (Claude API)',baseUrl:'https://api.anthropic.com/v1',model:'claude-sonnet-5',models:['claude-sonnet-5','claude-opus-5-5','claude-haiku-4-5']},
  deepseek:{label:'DeepSeek',baseUrl:PROVIDERS.deepseek.endpoint,model:'deepseek-v4-pro',models:PROVIDERS.deepseek.models},
  openai:{label:'OpenAI',baseUrl:PROVIDERS.openai.endpoint,model:'',models:[]},
  google:{label:'Google Gemini',baseUrl:PROVIDERS.google.endpoint,model:PROVIDERS.google.models[0],models:PROVIDERS.google.models,free:'Free tier',signup:'https://aistudio.google.com/apikey'},
  openrouter:{label:'OpenRouter',baseUrl:PROVIDERS.openrouter.endpoint,model:'deepseek/deepseek-chat-v3.1:free',models:['deepseek/deepseek-chat-v3.1:free','deepseek/deepseek-v4.1-flash','qwen/qwen3-coder:free','meta-llama/llama-3.3-70b-instruct:free',...PROVIDERS.openrouter.models],free:'Free models (:free)',signup:'https://openrouter.ai/keys'},
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
// Opens a website or an app on this computer. Values are passed as arguments, never parsed by a shell.
function openCommand(target,platform){
  const url=/^https?:\/\//i.test(target);
  if(platform==='darwin')return {file:'open',args:url?[target]:['-a',target]};
  // Windows: links through the URL handler (no shell); app names (letters, digits, spaces, . + ( ) - only) through start.
  if(platform==='win32')return url?{file:'rundll32.exe',args:['url.dll,FileProtocolHandler',target]}:{file:'cmd.exe',args:['/d','/s','/c',`start "" "${target}"`],verbatim:true};
  return {file:url?'xdg-open':'gtk-launch',args:[target]};
}
const DIAGNOSTICS={
  // Versions with how each tool is installed and where (updates.cjs), the same detection update_framework uses.
  versions:{label:'Installed agent tools',posix:updates.versionsCheck(),windows:updates.versionsCheck({windows:true})},
  ports:{label:'Listening agent ports',
    posix:"(ss -ltn 2>/dev/null || netstat -an 2>/dev/null) | grep -E ':(8642|8643|8644|8645|18789|11434|1234|8000|8080)\\b' || echo 'No known agent ports are listening.'",
    windows:"Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in 8642,8643,8644,8645,18789,11434,1234,8000,8080 } | Format-Table LocalAddress,LocalPort,OwningProcess -AutoSize"},
  hermes:{label:'Hermes status',posix:"hermes status 2>&1 | tail -40; ls -1 ~/.hermes/profiles 2>/dev/null | sed 's/^/profile: /'",windows:"hermes status"},
  docker:{label:'Running containers',posix:"docker ps --format '{{.Names}}  {{.Image}}  {{.Status}}' 2>&1 | head -40",windows:"docker ps --format '{{.Names}}  {{.Image}}  {{.Status}}'"},
  // What the user is already signed in to, so onboarding reuses it. Names and states only: secrets are masked.
  logins:{label:'Signed-in accounts and API keys',
    posix:"m(){ sed -E 's/(sk-|sk_|ghp_|gho_|xai-|AIza)[A-Za-z0-9_.-]*/\\1***/g; s/[A-Za-z0-9_+=-]{40,}/***/g'; }; echo '== Codex (ChatGPT sign-in)'; if command -v codex >/dev/null 2>&1; then codex login status </dev/null 2>&1 | head -3 | m; else echo 'not installed'; fi; echo '== Claude Code'; if command -v claude >/dev/null 2>&1; then claude auth status </dev/null 2>&1 | head -8 | m; else echo 'not installed'; fi; echo '== API keys in the environment (names only)'; for k in OPENAI_API_KEY ANTHROPIC_API_KEY OPENROUTER_API_KEY GEMINI_API_KEY GOOGLE_API_KEY XAI_API_KEY DEEPSEEK_API_KEY MISTRAL_API_KEY GROQ_API_KEY; do [ -n \"$(printenv $k)\" ] && echo \"$k is set\"; done; echo '== Hermes'; if command -v hermes >/dev/null 2>&1; then hermes status </dev/null 2>&1 | grep -E 'Model:|Provider:|✓' | head -20 | m; else echo 'not installed'; fi; echo '== OpenClaw'; if command -v openclaw >/dev/null 2>&1; then openclaw models status </dev/null 2>&1 | head -24 | m; else echo 'not installed'; fi",
    windows:"function m { process { \"$_\" -replace '(sk-|sk_|ghp_|gho_|xai-|AIza)[A-Za-z0-9_.-]*','$1***' -replace '[A-Za-z0-9_+=-]{40,}','***' } }; '== Codex (ChatGPT sign-in)'; if(Get-Command codex -ErrorAction SilentlyContinue){ codex login status 2>&1 | Select-Object -First 3 | m } else { 'not installed' }; '== Claude Code'; if(Get-Command claude -ErrorAction SilentlyContinue){ claude auth status 2>&1 | Select-Object -First 8 | m } else { 'not installed' }; '== API keys in the environment (names only)'; foreach($k in 'OPENAI_API_KEY','ANTHROPIC_API_KEY','OPENROUTER_API_KEY','GEMINI_API_KEY','GOOGLE_API_KEY','XAI_API_KEY','DEEPSEEK_API_KEY','MISTRAL_API_KEY','GROQ_API_KEY'){ if([Environment]::GetEnvironmentVariable($k)){ \"$k is set\" } }; '== Hermes'; if(Get-Command hermes -ErrorAction SilentlyContinue){ hermes status 2>&1 | Select-String -Pattern 'Model:|Provider:|✓' | Select-Object -First 20 | m } else { 'not installed' }; '== OpenClaw'; if(Get-Command openclaw -ErrorAction SilentlyContinue){ openclaw models status 2>&1 | Select-Object -First 24 | m } else { 'not installed' }"},
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
  'Never ask the user to type or paste commands into a terminal. You have tools for installing, updating, onboarding (setup_agent), checks, answering installer questions, connections, machines, SSH keys and skills: use them. When none fits, use run_command yourself instead of handing over shell commands.',
  '1. run_diagnostic versions on the target (this computer or the machine) to see what is installed and which versions.',
  '2. Install missing dependencies first with install_framework (node, python, git, uv, tmux, gh, homebrew on macOS; or essentials when several are missing). Check list_frameworks for each agent\'s requires.',
  '3. install_framework for the agent, or update_framework to bring an installed agent or dependency to its latest version (essentials updates all of them). update_framework finds how the tool is installed (Homebrew, npm of nvm, fnm, volta or Homebrew Node.js, npx, the native installer, uv, pipx, winget...) and updates that copy. When an update ends with exit code 0 but run_diagnostic versions still shows the old version, another copy comes first on PATH: compare the paths and update or remove the one that is used (update_framework how=...), never the same command again.',
  '4. Follow every terminal with wait_for_terminal until finished=true. When it reports question=true, read the output and answer with answer_prompt (usually enter for the default, or y). Keep waiting and answering until it finishes. When it fails (exit code not 0), read the output, fix the cause (usually a missing dependency or PATH) and retry once.',
  '5. Keys, tokens and passwords do not need the user at a terminal: when one is asked for (password=true), type one the user gave with answer_prompt answer=secret secret=S1, or first ask for it with request_secret (for sudo or SSH passwords too, unless the user prefers to type those there). Keys an agent reads from its config go there with store_secret. Only a browser sign-in needs the user: say exactly what to do and where, then continue.',
  '6. Before any sign-in, run_diagnostic logins on the same target: it shows what the user is already signed in to (ChatGPT through Codex, Claude Code, API keys by name, Hermes and OpenClaw providers), never the secrets. Reuse it: for OpenClaw prefer setup_agent use_claude_login or use_codex_login (no wizard); in a wizard pick that provider.',
  '7. Finish the onboarding yourself with setup_agent: sign_in runs the agent\'s own wizard (hermes setup, openclaw onboard, codex login, claude, opencode auth login); model runs hermes model (provider and model only). Drive menus with wait_for_terminal and answer_prompt choose with the option text: Opaya reads the screen and presses the arrow key exactly as many times as needed, so never step through a menu with down one press at a time. When the wizard asks for an API key or token, answer_prompt answer=secret types one the user gave (request_secret first); the user only finishes browser sign-ins. Hermes and OpenClaw also need their gateway API: setup_agent enable_api, then start_gateway (for Hermes, ACP works without it).',
  '8. Afterwards: discover_agents on that target, save_connection for the new agent (for Hermes prefer its gateway API when it runs, otherwise ACP; for Hermes and OpenClaw gateways set import_gateway_token so the user never copies a token), connect_agent, and report the result.',
  'When an agent\'s error says its onboarding, sign-in or gateway is unfinished or down, fix it the same way: setup_agent status to see where it stands, then sign_in, enable_api or start_gateway, and reconnect.',
  'On Windows, tools installed by winget appear on PATH in terminals opened afterwards; a new install terminal picks them up. npm tools that cannot install globally go to ~/.npm-global.'
].join('\n');
// Everything in the Opaya desktop app, so the Opaya Agent can explain it and point to the right place.
const APP_GUIDE=`Opaya app guide (tell the user where things are; you cannot click for them):
- Finding things: Search at the top of every screen, or Ctrl/Cmd+K, finds agents, each agent's Manage sections and actions, places (Vault, Docker manager, Install agents...), settings, machines, chats and vault keys, and shows where each lives (for example Hermes > Keys & tools). Back at the top left (or Alt+Left, or the mouse's back button) returns to the previous screen. An agent's right-click menu mirrors its sidebar: quick actions, then one submenu per Manage section. Settings has chips for its sections and a filter. Help opens with Where is what. What's new (after an update, or from Search) lists the changes of this version. With no agents yet, Home shows three ways to start: Find agents on this computer, Install an agent, or chat with you. When an agent cannot connect, its chat offers Let the Opaya Agent fix it (hands it to you) and Try again. When the user cannot find something, tell them where it lives and that Search finds it.
- Sidebar: the Opaya Agent and Discover at the top, Home (cards for every agent, Connect all), the agents, and at the bottom, under Workspace, Playground (two agents answer the same question side by side), Machines (the fleet board), Vault, Skills & tools (the skills library and MCP servers), Settings, Help and Hide sidebar; Settings > Sidebar hides Home, Playground, Machines, Vault, Skills & tools or Help. Vault, the Skills library and MCP servers share tabs (Keys, Skills, MCP servers): the Library, shared by all agents. Selecting an agent opens a second sidebar next to the first, the agent's own: its name, status and a power button (connect or disconnect); Chat, Terminal and Overview; its recent chats with + for a new chat and Search chats (the History panel); and its Manage sections. Your own screen (the Opaya Agent) has the same kind of sidebar: Chat, Setup guide, its chats, Settings (model, iTrust, Opaya Vault) and Tools (Discover agents, Install agents, Check & fix all, Machines). Ctrl/Cmd+1 to 9 open agents in the sidebar's order (Pinned, groups, This computer, Remote); holding Ctrl/Cmd shows each agent's number. The agents' sidebar shows names or only icons as a slim strip, switched with the button at its bottom (Icons only / Show names) or Settings > Sidebar; the selected agent's row joins its own sidebar either way. The top bar shows the agent and the page on the left, then the browser and projects buttons. Agents are grouped as Pinned, custom groups, This computer and Remote; under each agent's name is the machine it runs on (or the provider's server for API connections). Right-click an agent: Open chat, New conversation, Connect or Disconnect, Manage, Chat history, then submenus Files & terminal (Browse files, Open shell, Run native CLI, Connection log), Skills & tools (Skills tools & MCP, Projects, Share with another agent, iTrust, Opaya browser), Name & look (Rename, Change icon, Group & tags, Pin, Move up or down) and Maintenance (Update, Back up to this computer, Clone for Hermes, Redeploy for clones, Uninstall), plus Connection settings and Remove connection. Drag agents to reorder or into a group. Right-click empty sidebar space for Discover, Install agents, Update all agents, Add connection, Machines, local terminal, Skills library, theme and Settings.
- Manage (the gear next to an agent in the sidebar, Manage on its workspace card, the Manage button above a chat, right-click > Manage, or Ctrl/Cmd+Shift+M): one screen with every option for an agent: where it runs, how it is installed (npm, Homebrew, uv, pipx, official installer, Hermes profile or Docker container), its version and data size, all actions, its local backups and a danger zone (Uninstall, Remove connection). Its Check & fix with Opaya Agent button sends you the agent to check and repair.
- Updates: Opaya checks every agent, CLI and tool (Node.js, Python, Git, uv, gh...) on this computer and on machines with agents once an hour; a status bar chip and a note show what to update (Updates dialog: Update, Update all here, Check now). Install agents shows installed tools with their version and Update instead of Install. When a connection fails because something is too old, Opaya updates it automatically, reconnects, then hands it to you (the Opaya Agent) and finally shows the user the error. Every other agent error (a gateway that is not installed or not running, unfinished onboarding or sign-in, a dropped connection, a failed answer) comes straight to you with what Opaya thinks the cause is: find the real cause, fix it with your tools, reconnect and verify; only what truly needs the user (an interactive sign-in, a token) goes back to them (Settings > Agents and tools).
- Update, back up, uninstall: Update runs the right updater for the installation (hermes update, claude update, npm, Docker image pull and recreate). Update all agents (Machines, or right-click the workspace) updates each installation once per machine. Back up to this computer saves the agent's data (Hermes home without the installation; ~/.claude, ~/.codex, ~/.openclaw and so on) as a .tar.gz with or without chat history and API keys, local or remote, into the backup folder. Uninstall finds how the agent was installed and removes it in a visible terminal, optionally backs up first, deletes its data and removes the connection; for a Hermes profile it deletes the profile, for a container it removes the container. Agents that share one installation (Hermes profiles) are named before anything is removed.
- Chat: Markdown replies with tables, code blocks (Copy, Preview for HTML and SVG) and images; / in the message box lists commands and skills; Models sets the default model or one for this chat; Stop cancels only the current answer; the chat picker switches conversations (project chats show [project] first).
- Chat history (clock button next to a chat, Ctrl/Cmd+Shift+H, or right-click an agent > Chat history): right panel with All, Chats, Projects and Playground tabs, search and one or all agents. Per chat: Condense (keeps the essence: goal, key points, decisions, open items; uses tokens, with your model API key when set, otherwise the chat's agent), Share (copy Markdown, copy essence, save .md, send to another agent), Rename, Delete (deletes the chat and its transcript in Opaya, not the agent's own sessions).
- Remote agents on local projects: Projects > a project on this computer > Let an agent on a machine work on it (or right-click > Work on it from a machine). The agent gets its own copy in ~/opaya-projects/<name> on the machine: Git over SSH (recommended for git repos; the current branch, optionally with uncommitted changes; the agent works on branch opaya/<agent>), Through GitHub (the machine clones the repo; the agent pushes its branch; GitHub sign-in on the machine if needed), or Plain copy (non-git folders; node_modules and build output skipped). The project card then has Send (your latest changes) and Bring back (the agent's work, reviewed first: Apply to my folder as uncommitted edits, Merge commits when clean, New branch, Full diff). Nothing in the local folder changes until the user applies it; plain copies back up every file they replace.
- Projects (folder button in the top bar or Ctrl/Cmd+Shift+P): a folder on this computer or a machine plus the agents working in it; clicking an agent starts a chat in that folder. Right-click a project for git (status, pull, push, commit, stash, branches, merge, history) and GitHub CLI (create PR, list PRs, checks, open, check out, merge, sign in).
- Manage (Manage at the top of an agent's screen, a section in the agent's sidebar, or Ctrl/Cmd+Shift+M) is one page with everything about the agent: at the top (the agent with its 3D stage, status, Connect, Chat, Terminal, big quick-action buttons for Update, Clone, Back up, Settings and Machines (a disabled one says why), running clones and backups; its facts open the section about them), then its eight sections one after another, each action in exactly one: Model & skills (Q: model, reasoning, skills and commands, skills library), Keys & tools (W: API keys by name, Opaya Vault, MCP servers, Share with another agent, gateway, iTrust and Opaya browser switches, and dragging vault keys onto agents), Machine & Docker (E: where it runs, system, files, its CLI and shell, installed tools, its container, Restart container, Container logs and the Docker panel), Deploy & clone (R: Clone, Dockerize, Redeploy, New VPS, and targets to drag the agent onto), Projects (A: projects with git), Updates & backups (S: Update, how it is installed, Back up, saved backups, backups folder, Check & fix, Connection log), Profile & connection (D: name, icon, group and tags, pin, order, Reconnect, Clear error, Connection settings, Allow chat again, launch command, agent ID) and Danger zone (F: Uninstall, Remove connection). Each section is a set of cards with rows: a setting, its value, one action. The agent's sidebar is the page's table of contents: clicking a section (or pressing its letter on Manage) scrolls there, and the section in view is marked in the sidebar and the top bar as the user scrolls; Esc goes back to the top. Chat and Terminal in the agent's sidebar unfold their own actions (Chat: Open in a window, Export this chat; Terminal: its windows, New CLI window, New shell window, Files).
- Chat, Terminal and Manage: the top bar of every agent's screen has three buttons, Chat (talk to it), Terminal (its own CLI and a shell) and Manage (settings and maintenance); the one in use is highlighted, in Manage the open section shows next to it, and Opaya remembers the last one per agent. Chat in Opaya and the agent's CLI in Terminal can be separate conversations: switching does not move messages. Selecting an agent opens its chat; its chats are listed in the agent's sidebar (History opens on the right from Search chats); Terminal opens the agent's terminal windows next to or below the chat unless Settings > Chat and Terminal says full screen; the Manage button opens its management screen (a 3D view of what it is connected to, quick actions, Deploy & clone targets where dragging the agent card onto a machine or Docker clones it there, its Docker containers with live CPU and memory, pause, logs, shell, inspect and image pulls, Keys & access where dragging a vault key onto an agent gives it that key, its projects with pull and push, its chats, and every maintenance action). Chat always opens the full chat view. Another agent's chat can open as a chat window, a column beside the page that covers nothing (right-click the agent > Open chat window); minimizing it puts it in the status bar's tray, and leaving a chat while its agent still works puts that chat there too: the tray shows a spinner while it works and its new replies, which also show as a badge on the agent in the sidebar. Terminal (Settings > Chat and Terminal: next to the chat, or full screen) shows the agent's terminal windows. API connections have no CLI, so their Terminal is a shell. Agents whose vendor refuses other apps switch to their Terminal by themselves; right-click > Allow chat again undoes it.
- Terminal (Ctrl+\`): every session is a window, there are no tabs. Windows belong to the screen they were opened from (an agent, or Home and the other screens) and are arranged side by side, stacked or in a grid (the three buttons at the left of the terminal toolbar; drag the gaps to resize); the panel sits below the chat or beside it (move button). Each window's title bar: split (a new terminal right, below, left or above it), maximize, hide (keeps running), open in a separate window, end session; Ctrl/Cmd+Shift+Arrow moves between windows and the split layout is kept per agent; hidden windows come back from the toolbar's hidden button, the agent's Terminal sub-menu (which lists its windows) or right-click > Windows, which can also bring a window here from another screen. Toolbar: + New (the agent's CLI, its shell, this computer, a machine) and ... (Find, Rename, Open in separate window, Hide, Windows, Saved output of finished sessions, Close ended windows, Text size, End session). Right-click a terminal: Copy (keeps the selection), Paste, Select all, Find, Clear, Ask <agent> about this (puts the selection in the agent's chat box as a quote), New window, Windows, Rename, Open in separate window, Hide, End session; shell code blocks in chat replies have Run, which pastes the command into the agent's shell window without running it; Shift+drag (Option+drag on macOS) selects inside full-screen programs. Ctrl/Cmd +/- changes the text size; dropping files types their paths. Sessions keep running when Opaya closes; remote terminals use tmux. Terminal and browser dock at the bottom or on the right and resize; the layout is remembered.
- Opaya browser (globe button): links open inside Opaya. Every agent that can use it has it by default (Hermes and other ACP agents on this computer, on a machine or in Docker; Claude Code and Codex on this computer); only the user turns it off for an agent (right-click > Opaya browser, or its Keys & tools). Each agent has its own browser tab and its own cookies, never shared with another agent or with the user's tab; the browser pane shows the tab of the screen that is open (the owner is named in its toolbar). Its tools: browser_open, browser_read, browser_screenshot, browser_click, browser_type, browser_scroll, browser_back and browser_close (closes the tab and forgets its page; logins stay). The user's close button (X) does the same for the tab on screen. Hermes and other ACP agents on a machine or in a container reach it through a relay Opaya starts where they run (python3 or node, on 127.0.0.1 with a one-time token, over Opaya's own SSH or docker exec channel, so no port is opened). Codex's approval for Opaya's own MCP tools is answered automatically. Every model can use it: pages come back as text with links and form fields; models that can see images also get screenshots. Cookies (the cookie button in the browser toolbar) imports cookies from Chrome or Edge profiles on this computer, or from a cookies.txt or JSON export (Cookie-Editor), into the user's tab or chosen agents' tabs, optionally only for some domains; cookies Chrome and Edge 127+ lock to themselves (app-bound, v20) cannot be read: export those with a cookie extension. The Opaya window must be open. Page dialogs are answered automatically and every browser action returns within 45 seconds.
- Files from agents: when an agent's reply names a file by its full path (/home/... , ~/..., C:\...) that exists where the agent runs, the chat shows it as a card with Open, Save... and Show in folder (images get a preview), on this computer, a machine or in a container (up to 25 MB). Tell agents to give the full path of a file they made.
- Schedules (Schedules in the sidebar, an agent's Updates & backups, or Search): Opaya sends a message to an agent or the Opaya Agent on a schedule (every N minutes, hourly, daily, weekdays, a weekday, monthly or a cron expression in this computer's time) while its session service runs; each schedule has its own chat (Schedule: name), Run now, pause and delete. The same screen lists agents' own schedules (Hermes cron jobs, OpenClaw cron, the crontab where they run).
- Terminals opened for a screen stay on it: a terminal the Opaya Agent opens (setup, sign-in, uninstall) is on the Opaya Agent's screen, an agent's on that agent's screen, and Opaya says where a new one opened instead of moving you there. Questions and confirmations (end session, delete, update, exit) are Opaya's own dialogs.
- Skills, tools & MCP (Skills button or right-click): lists skills and commands, installs Hermes skills, MCP servers per agent. Settings > MCP servers adds well-known servers with one click (Files, Fetch, Memory, Playwright, GitHub, Context7, Brave Search, Git, Time; a key they need goes into a masked field and the vault) and turns the Opaya browser on per agent, or adds any stdio or HTTP server by hand. ACP agents (Hermes, OpenCode) get them per session, Claude Code on this computer per message; for Claude Code on a machine or in a container, Codex and OpenClaw Opaya writes them into the agent's own config after the user approves. Share with another agent (right-click, or Keys & tools) copies all or selected skills, API keys by name between any agents (Hermes/OpenClaw .env, Claude Code settings.json env, codex login, OpenCode auth.json, an API connection's token; values never shown), MCP servers and the gateway token, and runs in the progress window. Skills library (Settings, sidebar right-click or Skills panel) keeps global skills: add from an agent or a folder, install to many agents, remove.
- Clone (right-click > Clone; Hermes and the CLI agents): copy Everything, Skills + personality, Skills or Memory (optionally API keys) to this computer or a VPS, as a Hermes profile or regular install, a new Docker container, or a profile in a container Opaya already runs (Hermes as a profile in a Hermes container, OpenClaw as another agent of the same gateway, Claude Code / Codex / OpenCode with their own home folder in an Opaya Node.js container); progress window with speed and time left, minimizable to the status bar. Redeploy copies the same parts again.
- Machines: a card per machine (This computer plus SSH machines) with its agents; click a card for its panel underneath: system, memory, disk and address, Terminal, Files, Install agents, Edit or Rename, installed tools with Check versions, and its Docker with every container as a card. The header has + New VPS, Add existing, Install agents and a More menu (Test all machines, Update all agents). This computer can be renamed in Opaya, with a note and the backup folder. Add a new VPS creates an SSH key in ~/.ssh, shows the public key to add at the provider (or installs it with the password), tests the connection and checks Docker and Hermes. Discover finds agents per machine; installed ones are hidden, missing ones have Install buttons. Install agents installs agents and dependencies on this computer or a machine. On a machine, Install agents asks whether to install an agent regularly or as a Docker container (Hermes and OpenClaw from their official images, OpenClaw with its gateway on the machine's 127.0.0.1 reached through SSH; Claude Code, Codex and OpenCode in a Node.js container, data in ~/opaya-agents/<name>); the Docker install signs in and adds the agent by itself. Your install_framework does the regular install; for a container, send the user to Install agents > the machine > the agent > Docker container. Docker itself is installable as a dependency (id docker).
- iTrust: Settings > iTrust mode for all agents or the Opaya Agent, or right-click an agent: its tool requests are approved automatically. For you, removals still ask.
- Settings (sidebar, or Search): a page per topic on the left (Appearance: theme and sidebar; Chat & Terminal; Notifications & startup; Agents: the Opaya Agent's model, update checks, automatic fixes, iTrust; Keys & skills; Machines & data; Shortcuts; Updates & about) and a filter that searches every page. Dialogs close with Esc, the x, or a click on the dimmed page around them (not once something was typed in them). Updates: Opaya checks GitHub releases, downloads with checksum verification and installs in place (Update in the status bar, then Install and restart).
- Connection log (right-click an agent): protocol messages, stderr, running tools, pending approvals and Hermes log tail; your agent_diagnostics tool reads the same.
- Your chats: New chat and earlier chats at the top of your panel; Model settings chooses your model and API key.
- Secrets: keys pasted into your chat and those typed in Opaya's secure prompt stay in Opaya's encrypted vault; you only see references such as [secret S1 · NAME · mask]. A key given with "Give to every agent" is written into every agent that reads keys; API connections keep their own token.
- Opaya Vault (Vault in the sidebar, Settings, Machines, the key button next to your message box, or the key button in any agent's chat): every key the user keeps in Opaya, encrypted, each with the agents that have it. + Add key (name and key; tick "This API needs an endpoint" to add a base URL, saved as NAME_BASE_URL; then keep it, give it to chosen agents or to every agent). Import finds keys in a file (a .env, JSON, YAML or any text file; a file can also be dropped on the Vault), in pasted text, or in the tools on this computer (the agents' own key files, shell profiles, Opaya's environment, GitHub CLI, npm, AWS, Hugging Face); the user ticks which to keep and can rename them, and keys already in the Vault are marked. Only the user can import (you cannot). Back up & restore saves every kept key to one file encrypted with a password the user chooses, and restores such a file here or on a new computer; the Vault shows Not backed up when keys were added after the last backup. Only the user can back up or restore. Agents on this computer can ask for a key from their chat (opaya-vault; the user approves each one), a switch under the keys. Give to on a key opens the agents (those with it show Has it) and Every agent; the x forgets it. The key button next to your message box opens the Vault with Insert, which puts a key's reference into the message to you. Keys pasted as text into your chat are temporary. Your vault tool does the same: list, give, give_all, forget.
- Keys in an agent's chat: the key button lists the keys that agent has (names only, read from the file it reads keys from), Insert puts $NAME into the message, Give hands it a vault key, New key gives it one only it gets. Codex and ACP agents restart when idle so a new key is in their environment; Claude Code has it from its next message. Local Claude Code, Codex and ACP agents also have vault_list and vault_use to ask for a key themselves.
- DeepSeek Harness (dsh, developer preview): installed with npm (@deepseek-ai/dsh, Node.js 22.19+) on this computer, a machine or in a Docker container; Opaya chats with it over ACP (dsh --profile acp) and its Web UI button (above its chat) starts dsh web where it runs and opens it in the Opaya browser (through an SSH tunnel for a machine). Keys: it looks in the environment it was started with first, then ~/.dsh/.credentials.yaml (its Web UI saves there), then .env in its working folder, then ~/.dsh/.env. Opaya writes a key given to it into both ~/.dsh/.credentials.yaml and ~/.dsh/.env, and starts dsh on this computer without a same-named variable from the environment, so Opaya's key wins. "Authentication Fails ... api key is invalid" means the key it found is wrong: ask the user for the right DEEPSEEK_API_KEY (request_secret, or vault op=give) and store_secret it; its account at platform.deepseek.com needs balance too. Other providers and models are set in its Web UI. It has no terminal chat yet (profiles: acp, web, headless), so its CLI button opens a shell where dsh headless "task" runs one task. Its data is ~/.dsh.
- Docker manager (Docker on a machine card in Machines, or Open manager in an agent's Machine & Docker): a tab per machine, search, All / Running / Stopped and Live CPU and memory; a card per container with its state, ports (a local port opens in the browser), the agents in it and buttons for Start or Stop, Restart, Pause or Resume, Logs (its last 200 lines inside the card, Follow in a terminal), Shell, Details and Remove; Images lists size and which containers use each, with Pull, Remove and Prune. Your docker tool does the same on any machine. Discover also finds OpenClaw gateways running in Docker (the published port of 18789) on this computer and machines.
- Doing it yourself: for backup, uninstall, update, clone, transfer, MCP servers, Docker and keys you have tools (backup_agent, uninstall_agent, update_agent, clone_agent, transfer, mcp_server, docker, vault) and jobs to follow a running job. Use them instead of telling the user where to click, unless the user wants to do it. When something the user started fails (a job, a Docker action, giving a key, an install), Opaya hands it to you: find the cause and finish it.`;
const fn=(name,description,properties={},required=[])=>({type:'function',function:{name,description,parameters:{type:'object',properties,required,additionalProperties:false}}});
const TOOLS=[
  fn('get_workspace','Read all saved agent connections (with live status and last error), SSH machines and open terminals. Start here.'),
  fn('list_frameworks','List everything that can be installed: agent frameworks (kind agent), dependencies such as Node.js, Python, Git, uv, tmux, OpenSSH and Homebrew (kind dependency), and the essentials bundle that installs whatever of Node.js, Python, Git, uv and tmux is missing (kind bundle).'),
  fn('discover_agents','Read-only scan for installed agents on this computer, or on a saved SSH machine. Returns candidates; it does not add them.',{machine_id:{type:'string',description:'Saved machine id; omit for this computer.'}}),
  fn('connect_agent','Connect (or reconnect) a saved agent and report its status or error.',{agent_id:{type:'string'}},['agent_id']),
  fn('disconnect_agent','Disconnect a saved agent.',{agent_id:{type:'string'}},['agent_id']),
  fn('clear_agent_error','Clear a stale connection error on a saved agent.',{agent_id:{type:'string'}},['agent_id']),
  fn('read_terminal','Read a terminal: its recent output, the screen as the user sees it, and the menu on it (question, options, highlighted) when there is one.',{terminal_id:{type:'string'},max_chars:{type:'integer'}},['terminal_id']),
  fn('read_app_logs','Read Opaya startup diagnostics and every agent connection error.'),
  fn('agent_diagnostics','Read-only: why an agent is slow or not answering. Returns its status, how long the current answer has run and since the last update, the tools it is running, a pending approval, the last protocol messages between Opaya and the agent, its stderr and, for Hermes, the end of its own log files.',{agent_id:{type:'string'}},['agent_id']),
  fn('run_diagnostic','Run a fixed read-only check in a visible terminal and return its output.',{check:{type:'string',enum:Object.keys(DIAGNOSTICS)},machine_id:{type:'string',description:'Saved machine id; omit for this computer.'}},['check']),
  fn('save_connection','Add or update an agent connection. The user approves it first. Never include API tokens: save one the user gave with store_secret into=connection_token, or import a Hermes or OpenClaw gateway token with import_gateway_token.',{connection:{type:'object',description:'Fields: id (to update), name, provider (hermes|codex|claude|openclaw|custom), protocol (openai|acp|codex|claude|terminal), transport (http|local|ssh), hostId, endpoint, model, command, args, cwd, hermesHome, displayName, description, note, group (sidebar group name), tags (array of labels). OpenCode: provider custom, protocol acp, command opencode, args ["acp"]. Codex CLI: provider codex, protocol codex, command codex. Prefer discover_agents, which fills these in.'},import_gateway_token:{type:'boolean',description:'Hermes (with hermesHome) or OpenClaw over its gateway API: Opaya reads the gateway token from the agent\'s own config into its vault after the user approves. You never see the token. Use it after setup_agent enable_api or onboarding.'}},['connection']),
  fn('setup_agent','Finish an installed agent\'s setup in a visible terminal, on this computer, a saved machine or inside the agent\'s Docker container. The user approves the exact command first. Steps: sign_in runs the vendor\'s onboarding wizard (hermes setup, openclaw onboard --install-daemon, codex login, claude, opencode auth login, goose configure): follow it with wait_for_terminal and pick its menu options with answer_prompt choose; type API keys and passwords the user gave with answer_prompt answer=secret (request_secret first); the user only finishes browser sign-ins. model runs hermes model (provider and model only). OpenClaw use_claude_login / use_codex_login set it up with the Claude Code or ChatGPT (Codex) login already on that machine, without a wizard. enable_api turns on the OpenAI-compatible gateway API Opaya chats through (Hermes: API_SERVER_ENABLED with a new random API_SERVER_KEY in its .env; OpenClaw: gateway.http.endpoints.chatCompletions). start_gateway starts the Hermes or OpenClaw gateway in the background. status is a read-only check.',{framework_id:{type:'string',enum:Object.keys(catalog.SETUP)},step:{type:'string',enum:catalog.SETUP_STEPS},agent_id:{type:'string',description:'A saved agent: runs where it runs (its machine, Hermes profile or Docker container).'},machine_id:{type:'string',description:'Saved machine id when there is no saved agent yet; omit both for this computer.'}},['framework_id','step']),
  fn('remove_connection','Remove a saved agent connection and its local chats. The user approves it first.',{agent_id:{type:'string'}},['agent_id']),
  fn('save_machine','Add or update a saved SSH machine. The user approves it first.',{machine:{type:'object',description:'Fields: id (to update), name, alias, hostname, username, port, identityFile.'}},['machine']),
  fn('remove_machine','Remove a saved SSH machine that no agent uses. The user approves it first.',{machine_id:{type:'string'}},['machine_id']),
  fn('install_framework','Install an agent framework, a dependency or the essentials bundle in a visible terminal, on this computer or a saved machine. The user approves the exact command first. Dependency commands skip what is already installed.',{framework_id:{type:'string',description:'An id from list_frameworks, for example codex, node, python or essentials.'},machine_id:{type:'string',description:'Saved machine id; omit for this computer.'}},['framework_id']),
  fn('update_framework','Update an installed agent framework or dependency (or every essential) to its latest version, in a visible terminal, on this computer or a saved machine. The user approves the exact command first. By default the script finds how the tool is installed (Homebrew formula or cask, npm with the Node.js that owns it, npx, pnpm, bun, yarn, volta, the vendor\'s own updater, uv, pipx, winget, scoop, choco, the system package manager) and updates that copy; its output starts with the method and path it found. Check versions first with run_diagnostic versions, which shows how each tool is installed.',{framework_id:{type:'string',description:'An id from list_frameworks, for example hermes, claude, codex, node or essentials.'},machine_id:{type:'string',description:'Saved machine id; omit for this computer.'},how:{type:'string',enum:['auto','npm','npx','bun','pnpm','yarn','volta','self','cask','brew','system','nvm','fnm','mise','uv','pipx','pip','winget','scoop','choco'],description:'Force one install method instead of detecting it (auto, the default). Use it only when detection picked the wrong copy, for example npm when a Homebrew cask is first on PATH. self runs the vendor\'s own updater or installer.'}},['framework_id']),
  fn('wait_for_terminal','Wait for an install, update, setup or command you started to finish (up to 180 seconds). Returns finished=true with the exit code when it ended; question=true when the program waits for an answer, with the screen and, for a select menu, menu (question, options, highlighted) so you can answer_prompt choose by text; password=true when it asks for a password, API key or token (type one the user gave with answer_prompt answer=secret).',{terminal_id:{type:'string'},seconds:{type:'integer',description:'Maximum seconds to wait, 5 to 180. Default 90.'}},['terminal_id']),
  fn('run_command','Run any command in a visible terminal on this computer or a saved machine, for what your other tools do not cover (for example finishing an onboarding, fixing a PATH or a config). The user sees it in a terminal (and approves it first when iTrust is off). Follow it with wait_for_terminal and answer_prompt. Prefer the specific tools when one fits. Never put API keys, passwords or tokens in a command (a [secret S1 ...] reference is refused): save them with store_secret, or start the program and type them into its prompt with answer_prompt answer=secret.',{command:{type:'string',description:'The shell command (sh on macOS, Linux and machines; PowerShell on Windows).'},why:{type:'string',description:'One sentence the user sees in the approval: what it does and why.'},machine_id:{type:'string',description:'Saved machine id; omit for this computer.'}},['command','why']),
  fn('open_app','Open a website in the default browser, or start an app on this computer by name (for example System Settings, Docker, Terminal), for example to show the user a sign-in page.',{target:{type:'string',description:'An https:// link or an app name.'},why:{type:'string'}},['target','why']),
  fn('answer_prompt','Answer a question in a terminal you started (install_framework, update_framework, setup_agent, run_command, run_diagnostic, install_skill). Menus (wait_for_terminal returns menu with its options): answer=choose with option=<the option text>; Opaya reads the screen, presses the arrow key exactly as many times as needed, checks the highlighted option and presses Enter (space in a checklist), and searches or opens "More..." when the option is further down. Never step through a menu with down one press at a time. Other answers: Enter for the default, y/n, yes/no, a number, up/down (with times), space, tab, esc, q or Ctrl+C; answer=text with text (typed, then Enter) for names, folders or model ids. Passwords, API keys and tokens: answer=secret with secret=<id> (for example S1) types a secret the user gave, then Enter, and only into a prompt that asks for one; never type such a value as text. Pick the safe default unless the user said otherwise.',{terminal_id:{type:'string'},answer:{type:'string',enum:['choose','enter','y','n','yes','no','1','2','3','4','5','6','7','8','9','up','down','space','tab','esc','q','ctrl_c','text','secret']},option:{type:'string',description:'Only with answer=choose: the menu option to pick, as shown (or a distinctive part of it, e.g. "OpenAI" or "Use existing credentials").'},text:{type:'string',description:'Only with answer=text: what to type (one line, no secrets).'},secret:{type:'string',description:'Only with answer=secret: the id of a secret the user gave, for example S1.'},times:{type:'integer',description:'Only with up or down: how many presses (1 to 60).'}},['terminal_id','answer']),
  fn('request_secret','Ask the user for an API key, token or password in Opaya\'s secure prompt (a password field in a dialog). The value goes into Opaya\'s encrypted vault and you get only a reference such as [secret S1 · OPENROUTER_API_KEY · sk-o…9f3a]; then store_secret puts it where an agent reads it, or answer_prompt answer=secret types it into a terminal prompt. given=false when the user cancels: do not ask for it in the chat then.',{name:{type:'string',description:'The variable it is for, for example OPENROUTER_API_KEY, TELEGRAM_BOT_TOKEN or SUDO_PASSWORD.'},why:{type:'string',description:'One or two sentences the user sees: what it is for and where to get it.'},agent_id:{type:'string',description:'The saved agent it is for, shown to the user. Omit for a terminal prompt or your own model key.'}},['name','why']),
  fn('store_secret','Save a secret the user gave (by its id from a [secret S1 · ...] reference) where an agent reads it, without you ever seeing it. Hermes: NAME=value in the .env of its Hermes home. OpenClaw: ~/.openclaw/.env (in its Docker container /home/node/.openclaw/.env). Claude Code: env in ~/.claude/settings.json. Codex: codex login --with-api-key for OpenAI API keys, any other key in its .env (CODEX_HOME/.env). Opaya restarts Codex and ACP agents (Hermes over ACP) when they are idle, so the key is in their environment at once; Claude Code has it from its next message. API connections: the token Opaya sends to its endpoint (into=connection_token, the default for plain API connections). agent_id opaya: your own model API key. Works on this computer, SSH machines and in containers; the value never goes through a command line or a log. The user approves it first unless iTrust is on. The result says whether the agent must reconnect or its gateway restart.',{secret:{type:'string',description:'The secret id, for example S1.'},agent_id:{type:'string',description:'The saved agent, or opaya for the Opaya Agent itself.'},name:{type:'string',description:'The variable name to save it as, for example OPENROUTER_API_KEY. Default: the name in its reference.'},into:{type:'string',enum:['agent_config','connection_token'],description:'agent_config: the agent\'s own .env, settings or login (default for Hermes, OpenClaw, Claude Code and Codex). connection_token: the token Opaya sends to a connection over an HTTP API, such as a gateway API key.'}},['secret','agent_id']),
  fn('ssh_key','Create an ed25519 SSH key on this computer, or install a public key on a saved machine, in a visible terminal. The user approves it first. A passphrase or SSH password: the user types it there, or you type one they gave with answer_prompt answer=secret.',{action:{type:'string',enum:['generate','install']},key_name:{type:'string',description:'File name in ~/.ssh, letters, numbers, _ and -.'},machine_id:{type:'string'}},['action','key_name']),
  fn('list_directory','Read-only: list a folder on this computer or a saved machine (default: home folder).',{path:{type:'string'},machine_id:{type:'string'}}),
  fn('read_file','Read-only: read up to 256 KB of a text file on this computer or a saved machine. Secret files such as .env, keys and tokens are refused.',{path:{type:'string'},machine_id:{type:'string'}},['path']),
  fn('project_info','Read-only: project markers, git branch, uncommitted changes and recent commits for a folder.',{path:{type:'string'},machine_id:{type:'string'}},['path']),
  fn('list_skills','Read-only: the skills installed for an agent (folders with a SKILL.md) and where they live. Users run a skill with /name in the chat.',{agent_id:{type:'string'}},['agent_id']),
  fn('install_skill','Install a skill for a Hermes agent (`hermes skills install`: hub ids such as official/security/1password or skills-sh/owner/repo/skill, or an https link to a SKILL.md) or an OpenClaw agent (`openclaw skills install`: ClawHub @owner/skill, skills-sh:owner/repo/skill or git:owner/repo), in a visible terminal. The user approves it first (unless iTrust is on).',{agent_id:{type:'string'},skill:{type:'string'}},['agent_id','skill']),
  fn('list_projects','Read-only: saved projects (a folder on this computer or a machine, and the agents that work in it). Use project_info with the folder for git state. The user runs git actions from the Projects panel.'),
  fn('list_mcp_servers','Read-only: MCP servers saved in Opaya and which agents use them. Values of environment variables and headers are never shown. The user adds or edits servers in Settings > MCP servers.'),
  fn('read_notes','Read your notes file in your home folder.'),
  fn('vault','The Opaya Vault: every API key, token and password the user keeps in Opaya. list: names, masked hints, endpoints and which agents have each (never values). give: write one key where an agent reads keys (its .env, Claude Code settings.json env, Codex login or .env) and tell the agent in its chat. give_all: make a key global, written to every agent that reads keys. forget: remove it from the vault (agents keep their copy). The user approves give, give_all and forget unless iTrust is on.',{op:{type:'string',enum:['list','give','give_all','forget']},key:{type:'string',description:'The key name (OPENROUTER_API_KEY) or its id (S3) from list.'},agent_id:{type:'string',description:'For give: the agent that gets it.'}},['op']),
  fn('docker','Docker on this computer or a saved machine, like the Docker manager in the Machines view. list: containers (state, image, ports) and images. start, stop, restart, remove (a container), remove_image. logs: the last lines a container printed. open_shell: a visible terminal with a shell inside the container. The user approves every change; removals always ask.',{op:{type:'string',enum:['list','start','stop','restart','remove','remove_image','logs','open_shell']},machine_id:{type:'string',description:'Saved machine id; omit for this computer.'},container:{type:'string',description:'Container name (or the image for remove_image).'},lines:{type:'number',description:'logs: how many lines (10 to 1000, default 150).'}},['op']),
  fn('backup_agent','Back up a saved agent\'s data (Hermes home without the installation; ~/.claude, ~/.codex, ~/.openclaw and so on) as a .tar.gz into Opaya\'s backup folder on this computer. Runs as a job: follow it with jobs.',{agent_id:{type:'string'},api_keys:{type:'boolean',description:'Include API keys (default true).'},history:{type:'boolean',description:'Include chat history (default true).'}},['agent_id']),
  fn('uninstall_agent','Uninstall a saved agent the way it was installed, in a visible terminal (a Hermes profile deletes only the profile; a container removes the container). The user always approves it. Optionally back up first and remove the connection from Opaya. Runs as a job: follow it with jobs.',{agent_id:{type:'string'},delete_data:{type:'boolean',description:'Also delete its data folder.'},backup:{type:'boolean',description:'Back up first (default true); if the backup fails nothing is uninstalled.'},remove_connection:{type:'boolean',description:'Remove the connection and its chats from Opaya afterwards.'}},['agent_id']),
  fn('update_agent','Update a saved agent with the updater that fits how it was installed (hermes update, claude update, npm, Homebrew, Docker image pull and recreate), in the machine\'s Updates terminal; failures come back to you. all=true updates every installation once per machine. The user approves it.',{agent_id:{type:'string'},all:{type:'boolean'}}),
  fn('clone_agent','Clone a saved agent (Hermes and the CLI agents) to this computer or a machine: everything, skills + personality, skills or memory, with or without API keys. runtime regular (an install), profile (a Hermes profile, or a profile inside an existing container with container), or docker (a new container). The clone is added to Opaya and connected. Runs as a job: follow it with jobs. The user approves it.',{agent_id:{type:'string'},name:{type:'string',description:'Name of the clone (default: <name>-clone).'},machine_id:{type:'string',description:'Target machine; omit for this computer.'},runtime:{type:'string',enum:['regular','profile','docker']},container:{type:'string',description:'runtime profile: an existing container to add the profile to.'},what:{type:'string',enum:['everything','personality','skills','memory']},api_keys:{type:'boolean'},cron:{type:'boolean',description:'Copy cron jobs (default: only with everything).'}},['agent_id']),
  fn('transfer','Copy from one saved agent to another: skills (all or named), API keys by name (all or named; values never shown), Opaya MCP servers by id, or the Opaya API token of a connection. Runs as a job: follow it with jobs. The user approves it.',{from_agent_id:{type:'string'},to_agent_id:{type:'string'},skills:{description:'"all" or a list of skill names.'},api_keys:{description:'"all" or a list of key names.'},mcp_server_ids:{type:'array',items:{type:'string'}},api_token:{type:'boolean'}},['from_agent_id','to_agent_id']),
  fn('mcp_server','MCP servers Opaya gives agents. catalog: the one-click servers (Files, Fetch, Memory, Playwright, GitHub, Context7, Brave Search, Git, Time) and what each needs. install: add one from the catalog (a key it needs by its secret id, request_secret first; a folder for Files) for all agents or chosen ones. enable / disable: turn a saved server (list_mcp_servers) on or off for one agent. remove: delete a saved server. The user approves changes.',{op:{type:'string',enum:['catalog','install','enable','disable','remove']},server:{type:'string',description:'Catalog id for install; saved server id for enable, disable, remove.'},secret:{type:'string',description:'install: the secret id (S1) of the key the server needs.'},folder:{type:'string',description:'install Files: the folder it may use.'},agents:{description:'install: "all" or a list of agent ids.'},agent_id:{type:'string',description:'enable / disable: the agent.'}},['op']),
  fn('jobs','Background jobs in Opaya (clone, redeploy, backup, uninstall, transfer, skills library, free model setup): status, steps, error and the last log lines. Use it to follow a job you started or to see why one the user started failed.',{job_id:{type:'string',description:'One job; omit for all.'}}),
  fn('write_notes','Replace your notes file in your home folder (max 20000 characters). Use it to remember setup decisions.',{content:{type:'string'}},['content'])
];
// Chat models that can use tools first; embeddings, audio, image and moderation models last.
const rankModels=list=>[...list].sort((a,b)=>score(b)-score(a));
function score(id){const s=String(id).toLowerCase();if(/embed|whisper|tts|audio|realtime|transcri|image|dall-e|moderation|search|babbage|davinci|guard|rerank|vision-preview/.test(s))return -10;return (/gpt-5|gpt-4\.1|claude|gemini-2|deepseek-(chat|v)|qwen3|llama-3\.3|kimi|grok|mistral-(large|medium)/.test(s)?5:0)+(/mini|flash|small|lite|nano|8b|haiku/.test(s)?1:0);}
const endpointName=name=>`${String(name).replace(/_(API_KEY|APIKEY|KEY|TOKEN|SECRET)$/,'')||'API'}_BASE_URL`;
// What an agent's model is told after Opaya saved a key for it: the variable, where it is, never the value.
function keyNote(r,name){
  const n=r.name||name,env=r.loaded==='now'||r.loaded==='turn'?` It is already in your environment as $${n}, and the commands you run get it too.${r.endpointName?` So is $${r.endpointName}.`:''}`:r.loaded==='after'?` From your next message it is in your environment as $${n} (Opaya restarts you after this answer); until then read it from that file.`:' Processes started from now on have it; if you are already running, read it from that file when you need it.';
  if(r.file)return `[Opaya] I added a new environment variable for you: ${n} is now set in ${r.file} ${r.where}.${r.endpointName?` Its API endpoint is in ${r.endpointName} (${r.endpoint}) in the same file.`:''} The value is not in this chat.${env} Never print it or write it anywhere else. Use it for what I ask next.`;
  if(/login/i.test(r.where||''))return `[Opaya] I signed you in with a new ${name}: it is saved in ${r.where}. The value is not in this chat. ${r.loaded==='now'?'Opaya restarted you, so it is in use now.':'It is used from your next start.'}`;
  return `[Opaya] A new ${name} is saved as the token Opaya sends to your API from the next connection. The value is not in this chat.`;
}
// Where an agent reads keys from: its .env (Hermes, OpenClaw, DeepSeek Harness), Claude Code's settings.json env, or Codex.
const keyKindOf=a=>a.provider==='hermes'?'hermes':a.provider==='openclaw'?'openclaw':a.provider==='claude'||a.protocol==='claude'?'claude':a.provider==='codex'||a.protocol==='codex'?'codex':require('./maintenance.cjs').frameworkOf(a)==='dsh'?'dsh':'';
const loadedText=(loaded,reconnect)=>({now:'Opaya restarted it, so the key is in its environment now.',after:'Opaya restarts it when its current answer finishes, so the key is in its environment from its next message.',turn:'It has the key from its next message.'})[loaded]||reconnect;
const jobOf=j=>j&&typeof j==='object'&&j.steps?{job_id:j.id,kind:j.kind,title:j.title,status:j.status,error:j.error||undefined,steps:j.steps.map(x=>`${x.label}: ${x.state}`),log:(j.log||[]).slice(-8).map(l=>l.text),result:j.result||undefined}:j;
const stripAnsi=text=>String(text||'').replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)/g,'').replace(/\r/g,'');

class OpayaAgent{
  // askSecret({name,why,agent}): Opaya's secure prompt, resolves to the value or null. userHome: where agents on this
  // computer keep their config (tests use a temporary one).
  constructor({root,vault,broker,terminals,approve,emit,runInTerminal,builtinInstall=null,platform=process.platform,fetchImpl=globalThis.fetch,spawnAgent=launch,trusted=()=>false,askSecret=null,userHome=''}){
    Object.assign(this,{builtinInstall,home:path.join(root,'opaya-agent'),root,vault,broker,terminals,approve,emit,runInTerminal,platform,fetch:fetchImpl,spawnAgent,trusted,askSecret,userHome});this.ownTerminals=new Set();this.runs=new Map();this.screens=new Map();this.secrets=[];this.secretNext=1;this.secretCache=new Map();
    this.config={preset:'',baseUrl:'',model:''};this.messages=[];this.busy=false;this.status='';this.error='';this.controller=null;this.liveReply=null;this.codexRpc=null;this.codexThreadId='';this.codexActive=null;this.claudeSessionId='';this.claudeChild=null;this.claudeActive=null;this.toolBridge=null;
  }
  async init(){
    await fs.mkdir(this.home,{recursive:true,mode:0o700});
    const config=await readJson(path.join(this.home,'config.json'),{});this.config={...this.config,...config};
    {const b=await readJson(path.join(this.home,'vault-backup.json'),null);this.lastVaultBackup=b&&typeof b.at==='string'?{file:String(b.file||''),count:Number(b.count)||0,at:b.at}:null;}
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
    await this.loadSecrets();
  }
  saveIndex(){return atomicJson(path.join(this.home,'sessions.json'),{current:this.sessionId,sessions:this.sessions});}
  // ---- Secrets the user gives: values in the vault (JSON, so private keys keep their lines), S-numbers, names and masks
  // in secrets.json. Each belongs to the chat it was given in and is forgotten with it. Memory-only values (no OS
  // encryption) are gone after a restart, and so is their entry.
  async loadSecrets(){
    const d=await readJson(path.join(this.home,'secrets.json'),{});
    this.secrets=(Array.isArray(d.secrets)?d.secrets:[]).filter(s=>/^S\d{1,6}$/.test(s?.id)&&/^opaya-secret-[\w-]{8,64}$/.test(s.key)&&this.vault?.has?.(s.key)).map(s=>({...s,stored:Array.isArray(s.stored)?s.stored:[]}));
    this.secretNext=Math.max(Number(d.next)||1,...this.secrets.map(s=>Number(s.id.slice(1))+1));await this.pruneSecrets();
  }
  // One write at a time, each with the state as it is then, so a slower earlier write never wins.
  saveSecrets(){this.secretSaving=(this.secretSaving||Promise.resolve()).catch(()=>{}).then(()=>atomicJson(path.join(this.home,'secrets.json'),{next:this.secretNext,secrets:this.secrets}));return this.secretSaving;}
  secretValue(s,quiet=false){
    if(!this.secretCache.has(s.key)){let value='';try{const raw=this.vault.get(s.key);value=raw?JSON.parse(raw):'';}catch(error){if(quiet)return '';throw error;}if(typeof value==='string'&&value)this.secretCache.set(s.key,value);}
    const value=this.secretCache.get(s.key);if(!value&&!quiet)throw new Error(`Opaya no longer holds ${s.id} (it was forgotten, or kept in memory only and Opaya restarted). Ask the user again with request_secret.`);
    return value||'';
  }
  secretEntry(id){const want=secrets.secretId(id),s=this.secrets.find(x=>x.id===want);if(!s)throw new Error(`Opaya holds no secret ${want}. Use an id from a [secret S1 · ...] reference, or ask the user with request_secret.`);return s;}
  // Held values with their references (this chat's first), for hiding them in anything tools return.
  // Whether the copy of a tool this computer runs first is the one Opaya's installer put there (then it updates it).
  opayaOwned(id){
    const s=updates.SPECS[id],bin=this.platform==='win32'?s?.win||s?.bin:s?.bin,p=bin&&findExecutable(bin,environment());if(!p)return false;
    let r=p;try{r=require('node:fs').realpathSync(p);}catch{}
    const low=f=>this.platform==='win32'?f.toLowerCase():f,root=low(path.resolve(opayaToolsRoot(this.platform))+path.sep);
    return [p,r].some(f=>low(path.resolve(f)).startsWith(root));
  }
  heldValues(){const all=this.secrets||[],mine=all.filter(s=>s.session===this.sessionId);return [...mine,...all.filter(s=>!mine.includes(s))].map(s=>({value:this.secretValue(s,true),ref:secrets.reference(s)})).filter(h=>h.value);}
  async holdSecret(value,{name='',source='chat'}={}){
    value=String(value??'');if(!value.trim())throw new Error('The secret is empty.');if(value.length>12000||value.includes('\0'))throw new Error('A secret can be up to 12000 characters.');
    const same=this.secrets.find(s=>s.session===this.sessionId&&this.secretValue(s,true)===value);if(same)return same;
    const s={id:`S${this.secretNext++}`,key:`opaya-secret-${randomUUID()}`,name:secrets.envName(name,'API_KEY'),mask:secrets.mask(value),session:this.sessionId,source,createdAt:new Date().toISOString(),stored:[]};
    // Without OS encryption the value stays in memory only, never in a file.
    await this.vault.set(s.key,JSON.stringify(value),this.vault.available());this.secretCache.set(s.key,value);this.secrets.push(s);
    while(this.secrets.length>500)await this.dropSecret(this.secrets.find(x=>!x.kept)||this.secrets[0]);
    await this.saveSecrets();return s;
  }
  async dropSecret(s){this.secrets=this.secrets.filter(x=>x!==s);this.secretCache.delete(s.key);await this.vault.remove(s.key).catch(()=>{});}
  async forgetSecret(id){const s=this.secretEntry(id);await this.dropSecret(s);await this.saveSecrets();this.emit();return true;}
  // Secrets of chats that no longer exist (deleted, or dropped after 100 chats).
  async pruneSecrets(){const ids=new Set((this.sessions||[]).map(x=>x.id)),gone=this.secrets.filter(s=>!s.kept&&!ids.has(s.session));for(const s of gone)await this.dropSecret(s);if(gone.length)await this.saveSecrets();}
  // Keys in a message go to the vault first: values held before become their reference, new ones are held (at most 50
  // per message; any beyond that are hidden).
  async holdPasted(text){
    // A value given in another chat (pasted again, or its reference inserted with the key button) is held again for this
    // one, so its reference lasts as long as this chat.
    for(const s of this.secrets.filter(x=>x.session!==this.sessionId)){
      const v=this.secretValue(s,true),ref=secrets.reference(s);if(!v||!(v.length>=8&&text.includes(v))&&!text.includes(ref))continue;
      const mine=await this.holdSecret(v,{name:s.name});text=text.split(ref).join(secrets.reference(mine));
    }
    const concealed=secrets.conceal(text,this.heldValues()),spans=secrets.detect(concealed);if(!spans.length)return concealed;
    const refs=new Map();
    for(const s of spans)if(!refs.has(s.value))refs.set(s.value,refs.size<50?secrets.reference(await this.holdSecret(s.value,{name:s.name})):`[hidden ${s.name} · ${secrets.mask(s.value)}]`);
    this.emit();return secrets.replaceSpans(concealed,spans,s=>refs.get(s.value));
  }
  // The key button next to the message box: the user gives a secret without it being part of a message.
  async holdFromUser({name,value,endpoint}={}){
    value=String(value??'').trim();if(!value)throw new Error('Paste the key, token or password.');
    endpoint=String(endpoint??'').trim();if(endpoint){let u;try{u=new URL(endpoint);}catch{u=null;}if(!u||!/^https?:$/.test(u.protocol)||u.username||u.password||endpoint.length>2048)throw new Error('The endpoint must be a full http(s) URL, for example https://openrouter.ai/api/v1.');}
    const named=String(name||'').trim()?secrets.envName(name):'',s=await this.holdSecret(value,{name:named||secrets.patternName(value)?.name||(secrets.keyLike(value)?'API_KEY':'PASSWORD'),source:'dialog'});
    // Given again under another name: the name the user chose now wins.
    if(named&&s.name!==named)s.name=named;
    // Keys given with a key button or in the Opaya Vault are kept until forgotten there, not only while their chat lasts.
    s.kept=true;if(endpoint)s.endpoint=endpoint;await this.saveSecrets();
    this.emit();return {id:s.id,name:s.name,mask:s.mask,endpoint:s.endpoint||'',reference:secrets.reference(s)};
  }
  stored(s,record){s.stored=[...s.stored.filter(x=>!(x.agentId===record.agentId&&x.name===record.name)),{...record,at:new Date().toISOString()}].slice(-20);return this.saveSecrets().then(()=>this.emit());}
  async newSession(){
    if(this.busy)throw new Error('Stop the current answer first.');
    if(!this.messages.length){this.emit();return this.sessionId;}
    await this.persist();const id=randomUUID();
    this.sessions.push({id,title:'New chat',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});if(this.sessions.length>100)this.sessions.splice(0,this.sessions.length-100);
    this.sessionId=id;this.messages=[];this.error='';this.codexThreadId='';this.claudeSessionId='';await this.persist();await this.pruneSecrets();this.emit();return id;
  }
  async selectSession(id){
    if(this.busy)throw new Error('Stop the current answer first.');if(!this.sessions.some(x=>x.id===id))throw new Error('Chat not found.');
    await this.persist();this.sessionId=id;const m=await readJson(path.join(this.home,'sessions',`${id}.json`),[]);this.messages=Array.isArray(m)?m.slice(-200):[];this.error='';this.codexThreadId='';this.claudeSessionId='';await this.saveIndex();this.emit();return true;
  }
  async deleteSession(id){
    if(this.busy)throw new Error('Stop the current answer first.');if(!this.sessions.some(x=>x.id===id))throw new Error('Chat not found.');
    this.sessions=this.sessions.filter(x=>x.id!==id);await fs.rm(path.join(this.home,'sessions',`${id}.json`),{force:true});
    if(!this.sessions.length)this.sessions.push({id:randomUUID(),title:'New chat',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
    if(id===this.sessionId){this.sessionId=this.sessions.at(-1).id;const m=await readJson(path.join(this.home,'sessions',`${this.sessionId}.json`),[]);this.messages=Array.isArray(m)?m:[];this.codexThreadId='';}
    await this.saveIndex();await this.pruneSecrets();this.emit();return true;
  }
  cli(preset=this.config.preset){return preset==='codex'||preset==='claude';}
  configured(){return this.cli()||!!(this.config.baseUrl&&this.config.model);}
  describe(){
    const shown=this.messages.filter(m=>m.role==='user'||m.summary).slice(-80).map(({id,role,content,activity,createdAt,error})=>({id,role,content:content||'',activity:activity||[],createdAt,error}));
    return {configured:this.configured(),config:this.config,hasKey:!this.cli()&&this.vault.has(KEY),presets:PRESETS,busy:this.busy,status:this.status,error:this.error,messages:shown,live:this.liveReply?{...this.liveReply}:null,home:this.home,sessionId:this.sessionId,sessions:(this.sessions||[]).slice().reverse().map(({id,title,updatedAt})=>({id,title,updatedAt})),
      // Held secrets: names and masks only, newest first; current marks this chat's.
      vaultBackup:this.lastVaultBackup||null,
      secrets:this.secrets.slice().reverse().map(s=>({id:s.id,name:s.name,mask:s.mask,global:!!s.global,kept:!!s.kept,endpoint:s.endpoint||'',reference:secrets.reference(s),current:s.session===this.sessionId,createdAt:s.createdAt,stored:s.stored.map(({agentId,agentName,name,at})=>({agentId,agent:agentName,name,at}))}))};
  }
  async saveConfig({preset='custom',baseUrl,model,apiKey,remember=true}){
    if(!Object.hasOwn(PRESETS,preset))throw new Error('Unknown model provider.');
    const codex=this.cli(preset);
    const config={preset,baseUrl:codex?'':schema.endpoint(baseUrl||PRESETS[preset].baseUrl),model:schema.text(model,'model',256).trim()};
    if(!codex&&!config.model)throw new Error('Choose a model from the provider list.');
    if(!codex&&apiKey!==undefined&&apiKey!=='')await this.vault.set(KEY,schema.text(apiKey,'API key',16000).trim(),Boolean(remember));
    if(this.config.preset!==config.preset||this.config.model!==config.model||this.config.baseUrl!==config.baseUrl){await this.closeCodex();this.claudeSessionId='';}
    this.config=config;await atomicJson(path.join(this.home,'config.json'),config);this.error='';this.emit();return this.describe();
  }
  async forgetKey(){await this.vault.set(KEY,'',true);this.emit();return true;}
  headers(candidateKey,preset=this.config.preset){const key=candidateKey||(this.vault.has(KEY)?this.vault.get(KEY):'');return {'Content-Type':'application/json',...(key?{Authorization:`Bearer ${key}`}:{}),...(key&&preset==='anthropic'?{'x-api-key':key,'anthropic-version':'2023-06-01'}:{}),'X-Title':'Opaya'};}
  async test(candidate={}){
    const preset=candidate.preset||this.config.preset;
    if(preset==='codex'){
      const rpc=await this.ensureCodex(),result=await rpc.request('model/list',{limit:200});
      const models=(result.data||[]).map(m=>m.model||m.id).filter(m=>typeof m==='string');
      return {ok:true,models,message:`Codex CLI connected. ${models.length} models available.`};
    }
    if(preset==='claude'){
      const text=await this.claudeOnce('Reply with the single word OK.',60000);
      return {ok:true,models:PRESETS.claude.models,message:/\bok\b/i.test(text)?'Claude Code is signed in and answering.':'Claude Code answered.'};
    }
    const baseUrl=schema.endpoint(candidate.baseUrl||this.config.baseUrl||PRESETS[preset]?.baseUrl);
    if(!baseUrl)throw new Error('Choose a model provider first.');
    const response=await this.fetch(`${baseUrl}/models`,{headers:this.headers(candidate.apiKey,preset),signal:AbortSignal.timeout(15000)});
    if(response.status===401||response.status===403)throw new Error(`The key was not accepted (${response.status}). Copy the whole key again and paste it.`);
    // Some services have no model list: a one-word request with the chosen model proves the key works.
    const model=candidate.model||PRESETS[preset]?.model;
    if(!response.ok&&model){
      const r=await this.fetch(`${baseUrl}/chat/completions`,{method:'POST',headers:this.headers(candidate.apiKey,preset),signal:AbortSignal.timeout(30000),body:JSON.stringify({model,messages:[{role:'user',content:'Reply with OK.'}],max_tokens:5})});
      if(!r.ok)throw new Error(`The model API answered ${r.status}. Check the base URL and API key.`);
      return {ok:true,models:PRESETS[preset]?.models?.length?PRESETS[preset].models:[model],message:'Connected.'};
    }
    if(!response.ok)throw new Error(`The model API answered ${response.status}. Check the base URL and API key.`);
    const data=await response.json().catch(()=>({}));const models=rankModels((data.data||[]).map(m=>m.id).filter(Boolean)).slice(0,200);
    return {ok:true,models,message:models.length?`Connected. ${models.length} models available.`:'Connected.'};
  }
  async clear(){
    if(this.busy)throw new Error('Stop the current answer first.');this.messages=[];this.error='';this.codexThreadId='';this.claudeSessionId='';await this.persist();
    // The chat's secrets go with it.
    const mine=this.secrets.filter(s=>s.session===this.sessionId);for(const s of mine)await this.dropSecret(s);if(mine.length)await this.saveSecrets();
    this.emit();return true;
  }
  stop(){
    this.controller?.abort();if(this.claudeChild){terminate(this.claudeChild);this.claudeActive?.reject(new Error('Stopped.'));}const active=this.codexActive,rpc=this.codexRpc;
    if(active){this.codexRpc=null;this.codexThreadId='';this.codexActive=null;if(rpc&&!rpc.closed)rpc.close();active.reject(new Error('Stopped.'));}
    return true;
  }
  async persist(){
    const s=this.sessions?.find(x=>x.id===this.sessionId);
    if(s){const first=this.messages.find(m=>m.role==='user');if(first&&s.title==='New chat')s.title=String(first.content).slice(0,60).replace(/\s+/g,' ');if(this.messages.length)s.updatedAt=new Date().toISOString();}
    await atomicJson(path.join(this.home,'sessions',`${this.sessionId}.json`),this.messages.slice(-200));await this.saveIndex();
  }
  system(){
    const s=this.broker.snapshot(),held=this.secrets.filter(x=>x.session===this.sessionId);
    return [
      'You are the Opaya Agent, the built-in assistant of the Opaya desktop app ("One place. All your agents.").',
      'Opaya connects Hermes, Claude Code, Codex, OpenClaw and other agents on this computer and on SSH machines, keeps their chats and terminals, and lets the user switch between them.',
      'Your job: help install new agents, connect and maintain existing ones, manage SSH machines and keys, and troubleshoot agents that do not work.',
      `Work only through your tools. Check the workspace before changing anything. Prefer the smallest change. Explain briefly what you will do before a change. ${this.trusted?.()?'iTrust is on: your changes and commands run without asking the user (removals still ask), so be careful and say what you did.':'iTrust is off: every change and command is approved by the user in a native dialog, and a declined approval is final.'}`,
      'Secrets (API keys, tokens, passwords): the user can hand them to you freely. Opaya keeps every value in its encrypted vault and you only ever see a reference such as [secret S1 · OPENAI_API_KEY · sk-p…9f3a]; a key pasted into the chat becomes one before it reaches you. You never see, guess or repeat a value, so never put one in a command, a text answer or notes, and never ask the user to paste a key into a terminal. To get one, call request_secret (Opaya asks in a secure prompt). To give one to an agent, call store_secret with its id (S1): it goes where that agent reads keys (Hermes .env, OpenClaw ~/.openclaw/.env, DeepSeek Harness ~/.dsh/.env, Claude Code settings.json env, Codex login, the token of an API connection, or your own model key with agent_id opaya), then follow its next hint (reconnect, restart a gateway). When a terminal asks for a key, token or password, answer_prompt answer=secret secret=S1 types it. Keys the user already keeps in the Opaya Vault: vault op=list shows them, vault op=give gives one to an agent, op=give_all to every agent; request_secret only for a key that is not there. Hermes and OpenClaw gateway tokens are imported with save_connection import_gateway_token. [hidden NAME · mask] in tool output is a key Opaya hid from you: you cannot use it; ask the user for it with request_secret when you need it.',
      held.length?`Secrets the user gave in this chat: ${held.map(x=>secrets.reference(x)+(x.stored.length?` (saved for ${x.stored.map(y=>`${y.agentName} as ${y.name}`).join(', ')})`:'')).join('; ')}.`:'',
      'Use run_command and open_app to finish onboarding and fixes end to end when no specific tool fits, with as few extra programs as possible.',
      'Projects: list_projects shows saved project folders and their agents; chats started from a project open the agent in that folder. Git and GitHub CLI actions are in the Projects panel (right-click a project). '+
      'Skills: list_skills shows what an agent has; users run one with /name in its chat. Install Hermes skills with install_skill. MCP servers are added by the user in Settings > MCP servers (list_mcp_servers shows them); Opaya passes them to Hermes over ACP and to Claude Code. ',
      'When an agent hangs or does not answer, call agent_diagnostics first and explain what it shows: a pending approval, a tool that is still running, stderr errors or Hermes log errors. A Hermes log full of repeated "slack_bolt ... Session is closed" tracebacks is a known Hermes gateway bug in its Slack reconnect (NousResearch/hermes-agent#83662); it only affects the gateway and Slack, and restarting the Hermes gateway clears it. For agents that fail: read the connection and error, run diagnostics, check that the endpoint/port or executable exists, reconnect, and only then propose an edited connection. Do not remove connections unless asked.',
      INSTALL_PROCEDURE,
      'To understand a project or config, use list_directory, read_file and project_info (read-only).',
      APP_GUIDE,
      `Platform: ${this.platform}. Saved agents: ${s.agents.length}. Saved machines: ${s.hosts.length}. Your home folder: ${this.home}.`,
      'Answer in the language the user writes in. Be concise.'
    ].filter(Boolean).join('\n');
  }
  // Starts a request and returns at once; progress and the answer arrive through state updates.
  begin(text){if(this.busy)throw new Error('The Opaya Agent is already working.');if(!this.configured())throw new Error('Connect the Opaya Agent to a model first.');schema.prompt(text);this.send(text).catch(()=>{});return true;}
  async send(text){
    if(this.busy)throw new Error('The Opaya Agent is already working.');
    if(!this.configured())throw new Error('Connect the Opaya Agent to a model first.');
    text=schema.prompt(text);this.busy=true;this.error='';this.status='Thinking...';
    // Keys in the message go to the vault before anything else: the chat saved on disk and the model get references.
    // When that fails the message is not sent at all.
    try{text=await this.holdPasted(text);}
    catch(error){this.busy=false;this.status='';this.error=`The message was not sent: Opaya could not keep a key in it safely (${String(error?.message||error).slice(0,300)}).`;this.emit();throw new Error(this.error);}
    this.messages.push({id:randomUUID(),role:'user',content:text,createdAt:new Date().toISOString()});
    const reply={id:randomUUID(),role:'assistant',content:'',activity:[],createdAt:new Date().toISOString()};this.current=reply;
    this.controller=new AbortController();this.liveReply=reply;this.emit();
    let recent=this.messages.filter(m=>!m.summary).slice(-40);const start=recent.findIndex(m=>m.role==='user');recent=start<0?[]:recent.slice(start);
    const context=recent.map(({role,content,tool_calls,tool_call_id})=>({role,content:content??'',...(tool_calls?{tool_calls}:{}),...(tool_call_id?{tool_call_id}:{})}));
    const conversation=[{role:'system',content:this.system()},...context];
    try{
      if(this.config.preset==='codex')await this.runCodex(text,reply);
      else if(this.config.preset==='claude')await this.runClaude(text,reply);
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
    }catch(error){reply.error=this.controller.signal.aborted?'Stopped.':secrets.shieldOutput(String(error.message||error),this.heldValues()).slice(0,600);this.error=reply.error;}
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
  summarizer(){if(this.cli()||!this.configured())return null;const local=['ollama','lmstudio'].includes(this.config.preset);return local||this.vault.has(KEY)?`${PRESETS[this.config.preset]?.label||'Model API'} / ${this.config.model}`:null;}
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
    agent.extraEnv=codexEnv(this.userHome?path.join(this.userHome,'.codex'):undefined);
    const rpc=new Rpc(this.spawnAgent(agent,[...SHELL_ENV,'app-server'],null),{jsonrpc:false,onRequest:(method,params)=>this.codexRequest(method,params)});
    this.codexRpc=rpc;rpc.on('notification',(method,params)=>this.codexNotification(method,params));rpc.on('closed',error=>{if(this.codexActive)this.codexActive.reject(error);});
    await rpc.request('initialize',{clientInfo:{name:'opaya',title:'Opaya Agent',version:'0.22.4'},capabilities:{experimentalApi:true}});rpc.notify('initialized',{});return rpc;
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
  // Claude Code as the Opaya Agent's model: `claude -p` in the agent's home folder, with the Opaya tools as an MCP
  // server (opaya-tools-mcp.cjs, scoped to calling them) and Claude's own shell, edit and web tools turned off.
  claudeAgent(){return {id:'opaya-local-claude',name:'Local Claude Code',provider:'claude',protocol:'claude',transport:'local',command:'claude',args:[],cwd:this.home,hermesHome:''};}
  async claudeReady(){
    await primeShellPath();
    if(this.spawnAgent===launch&&!findExecutable('claude',environment()))throw new Error('Claude Code was not found on this computer. Install it (Install agents > Claude Code), run claude once in Terminal to sign in, then try again.');
    await fs.mkdir(this.home,{recursive:true}).catch(()=>{});
  }
  claudeSpawn(args){return this.spawnAgent(this.claudeAgent(),args,null,{cwd:this.home,env:environment({MCP_TOOL_TIMEOUT:'900000',MCP_TIMEOUT:'30000'})});}
  // One plain question without tools, to check that Claude Code is installed and signed in.
  async claudeOnce(prompt,timeout=60000){
    await this.claudeReady();
    const child=this.claudeSpawn(['-p','--output-format','json']);
    return new Promise((resolve,reject)=>{
      let out='',err='';const timer=setTimeout(()=>{terminate(child);reject(new Error('Claude Code did not answer in time. Run claude once in Terminal to sign in.'));},timeout);
      child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',d=>{out+=d;});child.stderr.on('data',d=>{err=(err+d).slice(-2000);});
      child.on('error',e=>{clearTimeout(timer);reject(e);});
      child.on('close',code=>{clearTimeout(timer);let r={};try{r=JSON.parse(out.trim().split('\n').pop()||'{}');}catch{}
        if(code!==0||r.is_error){const msg=String(r.result||err||`Claude Code exited (${code}).`);reject(new Error(/log ?in|login|auth|credential|api key/i.test(msg)?`Claude Code is not signed in yet. Run claude once in Terminal and sign in. (${msg.slice(0,200)})`:msg.slice(0,400)));}
        else resolve(String(r.result||''));});
      child.stdin.on('error',()=>{});child.stdin.end(prompt);
    });
  }
  async runClaude(text,reply){
    await this.claudeReady();
    if(!this.toolBridge)throw new Error('The Opaya tools are not available. Restart Opaya.');
    const config=path.join(this.home,'mcp.json');
    await atomicJson(config,{mcpServers:{opaya:{type:'stdio',command:this.toolBridge.command,args:this.toolBridge.args,env:this.toolBridge.env}}});
    const args=['-p','--output-format','stream-json','--verbose','--mcp-config',config,'--strict-mcp-config','--allowedTools','mcp__opaya',
      '--disallowedTools','Bash','Edit','Write','MultiEdit','NotebookEdit','WebFetch','WebSearch','Task','--append-system-prompt',this.system(),
      ...(this.claudeSessionId?['--resume',this.claudeSessionId]:[]),...(this.config.model?['--model',this.config.model]:[])];
    const child=this.claudeSpawn(args);this.claudeChild=child;
    await new Promise((resolve,reject)=>{
      let buffer='',stderr='',done=false,resultError='',seen=false;
      const finish=error=>{if(done)return;done=true;clearTimeout(timer);this.claudeActive=null;this.claudeChild=null;error?reject(error):resolve();};
      this.claudeActive={reply,reject:finish};
      const timer=setTimeout(()=>{terminate(child);finish(new Error('Claude turn timed out.'));},30*60*1000);timer.unref?.();
      const parse=line=>{
        if(!line.trim())return;let e;try{e=JSON.parse(line);}catch{return;}
        if(e.session_id)this.claudeSessionId=e.session_id;
        if(e.type==='assistant')for(const c of e.message?.content||[]){
          if(c.type==='text'&&c.text){reply.content=(reply.content?reply.content+'\n\n':'')+c.text;this.emit();}
          if(c.type==='tool_use'&&!String(c.name||'').startsWith('mcp__opaya__')){const label=`Claude: ${c.name}`;if(reply.activity.at(-1)!==label){reply.activity.push(label);this.emit();}}
        }
        if(e.type==='result'){seen=true;if(e.is_error)resultError=String(e.result||'Claude could not complete this request.');else if(!reply.content&&typeof e.result==='string')reply.content=e.result;}
      };
      child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
      child.stdout.on('data',chunk=>{buffer+=chunk;let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);parse(line);}});
      child.stderr.on('data',c=>{stderr=(stderr+c).slice(-3000);});
      child.on('error',finish);
      child.on('close',code=>{if(buffer.trim())parse(buffer);finish(resultError?new Error(resultError):code!==0?new Error(String(stderr||`Claude Code exited (${code}).`).slice(0,600)):!seen?new Error('Claude Code stopped before it finished.'):null);});
      child.stdin.on('error',()=>{});child.stdin.end(text);
    });
  }
  // A tool call from Claude Code, through the MCP bridge. Only during an active Opaya Agent turn.
  async bridgeCall(name,args){
    const active=this.claudeActive;if(!active||!this.busy)throw new Error('The Opaya Agent is not working on a request right now.');
    if(!TOOLS.some(t=>t.function.name===name))throw new Error('Unknown tool.');
    this.status=`Using ${name.replace(/_/g,' ')}...`;active.reply.activity.push(this.status.replace('...',''));this.emit();
    return this.tool(name,args&&typeof args==='object'?args:{});
  }
  async closeCodex(){const rpc=this.codexRpc,active=this.codexActive;this.codexRpc=null;this.codexThreadId='';this.codexActive=null;if(rpc&&!rpc.closed)rpc.close();active?.reject(new Error('Codex stopped.'));}
  async close(){await this.closeCodex();if(this.claudeChild)terminate(this.claudeChild);}
  host(id){return id?this.broker.host(id):null;}
  spawnProcess(file,args,{verbatim=false}={}){return require('node:child_process').spawn(file,args,{detached:true,stdio:'ignore',windowsHide:true,windowsVerbatimArguments:verbatim}).once('spawn',function(){this.unref();});}
  // iTrust for the Opaya Agent skips the dialog, except for removals, which always ask.
  async ask(title,detail,{always=false}={}){if(!always&&this.trusted?.()){this.status=`iTrust approved: ${title}`;this.current?.activity?.push(this.status);this.emit();return;}if(!await this.approve({name:'Opaya Agent'},title,detail))throw new Error('The user declined this action.');}
  // Terminals the Opaya Agent started; answer_prompt works only in these. Marked commands print an end line with the
  // exit code and a run tag, so wait_for_terminal knows when this run (not an earlier one in the same tab) is done.
  // A tab whose last run finished is reused; one still busy gets a sibling, so a command never types into a running one.
  async runOwn({label,key,host,command,marked=false}){
    const posix=!!host||this.platform!=='win32',tag=randomUUID().replace(/-/g,'').slice(0,8),hostId=host?.id||'';
    let slot=key;for(let n=2;n<10&&this.tabBusy(slot,hostId);n++)slot=`${key}_${n}`;
    const full=marked?(posix?`${command}; echo "[opaya] finished with exit code $? (run ${tag})"`:`${command}; Write-Host "[opaya] finished with exit code $(if ($?) { 0 } else { 1 }) (run ${tag})"`):command;
    const view=await this.runInTerminal({label,key:slot,host,command:full});this.ownTerminals.add(view.id);
    this.runs.set(view.id,{key:slot,hostId,tag:marked?tag:''});return view;
  }
  tabBusy(key,hostId){
    for(const [id,run] of this.runs){
      if(run.key!==key||run.hostId!==hostId)continue;
      let view;try{view=this.terminals.attach(id);}catch{this.runs.delete(id);continue;}
      if(!view.exited&&!this.runState(id,stripAnsi(view.buffer)).finished)return true;
    }
    return false;
  }
  // Output of the current run: what came after the end line of an earlier run in the same tab.
  runText(id,text){
    const run=this.runs.get(id);if(!run?.tag)return text;
    const ends=[...text.matchAll(/\[opaya\] finished with exit code \d+ \(run (\w+)\)[^\n]*\n?/g)].filter(m=>m[1]!==run.tag);
    const last=ends.at(-1);return last?text.slice(last.index+last[0].length):text;
  }
  // Finished (this run's end line), or waiting for an answer or a password.
  runState(id,text){
    const run=this.runs.get(id),state=promptState(text);if(!run?.tag)return state;
    const done=[...text.matchAll(new RegExp(`\\[opaya\\] finished with exit code (\\d+) \\(run ${run.tag}\\)`,'g'))].pop();
    return done?{finished:true,exit_code:Number(done[1])}:{finished:false,question:!!state.question,password:!!state.password};
  }
  async terminalOutput(id,wait=0){
    const deadline=Date.now()+wait;
    for(;;){const view=this.terminals.attach(id);if(view.exited||Date.now()>=deadline)return this.runText(id,stripAnsi(view.buffer)).slice(-6000);await new Promise(r=>setTimeout(r,800));}
  }
  // Wait until this run finishes (for short checks), up to `wait` ms.
  async runOutput(id,wait){
    const deadline=Date.now()+wait;
    for(;;){const view=this.terminals.attach(id),text=this.runText(id,stripAnsi(view.buffer));if(view.exited||this.runState(id,text).finished||Date.now()>=deadline)return text.slice(-6000);await new Promise(r=>setTimeout(r,700));}
  }
  // The screen the program drew, as a person sees it, with the select menu or numbered list on it.
  async screenOf(id){
    const view=this.terminals.attach(id),buffer=String(view.buffer||''),stamp=`${view.seq??''}:${buffer.length}:${buffer.slice(-64)}:${view.cols}x${view.rows}`;
    const cached=this.screens.get(id);if(cached?.stamp===stamp)return cached.value;
    const shot=await screen.render(buffer,view.cols||110,view.rows||30);
    const menu=screen.readMenu(shot.lines),numbered=menu?null:screen.readNumbered(shot.lines);
    const lines=shot.lines.map(l=>l.replace(/\s+$/,''));while(lines.length&&!lines[0].trim())lines.shift();
    const value={text:screen.screenText(lines),menu,numbered,appCursor:shot.appCursor,alternate:shot.alternate,seq:view.seq};
    this.screens.set(id,{stamp,value});return value;
  }
  // A secret prompt on the screen (password, API key, token): only a secret the user gave goes there (answer=secret).
  secretPrompt(shot){
    if(shot.menu)return false;
    const lines=shot.text.split('\n').filter(l=>l.trim()),tail=lines.slice(-4).join('\n');
    const asking=lines.slice(-4).reverse().find(l=>/^\s*[◆?]|[:?>]\s*\S?\s*$/.test(l))||'';
    return /(password|passphrase|passcode)[^\n]*:\s*$/im.test(tail)||(/(api[ _-]?key|access[ _-]?key|token|secret|password|passphrase)/i.test(asking)&&!/\[[yY]\/[nN]\]|\([yY]\/[nN]\)|yes\/no/i.test(asking));
  }
  // Settle after keys: wait for the program to redraw and then go quiet (short).
  async settle(id,before,limit=2500){
    const start=Date.now();let last=before,quietSince=Date.now();
    for(;;){
      await new Promise(r=>setTimeout(r,120));
      const view=this.terminals.attach(id),mark=`${view.seq??''}:${String(view.buffer||'').length}`;
      if(mark!==last){last=mark;quietSince=Date.now();}
      if((mark!==before&&Date.now()-quietSince>=300)||Date.now()-start>=limit)return;
    }
  }
  mark(id){const view=this.terminals.attach(id);return `${view.seq??''}:${String(view.buffer||'').length}`;}
  async keys(id,data,times=1){
    const before=this.mark(id);
    // Arrow keys go one by one with a short gap, as a person types; curses and prompt libraries read each one.
    for(let i=0;i<times;i++){this.terminals.write(id,data);if(times>1)await new Promise(r=>setTimeout(r,25));}
    await this.settle(id,before);
  }
  async asksSecret(id,shot){return this.secretPrompt(shot)||promptState(await this.terminalOutput(id)).password;}
  // answer_prompt secret: the held value, then Enter, only into a prompt that asks for a password, key or token. The
  // approval can take a while, so the prompt is checked again right before typing.
  async typeSecret(id,which,shot){
    const s=this.secretEntry(which),value=this.secretValue(s);
    if(/[\r\n]/.test(value))throw new Error(`${s.id} has several lines (a private key?), so it cannot be typed into a prompt.`);
    if(!await this.asksSecret(id,shot))throw new Error('Opaya types a secret only into a prompt that asks for a password, API key or token, and this terminal does not show one now. Follow it with wait_for_terminal until it asks (password=true).');
    let title='';try{title=this.terminals.attach(id).title||'';}catch{}
    await this.ask(`Type ${s.name} into a terminal?`,`${secrets.reference(s)}\n\nOpaya types the value it holds${title?` into "${title}"`:''}, then Enter. It never appears in the chat.`);
    this.screens.delete(id);if(!await this.asksSecret(id,await this.screenOf(id)))throw new Error('The terminal no longer asks for it. Read it again with wait_for_terminal.');
    await this.keys(id,value+'\r');this.status=`Typed ${s.id} (${s.name}) in the terminal`;this.emit();
    const after=await this.screenOf(id);
    return {typed:s.id,name:s.name,screen:after.text.slice(-2500),output:(await this.terminalOutput(id)).slice(-1500),next:'Call wait_for_terminal to see whether it was accepted.'};
  }
  // request_secret: Opaya's secure prompt. The model gets the reference, never the value.
  async requestSecret(args){
    const name=secrets.envName(args.name),why=String(args.why||'').replace(/\s+/g,' ').trim().slice(0,400),target=String(args.agent_id||'').trim();
    const agent=target&&!/^opaya(-agent)?$/i.test(target)?this.broker.agent(schema.id(target)):null;
    if(!this.askSecret)throw new Error('Opaya\'s secure prompt is not available here.');
    this.status=`Waiting for ${name}...`;this.emit();
    const value=await this.askSecret({name,why,agent:agent?.name||''});
    if(!value)return {given:false,name,note:'The user did not give it: they cancelled, closed the prompt or did not answer within 10 minutes, or the Opaya window is closed. Do not ask for it in the chat; say what it is for and that they can give it any time with the key button next to the message box.'};
    const s=await this.holdSecret(value,{name,source:'prompt'});this.emit();
    return {given:true,secret:s.id,reference:secrets.reference(s),next:agent?`Save it for ${agent.name} with store_secret secret=${s.id} agent_id=${agent.id}.`:'Use it with store_secret, or type it into a terminal prompt with answer_prompt answer=secret.'};
  }
  // store_secret: a held value into the place an agent reads it, on this computer, an SSH machine or in a container.
  // Files are rewritten whole (other lines and keys kept) through a temporary file with mode 600; the value travels on
  // stdin to SSH machines and containers, never in a command line.
  async storeSecret(args,{approved=false}={}){
    const ask=(title,detail)=>approved?undefined:this.ask(title,detail);
    const s=this.secretEntry(args.secret),value=this.secretValue(s),b=this.broker,ref=secrets.reference(s),target=String(args.agent_id||'').trim(),name=secrets.envName(args.name||s.name);
    if(!target)throw new Error('Give agent_id: a saved agent\'s id, or opaya for your own model key.');
    if(args.into&&!['agent_config','connection_token'].includes(args.into))throw new Error('into is agent_config or connection_token.');
    if(/^opaya(-agent)?$/i.test(target)){
      if(this.cli())throw new Error(`The Opaya Agent runs on ${PRESETS[this.config.preset].label}, which uses its own sign-in, not an API key. The user changes that in Model settings.`);
      await ask('Use this key for the Opaya Agent\'s model?',`${ref}\n\nOpaya keeps it in its vault as the API key for ${PRESETS[this.config.preset]?.label||'the model API'}${this.config.model?` (${this.config.model})`:''}.`);
      await this.vault.set(KEY,value,this.vault.available());await this.stored(s,{agentId:'opaya',agentName:'Opaya Agent',name:'model API key',where:'Opaya vault'});
      return {stored:true,secret:s.id,agent:'Opaya Agent',where:'your model API key (Opaya vault)',next:'Your next model request uses it.'};
    }
    const agent=b.agent(schema.id(target)),host=agent.transport==='ssh'?b.host(agent.hostId):null,where=place({agent,host}),api=agent.protocol==='openai';
    const on=`${where.container?`in container ${where.container} `:''}${host?`on ${host.name}`:'on this computer'}`,reconnect='Reconnect it so it loads the key: disconnect_agent, then connect_agent.';
    const into=args.into||(api&&!['hermes','openclaw'].includes(agent.provider)?'connection_token':'agent_config');
    if(into==='connection_token'){
      if(!api)throw new Error(`${agent.name} does not connect over an HTTP API, so it has no connection token. Use into=agent_config.`);
      await ask(`Save ${s.name} as the API token of "${agent.name}"?`,`${ref}\n\nOpaya keeps it in its vault and sends it to ${agent.endpoint} when it connects.`);
      await this.vault.set(agent.id,value,this.vault.available());await this.stored(s,{agentId:agent.id,agentName:agent.name,name:'connection token',where:'Opaya vault'});
      return {stored:true,secret:s.id,agent:agent.name,where:'its connection token (Opaya vault)',next:`Opaya sends it from the next connection. ${reconnect}`};
    }
    const kind=keyKindOf(agent);
    if(!kind)throw new Error(`Opaya does not know where ${agent.name} reads keys. Run its own sign-in (setup_agent sign_in) and type the key into its prompt with answer_prompt answer=secret${api?', or save it as its connection token with into=connection_token':''}.`);
    // A gateway Opaya reaches only over the network: its files are on another machine Opaya cannot write to.
    if(agent.transport==='http'&&!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(agent.endpoint||''))throw new Error(`Opaya reaches ${agent.name} only over HTTP (${agent.endpoint}), so it cannot write its config. Add its machine and a connection over SSH, or use into=connection_token for the key Opaya sends it.`);
    // Codex: an OpenAI key signs it in (codex login --with-api-key); any other key goes into its .env (CODEX_HOME/.env,
    // which Codex loads when it starts), like the other agents.
    if(kind==='codex'&&/^OPENAI_API_KEY$|^CODEX_API_KEY$/.test(name)){
      await ask(`Sign "${agent.name}" in with ${s.name}?`,`${ref}\n\nRuns codex login --with-api-key ${on}. Opaya gives the key on its input, never on the command line.`);
      await collect(this.spawnAgent(agent,[...(agent.args||[]).filter(x=>x!=='app-server'),'login','--with-api-key'],host),{timeout:60000,input:value+'\n'});
      await this.stored(s,{agentId:agent.id,agentName:agent.name,name:'Codex login',where:'codex login'});
      const loaded=await this.reloadForKey(agent);
      return {stored:true,secret:s.id,agent:agent.name,where:`the Codex login ${on}`,loaded,next:`Codex keeps it in its login (auth.json). ${loadedText(loaded,reconnect)}`};
    }
    // A key saved with its endpoint also gets <NAME>_BASE_URL (OPENROUTER_API_KEY -> OPENROUTER_BASE_URL).
    // DeepSeek Harness does not start at all when its .env sets a name only its launching environment may set.
    if(kind==='dsh'&&secrets.dshEnvRefused(name))throw new Error(`DeepSeek Harness takes ${name} only from the environment it is started with, not from a file, so Opaya does not write it.`);
    if(kind==='dsh'&&name==='DEEPSEEK_API_KEY')await this.checkDeepseekKey(value);
    const urlName=s.endpoint&&!(kind==='dsh'&&secrets.dshEnvRefused(endpointName(name)))?endpointName(name):'',set=(text,k,v)=>kind==='claude'?secrets.setJsonEnv(text,k,v):secrets.setEnv(text,k,v);
    const file=await this.configFile(kind,agent,where),write=text=>urlName?set(set(text,name,value),urlName,s.endpoint):set(text,name,value);
    write(await secrets.readAt(where,file)); // fails before asking: a value a .env cannot hold, a settings.json that is not JSON
    // DeepSeek Harness: also in its credential store, which wins over its .env files (a key saved in its Web UI goes
    // there too, so a new key from Opaya replaces an old one instead of losing to it); the .env keeps it for its tools.
    const store=kind==='dsh'?file.replace(/\.env$/,'.credentials.yaml'):'',storeWrite=text=>secrets.setYamlRef(urlName?secrets.setYamlRef(text,urlName,s.endpoint):text,name,value);
    if(store)storeWrite(await secrets.readAt(where,store));
    await ask(`Save ${name} for "${agent.name}"?`,`${ref}\n\nOpaya writes ${name}=${s.mask}${urlName?` and ${urlName}=${s.endpoint}`:''} into ${file}${store?` and ${store}`:''} ${on} (file mode 600). The value goes from Opaya's vault straight into the file, never through a command line, a log or the chat.`);
    await secrets.writeAt(where,file,write(await secrets.readAt(where,file)));
    if(store)await secrets.writeAt(where,store,storeWrite(await secrets.readAt(where,store)));
    await this.stored(s,{agentId:agent.id,agentName:agent.name,name,where:file});
    const machine=host?` with machine_id ${host.id}`:'',win=!host&&this.platform==='win32';
    const restart=where.container?`run_command docker restart ${where.container}${machine}`:kind==='hermes'?`run_command ${agent.hermesHome?(win?`$env:HERMES_HOME=${quote(agent.hermesHome)}; `:`HERMES_HOME=${quote(agent.hermesHome)} `):''}hermes gateway restart${machine}`:`run_command openclaw gateway restart${machine} (or setup_agent start_gateway)`;
    // Codex's app server and ACP agents keep running between messages: Opaya restarts them so the key is in their
    // environment. Claude Code starts anew for each message, so it has the key from the next one.
    const loaded=kind==='claude'&&agent.protocol!=='acp'?'turn':await this.reloadForKey(agent),then=loadedText(loaded,reconnect);
    const next={
      hermes:`Hermes loads this .env when a Hermes process starts, and a running gateway picks up new provider keys on its next request. ${then} When the key is for a channel (Telegram, Discord, Slack) or an API_SERVER_* setting, restart its gateway: ${restart}.`,
      openclaw:`OpenClaw loads this .env when its gateway starts (a variable already set in the gateway's own environment wins); its CLI commands see it at once. Restart the gateway: ${restart}, then disconnect_agent and connect_agent.`,
      claude:`Claude Code loads env from settings.json when it starts. ${then} An interactive Claude Code may ask once whether to use a new ANTHROPIC_API_KEY.`,
      codex:`Codex loads this .env when it starts. ${then}`,
      dsh:`DeepSeek Harness takes it from its credential store (~/.dsh/.credentials.yaml, where its Web UI saves keys too) on its next request; the same name set in the environment Opaya or a shell starts it from would win, and Opaya does not pass such a stale one to the dsh it starts. ${then}`
    }[kind];
    return {stored:true,secret:s.id,agent:agent.name,name,file,where:on,loaded,next,...(urlName?{endpointName:urlName,endpoint:s.endpoint}:{})};
  }
  // A DeepSeek key DeepSeek refuses is caught before it is written (the agent would only fail with "Authentication
  // Fails" later). No answer from DeepSeek (offline, a proxy) does not stop it.
  async checkDeepseekKey(value){
    let r;try{r=await this.fetch('https://api.deepseek.com/models',{headers:{authorization:`Bearer ${value}`},signal:AbortSignal.timeout(10000)});}catch{return;}
    if(r?.status===401||r?.status===403)throw new Error(`DeepSeek did not accept this key (${r.status}), so Opaya did not save it. Copy the whole key from platform.deepseek.com/api_keys again (it starts with sk-).`);
  }
  // An agent process that keeps running (Codex's app server, an ACP agent such as Hermes) reads its keys when it
  // starts. Opaya restarts it when it is idle ('now'), or right after its current answer ('after'); a disconnected one
  // loads the key when it connects ('next').
  async reloadForKey(agent){
    const b=this.broker;if(!['codex','acp'].includes(agent.protocol))return '';
    if(b.runtime.get(agent.id)?.status!=='connected')return 'next';
    const again=()=>{b.disconnect(agent.id);return b.connect(agent.id);};
    const turn=b.turns.get(agent.id);
    if(turn){
      this.reloads??=new Set();if(this.reloads.has(agent.id))return 'after';this.reloads.add(agent.id);
      turn.done.then(async()=>{this.reloads.delete(agent.id);if(!b.turns.has(agent.id)&&b.runtime.get(agent.id)?.status==='connected')await again();}).catch(()=>{});
      return 'after';
    }
    try{await again();return 'now';}catch{return 'failed';}
  }
  // The key button in an agent's own chat: the user gives that agent a key. Opaya keeps it in its vault and writes it
  // where the agent reads keys (its .env, Claude Code's settings, Codex's login, or the connection's token). The user
  // chose the agent and the name, so this asks no second time. The note tells the agent's model what was added, where,
  // and how to use it, without the value.
  // The Opaya Vault MCP (vault-mcp.cjs) of an agent on this computer: list names, or take a key after the user approves.
  async vaultTool({agentId,op,name,why}={}){
    const agent=this.broker.agent(schema.id(agentId)),keys=this.secrets.filter(s=>s.kept||s.global);
    if(op==='list')return {keys:keys.map(s=>({name:s.name,hint:s.mask,endpoint:s.endpoint||undefined,you_have_it:s.stored.some(x=>x.agentId===agent.id)})),note:keys.length?'Take one with vault_use name=<NAME>.':'The Opaya Vault is empty. Ask the user to add the key in Opaya (Vault in the sidebar).'};
    if(op!=='use')throw new Error('Unknown vault operation.');
    const want=secrets.envName(name||''),s=keys.slice().reverse().find(x=>x.name===want);
    if(!s)throw new Error(`The Opaya Vault has no ${want}. Call vault_list, or ask the user to add it in Opaya (Vault in the sidebar).`);
    const reason=String(why||'').replace(/\s+/g,' ').trim().slice(0,300);
    if(!this.broker.isTrusted?.(agent.id)&&!await this.approve({name:agent.name},`Let ${agent.name} use ${s.name}?`,`${agent.name} asks for ${s.name} (${s.mask}) from the Opaya Vault${reason?`: ${reason}`:''}.\n\nOpaya writes it into the file this agent reads keys from. The value does not go into the chat.`))throw new Error('The user declined. Do not ask again for this key in this task.');
    const r=await this.storeSecret({secret:s.id,agent_id:agent.id,name:s.name},{approved:true});
    return {name:r.name||s.name,file:r.file||undefined,where:r.where,endpoint_variable:r.endpointName,loaded:r.loaded||undefined,next:r.loaded==='after'?`It is in ${r.file||r.where}. From your next message it is in your environment as $${r.name||s.name} (Opaya restarts you after this answer). For this answer, load it from that file in the command that needs it; never print it.`:r.loaded==='now'||r.loaded==='turn'?`It is in your environment as $${r.name||s.name}${r.file?` (saved in ${r.file})`:''}; never print it.`:r.file?`It is in ${r.file}. Read it from there when you need it (for example, load that .env in the command that needs it); never print it.`:r.next};
  }
  // The key button in an agent's chat: the keys this agent has (names only), read from the file it reads keys from,
  // with the ones Opaya gave it marked, plus the vault keys it does not have yet.
  async agentKeys({agentId}={}){
    const b=this.broker,agent=b.agent(schema.id(agentId)),host=agent.transport==='ssh'?b.host(agent.hostId):null;
    const kind=keyKindOf(agent);
    const given=new Map();
    for(const s of this.secrets)for(const x of s.stored||[])if(x.agentId===agent.id)given.set(x.name==='Codex login'?s.name:x.name,{secret:s,where:x.where});
    let file='',names=[],error='';
    const remoteHttp=agent.transport==='http'&&!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/i.test(agent.endpoint||'');
    if(kind&&!remoteHttp){
      // The same reader as Transfer (Codex: its login and its .env); file is where a new key would go.
      try{file=await this.configFile(kind,agent,place({agent,host}));names=(await transfer.envKeys(agent,host,{vault:b.vault})).map(k=>k.name);
        if(kind==='dsh')names.push(...secrets.yamlRefs(await secrets.readAt(place({agent,host}),file.replace(/\.env$/,'.credentials.yaml')).catch(()=>'')));}
      catch(e){error=String(e?.message||e).slice(0,200);}
    }
    const keys=[...new Set([...names,...given.keys()])].map(name=>{const g=given.get(name);return {name,fromOpaya:Boolean(g),global:Boolean(g?.secret.global),hint:g?.secret.mask,where:g?(g.where==='codex login'?'Codex login':g.where):file,inFile:names.includes(name)};});
    const have=new Set(keys.map(k=>k.name));
    const vault=this.secrets.filter(s=>(s.kept||s.global)&&!have.has(s.name)).map(s=>({id:s.id,name:s.name,hint:s.mask,global:Boolean(s.global),endpoint:s.endpoint||undefined}));
    return {agent:agent.name,kind,file,error,keys,vault};
  }
  // Service actions the Opaya Agent's tools run (backup, uninstall, clone, transfer, MCP, jobs); set by the service.
  async app(name,input){if(typeof this.appAction!=='function')throw new Error('This action is not available here.');return this.appAction(name,input||{});}
  // The note about a new key, sent into the agent's last chat when it is connected and idle.
  tellAgent(agentId,note){
    const b=this.broker,rt=b.runtime.get(agentId);if(!note||rt?.status!=='connected'||b.turns.has(agentId))return false;
    const conversationId=b.data.conversations.find(c=>c.agentId===agentId&&c.id===b.data.lastConversation?.[agentId])?.id||b.data.conversations.filter(c=>c.agentId===agentId).at(-1)?.id||'';
    b.send({agentId,conversationId,text:note}).catch(()=>{});return true;
  }
  // The vault tool: list keys, give one to an agent, make one global, forget one.
  async vaultOp({op,key,agent_id}={}){
    const keys=this.secrets;
    if(op==='list')return {keys:keys.map(s=>({id:s.id,name:s.name,hint:s.mask,endpoint:s.endpoint||undefined,global:!!s.global,agents:[...new Set((s.stored||[]).map(x=>x.agentName))]}))};
    const want=String(key||'').trim(),s=/^S\d+$/i.test(want)?this.secretEntry(want):keys.slice().reverse().find(x=>x.name===secrets.envName(want));
    if(!s)throw new Error(`The Opaya Vault has no ${want||'such key'}. Call vault op=list, or request_secret to get it from the user.`);
    if(op==='give'){
      const agent=this.broker.agent(schema.id(agent_id));
      await this.ask(`Give ${s.name} to ${agent.name}?`,`${secrets.reference(s)}\n\nOpaya writes it where ${agent.name} reads keys and tells it the variable name in its chat, never the value.`);
      const r=await this.giveHeldToAgent({id:s.id,agentId:agent.id});return {name:r.name,agent:r.agent,file:r.file||undefined,where:r.where,next:r.next,told:this.tellAgent(agent.id,r.note)};
    }
    if(op==='give_all'){await this.ask(`Give ${s.name} to every agent?`,`${secrets.reference(s)}\n\nOpaya writes it into every agent that reads keys, on every machine and in containers, and tells the connected ones.`);return this.giveToAll({id:s.id});}
    if(op==='forget'){await this.ask(`Forget ${s.name}?`,'Opaya removes it from its vault. Agents it was saved for keep their copy.',{always:true});await this.forgetSecret(s.id);return {forgotten:s.name};}
    throw new Error('Unknown vault op.');
  }
  // ---- Import into the vault: a file, pasted text or the tools on this computer ------------------------------------
  // A scan keeps the values here for 15 minutes under a random id and returns names, masks and sources; the user picks,
  // and the picked ones are held like keys added in the Vault (kept until forgotten). A value the vault already holds is
  // marked and never held twice.
  async vaultImportScan({file,text,tools}={}){
    let sources;
    if(file){const f=String(file);sources=[{id:'file',label:path.basename(f),path:f,items:vaultImport.scanText(await vaultImport.readTextFile(f))}];}
    else if(typeof text==='string'){if(text.length>MAX_IMPORT_TEXT)throw new Error('Paste up to 1 MB of text.');sources=[{id:'text',label:'Pasted text',path:'',items:vaultImport.scanText(text,{long:true})}];}
    else if(tools){const b=this.broker;sources=await vaultImport.scanTools({agents:b.data.agents,hostOf:a=>a.transport==='ssh'?b.host(a.hostId):null,readKeys:transfer.readKeys,vault:b.vault,home:this.userHome||undefined,env:this.userHome?{}:process.env});}
    else throw new Error('Choose a file, paste text or scan your tools.');
    const held=new Map();for(const s of this.secrets){const v=this.secretValue(s,true);if(v)held.set(v,s);}
    // The same value in two places (a shell profile and an agent's .env) is one key: later places point to the first.
    const values=new Map(),first=new Map();let n=0;
    const out=sources.map(src=>({id:src.id,label:src.label,path:src.path,agentId:src.agentId,error:src.error,items:src.items.map(x=>{const key=`i${++n}`;values.set(key,x.value);const h=held.get(x.value),also=first.get(x.value)||'';if(!also)first.set(x.value,src.label);return {key,name:x.name,mask:secrets.mask(x.value),inVault:h?.kept||h?.global?h.name:'',also};})}));
    const id=randomUUID();this.imports??=new Map();for(const [k,v] of this.imports)if(Date.now()-v.at>15*60*1000)this.imports.delete(k);
    while(this.imports.size>=5)this.imports.delete(this.imports.keys().next().value);
    this.imports.set(id,{at:Date.now(),values});
    return {id,sources:out,count:n};
  }
  async vaultImportCommit({id,picks}={}){
    const scan=this.imports?.get(String(id||''));if(!scan||Date.now()-scan.at>15*60*1000)throw new Error('This scan has expired. Scan again.');
    if(!Array.isArray(picks)||!picks.length)throw new Error('Choose the keys to import.');
    const imported=[],skipped=[],seen=new Set();
    for(const p of picks.slice(0,500)){
      const value=scan.values.get(String(p?.key||''));if(!value||seen.has(value))continue;seen.add(value);
      const known=this.secrets.find(s=>(s.kept||s.global)&&this.secretValue(s,true)===value);if(known){skipped.push({name:known.name,why:'already in the Vault'});continue;}
      try{const r=await this.holdFromUser({name:p.name,value});imported.push({id:r.id,name:r.name,mask:r.mask});}catch(error){skipped.push({name:String(p.name||''),why:String(error?.message||error).slice(0,160)});}
    }
    this.imports.delete(String(id));this.emit();
    return {imported,skipped};
  }
  // A backup of the keys the user keeps, in a file encrypted with a password the user chooses (vault-backup.cjs). Only
  // the user can make or restore one, never the Opaya Agent or another agent.
  async vaultBackupSave({file,password}={}){
    file=String(file||'');if(!path.isAbsolute(file))throw new Error('Choose where to save the backup.');
    const keys=this.secrets.filter(s=>s.kept||s.global).map(s=>({name:s.name,value:this.secretValue(s,true),endpoint:s.endpoint||''})).filter(k=>k.value);
    const text=await vaultBackup.seal(keys,password);
    await fs.writeFile(file,text,{mode:0o600});await fs.chmod(file,0o600).catch(()=>{});
    const saved={file,count:keys.length,at:new Date().toISOString()};this.lastVaultBackup=saved;
    await atomicJson(path.join(this.home,'vault-backup.json'),saved).catch(()=>{});this.emit();return saved;
  }
  async vaultBackupRestore({file,password}={}){
    file=String(file||'');if(!path.isAbsolute(file))throw new Error('Choose the backup file.');
    const info=await fs.stat(file).catch(()=>null);if(!info?.isFile())throw new Error(`${file} does not exist.`);
    if(info.size>vaultBackup.MAX_BYTES)throw new Error('This file is too large to be an Opaya Vault backup.');
    const keys=await vaultBackup.open(await fs.readFile(file,'utf8'),password),restored=[],skipped=[];
    const held=new Set(this.secrets.filter(s=>s.kept||s.global).map(s=>this.secretValue(s,true)).filter(Boolean));
    for(const k of keys.slice(0,2000)){
      if(held.has(k.value)){skipped.push({name:k.name,why:'already in the Vault'});continue;}
      try{const r=await this.holdFromUser({name:k.name,value:k.value,endpoint:k.endpoint});held.add(k.value);restored.push({id:r.id,name:r.name,mask:r.mask});}
      catch(error){skipped.push({name:k.name,why:String(error?.message||error).slice(0,160)});}
    }
    this.emit();return {restored,skipped,total:keys.length};
  }
  // A key already in the Opaya Vault, given to one agent.
  async giveHeldToAgent({id,agentId}={}){
    const s=this.secretEntry(id),agent=this.broker.agent(schema.id(agentId));
    const r=await this.storeSecret({secret:s.id,agent_id:agent.id,name:s.name},{approved:true});
    return {id:s.id,agent:agent.name,name:r.name||s.name,file:r.file||'',where:r.where,next:r.next,note:keyNote(r,s.name)};
  }
  async giveToAgent({agentId,name,value,endpoint}={}){
    const agent=this.broker.agent(schema.id(agentId)),held=await this.holdFromUser({name,value,endpoint});
    const r=await this.storeSecret({secret:held.id,agent_id:agent.id,name:held.name},{approved:true});
    return {id:held.id,name:r.name||held.name,file:r.file||'',where:r.where,next:r.next,note:keyNote(r,held.name)};
  }
  // A key given to Opaya (its key button, "all agents") is global: Opaya writes it into the config of every agent that
  // reads keys from a file or a login (Hermes, OpenClaw, Claude Code and Codex), on every machine and in
  // containers, and tells each connected agent in its chat. API connections keep their own token: a global key does
  // not replace it. Agents Opaya cannot write for are listed with the reason.
  async giveToAll({id}={}){
    const s=this.secretEntry(id),b=this.broker,done=[],skipped=[];
    s.global=true;await this.saveSecrets();
    for(const agent of b.data.agents){
      const kind=keyKindOf(agent);
      if(!kind){skipped.push({agent:agent.name,reason:agent.protocol==='openai'?'an API connection: it keeps its own token':'Opaya does not know where this agent reads keys'});continue;}
      try{const r=await this.storeSecret({secret:s.id,agent_id:agent.id,name:s.name,into:'agent_config'},{approved:true});done.push({agent:agent.name,agentId:agent.id,file:r.file||'',where:r.where,note:keyNote(r,s.name)});}
      catch(error){skipped.push({agent:agent.name,reason:String(error?.message||error).slice(0,200)});}
    }
    // Each connected, idle agent is told in its last chat; the others see the note when you send it from their chat.
    let told=0;
    for(const d of done)if(this.tellAgent(d.agentId,d.note))told++;
    this.emit();
    return {id:s.id,name:s.name,stored:done.map(({agentId,note,...x})=>x),skipped,told};
  }
  // Where each kind of agent reads keys on its machine: its Hermes home, OpenClaw's state folder, Claude Code's config.
  async configFile(kind,agent,where){
    const local=isLocal(where),home=this.userHome||os.homedir(),env=this.userHome?{}:process.env;
    // A Hermes home written as ~/...: the home folder where it runs (a file name is never left to the shell).
    const tilde=async p=>/^~([\\/]|$)/.test(p)?(local?home:await secrets.dirAt(where))+p.slice(1):p;
    if(kind==='hermes'){
      if(local&&(agent.hermesHome||this.userHome))return path.join(await tilde(agent.hermesHome||path.join(home,'.hermes')),'.env');
      const dir=await tilde(await sourceHome(agent,where).catch(error=>{if(local)return path.join(home,'.hermes');throw error;}));return local?path.join(dir,'.env'):path.posix.join(dir,'.env');
    }
    if(kind==='openclaw')return local?path.join(env.OPENCLAW_STATE_DIR||path.join(home,'.openclaw'),'.env'):path.posix.join(await secrets.dirAt(where,'${OPENCLAW_STATE_DIR:-$HOME/.openclaw}'),'.env');
    if(kind==='codex')return local?path.join(env.CODEX_HOME||path.join(home,'.codex'),'.env'):path.posix.join(await secrets.dirAt(where,'${CODEX_HOME:-$HOME/.codex}'),'.env');
    if(kind==='dsh')return local&&!where.container?path.join(env.DSH_HOME||path.join(home,'.dsh'),'.env'):path.posix.join(await secrets.dirAt(where,'${DSH_HOME:-$HOME/.dsh}'),'.env');
    return local?path.join(env.CLAUDE_CONFIG_DIR||path.join(home,'.claude'),'settings.json'):path.posix.join(await secrets.dirAt(where,'${CLAUDE_CONFIG_DIR:-$HOME/.claude}'),'settings.json');
  }
  // Pick a menu option by its text: read the screen, press the arrow key exactly as often as needed, check the
  // highlighted option, then Enter (space in a checklist). Searches or opens "More..." when the option is not listed.
  async choose(id,option){
    const want=String(option||'').trim();
    if(!want||want.length>200||/[\r\n\0\u001b]/.test(want))throw new Error('Give the text of the option to choose (one line).');
    const seen=[],moves=[];let searched=false,more=false,stale=0,dir='down';
    for(let round=0;round<24;round++){
      const shot=await this.screenOf(id);
      if(this.secretPrompt(shot))throw new Error('The terminal asks for a password, API key or token: answer with answer=secret and the id of a secret the user gave (request_secret first).');
      if(!shot.menu){
        const list=shot.numbered,i=list?screen.pick(list.options.map(o=>o.label),want):-1;
        if(i>=0){await this.keys(id,`${list.options[i].number}\r`);return {chose:list.options[i].label,by:`typed ${list.options[i].number}`};}
        throw new Error(`No menu option matching "${want}" is on the screen. ${list?`Options: ${list.options.map(o=>`${o.number}. ${o.label}`).join('; ')}.`:'Read the screen with read_terminal.'}`);
      }
      const {menu}=shot;
      for(const o of menu.options)if(!seen.includes(o))seen.push(o);
      const i=screen.pick(menu.options,want);
      if(i>=0){
        const delta=i-menu.active;
        if(delta===0){
          await this.keys(id,menu.checklist?' ':'\r');
          return {chose:menu.options[i],question:menu.question,pressed:[...moves,menu.checklist?'space (toggled; choose more, then answer enter)':'enter'].join(', ')};
        }
        moves.push(`${Math.abs(delta)}x ${delta>0?'down':'up'}`);
        await this.keys(id,screen.arrow(delta>0?'down':'up',shot.appCursor),Math.abs(delta));continue;
      }
      // Not in view: search when the menu can, open "More..." once, or scroll to the next page of a long list.
      if(menu.search&&!searched){searched=true;moves.push(`searched "${want}"`);await this.keys(id,(menu.search==='slash'?'/':'')+want);continue;}
      const other=menu.options.findIndex(o=>/^(more|other|show (all|more)|browse all)\b|^more…/i.test(o));
      if(other>=0&&!more&&!searched){
        more=true;const delta=other-menu.active;moves.push(`opened "${menu.options[other]}"`);
        if(delta)await this.keys(id,screen.arrow(delta>0?'down':'up',shot.appCursor),Math.abs(delta));
        const again=await this.screenOf(id);if(again.menu&&screen.pick([again.menu.options[again.menu.active]],menu.options[other])===0)await this.keys(id,'\r');
        continue;
      }
      // A long list shows a window of it: move a page past the window's edge (down first, then up for lists that do not
      // wrap around) until the option shows up or nothing new appears.
      const before=seen.length,len=menu.options.length,step=dir==='down'?len-1-menu.active+len:menu.active+len;
      await this.keys(id,screen.arrow(dir,shot.appCursor),Math.min(Math.max(1,step),60));
      const next=await this.screenOf(id);for(const o of next.menu?.options||[])if(!seen.includes(o))seen.push(o);
      if(seen.length===before&&++stale>=2){if(dir==='up')break;dir='up';stale=0;}
    }
    throw new Error(`"${want}" is not in this menu. Options: ${seen.slice(0,60).join('; ')}.`);
  }
  // What every tool returns to the model (terminal output and screens, files, agent errors, logs, its own errors):
  // values the user gave become their reference, and other keys of known formats are hidden.
  async tool(name,args){
    let result;try{result=await this.runTool(name,args);}catch(error){throw new Error(secrets.shieldOutput(String(error?.message||error),this.heldValues()));}
    const held=this.heldValues();return secrets.deep(result,text=>secrets.shieldOutput(text,held));
  }
  async runTool(name,args){
    const b=this.broker;
    switch(name){
      case 'get_workspace':{const s=b.snapshot();return {platform:this.platform,agents:s.agents.map(({id,name,displayName,provider,protocol,transport,hostId,endpoint,model,command,args,cwd,hermesHome,status,error,busy,hasToken,note,group,tags,pinned})=>({id,name,displayName,provider,protocol,transport,hostId,endpoint,model,command,args,cwd,hermesHome,status,error,busy,hasToken,note,group,tags,pinned})),machines:s.hosts,terminals:this.terminals.describe()};}
      case 'list_frameworks':return catalog.list().map(({id,kind,name,description,requires,after,local,remote,localCommand,remoteCommand})=>({id,kind,name,description,requires,after,installableHere:local,installableOnMachines:remote,localCommand,remoteCommand}));
      case 'discover_agents':{const r=await b.discover({hostId:args.machine_id?schema.id(args.machine_id):undefined});return {scope:r.scope,agents:(r.agents||[]).map(({name,provider,protocol,transport,endpoint,command,args,hermesHome,detail,readiness,existingId,hostId})=>({name,provider,protocol,transport,endpoint,command,args,hermesHome,detail,readiness,existingId,hostId})),warnings:r.warnings||[]};}
      case 'connect_agent':{const id=schema.id(args.agent_id);await b.connect(id).catch(()=>{});const r=b.runtimeFor(id);return {status:r.status,error:r.error||''};}
      case 'disconnect_agent':{const id=schema.id(args.agent_id);await b.disconnect(id);return {status:b.runtimeFor(id).status};}
      case 'clear_agent_error':return {cleared:b.clearError(schema.id(args.agent_id))};
      case 'read_terminal':{
        const id=schema.id(args.terminal_id),shot=await this.screenOf(id);
        return {output:(await this.terminalOutput(id)).slice(-Math.min(Math.max(Number(args.max_chars)||4000,200),6000)),screen:shot.text.slice(-4000),menu:shot.menu||undefined,numbered:shot.numbered||undefined};
      }
      case 'agent_diagnostics':{const d=await b.diagnostics(schema.id(args.agent_id));if(d.adapter)d.adapter={...d.adapter,entries:(d.adapter.entries||[]).slice(-60),stderr:String(d.adapter.stderr||'').slice(-3000)};d.hermesLogs=(d.hermesLogs||[]).map(l=>({...l,tail:String(l.tail).slice(-3000)}));return d;}
      case 'read_app_logs':{
        const read=file=>fs.readFile(path.join(this.root,file),'utf8').then(t=>t.slice(-4000)).catch(()=>'');
        return {startup:await read('startup-error.txt'),service:await read('service-startup-error.txt'),agentErrors:b.snapshot().agents.filter(a=>a.error).map(a=>({id:a.id,name:a.name,status:a.status,error:a.error}))};
      }
      case 'run_diagnostic':{
        const check=DIAGNOSTICS[args.check];if(!check)throw new Error('Unknown diagnostic.');const host=this.host(args.machine_id);
        const command=host||this.platform!=='win32'?check.posix:check.windows;
        const view=await this.runOwn({label:`Check / ${check.label}`,key:`check_${args.check}`,host,command,marked:true});
        return {terminal_id:view.id,output:await this.runOutput(view.id,host?30000:20000)};
      }
      case 'save_connection':{
        const input=args.connection&&typeof args.connection==='object'?args.connection:{};
        const existing=input.id?b.agent(input.id):null;
        const {token,apiKey,importToken,...clean}=input;
        const agent=schema.agent({...(existing||{}),...clean});
        await this.ask(existing?`Update connection "${existing.name}"?`:`Add connection "${agent.name}"?`,JSON.stringify(Object.fromEntries(Object.entries(agent).filter(([k,v])=>v!==''&&!(Array.isArray(v)&&!v.length)&&!['createdAt','avatar'].includes(k))),null,2));
        const wantToken=args.import_gateway_token===true;
        if(wantToken&&!(agent.protocol==='openai'&&(agent.provider==='openclaw'||(agent.provider==='hermes'&&agent.hermesHome))))throw new Error('Gateway tokens can be imported for Hermes (with hermesHome) and OpenClaw connections over the gateway API.');
        const saved=await b.saveAgent({agent,importToken:wantToken},{preapproved:!!this.trusted?.()});return {saved:{id:saved.id,name:saved.name},token:wantToken?'imported into the vault':undefined,note:wantToken?'Connect it with connect_agent.':'If the agent needs an API token: import a Hermes or OpenClaw gateway token by saving again with import_gateway_token, or ask the user for it with request_secret and save it with store_secret into=connection_token.'};
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
        const update=name==='update_framework',host=this.host(args.machine_id),how=update&&args.how?String(args.how):'auto';const {framework,command}=catalog.command(String(args.framework_id||''),{remote:!!host,update,how});
        // An update of Node.js, Python, uv, GitHub CLI or Git that Opaya's installer put on this computer goes through that
        // installer again (the update script stops for those copies with exit code 3).
        if(!host&&update&&how==='auto'&&this.builtinInstall&&updates.SPECS[framework.id]?.opaya&&this.opayaOwned(framework.id)){
          await this.ask(`Update ${framework.name} on this computer?`,"Opaya's installer put it there: Opaya downloads the latest official build, checks its checksum and replaces its copy (no administrator password).");
          const r=await this.builtinInstall(framework.id,{update:true});
          if(r)return {...r,finished:true};
        }
        // On this computer, Node.js, Python, uv, GitHub CLI and Git come from Opaya's built-in installer (official
        // downloads, checksums verified, no administrator password), not from a package manager script.
        if(!host&&!update&&this.builtinInstall&&['node','python','uv','gh','git','essentials'].includes(framework.id)){
          await this.ask(`Install ${framework.name} on this computer?`,'Opaya downloads the official build, checks its checksum and installs it for your user (no administrator password), then adds it to your PATH.');
          const r=await this.builtinInstall(framework.id);
          if(r)return {...r,finished:true,next:'Open a new terminal (or restart programs) so they see the new PATH. Agents started from Opaya see it right away.'};
        }
        await this.ask(`${update?'Update':'Install'} ${framework.name} ${host?`on ${host.name}`:'on this computer'}?`,`Runs in a visible terminal:\n\n${update?previewOf(command):command}\n\n${framework.requires&&!update?`Requires ${framework.requires}.\n`:''}Afterwards: ${framework.after}`);
        const view=await this.runOwn({label:`${update?'Update':'Install'} ${framework.name}`,key:`${update?'update':'install'}_${framework.id}`,host,command,marked:true});
        return {terminal_id:view.id,started:true,next:framework.after,hint:'Call wait_for_terminal with this terminal_id to follow it to the end; answer installer questions with answer_prompt.',output:await this.terminalOutput(view.id,4000)};
      }
      case 'setup_agent':{
        const agent=args.agent_id?b.agent(schema.id(args.agent_id)):null;
        const host=agent?(agent.transport==='ssh'?this.host(agent.hostId):null):this.host(args.machine_id);
        const docker=agent?.command==='docker'?agent.args[dockerExecContainerIndex(agent.args||[])]||'':'';
        const s=catalog.setupCommand(String(args.framework_id||''),String(args.step||''),{remote:!!host,windows:!host&&!docker&&this.platform==='win32',hermesHome:agent?.hermesHome||'',container:docker});
        const where=`${docker?`in container ${docker} `:''}${host?`on ${host.name}`:'on this computer'}`;
        const verb={sign_in:'Sign in to',model:'Choose the model of',use_claude_login:'Set up with the Claude Code login:',use_codex_login:'Set up with the ChatGPT (Codex) login:',enable_api:'Turn on the gateway API of',start_gateway:'Start the gateway of',status:'Check'}[s.step];
        if(s.step!=='status')await this.ask(`${verb} ${s.framework.name} ${where}?`,`Runs in a visible terminal:\n\n${s.command}${s.note?`\n\n${s.note}`:''}`);
        const view=await this.runOwn({label:`${verb} ${s.framework.name}`,key:`setup_${s.framework.id}_${s.step}`,host,command:s.command,marked:true});
        const wizard='Follow it with wait_for_terminal and pick menu options with answer_prompt choose (the option text; prefer the provider the user is already signed in to). When it asks for an API key, token or password, type one the user gave with answer_prompt answer=secret secret=<id> (ask for it with request_secret first when there is none); never ask the user to paste it into the terminal. A browser sign-in: tell the user exactly what to do, then keep waiting.';
        const next={sign_in:wizard,model:wizard,use_claude_login:'Follow it with wait_for_terminal to the end, then enable_api and start_gateway.',use_codex_login:'Follow it with wait_for_terminal to the end, then set the default model and enable_api and start_gateway.',enable_api:'Then start_gateway (or restart it), save_connection over the gateway API with import_gateway_token, and connect_agent.',start_gateway:'Then discover_agents, save_connection with import_gateway_token, and connect_agent.',status:'Read the output.'}[s.step];
        return {terminal_id:view.id,started:true,note:s.note||undefined,next,output:s.step==='status'?await this.runOutput(view.id,host?30000:20000):await this.terminalOutput(view.id,4000)};
      }
      case 'run_command':{
        const host=this.host(args.machine_id),command=String(args.command||'').trim(),why=String(args.why||'').slice(0,300);
        if(!command||command.length>4000||command.includes('\0'))throw new Error('Give one command, up to 4000 characters.');
        if(/\[(secret S\d|hidden )/.test(command))throw new Error('A command never carries a secret: it would show in the terminal and its history. Save it where the agent reads it with store_secret, or start the program and type it into its prompt with answer_prompt answer=secret.');
        await this.ask(`Run a command ${host?`on ${host.name}`:'on this computer'}?`,`${why?why+'\n\n':''}Runs in a visible terminal:\n\n${command}`);
        const view=await this.runOwn({label:'Opaya Agent commands',key:'cmd',host,command,marked:true});
        return {terminal_id:view.id,started:true,hint:'Call wait_for_terminal with this terminal_id to follow it to the end; answer questions with answer_prompt.',output:await this.terminalOutput(view.id,3000)};
      }
      case 'open_app':{
        const target=String(args.target||'').trim();
        if(!target||target.length>300||/[\r\n\0]/.test(target)||(!/^https?:\/\//i.test(target)&&!/^[\w .+()-]{1,80}$/.test(target)))throw new Error('Give an https:// link or an app name.');
        if(/^http:\/\//i.test(target)&&!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/i.test(target))throw new Error('Open https:// links (or http://localhost).');
        await this.ask(`Open ${target}?`,String(args.why||'').slice(0,300)||'Opens it on this computer.');
        const {file,args:argv,verbatim}=openCommand(target,this.platform);
        await new Promise((resolve,reject)=>{const child=this.spawnProcess(file,argv,{verbatim});child.on('error',reject);child.on('spawn',resolve);setTimeout(resolve,1500);});
        return {opened:target};
      }
      case 'wait_for_terminal':{
        const id=schema.id(args.terminal_id),limit=Math.min(Math.max(Number(args.seconds)||90,5),180)*1000,start=Date.now();
        let last=null,quietSince=Date.now(),state,shot=null,exited=false;
        for(;;){
          const view=this.terminals.attach(id),output=this.runText(id,stripAnsi(view.buffer));state=this.runState(id,output);exited=!!view.exited;
          if(output!==last){last=output;quietSince=Date.now();shot=null;}
          const quiet=Date.now()-quietSince;
          if(state.finished||exited)break;
          // Quiet for a moment: look at the screen. A menu or a prompt there is a question; a secret prompt is for the user.
          if(quiet>=1200){
            shot=shot||await this.screenOf(id);
            const onScreen=promptState(shot.text);
            if(this.secretPrompt(shot))state={...state,password:true,question:false};
            else if(shot.menu||shot.numbered||onScreen.question)state={...state,question:true};
            if((state.question||state.password)&&quiet>=1500)break;
          }
          if(Date.now()-start>=limit)break;
          await new Promise(r=>setTimeout(r,700));
        }
        shot=shot||await this.screenOf(id);
        const menu=shot.menu?{question:shot.menu.question,options:shot.menu.options,highlighted:shot.menu.options[shot.menu.active],checklist:shot.menu.checklist||undefined,filter:shot.menu.filter||undefined}:undefined;
        return {...state,exited:exited||undefined,waited_seconds:Math.round((Date.now()-start)/1000),menu,numbered:shot.numbered||undefined,
          screen:state.finished?undefined:shot.text.slice(-3000),output:last.slice(state.finished?-4000:-1500),
          next:state.password?'It asks for a password, API key or token. Type one the user gave with answer_prompt answer=secret secret=<id>; when there is none, ask for it with request_secret (named after what the prompt asks for), then type it. Do not ask the user to paste a key into the terminal.':menu?'Pick with answer_prompt answer=choose and option=<the option text> (Opaya presses the arrow keys exactly as needed). Pick what the user already signed in to (run_diagnostic logins) unless they said otherwise.':state.question?'Answer with answer_prompt.':state.finished?(state.exit_code===0?'Done. Continue with the next step.':'It failed. Read the output, fix the cause (often a missing dependency) and try again.'):exited?'The terminal closed.':'Still running. Call wait_for_terminal again.'};
      }
      case 'answer_prompt':{
        const id=schema.id(args.terminal_id);if(!this.ownTerminals.has(id))throw new Error('You can only answer prompts in terminals you started.');
        const answer=String(args.answer||''),shot=await this.screenOf(id);
        if(answer==='secret')return this.typeSecret(id,args.secret,shot);
        // A value the model wrote never goes into a secret prompt: only one the user gave, through answer=secret.
        if(answer!=='ctrl_c'&&await this.asksSecret(id,shot))throw new Error('The terminal is asking for a password, API key or token. Type one the user gave with answer=secret and secret=<id> (request_secret first when there is none); Opaya never types a value you wrote there.');
        if(answer==='choose'){
          const r=await this.choose(id,args.option);this.status=`Chose ${r.chose}`;this.emit();
          const after=await this.screenOf(id);
          return {...r,screen:after.text.slice(-2500),menu:after.menu?{question:after.menu.question,options:after.menu.options,highlighted:after.menu.options[after.menu.active]}:undefined};
        }
        const keys={enter:'\r',y:'y\r',n:'n\r',yes:'yes\r',no:'no\r',up:screen.arrow('up',shot.appCursor),down:screen.arrow('down',shot.appCursor),space:' ',tab:'\t',q:'q',esc:'\u001b',ctrl_c:'\u0003'};
        let data=keys[answer]??(/^[1-9]$/.test(answer)?answer+'\r':null);
        if(answer==='text'){
          const text=String(args.text??'');if(!text||text.length>500||/[\r\n\0\u001b]/.test(text))throw new Error('Type one line of plain text, up to 500 characters.');
          if(/\[(secret S\d|hidden )/.test(text))throw new Error('Type a secret with answer=secret and its id, never as text.');data=text+'\r';
        }
        if(data===null)throw new Error('Unsupported answer.');
        const times=['up','down'].includes(answer)?Math.min(Math.max(Number(args.times)||1,1),60):1;
        await this.keys(id,data,times);this.status=`Answered ${answer==='text'?'with typed text':answer} in the terminal`;this.emit();
        const after=await this.screenOf(id);
        return {sent:times>1?`${times}x ${answer}`:answer,screen:after.text.slice(-2500),menu:after.menu?{question:after.menu.question,options:after.menu.options,highlighted:after.menu.options[after.menu.active]}:undefined,output:(await this.terminalOutput(id)).slice(-1500)};
      }
      case 'request_secret':return this.requestSecret(args);
      case 'store_secret':return this.storeSecret(args);
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
        const view=await this.runInTerminal({label:`SSH key ${name}`,key:`sshkey_${name}`,host:null,command});this.ownTerminals.add(view.id);
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
      case 'vault':return this.vaultOp(args);
      case 'docker':{
        const host=this.host(args.machine_id),op=String(args.op||''),c=String(args.container||'');
        if(op==='list'){const r=await dockerManager.list(host);return r.running?{version:r.version,containers:r.containers.slice(0,100),images:r.images.slice(0,100)}:r;}
        if(op==='logs')return {container:c,logs:stripAnsi(await dockerManager.logs(host,c,args.lines)).slice(-20000)};
        if(op==='open_shell'){const view=await this.app('dockerTerminal',{hostId:host?.id||'',container:c,kind:'shell'});return {terminal_id:view.id,note:'The user sees a shell inside the container.'};}
        const action=op==='remove_image'?'remove-image':op,where=host?host.name:'this computer';
        await this.ask(`${{start:'Start',stop:'Stop',restart:'Restart',remove:'Remove container','remove-image':'Remove image'}[action]||op} ${c} on ${where}?`,`docker ${action==='remove'?'rm -f':action==='remove-image'?'rmi':action} ${c}${action==='remove'?'\n\nThe container and everything inside it that is not in a volume are deleted.':''}`,{always:action==='remove'||action==='remove-image'});
        await dockerManager.act(host,{container:c,action});this.broker.changed?.();return {done:true,action,container:c};
      }
      case 'backup_agent':{const a=b.agent(schema.id(args.agent_id));await this.ask(`Back up ${a.name}?`,`Saves its data${args.api_keys===false?' without API keys':' with API keys'}${args.history===false?', without chat history':''} into Opaya's backup folder on this computer.`);return jobOf(await this.app('agentBackup',{id:a.id,keys:args.api_keys!==false,history:args.history!==false}));}
      case 'uninstall_agent':{const a=b.agent(schema.id(args.agent_id));return jobOf(await this.app('agentUninstall',{id:a.id,data:!!args.delete_data,backup:args.backup!==false,removeConnection:!!args.remove_connection}));}
      case 'update_agent':{if(args.all)return {installations:await this.app('agentUpdateAll',{}),note:'They run one after another in each machine\'s Updates terminal; failures come back to you.'};const a=b.agent(schema.id(args.agent_id));await this.app('agentUpdate',{id:a.id});return {started:true,note:'It runs in the machine\'s Updates terminal; read_terminal shows it, and a failure comes back to you.'};}
      case 'clone_agent':{
        const a=b.agent(schema.id(args.agent_id)),host=this.host(args.machine_id),runtime=['regular','profile','docker'].includes(args.runtime)?args.runtime:'regular',what=['everything','personality','skills','memory'].includes(args.what)?args.what:'everything';
        await this.ask(`Clone ${a.name}?`,`${what==='personality'?'Skills + personality':what[0].toUpperCase()+what.slice(1)}${args.api_keys===false?' without API keys':' with API keys'} to ${host?host.name:'this computer'} as ${runtime==='docker'?'a new Docker container':runtime==='profile'?(args.container?`a profile in container ${args.container}`:'a Hermes profile'):'a regular install'}${args.name?` named ${args.name}`:''}.`);
        return jobOf(await this.app('cloneAgent',{id:a.id,name:String(args.name||''),hostId:host?.id||'',runtime,container:String(args.container||''),scope:what,keys:args.api_keys!==false,...(args.cron===undefined?{}:{cron:!!args.cron})}));
      }
      case 'transfer':{
        const from=b.agent(schema.id(args.from_agent_id)),to=b.agent(schema.id(args.to_agent_id)),list=v=>v==='all'?'all':Array.isArray(v)&&v.length?v.map(String):undefined;
        const x={sourceId:from.id,targetId:to.id,skills:list(args.skills),keys:list(args.api_keys),mcp:Array.isArray(args.mcp_server_ids)?args.mcp_server_ids.map(String):[],token:!!args.api_token};
        const parts=[x.skills&&`skills (${x.skills==='all'?'all':x.skills.join(', ')})`,x.keys&&`API keys (${x.keys==='all'?'all':x.keys.join(', ')})`,x.mcp.length&&`${x.mcp.length} MCP server(s)`,x.token&&'the Opaya API token'].filter(Boolean);
        if(!parts.length)throw new Error('Say what to transfer: skills, api_keys, mcp_server_ids or api_token.');
        await this.ask(`Copy to ${to.name}?`,`From ${from.name} to ${to.name}: ${parts.join(', ')}. Key values never go through the chat.`);
        return jobOf(await this.app('transferStart',x));
      }
      case 'mcp_server':{
        const op=String(args.op||'');
        if(op==='catalog')return {servers:(await this.app('mcpCatalog',{})).map(({id,title,description,needs,secret,folder})=>({id,name:title,description,needs,secret,folder}))};
        if(op==='install'){
          const secret=args.secret?this.secretValue(this.secretEntry(args.secret)):'',agents=args.agents==='all'||args.agents===undefined?'all':[].concat(args.agents).map(x=>b.agent(schema.id(x)).id);
          await this.ask(`Add the ${args.server} MCP server?`,`For ${agents==='all'?'all agents':agents.map(id=>b.agent(id).name).join(', ')}${args.folder?`, folder ${args.folder}`:''}${args.secret?', with the key the user gave (stored in the vault)':''}.`);
          const r=await this.app('mcpInstall',{id:String(args.server||''),secret,folder:String(args.folder||''),agents});return {installed:true,server:r?.name||args.server};
        }
        if(op==='enable'||op==='disable'){const a=b.agent(schema.id(args.agent_id));await this.ask(`${op==='enable'?'Turn on':'Turn off'} ${args.server} for ${a.name}?`,'New conversations pick up the change.');await this.app('agentMcp',{agentId:a.id,serverId:String(args.server||''),enabled:op==='enable'});return {done:true};}
        if(op==='remove'){await this.ask(`Remove the MCP server ${args.server}?`,'Every agent stops using it from its next conversation.',{always:true});await this.app('mcpRemove',{id:String(args.server||'')});return {removed:true};}
        throw new Error('Unknown op.');
      }
      case 'jobs':{const all=await this.app('jobs',{}),list=args.job_id?all.filter(j=>j.id===args.job_id):all;return {jobs:list.slice(-10).map(jobOf)};}
      case 'read_notes':return {notes:await fs.readFile(path.join(this.home,'notes.md'),'utf8').catch(()=>'')};
      case 'write_notes':{const content=String(args.content??'');if(content.length>20000||content.includes('\0'))throw new Error('Notes must be under 20000 characters.');await fs.writeFile(path.join(this.home,'notes.md'),content,{mode:0o600});return {saved:true};}
      default:throw new Error('Unknown tool.');
    }
  }
}
module.exports={OpayaAgent,PRESETS,TOOLS,DIAGNOSTICS,stripAnsi,promptState,INSTALL_PROCEDURE,APP_GUIDE};
