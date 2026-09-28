'use strict';
// Updates that find how each tool is installed: path classification, the generated scripts (run against fake installs),
// the "exit 0 but still old" rule, and the single hand-off to the Opaya Agent.
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');const {spawnSync}=require('node:child_process');
const {temp}=require('./helpers.cjs');
const u=require('../desktop/updates.cjs');
const catalog=require('../desktop/catalog.cjs');
const maintenance=require('../desktop/maintenance.cjs');
const secrets=require('../desktop/secrets.cjs');
const skip=process.platform==='win32'?'runs POSIX sh scripts':false;

test('install paths are classified by how the tool was installed',()=>{
  const cases=[
    ['/opt/homebrew/Caskroom/claude-code/2.0.1/claude','cask'],
    ['/usr/local/Caskroom/codex/0.40.0/codex-aarch64-apple-darwin','cask'],
    ['/opt/homebrew/Cellar/codex/0.40.0/bin/codex','brew'],
    ['/home/linuxbrew/.linuxbrew/Cellar/gh/2.60.0/bin/gh','brew'],
    ['/opt/homebrew/Cellar/node/24.1.0/bin/node','brew'],
    ['/Users/me/.nvm/versions/node/v22.11.0/lib/node_modules/@openai/codex/bin/codex.js','npm','nvm'],
    ['/Users/me/.nvm/versions/node/v22.11.0/bin/node','nvm'],
    ['/Users/me/.local/share/fnm/node-versions/v20.1.0/installation/lib/node_modules/openclaw/openclaw.mjs','npm','fnm'],
    ['/Users/me/.local/state/fnm_multishells/1234_5678/bin/node','fnm'],
    ['/Users/me/.volta/tools/image/packages/@openai/codex/lib/node_modules/@openai/codex/bin/codex.js','volta'],
    ['/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js','npm','homebrew'],
    ['/usr/local/lib/node_modules/@openai/codex/bin/codex.js','npm','local'],
    ['/usr/lib/node_modules/opencode-ai/bin/opencode','npm','system'],
    ['/Users/me/.npm-global/lib/node_modules/@openai/codex/bin/codex.js','npm','user'],
    ['/Users/me/.opaya/tools/node/lib/node_modules/@openai/codex/bin/codex.js','npm','opaya'],
    ['/Users/me/.opaya/tools/node/bin/node','opaya'],
    ['/Users/me/.npm/_npx/6a9b1c/node_modules/@openai/codex/bin/codex.js','npx'],
    ['/Users/me/.local/share/claude/versions/2.0.1','native'],
    ['/Users/me/.codex/packages/standalone/current/codex','standalone'],
    ['/Users/me/.local/share/uv/tools/aider-chat/bin/aider','uv'],
    ['/Users/me/.local/share/pipx/venvs/hermes-agent/bin/hermes','pipx'],
    ['/Users/me/Library/Python/3.12/bin/aider','pip'],
    ['/Users/me/.hermes/hermes-agent/venv/bin/hermes','hermes'],
    ['/Users/me/.bun/install/global/node_modules/opencode-ai/bin/opencode','bun'],
    ['/Users/me/Library/pnpm/global/5/node_modules/@openai/codex/bin/codex.js','pnpm'],
    ['/Users/me/.opencode/bin/opencode','installer'],
    ['/Users/me/.local/bin/uv','installer'],
    ['/Applications/Ollama.app/Contents/Resources/ollama','app'],
    ['/usr/bin/git','system'],
    ['/snap/bin/gh','snap'],
    ['/nix/store/abc-gh-2.60/bin/gh','nix'],
    ['','none']
  ];
  for(const [file,method,via=''] of cases){const c=u.classify(file);assert.equal(c.method,method,file);assert.equal(c.via,via,file);}
  // Windows paths: backslashes and any letter case.
  const win=[
    ['C:\\Users\\Me\\AppData\\Roaming\\npm\\codex.cmd','npm'],
    ['C:\\Users\\Me\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Anthropic.ClaudeCode_x\\claude.exe','winget'],
    ['C:\\Users\\Me\\scoop\\shims\\gh.exe','scoop'],
    ['C:\\ProgramData\\chocolatey\\bin\\gh.exe','choco'],
    ['C:\\Users\\Me\\.local\\bin\\claude.exe','native'],
    ['C:\\Users\\Me\\AppData\\Local\\Opaya\\tools\\node\\node.exe','opaya'],
    ['C:\\nvm4w\\nodejs\\node.exe','nvm'],
    ['C:\\Program Files\\GitHub CLI\\gh.exe','installer'],
    ['C:\\Users\\Me\\AppData\\Local\\Programs\\Ollama\\ollama.exe','app']
  ];
  for(const [file,method] of win)assert.equal(u.classify(file).method,method,file);
  // What the updates list shows.
  assert.equal(u.label('npm','nvm'),'npm (nvm)');assert.equal(u.label('npm','homebrew'),'npm (Homebrew Node.js)');
  assert.equal(u.label('cask'),'Homebrew cask');assert.equal(u.label('brew'),'Homebrew');assert.equal(u.label('npx'),'npx');assert.equal(u.label('native'),'native installer');
});

