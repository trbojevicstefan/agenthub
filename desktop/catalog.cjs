'use strict';
// Installable agent frameworks. Commands are fixed strings from the vendors' published install instructions; nothing
// from the UI or the Opaya Agent is ever interpolated into them. Installs run in a visible terminal after approval.
const FRAMEWORKS = [
  {id:'hermes', name:'Hermes Agent', provider:'hermes', icon:'hermes', description:'Nous Research agent with gateway API, ACP, memory and profiles.',
    docs:'https://hermes-agent.nousresearch.com/docs/', after:'Run `hermes setup`, then `hermes gateway` for the API. Discover adds it.',
    posix:'curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash', windows:''},
  {id:'claude', name:'Claude Code', provider:'claude', icon:'claude', description:"Anthropic's coding agent CLI.",
    docs:'https://code.claude.com/docs/en/setup', after:'Run `claude` once to sign in. Discover adds it.',
    posix:'curl -fsSL https://claude.ai/install.sh | bash', windows:'irm https://claude.ai/install.ps1 | iex'},
  {id:'codex', name:'Codex CLI', provider:'codex', icon:'codex', description:"OpenAI's coding agent with app-server protocol.",
    docs:'https://developers.openai.com/codex/cli', after:'Run `codex` once to sign in. Discover adds it.', requires:'Node.js 18+',
    posix:'npm install -g @openai/codex', windows:'npm install -g @openai/codex'},
  {id:'openclaw', name:'OpenClaw', provider:'openclaw', icon:'openclaw', description:'Personal agent gateway with an OpenAI-compatible API.',
    docs:'https://docs.openclaw.ai/', after:'Run `openclaw onboard`, then start its gateway. Discover adds it.', requires:'Node.js 22+',
    posix:'npm install -g openclaw@latest', windows:'npm install -g openclaw@latest'},
  {id:'gemini-cli', name:'Gemini CLI', provider:'custom', icon:'gemini-cli', command:'gemini', description:"Google's open-source terminal agent.",
    docs:'https://github.com/google-gemini/gemini-cli', after:'Run `gemini` to sign in. Add it as a terminal agent.', requires:'Node.js 20+',
    posix:'npm install -g @google/gemini-cli', windows:'npm install -g @google/gemini-cli'},
  {id:'opencode', name:'OpenCode', provider:'custom', icon:'opencode', command:'opencode', description:'Open-source coding agent for the terminal.',
    docs:'https://opencode.ai/docs/', after:'Run `opencode auth login`. Add it as a terminal agent.', requires:'Node.js 18+',
    posix:'npm install -g opencode-ai', windows:'npm install -g opencode-ai'},
  {id:'goose', name:'Goose', provider:'custom', icon:'goose', command:'goose', description:'Extensible open-source agent from Block.',
    docs:'https://block.github.io/goose/', after:'Run `goose configure`. Add it as a terminal agent.',
    posix:'curl -fsSL https://github.com/block/goose/releases/download/stable/download_cli.sh | bash', windows:''},
  {id:'aider', name:'Aider', provider:'custom', icon:'', command:'aider', description:'AI pair programming in your terminal.',
    docs:'https://aider.chat/docs/install.html', after:'Run `aider` inside a git repository. Add it as a terminal agent.', requires:'Python 3.9+',
    posix:'python3 -m pip install --user aider-install && aider-install', windows:'py -m pip install aider-install; aider-install'},
  {id:'ollama', name:'Ollama', provider:'custom', icon:'ollama', command:'ollama', runtime:true, description:'Local model runtime. Useful as the Opaya Agent model.',
    docs:'https://ollama.com/download', after:'Run `ollama pull <model>`. Point the Opaya Agent at http://127.0.0.1:11434/v1.',
    posix:'curl -fsSL https://ollama.com/install.sh | sh', windows:'winget install --id Ollama.Ollama -e'}
];
function list(){return FRAMEWORKS.map(({posix,windows,...f})=>({...f,local:process.platform==='win32'?!!windows:!!posix,remote:!!posix,localCommand:process.platform==='win32'?windows:posix,remoteCommand:posix}));}
function command(id,{remote}){
  const f=FRAMEWORKS.find(f=>f.id===id);if(!f)throw new Error('Unknown agent framework.');
  const value=remote||process.platform!=='win32'?f.posix:f.windows;
  if(!value)throw new Error(`${f.name} has no native ${remote?'remote':'Windows'} installer. Install it on a Linux or macOS machine (or WSL) instead.`);
  return {framework:f,command:value};
}
module.exports={FRAMEWORKS,list,command};
