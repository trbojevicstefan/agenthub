'use strict';
// Projects: a named folder on this computer or a saved machine, plus the agents that work in it. Opaya stores only
// that; git state is read live. Git and GitHub CLI actions run as fixed commands in a visible terminal in the folder.
const {randomUUID}=require('node:crypto');
const path=require('node:path');
const {text,id}=require('./schema.cjs');
const {quote}=require('./process.cjs');
function project(input){
  if(!input||typeof input!=='object')throw new Error('Missing project.');
  const hostId=input.hostId?id(input.hostId):'';
  const folder=text(input.path,'project folder',2048).trim();
  if(!folder)throw new Error('Choose the project folder.');
  if(hostId?!path.posix.isAbsolute(folder):!(path.isAbsolute(folder)||path.win32.isAbsolute(folder)))throw new Error(hostId?'A folder on a machine must be an absolute path such as /root/app.':'Choose an absolute folder path.');
  const name=text(input.name,'project name',60,'').trim()||folder.split(/[\\/]/).filter(Boolean).pop()||'Project';
  const agentIds=Array.isArray(input.agentIds)?[...new Set(input.agentIds.map(id))].slice(0,64):[];
  const remotes=hostId||!Array.isArray(input.remotes)?[]:[...new Map(input.remotes.map(remote).filter(Boolean).map(r=>[r.agentId,r])).values()].slice(0,32);
  return {id:input.id?id(input.id):randomUUID(),name,path:folder,hostId,agentIds:[...new Set([...agentIds,...remotes.map(r=>r.agentId)])].slice(0,64),remotes,link:link(input.link),createdAt:input.createdAt||new Date().toISOString()};
}
// A copy of a local project on a machine, for remote agents: where it came from and how changes move.
const SHA=/^[0-9a-f]{7,64}$/;
function link(input){
  if(!input||typeof input!=='object'||!['git','github','copy'].includes(input.mode))return null;
  const b=String(input.branch||'');if(input.mode!=='copy'&&!BRANCH.test(b))return null;
  return {from:id(input.from),mode:input.mode,branch:input.mode==='copy'?'':b,base:BRANCH.test(String(input.base||''))?input.base:'',origin:typeof input.origin==='string'?input.origin.slice(0,500):'',
    lastSent:SHA.test(input.lastSent||'')?input.lastSent:'',lastFetched:SHA.test(input.lastFetched||'')?input.lastFetched:'',sentAt:typeof input.sentAt==='string'?input.sentAt.slice(0,40):'',fetchedAt:typeof input.fetchedAt==='string'?input.fetchedAt.slice(0,40):''};
}
// A remote agent's own copy of a local project: where it is (as the agent sees it) and how changes move.
function remote(input){
  if(!input||typeof input!=='object'||!['git','github','copy'].includes(input.mode))return null;
  try{
    const dir=String(input.dir||'');if(!path.posix.isAbsolute(dir)||dir.length>1024||/[\0\n]/.test(dir))return null;
    const container=String(input.container||'');if(container&&!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(container))return null;
    const l=link({...input,from:input.agentId});if(!l)return null;
    return {agentId:id(input.agentId),hostId:input.hostId?id(input.hostId):'',container,dir,mode:l.mode,branch:l.branch,base:l.base,origin:l.origin,lastSent:l.lastSent,lastFetched:l.lastFetched,sentAt:l.sentAt,fetchedAt:l.fetchedAt};
  }catch{return null;}
}
const remoteOf=(agent,p)=>(p.remotes||[]).find(r=>r.agentId===agent.id)||null;
// An agent can work in a project when it runs on the same machine as the folder (containers use their own paths), or
// when it has its own copy of the project.
const fits=(agent,p)=>!!remoteOf(agent,p)||agent.command!=='docker'&&(p.hostId?agent.transport==='ssh'&&agent.hostId===p.hostId:agent.transport!=='ssh');
// The folder the agent works in for this project.
const folderFor=(agent,p)=>{const r=remoteOf(agent,p);return r?r.dir:fits(agent,p)?p.path:'';};
// Agents that need their own copy to work on this local project: on another machine or in a container. API-only
// connections have no files.
const needsCopy=(agent,p)=>!p.hostId&&!fits({...agent,id:''},p)&&agent.protocol!=='openai'&&agent.transport!=='http';
const BRANCH=/^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)(?!.*\.lock$)(?!.*\/$)[A-Za-z0-9._\/-]{1,120}$/;
function branch(value){const v=String(value||'').trim();if(!BRANCH.test(v))throw new Error('Use a branch name with letters, numbers, ., _, - and /.');return v;}
function message(value,label='Commit message',max=500){const v=String(value||'').trim();if(!v)throw new Error(`Enter a ${label.toLowerCase()}.`);if(v.length>max||/[\0\r\n]/.test(v))throw new Error(`${label} must be one line under ${max} characters.`);return v;}
function cloneUrl(value){
  const v=String(value||'').trim();
  if(/^https:\/\/[A-Za-z0-9.-]+(:\d+)?\/[A-Za-z0-9._~\/-]+?(\.git)?$/.test(v)||/^git@[A-Za-z0-9.-]+:[A-Za-z0-9._~\/-]+?(\.git)?$/.test(v))return v;
  throw new Error('Use an https:// or git@host:owner/repo repository address.');
}
// Each action: label, group and the git/gh arguments. Arguments are quoted per shell below; user input is validated.
const ACTIONS={
  status:{label:'Status',group:'git',args:()=>[['git','status','-sb']]},
  fetch:{label:'Fetch',group:'git',args:()=>[['git','fetch','--all','--prune']]},
  pull:{label:'Pull',group:'git',args:()=>[['git','pull']]},
  push:{label:'Push',group:'git',args:()=>[['git','push','-u','origin','HEAD']]},
  commit:{label:'Commit all changes',group:'git',input:'message',args:x=>[['git','add','-A'],['git','commit','-m',message(x.message)]]},
  commitPush:{label:'Commit and push',group:'git',input:'message',args:x=>[['git','add','-A'],['git','commit','-m',message(x.message)],['git','push','-u','origin','HEAD']]},
  stash:{label:'Stash changes',group:'git',args:()=>[['git','stash','push','-u']]},
  stashPop:{label:'Apply last stash',group:'git',args:()=>[['git','stash','pop']]},
  branchNew:{label:'New branch',group:'branch',input:'branch',args:x=>[['git','switch','-c',branch(x.branch)]]},
  switch:{label:'Switch branch',group:'branch',input:'pick',args:x=>[['git','switch',branch(x.branch)]]},
  merge:{label:'Merge into current branch',group:'branch',input:'pick',args:x=>[['git','merge',branch(x.branch)]]},
  log:{label:'History',group:'branch',args:()=>[['git','log','--oneline','--graph','--decorate','-25']]},
  prCreate:{label:'Create pull request',group:'github',input:'title',args:x=>x.title?[['gh','pr','create','--title',message(x.title,'Title',200),'--body',String(x.body||'').replace(/[\0\r\n]+/g,' ').slice(0,2000)||'Created from Opaya.']]:[['gh','pr','create','--fill']]},
  prList:{label:'Pull requests',group:'github',args:()=>[['gh','pr','list']]},
  prStatus:{label:'PR status and checks',group:'github',args:()=>[['gh','pr','status']]},
  prView:{label:'Open PR in browser',group:'github',args:()=>[['gh','pr','view','--web']]},
  prCheckout:{label:'Check out PR',group:'github',input:'number',args:x=>{const n=String(x.number||'').trim();if(!/^\d{1,7}$/.test(n))throw new Error('Enter a pull request number.');return [['gh','pr','checkout',n]];}},
  prMerge:{label:'Merge PR',group:'github',args:()=>[['gh','pr','merge']]},
  ghLogin:{label:'Sign in to GitHub CLI',group:'github',args:()=>[['gh','auth','login']]}
};
const psQuote=v=>`'${String(v).replace(/'/g,"''")}'`;
// The full command typed into the project's terminal: change into the folder, then run each step only if the last worked.
function gitCommand(p,action,input={},{windows=false}={}){
  const a=ACTIONS[action];if(!a)throw new Error('Unknown git action.');
  const steps=a.args(input);
  if(windows&&!p.hostId){
    const run=steps.map(s=>`${s[0]} ${s.slice(1).map(psQuote).join(' ')}`);
    return `Set-Location -LiteralPath ${psQuote(p.path)}; ${run.map((r,i)=>i?`if ($?) { ${r} }`:r).join('; ')}`;
  }
  return `cd -- ${quote(p.path)} && ${steps.map(s=>s.map((x,i)=>i?quote(x):x).join(' ')).join(' && ')}`;
}
function cloneCommand({url,parent,folder,hostId},{windows=false}={}){
  url=cloneUrl(url);const name=String(folder||'').trim()||url.split(/[\/:]/).pop().replace(/\.git$/,'');
  if(!/^[A-Za-z0-9._-]{1,100}$/.test(name)||name==='.'||name==='..')throw new Error('Use a folder name with letters, numbers, ., _ and -.');
  const base=text(parent,'parent folder',2048).trim();
  if(hostId?!path.posix.isAbsolute(base):!(path.isAbsolute(base)||path.win32.isAbsolute(base)))throw new Error('Choose an absolute parent folder.');
  const target=hostId||!windows?path.posix.join(base,name):path.win32.join(base,name);
  const command=windows&&!hostId?`Set-Location -LiteralPath ${psQuote(base)}; git clone ${psQuote(url)} ${psQuote(name)}`:`cd -- ${quote(base)} && git clone ${quote(url)} ${quote(name)}`;
  return {command,path:target,name};
}
const actionList=()=>Object.entries(ACTIONS).map(([key,a])=>({key,label:a.label,group:a.group,input:a.input||''}));
module.exports={project,remote,remoteOf,fits,folderFor,needsCopy,gitCommand,cloneCommand,actionList,branch,ACTIONS};
