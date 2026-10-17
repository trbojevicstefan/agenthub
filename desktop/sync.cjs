'use strict';
// Sync with the web app (SYNC_PLAN.md). The same engine runs in the desktop app (over HTTPS, account.cjs) and in a web
// runtime (over its Unix socket, remote-vault.cjs). A round pulls what changed on the server and applies it here, then
// pushes what changed here. A change is found by the hash of a record's data against the hash last synced
// (sync-state.json). The server keeps the version it gets last.
const crypto=require('node:crypto');
const path=require('node:path');
const {readJson,atomicJson}=require('./store.cjs');
const hash=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0,32);
const TRANSCRIPT_LIMIT=1000*1024,PUSH_SIZE=500;
// Interface settings that follow the user. Everything else in Settings belongs to one computer.
const SETTINGS=['sendKey','tips','notifyReplies','notifyApprovals','notifyJobs','notifySound','chatOpens','consoleOpens'];
const pick=(o,keys)=>Object.fromEntries(keys.filter(k=>o?.[k]!==undefined).map(k=>[k,o[k]]));
// A record that cannot be applied now (an active turn, a machine not there yet): the round stops and tries again.
class Later extends Error{}
// Trust decisions stay on each computer: iTrust is not synced, and a synced executable waits for trust on first use.
const LOCAL_ONLY=['itrust','trustPending'];
const publicEndpoint=e=>{try{const u=new URL(e);return u.protocol==='https:'&&!['127.0.0.1','localhost','[::1]'].includes(u.hostname);}catch{return false;}};
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
  if(kinds.has('host'))for(const h of d.hosts||[])if(h.hostname){hosts.add(h.id);add('host',h.id,{name:h.name,hostname:h.hostname,username:h.username||'',port:h.port||22});}
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
  if(r.kind==='host'){const existing=d.hosts.find(h=>h.id===r.id);await broker.saveHost({...(existing||{}),id:r.id,name:x.name,hostname:x.hostname,username:x.username,port:x.port},{sync:true});return;}
  if(r.kind==='agent'){
    if(broker.turns.has(r.id))throw new Later();
    if(x.transport==='ssh'&&!d.hosts.some(h=>h.id===x.hostId))throw new Later();
    const existing=d.agents.find(a=>a.id===r.id),incoming=Object.fromEntries(Object.entries(x).filter(([k])=>!LOCAL_ONLY.includes(k)));
    const changed=x.protocol!=='openai'&&(!existing||existing.command!==x.command||JSON.stringify(existing.args)!==JSON.stringify(x.args)||existing.hermesHome!==x.hermesHome);
    await broker.saveAgent({agent:{...(existing||{}),...incoming,id:r.id,...(changed||existing?.trustPending?{trustPending:true}:{})}},{preapproved:true});return;
  }
  if(r.kind==='conversation'){
    if(!d.agents.some(a=>a.id===x.agentId))throw new Later();
    const c=d.conversations.find(c=>c.id===r.id);
    if(c)Object.assign(c,{title:x.title,externalSessionId:x.externalSessionId||c.externalSessionId||''});
    else{if(d.conversations.length>=2000)return;d.conversations.push({id:r.id,agentId:x.agentId,title:String(x.title||'Chat').slice(0,120),createdAt:x.createdAt||new Date().toISOString(),externalSessionId:x.externalSessionId||''});}
    await broker.persist();return;
  }
  if(r.kind==='transcript'){
    const c=d.conversations.find(c=>c.id===r.id);if(!c)throw new Later();
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
  async load(){const s=await readJson(this.file,null).catch(()=>null);this.state=s&&s.account===this.account&&s.hashes&&typeof s.hashes==='object'?s:{account:this.account,rev:0,hashes:{}};}
  save(){return atomicJson(this.file,this.state);}
  ctx(){return {broker:this.broker,opaya:this.opaya,vault:this.vault};}
  round(){if(!this.running)this.running=this.run().finally(()=>{this.running=null;});return this.running;}
  async run(){
    try{
      // Pull first: apply what changed on the server, in change order.
      let since=this.state.rev,more=true,stopped=false;
      while(more&&!stopped){
        const page=await this.transport.pull(since);
        if(page.reset){this.state.hashes={};}
        for(const r of page.records||[]){
          const key=`${r.kind}:${r.id}`;
          if(!this.accepts.has(r.kind)){since=r.rev;continue;}
          try{
            if(r.deleted){await remove(this.ctx(),r.kind,r.id);delete this.state.hashes[key];}
            else if(this.state.hashes[key]!==hash(r.data)){await apply(this.ctx(),r);this.state.hashes[key]=hash(r.data);}
          }catch(error){if(error instanceof Later){stopped=true;break;}this.log(`Sync could not apply ${key}: ${error.message}`);}
          since=r.rev;
        }
        if(!stopped&&!page.records?.length)since=Math.max(since,page.rev||0);
        more=!!page.more;
      }
      this.state.rev=since;
      // The local versions of what was just applied are the synced ones (the schema may normalize them).
      const local=await collect({...this.ctx(),kinds:this.sends,known:this.state.hashes});
      // Then push what changed here.
      const changes=[];
      for(const [key,r] of local){if(r.unchanged)continue;const h=hash(r.data);if(this.state.hashes[key]!==h)changes.push({...r,hash:h,key});}
      for(const key of Object.keys(this.state.hashes)){const [kind,id]=key.split(':');if(this.sends.has(kind)&&!local.has(key))changes.push({kind,id,deleted:true,key});}
      for(let i=0;i<changes.length;i+=PUSH_SIZE){
        const chunk=changes.slice(i,i+PUSH_SIZE);
        // A secret's value goes first, by its own call; records carry no values.
        for(const c of chunk)if(c.kind==='secret'&&this.transport.secret)await this.transport.secret(c.id,c.deleted?null:this.vault.get(c.id)||null);
        await this.transport.push(chunk.map(({kind,id,deleted,data})=>deleted?{kind,id,deleted:true}:{kind,id,data}));
        for(const c of chunk){if(c.deleted)delete this.state.hashes[c.key];else this.state.hashes[c.key]=c.hash;}
      }
      this.error='';this.lastRound=Date.now();await this.save();
      return {pulled:this.state.rev,pushed:changes.length};
    }catch(error){this.error=String(error?.message||error).slice(0,300);await this.save().catch(()=>{});throw error;}
  }
  // A local change: a round 5 seconds later (one round for many quick changes).
  touch(){if(!this.timer)return;clearTimeout(this.soon);this.soon=setTimeout(()=>this.round().catch(()=>{}),5000);this.soon.unref?.();}
  start(){if(this.timer)return;this.round().catch(()=>{});this.timer=setInterval(()=>this.round().catch(()=>{}),60000);this.timer.unref?.();}
  stop(){clearInterval(this.timer);clearTimeout(this.soon);this.timer=null;this.soon=null;}
  describe(){return {on:!!this.timer,lastRound:this.lastRound,error:this.error};}
}
module.exports={Sync,collect,apply,remove,mergeMessages,transcriptData,Later,SETTINGS};
