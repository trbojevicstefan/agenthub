'use strict';
// Which agents and tools are installed on each machine, in which version, and whether a newer one exists.
// Installed versions come from `<tool> --version` on the machine (this computer, or over SSH); latest versions from the
// public registries each tool ships through. Read-only: updating goes through catalog update commands.
const {spawn}=require('node:child_process');
const {REMOTE_PATH,findExecutable,environment,collect,primeShellPath}=require('./process.cjs');
const {run}=require('./clone.cjs');
// `bin` is what the machine runs; `latest` says where the newest version is published.
const TOOLS=[
  {id:'hermes',name:'Hermes Agent',bin:'hermes',latest:{git:true}},
  {id:'claude',name:'Claude Code',bin:'claude',latest:{npm:'@anthropic-ai/claude-code'}},
  {id:'codex',name:'Codex CLI',bin:'codex',latest:{npm:'@openai/codex'}},
  {id:'openclaw',name:'OpenClaw',bin:'openclaw',latest:{npm:'openclaw'}},
  {id:'gemini-cli',name:'Gemini CLI',bin:'gemini',latest:{npm:'@google/gemini-cli'}},
  {id:'opencode',name:'OpenCode',bin:'opencode',latest:{npm:'opencode-ai'}},
  {id:'goose',name:'Goose',bin:'goose',latest:{github:'block/goose'}},
  {id:'aider',name:'Aider',bin:'aider',latest:{pypi:'aider-chat'}},
  {id:'ollama',name:'Ollama',bin:'ollama',latest:{github:'ollama/ollama'}},
  {id:'node',name:'Node.js',bin:'node',latest:{node:true},dependency:true},
  {id:'python',name:'Python 3',bin:'python3',win:'python',latest:{python:true},dependency:true},
  {id:'git',name:'Git',bin:'git',dependency:true},
  {id:'uv',name:'uv',bin:'uv',latest:{github:'astral-sh/uv'},dependency:true},
  {id:'tmux',name:'tmux',bin:'tmux',args:'-V',dependency:true,posixOnly:true},
  {id:'openssh',name:'OpenSSH client',bin:'ssh',args:'-V',dependency:true},
  {id:'gh',name:'GitHub CLI',bin:'gh',latest:{github:'cli/cli'},dependency:true},
  {id:'docker',name:'Docker',bin:'docker',dependency:true},
  {id:'homebrew',name:'Homebrew',bin:'brew',dependency:true,posixOnly:true}
];
const parse=text=>{const m=/(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(text||''));return m?[Number(m[1]),Number(m[2]),Number(m[3]||0)]:null;};
const show=v=>v?v.join('.'):'';
function compare(a,b){for(let i=0;i<3;i++){if((a[i]||0)!==(b[i]||0))return (a[i]||0)<(b[i]||0)?-1:1;}return 0;}
// One script per machine: `id=<first line of --version>` for each installed tool, and how far Hermes is behind.
function script({windows}){
  if(windows)return TOOLS.filter(t=>!t.posixOnly).map(t=>{const bin=t.win||t.bin;return `if (Get-Command ${bin} -ErrorAction SilentlyContinue) { '${t.id}=' + ((& ${bin} ${t.args||'--version'} 2>&1) -join ' ') }`;}).join('; ');
  return [REMOTE_PATH,
    ...TOOLS.map(t=>`if command -v ${t.bin} >/dev/null 2>&1; then printf '%s=%s\\n' ${t.id} "$(${t.bin} ${t.args||'--version'} 2>&1 | grep -m1 -E '[0-9]+\\.[0-9]+')"; fi`),
    // Hermes installs from git: count the commits the checkout is behind its upstream.
    'h="${HERMES_HOME:-$HOME/.hermes}/hermes-agent"; if [ -d "$h/.git" ] && command -v git >/dev/null 2>&1; then git -C "$h" fetch -q 2>/dev/null; b=$(git -C "$h" rev-list --count HEAD..@{u} 2>/dev/null) && echo "hermes_behind=$b"; fi',
    'true'].join('\n');
}
async function installed(host,{timeout=90000}={}){
  const windows=!host&&process.platform==='win32';let out;
  if(windows){
    const ps=findExecutable('powershell.exe',environment())||findExecutable('pwsh',environment());if(!ps)return {};
    out=await collect(spawn(ps,['-NoProfile','-Command',script({windows})],{env:environment(),windowsHide:true,stdio:['pipe','pipe','pipe']}),{timeout});
  }else{if(!host)await primeShellPath();out=await run({host:host||null,container:''},script({windows:false}),timeout);}
  const found={};
  for(const line of out.split(/\r?\n/)){const m=/^([\w-]+)=(.*)$/.exec(line.trim());if(m)found[m[1]]=m[2].trim().slice(0,200);}
  return found;
}
// Newest published versions, cached for an hour. Failures leave that tool without a "latest" (never "outdated").
const cache=new Map();
async function getJson(url,fetchImpl){
  const r=await fetchImpl(url,{headers:{'User-Agent':'Opaya','Accept':'application/json'},signal:AbortSignal.timeout(15000)});
  if(!r.ok)throw new Error(`${url} answered ${r.status}`);return r.json();
}
async function latestOf(tool,{fetchImpl=globalThis.fetch,installedVersion=null}={}){
  const l=tool.latest;if(!l||l.git)return null;
  const key=tool.id+(installedVersion&&(l.python||l.node)?`@${installedVersion[0]}.${installedVersion[1]}`:'');
  const hit=cache.get(key);if(hit&&Date.now()-hit.at<55*60*1000)return hit.value;
  let value=null;
  try{
    if(l.npm)value=parse((await getJson(`https://registry.npmjs.org/${l.npm.replace('/','%2F')}/latest`,fetchImpl)).version);
    else if(l.pypi)value=parse((await getJson(`https://pypi.org/pypi/${l.pypi}/json`,fetchImpl)).info?.version);
    else if(l.github)value=parse((await getJson(`https://api.github.com/repos/${l.github}/releases/latest`,fetchImpl)).tag_name);
    // Node.js: the newest release of the same major line. Only when that line has reached its end of life is the
    // newest LTS the update; moving 22 to 24 while 22 is supported is not an update anyone needs.
    else if(l.node&&installedVersion){
      const list=await getJson('https://nodejs.org/dist/index.json',fetchImpl);
      const same=list.find(r=>parse(r.version)?.[0]===installedVersion[0]);
      const schedule=await getJson('https://raw.githubusercontent.com/nodejs/Release/main/schedule.json',fetchImpl).catch(()=>({}));
      const end=schedule[`v${installedVersion[0]}`]?.end,ended=!!end&&new Date(end)<new Date();
      value=parse((ended?list.find(r=>r.lts):same)?.version);
    }
    // Python: the newest patch of the same minor line (3.12.x stays on 3.12).
    else if(l.python&&installedVersion){const list=await getJson('https://endoflife.date/api/python.json',fetchImpl);value=parse(list.find(r=>r.cycle===`${installedVersion[0]}.${installedVersion[1]}`)?.latest);}
  }catch{value=null;}
  cache.set(key,{value,at:Date.now()});return value;
}
// The report for one machine: installed tools, their versions and which ones have an update.
async function check(host,{fetchImpl}={}){
  const found=await installed(host),items=[];
  for(const tool of TOOLS){
    const raw=found[tool.id];if(raw===undefined)continue;
    const version=parse(raw);let latest=null,outdated=false,note='';
    if(tool.latest?.git){const behind=Number(found.hermes_behind);if(Number.isFinite(behind)&&behind>0){outdated=true;note=`${behind} update${behind===1?'':'s'} behind`;}}
    else if(version){latest=await latestOf(tool,{fetchImpl,installedVersion:version});outdated=!!latest&&compare(version,latest)<0;}
    items.push({id:tool.id,name:tool.name,dependency:!!tool.dependency,installed:show(version)||raw.slice(0,60),latest:show(latest),outdated,note});
  }
  return {checkedAt:new Date().toISOString(),items};
}
// Whether a connection error means something is too old, and what to update: 'agent', 'node', 'python' or null.
const TOO_OLD=/\b(version|outdated|too old|upgrade|update (?:is )?required|no longer supported|unsupported|incompatible|minimum|requires? (?:node|python)|unknown (?:argument|option|flag|command|subcommand)|unrecognized (?:argument|option|subcommand)|unexpected argument|or (?:newer|later|higher))\b/i;
function fixTarget(error){
  const text=String(error||'');if(!TOO_OLD.test(text))return null;
  if(/\bnode(?:\.js)?\b/i.test(text)&&/requir|version|>=|at least|minimum|unsupported/i.test(text))return 'node';
  if(/\bpython\b/i.test(text)&&/requir|version|>=|at least|minimum|or (?:newer|later|higher)/i.test(text))return 'python';
  return 'agent';
}
module.exports={TOOLS,fixTarget,parse,compare,script,installed,latestOf,check,cache};
