'use strict';
// New VPS setup: create a dedicated SSH key in ~/.ssh (reused if it exists), show its public half for the VPS provider,
// then test the connection. The first successful test records the server's host key (trust on first use).
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {spawn,execFile}=require('node:child_process');
const {findExecutable,environment,sshArgs,target,collect}=require('./process.cjs');
const keyPath=name=>path.join(os.homedir(),'.ssh',`opaya_${name}`);
function keyName(value){const v=String(value||'').trim().toLowerCase().replace(/[^a-z0-9_-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,40);if(!v)throw new Error('Name the VPS with letters or numbers.');return v;}
async function createKey(name){
  name=keyName(name);const file=keyPath(name);
  await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});
  let created=false;
  try{await fs.access(file);}catch{
    const keygen=findExecutable('ssh-keygen',environment());if(!keygen)throw new Error('ssh-keygen is missing. Install the OpenSSH client first.');
    await new Promise((resolve,reject)=>execFile(keygen,['-t','ed25519','-N','','-C',`opaya-${name}@${os.hostname()}`,'-f',file],{windowsHide:true,timeout:30000},(error,_o,stderr)=>error?reject(new Error(String(stderr||error.message).trim().slice(0,300))):resolve()));
    created=true;
  }
  const publicKey=(await fs.readFile(file+'.pub','utf8')).trim();
  if(!/^ssh-ed25519 [A-Za-z0-9+/=]+( .*)?$/.test(publicKey)&&!/^ssh-(rsa|ecdsa)[\w-]* /.test(publicKey))throw new Error('The public key file is not a valid SSH key.');
  return {name,identityFile:file,publicKey,created};
}
// accept-new: trust the server key the first time only; a changed key later is still refused.
async function test(host){
  const ssh=findExecutable('ssh',environment());if(!ssh)throw new Error('OpenSSH client is not installed.');
  const args=sshArgs(host).map(a=>a==='StrictHostKeyChecking=yes'?'StrictHostKeyChecking=accept-new':a);
  try{
    // The probe always exits 0: a server without Docker or Hermes is still a good connection.
    const out=await collect(spawn(ssh,[...args,'-T',target(host),'echo OPAYA_OK; uname -sm 2>/dev/null; command -v docker >/dev/null && echo docker; if command -v hermes >/dev/null 2>&1 || [ -x "$HOME/.local/bin/hermes" ]; then echo hermes; fi; exit 0'],{env:environment(),windowsHide:true,stdio:['pipe','pipe','pipe']}),{timeout:25000});
    const lines=out.split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
    if(!lines.includes('OPAYA_OK'))throw new Error('Unexpected answer from the server.');
    return {ok:true,system:lines.find(l=>l!=='OPAYA_OK'&&l!=='docker'&&l!=='hermes')||'',docker:lines.includes('docker'),hermes:lines.includes('hermes')};
  }catch(error){
    const m=String(error.message||error);
    if(/Permission denied|publickey/i.test(m))throw new Error('The server refused the key. Add the public key to the VPS (provider panel or ~/.ssh/authorized_keys), then test again.');
    if(/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(m))throw new Error('The server\'s host key changed since it was trusted. If you rebuilt the VPS, remove its old entry from ~/.ssh/known_hosts first.');
    if(/timed out|Connection refused|No route|Could not resolve/i.test(m))throw new Error('Cannot reach the server. Check the address, the port and that the VPS is running.');
    throw new Error(m.slice(0,400));
  }
}
module.exports={createKey,test,keyName,keyPath};
