'use strict';
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
    posix:'npm install -g @openai/codex || { mkdir -p ~/.npm-global && npm config set prefix ~/.npm-global && npm install -g @openai/codex; }', windows:'npm install -g @openai/codex'},
  {id:'openclaw', name:'OpenClaw', provider:'openclaw', icon:'openclaw', description:'Personal agent gateway with an OpenAI-compatible API.',
    docs:'https://docs.openclaw.ai/', after:'Run `openclaw onboard`, then start its gateway. Discover adds it.', requires:'Node.js 22+',
    posix:'npm install -g openclaw@latest || { mkdir -p ~/.npm-global && npm config set prefix ~/.npm-global && npm install -g openclaw@latest; }', windows:'npm install -g openclaw@latest'},
  {id:'gemini-cli', name:'Gemini CLI', provider:'custom', icon:'gemini-cli', command:'gemini', description:"Google's open-source terminal agent.",
    docs:'https://github.com/google-gemini/gemini-cli', after:'Run `gemini` once to sign in. Discover adds it; Opaya chats with it over ACP.', requires:'Node.js 20+',
    posix:'npm install -g @google/gemini-cli || { mkdir -p ~/.npm-global && npm config set prefix ~/.npm-global && npm install -g @google/gemini-cli; }', windows:'npm install -g @google/gemini-cli'},
  {id:'opencode', name:'OpenCode', provider:'custom', icon:'opencode', command:'opencode', description:'Open-source coding agent for the terminal.',
    docs:'https://opencode.ai/docs/', after:'Run `opencode auth login`. Discover adds it; Opaya chats with it over ACP.', requires:'Node.js 18+',
    posix:'npm install -g opencode-ai || { mkdir -p ~/.npm-global && npm config set prefix ~/.npm-global && npm install -g opencode-ai; }', windows:'npm install -g opencode-ai'},
  {id:'goose', name:'Goose', provider:'custom', icon:'goose', command:'goose', description:'Extensible open-source agent from Block.',
    docs:'https://block.github.io/goose/', after:'Run `goose configure`. Add it as a terminal agent.',
    posix:'curl -fsSL https://github.com/block/goose/releases/download/stable/download_cli.sh | bash', windows:''},
  {id:'aider', name:'Aider', provider:'custom', icon:'', command:'aider', description:'AI pair programming in your terminal.',
    docs:'https://aider.chat/docs/install.html', after:'Run `aider` inside a git repository. Add it as a terminal agent.', requires:'Python 3.9+',
    posix:'python3 -m pip install --user aider-install && aider-install', windows:'py -m pip install aider-install; aider-install'},
  {id:'ollama', name:'Ollama', provider:'custom', icon:'ollama', command:'ollama', runtime:true, description:'Local model runtime. Useful as the Opaya Agent model.',
    docs:'https://ollama.com/download', after:'Run `ollama pull <model>`. Point the Opaya Agent at http://127.0.0.1:11434/v1.',
    posix:'curl -fsSL https://ollama.com/install.sh | sh', windows:'winget install --id Ollama.Ollama -e'},
  // Dependencies agents need. Each command skips what is already installed; the essentials bundle runs them in order.
  {id:'node', kind:'dependency', name:'Node.js LTS', provider:'custom', icon:'', description:'Runtime for Codex, OpenClaw, Gemini CLI and OpenCode (includes npm).', docs:'https://nodejs.org/en/download', after:'Open a new terminal so npm is on PATH.',
    posix:"if command -v node >/dev/null 2>&1; then echo 'node is already installed'; elif command -v brew >/dev/null 2>&1; then brew install node; elif command -v apt-get >/dev/null 2>&1; then curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash - && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs; elif command -v dnf >/dev/null 2>&1; then sudo dnf install -y nodejs npm; else echo 'Install Node.js LTS from https://nodejs.org'; fi", windows:"if (-not (Get-Command node -ErrorAction SilentlyContinue)) { winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements; $env:Path=[Environment]::GetEnvironmentVariable('Path','Machine')+';'+[Environment]::GetEnvironmentVariable('Path','User') } else { 'node is already installed' }"},
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
// Updates to the latest version. Same rules as installs: fixed vendor commands, nothing interpolated.
const npmUp=pkg=>`npm install -g ${pkg}@latest || { mkdir -p ~/.npm-global && npm config set prefix ~/.npm-global && npm install -g ${pkg}@latest; }`;
const pkgUp=(bin,{brew=bin,apt=bin,dnf=bin}={})=>`if ! command -v ${bin} >/dev/null 2>&1; then echo '${bin} is not installed'; elif command -v brew >/dev/null 2>&1 && brew list ${brew} >/dev/null 2>&1; then brew upgrade ${brew} || true; elif command -v apt-get >/dev/null 2>&1; then sudo apt-get update && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --only-upgrade ${apt}; elif command -v dnf >/dev/null 2>&1; then sudo dnf upgrade -y ${dnf}; else echo 'Update ${bin} with your package manager.'; fi; ${bin} --version 2>&1 | head -1`;
const wingetUp=(bin,wid)=>`if (Get-Command ${bin} -ErrorAction SilentlyContinue) { winget upgrade --id ${wid} -e --accept-source-agreements --accept-package-agreements; ${bin} --version } else { '${bin} is not installed' }`;
const UPDATES={
  hermes:{posix:'hermes update',windows:'hermes update'},
  claude:{posix:'claude update',windows:'claude update'},
  codex:{posix:npmUp('@openai/codex'),windows:'npm install -g @openai/codex@latest'},
  openclaw:{posix:npmUp('openclaw'),windows:'npm install -g openclaw@latest'},
  'gemini-cli':{posix:npmUp('@google/gemini-cli'),windows:'npm install -g @google/gemini-cli@latest'},
  opencode:{posix:npmUp('opencode-ai'),windows:'npm install -g opencode-ai@latest'},
  goose:{posix:'goose update',windows:''},
  aider:{posix:'aider-install',windows:'aider-install'},
  ollama:{posix:'curl -fsSL https://ollama.com/install.sh | sh',windows:"winget upgrade --id Ollama.Ollama -e --accept-source-agreements --accept-package-agreements"},
  node:{posix:pkgUp('node',{brew:'node',apt:'nodejs',dnf:'nodejs'}),windows:wingetUp('node','OpenJS.NodeJS.LTS')},
  python:{posix:pkgUp('python3',{brew:'python',apt:'python3',dnf:'python3'}),windows:wingetUp('py','Python.Python.3.12')},
  git:{posix:pkgUp('git'),windows:wingetUp('git','Git.Git')},
  uv:{posix:'uv self update',windows:'uv self update'},
  tmux:{posix:pkgUp('tmux'),windows:''},
  openssh:{posix:pkgUp('ssh',{brew:'openssh',apt:'openssh-client',dnf:'openssh-clients'}),windows:''},
  gh:{posix:pkgUp('gh'),windows:wingetUp('gh','GitHub.cli')},
  docker:{posix:pkgUp('docker',{brew:'docker',apt:'docker-ce docker-ce-cli containerd.io',dnf:'docker-ce docker-ce-cli containerd.io'}),windows:wingetUp('docker','Docker.DockerDesktop')},
  homebrew:{posix:'brew update && brew upgrade',windows:''}
};
const ESSENTIALS=['node','python','git','uv','tmux'];
const available=(f,remote)=>remote||process.platform!=='win32'?!!f.posix&&!(f.macOnly&&(remote||process.platform!=='darwin')):!!f.windows;
function list(){const containers=require('./containers.cjs');return [...FRAMEWORKS.map(({posix,windows,...f})=>({kind:'agent',...f,docker:containers.supported(f.id),local:available({posix,windows,...f},false),remote:available({posix,windows,...f},true),localCommand:process.platform==='win32'?windows:posix,remoteCommand:posix})),
  {id:'essentials',kind:'bundle',name:'All essentials',provider:'custom',icon:'',description:`Installs whatever is missing of ${ESSENTIALS.map(id=>FRAMEWORKS.find(f=>f.id===id)).filter(f=>available(f,false)).map(f=>f.name).join(', ')}.`,after:'Open a new terminal, then install agents.',local:true,remote:true,localCommand:command('essentials',{remote:false}).command,remoteCommand:command('essentials',{remote:true}).command}];}
function command(id,{remote,update=false}){
  if(update)return updateCommand(id,{remote});
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
function updateCommand(id,{remote}){
  const posix=remote||process.platform!=='win32';
  if(id==='essentials'){
    const parts=ESSENTIALS.map(e=>UPDATES[e]?.[posix?'posix':'windows']).filter(Boolean);
    return {framework:{id:'essentials',name:'All essentials',after:'Everything that was installed is now up to date.'},command:parts.map(p=>posix?`(${p})`:`& {${p}}`).join('; ')};
  }
  const f=FRAMEWORKS.find(f=>f.id===id);if(!f)throw new Error('Unknown agent framework.');
  const value=UPDATES[id]?.[posix?'posix':'windows'];
  if(!value||!available(f,remote))throw new Error(`Opaya has no ${remote?'remote':posix?'':'Windows '}update command for ${f.name}. Install it again to get the latest version.`.replace('  ',' '));
  return {framework:{...f,after:`${f.name} is up to date.`},command:value};
}
module.exports={FRAMEWORKS,UPDATES,list,command};
