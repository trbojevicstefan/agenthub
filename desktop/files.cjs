'use strict';
// Read-only file and project browsing for this computer and saved SSH machines. Nothing here writes, deletes or runs
// anything except `git` for status on this computer, and a fixed Python reader over SSH.
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {spawn,execFile}=require('node:child_process');
const {findExecutable,environment,sshArgs,target,quote,collect}=require('./process.cjs');
const MAX_ENTRIES=2000,MAX_READ=256*1024;
const MARKERS=['.git','package.json','pyproject.toml','requirements.txt','Cargo.toml','go.mod','Dockerfile','docker-compose.yml','compose.yaml','README.md','AGENTS.md','CLAUDE.md','.hermes','config.yaml','SOUL.md','.env'];
// File names the Opaya Agent may never read, so secrets are not sent to its model provider. The user can still view them.
const SECRET=/(^|[\\/])(\.env(\..*)?|.*\.(pem|key|p12|pfx|kdbx)|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|known_hosts|authorized_keys|credentials(\.json)?|auth\.json|vault\.json|.*secret.*|.*token.*|\.netrc|\.npmrc|\.pypirc)$/i;
const isSecret=file=>SECRET.test(String(file));

// Same operations as local(), executed by python3 on the remote machine. The request arrives on stdin as JSON.
const REMOTE=String.raw`
import json,os,sys,subprocess
r=json.load(sys.stdin);op=r.get('op');p=os.path.abspath(os.path.expanduser(r.get('path') or '~'))
def out(x):
  sys.stdout.write(json.dumps(x));sys.exit(0)
def git(args):
  try:return subprocess.run(['git','-C',p]+args,capture_output=True,text=True,timeout=8).stdout
  except Exception:return ''
try:
  if op=='list':
    items=[]
    with os.scandir(p) as it:
      for i,e in enumerate(it):
        if i>=${MAX_ENTRIES}:break
        try:
          st=e.stat();items.append({'name':e.name,'type':'dir' if e.is_dir() else 'file','size':st.st_size,'mtime':int(st.st_mtime),'link':e.is_symlink()})
        except OSError:items.append({'name':e.name,'type':'broken','size':0,'mtime':0,'link':True})
    out({'path':p,'parent':os.path.dirname(p) if p!='/' else '','home':os.path.expanduser('~'),'entries':items})
  if op=='read':
    size=os.path.getsize(p)
    with open(p,'rb') as f:data=f.read(${MAX_READ})
    binary=b'\0' in data[:8192]
    out({'path':p,'size':size,'truncated':size>len(data),'binary':binary,'text':'' if binary else data.decode('utf-8','replace')})
  if op=='project':
    markers=[m for m in ${JSON.stringify(MARKERS)} if os.path.exists(os.path.join(p,m))]
    status=git(['status','--porcelain=v1','--branch']).splitlines()
    out({'path':p,'markers':markers,'git':{'branch':status[0][3:] if status else '','changes':status[1:61],'recent':git(['log','--oneline','-8']).splitlines()} if status else None})
  out({'error':'Unknown operation.'})
except Exception as e:
  out({'error':str(e)[:400]})
`;
function git(cwd,args){return new Promise(resolve=>{const bin=findExecutable('git',environment());if(!bin)return resolve('');execFile(bin,['-C',cwd,...args],{timeout:8000,windowsHide:true,maxBuffer:1024*1024,env:environment()},(error,stdout)=>resolve(error?'':stdout));});}
async function local(op,input){
  const p=path.resolve(input?input.replace(/^~(?=$|[\\/])/,os.homedir()):os.homedir());
  if(op==='list'){
    const dir=await fs.opendir(p),entries=[];
    for await(const e of dir){
      if(entries.length>=MAX_ENTRIES)break;
      try{const st=await fs.stat(path.join(p,e.name));entries.push({name:e.name,type:st.isDirectory()?'dir':'file',size:st.size,mtime:Math.floor(st.mtimeMs/1000),link:e.isSymbolicLink()});}
      catch{entries.push({name:e.name,type:'broken',size:0,mtime:0,link:true});}
    }
    const parent=path.dirname(p);return {path:p,parent:parent===p?'':parent,home:os.homedir(),entries};
  }
  if(op==='read'){
    const st=await fs.stat(p);if(st.isDirectory())throw new Error('That is a folder.');
    const handle=await fs.open(p,'r');try{const buffer=Buffer.alloc(Math.min(st.size,MAX_READ));await handle.read(buffer,0,buffer.length,0);const binary=buffer.subarray(0,8192).includes(0);return {path:p,size:st.size,truncated:st.size>buffer.length,binary,text:binary?'':buffer.toString('utf8')};}finally{await handle.close();}
  }
  if(op==='project'){
    const markers=[];for(const m of MARKERS){try{await fs.access(path.join(p,m));markers.push(m);}catch{}}
    const status=(await git(p,['status','--porcelain=v1','--branch'])).split(/\r?\n/).filter(Boolean);
    return {path:p,markers,git:status.length?{branch:status[0].slice(3),changes:status.slice(1,61),recent:(await git(p,['log','--oneline','-8'])).split(/\r?\n/).filter(Boolean)}:null};
  }
  throw new Error('Unknown operation.');
}
async function remote(host,op,input){
  const ssh=findExecutable('ssh',environment());if(!ssh)throw new Error('OpenSSH client is not installed.');
  const child=spawn(ssh,[...sshArgs(host),'-T',target(host),'python3 -c '+quote(REMOTE)],{env:environment(),windowsHide:true,stdio:['pipe','pipe','pipe']});
  let result;
  try{result=JSON.parse(await collect(child,{timeout:20000,maxBytes:2*1024*1024,input:JSON.stringify({op,path:input||''})}));}
  catch(error){if(/Host key verification|Permission denied|sign_and_send_pubkey/i.test(error.message))throw new Error('SSH trust or authentication failed. Open this machine in Terminal once to verify it and unlock your key.');if(/python3: (command )?not found/i.test(error.message))throw new Error('Browsing files on this machine needs python3.');throw error;}
  if(result.error)throw new Error(result.error);return result;
}
async function browse({op,path:input='',host=null}){
  if(!['list','read','project'].includes(op))throw new Error('Unknown file operation.');
  if(typeof input!=='string'||input.length>4096||/[\0\r\n]/.test(input))throw new Error('Invalid path.');
  return host?remote(host,op,input):local(op,input);
}
module.exports={browse,isSecret,MARKERS,REMOTE};
