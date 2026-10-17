'use strict';
// Sync with the web app (SYNC_PLAN.md). The same engine runs in the desktop app (over HTTPS, account.cjs) and in a web
// runtime (over its Unix socket, remote-vault.cjs). A round pulls what changed on the server and applies it here, then
// pushes what changed here. A change is found by the hash of a record's data against the hash last synced
// (sync-state.json). The server keeps the version it gets last.
const crypto=require('node:crypto');
const path=require('node:path');
const {readJson,atomicJson}=require('./store.cjs');
const hash=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0,32);
// One push: at most 500 records and about 8 MB (the server takes 16 MB, the runtime's socket 24 MB).
const TRANSCRIPT_LIMIT=1000*1024,PUSH_SIZE=500,PUSH_BYTES=8*1024*1024,MAX_FAILED=200;
// Interface settings that follow the user. Everything else in Settings belongs to one computer.
const SETTINGS=['sendKey','tips','notifyReplies','notifyApprovals','notifyJobs','notifySound','chatOpens','consoleOpens'];
const pick=(o,keys)=>Object.fromEntries(keys.filter(k=>o?.[k]!==undefined).map(k=>[k,o[k]]));
// A record that cannot be applied now: an active turn (`parent` empty: the next round tries again), or its machine,
// agent or chat is not here yet (`parent` is that record's key: it may come later in the same round).
class Later extends Error{constructor(parent=''){super('later');this.parent=parent;}}
// Trust decisions stay on each computer: iTrust is not synced, and a synced executable waits for trust on first use.
const LOCAL_ONLY=['itrust','trustPending'];
const publicEndpoint=e=>{try{const u=new URL(e);return u.protocol==='https:'&&!['127.0.0.1','localhost','[::1]'].includes(u.hostname);}catch{return false;}};
// What syncs: machines with a hostname, agents on them or HTTP APIs with a public address, and their chats.
const hostSyncs=h=>!!h?.hostname;
const agentSyncs=(d,a)=>!!a&&(a.transport==='ssh'&&hostSyncs(d.hosts.find(h=>h.id===a.hostId))||a.transport==='http'&&publicEndpoint(a.endpoint));
const chatSyncs=(d,c)=>!!c&&!c.kind&&agentSyncs(d,d.agents.find(a=>a.id===c.agentId));
// An item here that does not sync (now): a machine with only an alias, an agent on this computer, their chats. It is
// not deleted on the server, and records from the server leave it as it is.
function localOnly(d,kind,id){
  if(kind==='host'){const h=d.hosts.find(h=>h.id===id);return !!h&&!hostSyncs(h);}
  if(kind==='agent'){const a=d.agents.find(a=>a.id===id);return !!a&&!agentSyncs(d,a);}
  if(kind==='conversation'||kind==='transcript'){const c=d.conversations.find(c=>c.id===id);return !!c&&!chatSyncs(d,c);}
  return false;
}
// Messages as they sync: finished ones, text only (no attachments), newest first until the limit.
function transcriptData(messages){
  const out=[];let size=0;
  for(const m of [...(messages||[])].reverse()){
    if(!m||m.status==='streaming'||typeof m.id!=='string')continue;
    const x={id:m.id,role:m.role,content:String(m.content||''),status:m.status||'done',createdAt:m.createdAt||'',...(m.error?{error:String(m.error)}:{})};
    size+=Buffer.byteLength(JSON.stringify(x));if(size>TRANSCRIPT_LIMIT)break;out.push(x);
  }
  return {messages:out.reverse()};
}
// Both sides' messages, each once (by ID), in time order. A message being written here stays as it is.
function mergeMessages(local,remote){
  const byId=new Map((local||[]).map(m=>[m.id,m]));
  for(const m of remote||[]){const mine=byId.get(m.id);if(!mine)byId.set(m.id,m);else if(mine.status!=='streaming'&&mine.content!==m.content&&m.status==='done')byId.set(m.id,{...mine,content:m.content,status:m.status});}
  return [...byId.values()].sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt)));
}
// The records this workspace has, for the kinds this client sends. known: the hashes last synced, to skip reading
// transcripts that are not in memory and did not change.
async function collect({broker,opaya,kinds,known={}}){
  const out=new Map(),add=(kind,id,data)=>out.set(`${kind}:${id}`,{kind,id,data});
  const d=broker.data,hosts=new Set();
  if(kinds.has('host'))for(const h of d.hosts||[])if(hostSyncs(h)){hosts.add(h.id);add('host',h.id,{name:h.name,hostname:h.hostname,username:h.username||'',port:h.port||22});}
  const agents=new Set();
  if(kinds.has('agent'))for(const a of d.agents||[]){
    if(!(a.transport==='ssh'&&hosts.has(a.hostId)||a.transport==='http'&&publicEndpoint(a.endpoint)))continue;
    agents.add(a.id);const {itrust:_i,trustPending:_t,...data}=a;add('agent',a.id,data);
  }
  for(const c of d.conversations||[]){
    if(!agents.has(c.agentId)||c.kind)continue;
    if(kinds.has('conversation'))add('conversation',c.id,{agentId:c.agentId,title:c.title,createdAt:c.createdAt,externalSessionId:c.externalSessionId||''});
    if(kinds.has('transcript')){
      const loaded=broker.histories.get(c.id);
      if(!loaded&&known[`transcript:${c.id}`]){out.set(`transcript:${c.id}`,{kind:'transcript',id:c.id,unchanged:known[`transcript:${c.id}`]});continue;}
      add('transcript',c.id,transcriptData(loaded||await broker.store.transcript(c.id)));
    }
  }
  if(kinds.has('secret')&&opaya)for(const s of opaya.secrets||[])if((s.kept||s.global)&&s.sync)add('secret',s.key,{name:s.name,mask:s.mask,endpoint:s.endpoint||'',global:!!s.global});
  if(kinds.has('settings'))add('settings','settings',pick(d.settings,SETTINGS));
  return out;
}
// A record from the server, applied to this workspace. A new or changed executable is saved, and the broker asks the
// user to trust it before it first runs here (broker.ensureTrusted).
async function apply({broker,opaya,vault},r){
  const d=broker.data,x=r.data;
  if(r.kind==='host'){
    const existing=d.hosts.find(h=>h.id===r.id),next={...(existing||{}),id:r.id,name:x.name,hostname:x.hostname,username:x.username,port:x.port};
    // A new address waits for the turns on this machine to end; a new name does not.
    const moved=existing&&(existing.hostname!==next.hostname||existing.username!==next.username||(existing.port||22)!==(next.port||22));
    if(moved&&d.agents.some(a=>a.hostId===r.id&&broker.turns.has(a.id)))throw new Later();
    await broker.saveHost(next,{sync:true});return;
  }
  if(r.kind==='agent'){
    // Only what this engine sends: agents on a machine and HTTP APIs with a public address. Never "this computer".
    if(!(x.transport==='ssh'||x.transport==='http'&&publicEndpoint(x.endpoint)))throw new Error(`${String(x.name||'An agent').slice(0,60)} is not an agent on a machine or an HTTP API with a public address.`);
    if(broker.turns.has(r.id))throw new Later();
    if(x.transport==='ssh'&&!d.hosts.some(h=>h.id===x.hostId))throw new Later(`host:${x.hostId}`);
    const existing=d.agents.find(a=>a.id===r.id),incoming=Object.fromEntries(Object.entries(x).filter(([k])=>!LOCAL_ONLY.includes(k)));
    // A new executable, or the same one in another place, waits for the user's trust here.
    const changed=x.protocol!=='openai'&&(!existing||existing.command!==x.command||JSON.stringify(existing.args)!==JSON.stringify(x.args)||existing.hermesHome!==x.hermesHome||existing.transport!==x.transport||existing.hostId!==x.hostId);
    await broker.saveAgent({agent:{...(existing||{}),...incoming,id:r.id,...(changed||existing?.trustPending?{trustPending:true}:{})}},{preapproved:true,sync:true});return;
  }
  if(r.kind==='conversation'){
    if(!d.agents.some(a=>a.id===x.agentId))throw new Later(`agent:${x.agentId}`);
    const c=d.conversations.find(c=>c.id===r.id);
    if(c)Object.assign(c,{title:x.title,externalSessionId:x.externalSessionId||c.externalSessionId||''});
    else{if(d.conversations.length>=2000)throw new Error('This app has 2000 chats, the most it keeps. Delete chats to get the new ones.');d.conversations.push({id:r.id,agentId:x.agentId,title:String(x.title||'Chat').slice(0,120),createdAt:x.createdAt||new Date().toISOString(),externalSessionId:x.externalSessionId||''});}
    await broker.persist();return;
  }
  if(r.kind==='transcript'){
    const c=d.conversations.find(c=>c.id===r.id);if(!c)throw new Later(`conversation:${r.id}`);
    if(broker.turns.get(c.agentId)?.conversationId===c.id)throw new Later();
    const local=broker.histories.get(c.id)||await broker.store.transcript(c.id),merged=mergeMessages(local,x.messages);
    if(broker.histories.has(c.id)||c.id===d.activeConversationId)broker.histories.set(c.id,merged);
    await broker.store.writeTranscript(c.id,merged);broker.changed();return;
  }
  if(r.kind==='secret'){if(!opaya?.syncedSecret)return;await vault.refresh?.(r.id);await opaya.syncedSecret(r.id,x);return;}
  if(r.kind==='settings'){await broker.saveSettings(pick(x,SETTINGS));return;}
}
async function remove({broker,opaya},kind,id){
  const d=broker.data;
  if(kind==='host'){if(d.hosts.some(h=>h.id===id)&&!d.agents.some(a=>a.hostId===id))await broker.removeHost(id);return;}
  if(kind==='agent'){if(!d.agents.some(a=>a.id===id))return;if(broker.turns.has(id))throw new Later();await broker.removeAgent(id);return;}
  if(kind==='conversation'){const c=d.conversations.find(c=>c.id===id);if(!c)return;if(broker.turns.get(c.agentId)?.conversationId===id)throw new Later();await broker.deleteConversation(id);return;}
  if(kind==='secret'){await opaya?.syncedSecret?.(id,null);return;}
}
class Sync{
  // transport: {pull(since), push(records), secret?(key, value)}. sends/accepts: the kinds this client sends and takes.
  constructor({root,broker,opaya,vault,transport,sends,accepts,account='',log=()=>{}}){
    Object.assign(this,{root,broker,opaya,vault,transport,sends:new Set(sends),accepts:new Set(accepts),account,log});
    this.file=path.join(root,'sync-state.json');this.state={account,rev:0,hashes:{}};this.running=null;this.timer=null;this.soon=null;this.error='';this.lastRound=0;
  }
  async load(){
    const s=await readJson(this.file,null).catch(()=>null);
    this.state=s&&s.account===this.account&&s.hashes&&typeof s.hashes==='object'?s:{account:this.account,rev:0,hashes:{}};
    if(!this.state.failed||typeof this.state.failed!=='object')this.state.failed={};
  }
  save(){return atomicJson(this.file,this.state);}
  ctx(){return {broker:this.broker,opaya:this.opaya,vault:this.vault};}
  round(){if(!this.running)this.running=this.run().finally(()=>{this.running=null;});return this.running;}
  // A record that cannot be applied here (a newer app's data, a limit): it is tried again when it changes on the server,
  // and the sync status shows it.
  fail(key,message){
    this.state.failed[key]=String(message||'Unknown error.').slice(0,200);this.log(`Sync could not apply ${key}: ${message}`);
    const keys=Object.keys(this.state.failed);if(keys.length>MAX_FAILED)delete this.state.failed[keys[0]];
  }
  // One record from the server: 'done', 'turn' (an active turn: the next round tries again) or 'parent' (its machine,
  // agent or chat is not here yet).
  async take(r){
    const key=`${r.kind}:${r.id}`;
    if(!this.accepts.has(r.kind))return 'done';
    try{
      if(localOnly(this.broker.data,r.kind,r.id)){}
      else if(r.deleted){await remove(this.ctx(),r.kind,r.id);delete this.state.hashes[key];}
      else if(this.state.hashes[key]!==hash(r.data)){await apply(this.ctx(),r);this.state.hashes[key]=hash(r.data);}
      delete this.state.failed[key];return 'done';
    }catch(error){
      if(error instanceof Later)return error.parent&&this.state.failed[error.parent]?(this.fail(key,`It belongs to ${error.parent.split(':')[0]} ${error.parent.split(':')[1]}, which was not applied here.`),'done'):error.parent?'parent':'turn';
      this.fail(key,error.message);return 'done';
    }
  }
  async run(){
    try{
      // Pull first: apply what changed on the server, in change order. A record whose machine, agent or chat comes
      // later waits for the end of the pull; a record held by an active turn is pulled again next round.
      let since=this.state.rev,more=true;const waiting=[],held=[];
      while(more){
        const page=await this.transport.pull(since);
        if(page.reset){this.state.hashes={};this.state.failed={};}
        for(const r of page.records||[]){
          const result=await this.take(r);
          if(result==='parent')waiting.push(r);else if(result==='turn')held.push(r);
          since=r.rev;
        }
        if(!page.records?.length)since=Math.max(since,page.rev||0);
        more=!!page.more&&!!page.records?.length;
      }
      for(let progress=true;progress&&waiting.length;){
        progress=false;
        for(const r of [...waiting]){
          const result=await this.take(r);if(result==='parent')continue;
          waiting.splice(waiting.indexOf(r),1);progress=true;if(result==='turn')held.push(r);
        }
      }
      for(const r of waiting)this.fail(`${r.kind}:${r.id}`,'Its machine, agent or chat is not in sync.');
      if(held.length)since=Math.min(since,...held.map(r=>r.rev-1));
      this.state.rev=since;
      // The local versions of what was just applied are the synced ones (the schema may normalize them).
      const local=await collect({...this.ctx(),kinds:this.sends,known:this.state.hashes});
      // Then push what changed here. An item that no longer syncs but is still here stops syncing: it is not deleted
      // on the server (the other app keeps its copy).
      const changes=[],d=this.broker.data;
      for(const [key,r] of local){if(r.unchanged)continue;const h=hash(r.data);if(this.state.hashes[key]!==h)changes.push({...r,hash:h,key});}
      for(const key of Object.keys(this.state.hashes)){
        const [kind,id]=key.split(':');if(!this.sends.has(kind)||local.has(key))continue;
        if(localOnly(d,kind,id)){delete this.state.hashes[key];continue;}
        changes.push({kind,id,deleted:true,key});
      }
      for(let i=0;i<changes.length;){
        // At most PUSH_SIZE records and about PUSH_BYTES in one push.
        const chunk=[];let bytes=0;
        while(i<changes.length&&chunk.length<PUSH_SIZE){const n=changes[i].deleted?100:Buffer.byteLength(JSON.stringify(changes[i].data));if(chunk.length&&bytes+n>PUSH_BYTES)break;chunk.push(changes[i++]);bytes+=n;}
        // A secret's value goes first, by its own call; records carry no values.
        for(const c of chunk)if(c.kind==='secret'&&this.transport.secret)await this.transport.secret(c.id,c.deleted?null:this.vault.get(c.id)||null);
        await this.transport.push(chunk.map(({kind,id,deleted,data})=>deleted?{kind,id,deleted:true}:{kind,id,data}));
        for(const c of chunk){if(c.deleted)delete this.state.hashes[c.key];else this.state.hashes[c.key]=c.hash;}
      }
      const failed=Object.values(this.state.failed);
      this.error=failed.length?`${failed.length} synced item${failed.length===1?'':'s'} could not be applied here. ${failed[0]}`.slice(0,300):'';
      this.lastRound=Date.now();await this.save();
      return {pulled:this.state.rev,pushed:changes.length,failed:failed.length};
    }catch(error){this.error=String(error?.message||error).slice(0,300);await this.save().catch(()=>{});throw error;}
  }
  // A local change: a round 5 seconds later (one round for many quick changes).
  touch(){if(!this.timer)return;clearTimeout(this.soon);this.soon=setTimeout(()=>this.round().catch(()=>{}),5000);this.soon.unref?.();}
  start(){if(this.timer)return;this.round().catch(()=>{});this.timer=setInterval(()=>this.round().catch(()=>{}),60000);this.timer.unref?.();}
  stop(){clearInterval(this.timer);clearTimeout(this.soon);this.timer=null;this.soon=null;}
  describe(){return {on:!!this.timer,lastRound:this.lastRound,error:this.error};}
}
module.exports={Sync,collect,apply,remove,localOnly,mergeMessages,transcriptData,Later,SETTINGS};
