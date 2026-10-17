'use strict';
// Web runtime containers (OPAYA_RUNTIME=web) run nothing on "this computer": agents, terminals and installs run on the
// user's own machines over SSH. install() wraps child_process and node-pty before any other module loads them, so every
// local process start in the session service passes this check: only ssh (and the guard's own allowlist) may start.
// The container is also isolated (deploy/runtime.Dockerfile, web/src/launcher.ts); this guard is the second wall and
// gives a clear error instead of a broken feature.
const path=require('node:path');
const ALLOWED=new Set(['ssh']);
const web=()=>process.env.OPAYA_RUNTIME==='web';
const MESSAGE='This runs on your own computer in the Opaya desktop app. In the web app, agents and terminals run on your machines over SSH.';
function allowed(command){
  const file=String(command||'');if(!file)return false;
  const base=path.basename(file).replace(/\.exe$/i,'');
  // A bare name or an absolute path; never a shell.
  return ALLOWED.has(base)&&(file===base||path.isAbsolute(file));
}
function refused(command){const e=new Error(MESSAGE);e.code='OPAYA_LOCAL_OFF';e.command=path.basename(String(command||''));return e;}
let installed=false;
function install(){
  if(installed||!web())return;installed=true;
  const cp=require('node:child_process');
  for(const name of ['spawn','spawnSync','execFile','execFileSync']){const original=cp[name];cp[name]=function(command,...rest){if(!allowed(command))throw refused(command);return original.call(this,command,...rest);};}
  // exec and execSync always go through a shell.
  for(const name of ['exec','execSync','fork'])cp[name]=command=>{throw refused(command);};
  try{const pty=require('node-pty'),original=pty.spawn;pty.spawn=function(command,...rest){if(!allowed(command))throw refused(command);return original.call(this,command,...rest);};}catch{}
}
module.exports={install,allowed,web,MESSAGE};
