'use strict';
// Remote agents working on a local project. Each agent gets its own copy where it runs (a machine over SSH, or inside
// its Docker container), linked to the one local project:
// - git (direct): the repository goes to the machine over SSH with git itself (your current branch, optionally with
//   uncommitted work). The agent works on its own branch; bringing changes back fetches that branch for review.
// - github: the machine clones the GitHub repository; the agent pushes its branch; you fetch it or open a PR.
// - copy: a plain folder is copied there and back; files that would be overwritten locally are backed up first.
// Nothing is ever force-pushed, and nothing is merged into your branch without you choosing it.
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {execFile}=require('node:child_process');
const {findExecutable,environment,sshArgs,quote,target}=require('./process.cjs');
const {run,transfer,measure}=require('./clone.cjs');
const q=quote;
const SKIP=new Set(['node_modules','.venv','venv','__pycache__','.next','.nuxt','dist','build','target','.cache','.turbo','.gradle','.DS_Store','.opaya-backup']);
const slug=v=>String(v||'').toLowerCase().replace(/[^a-z0-9_-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,40)||'project';
const AGENT_ID=['-c','user.name=Opaya agent','-c','user.email=agent@opaya.local'];
// Local git, with SSH going through the same options Opaya uses (key, port, user, host verification) and no prompts.
function sshCommand(host){const ssh=findExecutable('ssh',environment());if(!ssh)throw new Error('OpenSSH client is not installed.');return [ssh,...sshArgs(host)].map(q).join(' ');}
function git(cwd,args,{host=null,timeout=10*60*1000}={}){
  const bin=findExecutable('git',environment());if(!bin)return Promise.reject(new Error('Git is not installed on this computer. Install it from Install agents > Git.'));
  const env=environment({GIT_TERMINAL_PROMPT:'0',...(host?{GIT_SSH_COMMAND:sshCommand(host)}:{})});
  return new Promise((resolve,reject)=>execFile(bin,['-C',cwd,...args],{env,timeout,windowsHide:true,maxBuffer:16*1024*1024},(error,stdout,stderr)=>error?reject(new Error(String(stderr||error.message).trim().split('\n').slice(-4).join(' ').slice(0,600))):resolve(String(stdout))));
}
const gitUrl=(host,dir)=>host?`ssh://${target(host)}${dir}`:dir;
const where=(host,container='')=>({host:host||null,container:container||''});
// no host and no container: a second folder on this computer (used by tests)
const hostName=(host,container='')=>container?`container ${container} on ${host?host.name:'this computer'}`:host?host.name:'this computer';
// Git runs inside the container: the SSH (or local) side starts git-receive-pack / git-upload-pack through docker exec.
const pack=(container,kind)=>container?[`--${kind}-pack=docker exec -i ${q(container)} git-${kind}-pack`]:[];
// What the local folder is: a git repository (branch, uncommitted changes, GitHub origin) or a plain folder.
async function inspect(folder){
  const info={git:false,branch:'',dirty:0,origin:'',github:false,unpushed:0};
  try{if((await git(folder,['rev-parse','--is-inside-work-tree'])).trim()!=='true')return info;}catch{return info;}
  info.git=true;
  info.branch=(await git(folder,['branch','--show-current']).catch(()=>'')).trim();
  info.dirty=(await git(folder,['status','--porcelain']).catch(()=>'')).split('\n').filter(Boolean).length;
  info.origin=(await git(folder,['remote','get-url','origin']).catch(()=>'')).trim();
  info.github=/github\.com[:/]/.test(info.origin);
  info.unpushed=info.origin?Number((await git(folder,['rev-list','--count','@{u}..HEAD']).catch(()=>'')).trim())||0:0;
  info.upstream=!!info.origin&&!!(await git(folder,['rev-parse','--abbrev-ref','@{u}']).catch(()=>'')).trim();
  return info;
}
// The commit to send: HEAD, or HEAD plus every uncommitted change (tracked and new files, not ignored ones) as one
// commit made with a temporary index, so your working folder and your branch stay exactly as they are.
async function snapshot(folder,includeChanges){
  const head=(await git(folder,['rev-parse','HEAD'])).trim();
  if(!includeChanges||!(await git(folder,['status','--porcelain'])).trim())return {commit:head,included:false};
  const index=path.join(os.tmpdir(),`opaya-index-${process.pid}-${Date.now()}`);
  const withIndex=args=>new Promise((resolve,reject)=>execFile(findExecutable('git',environment()),['-C',folder,...args],{env:environment({GIT_INDEX_FILE:index}),windowsHide:true,maxBuffer:16*1024*1024},(e,out,err)=>e?reject(new Error(String(err||e.message).slice(0,400))):resolve(String(out))));
  try{
    await withIndex(['read-tree','HEAD']);await withIndex(['add','-A']);
    const tree=(await withIndex(['write-tree'])).trim();
    const commit=(await git(folder,[...AGENT_ID,'commit-tree',tree,'-p',head,'-m','Uncommitted changes sent from Opaya'])).trim();
    return {commit,included:true};
  }finally{await fs.rm(index,{force:true});}
}
async function remoteHome(host,container=''){return (await run(where(host,container),'printf %s "$HOME"')).trim();}
async function requireRemoteGit(host,container=''){
  const out=(await run(where(host,container),'command -v git >/dev/null 2>&1 && echo yes || echo no')).trim();
  if(out!=='yes')throw new Error(container?`Git is not installed in container ${container}. Share it as a plain copy instead, or install git in the container.`:`Git is not installed on ${hostName(host)}. Install it there (Install agents > ${hostName(host)} > Git), then try again.`);
}
// Where an agent's copy lives, as the agent sees it. On a machine: ~/opaya-projects/<project>-<agent>. In a container: in
// its data volume (the first writable bind mount, which survives the container being recreated), else its home.
async function placement({host,container='',project,agent}){
  const name=`${slug(project)}-${slug(agent)}`.slice(0,70);
  if(!container)return `${await remoteHome(host)}/opaya-projects/${name}`;
  const inspectMounts=host?run(where(host),`docker inspect -f '{{json .Mounts}}' ${q(container)}`,60000)
    :new Promise((resolve,reject)=>{const docker=findExecutable('docker',environment());if(!docker)return reject(new Error('Docker is not installed on this computer.'));execFile(docker,['inspect','-f','{{json .Mounts}}',container],{env:environment(),windowsHide:true,timeout:60000},(e,out,err)=>e?reject(new Error(String(err||e.message).trim())):resolve(String(out)));});
  const out=await inspectMounts.catch(error=>{throw new Error(`Could not look inside container ${container}: ${error.message}`);});
  let mounts=[];try{mounts=JSON.parse(out.trim()||'[]')||[];}catch{}
  const volume=mounts.find(m=>m&&m.Type==='bind'&&m.RW!==false&&typeof m.Destination==='string'&&m.Destination.startsWith('/')&&m.Destination!=='/');
  const root=volume?volume.Destination.replace(/\/+$/,''):await remoteHome(host,container);
  return `${root}/opaya-projects/${slug(project)}`;
}
// Delete an agent's copy. Only folders Opaya made (under an opaya-projects folder, never that folder itself).
async function removeCopy({host,container='',dir}){
  if(!/^\/(?:[^/\0]+\/)*opaya-projects\/[a-z0-9_-]+$/.test(String(dir||'')))throw new Error('Opaya only deletes copies it made.');
  await run(where(host,container),`rm -rf ${q(dir)}`,5*60*1000);
}
// ---- git, direct over SSH --------------------------------------------------------------------------------------
async function sendGit({folder,host,container='',dir,branch,includeChanges,first,lease='',progress}){
  await requireRemoteGit(host,container);
  progress({step:'prepare',state:'active',message:`Preparing ${dir} on ${hostName(host,container)}`});
  // A working repository that accepts pushes to its checked-out branch and updates its files (updateInstead). If the
  // agent left changes there, the push is refused rather than overwriting them.
  await run(where(host,container),`mkdir -p ${q(dir)} && cd ${q(dir)} && { [ -d .git ] || { git init -q && git symbolic-ref HEAD ${q('refs/heads/'+branch)}; }; } && git config receive.denyCurrentBranch updateInstead`,60000);
  progress({step:'prepare',state:'done',message:'Ready'});
  progress({step:'send',state:'active',message:includeChanges?'Sending your branch with uncommitted changes':'Sending your branch'});
  const snap=await snapshot(folder,includeChanges);
  // After you brought the agent's work back, its branch may be replaced, but only if it still ends where it did then
  // (force-with-lease): anything the agent did since stops the send instead of being lost.
  try{await git(folder,['push',...pack(container,'receive'),...(lease?[`--force-with-lease=refs/heads/${branch}:${lease}`]:[]),gitUrl(host,dir),`${snap.commit}:refs/heads/${branch}`],{host});}
  catch(error){
    if(/non-fast-forward|fetch first|rejected|stale info/i.test(error.message)&&!first)throw new Error(`${hostName(host,container)} has work you have not brought back yet. Bring changes back first, then send again.`);
    if(/unstaged changes|working tree|updateInstead/i.test(error.message))throw new Error(`The agent has unsaved changes on ${hostName(host,container)}. Bring changes back first, then send again.`);
    throw error;
  }
  progress({step:'send',state:'done',message:snap.included?'Sent, with your uncommitted changes':'Sent'});
  return {commit:snap.commit,included:snap.included};
}
// Save what the agent changed on the machine as a commit on its branch, then fetch it here for review.
async function commitRemote(host,container,dir,agentName){
  const msg=`Work by ${agentName||'the agent'} on ${hostName(host,container)}`.replace(/[^\w .()/-]/g,'');
  return (await run(where(host,container),`cd ${q(dir)} && if [ -n "$(git status --porcelain)" ]; then git add -A && git ${AGENT_ID.map(q).join(' ')} commit -q -m ${q(msg)} && echo committed; else echo clean; fi`,120000)).trim();
}
// What the agent did: everything on its branch since `base` (what Opaya last sent it, so your own uncommitted work that
// travelled along is not shown as the agent's). canMerge: its commits can be merged into your branch as they are.
async function summary(folder,ref,base){
  const head=(await git(folder,['rev-parse','HEAD'])).trim(),tip=(await git(folder,['rev-parse',ref])).trim();
  const from=base&&await git(folder,['cat-file','-e',`${base}^{commit}`]).then(()=>true,()=>false)?base:(await git(folder,['merge-base',head,ref]).catch(()=>'')).trim()||head;
  const commits=(await git(folder,['log','--format=%h %s',`${from}..${ref}`,'-50'])).split('\n').filter(Boolean);
  const files=(await git(folder,['diff','--name-status',from,ref])).split('\n').filter(Boolean).slice(0,300);
  const stat=(await git(folder,['diff','--shortstat',from,ref])).trim();
  const branch=(await git(folder,['branch','--show-current']).catch(()=>'')).trim();
  const canMerge=await git(folder,['merge-base','--is-ancestor',from,head]).then(()=>true,()=>false);
  return {ref,tip,base:from,commits,files,stat,branch,canMerge,upToDate:!files.length};
}
async function bringBackGit({folder,host,container='',dir,branch,agentName,base,progress}){
  await requireRemoteGit(host,container);
  progress({step:'save',state:'active',message:`Saving the agent's changes on ${hostName(host,container)}`});
  const saved=await commitRemote(host,container,dir,agentName);
  progress({step:'save',state:'done',message:saved==='committed'?'Saved its changes as a commit':'No unsaved changes there'});
  progress({step:'fetch',state:'active',message:'Fetching its branch'});
  const ref=`refs/opaya/${slug(container||(host?host.name:'local'))}/${branch}`;
  await git(folder,['fetch','--no-tags',...pack(container,'upload'),gitUrl(host,dir),`+refs/heads/${branch}:${ref}`],{host});
  progress({step:'fetch',state:'done',message:'Fetched'});
  return summary(folder,ref,base);
}
// ---- GitHub ------------------------------------------------------------------------------------------------------
async function sendGithub({folder,host,dir,branch,base,origin,first,progress}){
  await requireRemoteGit(host);
  const info=await inspect(folder);
  if(info.unpushed||!info.upstream){
    progress({step:'push',state:'active',message:`Pushing ${base} to GitHub so ${hostName(host)} can get it`});
    await git(folder,['push','-u','origin','HEAD']).catch(error=>{throw new Error(`Could not push ${base} to GitHub: ${error.message}. Push it yourself (Projects > Git > Push), then try again.`);});
    progress({step:'push',state:'done',message:'Pushed'});
  }
  progress({step:'prepare',state:'active',message:`Getting the repository on ${hostName(host)} from GitHub`});
  const script=first
    ?`if [ -d ${q(dir+'/.git')} ]; then cd ${q(dir)} && git fetch -q origin; else mkdir -p ${q(path.posix.dirname(dir))} && GIT_TERMINAL_PROMPT=0 git clone -q ${q(origin)} ${q(dir)} && cd ${q(dir)}; fi && (git switch -q ${q(branch)} 2>/dev/null || git switch -q -c ${q(branch)} ${q('origin/'+base)})`
    :`cd ${q(dir)} && GIT_TERMINAL_PROMPT=0 git fetch -q origin && git switch -q ${q(branch)} && git ${AGENT_ID.map(q).join(' ')} merge -q --no-edit ${q('origin/'+base)}`;
  try{await run(where(host),`export GIT_TERMINAL_PROMPT=0; ${script}`,10*60*1000);}
  catch(error){
    if(/Authentication|could not read Username|Permission denied \(publickey\)|Repository not found|403/i.test(error.message))throw Object.assign(new Error(`${hostName(host)} cannot read this GitHub repository yet. Sign in to GitHub there once (the button below), then try again.`),{needsGithubLogin:true});
    if(/conflict/i.test(error.message))throw new Error(`Your latest ${base} conflicts with the agent's work on ${hostName(host)}. Bring changes back and merge them first.`);
    throw error;
  }
  progress({step:'prepare',state:'done',message:`On branch ${branch}, from ${base}`});
  const commit=(await git(folder,['rev-parse',`refs/remotes/origin/${base}`]).catch(()=>'')).trim()||(await git(folder,['rev-parse','HEAD'])).trim();
  return {commit};
}
async function bringBackGithub({folder,host,dir,branch,agentName,base,progress}){
  progress({step:'save',state:'active',message:`Saving the agent's changes on ${hostName(host)}`});
  const saved=await commitRemote(host,'',dir,agentName);
  progress({step:'save',state:'done',message:saved==='committed'?'Saved its changes as a commit':'No unsaved changes there'});
  progress({step:'push',state:'active',message:`Pushing ${branch} from ${hostName(host)} to GitHub`});
  try{await run(where(host),`cd ${q(dir)} && GIT_TERMINAL_PROMPT=0 git push -q -u origin ${q(branch)}`,5*60*1000);}
  catch(error){if(/Authentication|could not read Username|403|Permission denied/i.test(error.message))throw Object.assign(new Error(`${hostName(host)} cannot push to GitHub yet. Sign in to GitHub there once (the button below), then try again.`),{needsGithubLogin:true});throw error;}
  progress({step:'push',state:'done',message:`Pushed ${branch}`});
  progress({step:'fetch',state:'active',message:'Fetching it here'});
  await git(folder,['fetch','--no-tags','origin',`+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
  progress({step:'fetch',state:'done',message:'Fetched'});
  return {...await summary(folder,`refs/remotes/origin/${branch}`,base),pushedBranch:branch};
}
// ---- plain folders ---------------------------------------------------------------------------------------------
async function topLevel(folder){return (await fs.readdir(folder)).filter(n=>!SKIP.has(n));}
async function sendCopy({folder,host,container='',dir,progress}){
  const paths=await topLevel(folder);if(!paths.length)throw new Error('The folder is empty.');
  const size=await measure(where(null),folder,paths);
  progress({step:'send',state:'active',message:`Copying ${size.files} files (${Math.round(size.bytes/1048576*10)/10} MB); skipping ${[...SKIP].slice(0,6).join(', ')}...`,bytes:0,total:size.bytes});
  const sent=await transfer(where(null),folder,paths,where(host,container),dir,{onBytes:n=>progress({step:'send',bytes:n,total:size.bytes})});
  progress({step:'send',state:'done',message:`Copied ${Math.round(sent/1048576*10)/10} MB`,bytes:sent,total:Math.max(sent,size.bytes)});
  return {};
}
async function walk(root,rel='',out=new Map()){
  for(const e of await fs.readdir(path.join(root,rel),{withFileTypes:true}).catch(()=>[])){
    if(SKIP.has(e.name))continue;const r=rel?path.join(rel,e.name):e.name;
    if(e.isDirectory())await walk(root,r,out);else if(e.isFile())out.set(r,path.join(root,r));
  }
  return out;
}
const same=async(a,b)=>{try{const [x,y]=await Promise.all([fs.readFile(a),fs.readFile(b)]);return x.equals(y);}catch{return false;}};
// Copy the machine's version back: new and changed files only (nothing is deleted here). Every local file that gets
// replaced is saved first under <backups>/projects/<name>/<time>/.
async function bringBackCopy({folder,host,container='',dir,backupRoot,name,progress}){
  const staging=await fs.mkdtemp(path.join(os.tmpdir(),'opaya-bring-'));
  try{
    progress({step:'fetch',state:'active',message:`Copying ${dir} from ${hostName(host,container)}`});
    const entries=(await run(where(host,container),`cd ${q(dir)} && ls -A`)).split('\n').map(s=>s.trim()).filter(n=>n&&!SKIP.has(n));
    if(entries.length)await transfer(where(host,container),dir,entries,where(null),staging);
    progress({step:'fetch',state:'done',message:'Copied'});
    progress({step:'apply',state:'active',message:'Comparing with your folder'});
    const theirs=await walk(staging),changed=[],added=[];
    for(const [rel,file] of theirs){const mine=path.join(folder,rel);try{await fs.access(mine);if(!await same(file,mine))changed.push(rel);}catch{added.push(rel);}}
    let backup='';
    if(changed.length){backup=path.join(backupRoot,'projects',slug(name),new Date().toISOString().replace(/[:.]/g,'-'));for(const rel of changed){await fs.mkdir(path.dirname(path.join(backup,rel)),{recursive:true});await fs.copyFile(path.join(folder,rel),path.join(backup,rel));}}
    for(const rel of [...changed,...added]){await fs.mkdir(path.dirname(path.join(folder,rel)),{recursive:true});await fs.copyFile(theirs.get(rel),path.join(folder,rel));}
    progress({step:'apply',state:'done',message:changed.length||added.length?`${changed.length} updated, ${added.length} new${backup?`; your previous versions are in ${backup}`:''}`:'No differences'});
    return {changed,added,backup,upToDate:!changed.length&&!added.length};
  }finally{await fs.rm(staging,{recursive:true,force:true});}
}
// Commands for what you choose after reviewing; they run in a visible terminal in your project folder.
// apply: the agent's changes become uncommitted edits in your folder, next to your own (nothing is committed for you).
// merge: its commits are merged into your branch (offered when that is clean). branch: its work on a new branch.
function applyCommands(result,action,{branch,patchFile,windows=false}={}){
  const ref=result?.ref,base=result?.base;
  if(!/^refs\/(opaya|remotes\/origin)\/[\w./-]+$/.test(ref||''))throw new Error('Unknown change set.');
  if(base&&!/^[0-9a-f]{7,64}$/.test(base))throw new Error('Unknown base.');
  if(action==='apply'){if(!patchFile)throw new Error('Missing patch file.');return [`git diff --binary ${base} ${q(ref)} --output=${q(patchFile)}`,`git apply --3way --whitespace=nowarn ${q(patchFile)}`,'git status --short'];}
  if(action==='merge')return [`git merge --no-edit ${q(ref)}`];
  if(action==='branch'){const b=String(branch||'').trim();if(!/^[A-Za-z0-9._\/-]{1,100}$/.test(b)||b.startsWith('-'))throw new Error('Choose a branch name.');return [`git switch -c ${q(b)} ${q(ref)}`];}
  if(action==='diff')return [`git --no-pager diff --stat ${base} ${q(ref)}`,`git diff ${base} ${q(ref)}`];
  throw new Error('Unknown action.');
}
module.exports={placement,removeCopy,inspect,snapshot,summary,sendGit,bringBackGit,sendGithub,bringBackGithub,sendCopy,bringBackCopy,applyCommands,remoteHome,slug,gitUrl,SKIP};
