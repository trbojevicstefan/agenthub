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
// What the Machines screen shows about a server. The probe always exits 0: a server without Docker or Hermes is
// still a good connection, and a missing tool (free, uptime -p on macOS) only leaves its line out.
const TOOLS=['docker','tmux','git','node','python3','hermes','openclaw','claude','codex'];
const PROBE=['echo OPAYA_OK','uname -sm 2>/dev/null','echo "host=$(hostname 2>/dev/null)"','if [ -r /etc/os-release ]; then . /etc/os-release; echo "os=$PRETTY_NAME"; fi',
  'echo "uptime=$(uptime -p 2>/dev/null | sed \'s/^up //\')"',`echo "disk=$(df -Ph "$HOME" 2>/dev/null | awk 'NR==2{print $4" free of "$2}')"`,`echo "memory=$(free -h 2>/dev/null | awk '/^Mem:/{print $7" free of "$2}')"`,
  `for t in ${TOOLS.join(' ')}; do if command -v $t >/dev/null 2>&1; then echo "tool=$t"; fi; done`,'if [ -x "$HOME/.local/bin/hermes" ]; then echo "tool=hermes"; fi','exit 0'].join('; ');
function parseProbe(out){
  const lines=String(out||'').split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
  if(!lines.includes('OPAYA_OK'))throw new Error('Unexpected answer from the server.');
  const field=name=>(lines.find(l=>l.startsWith(name+'='))||'').slice(name.length+1).slice(0,120);
  const tools=[...new Set(lines.filter(l=>l.startsWith('tool=')).map(l=>l.slice(5)).filter(t=>TOOLS.includes(t)))];
  return {ok:true,system:lines.find(l=>l!=='OPAYA_OK'&&!l.includes('='))||'',host:field('host'),os:field('os'),uptime:field('uptime'),disk:field('disk'),memory:field('memory'),tools,docker:tools.includes('docker'),hermes:tools.includes('hermes')};
}
// accept-new: trust the server key the first time only; a changed key later is still refused.
async function test(host){
  const ssh=findExecutable('ssh',environment());if(!ssh)throw new Error('OpenSSH client is not installed.');
  const args=sshArgs(host).map(a=>a==='StrictHostKeyChecking=yes'?'StrictHostKeyChecking=accept-new':a);
  try{
    const started=Date.now();
    const out=await collect(spawn(ssh,[...args,'-T',target(host),PROBE],{env:environment(),windowsHide:true,stdio:['pipe','pipe','pipe']}),{timeout:25000});
    return {...parseProbe(out),ms:Date.now()-started,checkedAt:new Date().toISOString()};
  }catch(error){
    const m=String(error.message||error);
    if(/Permission denied|publickey/i.test(m))throw new Error('The server refused the key. Add the public key to the VPS (provider panel or ~/.ssh/authorized_keys), then test again.');
    if(/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(m))throw new Error('The server\'s host key changed since it was trusted. If you rebuilt the VPS, remove its old entry from ~/.ssh/known_hosts first.');
    if(/timed out|Connection refused|No route|Could not resolve/i.test(m))throw new Error('Cannot reach the server. Check the address, the port and that the VPS is running.');
    throw new Error(m.slice(0,400));
  }
}
module.exports={createKey,test,keyName,keyPath,parseProbe,PROBE};
