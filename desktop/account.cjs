'use strict';
// The optional Opaya account (app.opaya.dev). The desktop app never creates accounts and never sells plans: Sign in uses
// the device flow (RFC 8628) and opens the approval page in the system browser; Manage plan and Upgrade open the web
// pages. The session token stays in the Vault (opaya_account_token) and never reaches the window. The plan comes as a
// signed entitlement token (EdDSA), checked here offline against the keys in account-keys.json and the server's JWKS, so
// the limits hold for 14 days without a connection. An expired token gives the Free limits; saved machines keep working
// and only new ones are blocked. With no account URL (OPAYA_ACCOUNT_URL, or package.json opayaAccountUrl), accounts are
// off and nothing is limited, as before accounts existed.
const crypto=require('node:crypto');
const os=require('node:os');
const path=require('node:path');
const {readJson,atomicJson}=require('./store.cjs');
const TOKEN_KEY='opaya_account_token',CLIENT_ID='opaya-desktop',AUDIENCE='opaya-desktop',TOKEN_TYPE='opaya-entitlements+jwt';
const DAY=24*60*60*1000;
const FREE={plan:'free',status:'free',trialEnd:null,limits:{hosts:1},features:{web:false,sync:false}};
const PLAN_TITLES={free:'Free',pro:'Pro',fleet:'Fleet',team:'Team'};
function accountUrl(env=process.env){
  const raw=String(env.OPAYA_ACCOUNT_URL||require('../package.json').opayaAccountUrl||'').trim().replace(/\/+$/,'');if(!raw)return '';
  let u;try{u=new URL(raw);}catch{return '';}
  // https only, except a server on this computer for development.
  if(u.protocol!=='https:'&&!(u.protocol==='http:'&&['localhost','127.0.0.1'].includes(u.hostname)))return '';
  return u.origin;
}
const b64=s=>Buffer.from(String(s),'base64url');
// An entitlement token, checked with node:crypto: EdDSA over Ed25519, a known key ID, our audience and issuer, not
// expired. Returns the payload or throws.
function verify(token,keys,{issuer,now=Date.now()}={}){
  const parts=String(token||'').split('.');if(parts.length!==3)throw new Error('Not an entitlement token.');
  let header,payload;try{header=JSON.parse(b64(parts[0]));payload=JSON.parse(b64(parts[1]));}catch{throw new Error('Not an entitlement token.');}
  if(header.alg!=='EdDSA'||header.typ!==TOKEN_TYPE)throw new Error('Unexpected entitlement token type.');
  const jwk=(keys||[]).find(k=>k&&k.kid===header.kid&&k.kty==='OKP'&&k.crv==='Ed25519'&&typeof k.x==='string');if(!jwk)throw new Error('Unknown entitlement key.');
  const key=crypto.createPublicKey({key:{kty:'OKP',crv:'Ed25519',x:jwk.x},format:'jwk'});
  if(!crypto.verify(null,Buffer.from(`${parts[0]}.${parts[1]}`),key,b64(parts[2])))throw new Error('The entitlement signature does not match.');
  if(![].concat(payload.aud).includes(AUDIENCE))throw new Error('The entitlement token is for another app.');
  if(issuer&&payload.iss!==issuer)throw new Error('The entitlement token is from another server.');
  if(!Number.isFinite(payload.exp)||payload.exp*1000<=now)throw new Error('The entitlement token expired.');
  return payload;
}
const deviceName=()=>String(os.hostname()||'').replace(/\.local$/i,'').replace(/[^\p{L}\p{N} ._'()-]/gu,'').trim().slice(0,60)||'This computer';
class Account{
  constructor({root,vault,baseUrl=accountUrl(),fetchImpl=globalThis.fetch,openExternal=async()=>{},emit=()=>{},keys=require('./account-keys.json').keys||[],now=()=>Date.now(),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms).unref?.()),version='',platform=process.platform,arch=process.arch,name=deviceName()}){
    Object.assign(this,{root,vault,baseUrl,fetch:fetchImpl,openExternal,emit,embedded:keys,now,sleep,version,platform,arch,name});
    this.file=path.join(root,'account.json');this.data={};this.pending=null;this.error='';this.timer=null;this.polling=null;
  }
  get enabled(){return !!this.baseUrl;}
  signedIn(){return this.enabled&&this.vault.has(TOKEN_KEY);}
  async load(){this.data=await readJson(this.file,{}).catch(()=>({}));if(this.data.issuer&&this.data.issuer!==this.baseUrl)this.data={};}
  async persist(){await atomicJson(this.file,this.data);}
  keys(){return [...this.embedded,...(this.data.jwks||[])];}
  // The verified entitlements, or null when there are none or they expired.
  entitlements(){
    if(!this.data.token)return null;
    try{return verify(this.data.token,this.keys(),{issuer:this.baseUrl,now:this.now()});}catch{return null;}
  }
  limits(){
    if(!this.enabled)return {hosts:Infinity,web:true,sync:true};
    const e=this.signedIn()?this.entitlements():null,p=e||FREE;
    return {hosts:Number.isInteger(p.limits?.hosts)&&p.limits.hosts>=0?p.limits.hosts:FREE.limits.hosts,web:!!p.features?.web,sync:!!p.features?.sync};
  }
  hostLimit(){return this.limits().hosts;}
  // What the window shows. No token, no entitlement token.
  state(){
    if(!this.enabled)return {enabled:false};
    const signedIn=this.signedIn(),e=signedIn?this.entitlements():null,p=e||FREE,limits=this.limits();
    return {enabled:true,server:this.baseUrl,signedIn,email:signedIn?this.data.email||'':'',name:signedIn?this.data.name||'':'',plan:p.plan,planTitle:PLAN_TITLES[p.plan]||p.plan,status:p.status,trialEnd:p.trialEnd?p.trialEnd*1000:null,
      limits:{hosts:limits.hosts},features:{web:limits.web,sync:limits.sync},checkedAt:signedIn?this.data.checkedAt||0:0,expiresAt:e?e.exp*1000:0,expired:signedIn&&!e&&!!this.data.token,
      pending:this.pending?{userCode:this.pending.userCode,url:this.pending.url,expiresAt:this.pending.expiresAt}:null,error:this.error};
  }
  changed(){this.emit(this.state());}
  async call(pathname,{method='GET',body,token}={}){
    if(!this.enabled)throw new Error('Opaya accounts are not available in this build.');
    const headers={'User-Agent':`Opaya/${this.version||'desktop'} (${this.platform}; ${this.arch})`,Accept:'application/json'};
    if(body!==undefined)headers['Content-Type']='application/json';
    if(token)headers.Authorization=`Bearer ${token}`;
    if(pathname==='/api/auth/device/code')headers['X-Opaya-Device']=this.name;
    let response;
    try{response=await this.fetch(this.baseUrl+pathname,{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000),redirect:'error'});}
    catch{const e=new Error(`Cannot reach ${new URL(this.baseUrl).host}. Check the internet connection.`);e.offline=true;throw e;}
    const data=await response.json().catch(()=>null);
    return {ok:response.ok,status:response.status,data};
  }
  // Sign in: a device code, the approval page in the browser, then polling until the user approves or denies.
  async signIn(){
    if(this.signedIn())return this.state();
    this.cancelSignIn();this.error='';
    const r=await this.call('/api/auth/device/code',{method:'POST',body:{client_id:CLIENT_ID}});
    if(!r.ok||!r.data?.device_code)throw new Error(r.status===429?'Too many sign-in attempts. Wait a minute and try again.':'The sign-in did not start. Try again.');
    const d=r.data,url=String(d.verification_uri_complete||d.verification_uri||'');
    if(!url.startsWith(this.baseUrl+'/'))throw new Error('The server sent an unexpected sign-in address.');
    this.pending={deviceCode:d.device_code,userCode:String(d.user_code||''),url,interval:Math.max(5,Number(d.interval)||5),expiresAt:this.now()+Math.min(Number(d.expires_in)||900,1800)*1000};
    this.changed();
    await this.openExternal(url).catch(()=>{});
    this.polling=this.poll(this.pending).catch(()=>{});
    return this.state();
  }
  cancelSignIn(){if(this.pending){this.pending.cancelled=true;this.pending=null;this.changed();}return true;}
  async poll(p){
    while(!p.cancelled&&this.pending===p){
      await this.sleep(p.interval*1000);if(p.cancelled||this.pending!==p)return;
      if(this.now()>p.expiresAt){this.pending=null;this.error='The sign-in code expired. Click Sign in to start again.';this.changed();return;}
      let r;try{r=await this.call('/api/auth/device/token',{method:'POST',body:{grant_type:'urn:ietf:params:oauth:grant-type:device_code',device_code:p.deviceCode,client_id:CLIENT_ID}});}catch{continue;}
      if(p.cancelled||this.pending!==p)return;
      if(r.ok&&r.data?.access_token){
        await this.vault.set(TOKEN_KEY,String(r.data.access_token),this.vault.available());
        this.pending=null;this.data={issuer:this.baseUrl};await this.refresh().catch(()=>{});this.changed();return;
      }
      const code=r.data?.error;
      if(code==='authorization_pending')continue;
      if(code==='slow_down'){p.interval+=5;continue;}
      this.pending=null;this.error=code==='access_denied'?'The sign-in was denied in the browser.':code==='expired_token'?'The sign-in code expired. Click Sign in to start again.':'The sign-in did not finish. Try again.';this.changed();return;
    }
  }
  // New entitlements from the server: at start, every 24 hours, and after sign-in. Offline, the saved ones stay.
  async refresh(){
    if(!this.signedIn())return this.state();
    const token=this.vault.get(TOKEN_KEY);
    const r=await this.call('/api/entitlements',{token});
    if(r.status===401){await this.forget('Your sign-in ended. Sign in again.');return this.state();}
    if(!r.ok||!r.data?.token)throw new Error('The plan could not be checked. Opaya tries again later.');
    let payload;
    try{payload=verify(r.data.token,this.keys(),{issuer:this.baseUrl,now:this.now()});}
    catch{
      // A key this build does not have (a new key): get the server's public keys and check again.
      const j=await this.call('/.well-known/jwks.json');const jwks=Array.isArray(j.data?.keys)?j.data.keys.filter(k=>k&&k.kty==='OKP'&&k.crv==='Ed25519'&&typeof k.x==='string'&&typeof k.kid==='string').map(({kty,crv,x,kid})=>({kty,crv,x,kid})).slice(0,5):[];
      payload=verify(r.data.token,[...this.embedded,...jwks],{issuer:this.baseUrl,now:this.now()});this.data.jwks=jwks;
    }
    this.data={...this.data,issuer:this.baseUrl,token:r.data.token,email:String(r.data.account?.email||'').slice(0,200),name:String(r.data.account?.name||'').slice(0,200),checkedAt:this.now(),plan:payload.plan};
    this.error='';await this.persist();this.changed();return this.state();
  }
  async forget(error=''){
    await this.vault.remove(TOKEN_KEY).catch(()=>{});this.data={issuer:this.baseUrl};this.error=error;await this.persist().catch(()=>{});this.changed();
  }
  async signOut(){
    this.cancelSignIn();
    if(this.signedIn()){const token=this.vault.get(TOKEN_KEY);await this.call('/api/auth/sign-out',{method:'POST',body:{},token}).catch(()=>{});}
    await this.forget();return this.state();
  }
  // The public half of the web app's SSH key for this account, for "Allow web access" on a machine.
  async webSshKey(){
    if(!this.signedIn())throw new Error('Sign in to your Opaya account first (Settings > Account).');
    const r=await this.call('/api/web-ssh-key',{token:this.vault.get(TOKEN_KEY)});
    if(r.status===403)throw new Error('Web access comes with Pro and Fleet. Upgrade the plan in Settings > Account.');
    const key=String(r.data?.publicKey||''),comment=String(r.data?.comment||'');
    if(!r.ok||!/^ssh-ed25519 [A-Za-z0-9+/]+=* opaya-web [A-Za-z0-9_-]{1,80}$/.test(key)||!key.endsWith(' '+comment))throw new Error('The web SSH key could not be read. Try again.');
    return {publicKey:key,comment,address:String(r.data?.address||'').slice(0,64)};
  }
  // Sync with the web app over HTTPS (sync.cjs): pull and push records, and the values of keys marked "Sync to web".
  syncTransport(){
    const send=async(pathname,options)=>{
      if(!this.signedIn())throw new Error('Sign in to your Opaya account first.');
      const r=await this.call(pathname,{...options,token:this.vault.get(TOKEN_KEY)});
      if(r.status===401){await this.forget('Your sign-in ended. Sign in again.');throw new Error('Your sign-in ended.');}
      if(!r.ok)throw new Error(r.data?.message||`Sync failed (HTTP ${r.status}).`);
      return r.data;
    };
    return {
      pull:since=>send(`/api/sync?since=${Number(since)||0}`),
      push:records=>send('/api/sync',{method:'POST',body:{records}}),
      secret:(key,value)=>send('/api/sync/secrets',{method:'POST',body:{key,...(value?{value}:{})}})
    };
  }
  // Manage plan, Upgrade and the account page open in the system browser.
  async open(page){
    const target={billing:'/billing',pricing:'/pricing',account:'/account'}[page];if(!target)throw new Error('Unknown account page.');
    if(!this.enabled)throw new Error('Opaya accounts are not available in this build.');
    await this.openExternal(this.baseUrl+target);return true;
  }
  start(){
    if(!this.enabled||this.timer)return;
    const tick=()=>{if(this.signedIn())this.refresh().catch(()=>{});};
    tick();this.timer=setInterval(tick,DAY);this.timer.unref?.();
  }
  stop(){clearInterval(this.timer);this.timer=null;this.cancelSignIn();}
}
// Web access on a machine: the web SSH key line in ~/.ssh/authorized_keys, or removed. Lines are found by their comment
// (" opaya-web <organization ID>" at the end), so a new key replaces the old one and other keys stay as they are. The
// file is rewritten in place (cat >), so its owner and mode stay.
function webAccessScript({allow,publicKey,comment}){
  const q=require('./process.cjs').quote,keep=`awk -v c=${q(' '+comment)} 'substr($0,length($0)-length(c)+1)!=c' ~/.ssh/authorized_keys > ~/.ssh/.opaya-keys.$$`;
  return allow
    ?`umask 077; mkdir -p ~/.ssh && touch ~/.ssh/authorized_keys && ${keep} && printf '%s\n' ${q(publicKey)} >> ~/.ssh/.opaya-keys.$$ && cat ~/.ssh/.opaya-keys.$$ > ~/.ssh/authorized_keys; rm -f ~/.ssh/.opaya-keys.$$; echo OPAYA_DONE`
    :`if [ -f ~/.ssh/authorized_keys ]; then ${keep} && cat ~/.ssh/.opaya-keys.$$ > ~/.ssh/authorized_keys; rm -f ~/.ssh/.opaya-keys.$$; fi; echo OPAYA_DONE`;
}
// The host limit, as a message the window recognizes (it offers Sign in or Upgrade).
function hostLimitError(limit,count){return new Error(`Your plan allows ${limit} remote machine${limit===1?'':'s'}, and ${count} ${count===1?'is':'are'} saved. Machines that are saved keep working. To add more, upgrade the plan in Settings > Account.`);}
module.exports={Account,verify,accountUrl,hostLimitError,webAccessScript,TOKEN_KEY,FREE};
