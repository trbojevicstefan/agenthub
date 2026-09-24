'use strict';
// In-app updates from this repository's GitHub releases. Opaya checks the public releases list, downloads the build for
// this platform, verifies it against the release's SHA256SUMS file and installs it in place:
// Windows runs the NSIS installer silently into the current folder and starts Opaya again;
// macOS swaps the .app bundle from the release ZIP and reopens it.
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const REPO='trbojevicstefan/agenthub';
const API=`https://api.github.com/repos/${REPO}/releases?per_page=30`;
const DOWNLOAD_PREFIX=`https://github.com/${REPO}/releases/download/`;
const parse=v=>String(v||'').replace(/^v/,'').split('-')[0].split('.').map(n=>Number(n)||0);
function compare(a,b){const x=parse(a),y=parse(b);for(let i=0;i<3;i++){if((x[i]||0)!==(y[i]||0))return (x[i]||0)>(y[i]||0)?1:-1;}return 0;}
// Windows releases are tagged v<version>-build.<run>, macOS ones v<version>-mac.<run>.
function pick(releases,{platform=process.platform,arch=process.arch}={}){
  const kind=platform==='win32'?'build':platform==='darwin'?'mac':'';if(!kind)return null;
  const pattern=new RegExp(`^v(\\d+\\.\\d+\\.\\d+)-${kind}\\.(\\d+)$`);
  const candidates=(Array.isArray(releases)?releases:[]).filter(r=>!r.draft&&pattern.test(r.tag_name||'')).map(r=>{const m=pattern.exec(r.tag_name);return {release:r,version:m[1],run:Number(m[2])};})
    .sort((a,b)=>compare(b.version,a.version)||b.run-a.run);
  for(const c of candidates){
    const assets=c.release.assets||[];
    const asset=platform==='win32'?assets.find(a=>/^Opaya-[\d.]+-Setup-x64\.exe$/.test(a.name)):assets.find(a=>new RegExp(`^Opaya-[\\d.]+-mac-${arch==='arm64'?'arm64':'x64'}\\.zip$`).test(a.name));
    const sums=assets.find(a=>/SHA256SUMS\.txt$/.test(a.name));
    if(asset&&sums&&safeUrl(asset.browser_download_url)&&safeUrl(sums.browser_download_url))return {version:c.version,tag:c.release.tag_name,url:c.release.html_url,notes:notes(c.release.body),published:c.release.published_at,asset:{name:asset.name,size:asset.size,url:asset.browser_download_url},sums:sums.browser_download_url};
  }
  return null;
}
const safeUrl=u=>typeof u==='string'&&u.startsWith(DOWNLOAD_PREFIX)&&!u.includes('..');
// The first section of the release notes: this version's headline and bullets.
function notes(body){const text=String(body||'');const end=text.search(/\n## /);return (end>0?text.slice(0,end):text).trim().slice(0,4000);}
function checksum(sumsText,name){for(const line of String(sumsText).split(/\r?\n/)){const m=/^([a-f0-9]{64})\s+\*?(.+)$/.exec(line.trim());if(m&&m[2]===name)return m[1];}return '';}
// Windows: wait until every Opaya process from the install folder has exited (window, session service, helpers), run
// the installer silently into the same folder, then start Opaya. If the silent install fails, open the normal installer
// so the user sees why. Everything is logged next to the download.
function windowsScript({pid,exe,installer,log}){
  const q=v=>`'${String(v).replace(/'/g,"''")}'`,dir=path.win32.dirname(exe);
  return [
    "$ErrorActionPreference = 'Continue'",
    `$log = ${q(log)}; $exe = ${q(exe)}; $dir = ${q(dir+'\\')}; $installer = ${q(installer)}`,
    "function Log($m) { Add-Content -LiteralPath $log -Value ((Get-Date -Format s) + ' ' + $m) }",
    "function Running { Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($dir, [System.StringComparison]::OrdinalIgnoreCase) } }",
    "Log 'Waiting for Opaya to close'",
    `Wait-Process -Id ${Number(pid)} -Timeout 60 -ErrorAction SilentlyContinue`,
    "$deadline = (Get-Date).AddSeconds(30)",
    "while ((Running) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }",
    "$left = Running; if ($left) { Log ('Stopping ' + (($left | ForEach-Object { $_.ProcessName + ':' + $_.Id }) -join ', ')); $left | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 2 }",
    "Log 'Installing'",
    // NSIS wants /D= last and unquoted, so the arguments go as one string.
    "$p = Start-Process -FilePath $installer -ArgumentList ('/S /D=' + $dir.TrimEnd('\\')) -Wait -PassThru",
    "Log ('Installer exit code ' + $p.ExitCode)",
    "if ($p.ExitCode -ne 0) { Log 'Silent install failed; opening the installer'; Start-Process -FilePath $installer; exit 1 }",
    "Start-Sleep -Seconds 2",
    "if (-not (Running)) { Log 'Starting Opaya'; Start-Process -FilePath $exe }",
    "Log 'Done'"
  ].join('\r\n')+'\r\n';
}
class Updater{
  constructor({app,fetchImpl=globalThis.fetch,emit=()=>{},platform=process.platform,arch=process.arch}){Object.assign(this,{app,fetch:fetchImpl,emit,platform,arch});this.state={status:'idle',current:app.getVersion()};}
  set(patch){this.state={...this.state,...patch};this.emit(this.state);return this.state;}
  async check(){
    if(!['win32','darwin'].includes(this.platform))return this.set({status:'unsupported',error:'Automatic updates are available on Windows and macOS.'});
    this.set({status:'checking',error:''});
    try{
      const res=await this.fetch(API,{headers:{Accept:'application/vnd.github+json','User-Agent':'Opaya-Updater'}});
      if(!res.ok)throw new Error(res.status===403?'GitHub rate limit reached. Try again in an hour.':`GitHub answered ${res.status}.`);
      const latest=pick(await res.json(),{platform:this.platform,arch:this.arch});
      if(!latest)return this.set({status:'current',checkedAt:Date.now(),latest:null});
      const newer=compare(latest.version,this.state.current)>0;
      return this.set({status:newer?'available':'current',checkedAt:Date.now(),latest});
    }catch(error){return this.set({status:'error',error:String(error.message||error).slice(0,300)});}
  }
  async download(){
    const latest=this.state.latest;if(!latest||this.state.status!=='available')throw new Error('Check for updates first.');
    this.set({status:'downloading',progress:0,error:''});
    try{
      const sums=await (await this.fetch(latest.sums,{headers:{'User-Agent':'Opaya-Updater'}})).text();
      const expected=checksum(sums,latest.asset.name);if(!expected)throw new Error('The release has no checksum for this build.');
      const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'opaya-update-'));const file=path.join(dir,latest.asset.name);
      const res=await this.fetch(latest.asset.url,{headers:{'User-Agent':'Opaya-Updater'}});if(!res.ok||!res.body)throw new Error(`Download failed (${res.status}).`);
      const total=Number(res.headers.get('content-length'))||latest.asset.size||0,hash=crypto.createHash('sha256'),out=fs.createWriteStream(file,{mode:0o600});
      let received=0,last=0;
      for await(const chunk of res.body){hash.update(chunk);received+=chunk.length;if(!out.write(chunk))await new Promise(r=>out.once('drain',r));if(total&&Date.now()-last>250){last=Date.now();this.set({progress:Math.min(99,Math.round(received/total*100))});}}
      await new Promise((resolve,reject)=>out.end(error=>error?reject(error):resolve()));
      if(hash.digest('hex')!==expected){await fsp.rm(dir,{recursive:true,force:true});throw new Error('The download does not match the release checksum. Nothing was installed.');}
      return this.set({status:'ready',progress:100,file});
    }catch(error){this.set({status:'error',error:String(error.message||error).slice(0,300)});throw error;}
  }
  // Starts the installer after this process exits. The caller stops the session service and quits.
  async install(){
    const file=this.state.file;if(this.state.status!=='ready'||!file)throw new Error('Download the update first.');
    if(this.platform==='win32'){
      const scriptFile=path.join(path.dirname(file),'install-update.ps1');
      await fsp.writeFile(scriptFile,'\ufeff'+windowsScript({pid:process.pid,exe:process.execPath,installer:file,log:path.join(path.dirname(file),'update.log')}),'utf8');
      spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',scriptFile],{detached:true,stdio:'ignore',windowsHide:true}).unref();
      return true;
    }
    const bundle=process.execPath.slice(0,process.execPath.indexOf('.app/')+4);
    if(!bundle.endsWith('.app'))throw new Error('Opaya is not running from an app bundle.');
    if(bundle.startsWith('/Volumes/'))throw new Error('Move Opaya to Applications first, then update.');
    try{await fsp.access(path.dirname(bundle),fs.constants.W_OK);}catch{throw new Error(`Opaya cannot write to ${path.dirname(bundle)}. Move it to Applications or update from the release page.`);}
    const staging=path.join(path.dirname(file),'unpacked');
    await new Promise((resolve,reject)=>{const p=spawn('/usr/bin/ditto',['-x','-k',file,staging]);p.on('error',reject);p.on('close',code=>code===0?resolve():reject(new Error('Could not unpack the update.')));});
    const next=(await fsp.readdir(staging)).find(n=>n.endsWith('.app'));if(!next)throw new Error('The update does not contain Opaya.app.');
    const sh=v=>`'${String(v).replace(/'/g,"'\\''")}'`,fresh=path.join(staging,next);
    // Keep the old app until the new one is in place; put it back if the copy fails.
    const old=sh(bundle+'.previous'),app=sh(bundle);
    const script=`while kill -0 ${process.pid} 2>/dev/null; do sleep 0.5; done; sleep 1; rm -rf ${old}; mv ${app} ${old} && if /usr/bin/ditto ${sh(fresh)} ${app}; then rm -rf ${old}; /usr/bin/xattr -dr com.apple.quarantine ${app} 2>/dev/null; else rm -rf ${app}; mv ${old} ${app}; fi; /usr/bin/open ${app}`;
    spawn('/bin/sh',['-c',script],{detached:true,stdio:'ignore'}).unref();
    return true;
  }
}
module.exports={Updater,pick,compare,checksum,notes,windowsScript};
