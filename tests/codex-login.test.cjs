'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const http=require('node:http');const {spawn}=require('node:child_process');
const {CodexLogins,findAuthUrl,parseCallback,parseResponse,forwardScript}=require('../desktop/codex-login.cjs');
const {collect}=require('../desktop/process.cjs');
const posix=process.platform==='win32';
// What `codex login` showed on a VPS, cut into rows by the terminal's width.
const SCREEN=`  Welcome to Codex, OpenAI's command-line coding agent

  Finish signing in via your browser

  If the link doesn't open automatically, press c to copy it:

  https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_EMoamEEZ73f0CkXaXp7hrann&redirect_uri=http%3A%2F%2F127.0.0.1
%3A1455%2Fauth%2Fcallback&code_challenge=bi7uF2fQWPZ23MPoffSuNfVGXySSQXLHOHNsPWN2rWE&code_challenge_method=S256&state=U5vCptHyNIbWB8Wvm
U8DAehQ7VVn35DZ66GIXQIulds&scope=openid+profile+email+offline_access+api.connectors.read+api.connectors.invoke&id_token_add_organizatio
ns=true&codex_cli_simplified_flow=true&originator=codex-tui

  On a remote or headless machine? Press esc and choose Sign in with Device Code.`;
test('the sign-in link is read from the screen, across the rows it is cut into',()=>{
  const auth=findAuthUrl(SCREEN.split('\n'));
  assert.equal(auth.port,1455);assert.equal(auth.state,'U5vCptHyNIbWB8WvmU8DAehQ7VVn35DZ66GIXQIulds');assert.equal(auth.callbackPath,'/auth/callback');
  assert.match(auth.url,/originator=codex-tui$/);assert.equal(new URL(auth.url).searchParams.get('code_challenge_method'),'S256');
  assert.equal(findAuthUrl('no link here'),null);
  assert.equal(findAuthUrl('https://auth.openai.com/oauth/authorize?redirect_uri=https%3A%2F%2Fevil.example%2Fcb&state=x'),null,'only a callback to 127.0.0.1 here');
});
test('the address the browser ended on is checked before anything is sent',()=>{
  assert.deepEqual(parseCallback('  http://127.0.0.1:1455/auth/callback?code=ac_1&state=abc  '),{port:1455,path:'/auth/callback?code=ac_1&state=abc',state:'abc',code:true});
  assert.equal(parseCallback('http://127.0.0.1:1455/auth/callback?code=$(reboot)&state=a'),null,'shell characters never reach a command');
  assert.equal(parseCallback('https://example.com/auth/callback?code=1'),null);
  assert.throws(()=>forwardScript(1455,"/x'; rm -rf ~"),/Not a Codex sign-in address/);
});
test('a raw HTTP answer keeps the last response of a redirect chain',()=>{
  const r=parseResponse('HTTP/1.1 302 Found\r\nLocation: /success\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n<p>Signed in ✓</p>');
  assert.equal(r.status,200);assert.equal(r.headers['content-type'],'text/html');assert.equal(r.body.toString('utf8'),'<p>Signed in ✓</p>');
  assert.equal(parseResponse('nothing').status,502);
});
// Codex where it runs, played by a local server; "where it runs" is this machine's /bin/sh.
async function fakeCodex(t,state){
  const seen=[];const s=http.createServer((req,res)=>{seen.push(req.url);
    if(req.url.startsWith('/auth/callback')){const ok=new URL(req.url,'http://x').searchParams.get('state')===state;res.writeHead(ok?302:400,ok?{Location:'http://localhost:1455/success'}:{'content-type':'text/plain'});res.end(ok?'':'bad state');return;}
    if(req.url==='/success'){res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end('<h1>Signed in to Codex</h1>');return;}
    res.writeHead(404);res.end();});
  await new Promise(r=>s.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{s.closeAllConnections();s.close(r);}));
  return {port:s.address().port,seen};
}
const shell=(_where,script)=>spawn('/bin/sh',['-c',script],{stdio:['pipe','pipe','pipe']});
const authFor=(port,state)=>({url:`https://auth.openai.com/oauth/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A${port}%2Fauth%2Fcallback&state=${state}`,state,port,callbackPath:'/auth/callback'});
test('the browser lands here and the answer reaches Codex where it runs; its page comes back',{skip:posix},async t=>{
  const codex=await fakeCodex(t,'s1'),events=[],opened=[];
  const logins=new CodexLogins({shell,collect,open:async u=>opened.push(u),notify:e=>events.push(e),localPort:()=>0});t.after(()=>logins.close());
  const info=await logins.start({auth:authFor(codex.port,'s1'),where:{host:{name:'vps'},container:''},name:'vps',terminalId:'t1'});
  assert.equal(info.listening,true);assert.deepEqual(opened,[authFor(codex.port,'s1').url]);assert.equal(events[0].phase,'open');
  const here=`http://127.0.0.1:${info.localPort}`;
  const wrong=await fetch(`${here}/auth/callback?code=c&state=other`);assert.equal(wrong.status,400,'an answer for another sign-in is refused here');
  assert.equal((await fetch(`${here}/anything`)).status,404);
  const res=await fetch(`${here}/auth/callback?code=c1&state=s1`,{redirect:'manual'});
  assert.equal(res.status,302);assert.equal(res.headers.get('location'),'http://localhost:1455/success','the browser follows Codex to its success page, here');
  const ok=await fetch(`${here}/success`);assert.equal(ok.status,200);assert.match(await ok.text(),/Signed in to Codex/);
  assert.deepEqual(codex.seen.filter(u=>u.startsWith('/auth')),['/auth/callback?code=c1&state=s1']);
  assert.equal(events.at(-1).phase,'done');
  assert.equal(await logins.start({auth:authFor(codex.port,'s1'),where:{host:{name:'vps'}},terminalId:'t1'}),info,'the same link starts nothing new');
  const other=await logins.start({auth:authFor(codex.port,'s9'),where:{host:{name:'vps'}},terminalId:'t9'});logins.stopTerminal('t9');
  assert(!logins.list().some(x=>x.state==='s9'),'a closed sign-in terminal stops its listener');assert.equal(other.listening,true);
});
test('when the port is taken here the pasted address finishes the sign-in',{skip:posix},async t=>{
  const codex=await fakeCodex(t,'s2'),events=[];
  const logins=new CodexLogins({shell,collect,open:async()=>{throw new Error('should not open');},notify:e=>events.push(e)});t.after(()=>logins.close());
  const info=await logins.start({auth:authFor(codex.port,'s2'),where:{host:{name:'vps'}},name:'vps'});
  assert.equal(info.listening,false);assert.match(info.error,/in use/);assert.equal(events[0].phase,'paste');
  await assert.rejects(()=>logins.finish({text:'hello'}),/Paste the whole address/);
  await assert.rejects(()=>logins.finish({text:`http://127.0.0.1:${codex.port}/auth/callback?code=x&state=nope`}),/No Codex sign-in is waiting/);
  assert.deepEqual(await logins.finish({text:`  http://127.0.0.1:${codex.port}/auth/callback?code=c2&state=s2 `}),{ok:true,machine:'vps'});
  assert.equal(events.at(-1).phase,'done');assert.equal(logins.list().length,0);
  // Without a waiting sign-in (Opaya restarted), the place Codex runs is given.
  assert.deepEqual(await logins.finish({text:`http://127.0.0.1:${codex.port}/auth/callback?code=c3&state=s2`,where:{host:{name:'vps'}},name:'vps'}),{ok:true,machine:'vps'});
  await assert.rejects(()=>logins.finish({text:`http://127.0.0.1:${codex.port}/auth/callback?code=c4&state=bad`,where:{host:{name:'vps'}}}),/answered 400/);
});
test('Codex sign-in on a machine or in a container uses the browser, never a device code',()=>{
  const catalog=require('../desktop/catalog.cjs'),containers=require('../desktop/containers.cjs');
  assert.equal(catalog.setupCommand('codex','sign_in',{remote:true}).command,'codex login');
  assert.match(catalog.setupCommand('codex','sign_in',{remote:true,container:'codex-1'}).command,/docker exec \$t 'codex-1' sh -c 'codex login'$/);
  assert.doesNotMatch(containers.plan('codex',{}).command,/device-auth/);
  const {TOOLS,INSTALL_PROCEDURE}=require('../desktop/opaya-agent.cjs');
  assert(TOOLS.some(x=>x.function.name==='finish_codex_login'));assert.match(INSTALL_PROCEDURE,/never with a device code/);
});
