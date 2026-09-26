'use strict';
// The setup guide: gets a computer ready for AI coding agents for someone who has never coded, without any AI model.
// It is plain scripts: it looks at the computer, asks what the person has (a ChatGPT or Claude account, an API key, or
// nothing) and what they want to make, then installs things in order in one visible terminal. The first goal is a
// model for the Opaya Agent (Codex CLI or Claude Code, signed in): once it has one, the Opaya Agent finishes the setup
// and fixes what went wrong. Without a model, the guide installs everything itself.
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
// What the person already has. brain: which Opaya Agent model this gives.
const WAYS={
  chatgpt:{label:'ChatGPT account',brain:'codex',agent:'codex'},
  claude:{label:'Claude account',brain:'claude',agent:'claude'},
  api:{label:'API key',brain:'api'},
  free:{label:'Free model on this computer',brain:'local'},
  none:{label:'Nothing yet',brain:''}
};
// What the person wants to make, and the tools that needs.
const GOALS={
  web:{label:'Websites and web apps',tools:['git','node','gh']},
  python:{label:'Python, data and automation',tools:['git','python','uv']},
  agents:{label:'Just work with AI agents',tools:['git']},
  all:{label:'A bit of everything',tools:['git','node','python','uv','gh']}
};
// Agents the guide can install, and what each one needs first.
const AGENTS={
  codex:{name:'Codex CLI',needs:['node'],signIn:{posix:'codex login',windows:'codex.cmd login'},signInNote:'A browser page opens: sign in with your ChatGPT account. When it says you are signed in, come back here.'},
  claude:{name:'Claude Code',needs:[],needsWindows:['git'],signIn:{posix:'claude',windows:'claude'},signInNote:'Claude Code starts in the terminal below. Pick how to sign in (your Claude account), finish in the browser, then type /exit and press Enter.'},
  'gemini-cli':{name:'Gemini CLI',needs:['node']},
  opencode:{name:'OpenCode',needs:['node']}
};
const TOOL_NAMES={git:'Git',node:'Node.js',python:'Python',uv:'uv',gh:'GitHub CLI',codex:'Codex CLI',claude:'Claude Code','gemini-cli':'Gemini CLI',opencode:'OpenCode'};
// Plain-language reasons shown next to each step.
const WHY={git:'Keeps every version of your work, so nothing gets lost.',node:'Runs JavaScript: needed for websites and for Codex CLI.',python:'The most popular language for scripts, data and automation.',uv:'Installs Python packages quickly and safely.',gh:'Connects your projects to GitHub.',
  codex:'OpenAI\'s coding agent. Works with your ChatGPT account.',claude:'Anthropic\'s coding agent. Works with your Claude account.','gemini-cli':'Google\'s coding agent. Works with your Google account.',opencode:'An open-source coding agent that works with many models.'};
