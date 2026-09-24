'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const crypto=require('node:crypto');
const {Updater,pick,compare,checksum}=require('../desktop/updater.cjs');
const D='https://github.com/trbojevicstefan/agenthub/releases/download/';
const release=(tag,assets,extra={})=>({tag_name:tag,html_url:`https://github.com/trbojevicstefan/agenthub/releases/tag/${tag}`,body:`# Opaya notes\n\n- one\n\n## Earlier: old\n- old`,assets:assets.map(name=>({name,size:10,browser_download_url:D+tag+'/'+name})),...extra});
const RELEASES=[release('v0.7.0-mac.14',['Opaya-0.7.0-mac-arm64.zip','Opaya-0.7.0-mac-arm64.dmg','darwin-arm64-SHA256SUMS.txt']),release('v0.7.0-build.19',['Opaya-0.7.0-Setup-x64.exe','win32-x64-SHA256SUMS.txt']),release('v0.6.0-build.18',['Opaya-0.6.0-Setup-x64.exe','win32-x64-SHA256SUMS.txt']),release('v0.8.0-build.20',['Opaya-0.8.0-Setup-x64.exe','win32-x64-SHA256SUMS.txt'],{draft:true})];
test('picks the newest non-draft release for this platform and compares versions',()=>{
  const win=pick(RELEASES,{platform:'win32',arch:'x64'});assert.equal(win.version,'0.7.0');assert.equal(win.asset.name,'Opaya-0.7.0-Setup-x64.exe');assert.equal(win.notes,'# Opaya notes\n\n- one');
  const mac=pick(RELEASES,{platform:'darwin',arch:'arm64'});assert.equal(mac.asset.name,'Opaya-0.7.0-mac-arm64.zip');
  assert.equal(pick(RELEASES,{platform:'linux'}),null);
  assert.equal(pick([release('v0.9.0-build.30',['Opaya-0.9.0-Setup-x64.exe'])],{platform:'win32'}),null,'no checksum file, no update');
  const foreign=release('v0.9.0-build.31',['Opaya-0.9.0-Setup-x64.exe','win32-x64-SHA256SUMS.txt']);foreign.assets[0].browser_download_url='https://evil.example/Opaya.exe';
  assert.equal(pick([foreign],{platform:'win32'}),null,'assets must come from this repository');
  assert.equal(compare('0.10.0','0.9.9'),1);assert.equal(compare('v0.7.0','0.7.0'),0);assert.equal(compare('0.6.3','0.7.0'),-1);
  assert.equal(checksum('abc\n'+'a'.repeat(64)+'  Opaya-0.7.0-Setup-x64.exe\n','Opaya-0.7.0-Setup-x64.exe'),'a'.repeat(64));
});
function fakeFetch(payload,{tamper=false}={}){
  const sha=crypto.createHash('sha256').update(payload).digest('hex');
  return async url=>{
    if(url.includes('api.github.com'))return {ok:true,json:async()=>RELEASES};
    if(url.endsWith('SHA256SUMS.txt'))return {ok:true,text:async()=>`${sha}  Opaya-0.7.0-Setup-x64.exe\n`};
    const body=tamper?Buffer.concat([payload,Buffer.from('x')]):payload;
    return {ok:true,headers:{get:()=>String(body.length)},body:(async function*(){yield body.subarray(0,5);yield body.subarray(5);})()};
  };
}
test('downloads only verified builds and reports progress states',async()=>{
  const payload=Buffer.from('installer-bytes-0123456789'),states=[];
  const u=new Updater({app:{getVersion:()=>'0.6.0'},fetchImpl:fakeFetch(payload),emit:s=>states.push(s.status),platform:'win32',arch:'x64'});
  assert.equal((await u.check()).status,'available');
  const ready=await u.download();assert.equal(ready.status,'ready');assert.deepEqual(await fs.readFile(ready.file),payload);
  assert.deepEqual([...new Set(states)],['checking','available','downloading','ready']);
  await fs.rm(require('node:path').dirname(ready.file),{recursive:true,force:true});
  const bad=new Updater({app:{getVersion:()=>'0.6.0'},fetchImpl:fakeFetch(payload,{tamper:true}),platform:'win32',arch:'x64'});
  await bad.check();await assert.rejects(()=>bad.download(),/does not match/);assert.equal(bad.state.status,'error');
  const current=new Updater({app:{getVersion:()=>'0.7.0'},fetchImpl:fakeFetch(payload),platform:'win32',arch:'x64'});
  assert.equal((await current.check()).status,'current');
  assert.equal((await new Updater({app:{getVersion:()=>'0.7.0'},platform:'linux'}).check()).status,'unsupported');
});
test('the Windows update script waits for every Opaya process, installs into the same folder and restarts Opaya',()=>{
  const {windowsScript}=require('../desktop/updater.cjs');
  const s=windowsScript({pid:4242,exe:"C:\\Users\\O'Brien\\AppData\\Local\\Programs\\Opaya\\Opaya.exe",installer:'C:\\Temp\\u\\Opaya-0.10.1-Setup-x64.exe',log:'C:\\Temp\\u\\update.log'});
  assert.match(s,/Wait-Process -Id 4242/);
  assert.match(s,/\$exe = 'C:\\Users\\O''Brien\\AppData\\Local\\Programs\\Opaya\\Opaya\.exe'/,'single quotes are doubled for PowerShell');
  assert.match(s,/Stop-Process -Force/);
  assert.match(s,/-ArgumentList \('\/S \/D=' \+ \$dir\.TrimEnd/,'NSIS /D stays last and unquoted');
  assert.match(s,/if \(\$p\.ExitCode -ne 0\) \{[^}]*Start-Process -FilePath \$installer/,'a failed silent install opens the normal installer');
  assert.match(s,/Start-Process -FilePath \$exe/,'Opaya starts again after the install');
});
