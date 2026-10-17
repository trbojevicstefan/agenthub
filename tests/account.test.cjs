'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const crypto=require('node:crypto');const path=require('node:path');const fs=require('node:fs/promises');
const {temp,secure}=require('./helpers.cjs');
const {Account,verify,accountUrl,hostLimitError,TOKEN_KEY}=require('../desktop/account.cjs');
const {Vault,Store}=require('../desktop/store.cjs');
const {Broker}=require('../desktop/broker.cjs');
const SERVER='https://app.opaya.dev',DAY=24*60*60*1000;
// A signing key like the server's (web/src/entitlements.ts) and tokens signed with it.
function keyPair(kid='k1'){const {privateKey,publicKey}=crypto.generateKeyPairSync('ed25519');return {kid,privateKey,jwk:{...publicKey.export({format:'jwk'}),kid}};}
function sign(key,claims,{now=Date.now(),days=14,typ='opaya-entitlements+jwt'}={}){
  const iat=Math.floor(now/1000),h=Buffer.from(JSON.stringify({alg:'EdDSA',kid:key.kid,typ})).toString('base64url');
  const p=Buffer.from(JSON.stringify({iss:SERVER,aud:'opaya-desktop',sub:'u1',org:'o1',iat,exp:iat+days*86400,plan:'pro',status:'active',trialEnd:null,limits:{hosts:5},features:{web:true,sync:true},...claims})).toString('base64url');
  return `${h}.${p}.${crypto.sign(null,Buffer.from(`${h}.${p}`),key.privateKey).toString('base64url')}`;
}
async function vault(t){const root=await temp(t),v=new Vault(root,secure());await v.load();return {root,vault:v};}
// The server side of the device flow and the entitlements, as answers to fetch.
function server({key,plan={},approveAfter=1,deny=false,status=200,now=()=>Date.now()}={}){
  const calls=[];let polls=0;
  const json=(body,code=200)=>({ok:code<400,status:code,json:async()=>body});
  const fetchImpl=async(url,init={})=>{
    const u=new URL(url);calls.push({path:u.pathname,init});
    if(u.pathname==='/api/auth/device/code')return json({device_code:'dev-code',user_code:'ABCD2345',verification_uri:`${SERVER}/device`,verification_uri_complete:`${SERVER}/device?user_code=ABCD2345`,expires_in:900,interval:5});
    if(u.pathname==='/api/auth/device/token'){polls++;if(deny)return json({error:'access_denied'},400);return polls<=approveAfter?json({error:'authorization_pending'},400):json({access_token:'session-token-123',token_type:'Bearer'});}
    if(u.pathname==='/api/entitlements'){if(status!==200)return json({code:'UNAUTHORIZED'},status);return json({token:sign(key,plan,{now:now()}),account:{email:'ana@example.com',name:'Ana'}});}
    if(u.pathname==='/.well-known/jwks.json')return json({keys:[key.jwk]});
    if(u.pathname==='/api/auth/sign-out')return json({success:true});
    return json({},404);
  };
  return {fetchImpl,calls};
}

test('entitlement tokens are checked offline: signature, key, audience, issuer and expiry',()=>{
  const key=keyPair(),other=keyPair('k1'),now=Date.now();
  const token=sign(key,{});
  assert.equal(verify(token,[key.jwk],{issuer:SERVER,now}).limits.hosts,5);
  const [h,p,s]=token.split('.'),changed=Buffer.from(JSON.stringify({...JSON.parse(Buffer.from(p,'base64url')),limits:{hosts:500}})).toString('base64url');
  assert.throws(()=>verify(`${h}.${changed}.${s}`,[key.jwk],{issuer:SERVER,now}),/signature/);
  assert.throws(()=>verify(sign(other,{}),[key.jwk],{issuer:SERVER,now}),/signature/,'same kid, other key');
  assert.throws(()=>verify(token,[keyPair('k2').jwk],{issuer:SERVER,now}),/Unknown entitlement key/);
  assert.throws(()=>verify(sign(key,{aud:'someone-else'}),[key.jwk],{issuer:SERVER,now}),/another app/);
  assert.throws(()=>verify(token,[key.jwk],{issuer:'https://evil.example',now}),/another server/);
  assert.throws(()=>verify(token,[key.jwk],{issuer:SERVER,now:now+15*DAY}),/expired/);
  assert.throws(()=>verify(sign(key,{},{typ:'JWT'}),[key.jwk],{issuer:SERVER,now}),/type/);
  assert.throws(()=>verify('nonsense',[key.jwk]),/Not an entitlement token/);
});

