'use strict';
// In-app updates from this repository's GitHub releases. Opaya checks the public releases list, downloads the build for
// this platform, verifies it against the release's SHA256SUMS file and installs it in place:
// Windows starts the NSIS installer the way electron-updater does (--updated /S --force-run): the installer closes
// every running Opaya, installs over the existing installation and starts Opaya again;
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
class Updater{
  constructor({app,fetchImpl=globalThis.fetch,emit=()=>{},platform=process.platform,arch=process.arch,markerFile='',spawnImpl=spawn}){Object.assign(this,{app,fetch:fetchImpl,emit,platform,arch,markerFile,spawn:spawnImpl});this.state={status:'idle',current:app.getVersion()};}
  // After a restart: did the last update install? If Opaya is still on the old version, say so and keep the installer
  // at hand, instead of failing silently.
  async checkPending(){
    if(!this.markerFile)return null;
    const marker=await fsp.readFile(this.markerFile,'utf8').then(JSON.parse).catch(()=>null);if(!marker)return null;
    await fsp.rm(this.markerFile,{force:true}).catch(()=>{});
    const current=this.state.current;
    if(compare(current,marker.to)>=0||Date.now()-Number(marker.at||0)>3*24*3600*1000)return null;
    const installer=marker.installer&&fs.existsSync(marker.installer)?marker.installer:'';
    return this.set({status:'failed',latest:{version:marker.to,url:marker.url||''},file:installer,error:`Opaya ${marker.to} did not install; you still have ${current}. ${installer?'Run the installer to finish the update.':'Download it again, or install it from the release page.'}`});
  }
  async writeMarker(){if(this.markerFile)await fsp.writeFile(this.markerFile,JSON.stringify({from:this.state.current,to:this.state.latest?.version||'',url:this.state.latest?.url||'',installer:this.state.file,at:Date.now()}),{mode:0o600}).catch(()=>{});}
  // The visible installer, for when the automatic update did not finish. Opaya quits afterwards so it can replace files.
  async runInstaller(){
    const file=this.state.file;if(!file||!fs.existsSync(file))throw new Error('The downloaded installer is gone. Check for updates again.');
    if(this.platform!=='win32')throw new Error('Open the release page to install this version.');
    this.spawn(file,[],{detached:true,stdio:'ignore'}).unref();return true;
  }
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
    await this.writeMarker();
    if(this.platform==='win32'){
      this.spawn(file,['--updated','/S','--force-run'],{detached:true,stdio:'ignore'}).unref();
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
module.exports={Updater,pick,compare,checksum,notes};
