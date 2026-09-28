'use strict';
const quote=v=>"'"+String(v).replace(/'/g,"'\\''")+"'";
// Installable agent frameworks. Commands are fixed strings from the vendors' published install instructions; nothing
// from the UI or the Opaya Agent is ever interpolated into them. Installs run in a visible terminal after approval.
const FRAMEWORKS = [
  {id:'hermes', name:'Hermes Agent', provider:'hermes', icon:'hermes', description:'Nous Research agent with gateway API, ACP, memory and profiles.',
    docs:'https://hermes-agent.nousresearch.com/docs/', after:'Run `hermes setup`, then `hermes gateway` for the API. Discover adds it.',
    posix:'curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash', windows:'irm https://hermes-agent.nousresearch.com/install.ps1 | iex'},
  {id:'claude', name:'Claude Code', provider:'claude', icon:'claude', description:"Anthropic's coding agent CLI.",
    docs:'https://code.claude.com/docs/en/setup', after:'Run `claude` once to sign in. Discover adds it.',
    posix:'curl -fsSL https://claude.ai/install.sh | bash', windows:'irm https://claude.ai/install.ps1 | iex'},
  {id:'codex', name:'Codex CLI', provider:'codex', icon:'codex', description:"OpenAI's coding agent with app-server protocol.",
    docs:'https://developers.openai.com/codex/cli', after:'Run `codex` once to sign in. Discover adds it.', requires:'Node.js 18+',
    posix:'npm install -g @openai/codex || { mkdir -p ~/.npm-global && npm config set prefix ~/.npm-global && npm install -g @openai/codex; }', windows:'npm.cmd install -g @openai/codex'},
  {id:'openclaw', name:'OpenClaw', provider:'openclaw', icon:'openclaw', description:'Personal agent gateway with an OpenAI-compatible API.',
    docs:'https://docs.openclaw.ai/', after:'Run `openclaw onboard`, then start its gateway. Discover adds it.', requires:'Node.js 24+',
    posix:'npm install -g openclaw@latest || { mkdir -p ~/.npm-global && npm config set prefix ~/.npm-global && npm install -g openclaw@latest; }', windows:'npm.cmd install -g openclaw@latest'},
  {id:'opencode', name:'OpenCode', provider:'custom', icon:'opencode', command:'opencode', description:'Open-source coding agent for the terminal.',
    docs:'https://opencode.ai/docs/', after:'Run `opencode auth login`. Discover adds it; Opaya chats with it over ACP.', requires:'Node.js 18+',
    posix:'npm install -g opencode-ai || { mkdir -p ~/.npm-global && npm config set prefix ~/.npm-global && npm install -g opencode-ai; }', windows:'npm.cmd install -g opencode-ai'},
  {id:'goose', name:'Goose', provider:'custom', icon:'goose', command:'goose', description:'Extensible open-source agent from Block.',
    docs:'https://block.github.io/goose/', after:'Run `goose configure`. Add it as a terminal agent.',
    posix:'curl -fsSL https://github.com/block/goose/releases/download/stable/download_cli.sh | bash', windows:''},
  {id:'aider', name:'Aider', provider:'custom', icon:'', command:'aider', description:'AI pair programming in your terminal.',
    docs:'https://aider.chat/docs/install.html', after:'Run `aider` inside a git repository. Add it as a terminal agent.', requires:'Python 3.9+',
    posix:'python3 -m pip install --user aider-install && aider-install', windows:'py -m pip install aider-install; aider-install'},
  {id:'ollama', name:'Ollama', provider:'custom', icon:'ollama', command:'ollama', runtime:true, description:'Local model runtime. Useful as the Opaya Agent model.',
    docs:'https://ollama.com/download', after:'Run `ollama pull <model>`. Point the Opaya Agent at http://127.0.0.1:11434/v1.',
    posix:'if [ "$(uname)" = Darwin ]; then mkdir -p "$HOME/Applications" && curl -fsSL -o /tmp/Ollama-darwin.zip https://ollama.com/download/Ollama-darwin.zip && ditto -x -k /tmp/Ollama-darwin.zip "$HOME/Applications" && open -a "$HOME/Applications/Ollama.app" && echo \'Ollama is installed in your Applications folder.\'; else curl -fsSL https://ollama.com/install.sh | sh; fi', windows:"if (Get-Command winget -ErrorAction SilentlyContinue) { winget install --id Ollama.Ollama -e --accept-source-agreements --accept-package-agreements } else { $ProgressPreference='SilentlyContinue'; Invoke-WebRequest https://ollama.com/download/OllamaSetup.exe -OutFile \"$env:TEMP\\OllamaSetup.exe\" -UseBasicParsing; Start-Process \"$env:TEMP\\OllamaSetup.exe\" -ArgumentList '/VERYSILENT','/NORESTART' -Wait; 'Ollama is installed.' }"},
  // Dependencies agents need. Each command skips what is already installed; the essentials bundle runs them in order.
  {id:'node', kind:'dependency', name:'Node.js LTS', provider:'custom', icon:'', description:'Runtime for Codex, OpenClaw and OpenCode (includes npm).', docs:'https://nodejs.org/en/download', after:'Open a new terminal so npm is on PATH.',
    posix:"if command -v node >/dev/null 2>&1; then echo 'node is already installed'; elif command -v brew >/dev/null 2>&1; then brew install node; elif command -v apt-get >/dev/null 2>&1; then curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash - && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs; elif command -v dnf >/dev/null 2>&1; then sudo dnf install -y nodejs npm; else echo 'Installing Node.js LTS with nvm (no administrator password needed)'; export NVM_DIR=\"$HOME/.nvm\"; [ \"$(uname)\" = Darwin ] && touch \"$HOME/.zshrc\"; curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash && . \"$NVM_DIR/nvm.sh\" && nvm install --lts && nvm alias default 'lts/*'; fi", windows:"if (-not (Get-Command node -ErrorAction SilentlyContinue)) { winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements; $env:Path=[Environment]::GetEnvironmentVariable('Path','Machine')+';'+[Environment]::GetEnvironmentVariable('Path','User') } else { 'node is already installed' }"},
  {id:'python', kind:'dependency', name:'Python 3', provider:'custom', icon:'', description:'Runtime for Hermes tools, Aider and the remote file browser (includes pip).', docs:'https://www.python.org/downloads/', after:'Open a new terminal so python and pip are on PATH.',
    posix:"if command -v python3 >/dev/null 2>&1; then echo 'python3 is already installed'; elif command -v brew >/dev/null 2>&1; then brew install python; elif command -v apt-get >/dev/null 2>&1; then sudo apt-get update && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y python3 python3-pip python3-venv; elif command -v dnf >/dev/null 2>&1; then sudo dnf install -y python3 python3-pip; else echo 'No supported package manager found (Homebrew, apt or dnf).'; fi", windows:"if (-not (Get-Command py -ErrorAction SilentlyContinue)) { winget install --id Python.Python.3.12 -e --accept-source-agreements --accept-package-agreements; $env:Path=[Environment]::GetEnvironmentVariable('Path','Machine')+';'+[Environment]::GetEnvironmentVariable('Path','User') } else { 'python is already installed' }"},
  {id:'git', kind:'dependency', name:'Git', provider:'custom', icon:'', description:'Needed by coding agents and by most installers.', docs:'https://git-scm.com/downloads', after:'Open a new terminal so git is on PATH.',
    posix:"if command -v git >/dev/null 2>&1; then echo 'git is already installed'; elif command -v brew >/dev/null 2>&1; then brew install git; elif command -v apt-get >/dev/null 2>&1; then sudo apt-get update && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y git; elif command -v dnf >/dev/null 2>&1; then sudo dnf install -y git; else echo 'No supported package manager found (Homebrew, apt or dnf).'; fi", windows:"if (-not (Get-Command git -ErrorAction SilentlyContinue)) { winget install --id Git.Git -e --accept-source-agreements --accept-package-agreements; $env:Path=[Environment]::GetEnvironmentVariable('Path','Machine')+';'+[Environment]::GetEnvironmentVariable('Path','User') } else { 'git is already installed' }"},
  {id:'uv', kind:'dependency', name:'uv', provider:'custom', icon:'', description:'Fast Python package and tool manager used by Python agents.', docs:'https://docs.astral.sh/uv/', after:'Open a new terminal so uv is on PATH.',
    posix:"command -v uv >/dev/null 2>&1 && echo 'uv is already installed' || curl -LsSf https://astral.sh/uv/install.sh | sh", windows:"if (-not (Get-Command uv -ErrorAction SilentlyContinue)) { irm https://astral.sh/uv/install.ps1 | iex; $env:Path=[Environment]::GetEnvironmentVariable('Path','Machine')+';'+[Environment]::GetEnvironmentVariable('Path','User') } else { 'uv is already installed' }"},
  {id:'tmux', kind:'dependency', name:'tmux', provider:'custom', icon:'', description:'Keeps remote terminals alive when the SSH connection drops.', docs:'https://github.com/tmux/tmux/wiki/Installing', after:'Remote terminals now survive disconnects.',
    posix:"if command -v tmux >/dev/null 2>&1; then echo 'tmux is already installed'; elif command -v brew >/dev/null 2>&1; then brew install tmux; elif command -v apt-get >/dev/null 2>&1; then sudo apt-get update && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y tmux; elif command -v dnf >/dev/null 2>&1; then sudo dnf install -y tmux; else echo 'No supported package manager found (Homebrew, apt or dnf).'; fi", windows:''},
  {id:'openssh', kind:'dependency', name:'OpenSSH client', provider:'custom', icon:'', description:'Needed to connect to VPS machines. Windows asks for administrator approval.', docs:'https://learn.microsoft.com/windows-server/administration/openssh/openssh_install_firstuse', after:'Restart Opaya so the SSH client is found.',
    posix:"if command -v ssh >/dev/null 2>&1; then echo 'ssh is already installed'; elif command -v brew >/dev/null 2>&1; then brew install openssh; elif command -v apt-get >/dev/null 2>&1; then sudo apt-get update && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y openssh-client; elif command -v dnf >/dev/null 2>&1; then sudo dnf install -y openssh-clients; else echo 'No supported package manager found (Homebrew, apt or dnf).'; fi", windows:"if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) { Start-Process powershell -Verb RunAs -Wait -ArgumentList '-NoProfile','-Command','Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0' } else { 'ssh is already installed' }"},
  {id:'gh', kind:'dependency', name:'GitHub CLI', provider:'custom', icon:'', description:'gh: pull requests, checks and GitHub sign-in for the Projects panel.', docs:'https://cli.github.com', after:'Run `gh auth login` once (Projects > right-click > Sign in to GitHub CLI).',
    posix:"if command -v gh >/dev/null 2>&1; then echo 'gh is already installed'; elif command -v brew >/dev/null 2>&1; then brew install gh; elif command -v apt-get >/dev/null 2>&1; then sudo apt-get update && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y gh; elif command -v dnf >/dev/null 2>&1; then sudo dnf install -y gh; else echo 'Install GitHub CLI from https://cli.github.com'; fi", windows:"if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { winget install --id GitHub.cli -e --accept-source-agreements --accept-package-agreements; $env:Path=[Environment]::GetEnvironmentVariable('Path','Machine')+';'+[Environment]::GetEnvironmentVariable('Path','User') } else { 'gh is already installed' }"},
  {id:'docker', kind:'dependency', name:'Docker', provider:'custom', icon:'', description:'Runs agents in containers. On Linux servers Opaya installs Docker Engine and adds your user to the docker group.', docs:'https://docs.docker.com/engine/install/', after:'Log out and back in (or reconnect) so your user can use Docker.',
    posix:"if command -v docker >/dev/null 2>&1; then echo 'docker is already installed'; elif [ \"$(uname)\" = Linux ]; then curl -fsSL https://get.docker.com | sudo sh && sudo usermod -aG docker \"$USER\" && echo 'Docker is installed. Reconnect so your user can use it.'; elif command -v brew >/dev/null 2>&1; then brew install --cask docker && echo 'Open Docker Desktop once to finish.'; else echo 'Install Docker Desktop from https://www.docker.com/products/docker-desktop/'; fi", windows:"if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { winget install --id Docker.DockerDesktop -e --accept-source-agreements --accept-package-agreements } else { 'docker is already installed' }"},
  {id:'homebrew', kind:'dependency', name:'Homebrew', provider:'custom', icon:'', description:'macOS package manager used to install the other dependencies.', docs:'https://brew.sh', after:'Follow the printed "Next steps" to add brew to PATH.', macOnly:true,
    posix:'command -v brew >/dev/null 2>&1 && echo "brew is already installed" || /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"', windows:''}
];
// Updates to the latest version. Same rules as installs: fixed commands, nothing interpolated. Each script finds how the
// tool is installed on the machine (Homebrew, the npm that owns it, npx, the vendor's updater, uv, pipx, winget...) and
// updates that copy (updates.cjs). `how` forces one method (the Opaya Agent, after the detected one failed).
const updates=require('./updates.cjs');
const UPDATES=Object.fromEntries(FRAMEWORKS.filter(f=>updates.SPECS[f.id]).map(f=>[f.id,{posix:updates.script(f.id),windows:updates.script(f.id,{windows:true})}]));
// In sh like the other updates, so it works from any login shell (fish too) and leaves its PATH alone.
UPDATES.homebrew={posix:`sh -c '${updates.TOOL_PATH}; brew update && brew upgrade'`,windows:''};
const ESSENTIALS=['node','python','git','uv','tmux'];
const available=(f,remote)=>remote||process.platform!=='win32'?!!f.posix&&!(f.macOnly&&(remote||process.platform!=='darwin')):!!f.windows;
function list(){const containers=require('./containers.cjs');return [...FRAMEWORKS.map(({posix,windows,...f})=>({kind:'agent',...f,docker:containers.supported(f.id),builtin:require('./toolchain.cjs').supports(f.id)&&(f.id!=='git'||process.platform!=='linux'),local:available({posix,windows,...f},false),remote:available({posix,windows,...f},true),localCommand:process.platform==='win32'?windows:posix,remoteCommand:posix})),
  {id:'essentials',kind:'bundle',name:'All essentials',provider:'custom',icon:'',description:`Installs whatever is missing of ${ESSENTIALS.map(id=>FRAMEWORKS.find(f=>f.id===id)).filter(f=>available(f,false)).map(f=>f.name).join(', ')}.`,after:'Open a new terminal, then install agents.',local:true,remote:true,localCommand:command('essentials',{remote:false}).command,remoteCommand:command('essentials',{remote:true}).command}];}
function command(id,{remote,update=false,how='auto'}){
  if(update)return updateCommand(id,{remote,how});
  if(id==='essentials'){
    const parts=ESSENTIALS.map(id=>FRAMEWORKS.find(f=>f.id===id)).filter(f=>available(f,remote)).map(f=>remote||process.platform!=='win32'?f.posix:f.windows);
    return {framework:{id:'essentials',name:'All essentials',after:'Open a new terminal, then install agents.'},command:parts.map(p=>remote||process.platform!=='win32'?`(${p})`:`& {${p}}`).join(remote||process.platform!=='win32'?'; ':'; ')};
  }
  const f=FRAMEWORKS.find(f=>f.id===id);if(!f)throw new Error('Unknown agent framework.');
  if(!available(f,remote))throw new Error(`${f.name} is not available ${remote?'on remote machines':'on this system'}.`);
  const value=remote||process.platform!=='win32'?f.posix:f.windows;
  if(!value)throw new Error(`${f.name} has no native ${remote?'remote':'Windows'} installer. Install it on a Linux or macOS machine (or WSL) instead.`);
  return {framework:f,command:value};
}
function updateCommand(id,{remote,how='auto'}){
  const posix=remote||process.platform!=='win32';
  if(id==='essentials'){
    const parts=ESSENTIALS.map(e=>UPDATES[e]?.[posix?'posix':'windows']).filter(Boolean);
    return {framework:{id:'essentials',name:'All essentials',after:'Everything that was installed is now up to date.'},command:parts.map(p=>posix?`(${p})`:`& {${p}}`).join('; ')};
  }
  const f=FRAMEWORKS.find(f=>f.id===id);if(!f)throw new Error('Unknown agent framework.');
  const value=how&&how!=='auto'&&updates.SPECS[id]?updates.script(id,{windows:!posix,how}):UPDATES[id]?.[posix?'posix':'windows'];
  if(!value||!available(f,remote))throw new Error(`Opaya has no ${remote?'remote':posix?'':'Windows '}update command for ${f.name}. Install it again to get the latest version.`.replace('  ',' '));
  return {framework:{...f,after:`${f.name} is up to date.`},command:value};
}
// Onboarding and gateways, so the Opaya Agent can finish an agent's setup after installing it. Same rules as installs:
// fixed vendor commands in a visible terminal; the user types passwords, API keys and browser sign-ins there.
// sign_in: the vendor's own setup wizard. enable_api: turn on the OpenAI-compatible API Opaya chats through (Hermes gets
// a random API_SERVER_KEY that is written to its .env, never printed; Opaya imports it into its vault).
// start_gateway: start the gateway in the background (its service when installed). status: read-only check.
const HERMES_WIN_HOME="$h=if($env:HERMES_HOME){$env:HERMES_HOME}elseif(Test-Path \"$env:LOCALAPPDATA\\hermes\\.env\"){\"$env:LOCALAPPDATA\\hermes\"}else{\"$HOME\\.hermes\"}";
const SETUP={
  hermes:{
    sign_in:{posix:'hermes setup',windows:'hermes setup',note:'hermes setup first asks how to set up: Quick Setup (Nous Portal, free sign-in) is highlighted; choose "Full setup" to pick another provider. In Select provider, OpenAI > "ChatGPT or Codex Subscription" offers to import the Codex login ("Import these credentials?" y), and Anthropic offers "Use existing credentials" from Claude Code. The user types API keys in the terminal.'},
    model:{posix:'hermes model',windows:'hermes model',note:'Only the provider and model menus of hermes setup. The same logins can be reused there.'},
    enable_api:{
      posix:`h="\${HERMES_HOME:-$HOME/.hermes}"; mkdir -p "$h" && f="$h/.env" && touch "$f" && chmod 600 "$f" && if grep -q '^API_SERVER_ENABLED=' "$f"; then sed -i.opaya 's/^API_SERVER_ENABLED=.*/API_SERVER_ENABLED=true/' "$f" && rm -f "$f.opaya"; else echo 'API_SERVER_ENABLED=true' >> "$f"; fi && { grep -q '^API_SERVER_KEY=.' "$f" || echo "API_SERVER_KEY=$(openssl rand -hex 32 2>/dev/null || od -An -N32 -tx1 /dev/urandom | tr -d ' \\n')" >> "$f"; } && echo "Gateway API enabled in $f (API_SERVER_ENABLED=true, API_SERVER_KEY set). Restart the gateway to use it."`,
      windows:`${HERMES_WIN_HOME}; New-Item -ItemType Directory -Force $h | Out-Null; $f=Join-Path $h '.env'; if(-not (Test-Path $f)){New-Item -ItemType File $f | Out-Null}; $lines=@(Get-Content $f | Where-Object { $_ -notmatch '^API_SERVER_ENABLED=' }); $lines+='API_SERVER_ENABLED=true'; if(-not ($lines | Where-Object { $_ -match '^API_SERVER_KEY=.' })){ $b=New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); $lines+='API_SERVER_KEY='+(-join ($b | ForEach-Object { '{0:x2}' -f $_ })) }; Set-Content -Path $f -Value $lines; "Gateway API enabled in $f (API_SERVER_ENABLED=true, API_SERVER_KEY set). Restart the gateway to use it."`},
    start_gateway:{
      posix:`hermes gateway start 2>/dev/null || { h="\${HERMES_HOME:-$HOME/.hermes}"; mkdir -p "$h/logs"; nohup hermes gateway run >> "$h/logs/opaya-gateway.log" 2>&1 & sleep 6; }; hermes gateway status`,
      windows:`hermes gateway start; if ($LASTEXITCODE -ne 0) { Start-Process hermes -ArgumentList 'gateway','run' -WindowStyle Hidden; Start-Sleep 6 }; hermes gateway status`},
    status:{posix:'hermes status; hermes gateway status',windows:'hermes status; hermes gateway status'}},
  openclaw:{
    sign_in:{posix:'openclaw onboard --install-daemon',windows:'openclaw onboard --install-daemon',note:'The OpenClaw onboarding wizard asks for the model provider, its sign-in or API key, and installs the gateway service. Logins it finds are listed first as "Detected on this machine". The user types keys in the terminal. OpenClaw needs Node.js 24 or newer.'},
    // Reuse a login the user already has, without the wizard (run_diagnostic logins shows which ones exist).
    use_claude_login:{posix:'openclaw onboard --non-interactive --accept-risk --mode local --auth-choice anthropic-cli --no-install-daemon --skip-channels --skip-search --skip-skills --skip-ui --skip-health',windows:'openclaw onboard --non-interactive --accept-risk --mode local --auth-choice anthropic-cli --no-install-daemon --skip-channels --skip-search --skip-skills --skip-ui --skip-health',note:'Sets OpenClaw up with the Claude Code login on this machine (claude must be signed in).'},
    use_codex_login:{posix:'{ [ -f "$HOME/.openclaw/openclaw.json" ] || openclaw onboard --non-interactive --accept-risk --mode local --auth-choice skip --no-install-daemon --skip-channels --skip-search --skip-skills --skip-ui --skip-health; } && openclaw migrate apply codex --from "$HOME/.codex" --agent main --include-secrets --item auth:openai --yes && openclaw models status',
      windows:'if (-not (Test-Path "$HOME\\.openclaw\\openclaw.json")) { openclaw onboard --non-interactive --accept-risk --mode local --auth-choice skip --no-install-daemon --skip-channels --skip-search --skip-skills --skip-ui --skip-health }; openclaw migrate apply codex --from "$HOME\\.codex" --agent main --include-secrets --item auth:openai --yes; openclaw models status',note:'Imports the ChatGPT sign-in of Codex on this machine into OpenClaw (codex must be signed in). Then choose the default model (list_agent_models / set_agent_model).'},
    enable_api:{posix:'openclaw config set gateway.http.endpoints.chatCompletions.enabled true && { openclaw gateway restart || true; }',windows:'openclaw config set gateway.http.endpoints.chatCompletions.enabled true; openclaw gateway restart'},
    start_gateway:{
      // The service when there is one (or can be installed: launchd, systemd, schtasks), otherwise a background run.
      posix:`openclaw gateway start 2>/dev/null || openclaw gateway install 2>/dev/null || { mkdir -p "$HOME/.openclaw"; nohup openclaw gateway run >> "$HOME/.openclaw/opaya-gateway.log" 2>&1 & sleep 6; }; openclaw gateway status`,
      windows:`openclaw gateway start; if ($LASTEXITCODE -ne 0) { openclaw gateway install }; if ($LASTEXITCODE -ne 0) { Start-Process openclaw -ArgumentList 'gateway','run' -WindowStyle Hidden; Start-Sleep 6 }; openclaw gateway status`},
    status:{posix:'openclaw status; openclaw gateway status',windows:'openclaw status; openclaw gateway status'}},
  claude:{sign_in:{posix:'claude',windows:'claude',note:'Claude Code opens: the user picks how to sign in and finishes in the browser, then types /exit (or you send ctrl_c twice once it says they are signed in).'}},
  codex:{
    sign_in:{posix:'codex login',remote:'codex login --device-auth',windows:'codex.cmd login',note:'On this computer a browser page opens for the ChatGPT sign-in; on a machine Codex shows a link and a code to enter on any device.'},
    status:{posix:'codex login status',windows:'codex.cmd login status'}},
  opencode:{sign_in:{posix:'opencode auth login',windows:'opencode auth login',note:'OpenCode asks for a provider and its key.'},status:{posix:'opencode auth list',windows:'opencode auth list'}},
  goose:{sign_in:{posix:'goose configure',windows:'',note:'Goose asks for a provider and its key.'}}
};
const SETUP_STEPS=['sign_in','model','use_claude_login','use_codex_login','enable_api','start_gateway','status'];
// The command for one setup step. hermesHome picks a Hermes profile; container runs it inside a Docker agent.
function setupCommand(id,step,{remote=false,windows=process.platform==='win32'&&!remote,hermesHome='',container=''}={}){
  const f=FRAMEWORKS.find(x=>x.id===id),s=SETUP[id]?.[step];
  if(!f||!SETUP[id])throw new Error(`Opaya has no setup steps for ${id}. Setup steps exist for ${Object.keys(SETUP).join(', ')}.`);
  if(!s)throw new Error(`${f.name} has no ${step.replace('_',' ')} step. It has: ${Object.keys(SETUP[id]).join(', ')}.`);
  if(container)windows=false;
  let command=windows?s.windows:(remote&&s.remote)||s.posix;
  if(!command)throw new Error(`${f.name} cannot do this on Windows.`);
  if(hermesHome&&id==='hermes')command=windows?`$env:HERMES_HOME='${String(hermesHome).replace(/'/g,"''")}'; ${command}`:`export HERMES_HOME=${quote(hermesHome)}; ${command}`;
  if(container)command=`if [ -t 0 ]; then t=-it; else t=-i; fi; docker exec $t ${quote(container)} sh -c ${quote(command)}`;
  return {framework:{id:f.id,name:f.name},step,command,note:s.note||''};
}
module.exports={FRAMEWORKS,UPDATES,SETUP,SETUP_STEPS,list,command,setupCommand};
