'use strict';
// Cookies from Chrome and Edge into the Opaya browser, so an agent's tab (or yours) is signed in where the user is.
// The cookie database is read with sqlite-read.cjs and decrypted the way each browser encrypts it:
//   Windows  v10: AES-256-GCM with the key in "Local State", itself protected by DPAPI (unlocked with PowerShell).
//            v20: "app-bound" encryption (Chrome and Edge 127+): only the browser itself can read these; counted and
//            reported, and the user imports a cookies.txt or JSON export of them instead.
//   macOS    v10: AES-128-CBC, key from the Keychain item "Chrome Safe Storage" / "Microsoft Edge Safe Storage".
//   Linux    v10: AES-128-CBC with the default password; v11: the password in the keyring (secret-tool).
// Values never leave the session; Opaya only reports counts and domains.
const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const crypto=require('node:crypto');const {execFileSync}=require('node:child_process');
const {Db}=require('./sqlite-read.cjs');
const BROWSERS={chrome:{label:'Google Chrome',keychain:'Chrome Safe Storage',secret:'chrome'},edge:{label:'Microsoft Edge',keychain:'Microsoft Edge Safe Storage',secret:'chromium'}};
function userData(id,{platform=process.platform,home=os.homedir(),env=process.env}={}){
  if(platform==='win32'){const local=env.LOCALAPPDATA||path.join(home,'AppData','Local');return id==='chrome'?path.join(local,'Google','Chrome','User Data'):path.join(local,'Microsoft','Edge','User Data');}
  if(platform==='darwin')return path.join(home,'Library','Application Support',id==='chrome'?'Google/Chrome':'Microsoft Edge');
  return path.join(env.XDG_CONFIG_HOME||path.join(home,'.config'),id==='chrome'?'google-chrome':'microsoft-edge');
}
const cookieFile=dir=>[path.join(dir,'Network','Cookies'),path.join(dir,'Cookies')].find(f=>fs.existsSync(f));
// Browsers on this computer with their profiles (the names the user gave them).
function profiles(opts={}){
  const out=[];
  for(const [id,b] of Object.entries(BROWSERS)){
    const root=userData(id,opts);if(!fs.existsSync(root))continue;
    let names={};try{names=JSON.parse(fs.readFileSync(path.join(root,'Local State'),'utf8')).profile?.info_cache||{};}catch{}
    for(const dir of fs.readdirSync(root)){if(!/^(Default|Profile \d+)$/.test(dir))continue;const file=cookieFile(path.join(root,dir));if(file)out.push({browser:id,label:b.label,profile:dir,name:names[dir]?.name||dir,file});}
  }
  return out;
}
// The key that unlocks v10 values on this computer.
function keyFor(browser,{platform=process.platform,root}={}){
  const b=BROWSERS[browser];
  if(platform==='win32'){
    const enc=Buffer.from(JSON.parse(fs.readFileSync(path.join(root,'Local State'),'utf8')).os_crypt.encrypted_key,'base64');
    if(enc.subarray(0,5).toString()!=='DPAPI')throw new Error('The browser key is not DPAPI-protected.');
    const ps=`Add-Type -AssemblyName System.Security;[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String('${enc.subarray(5).toString('base64')}'),$null,'CurrentUser'))`;
    return {gcm:Buffer.from(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',ps],{encoding:'utf8',windowsHide:true,timeout:20000}).trim(),'base64')};
  }
  if(platform==='darwin'){
    let pw;try{pw=execFileSync('security',['find-generic-password','-w','-s',b.keychain],{encoding:'utf8',timeout:60000}).trim();}catch{throw new Error(`macOS did not give Opaya the "${b.keychain}" key. Allow it in the Keychain prompt and try again.`);}
    return {cbc:crypto.pbkdf2Sync(pw,'saltysalt',1003,16,'sha1')};
  }
  let v11='';try{v11=execFileSync('secret-tool',['lookup','application',b.secret],{encoding:'utf8',timeout:15000}).trim();}catch{}
  return {cbc:crypto.pbkdf2Sync('peanuts','saltysalt',1,16,'sha1'),cbc11:v11?crypto.pbkdf2Sync(v11,'saltysalt',1,16,'sha1'):null};
}
function decrypt(blob,key,hashPrefix){
  if(!blob?.length)return '';
  const tag=blob.subarray(0,3).toString('latin1');let plain;
  if(tag==='v20')return null; // app-bound: only the browser can read it
  if(tag==='v10'&&key.gcm){const iv=blob.subarray(3,15),data=blob.subarray(15,blob.length-16),t=blob.subarray(blob.length-16);const d=crypto.createDecipheriv('aes-256-gcm',key.gcm,iv);d.setAuthTag(t);plain=Buffer.concat([d.update(data),d.final()]);}
  else if((tag==='v10'||tag==='v11')&&(key.cbc||key.cbc11)){const k=tag==='v11'?key.cbc11:key.cbc;if(!k)return null;const d=crypto.createDecipheriv('aes-128-cbc',k,Buffer.alloc(16,0x20));plain=Buffer.concat([d.update(blob.subarray(3)),d.final()]);}
  else return null;
  // Version 24 and later put a SHA-256 of the domain before the value.
  return (hashPrefix&&plain.length>=32?plain.subarray(32):plain).toString('utf8');
}
const SAME={'-1':'unspecified',0:'no_restriction',1:'lax',2:'strict'};
const chromeTime=us=>us?Math.floor(Number(us)/1e6-11644473600):0;
// An Electron cookie (session.cookies.set) from a host, name, value and flags.
function electronCookie({host,name,value,path:p='/',secure=false,httpOnly=false,expires=0,sameSite='unspecified'}){
  const domain=String(host||'').trim(),bare=domain.replace(/^\./,'');if(!bare||!name)return null;
  const c={url:`${secure?'https':'http'}://${bare}${p||'/'}`,name:String(name),value:String(value??''),path:p||'/',secure:!!secure,httpOnly:!!httpOnly,sameSite};
  if(domain.startsWith('.'))c.domain=domain;
  if(expires>0)c.expirationDate=expires;
  if(sameSite==='no_restriction')c.secure=true,c.url=`https://${bare}${p||'/'}`;
  return c;
}
const matches=(host,domains)=>!domains?.length||domains.some(d=>{d=d.replace(/^\./,'').toLowerCase();const h=String(host).replace(/^\./,'').toLowerCase();return h===d||h.endsWith('.'+d);});
// Cookies of one Chrome or Edge profile: the cookies, how many could not be read (app-bound) and the domains seen.
function readBrowser({browser,profile,domains=[]},opts={}){
  const p=profiles(opts).find(x=>x.browser===browser&&x.profile===profile);if(!p)throw new Error('That browser profile was not found.');
  // The database is locked while the browser runs on Windows: read a copy, or ask to close the browser.
  const tmp=path.join(os.tmpdir(),`opaya-cookies-${crypto.randomUUID()}`);
  try{fs.copyFileSync(p.file,tmp);}catch{throw new Error(`${p.label} is using its cookie file. Close ${p.label}, then import again.`);}
  try{
    const db=new Db(tmp);let version=0;try{version=Number([...db.select('meta')].find(r=>r.key==='version')?.value)||0;}catch{}
    const rows=[...db.select('cookies')].filter(r=>matches(r.host_key,domains));
    let key=null;const needKey=rows.some(r=>r.encrypted_value?.length&&r.encrypted_value.subarray(0,3).toString('latin1')!=='v20');
    if(needKey)key=keyFor(browser,{...opts,root:userData(browser,opts)});
    const cookies=[],locked=new Set();let unreadable=0;
    for(const r of rows){
      let value=r.value||'';
      if(!value&&r.encrypted_value?.length){let v=null;try{v=decrypt(r.encrypted_value,key||{},version>=24);}catch{v=null;}if(v==null){unreadable++;locked.add(String(r.host_key).replace(/^\./,''));continue;}value=v;}
      const c=electronCookie({host:r.host_key,name:r.name,value,path:r.path,secure:!!r.is_secure,httpOnly:!!r.is_httponly,expires:r.has_expires||r.is_persistent?chromeTime(r.expires_utc):0,sameSite:SAME[String(r.samesite)]||'unspecified'});
      if(c)cookies.push(c);
    }
    return {cookies,unreadable,locked:[...locked].slice(0,20),label:`${p.label} / ${p.name}`};
  }finally{fs.rmSync(tmp,{force:true});}
}
// A file exported from a browser: Netscape cookies.txt, or the JSON of Cookie-Editor, EditThisCookie and similar.
function parseFile(text,{domains=[]}={}){
  text=String(text||'').replace(/^﻿/,'');const out=[];
  const t=text.trim();
  if(t.startsWith('[')||t.startsWith('{')){
    let list;try{list=JSON.parse(t);}catch{throw new Error('This JSON file could not be read.');}
    if(!Array.isArray(list))list=list.cookies||[];
    for(const c of list){if(!c||!c.name||!matches(c.domain||c.host,domains))continue;
      const ss=String(c.sameSite||'').toLowerCase();
      const e=electronCookie({host:c.domain||c.host,name:c.name,value:c.value,path:c.path,secure:!!c.secure,httpOnly:!!c.httpOnly,expires:Math.floor(Number(c.expirationDate||c.expires||0))||0,sameSite:ss==='strict'?'strict':ss==='lax'?'lax':ss==='none'||ss==='no_restriction'?'no_restriction':'unspecified'});
      if(e)out.push(e);}
    return out;
  }
  for(const raw of text.split(/\r?\n/)){
    let line=raw;let httpOnly=false;if(line.startsWith('#HttpOnly_')){httpOnly=true;line=line.slice(10);}else if(!line.trim()||line.startsWith('#'))continue;
    const f=line.split('\t');if(f.length<7)continue;const [host,,p,secure,expires,name,...v]=f;
    if(!matches(host,domains))continue;
    const e=electronCookie({host,name,value:v.join('\t'),path:p,secure:/^true$/i.test(secure),httpOnly,expires:Number(expires)||0});if(e)out.push(e);
  }
  if(!out.length&&!/\t/.test(text))throw new Error('This is not a cookies.txt or JSON cookie file.');
  return out;
}
module.exports={profiles,readBrowser,parseFile,decrypt,electronCookie,userData,BROWSERS};