test('without an account URL nothing is limited and the window sees no account',async t=>{
  const {root,vault:v}=await vault(t),a=new Account({root,vault:v,baseUrl:''});await a.load();
  assert.deepEqual(a.state(),{enabled:false});assert.equal(a.hostLimit(),Infinity);
  await assert.rejects(a.signIn(),/not available/);
  assert.equal(accountUrl({OPAYA_ACCOUNT_URL:'http://app.opaya.dev'}),'','plain http only for this computer');
  assert.equal(accountUrl({OPAYA_ACCOUNT_URL:'http://localhost:3000/'}),'http://localhost:3000');
  assert.equal(accountUrl({OPAYA_ACCOUNT_URL:'https://app.opaya.dev/'}),'https://app.opaya.dev');
});

test('sign-in with the device flow keeps the token in the Vault and the plan in account.json, never in the window state',async t=>{
  const {root,vault:v}=await vault(t),key=keyPair(),{fetchImpl,calls}=server({key,plan:{plan:'pro',status:'trialing',trialEnd:Math.floor(Date.now()/1000)+10*86400}}),opened=[],states=[];
  const a=new Account({root,vault:v,baseUrl:SERVER,fetchImpl,openExternal:async url=>opened.push(url),emit:s=>states.push(s),keys:[key.jwk],sleep:async()=>{},version:'0.36.0',name:"Ana's MacBook"});await a.load();
  assert.equal(a.hostLimit(),1,'signed out: Free');
  const started=await a.signIn();
  assert.equal(started.pending.userCode,'ABCD2345');assert.deepEqual(opened,[`${SERVER}/device?user_code=ABCD2345`]);
  assert.equal(calls[0].init.headers['X-Opaya-Device'],"Ana's MacBook");assert.match(calls[0].init.headers['User-Agent'],/^Opaya\/0\.36\.0/);
  assert.equal(JSON.parse(calls[0].init.body).client_id,'opaya-desktop');
  await a.polling;
  assert.equal(v.get(TOKEN_KEY),'session-token-123');
  const s=a.state();
  assert.equal(s.signedIn,true);assert.equal(s.email,'ana@example.com');assert.equal(s.plan,'pro');assert.equal(s.status,'trialing');assert.equal(s.limits.hosts,5);assert.equal(s.features.web,true);assert.ok(s.trialEnd>Date.now());
  const shown=JSON.stringify([s,...states]);assert.ok(!shown.includes('session-token-123'),'no session token in the window state');assert.ok(!shown.includes('eyJ'),'no entitlement token in the window state');
  assert.equal(calls.find(c=>c.path==='/api/entitlements').init.headers.Authorization,'Bearer session-token-123');
  const saved=JSON.parse(await fs.readFile(path.join(root,'account.json'),'utf8'));assert.ok(saved.token&&!JSON.stringify(saved).includes('session-token-123'));
  // A new start reads the saved plan without the network.
  const again=new Account({root,vault:v,baseUrl:SERVER,fetchImpl:async()=>{throw new Error('offline');},keys:[key.jwk]});await again.load();
  assert.equal(again.hostLimit(),5);
  await a.signOut();
  assert.equal(v.has(TOKEN_KEY),false);assert.equal(a.state().signedIn,false);assert.equal(a.hostLimit(),1);
  const out=calls.find(c=>c.path==='/api/auth/sign-out');assert.equal(out.init.headers.Authorization,'Bearer session-token-123');
});

