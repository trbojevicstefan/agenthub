'use strict';
// The session service of the web app: one runtime container per active user (web/src/launcher.ts starts it from
// deploy/runtime.Dockerfile). Plain Node, no Electron. The user's data is in OPAYA_DATA (/data, the user's own
// volume); the web server connects to its session socket there (wire.cjs) and relays the browser's calls. The Vault is
// the user's server-side store (remote-vault.cjs), and nothing runs on "this computer" (runtime-guard.cjs).
process.env.OPAYA_RUNTIME='web';
require('./runtime-guard.cjs').install();
const os=require('node:os'),path=require('node:path');
const root=path.resolve(process.env.OPAYA_DATA||'/data');
const token=String(process.env.OPAYA_VAULT_TOKEN||'');
// The plan's machine limit when the container started (the web server's entitlements).
const hostLimit=Number.parseInt(process.env.OPAYA_HOST_LIMIT||'',10);
delete process.env.OPAYA_VAULT_TOKEN; // not passed on to ssh
// The parts of Electron's app object the service uses.
const app={getVersion:()=>require('../package.json').version,getPath:name=>name==='home'?os.homedir():root,exit:code=>process.exit(code),on:()=>{}};
async function main(){
  if(!/^[a-f0-9]{64}$/.test(token))throw new Error('OPAYA_VAULT_TOKEN is missing.');
  // HOME (ssh keys, known_hosts) is on the user's volume; the root file system is read-only.
  require('node:fs').mkdirSync(os.homedir(),{recursive:true,mode:0o700});
  const vault=new (require('./remote-vault.cjs').RemoteVault)({address:path.join(root,'vault.sock'),token});
  await require('./service.cjs').start({app,safeStorage:null,shell:null},root,{vault,...(Number.isInteger(hostLimit)&&hostLimit>=0?{hostLimit}:{})});
  // The web SSH key (web/src/ssh-key.ts) from the Vault, in /tmp (memory in the container), for ssh (process.cjs).
  const key=vault.get('opaya_web_ssh_key');
  if(key){
    const fs=require('node:fs'),file=path.join(os.tmpdir(),`opaya-web-ssh-${process.pid}`);fs.writeFileSync(file,Buffer.from(key,'base64'),{mode:0o600});process.env.OPAYA_WEB_SSH_KEY=file;
    process.on('exit',()=>{try{fs.rmSync(file,{force:true});}catch{}});
  }
}
main().catch(error=>{console.error(`Opaya runtime did not start: ${String(error?.message||error)}`);process.exit(1);});
