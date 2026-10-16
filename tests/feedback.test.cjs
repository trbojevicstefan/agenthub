'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {Feedback,scrub,fingerprint}=require('../desktop/feedback.cjs');
const tmp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'opaya-fb-'));

test('errors are cleaned of keys, paths, names, addresses and e-mails before they leave',()=>{
  const home='/home/stefan',key='sk-proj-'+'a'.repeat(40);
  const t=scrub(`Failed with ${key} in /home/stefan/.hermes/.env on hostinger (10.0.0.12) for stefan@example.com, token=abcdef123456`,{home,user:'stefan',names:['hostinger']});
  for(const bad of [key,'/home/stefan','hostinger','10.0.0.12','stefan@example.com','abcdef123456'])assert(!t.includes(bad),bad);
  assert.match(t,/~\/\.hermes\/\.env/);assert.match(t,/<machine>/);assert.match(t,/<ip>/);
  assert.equal(fingerprint('a','Timed out after 30000 ms at /x/y'),fingerprint('a','Timed out after 45 ms at /z'));
  assert.notEqual(fingerprint('a','x failed'),fingerprint('b','x failed'));
});

test('feedback is sent; errors only when sharing is on, grouped, and kept until the collector takes them',async()=>{
  const settings={shareErrors:false},posts=[];let up=false;
  const fetchImpl=async(url,init)=>{posts.push(JSON.parse(init.body));return {ok:up,status:up?200:503};};
  const root=tmp(),fb=new Feedback({root,version:'1.2.3',endpoint:'https://collector.example/v1/report',settings:()=>settings,fetchImpl});await fb.init();
  assert.equal(await fb.record({source:'action',title:'Install',message:'boom'}),false,'nothing collected while sharing is off');
  settings.shareErrors=true;
  await fb.record({source:'action',title:'Install Hermes',message:'exit code 1 after 30 s'});
  await fb.record({source:'action',title:'Install Hermes',message:'exit code 1 after 45 s'});
  await fb.record({source:'action',title:'Cancelled',message:'Cancelled by the user (stopped by the user)'});
  assert.equal(fb.outbox.length,1);assert.equal(fb.outbox[0].count,2);assert.equal(fb.outbox[0].app,'1.2.3');
  const r=await fb.submit({message:'The wizard is great',kind:'praise',diagnostics:true});
  assert.equal(r.sent,false);assert.equal(r.queued,true);assert.equal(fb.outbox.length,2);
  const again=new Feedback({root,endpoint:'https://collector.example/v1/report',settings:()=>settings,fetchImpl});await again.init();
  assert.equal(again.outbox.length,2,'the outbox survives a restart');assert.equal(again.installId,fb.installId);
  up=true;const sent=await again.flush();assert.equal(sent.length,2);assert.equal(again.outbox.length,0);
  const last=posts.at(-1).items;assert.deepEqual(last.map(i=>i.type),['error','feedback']);assert.equal(last[1].recentErrors[0].count,2);
  assert.deepEqual(again.describe().recent.map(x=>x.state),['sent','sent']);
  await assert.rejects(()=>again.submit({message:'x'}),/few words/);
});

test('the collector files feedback and groups errors into GitHub issues',async()=>{
  const {handle,feedbackIssue}=await import('../collector/worker.mjs');
  const issues=[],comments=[],kv=new Map();
  const fetchImpl=async(url,init={})=>{
    const u=String(url),body=init.body?JSON.parse(init.body):null,ok=d=>({ok:true,status:200,json:async()=>d,text:async()=>''});
    assert.equal(init.headers.authorization,'Bearer t0k');
    if(u.includes('/search/issues')){const fp=decodeURIComponent(u).match(/\[err:(\w+)\]/)[1];const hit=issues.find(i=>i.title.includes(`[err:${fp}]`));return ok({items:hit?[hit]:[]});}
    if(/\/issues$/.test(u)&&init.method==='POST'){const n={number:issues.length+1,state:'open',...body};issues.push(n);return ok(n);}
    if(/\/issues\/\d+\/comments$/.test(u)){comments.push({n:Number(u.split('/').at(-2)),...body});return ok({});}
    if(/\/issues\/\d+$/.test(u)&&!init.method)return ok(issues[Number(u.split('/').pop())-1]);
    throw new Error('unexpected '+u);
  };
  const env={GITHUB_TOKEN:'t0k',GITHUB_REPO:'me/opaya-feedback',FINGERPRINTS:{get:async k=>kv.get(k)||null,put:async(k,v)=>{kv.set(k,v);}}};
  const post=items=>handle(new Request('https://c.example/v1/report',{method:'POST',body:JSON.stringify({items})}),env,{fetchImpl}).then(r=>r.json().then(j=>({status:r.status,...j})));
  const err={type:'error',id:'e1',fingerprint:'0123456789abcdef',source:'action',title:'Install Hermes',message:'exit code 1',count:1,app:'0.35.0',os:'win32',arch:'x64',at:'2026-10-16T00:00:00Z'};
  let r=await post([{type:'feedback',id:'f1',kind:'bug',message:'The update stops\nwhen it fails',contact:'me@x.io',app:'0.35.0',os:'darwin',arch:'arm64'},err]);
  assert.equal(r.status,200);assert.equal(issues.length,2);
  assert.equal(issues[0].title,'[bug] The update stops');assert.deepEqual(issues[0].labels,['feedback','bug','app:0.35.0']);
  assert.match(issues[1].title,/^\[err:0123456789abcdef\] action: Install Hermes/);
  r=await post([{...err,id:'e2',count:3}]);assert.equal(issues.length,2,'the same fingerprint gets a comment, not a new issue');assert.equal(comments.length,1);assert.match(comments[0].body,/Seen again 3×/);
  assert.equal((await post([{type:'nope'}])).status,400);
  assert.equal((await handle(new Request('https://c.example/v1/report',{method:'POST',body:'{}'}),{},{fetchImpl})).status,500);
  assert.match(feedbackIssue({message:'x'.repeat(10),kind:'weird'}).title,/^\[other\]/);
});