test('every update script is valid sh, uses only fixed package names and has a Windows counterpart where the tool runs there',()=>{
  for(const id of Object.keys(u.SPECS)){
    const sh=u.script(id);assert.match(sh,/^sh -c '/);
    const r=spawnSync('sh',['-n','-c',sh],{encoding:'utf8'});assert.equal(r.status,0,`${id}: ${r.stderr}`);
    assert.match(sh,/say "method=\$m via=\$v path=\$p/,id);assert.match(sh,/exit \$rc'$/,id);
    const w=u.script(id,{windows:true});
    if(u.SPECS[id].windows===false){assert.equal(w,'',id);continue;}
    assert(!w.includes('\n'),`${id}: one line for PowerShell`);assert.match(w,/if \(\$opOk\) \{ cmd \/c exit 0 \} else \{ cmd \/c exit 1 \}$/,id);
  }
  const codexWin=u.script('codex',{windows:true});
  assert(codexWin.includes('npm.cmd install -g --prefix "$pre" @openai/codex@latest'));assert(codexWin.includes('irm https://chatgpt.com/codex/install.ps1 | iex'));
  const claudeWin=u.script('claude',{windows:true});
  assert(claudeWin.includes("{$_ -in 'native','installer'} { claude update; break }"));assert(claudeWin.includes('winget upgrade --id Anthropic.ClaudeCode -e'));
  assert(claudeWin.includes('-1978335189'),'"no applicable update" from WinGet is not a failure');
  // A forced method must fit the tool; nothing else reaches the script.
  assert.throws(()=>u.script('codex',{how:'rm -rf ~'}),/cannot be updated/);assert.throws(()=>u.script('git',{how:'npm'}),/cannot be updated/);
  assert.throws(()=>u.script('claude',{windows:true,how:'cask'}),/cannot be updated/);
  assert.match(u.script('codex',{how:'npm'}),/m='npm'|m=npm/);
  assert.match(catalog.command('codex',{remote:true,update:true,how:'cask'}).command,/Caskroom/);
  assert.equal(u.plan('claude','cask'),'brew upgrade --cask claude-code');assert.equal(u.plan('claude','native'),'claude update');
  assert.match(u.plan('codex','npm'),/npm install -g @openai\/codex@latest/);assert.equal(u.plan('codex','npx'),'refresh the npx copy of @openai/codex');
});

// A fake machine: HOME with stub programs that write what they were asked to do into $HOME/log.
async function machine(t){
  const root=await temp(t),home=path.join(root,'home');await fs.mkdir(home,{recursive:true});
  const stub=async(rel,body)=>{const f=path.join(home,rel);await fs.mkdir(path.dirname(f),{recursive:true});await fs.writeFile(f,`#!/bin/sh\n${body}\n`,{mode:0o755});return f;};
  const link=async(rel,target)=>{const f=path.join(home,rel);await fs.mkdir(path.dirname(f),{recursive:true});await fs.symlink(target,f);};
  const run=(id,opts={})=>{
    const r=spawnSync('sh',['-c',u.script(id,{how:opts.how||'auto'})],{env:{HOME:home,PATH:'/usr/bin:/bin'},encoding:'utf8',timeout:30000,...(opts.uid!==undefined?{uid:opts.uid,gid:opts.uid}:{})});
    return {code:r.status,out:r.stdout+r.stderr,log:async()=>fs.readFile(path.join(home,'log'),'utf8').catch(()=>'')};
  };
  return {root,home,stub,link,run};
}
const version=v=>`[ "$1" = --version ] && { echo '${v}'; exit 0; }`;

test('Claude Code from the native installer updates itself',{skip},async t=>{
  const m=await machine(t);
  await m.stub('.local/share/claude/versions/2.0.1',`${version('2.0.1 (Claude Code)')}\necho "claude $*" >> "$HOME/log"`);
  await m.link('.local/bin/claude','../share/claude/versions/2.0.1');
  const r=m.run('claude');assert.equal(r.code,0,r.out);
  assert.equal((await r.log()).trim(),'claude update');
  const ran=u.report(r.out);assert.equal(ran.method,'native');assert.equal(ran.label,'native installer');assert.equal(ran.before,'2.0.1 (Claude Code)');
  assert.equal(ran.real,path.join(m.home,'.local/share/claude/versions/2.0.1'));
});

test('a Homebrew cask and a Homebrew formula are upgraded with the brew that owns them',{skip},async t=>{
  const m=await machine(t);
  await m.stub('brew/bin/brew','echo "brew $*" >> "$HOME/log"');
  await m.stub('brew/Caskroom/claude-code/2.0.1/claude',version('2.0.1 (Claude Code)'));
  await m.link('.local/bin/claude',path.join(m.home,'brew/Caskroom/claude-code/2.0.1/claude'));
  await m.stub('brew/Cellar/codex/0.40.0/bin/codex',version('codex-cli 0.40.0'));
  await m.link('.local/bin/codex',path.join(m.home,'brew/Cellar/codex/0.40.0/bin/codex'));
  const a=m.run('claude');assert.equal(a.code,0,a.out);assert.match(a.out,/method=cask/);
  const b=m.run('codex');assert.equal(b.code,0,b.out);assert.match(b.out,/method=brew/);
  assert.deepEqual((await a.log()).trim().split('\n'),['brew upgrade --cask --greedy claude-code','brew upgrade codex']);
});

test('an npm install under nvm is updated with that Node.js npm and its own prefix',{skip},async t=>{
  const m=await machine(t),pre=path.join(m.home,'.nvm/versions/node/v20.11.0');
  await m.stub('.nvm/versions/node/v20.11.0/lib/node_modules/@openai/codex/bin/codex.js',version('codex-cli 0.39.0'));
  await m.link('.nvm/versions/node/v20.11.0/bin/codex','../lib/node_modules/@openai/codex/bin/codex.js');
  await m.stub('.nvm/versions/node/v20.11.0/bin/npm','echo "npm $*" >> "$HOME/log"');
  await m.stub('.nvm/versions/node/v20.11.0/bin/node','exit 0');
  const r=m.run('codex');assert.equal(r.code,0,r.out);
  assert.match(r.out,/method=npm via=nvm/);assert.equal(u.report(r.out).label,'npm (nvm)');
  assert.equal((await r.log()).trim(),`npm install -g --prefix ${pre} @openai/codex@latest`);
});

test('a root-owned npm prefix is updated visibly with sudo and says why',{skip},async t=>{
  const m=await machine(t),root=process.getuid?.()===0;
  await m.stub('npm/lib/node_modules/@openai/codex/bin/codex.js',version('codex-cli 0.39.0'));
  await m.link('.local/bin/codex',path.join(m.home,'npm/lib/node_modules/@openai/codex/bin/codex.js'));
  await m.stub('npm/bin/npm','echo "npm $*" >> "$HOME/log"');
  await m.stub('.local/bin/sudo','echo "sudo $1 $2" >> "$HOME/log"; exec "$@"');
  // Not writable for the user who runs it: as root, the test runs the script as nobody.
  if(root){for(let d=m.home;d!==path.dirname(m.root);d=path.dirname(d))await fs.chmod(d,0o755);await fs.chmod(m.home,0o777);}
  else await fs.chmod(path.join(m.home,'npm/lib/node_modules'),0o555);
  let r;try{r=m.run('codex',root?{uid:65534}:{});}
  // Writable again, or the temporary folder cannot be removed afterwards (macOS CI).
  finally{if(!root)await fs.chmod(path.join(m.home,'npm/lib/node_modules'),0o755);}
  assert.equal(r.code,0,r.out);
  assert.match(r.out,/belongs to another user \(usually root\), so npm needs administrator rights/);
  const lines=(await r.log()).trim().split('\n');
  assert.match(lines[0],/^sudo env PATH=/);assert.equal(lines[1],`npm install -g --prefix ${path.join(m.home,'npm')} @openai/codex@latest`);
});

test('an agent that only runs through npx gets its npx cache copy refreshed',{skip},async t=>{
  const m=await machine(t),cache=path.join(m.home,'npm-cache');
  await m.stub('.local/bin/npm',`[ "$1 $2 $3" = "config get cache" ] && { echo '${cache}'; exit 0; }\necho "npm $*" >> "$HOME/log"`);
  await m.stub('.local/bin/npx','echo "npx $*" >> "$HOME/log"; echo 0.41.0');
  await m.stub('npm-cache/_npx/aaa111/node_modules/@openai/codex/package.json','');
  await m.stub('npm-cache/_npx/bbb222/node_modules/cowsay/package.json','');
  const r=m.run('codex');assert.equal(r.code,0,r.out);assert.match(r.out,/method=npx/);
  await assert.rejects(fs.stat(path.join(cache,'_npx/aaa111')),'the old npx copy is removed');await fs.stat(path.join(cache,'_npx/bbb222'));
  assert.equal((await r.log()).trim(),'npx -y @openai/codex --version');
  // An agent started with npx: its update refreshes that copy, and there is nothing to uninstall.
  const a={id:'x',name:'Codex',provider:'codex',protocol:'acp',transport:'local',command:'npx',args:['-y','@openai/codex@latest','mcp']};
  assert.equal(maintenance.kindOf(a).kind,'npx');assert.equal(maintenance.npxOf(a),'codex');
  const c=maintenance.updateCommand(a,{remote:true});assert.match(c.command,/m='npx'|m=npx/);assert.match(c.summary,/npx cache/);
  assert.equal(maintenance.capabilities(a).uninstall,false);
});

test('a tool that is not installed fails with a plain reason',{skip},async t=>{
  const m=await machine(t);const r=m.run('goose');assert.notEqual(r.code,0);assert.match(r.out,/Goose is not installed here/);
});

test('exit code 0 with the old version still first on PATH counts as failed',()=>{
  assert.deepEqual(u.verdict({name:'Codex CLI',code:0,item:{installed:'0.41.0',latest:'0.41.0',outdated:false}}),{ok:true});
  assert.deepEqual(u.verdict({name:'Codex CLI',code:0,item:null}),{ok:true,unverified:true});
  const old=u.verdict({name:'Codex CLI',code:0,item:{installed:'0.39.0',latest:'0.41.0',outdated:true,path:'/opt/homebrew/bin/codex'},ran:{path:'/Users/me/.nvm/versions/node/v20.11.0/bin/codex'}});
  assert.equal(old.ok,false);assert.match(old.reason,/ended without an error, but Codex CLI is still 0\.39\.0 \(the latest is 0\.41\.0\) at \/opt\/homebrew\/bin\/codex/);
  assert.match(old.reason,/\.nvm\/versions\/node\/v20\.11\.0\/bin\/codex/,'names the copy the update changed');
  assert.equal(u.verdict({name:'Hermes Agent',code:0,item:{installed:'0.9',outdated:true,note:'3 updates behind'}}).ok,false);
  assert.match(u.verdict({name:'Claude Code',code:1}).reason,/exit code 1/);
  assert.match(u.verdict({name:'Node.js',code:3}).reason,/Opaya's own installer/);
  assert.match(u.verdict({name:'Aider',code:0,item:{missing:true}}).reason,/no longer found/);
  assert.equal(u.verdict({name:'X',code:0,error:'Timed out'}).reason,'Timed out');
});

test('the Opaya Agent gets every failed update in one message, with the end of the output and no secrets',()=>{
  const key='sk-ant-api03-'+'Q'.repeat(40);
  const out=`[opaya] Updating Codex CLI\n[opaya] method=npm via=homebrew path=/opt/homebrew/bin/codex\n${Array.from({length:60},(_,i)=>`line ${i}`).join('\n')}\nnpm error code EACCES\nANTHROPIC_API_KEY=${key}\n`;
  const shown=secrets.shieldOutput(u.tail(out),[]);assert(!shown.includes(key),'keys never reach the Opaya Agent');assert(shown.includes('npm error code EACCES'));assert(!shown.includes('line 5\n'),'only the last lines');
  const failed=[
    {name:'Codex CLI',tool:'codex',machine:'This computer',machineId:'',how:'npm (Homebrew Node.js)',path:'/opt/homebrew/bin/codex',plan:'npm install -g @openai/codex@latest (with the npm that owns it)',terminal:'t1',code:243,installed:'0.39.0',latest:'0.41.0',reason:'The update ended with exit code 243.',output:shown},
    {name:'Claude Code',tool:'claude',machine:'Build box',machineId:'h1',how:'Homebrew cask',path:'/opt/homebrew/bin/claude',plan:'brew upgrade --cask claude-code',terminal:'t2',code:0,installed:'2.0.1',after:'2.0.1',latest:'2.0.5',reason:'The update ended without an error, but Claude Code is still 2.0.1.',output:'==> Upgrading claude-code'}
  ];
  const p=u.handoffPrompt(failed);
  assert.match(p,/^2 updates I started did not finish or did not take effect/);
  assert.match(p,/1\. Codex CLI \(framework_id codex\) on This computer \(this computer\): installed with npm \(Homebrew Node\.js\) at \/opt\/homebrew\/bin\/codex/);
  assert.match(p,/2\. Claude Code \(framework_id claude\) on Build box \(machine_id h1\): installed with Homebrew cask/);
  assert.match(p,/terminal_id t1/);assert.match(p,/243/);assert.match(p,/npm error code EACCES/);assert.match(p,/==> Upgrading claude-code/);assert.match(p,/latest 2\.0\.5/);
  assert.match(p,/Do not run the same failing command again unchanged/);assert(!p.includes(key));
  assert.match(u.handoffPrompt(failed.slice(0,1)),/^An update I started/);
  // What the script reported comes back for the hand-off.
  const ran=u.report(`${out}[opaya] before: codex-cli 0.39.0\n[opaya] after: codex-cli 0.39.0\n`);
  assert.equal(ran.method,'npm');assert.equal(ran.via,'homebrew');assert.equal(ran.path,'/opt/homebrew/bin/codex');assert.equal(ran.before,'codex-cli 0.39.0');assert.equal(ran.after,'codex-cli 0.39.0');
});

test('the Opaya Agent reads versions with the same detection its update uses',{skip},()=>{
  const r=spawnSync('sh',['-c',u.versionsCheck()],{encoding:'utf8',env:{HOME:'/nonexistent',PATH:'/usr/bin:/bin'}});assert.equal(r.status,0,r.stderr);
  assert.match(r.stdout,/^hermes: /m);assert.match(r.stdout,/^codex: (not installed|.+\(\w+)/m);
  assert.match(u.versionsCheck({windows:true}),/OpayaHow \$p/);
});
