'use strict';
// Install matrix: installs every agent with Opaya's own commands on a fresh machine, the way Opaya runs them, then checks
// that Opaya finds and runs each one. Run in CI (.github/workflows/install-matrix.yml) on throwaway machines.
//   --where local   this computer: the built-in installer for Node.js, Python, Git and uv, then each agent's install
//                   command in a shell with Opaya's environment; found with Opaya's own PATH lookup.
//   --where ssh     a VPS: ssh -tt user@host '<command>' like Opaya's install terminal; found with Opaya's remote PATH.
//                   --ssh user@host:port --key <private key>
//   --where docker  each agent installed as a Docker container (containers.cjs), checked with docker exec.
//   --only a,b      just these agents.
// Writes artifacts/install-matrix-<where>.json and a table to $GITHUB_STEP_SUMMARY; exits 1 when anything failed.
const fs=require('node:fs');const path=require('node:path');const {spawn,execFileSync}=require('node:child_process');
const catalog=require('../desktop/catalog.cjs');const containers=require('../desktop/containers.cjs');
const proc=require('../desktop/process.cjs');const toolchain=require('../desktop/toolchain.cjs');
const arg=name=>{const i=process.argv.indexOf(`--${name}`);return i>0?process.argv[i+1]:'';};
const where=arg('where')||'local',only=arg('only')?arg('only').split(','):null,win=process.platform==='win32';
// The agents and the program each one puts on PATH.
const BIN={hermes:'hermes',claude:'claude',codex:'codex',openclaw:'openclaw',opencode:'opencode',dsh:'dsh',goose:'goose',aider:'aider'};
const pick=ids=>ids.filter(id=>!only||only.includes(id));

function run(file,args,{timeout=25*60*1000,env=process.env,input=null,shell=false}={}){
  return new Promise(resolve=>{
    const started=Date.now();let out='';
    const child=spawn(file,args,{env,shell,windowsHide:true,stdio:[input===null?'ignore':'pipe','pipe','pipe']});
    const keep=d=>{out=(out+d).slice(-60000);};child.stdout.on('data',keep);child.stderr.on('data',keep);
    if(input!==null){child.stdin.on('error',()=>{});child.stdin.end(input);}
    const timer=setTimeout(()=>{out+=`\n[install-matrix] timed out after ${Math.round(timeout/60000)} minutes`;try{child.kill('SIGKILL');}catch{}},timeout);
    child.on('error',e=>{out+=`\n${e.message}`;});
    child.on('close',code=>{clearTimeout(timer);resolve({code:code??1,out,seconds:Math.round((Date.now()-started)/1000)});});
  });
}
const tail=(text,n=40)=>String(text||'').replace(/\x1b\[[0-9;?]*[A-Za-z]/g,'').replace(/\r/g,'').split('\n').filter(l=>l.trim()).slice(-n).join('\n');
const results=[];
function report(r){results.push(r);console.log(`${r.ok?'ok  ':'FAIL'} ${r.id.padEnd(10)} ${String(r.seconds??'').padStart(4)}s  ${r.version||r.error||''}`);if(!r.ok&&r.log)console.log(r.log.split('\n').map(l=>'     | '+l).join('\n'));}

// ---- this computer ---------------------------------------------------------------------------------------------------
async function local(){
  for(const id of ['node','python','git','uv'].filter(id=>toolchain.supports(id)&&(id!=='git'||process.platform!=='linux'))){
    const started=Date.now();
    try{const r=await toolchain.install(id,{});report({id,ok:true,seconds:Math.round((Date.now()-started)/1000),version:`built-in ${r.version}`});}
    catch(e){report({id,ok:false,seconds:Math.round((Date.now()-started)/1000),error:e.message});}
  }
  const ids=pick(Object.keys(BIN).filter(id=>{try{catalog.command(id,{remote:false});return true;}catch{return false;}}));
  for(const id of ids){
    const {command}=catalog.command(id,{remote:false});await proc.primeShellPath();const env=proc.environment();
    const r=win?await run('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-Command',command],{env}):await run(process.env.SHELL&&!/fish/.test(process.env.SHELL)?process.env.SHELL:'/bin/bash',['-lc',command],{env});
    report({id,...await verifyLocal(id),seconds:r.seconds,log:tail(r.out),installExit:r.code});
  }
}
async function verifyLocal(id){
  await proc.primeShellPath();const env=proc.environment(),file=proc.findExecutable(BIN[id],env);
  if(!file)return {ok:false,error:`${BIN[id]} is not on Opaya's PATH after the install`};
  const v=await run(file,['--version'],{env,timeout:120000,shell:win&&/\.(cmd|bat)$/i.test(file)});
  return v.code===0?{ok:true,version:`${tail(v.out,1).slice(0,80)} (${file})`}:{ok:false,error:`${file} --version exited ${v.code}: ${tail(v.out,3)}`};
}