test('offline for 13 days keeps the paid limits; on day 15 the Free limits apply',async t=>{
  const {root,vault:v}=await vault(t),key=keyPair(),start=Date.now();let now=start;
  const {fetchImpl}=server({key,plan:{plan:'fleet',limits:{hosts:20}},approveAfter:0,now:()=>now});
  let offline=false;const a=new Account({root,vault:v,baseUrl:SERVER,fetchImpl:(...x)=>offline?Promise.reject(new Error('down')):fetchImpl(...x),keys:[key.jwk],sleep:async()=>{},now:()=>now});await a.load();
  await a.signIn();await a.polling;assert.equal(a.hostLimit(),20);
  offline=true;now=start+13*DAY;
  await assert.rejects(a.refresh(),/Cannot reach/);assert.equal(a.hostLimit(),20);assert.equal(a.state().expired,false);
  now=start+15*DAY;assert.equal(a.hostLimit(),1);assert.equal(a.state().expired,true);assert.equal(a.state().signedIn,true);
  offline=false;await a.refresh();assert.equal(a.hostLimit(),20,'back online: a new token');
});

test('a denied sign-in stores nothing; an ended session signs out; a new server key is fetched',async t=>{
  const {root,vault:v}=await vault(t),key=keyPair('new-key');
  const denied=new Account({root,vault:v,baseUrl:SERVER,fetchImpl:server({key,deny:true}).fetchImpl,keys:[],sleep:async()=>{}});await denied.load();
  await denied.signIn();await denied.polling;
  assert.equal(v.has(TOKEN_KEY),false);assert.match(denied.state().error,/denied/);
  // The build knows no key: the server's JWKS is fetched and kept.
  const {fetchImpl,calls}=server({key,approveAfter:0});const a=new Account({root,vault:v,baseUrl:SERVER,fetchImpl,keys:[],sleep:async()=>{}});await a.load();
  await a.signIn();await a.polling;
  assert.ok(calls.some(c=>c.path==='/.well-known/jwks.json'));assert.equal(a.hostLimit(),5);
  const ended=new Account({root,vault:v,baseUrl:SERVER,fetchImpl:server({key,status:401}).fetchImpl,keys:[key.jwk]});await ended.load();
  await ended.refresh();assert.equal(v.has(TOKEN_KEY),false);assert.match(ended.state().error,/Sign in again/);
});

test('plan pages open in the browser; the sign-in address must be on the account server',async t=>{
  const {root,vault:v}=await vault(t),opened=[];
  const a=new Account({root,vault:v,baseUrl:SERVER,openExternal:async u=>opened.push(u),fetchImpl:async()=>({ok:true,status:200,json:async()=>({device_code:'d',user_code:'U',verification_uri_complete:'https://evil.example/device'})})});await a.load();
  await a.open('billing');await a.open('pricing');assert.deepEqual(opened,[`${SERVER}/billing`,`${SERVER}/pricing`]);
  await assert.rejects(a.open('../admin'),/Unknown/);
  await assert.rejects(a.signIn(),/unexpected sign-in address/);assert.equal(opened.length,2);
});

test('the host limit blocks only new machines: saved ones stay and can be edited',async t=>{
  const root=await temp(t);const broker=new Broker({store:new Store(root),vault:new Vault(root,secure()),emit:()=>{},approve:async()=>true});await broker.init();
  const host=n=>({name:`vps-${n}`,hostname:`10.0.0.${n}`,username:'root',port:22});
  for(const n of [1,2,3])await broker.saveHost(host(n));
  broker.hostLimit=()=>1;
  await assert.rejects(broker.saveHost(host(4)),/^Error: Your plan allows 1 remote machine, and 3 are saved\./);
  assert.equal(broker.data.hosts.length,3);
  const first=broker.data.hosts[0];await broker.saveHost({...first,name:'renamed'});assert.equal(broker.data.hosts[0].name,'renamed');
  broker.hostLimit=()=>5;await broker.saveHost(host(4));assert.equal(broker.data.hosts.length,4);
  assert.equal(hostLimitError(20,1).message.startsWith('Your plan allows 20 remote machines, and 1 is saved.'),true);
});