const exists=file=>{try{return fs.existsSync(file);}catch{return false;}};
const read=file=>{try{return fs.readFileSync(file,'utf8');}catch{return '';}};
// Whether a CLI is signed in on this computer, from the files it writes when you sign in. (Claude Code on macOS keeps
// its token in the keychain; ~/.claude.json still records the account.)
function signedIn(tool,home=os.homedir(),env=process.env){
  if(tool==='codex')return exists(path.join(env.CODEX_HOME||path.join(home,'.codex'),'auth.json'));
  if(tool==='claude')return exists(path.join(env.CLAUDE_CONFIG_DIR||path.join(home,'.claude'),'.credentials.json'))||/"oauthAccount"\s*:\s*\{/.test(read(path.join(home,'.claude.json')));
  if(tool==='gemini-cli')return exists(path.join(home,'.gemini','oauth_creds.json'));
  return false;
}
// The computer as the guide describes it. installed: tool id -> version text (versions.installed).
function describe({installed={},platform=process.platform,arch=process.arch,memory=os.totalmem(),home=os.homedir(),env=process.env}={}){
  const os_=platform==='darwin'?'Mac':platform==='win32'?'Windows':'Linux';
  const has=id=>Object.hasOwn(installed,id);
  return {platform,arch,system:`${os_}${platform==='darwin'?arch==='arm64'?' (Apple silicon)':' (Intel)':''}`,memoryGb:Math.round(memory/1e9),
    // Node.js without npm (some Linux packages) cannot install agents: it counts as missing.
    tools:Object.fromEntries(Object.keys(TOOL_NAMES).map(id=>[id,has(id)&&(id!=='node'||has('npm'))?String(installed[id]).slice(0,60):''])),
    signedIn:{codex:has('codex')&&signedIn('codex',home,env),claude:has('claude')&&signedIn('claude',home,env),'gemini-cli':has('gemini-cli')&&signedIn('gemini-cli',home,env)},
    packageManager:platform==='win32'?'winget':has('homebrew')?'Homebrew':platform==='darwin'?'':'system',
    // A local model needs about 8 GB of memory to be useful.
    localModelOk:memory>=7.5e9};
}
// The ordered steps. The model comes first; with a model, the rest is handed to the Opaya Agent.
function plan({way='none',goals=[],agents=[],facts,platform=process.platform}){
  if(!Object.hasOwn(WAYS,way))throw new Error('Choose what you have.');
  const w=WAYS[way],steps=[],queued=new Set(),have=id=>!!facts?.tools?.[id];
  const install=(id,phase)=>{if(queued.has(id)||have(id))return;queued.add(id);steps.push({id:`install-${id}`,kind:'install',tool:id,phase,title:`Install ${TOOL_NAMES[id]}`,why:WHY[id]||''});};
  const withNeeds=(id,phase)=>{const a=AGENTS[id];for(const n of [...(a?.needs||[]),...(platform==='win32'?a?.needsWindows||[]:[])])install(n,phase);install(id,phase);};
  if(w.agent){
    withNeeds(w.agent,'model');
    if(!facts?.signedIn?.[w.agent])steps.push({id:`signin-${w.agent}`,kind:'signin',tool:w.agent,phase:'model',title:`Sign in to ${TOOL_NAMES[w.agent]}`,why:AGENTS[w.agent].signInNote});
    steps.push({id:'brain',kind:'brain',tool:w.agent,phase:'model',title:'Give the Opaya Agent its brain',why:`The Opaya Agent thinks with ${TOOL_NAMES[w.agent]} from now on and finishes the setup for you.`});
  }
  const rest=[...new Set([...goals.flatMap(g=>GOALS[g]?.tools||[]),...agents.filter(a=>Object.hasOwn(AGENTS,a)&&a!==w.agent)])];
  for(const id of rest)if(AGENTS[id])withNeeds(id,'rest');else install(id,'rest');
  steps.push({id:'add',kind:'add',phase:'rest',title:'Add your agents to Opaya',why:'So you can chat with them and give them projects.'});
  return steps;
}
// What the Opaya Agent is asked to do once it has a model: the remaining steps, and to check and fix everything.
function handoff({steps,facts,goals=[]}){
  const todo=steps.filter(s=>s.phase==='rest'&&s.kind==='install').map(s=>TOOL_NAMES[s.tool]);
  const wants=goals.map(g=>GOALS[g]?.label).filter(Boolean);
  return [
    `Please finish setting up this computer (${facts?.system||'this computer'}) for someone who has never coded.`,
    wants.length?`They want to make: ${wants.join(', ')}.`:'',
    todo.length?`Install what is still missing, in this order, and wait for each one to finish: ${todo.join(', ')}.`:'Everything they chose is installed.',
    'Then check the installed versions (run_diagnostic versions), fix anything that failed or is out of date, and add every agent you find to Opaya (discover_agents, then save_connection).',
    'Keep the user informed in short, simple, non-technical sentences, and tell them what to type if a terminal asks for their password.',
    'At the end, tell them in two or three sentences what is ready and what to do next (for example: open Projects and start a chat with an agent).'
  ].filter(Boolean).join(' ');
}
// Marked commands print an end line with the step id and exit code; the guide waits for it in the setup terminal.
function marked(step,command,{windows}){
  return windows?`${command}; Write-Host "[opaya-setup] ${step} exit $(if ($?) { 0 } else { 1 })"`:`${command}; echo "[opaya-setup] ${step} exit $?"`;
}
function markOf(buffer,step){const m=[...String(buffer||'').replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g,'').matchAll(new RegExp(`\\[opaya-setup\\] ${step.replace(/[^\w-]/g,'')} exit (\\d+)`,'g'))].pop();return m?Number(m[1]):null;}
// Tools installed a moment ago (by Opaya itself, nvm or an installer) are found even before the terminal's PATH knows them.
const {opayaToolDirs}=require('./process.cjs');
function withPath(command,{windows,dirs=opayaToolDirs(windows?'win32':process.platform==='win32'?'linux':process.platform)}){
  if(windows)return `$env:Path=(${dirs.map(d=>`'${d.replace(/'/g,"''")}'`).join(',')} -join ';')+';'+[Environment]::GetEnvironmentVariable('Path','User')+';'+[Environment]::GetEnvironmentVariable('Path','Machine')+';'+$env:USERPROFILE+'\\.local\\bin'; ${command}`;
  return `export PATH="${dirs.map(d=>d.replace(/["\\$`]/g,'\\$&')).join(':')}:$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; [ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1; ${command}`;
}
module.exports={WAYS,GOALS,AGENTS,TOOL_NAMES,WHY,signedIn,describe,plan,handoff,marked,markOf,withPath};
