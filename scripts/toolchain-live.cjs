'use strict';
// Live check of Opaya's built-in installer on a real machine: downloads the latest official builds, verifies their
// checksums, unpacks them into a temporary tools folder (the user's PATH is not touched) and runs each one.
const os=require('node:os');const path=require('node:path');const fs=require('node:fs');const {execFileSync}=require('node:child_process');
const toolchain=require('../desktop/toolchain.cjs');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'opaya-tools-live-')),win=process.platform==='win32';
const run=(file,args)=>execFileSync(file,args,{encoding:'utf8',shell:win&&/\.cmd$/i.test(file)}).trim().split('\n')[0];
const checks={
  node:()=>[run(path.join(root,'node',win?'node.exe':'bin/node'),['--version']),run(path.join(root,'node',win?'npm.cmd':'bin/npm'),['--version'])].join(' / npm '),
  python:()=>run(path.join(root,'python',win?'python.exe':'bin/python3'),['-c','import sys, pip; print(sys.version.split()[0], "pip", pip.__version__)']),
  uv:()=>run(path.join(root,'bin',win?'uv.exe':'uv'),['--version']),
  gh:()=>run(path.join(root,'bin',win?'gh.exe':'gh'),['--version']),
  git:()=>win?run(path.join(root,'git','cmd','git.exe'),['--version'])+' / bash '+(fs.existsSync(path.join(root,'git','bin','bash.exe'))?'present':'MISSING'):run('/usr/bin/git',['--version'])
};
(async()=>{
  let failed=0;
  for(const id of Object.keys(checks).filter(id=>toolchain.supports(id))){
    const start=Date.now();
    for(let attempt=1;attempt<=2;attempt++){
      try{const r=await toolchain.install(id,{root,persist:false});console.log(`ok   ${id} ${r.version} -> ${checks[id]()} (${Math.round((Date.now()-start)/1000)}s)`);break;}
      catch(e){if(attempt===2){failed++;console.log(`FAIL ${id}: ${e.message}`);}else console.log(`retry ${id}: ${e.message}`);}
    }
  }
  // npm from the downloaded Node.js can install packages.
  try{const dir=path.join(root,'npm-check');fs.mkdirSync(dir);execFileSync(path.join(root,'node',win?'npm.cmd':'bin/npm'),['install','--prefix',dir,'--no-audit','--no-fund','is-number'],{stdio:'pipe',shell:win,env:{...process.env,PATH:[path.join(root,'node',win?'':'bin'),process.env.PATH].join(path.delimiter)}});
    console.log(`ok   npm install works (${fs.existsSync(path.join(dir,'node_modules','is-number'))?'package present':'package MISSING'})`);}
  catch(e){failed++;console.log(`FAIL npm install: ${String(e.stderr||e.message).slice(0,300)}`);}
  // Windows: the user PATH and PowerShell policy are really written (this runner is thrown away afterwards).
  if(win){
    try{await toolchain.persistPath({root,extra:{OPAYA_LIVE_CHECK:'1'}});
      const read=c=>execFileSync('powershell.exe',['-NoProfile','-Command',c],{encoding:'utf8'}).trim();
      const userPath=read("[Environment]::GetEnvironmentVariable('Path','User')"),policy=read('Get-ExecutionPolicy -Scope CurrentUser');
      const ok=userPath.split(';')[0]===path.join(root,'node')&&read("[Environment]::GetEnvironmentVariable('OPAYA_LIVE_CHECK','User')")==='1';
      console.log(`${ok?'ok  ':'FAIL'} user PATH starts with Opaya's tools; execution policy for this user: ${policy}`);if(!ok)failed++;
    }catch(e){failed++;console.log(`FAIL PATH: ${e.message}`);}
  }
  fs.rmSync(root,{recursive:true,force:true});
  if(failed)process.exit(1);
})();
