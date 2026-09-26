'use strict';
// Opaya installs the basics itself, without winget, Homebrew, apt, npm or any script: it downloads the official builds
// (Node.js with npm, Python, uv, GitHub CLI, and Git on Windows), checks their SHA-256, unpacks them into its own tools
// folder (no administrator rights) and puts that folder on the user's PATH. On macOS, Git comes from Apple's command
// line tools, which macOS installs itself after one click.
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {once}=require('node:events');
const {spawn,execFile}=require('node:child_process');
const {findExecutable,environment,opayaToolsRoot,opayaToolDirs,resetRegistryEnv}=require('./process.cjs');
const NAMES={node:'Node.js (with npm)',python:'Python 3',uv:'uv',gh:'GitHub CLI',git:'Git'};
const supports=(id,platform=process.platform)=>id==='git'?platform==='win32'||platform==='darwin':Object.hasOwn(NAMES,id);
const TRIPLES={'win32-x64':'x86_64-pc-windows-msvc','win32-arm64':'aarch64-pc-windows-msvc','darwin-x64':'x86_64-apple-darwin','darwin-arm64':'aarch64-apple-darwin','linux-x64':'x86_64-unknown-linux-gnu','linux-arm64':'aarch64-unknown-linux-gnu'};
const archOf=arch=>arch==='arm64'?'arm64':'x64';
const HEADERS={'User-Agent':'Opaya','Accept':'application/json'};
async function getJson(url,fetchImpl){const r=await fetchImpl(url,{headers:HEADERS,signal:AbortSignal.timeout(30000)});if(!r.ok)throw new Error(`${new URL(url).host} answered ${r.status}.`);return r.json();}
async function getText(url,fetchImpl){const r=await fetchImpl(url,{headers:{'User-Agent':'Opaya'},signal:AbortSignal.timeout(30000)});if(!r.ok)throw new Error(`${new URL(url).host} answered ${r.status}.`);return r.text();}
// ---- Choosing the right file (pure, tested for every platform) --------------------------------------------------
function nodeAsset(index,{platform,arch}){
  const lts=(index||[]).find(r=>r.lts);if(!lts)throw new Error('No Node.js LTS release found.');
  const os_=platform==='win32'?'win':platform,a=archOf(arch),base=`node-${lts.version}-${os_}-${a}`,file=`${base}.${platform==='win32'?'zip':'tar.gz'}`;
  return {version:lts.version,file,url:`https://nodejs.org/dist/${lts.version}/${file}`,sums:`https://nodejs.org/dist/${lts.version}/SHASUMS256.txt`,layout:{type:'dir',from:base,to:'node'}};
}
const REPOS={python:'astral-sh/python-build-standalone',uv:'astral-sh/uv',gh:'cli/cli',git:'git-for-windows/git'};
const LAYOUTS={python:{type:'dir',from:'python',to:'python'},uv:{type:'bins',names:['uv','uvx']},gh:{type:'bins',names:['gh']},git:{type:'sfx',to:'git'}};
// GitHub downloads without the GitHub API (which allows 60 requests an hour per network): the latest tag comes from
// the releases/latest redirect, file names follow each project's naming, checksums come from the files they publish.
function githubAsset(id,tag,{platform,arch,sums=''}){
  const a=archOf(arch),triple=TRIPLES[`${platform}-${a}`];if(!triple)throw new Error(`${NAMES[id]} has no build for this computer.`);
  const base=`https://github.com/${REPOS[id]}/releases/download/${tag}/`;let file;
  if(id==='uv')file=`uv-${triple}.${platform==='win32'?'zip':'tar.gz'}`;
  else if(id==='gh'){const v=tag.replace(/^v/,'');file=platform==='win32'?`gh_${v}_windows_${a==='arm64'?'arm64':'amd64'}.zip`:platform==='darwin'?`gh_${v}_macOS_${a==='arm64'?'arm64':'amd64'}.zip`:`gh_${v}_linux_${a==='arm64'?'arm64':'amd64'}.tar.gz`;}
  else if(id==='git'){const v=tag.replace(/^v/,'').replace(/\.windows\.1$/,'').replace(/\.windows\.(\d+)$/,'.$1');file=`PortableGit-${v}-${a==='arm64'?'arm64':'64-bit'}.7z.exe`;}
  else if(id==='python'){
    const re=new RegExp(`\\b(cpython-3\\.13\\.\\d+\\+${tag}-${triple}-install_only\\.tar\\.gz)\\b`),m=re.exec(sums);
    if(!m)throw new Error(`Python: no download for ${platform} ${arch} in ${tag}.`);file=m[1];
  }
  return {version:tag,file,url:base+encodeURIComponent(file).replace(/%2B/g,'+'),layout:LAYOUTS[id]};
}
// Where each project publishes checksums for a release.
function sumsUrl(id,tag,file){
  const base=`https://github.com/${REPOS[id]}/releases/download/${tag}/`;
  if(id==='uv')return base+`${file}.sha256`;
  if(id==='gh')return base+`gh_${tag.replace(/^v/,'')}_checksums.txt`;
  if(id==='python')return base+'SHA256SUMS';
  return `https://github.com/${REPOS[id]}/releases/tag/${tag}`; // Git for Windows: the table in its release notes
}
// A checksum from a sums file, or from a page that lists the file with its SHA-256 next to it.
function checksumFrom(text,file){
  const t=String(text||'');
  for(const line of t.split(/\r?\n/))if(line.includes(file)){const m=/\b([0-9a-f]{64})\b/i.exec(line);if(m)return m[1].toLowerCase();}
  // A web page (Git for Windows' release notes): the file name, then its SHA-256 in the next table cell.
  for(let i=t.indexOf(file);i>=0;i=t.indexOf(file,i+1)){const m=/^[^]{0,300}?\b([0-9a-f]{64})\b/i.exec(t.slice(i+file.length,i+file.length+300));if(m)return m[1].toLowerCase();}
  return '';
}
async function latestTag(repo,fetchImpl){
  const r=await fetchImpl(`https://github.com/${repo}/releases/latest`,{redirect:'manual',headers:{'User-Agent':'Opaya'},signal:AbortSignal.timeout(30000)});
  const to=r.headers?.get?.('location')||(r.redirected?r.url:'')||'';const m=/\/releases\/tag\/([^/?#]+)$/.exec(to);
  if(!m)throw new Error(`Could not find the latest release of ${repo} (GitHub answered ${r.status}).`);return decodeURIComponent(m[1]);
}
async function plan(id,{platform=process.platform,arch=process.arch,fetchImpl=globalThis.fetch}={}){
  if(id==='node'){const a=nodeAsset(await getJson('https://nodejs.org/dist/index.json',fetchImpl),{platform,arch});return {...a,sha256:checksumFrom(await getText(a.sums,fetchImpl),a.file)};}
  const tag=await latestTag(REPOS[id],fetchImpl);
  const sums=id==='python'?await getText(sumsUrl(id,tag),fetchImpl):'';
  const a=githubAsset(id,tag,{platform,arch,sums});
  a.sha256=checksumFrom(sums||await getText(sumsUrl(id,tag,a.file),fetchImpl),a.file);
  return a;
}
// ---- Download, verify, unpack ----------------------------------------------------------------------------------
async function download(url,file,{fetchImpl,onBytes}){
  const r=await fetchImpl(url,{headers:{'User-Agent':'Opaya'},redirect:'follow'});if(!r.ok)throw new Error(`Download failed (${r.status}).`);
  const total=Number(r.headers?.get?.('content-length'))||0,hash=crypto.createHash('sha256'),out=fs.createWriteStream(file);let bytes=0,last=0;
  try{for await(const chunk of r.body){const b=Buffer.from(chunk);hash.update(b);bytes+=b.length;if(!out.write(b))await once(out,'drain');if(Date.now()-last>250){last=Date.now();onBytes(bytes,total);}}}
  finally{await new Promise(resolve=>out.end(resolve));}
  onBytes(bytes,total||bytes);return hash.digest('hex');
}
function run(command,args,{timeout=10*60*1000,cwd}={}){return new Promise((resolve,reject)=>execFile(command,args,{env:environment(),timeout,windowsHide:true,cwd,maxBuffer:8*1024*1024},(e,out,err)=>e?reject(new Error(String(err||e.message).trim().split('\n').slice(-3).join(' ').slice(0,400))):resolve(String(out))));}
function tarPath(platform){if(platform==='win32'){const sys=path.join(process.env.SystemRoot||'C:\\Windows','System32','tar.exe');if(fs.existsSync(sys))return sys;}return findExecutable('tar',environment());}
async function unpack(file,dest,{platform}){
  await fsp.mkdir(dest,{recursive:true});
  const tar=tarPath(platform);if(!tar)throw new Error('tar is missing on this computer (Windows 10 version 1803 or newer includes it).');
  await run(tar,['-xf',file,'-C',dest]);
}
async function findFiles(dir,names,out=[]){for(const e of await fsp.readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())await findFiles(p,names,out);else if(names.includes(e.name))out.push(p);}return out;}
async function place(staging,root,layout,{platform}){
  if(layout.type==='dir'){const target=path.join(root,layout.to);await fsp.rm(target,{recursive:true,force:true});await fsp.rename(path.join(staging,layout.from),target);return target;}
  const bin=path.join(root,'bin');await fsp.mkdir(bin,{recursive:true});const names=layout.names.flatMap(n=>platform==='win32'?[`${n}.exe`]:[n]);
  const found=await findFiles(staging,names);if(!found.length)throw new Error('The download did not contain the expected program.');
  for(const f of found){const to=path.join(bin,path.basename(f));await fsp.rm(to,{force:true});await fsp.copyFile(f,to);if(platform!=='win32')await fsp.chmod(to,0o755);}
  return bin;
}
// ---- PATH for new terminals and apps -------------------------------------------------------------------------------
const WINDOWS_PATH_SCRIPT="$add = $env:OPAYA_DIRS -split ';'; $p = [Environment]::GetEnvironmentVariable('Path','User'); $parts = @(); if ($p) { $parts = @($p -split ';' | Where-Object { $_ }) }; $new = @($add) + @($parts | Where-Object { $add -notcontains $_ }); [Environment]::SetEnvironmentVariable('Path', ($new -join ';'), 'User'); if ($env:OPAYA_EXTRA) { ($env:OPAYA_EXTRA | ConvertFrom-Json).PSObject.Properties | ForEach-Object { [Environment]::SetEnvironmentVariable($_.Name, $_.Value, 'User') } }; try { if ((Get-ExecutionPolicy -Scope CurrentUser) -eq 'Undefined' -and @('Undefined','Restricted','AllSigned') -contains (Get-ExecutionPolicy -Scope LocalMachine)) { Set-ExecutionPolicy -Scope CurrentUser RemoteSigned -Force } } catch { Write-Warning ('PowerShell policy unchanged: ' + $_) }";
// Windows PowerShell 5 started from a PowerShell 7 (or VS Code) session inherits a module path that makes its own
// modules fail to load; without PSModulePath it rebuilds the right one.
function psEnv(extra){const env=environment(extra);for(const k of Object.keys(env))if(k.toUpperCase()==='PSMODULEPATH')delete env[k];return env;}
const BEGIN='# >>> Opaya tools >>>',END='# <<< Opaya tools <<<';
async function persistPath({platform=process.platform,root=opayaToolsRoot(platform),home=os.homedir(),extra={}}={}){
  const dirs=opayaToolDirs(platform,root);
  if(platform==='win32'){
    // User PATH (our folders first), extra user variables, and the execution policy npm's and agents' PowerShell
    // launchers need (RemoteSigned for this user only, as npm documents), unless a policy is already set.
    const ps=findExecutable('powershell.exe',environment())||findExecutable('pwsh.exe',environment());if(!ps)throw new Error('PowerShell was not found.');
    const script=WINDOWS_PATH_SCRIPT;
    await new Promise((resolve,reject)=>execFile(ps,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',script],{env:psEnv({OPAYA_DIRS:dirs.join(';'),OPAYA_EXTRA:JSON.stringify(extra)}),windowsHide:true,timeout:60000},e=>e?reject(e):resolve()));
    resetRegistryEnv();return {dirs};
  }
  const rel=dirs.map(d=>d.startsWith(home+'/')?`$HOME/${d.slice(home.length+1)}`:d);
  const block=`${BEGIN}\nexport PATH="${rel.join(':')}:$PATH"\n${END}\n`;
  const files=platform==='darwin'?['.zprofile','.zshrc','.bash_profile']:['.profile','.bashrc','.zshrc'];
  const written=[];
  for(const [i,name] of files.entries()){
    const file=path.join(home,name);let text='';try{text=await fsp.readFile(file,'utf8');}catch{if(i>0)continue;}
    const next=text.includes(BEGIN)?text.replace(new RegExp(`${BEGIN}[\\s\\S]*?${END}\\n?`),block):`${text}${text&&!text.endsWith('\n')?'\n':''}${block}`;
    if(next!==text){await fsp.writeFile(file,next);written.push(file);}
  }
  return {dirs,files:written};
}
// macOS: Git is part of Apple's command line tools. macOS shows its own install window after one click.
async function macGit(progress,{timeout=45*60*1000}={}){
  const ok=()=>run('/usr/bin/xcode-select',['-p'],{timeout:10000}).then(()=>run('/usr/bin/git',['--version'],{timeout:20000})).then(()=>true,()=>false);
  if(await ok())return {version:(await run('/usr/bin/git',['--version'])).trim()};
  spawn('/usr/bin/xcode-select',['--install'],{stdio:'ignore',detached:true}).unref();
  progress({message:'macOS opened a window to install its developer tools (Git comes with them). Click "Install" there and wait; this can take a few minutes.',state:'warn'});
  const end=Date.now()+timeout;while(!await ok()){if(Date.now()>end)throw new Error('The macOS developer tools did not finish installing. Open Terminal and run: xcode-select --install');await new Promise(r=>setTimeout(r,5000));}
  return {version:(await run('/usr/bin/git',['--version'])).trim()};
}
// Install one tool. progress({message,bytes,total,state}).
async function install(id,{progress=()=>{},platform=process.platform,arch=process.arch,fetchImpl=globalThis.fetch,root=opayaToolsRoot(platform),persist=true}={}){
  if(!supports(id,platform))throw new Error(`Opaya cannot install ${NAMES[id]||id} by itself on this system.`);
  if(id==='git'&&platform==='darwin')return macGit(progress);
  progress({message:`Finding the latest ${NAMES[id]}`});
  const p=await plan(id,{platform,arch,fetchImpl});
  if(!/^[0-9a-f]{64}$/.test(p.sha256||''))throw new Error(`Could not find the official checksum for ${p.file}, so it was not installed.`);
  await fsp.mkdir(root,{recursive:true});
  const tmp=await fsp.mkdtemp(path.join(os.tmpdir(),'opaya-tool-')),file=path.join(tmp,p.file);
  try{
    progress({message:`Downloading ${NAMES[id]} ${p.version}`});
    const sha=await download(p.url,file,{fetchImpl,onBytes:(bytes,total)=>progress({bytes,total})});
    if(sha!==p.sha256)throw new Error(`${p.file} did not match its official checksum, so it was not installed. Try again.`);
    progress({message:`Unpacking ${NAMES[id]}`});
    let where;
    if(p.layout.type==='sfx'){
      where=path.join(root,p.layout.to);await fsp.rm(where,{recursive:true,force:true});
      await run(file,[`-o${where}`,'-y'],{timeout:15*60*1000});
    }else{
      const staging=path.join(root,`.staging-${id}-${Date.now()}`);
      try{await unpack(file,staging,{platform});where=await place(staging,root,p.layout,{platform});}
      finally{await fsp.rm(staging,{recursive:true,force:true});}
    }
    const extra=id==='git'&&platform==='win32'?{CLAUDE_CODE_GIT_BASH_PATH:path.join(where,'bin','bash.exe')}:{};
    if(persist){progress({message:'Adding it to your PATH'});await persistPath({platform,root,extra});for(const [k,v] of Object.entries(extra))process.env[k]=v;}
    return {version:p.version,path:where};
  }finally{await fsp.rm(tmp,{recursive:true,force:true});}
}
module.exports={NAMES,supports,nodeAsset,githubAsset,sumsUrl,latestTag,checksumFrom,plan,install,persistPath,unpack,place,BEGIN,END,WINDOWS_PATH_SCRIPT};
