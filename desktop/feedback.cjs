'use strict';
// Feedback and error reports, so Opaya gets better from what people run into. Feedback is sent when the user sends it.
// Errors are collected only when the user turns on "Share errors" (off by default): each is cleaned of secrets, home
// folders, user names, machine names and addresses, grouped by a fingerprint (the same error counts up instead of
// repeating) and sent at most once an hour per fingerprint. Everything waits in an outbox file until Opaya's collector
// (collector/ in this repository) accepts it, so nothing is lost offline.
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {createHash,randomUUID}=require('node:crypto');
const secrets=require('./secrets.cjs');

const MAX_OUTBOX=500,MAX_TEXT=4000,GROUP_MS=60*60*1000;
const KINDS=['bug','idea','praise','other'];

// Text with nothing that identifies the user or their machines: keys and tokens, the home folder, the user name,
// e-mail addresses, IP addresses and the names of their saved machines.
function scrub(text,{held=[],home=os.homedir(),user=safeUser(),names=[]}={}){
  let t=secrets.shieldOutput(String(text??''),held);
  const swap=(value,to)=>{if(value&&value.length>2)t=t.split(value).join(to);};
  swap(home,'~');swap(home.replace(/\\/g,'/'),'~');
  for(const n of names)swap(String(n||''),'<machine>');
  if(user&&user.length>2)t=t.replace(new RegExp(`\\b${user.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\b`,'gi'),'<user>');
  t=t.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g,'<email>')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g,'<ip>')
    .replace(/\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b/gi,'<ip>')
    .replace(/\b(Bearer|token|apikey|api_key|password|secret)(["'\s:=]+)[^\s"',;]{6,}/gi,'$1$2<hidden>');
  return t.slice(0,MAX_TEXT);
}
function safeUser(){try{return os.userInfo().username||'';}catch{return '';}}
// The same error from any place: numbers, ids, paths and quoted names do not change its fingerprint.
function fingerprint(source,message){
  const norm=String(message||'').toLowerCase().replace(/"[^"]*"|'[^']*'/g,'""').replace(/[a-f0-9]{8,}/g,'#').replace(/\d+/g,'#').replace(/(~|[a-z]:)?[\\/][^\s]*/g,'/p').replace(/\s+/g,' ').trim().slice(0,300);
  return createHash('sha256').update(`${source}|${norm}`).digest('hex').slice(0,16);
}

class Feedback{
  constructor({root,version='',endpoint='',settings=()=>({}),held=()=>[],machines=()=>[],fetchImpl=globalThis.fetch,platform=process.platform,arch=process.arch}){
    this.dir=path.join(root,'feedback');this.file=path.join(this.dir,'outbox.json');this.version=version;this.endpoint=endpoint;
    this.settings=settings;this.held=held;this.machines=machines;this.fetch=fetchImpl;this.platform=platform;this.arch=arch;
    this.outbox=[];this.groups=new Map();this.sent=[];this.installId='';this.flushing=null;this.lastError='';
  }
  async init(){
    await fs.mkdir(this.dir,{recursive:true});
    try{const d=JSON.parse(await fs.readFile(this.file,'utf8'));this.outbox=Array.isArray(d.outbox)?d.outbox.slice(-MAX_OUTBOX):[];this.sent=Array.isArray(d.sent)?d.sent.slice(-50):[];this.installId=String(d.installId||'');}catch{}
    if(!/^[0-9a-f-]{36}$/.test(this.installId))this.installId=randomUUID();
    await this.save();
  }
  url(){return String(this.settings().feedbackUrl||this.endpoint||'').trim();}
  sharing(){return this.settings().shareErrors===true;}
  async save(){const tmp=`${this.file}.tmp`;await fs.writeFile(tmp,JSON.stringify({installId:this.installId,outbox:this.outbox,sent:this.sent}),'utf8');await fs.rename(tmp,this.file);}
  context(){return {app:this.version,os:this.platform,arch:this.arch,osRelease:os.release(),install:this.installId};}
  clean(text){return scrub(text,{held:this.held(),names:this.machines()});}
  // What the user wrote. Diagnostics (the last errors, already cleaned) only when they tick it.
  async submit({message,kind='other',contact='',diagnostics=false,where=''}={}){
    const text=String(message||'').trim();if(text.length<3)throw new Error('Write a few words first.');if(text.length>MAX_TEXT)throw new Error('That is longer than 4,000 characters.');
    const item={type:'feedback',id:randomUUID(),at:new Date().toISOString(),kind:KINDS.includes(kind)?kind:'other',message:this.clean(text),
      contact:String(contact||'').trim().slice(0,200),where:String(where||'').slice(0,80),...this.context(),
      ...(diagnostics?{recentErrors:this.recent().slice(0,15)}:{})};
    await this.queue(item);
    const sent=await this.flush();
    return {id:item.id,sent:sent.includes(item.id),queued:!sent.includes(item.id),configured:!!this.url()};
  }
  // An error in Opaya: kept only when sharing is on; the same fingerprint within an hour counts up.
  async record({source='app',title='',message='',context=''}={}){
    if(!this.sharing())return false;
    const msg=String(message||'').trim();if(!msg)return false;
    if(/cancel|declined|not approved|stopped by the user/i.test(msg))return false;
    const fp=fingerprint(source,`${title} ${msg}`),now=Date.now(),g=this.groups.get(fp);
    if(g&&now-g.first<GROUP_MS){g.count++;g.last=now;const pending=this.outbox.find(x=>x.fingerprint===fp&&x.type==='error');if(pending){pending.count=g.count;pending.lastAt=new Date(now).toISOString();await this.save();}return true;}
    this.groups.set(fp,{first:now,last:now,count:1});
    const item={type:'error',id:randomUUID(),at:new Date(now).toISOString(),lastAt:new Date(now).toISOString(),count:1,fingerprint:fp,source:String(source).slice(0,40),
      title:this.clean(title).slice(0,200),message:this.clean(msg),context:this.clean(context).slice(0,2000),...this.context()};
    await this.queue(item);this.later();return true;
  }
  recent(){return [...this.outbox,...this.sent].filter(x=>x.type==='error').slice(-30).reverse().map(({source,title,message,count,at})=>({source,title,message,count,at}));}
  async queue(item){this.outbox.push(item);if(this.outbox.length>MAX_OUTBOX)this.outbox.splice(0,this.outbox.length-MAX_OUTBOX);await this.save();}
  later(){if(this.timer)return;this.timer=setTimeout(()=>{this.timer=null;this.flush().catch(()=>{});},30*1000);this.timer.unref?.();}
  // Sends what waits, oldest first, in batches; keeps what the collector did not take. Returns the ids sent.
  flush(){
    if(this.flushing)return this.flushing;
    this.flushing=(async()=>{
      const url=this.url(),done=[];if(!url||!this.outbox.length||!this.fetch)return done;
      while(this.outbox.length){
        const batch=this.outbox.slice(0,20);
        try{
          const r=await this.fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({items:batch}),signal:AbortSignal.timeout(20000)});
          if(!r.ok)throw new Error(`The feedback service answered ${r.status}.`);
        }catch(e){this.lastError=String(e?.message||e).slice(0,200);break;}
        this.lastError='';
        const ids=new Set(batch.map(x=>x.id));this.outbox=this.outbox.filter(x=>!ids.has(x.id));
        this.sent.push(...batch.map(x=>({...x,sentAt:new Date().toISOString()})));this.sent=this.sent.slice(-50);done.push(...ids);
        await this.save();
      }
      return done;
    })().finally(()=>{this.flushing=null;});
    return this.flushing;
  }
  describe(){return {configured:!!this.url(),sharing:this.sharing(),waiting:this.outbox.length,lastError:this.lastError,
    recent:[...this.outbox.map(x=>({...x,state:'waiting'})),...this.sent.map(x=>({...x,state:'sent'}))].slice(-25).reverse()
      .map(({type,kind,title,message,count,at,state,source})=>({type,kind,title,message:String(message||'').slice(0,400),count,at,state,source}))};}
  async clear(){this.outbox=this.outbox.filter(x=>x.type==='feedback');this.sent=[];this.groups.clear();await this.save();return true;}
}
module.exports={Feedback,scrub,fingerprint,KINDS};
