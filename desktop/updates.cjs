'use strict';
// How each agent and tool is installed on a machine, and the update that fits that installation. The scripts find the
// program the way Opaya's version check finds it (TOOL_PATH), follow its symlinks and read the install method from where
// it lives: a Homebrew Cellar or Caskroom, the npm prefix of nvm, fnm, asdf, mise or Homebrew Node.js, Volta, pnpm, yarn,
// bun, the npx cache, a vendor installer (Claude Code native, Codex standalone, OpenCode, Goose, Hermes, uv), uv tool,
// pipx, pip, winget, scoop, choco or the system package manager. Then they update that copy with its own tool. Detection
// runs on the machine itself, so it is right over SSH too. Commands are fixed: only the package names below go into them;
// values read on the machine (a Homebrew formula or cask name, an npm prefix) are checked against known names or quoted.
const quote=v=>"'"+String(v).replace(/'/g,"'\\''")+"'";
// Where Opaya looks for programs, in its order: Opaya's own tools, the per-user installers, Homebrew, then the shell's
// PATH, then version managers. The version check uses the same PATH, so "installed" and "updated" mean the same copy.
const TOOL_PATH='PATH="$HOME/.opaya/tools/node/bin:$HOME/.opaya/tools/python/bin:$HOME/.opaya/tools/bin:$HOME/.local/bin:$HOME/.cargo/bin:$HOME/.npm-global/bin:$HOME/.volta/bin:$HOME/.bun/bin:$HOME/.opencode/bin:/opt/homebrew/bin:/usr/local/bin:$PATH:/home/linuxbrew/.linuxbrew/bin:$HOME/Library/pnpm:$HOME/.local/share/pnpm:$HOME/.asdf/shims:$HOME/.local/share/mise/shims"; for d in "$HOME"/.nvm/versions/node/*/bin; do [ -d "$d" ] && PATH="$PATH:$d"; done; export PATH';
// Install location -> method: globs on the resolved path (symlinks followed), first match wins. The same table becomes
// a sh `case`, a PowerShell `switch -Wildcard` and classify() below. Order matters: a Homebrew formula can hold
// node_modules, and an npm package can sit under Opaya's or nvm's Node.js.
const WHERE=[
  ['npx',['*/_npx/*']],
  ['cask',['*/Caskroom/*']],
  ['brew',['*/Cellar/*']],
  ['scoop',['*/scoop/*']],
  ['choco',['*/chocolatey/*']],
  ['winget',['*/WinGet/*']],
  ['bun',['*/.bun/*']],
  ['pnpm',['*/pnpm/*']],
  ['volta',['*/.volta/*','*/Volta/*']],
  ['yarn',['*/.yarn/*','*/yarn/global/*','*/Yarn/*']],
  ['npm',['*/node_modules/*','*/AppData/Roaming/npm/*']],
  ['opaya',['*/.opaya/tools/*','*/Opaya/tools/*']],
  ['nvm',['*/.nvm/*','*/nvm/*','*/nvm4w/*']],
  ['fnm',['*/fnm/*','*/fnm_multishells/*']],
  ['asdf',['*/.asdf/*']],
  ['mise',['*/mise/*']],
  ['native',['*/.local/share/claude/*','*/.local/bin/claude.exe']],
  ['standalone',['*/.codex/packages/*']],
  ['uv',['*/uv/tools/*']],
  ['pipx',['*/pipx/*']],
  ['pip',['*/Library/Python/*','*/site-packages/*','*/Python3*/Scripts/*']],
  ['hermes',['*/.hermes/*','*/hermes-agent/*','*/hermes/*']],
  ['app',['*.app/*','*/Programs/Ollama/*']],
  ['snap',['/snap/*']],
  ['nix',['/nix/*']],
  ['system',['/usr/bin/*','/bin/*','/usr/sbin/*','/sbin/*','/usr/lib/*','/usr/libexec/*','/usr/share/*']],
  ['installer',['*/.opencode/*','*/.local/bin/*','*/.cargo/bin/*','/usr/local/*','/opt/*','*/Program Files/*','*/Programs/*']]
];
// Whose npm prefix an npm package is in (shown as "npm (nvm)").
const VIA=[
  ['nvm',['*/.nvm/*','*/nvm/*']],['fnm',['*/fnm/*','*/fnm_multishells/*']],['asdf',['*/.asdf/*']],['mise',['*/mise/*']],
  ['user',['*/.npm-global/*']],['opaya',['*/.opaya/tools/*','*/Opaya/tools/*']],['homebrew',['/opt/homebrew/*','/home/linuxbrew/*']],
  ['local',['/usr/local/*']],['system',['/usr/*']]
];
const LABELS={npx:'npx',cask:'Homebrew cask',brew:'Homebrew',scoop:'Scoop',choco:'Chocolatey',winget:'WinGet',bun:'bun',pnpm:'pnpm',volta:'Volta',yarn:'yarn',npm:'npm',
  opaya:"Opaya's installer",nvm:'nvm',fnm:'fnm',asdf:'asdf',mise:'mise',native:'native installer',standalone:'standalone installer',uv:'uv tool',pipx:'pipx',pip:'pip',
  hermes:'Hermes installer',app:'app',snap:'snap',nix:'Nix',system:'system package',installer:'official installer',other:'unknown',none:'not installed'};
const VIA_LABELS={nvm:'nvm',fnm:'fnm',asdf:'asdf',mise:'mise',user:'~/.npm-global',opaya:"Opaya's Node.js",homebrew:'Homebrew Node.js',local:'/usr/local',system:'system Node.js'};
function label(method,via=''){const m=LABELS[method]||method||'unknown';return method==='npm'&&VIA_LABELS[via]?`npm (${VIA_LABELS[via]})`:m;}
// The same classification in JavaScript (tests, and Windows paths): case-insensitive on Windows, like PowerShell -like.
const globRe=(glob,windows)=>new RegExp('^'+glob.split('*').map(s=>s.replace(/[.+?^${}()|[\]\\]/g,'\\$&')).join('.*')+'$',windows?'i':'');
function classify(file,{windows=/^[A-Za-z]:[\\/]/.test(String(file||''))}={}){
  const p=String(file||'').replace(/\\/g,'/');if(!p)return {method:'none',via:'',label:label('none')};
  const hit=table=>(table.find(([,globs])=>globs.some(g=>globRe(g,windows).test(p)))||[])[0]||'';
  const method=hit(WHERE)||'other',via=method==='npm'?hit(VIA):'';
  return {method,via,label:label(method,via)};
}
// ---- What each tool is and how each method updates it ------------------------------------------------------------
// npm: package; cask / brew: known Homebrew names (the first is the default); self: the vendor's own updater, used for
// the methods in `own`; installer: the vendor install script, which also updates; system: apt / dnf names.
const SPECS={
  hermes:{name:'Hermes Agent',bin:'hermes',self:'hermes update',own:['hermes','installer'],uv:'hermes-agent',pipx:'hermes-agent',winSelf:'hermes update'},
  claude:{name:'Claude Code',bin:'claude',npm:'@anthropic-ai/claude-code',self:'claude update',own:['native','installer'],cask:['claude-code','claude-code@latest'],system:{apt:'claude-code',dnf:'claude-code'},winget:'Anthropic.ClaudeCode',winSelf:'claude update'},
  codex:{name:'Codex CLI',bin:'codex',npm:'@openai/codex',cask:['codex'],brew:['codex'],own:['standalone'],installer:{posix:'curl -fsSL https://chatgpt.com/codex/install.sh | sh',windows:'irm https://chatgpt.com/codex/install.ps1 | iex'}},
  // OpenClaw's gateway keeps running the old code until it restarts.
  openclaw:{name:'OpenClaw',bin:'openclaw',npm:'openclaw',self:'openclaw update --yes',own:['installer','other'],then:'openclaw gateway restart >/dev/null 2>&1 || true',winSelf:'openclaw update --yes'},
  opencode:{name:'OpenCode',bin:'opencode',npm:'opencode-ai',brew:['opencode'],self:'opencode upgrade',own:['installer'],scoop:'opencode',choco:'opencode',winSelf:'opencode upgrade'},
  goose:{name:'Goose',bin:'goose',brew:['block-goose-cli'],self:'goose update',own:['installer','other'],windows:false},
  aider:{name:'Aider',bin:'aider',uv:'aider-chat',uvUp:'uv tool install --force --python python3.12 --with pip aider-chat@latest',pipx:'aider-chat',pip:'aider-chat',brew:['aider']},
  ollama:{name:'Ollama',bin:'ollama',brew:['ollama'],cask:['ollama-app','ollama'],winget:'Ollama.Ollama',own:['installer'],installer:{posix:'curl -fsSL https://ollama.com/install.sh | sh'},app:true},
  node:{name:'Node.js',bin:'node',brew:['node','node@[0-9]*'],system:{apt:'nodejs',dnf:'nodejs'},winget:'OpenJS.NodeJS.LTS',opaya:true,runtime:true},
  python:{name:'Python 3',bin:'python3',win:'python',brew:['python@3*','python3','python'],system:{apt:'python3',dnf:'python3'},opaya:true,wingetPython:true},
  git:{name:'Git',bin:'git',brew:['git'],system:{apt:'git',dnf:'git'},winget:'Git.Git',opaya:true},
  uv:{name:'uv',bin:'uv',brew:['uv'],self:'uv self update',own:['installer','other'],pipx:'uv',pip:'uv',winget:'astral-sh.uv',scoop:'uv',opaya:true,winSelf:'uv self update'},
  tmux:{name:'tmux',bin:'tmux',brew:['tmux'],system:{apt:'tmux',dnf:'tmux'},windows:false},
  openssh:{name:'OpenSSH client',bin:'ssh',brew:['openssh'],system:{apt:'openssh-client',dnf:'openssh-clients'},windows:false},
  gh:{name:'GitHub CLI',bin:'gh',brew:['gh'],system:{apt:'gh',dnf:'gh'},winget:'GitHub.cli',scoop:'gh',choco:'gh',opaya:true},
  docker:{name:'Docker',bin:'docker',cask:['docker','docker-desktop'],brew:['docker'],system:{apt:'docker-ce docker-ce-cli containerd.io',dnf:'docker-ce docker-ce-cli containerd.io'},winget:'Docker.DockerDesktop',app:true}
};
// Methods an update can be forced to (the Opaya Agent's update_framework `how`), per tool.
function methodsOf(id,{windows=false}={}){
  const s=SPECS[id];if(!s)return [];
  const m=new Set(['auto']);
  if(s.npm)for(const x of ['npm','npx','bun','pnpm','yarn','volta'])m.add(x);
  if(s.self||s.installer?.[windows?'windows':'posix'])m.add('self');
  if(windows){if(s.winget||s.wingetPython)m.add('winget');if(s.scoop)m.add('scoop');if(s.choco)m.add('choco');}
  else{if(s.cask)m.add('cask');if(s.brew)m.add('brew');if(s.system)m.add('system');if(s.runtime)for(const x of ['nvm','fnm','volta','mise'])m.add(x);}
  if(s.uv)m.add('uv');if(s.pipx)m.add('pipx');if(s.pip)m.add('pip');
  return [...m];
}
// ---- POSIX sh ------------------------------------------------------------------------------------------------------
const caseOf=(table,v)=>table.map(([name,globs])=>`${globs.map(g=>g.replace(/ /g,'\\ ')).join('|')}) ${v}=${name};;`).join(' ');
// how <path>: sets m (method) and v (whose npm prefix). real <path>: follows symlinks without readlink -f (old macOS),
// then drops the ../ they leave ("/opt/homebrew/bin/../lib/node_modules").
const HOW=`how(){ case $1 in ${caseOf(WHERE,'m')} *) m=other;; esac; v=; if [ "$m" = npm ]; then case $1 in ${caseOf(VIA,'v')} esac; fi; }`;
const REAL='real(){ f=$1; k=0; while [ -L "$f" ] && [ $k -lt 40 ]; do l=$(readlink "$f"); case $l in /*) f=$l;; *) f=${f%/*}/$l;; esac; k=$((k+1)); done; [ -n "${f%/*}" ] && d=$(cd "${f%/*}" 2>/dev/null && pwd -P) && f=$d/${f##*/}; printf %s "$f"; }';
// find <bin>: p = what PATH runs, r = the real file behind it (asdf and mise shims asked where they point).
const FIND='find_(){ p=$(command -v "$1" 2>/dev/null); r=$p; case $p in */.asdf/shims/*) r=$(asdf which "$1" 2>/dev/null || echo "$p");; */mise/shims/*) r=$(mise which "$1" 2>/dev/null || echo "$p");; esac; [ -n "$r" ] && r=$(real "$r"); how "$r"; [ "$m" = other ] && [ -n "$p" ] && how "$p"; [ -n "$p" ] || m=none; }';
const SAY="say(){ printf '[opaya] %s\\n' \"$*\"; }";
// sudo only when needed and never silently: the step says why, and the user types the password in the terminal.
const SUDO='S=; [ "$(id -u)" = 0 ] || S=sudo';
// The npm that owns the package's prefix (nvm, fnm, asdf, mise, Homebrew or system Node.js), and that prefix
// explicitly, so a prefix in ~/.npmrc (Opaya's old ~/.npm-global fallback) cannot send the update to another copy.
const NPM_UP=`npm_up(){ pre=; case $r in */lib/node_modules/*) pre=\${r%%/lib/node_modules/*};; esac; if [ -z "$pre" ]; then say "npm install -g $1@latest"; npm install -g "$1@latest"; return; fi; np=npm; if [ -x "$pre/bin/npm" ]; then np=$pre/bin/npm; [ -x "$pre/bin/node" ] && PATH="$pre/bin:$PATH"; fi; say "npm prefix $pre"; if [ -w "$pre/lib/node_modules" ]; then "$np" install -g --prefix "$pre" "$1@latest"; else say "$pre/lib/node_modules belongs to another user (usually root), so npm needs administrator rights to update this copy. Type your computer password below if asked (it stays invisible)."; ${SUDO}; $S env "PATH=$PATH" "$np" install -g --prefix "$pre" "$1@latest"; fi; }`;
const PM_UP='pm_up(){ case $1 in bun) bun add -g "$2@latest";; pnpm) pnpm add -g "$2@latest";; yarn) yarn global add "$2@latest";; volta) volta install "$2@latest";; esac; }';
// npx keeps packages in <npm cache>/_npx/<hash>: remove the copies of this package so the next run gets the newest,
// then fetch it once.
const NPX_UP='npx_up(){ c=$(npm config get cache 2>/dev/null); [ -d "$c" ] || c=$HOME/.npm; for d in "$c"/_npx/*/; do [ -f "${d}node_modules/$1/package.json" ] && rm -rf "$d" && say "Removed an old npx copy in $d"; done; npx -y "$1" --version; }';
// The brew that owns the Cellar or Caskroom; Intel Homebrew in /usr/local runs under Rosetta on Apple Silicon.
const BREW='brew_do(){ bp=; case $r in */Cellar/*) bp=${r%%/Cellar/*};; */Caskroom/*) bp=${r%%/Caskroom/*};; esac; b=brew; [ -n "$bp" ] && [ -x "$bp/bin/brew" ] && b=$bp/bin/brew; if [ "$bp" = /usr/local ] && [ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ]; then say "Intel Homebrew in /usr/local runs through Rosetta"; arch -x86_64 "$b" "$@"; else "$b" "$@"; fi; }';
const pick=(from,names,dflt)=>`t=\${r#*/${from}/}; t=\${t%%/*}; case $t in ${names.join('|')}) ;; *) t=${dflt};; esac`;
const has=bin=>`command -v ${bin} >/dev/null 2>&1`;
function systemUp(s){
  const {apt,dnf}=s.system;
  return `if [ "$(uname -s)" = Darwin ]; then say "$p comes with macOS (Apple's command line tools). Update them in System Settings > General > Software Update."; false; else ${SUDO}; if ${has('apt-get')}; then $S apt-get update && $S env DEBIAN_FRONTEND=noninteractive apt-get install -y --only-upgrade ${apt}; elif ${has('dnf')}; then $S dnf upgrade -y ${dnf}; elif ${has('yum')}; then $S yum update -y ${dnf}; else say 'Update it with your system package manager.'; false; fi; fi`;
}
// When the install location says nothing: the sensible ways in order, each only when it owns the tool.
function fallback(s){
  const tries=[];
  for(const c of s.cask||[])tries.push([`${has('brew')} && brew list --cask ${c} >/dev/null 2>&1`,`brew upgrade --cask --greedy ${c}`]);
  for(const f of (s.brew||[]).filter(f=>!/[*[]/.test(f)))tries.push([`${has('brew')} && brew list --formula ${f} >/dev/null 2>&1`,`brew upgrade ${f}`]);
  if(s.npm)tries.push([`${has('npm')} && npm ls -g --depth=0 ${s.npm} >/dev/null 2>&1`,`npm_up ${s.npm}`]);
  if(s.uv)tries.push([`${has('uv')} && uv tool list 2>/dev/null | grep -q '^${s.uv} '`,s.uvUp||`uv tool upgrade ${s.uv}`]);
  if(s.pipx)tries.push([`${has('pipx')} && pipx list --short 2>/dev/null | grep -q '^${s.pipx} '`,`pipx upgrade ${s.pipx}`]);
  if(s.self)tries.push(['[ -n "$p" ]',s.self]);
  if(s.pip)tries.push([`${has('python3')} && python3 -m pip show ${s.pip} >/dev/null 2>&1`,`python3 -m pip install --user -U --upgrade-strategy only-if-needed ${s.pip}`]);
  const last=`say ${quote(`Opaya could not tell how ${s.name} is installed here`)} "($p)."; false`;
  return tries.length?tries.map(([test,run],i)=>`${i?'elif':'if'} ${test}; then ${run}`).join('; ')+`; else ${last}; fi`:last;
}
function posixCases(id,s){
  const out=[];
  if(s.self&&s.own)out.push(`${s.own.join('|')}) ${s.self};;`);
  if(s.installer?.posix&&s.own&&!s.self)out.push(`${s.own.join('|')}) ${s.installer.posix};;`);
  if(s.opaya)out.push(`opaya) say "Opaya installed this copy ($p). Opaya updates it with its own installer: Install agents > this computer, or ask the Opaya Agent."; exit 3;;`);
  if(s.npm){
    out.push(`npm) npm_up ${s.npm}${s.then?` && { ${s.then}; }`:''};;`,`bun|pnpm|yarn|volta) pm_up "$m" ${s.npm};;`,`npx) npx_up ${s.npm};;`);
  }
  if(s.runtime)out.push('nvm|fnm|volta|mise) cur=$("$p" -v); mj=${cur%%.*}; mj=${mj#v}; case $m in nvm) export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"; . "$NVM_DIR/nvm.sh" && nvm install "$mj" --reinstall-packages-from="$cur" && { [ "$(nvm version default)" != "$cur" ] || nvm alias default "$mj"; };; fnm) fnm install "$mj" && fnm default "$mj";; volta) volta install "node@$mj";; mise) mise use -g "node@$mj";; esac;;');
  if(s.cask)out.push(`cask) ${pick('Caskroom',s.cask,s.cask[0])}; brew_do upgrade --cask --greedy "$t";;`);
  if(s.brew)out.push(`brew) ${pick('Cellar',s.brew,s.brew[0].replace(/[*[].*$/,''))}; brew_do upgrade "$t";;`);
  if(s.uv)out.push(`uv) ${s.uvUp||`uv tool upgrade ${s.uv}`};;`);
  if(s.pipx)out.push(`pipx) pipx upgrade ${s.pipx};;`);
  if(s.pip)out.push(`pip) python3 -m pip install --user -U --upgrade-strategy only-if-needed ${s.pip};;`);
  if(s.system)out.push(`system) ${systemUp(s)};;`);
  if(s.app&&id==='ollama')out.push(`app) if ${has('brew')} && brew list --cask ollama-app >/dev/null 2>&1; then brew upgrade --cask --greedy ollama-app; else a=\${r%%/Ollama.app/*}; say "Downloading the newest Ollama.app into $a"; curl -fsSL -o /tmp/Ollama-darwin.zip https://ollama.com/download/Ollama-darwin.zip && { osascript -e 'quit app "Ollama"' >/dev/null 2>&1; ditto -x -k /tmp/Ollama-darwin.zip "$a" && open -a "$a/Ollama.app"; }; fi;;`);
  if(s.app&&id==='docker')out.push(`app) if ${has('brew')} && brew list --cask docker >/dev/null 2>&1; then brew upgrade --cask --greedy docker; else say 'Docker Desktop updates itself: open it and choose Check for updates.'; false; fi;;`);
  if(s.installer?.posix&&!(s.own&&!s.self))out.push(`installer) ${s.installer.posix};;`);
  if(id==='ollama')out.push(`snap) ${SUDO}; $S snap refresh ollama;;`);
  out.push(`none) say ${quote(`${s.name} is not installed here.`)}; false;;`,`*) ${fallback(s)};;`);
  return out;
}
function posixScript(id,{how='auto'}={}){
  const s=SPECS[id];if(!s)throw new Error(`Opaya has no update for ${id}.`);
  if(how!=='auto'&&!methodsOf(id).includes(how))throw new Error(`${s.name} cannot be updated with ${how} here. It can be: ${methodsOf(id).join(', ')}.`);
  const cases=posixCases(id,s),text=cases.join(' ');
  const helpers=[SAY,REAL,HOW,FIND,/npm_up/.test(text)&&NPM_UP,/pm_up/.test(text)&&PM_UP,/npx_up/.test(text)&&NPX_UP,/brew_do/.test(text)&&BREW].filter(Boolean);
  const ver=`$(${s.bin} --version 2>&1 | grep -m1 -E '[0-9]+\\.[0-9]+')`;
  // Not on PATH, but run through npx: that is its installation.
  const npxOnly=s.npm?`if [ "$m" = none ] && ls "$(npm config get cache 2>/dev/null || echo "$HOME/.npm")"/_npx/*/node_modules/${s.npm}/package.json >/dev/null 2>&1; then m=npx; fi`:'';
  const forced=how==='self'?(s.self||s.installer?.posix?`m=${(s.own||['installer'])[0]}`:''):how!=='auto'?`m=${how}`:'';
  const lines=[TOOL_PATH,...helpers,`find_ ${s.bin}`,npxOnly,forced,
    `say "method=$m via=$v path=$p$([ "$r" = "$p" ] || printf ' -> %s' "$r")"`,`[ -n "$p" ] && say "before: ${ver}"`,
    `case $m in\n${cases.join('\n')}\nesac`,'rc=$?','hash -r 2>/dev/null',`[ -n "$p" ] && say "after: ${ver}"`,'exit $rc'].filter(Boolean);
  return `sh -c ${quote(lines.join('\n'))}`;
}
// ---- Windows PowerShell --------------------------------------------------------------------------------------------
const psGlob=g=>`'${g.replace(/\//g,'\\')}'`;
const psSwitch=(table,dflt)=>`switch -Wildcard ($x) { ${table.map(([name,globs])=>globs.map(g=>`${psGlob(g)} {'${name}';break}`).join(' ')).join(' ')} default {'${dflt}'} }`;
const PS_HOW=`function OpayaHow($x) { if (-not $x) { return 'none' }; ${psSwitch(WHERE,'other')} }; function OpayaVia($x) { ${psSwitch(VIA,'')} }`;
const PS_FIND=bin=>`$opP=(Get-Command ${bin} -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source; $opR=$opP; if ($opP) { try { $t=(Get-Item -LiteralPath $opP -ErrorAction Stop).Target; if ($t) { $opR=[string]@($t)[0] } } catch {} }; $opM=OpayaHow $opR; if ($opM -eq 'other' -and $opP) { $opM=OpayaHow $opP }; $opV=if ($opM -eq 'npm') { OpayaVia $opR } else { '' }`;
const psWinget=id=>`winget upgrade --id ${id} -e --accept-source-agreements --accept-package-agreements; if ($LASTEXITCODE -eq -1978335189) { Write-Host '[opaya] WinGet has no newer version.'; cmd /c exit 0 }`;
function windowsCases(id,s){
  const out=[],pkg=s.npm,npmDir=pkg?pkg.replace(/\//g,'\\'):'';
  if(s.winSelf&&s.own)out.push(`{$_ -in ${s.own.map(m=>`'${m}'`).join(',')}} { ${s.winSelf}; break }`);
  if(s.installer?.windows&&s.own)out.push(`{$_ -in ${s.own.map(m=>`'${m}'`).join(',')}} { ${s.installer.windows}; break }`);
  if(s.opaya)out.push(`'opaya' { Write-Host "[opaya] Opaya installed this copy ($opP). Opaya updates it with its own installer: Install agents > this computer, or ask the Opaya Agent."; cmd /c exit 3; break }`);
  if(pkg){
    out.push(`'npm' { $pre=Split-Path $opP; if (Test-Path (Join-Path $pre 'node_modules\\${npmDir}')) { Write-Host "[opaya] npm prefix $pre"; npm.cmd install -g --prefix "$pre" ${pkg}@latest } else { npm.cmd install -g ${pkg}@latest }; break }`,
      `'bun' { bun add -g ${pkg}@latest; break }`,`'pnpm' { pnpm add -g ${pkg}@latest; break }`,`'yarn' { yarn global add ${pkg}@latest; break }`,`'volta' { volta install ${pkg}@latest; break }`,
      `'npx' { $c=(npm.cmd config get cache); Get-ChildItem -Directory (Join-Path $c '_npx') -ErrorAction SilentlyContinue | Where-Object { Test-Path (Join-Path $_.FullName 'node_modules\\${npmDir}\\package.json') } | ForEach-Object { Remove-Item -Recurse -Force $_.FullName; Write-Host "[opaya] Removed an old npx copy in $($_.FullName)" }; npx.cmd -y ${pkg} --version; break }`);
  }
  if(s.winget)out.push(`'winget' { ${psWinget(s.winget)}; break }`);
  if(s.wingetPython)out.push(`'winget' { $mi=((& $opP --version 2>&1) -replace '^\\D*3\\.(\\d+).*$','$1'); if ($mi -match '^\\d+$') { ${psWinget('"Python.Python.3.$mi"')} } else { cmd /c exit 1 }; break }`);
  if(s.scoop)out.push(`'scoop' { scoop update ${s.scoop}; break }`);
  // Chocolatey needs an administrator: Windows asks for approval.
  if(s.choco)out.push(`'choco' { Start-Process choco -ArgumentList 'upgrade','${s.choco}','-y' -Verb RunAs -Wait; break }`);
  if(s.uv)out.push(`'uv' { ${s.uvUp||`uv tool upgrade ${s.uv}`}; break }`);
  if(s.pipx)out.push(`'pipx' { pipx upgrade ${s.pipx}; break }`);
  if(s.pip)out.push(`'pip' { py -m pip install --user -U --upgrade-strategy only-if-needed ${s.pip}; break }`);
  out.push(`'none' { Write-Host '[opaya] ${s.name} is not installed here.'; cmd /c exit 1; break }`);
  // Unknown: WinGet when it knows the package, then npm when it owns it, then the vendor's own updater.
  const tries=[];
  if(s.winget)tries.push([`(Get-Command winget -ErrorAction SilentlyContinue) -and (winget list --id ${s.winget} -e 2>$null | Select-String -SimpleMatch '${s.winget}')`,psWinget(s.winget)]);
  if(pkg)tries.push([`(Get-Command npm.cmd -ErrorAction SilentlyContinue) -and ((npm.cmd ls -g --depth=0 ${pkg} 2>$null) -match '${pkg.replace(/[.]/g,'\\.')}@')`,`npm.cmd install -g ${pkg}@latest`]);
  if(s.winSelf)tries.push(['$opP',s.winSelf]);
  const last=`Write-Host "[opaya] Opaya could not tell how ${s.name} is installed here ($opP)."; cmd /c exit 1`;
  out.push(`default { ${tries.length?tries.map(([t,r],i)=>`${i?'elseif':'if'} (${t}) { ${r} }`).join(' ')+` else { ${last} }`:last} }`);
  return out;
}
function windowsScript(id,{how='auto'}={}){
  const s=SPECS[id];if(!s)throw new Error(`Opaya has no update for ${id}.`);if(s.windows===false)return '';
  if(how!=='auto'&&!methodsOf(id,{windows:true}).includes(how))throw new Error(`${s.name} cannot be updated with ${how} on Windows. It can be: ${methodsOf(id,{windows:true}).join(', ')}.`);
  const bin=s.win||s.bin,ver=`$((& ${bin} --version 2>&1 | Select-Object -First 1))`;
  const npxOnly=s.npm?`if ($opM -eq 'none') { $c=(npm.cmd config get cache 2>$null); if ($c -and (Test-Path (Join-Path $c '_npx\\*\\node_modules\\${s.npm.replace(/\//g,'\\')}\\package.json'))) { $opM='npx' } }; `:'';
  const forced=how==='self'?`$opM='${(s.own||['installer'])[0]}'; `:how!=='auto'?`$opM='${how}'; `:'';
  return `${PS_HOW}; ${PS_FIND(bin)}; ${npxOnly}${forced}Write-Host "[opaya] method=$opM via=$opV path=$opP$(if ($opR -ne $opP) { ' -> ' + $opR })"; if ($opP) { Write-Host "[opaya] before: ${ver}" }; switch ($opM) { ${windowsCases(id,s).join(' ')} }; $opOk=$?; if ($opP) { Write-Host "[opaya] after: ${ver}" }; if ($opOk) { cmd /c exit 0 } else { cmd /c exit 1 }`;
}
function script(id,{windows=false,how='auto'}={}){return windows?windowsScript(id,{how}):posixScript(id,{how});}
// What the update runs for a method, in words for the approval: "brew upgrade --cask claude-code".
function plan(id,method,{windows=false}={}){
  const s=SPECS[id];if(!s)return '';const pkg=s.npm;
  const own=(s.own||[]).includes(method)?(windows?s.winSelf||s.installer?.windows:s.self||s.installer?.posix):'';
  const byMethod={npm:pkg&&`npm install -g ${pkg}@latest (with the npm that owns it)`,npx:pkg&&`refresh the npx copy of ${pkg}`,bun:pkg&&`bun add -g ${pkg}@latest`,pnpm:pkg&&`pnpm add -g ${pkg}@latest`,yarn:pkg&&`yarn global add ${pkg}@latest`,
    volta:s.runtime?'volta install node@<same major>':pkg&&`volta install ${pkg}@latest`,cask:s.cask&&`brew upgrade --cask ${s.cask[0]}`,brew:s.brew&&`brew upgrade ${s.brew[0].replace(/[*[].*$/,'')}`,
    uv:s.uv&&(s.uvUp||`uv tool upgrade ${s.uv}`),pipx:s.pipx&&`pipx upgrade ${s.pipx}`,pip:s.pip&&`pip install --user -U ${s.pip}`,system:s.system&&(windows?'':`apt-get / dnf upgrade ${s.system.apt}`),
    winget:(s.winget||s.wingetPython)&&`winget upgrade ${s.winget||'Python.Python.3.x'}`,scoop:s.scoop&&`scoop update ${s.scoop}`,choco:s.choco&&`choco upgrade ${s.choco}`,
    nvm:s.runtime&&'nvm install <same major>',fnm:s.runtime&&'fnm install <same major>',mise:s.runtime&&'mise use -g node@<same major>',opaya:s.opaya&&"Opaya's built-in installer",
    installer:!own&&s.installer?.[windows?'windows':'posix']};
  return own||byMethod[method]||'finds the right way on the machine';
}
// ---- After an update ---------------------------------------------------------------------------------------------
// What the script reported: method, path, and the version before and after.
function report(output){
  const t=String(output||'').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g,'').replace(/\r/g,''),out={};
  const m=[...t.matchAll(/\[opaya\] method=(\S*) via=(\S*) path=([^\n]*)/g)].pop();
  if(m){out.method=m[1];out.via=m[2];const [p,r]=m[3].split(' -> ');out.path=p.trim();if(r)out.real=r.trim();out.label=label(m[1],m[2]);}
  const before=[...t.matchAll(/\[opaya\] before: ([^\n]*)/g)].pop(),after=[...t.matchAll(/\[opaya\] after: ([^\n]*)/g)].pop();
  if(before)out.before=before[1].trim();if(after)out.after=after[1].trim();
  return out;
}
// Whether an update took effect. Exit code 0 is not enough: when the version Opaya finds afterwards is still older than
// the latest, the update changed another copy (or none), and it counts as failed with a reason a person understands.
function verdict({name,code,error='',item=null,ran={}}){
  if(error)return {ok:false,reason:error};
  if(code!==0)return {ok:false,reason:code===3?`${name} was installed by Opaya's own installer, which updates it.`:`The update ended with exit code ${code}.`};
  if(!item)return {ok:true,unverified:true};
  if(item.missing)return {ok:false,reason:`The update finished, but ${name} is no longer found on PATH.`};
  if(!item.outdated)return {ok:true};
  const where=item.path||ran.path,other=ran.path&&item.path&&ran.path!==item.path;
  return {ok:false,reason:`The update ended without an error, but ${name} is still ${item.installed}${item.latest?` (the latest is ${item.latest})`:item.note?` (${item.note})`:''}${where?` at ${where}`:''}. ${other?`The update ran for ${ran.path}, but ${item.path} comes first on PATH, so that copy is the one in use.`:'That copy did not change: another installation was probably updated, or the update did not apply.'}`};
}
// The last lines a terminal printed, for a hand-off (the caller hides secrets in them first).
function tail(text,{lines=30,chars=2500}={}){
  const t=String(text||'').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g,'').replace(/\r/g,'').split('\n').filter(l=>l.trim()).slice(-lines).join('\n');
  return t.length>chars?t.slice(-chars):t;
}
// One message for the Opaya Agent with every update that failed or did not take effect in one run: machine, tool,
// install method, what ran, exit code, versions and the end of the output.
function handoffPrompt(failed){
  const list=failed.slice(0,12).map((f,i)=>{
    const where=f.machineId?`${f.machine} (machine_id ${f.machineId})`:`${f.machine} (this computer)`;
    const how=f.how?`installed with ${f.how}${f.path?` at ${f.path}`:''}`:f.path?`at ${f.path}`:'install method not detected';
    const versions=[f.installed&&`installed ${f.installed}`,f.after&&f.after!==f.installed&&`now ${f.after}`,f.latest&&`latest ${f.latest}`].filter(Boolean).join(', ');
    return `${i+1}. ${f.name}${f.tool&&f.tool!==f.name?` (framework_id ${f.tool})`:''} on ${where}: ${how}.\n   Ran: ${f.plan||'the update script'}${f.terminal?` (terminal_id ${f.terminal})`:''}. ${f.code===undefined||f.code===null?'It did not finish.':`Exit code ${f.code}.`}${versions?` Versions: ${versions}.`:''}\n   Why it counts as failed: ${f.reason}${f.output?`\n   Last output:\n${f.output.split('\n').map(l=>'   | '+l).join('\n')}`:''}`;
  });
  return [`${failed.length===1?'An update':`${failed.length} updates`} I started did not finish or did not take effect. Finish ${failed.length===1?'it':'each one'}, check the version afterwards, and tell me only what I must do myself (for example type my password in a terminal or sign in).`,
    ...list,failed.length>12?`...and ${failed.length-12} more: run_diagnostic versions on each machine to find them.`:'',
    'Do not run the same failing command again unchanged. Read the output and fix the cause first (for example a root-owned npm folder, a second copy that comes earlier on PATH, a missing PATH entry, a Homebrew lock or an old Node.js), then update with update_framework (it detects how the tool is installed; set how to another method when the detected one cannot work) or run_command. Follow every terminal with wait_for_terminal. Finally run_diagnostic versions on each machine and compare with the latest versions above.'].filter(Boolean).join('\n\n');
}
// The Opaya Agent's "versions" check: every tool with its version, how it is installed and where, with the same PATH
// and detection as the update scripts, so what it reads matches what an update will do.
const DIAG=['hermes','claude','codex','openclaw','opencode','goose','aider','ollama','node','npm','python3','uv','git','gh','brew','docker','tmux','ssh'];
function versionsCheck({windows=false}={}){
  if(windows)return `${PS_HOW}; foreach ($c in 'hermes','claude','codex','openclaw','opencode','goose','aider','ollama','node','npm','python','uv','git','gh','docker','ssh') { $p=(Get-Command $c -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source; if ($p) { $m=OpayaHow $p; $v=$(if ($m -eq 'npm') { OpayaVia $p } else { '' }); $a=$(if ($c -eq 'ssh') { '-V' } else { '--version' }); $n=((& $c $a 2>&1) | Select-Object -First 1); "$($c): $n ($m$(if ($v) { ' via ' + $v }), $p)" } else { "$($c): not installed" } }`;
  return `sh -c ${quote([TOOL_PATH,REAL,HOW,
    `for c in ${DIAG.join(' ')}; do p=$(command -v "$c" 2>/dev/null); if [ -z "$p" ]; then echo "$c: not installed"; continue; fi; r=$(real "$p"); how "$r"; [ "$m" = other ] && how "$p"; case $c in ssh|tmux) a=-V;; *) a=--version;; esac; n=$("$c" $a 2>&1 </dev/null | head -1); printf '%s: %s (%s%s, %s%s)\\n' "$c" "$n" "$m" "\${v:+ via $v}" "$p" "$([ "$r" = "$p" ] || printf ' -> %s' "$r")"; done`].join('\n'))}`;
}
module.exports={tail,versionsCheck,handoffPrompt,TOOL_PATH,WHERE,VIA,LABELS,SPECS,HOW,REAL,PS_HOW,label,classify,methodsOf,script,posixScript,windowsScript,plan,report,verdict};