// ---- a VPS over SSH ---------------------------------------------------------------------------------------------------
async function ssh(){
  const m=/^([^@]+)@([^:]+):(\d+)$/.exec(arg('ssh')||'');if(!m)throw new Error('--ssh user@host:port');
  const base=['-p',m[3],'-i',arg('key'),'-o','StrictHostKeyChecking=no','-o','UserKnownHostsFile=/dev/null','-o','LogLevel=ERROR','-o','ServerAliveInterval=30',`${m[1]}@${m[2]}`];
  // As Opaya's install terminal runs it: the command (with its exit mark) as ssh's remote command, in a pseudo terminal.
  const remote=(command,timeout)=>run('ssh',['-tt',...base,`${command}; echo "[opaya] finished with exit code $?"`],{timeout,input:''});
  const ess=await remote(catalog.command('essentials',{remote:true}).command,30*60*1000);
  const have=await run('ssh',[...base,`${proc.REMOTE_PATH}; for t in node npm python3 git uv tmux; do printf '%s ' "$t"; command -v $t >/dev/null 2>&1 && echo ok || echo MISSING; done`],{timeout:60000});
  report({id:'essentials',ok:!/MISSING/.test(have.out),seconds:ess.seconds,version:tail(have.out,8).replace(/\n/g,', '),error:/MISSING/.test(have.out)?tail(have.out,8).replace(/\n/g,', '):'',log:tail(ess.out)});
  for(const id of pick(Object.keys(BIN))){
    let command;try{({command}=catalog.command(id,{remote:true}));}catch(e){report({id,ok:false,error:e.message});continue;}
    const r=await remote(command,25*60*1000);
    const v=await run('ssh',[...base,`${proc.REMOTE_PATH}; command -v ${BIN[id]} && ${BIN[id]} --version`],{timeout:180000});
    report({id,ok:v.code===0,seconds:r.seconds,version:v.code===0?tail(v.out,2).replace(/\n/g,' '):'',error:v.code===0?'':`${BIN[id]} is not found with Opaya's remote PATH after the install (exit ${v.code}) ${tail(v.out,2)}`,log:tail(r.out)});
  }
}

// ---- Docker containers --------------------------------------------------------------------------------------------------
async function docker(){
  for(const id of pick(Object.keys(containers.PLANS))){
    const plan=containers.plan(id,{name:`ci-${id}`});
    // No terminal: the sign-in step at the end reads end of input and stops, as when the user skips it.
    const r=await run('bash',['-c',plan.command],{timeout:25*60*1000,input:''});
    const args=plan.connection.args.filter((a,i,all)=>a!=='-i'&&a!=='--profile'&&all[i-1]!=='--profile'),bin=args.at(-1)==='acp'?args.slice(0,-1):args;
    const v=await run('docker',[...bin,'--version'],{timeout:120000});
    let extra='';
    if(plan.port){const h=await run('curl',['-fsS','--max-time','5',`http://127.0.0.1:${plan.port}/healthz`],{timeout:30000});extra=h.code===0?' / gateway healthy':' / gateway NOT healthy';}
    report({id:`${id} (docker)`,ok:r.code===0&&v.code===0&&!/NOT healthy/.test(extra),seconds:r.seconds,version:v.code===0?tail(v.out,1)+extra:'',error:r.code!==0?`install exited ${r.code}${containers.EXIT[r.code]?`: ${containers.EXIT[r.code]}`:''}`:v.code!==0?`docker ${bin.join(' ')} --version exited ${v.code}: ${tail(v.out,3)}`:extra,log:tail(r.out)});
  }
}

(async()=>{
  console.log(`Install matrix: ${where} on ${process.platform}${where==='ssh'?` (${arg('ssh')})`:''}`);
  try{await (where==='ssh'?ssh():where==='docker'?docker():local());}
  catch(e){report({id:'matrix',ok:false,error:e.message});}
  const label=`${where}${where==='local'?` (${process.platform})`:where==='ssh'?` (${arg('ssh').split('@')[0]})`:''}`;
  fs.mkdirSync(path.join(__dirname,'..','artifacts'),{recursive:true});
  fs.writeFileSync(path.join(__dirname,'..','artifacts',`install-matrix-${where}-${process.platform}-${(arg('ssh').split('@')[0]||'x')}.json`),JSON.stringify(results,null,2));
  if(process.env.GITHUB_STEP_SUMMARY){
    const cell=s=>String(s||'').replace(/\|/g,'\\|').replace(/\n/g,' ').slice(0,160);
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,`### Install matrix: ${label}\n\n| | Agent | Time | Result |\n|---|---|---|---|\n${results.map(r=>`| ${r.ok?'✅':'❌'} | ${r.id} | ${r.seconds??''}s | ${cell(r.ok?r.version:r.error)} |`).join('\n')}\n\n`);
  }
  const failed=results.filter(r=>!r.ok);console.log(`\n${results.length-failed.length}/${results.length} passed${failed.length?`; failed: ${failed.map(r=>r.id).join(', ')}`:''}`);
  process.exit(failed.length?1:0);
})();
