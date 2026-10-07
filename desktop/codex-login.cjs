'use strict';
// Codex sign-in on a machine or in a container, with the browser on this computer.
// `codex login` starts a small server on 127.0.0.1:1455 where it runs and sends the browser to OpenAI, which returns
// the browser to http://127.0.0.1:1455/auth/callback?code=... . On a VPS or in a container that address is not this
// computer, and device-code sign-in may be turned off for the workspace. So while such a sign-in waits, Opaya listens on
// the same port here, opens the sign-in page in the user's browser, and passes each request the browser makes there to
// Codex where it runs (over Opaya's own SSH or docker exec channel), with Codex's answer going back to the browser.
// When the port is taken here, the user (or the Opaya Agent) pastes the address the browser ended on: finish() passes it.
const http=require('node:http');
const {quote}=require('./process.cjs');

const AUTH=/https:\/\/auth\.openai\.com\/oauth\/authorize\?/;
const URL_CHARS=/^[A-Za-z0-9%&=._~+\-:/?#@!$'()*,;]+$/;
// The sign-in link in what a terminal shows. A long link is cut into several screen rows; the rows after it that are
// only link characters are its continuation.
function findAuthUrl(lines){
  const rows=(Array.isArray(lines)?lines:String(lines||'').split('\n')).map(l=>String(l).replace(/\s+$/,''));
  for(let i=rows.length-1;i>=0;i--){
    const m=AUTH.exec(rows[i]);if(!m)continue;
    let url=rows[i].slice(m.index).split(/\s/)[0];
    for(let j=i+1;j<rows.length;j++){const next=rows[j].trim();if(!next||!URL_CHARS.test(next)||AUTH.test(next))break;url+=next;}
    const parsed=parse(url);if(parsed)return parsed;
  }
  return null;
}
// The parts of a sign-in link Opaya needs: where Codex waits for the answer, and the state that ties the answer to it.
function parse(url){
  let u;try{u=new URL(url);}catch{return null;}
  if(u.hostname!=='auth.openai.com'||!u.pathname.startsWith('/oauth/authorize'))return null;
  const state=u.searchParams.get('state')||'';let redirect;try{redirect=new URL(u.searchParams.get('redirect_uri')||'');}catch{return null;}
  if(!state||redirect.protocol!=='http:'||!['127.0.0.1','localhost'].includes(redirect.hostname))return null;
  const port=Number(redirect.port||80);if(!Number.isInteger(port)||port<1024||port>65535)return null;
  return {url:u.toString(),state,port,callbackPath:redirect.pathname||'/auth/callback'};
}
// The address the browser ended on after signing in (http://127.0.0.1:1455/auth/callback?code=...&state=...).
function parseCallback(text){
  const found=/https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/[^\s"'<>]*/.exec(String(text||''));if(!found)return null;
  let u;try{u=new URL(found[0]);}catch{return null;}
  const port=Number(u.port||80),path=u.pathname+u.search;
  if(!Number.isInteger(port)||port<1024||port>65535||!SAFE_PATH.test(path))return null;
  return {port,path,state:u.searchParams.get('state')||'',code:!!u.searchParams.get('code')||!!u.searchParams.get('error')};
}
const SAFE_PATH=/^\/[A-Za-z0-9/_\-.~%?=&+]*$/;
// Fetches one address from Codex where it runs and prints the raw HTTP answer: curl, else python3, else node.
function forwardScript(port,path){
  if(!SAFE_PATH.test(path)||!Number.isInteger(port))throw new Error('Not a Codex sign-in address.');
  const url=`http://127.0.0.1:${port}${path}`;
  const py=`import sys,http.client
c=http.client.HTTPConnection("127.0.0.1",${port},timeout=20);c.request("GET",${JSON.stringify(path)});r=c.getresponse()
o=sys.stdout.buffer;o.write(("HTTP/1.1 %d %s\\r\\n"%(r.status,r.reason)).encode())
for k,v in r.getheaders():o.write(("%s: %s\\r\\n"%(k,v)).encode())
o.write(b"\\r\\n");o.write(r.read());o.flush()`;
  const js=`require("http").get({host:"127.0.0.1",port:${port},path:${JSON.stringify(path)}},r=>{let h="HTTP/1.1 "+r.statusCode+" "+r.statusMessage+"\\r\\n";for(let i=0;i<r.rawHeaders.length;i+=2)h+=r.rawHeaders[i]+": "+r.rawHeaders[i+1]+"\\r\\n";process.stdout.write(h+"\\r\\n");r.pipe(process.stdout);}).on("error",e=>{console.error(e.message);process.exit(1);})`;
  return `if command -v curl >/dev/null 2>&1; then exec curl -sS -i --max-time 20 ${quote(url)}; elif command -v python3 >/dev/null 2>&1; then exec python3 -c ${quote(py)}; elif command -v node >/dev/null 2>&1; then exec node -e ${quote(js)}; else echo 'Neither curl, python3 nor node is available where Codex runs.' >&2; exit 3; fi`;
}
// A raw HTTP answer split into status, headers and body. curl -i prints every response of a redirect chain; the last wins.
function parseResponse(raw){
  const enc=Buffer.isBuffer(raw)?'latin1':'utf8';let text=Buffer.isBuffer(raw)?raw.toString('latin1'):String(raw||'');
  for(;;){
    const end=text.indexOf('\r\n\r\n');if(end<0)break;
    const head=text.slice(0,end).split('\r\n'),status=/^HTTP\/[\d.]+\s+(\d{3})/.exec(head[0]);
    if(!status)break;
    const body=text.slice(end+4);
    if(/^HTTP\/[\d.]+\s+\d{3}/.test(body)){text=body;continue;}
    const headers={};for(const line of head.slice(1)){const i=line.indexOf(':');if(i>0)headers[line.slice(0,i).trim().toLowerCase()]=line.slice(i+1).trim();}
    return {status:Number(status[1]),headers,body:Buffer.from(body,enc)};
  }
  return {status:502,headers:{'content-type':'text/plain; charset=utf-8'},body:Buffer.from('Codex did not answer where it runs.\n')};
}
const page=(title,text)=>`<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:15px system-ui;margin:12vh auto;max-width:520px;color:#222"><h2>${title}</h2><p>${text}</p>`;

class CodexLogins{
  // shell(where,script): a child process running the script where Codex runs (clone.cjs shell); collect: process.cjs.
  // open(url): opens a link in the user's browser. notify(event): tells the windows what happens.
  // localPort: the port to listen on here, the one Codex chose (tests use another, as Codex itself runs on this machine).
  constructor({shell,collect,open,notify,listenHost='127.0.0.1',localPort=auth=>auth.port,timeout=15*60*1000}){Object.assign(this,{shell,collect,open,notify,listenHost,localPort,timeout});this.pending=new Map();}
  // A terminal printed a Codex sign-in link (where: {host, container, home?} it runs; name: the machine, for messages).
  async start({auth,where,name='the machine',terminalId=''}){
    if(!auth||!where)return null;
    const old=this.pending.get(auth.state);if(old)return old.info;
    for(const [state,p] of this.pending)if(p.terminalId&&p.terminalId===terminalId)this.stop(state);
    const entry={auth,where,name,terminalId,server:null,done:false,info:{state:auth.state,port:auth.port,name,listening:false,url:auth.url,terminalId}};
    this.pending.set(auth.state,entry);
    entry.timer=setTimeout(()=>this.stop(auth.state),this.timeout);entry.timer.unref?.();
    try{entry.server=await this.listen(entry);entry.info.listening=true;entry.info.localPort=entry.server.address().port;}
    catch(error){entry.info.error=error.code==='EADDRINUSE'?`Port ${auth.port} is in use on this computer.`:error.message;}
    this.notify({type:'codex-login',phase:entry.info.listening?'open':'paste',...entry.info});
    if(entry.info.listening)try{await this.open(auth.url);}catch(error){this.notify({type:'codex-login',phase:'paste',...entry.info,error:`Could not open the browser: ${error.message}`});}
    return entry.info;
  }
  listen(entry){
    return new Promise((resolve,reject)=>{
      const server=http.createServer((req,res)=>this.serve(entry,req,res).catch(error=>{if(!res.headersSent){res.writeHead(502,{'content-type':'text/html; charset=utf-8'});res.end(page('Sign-in not finished',String(error.message).replace(/[<>&]/g,'')));}}));
      server.once('error',reject);
      server.listen(this.localPort(entry.auth),this.listenHost,()=>{server.off('error',reject);server.unref?.();resolve(server);});
    });
  }
  // Only Codex's own pages, and the callback only with the state of this sign-in.
  async serve(entry,req,res){
    const path=String(req.url||'/'),u=new URL(path,'http://127.0.0.1');
    const callback=u.pathname===entry.auth.callbackPath,known=callback||/^\/(success|cancel|favicon\.ico)$/.test(u.pathname);
    if(req.method!=='GET'||!known||!SAFE_PATH.test(path)){res.writeHead(404);res.end();return;}
    if(callback&&u.searchParams.get('state')!==entry.auth.state){res.writeHead(400,{'content-type':'text/html; charset=utf-8'});res.end(page('Not this sign-in','This answer belongs to another Codex sign-in. Start the sign-in again in Opaya.'));return;}
    const answer=await this.forward(entry,path);
    const headers={...answer.headers};for(const h of ['transfer-encoding','connection','content-length','keep-alive'])delete headers[h];
    res.writeHead(answer.status,headers);res.end(answer.body);
    if(callback)this.finished(entry,answer);
  }
  async forward(entry,path){
    const raw=await this.collect(this.shell(entry.where,forwardScript(entry.auth.port,path)),{timeout:30000,maxBytes:4*1024*1024});
    return parseResponse(raw);
  }
  finished(entry,answer){
    const ok=answer.status<400;
    this.notify({type:'codex-login',phase:ok?'done':'failed',...entry.info,status:answer.status});
    // Codex shows its success page right after the callback; keep listening a little for it, then stop.
    if(ok){entry.done=true;setTimeout(()=>this.stop(entry.auth.state),20000).unref?.();}
  }
  // The address the browser ended on, pasted by the user or given by the Opaya Agent. Without a waiting sign-in, `where`
  // says where Codex runs.
  async finish({text,where,name}){
    const cb=parseCallback(text);if(!cb)throw new Error('Paste the whole address from the browser: it starts with http://127.0.0.1:1455/auth/callback?code=');
    if(!cb.code)throw new Error('That address has no sign-in code. Paste the address the browser shows after you sign in.');
    const entry=this.pending.get(cb.state)||(where?{auth:{state:cb.state,port:cb.port,callbackPath:'/auth/callback'},where,name:name||'the machine',info:{state:cb.state,port:cb.port,name:name||'the machine'}}:null);
    if(!entry)throw new Error('No Codex sign-in is waiting for this address. Start the sign-in again, then paste the new address.');
    const answer=await this.forward(entry,cb.path);
    if(answer.status>=400)throw new Error(`Codex where it runs answered ${answer.status}: ${answer.body.toString('utf8').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().slice(0,200)||'the sign-in was not accepted'}. Start the sign-in again.`);
    this.notify({type:'codex-login',phase:'done',...entry.info,status:answer.status});
    if(this.pending.has(cb.state))this.stop(cb.state);
    return {ok:true,machine:entry.name};
  }
  stop(state){const e=this.pending.get(state);if(!e)return;this.pending.delete(state);clearTimeout(e.timer);try{e.server?.close();e.server?.closeAllConnections?.();}catch{}}
  // The terminal Codex signed in from ended: its sign-in cannot finish any more.
  stopTerminal(id){for(const [state,e] of [...this.pending])if(e.terminalId===id&&!e.done)this.stop(state);}
  list(){return [...this.pending.values()].map(e=>({...e.info,done:e.done}));}
  close(){for(const state of [...this.pending.keys()])this.stop(state);}
}
module.exports={CodexLogins,findAuthUrl,parse,parseCallback,forwardScript,parseResponse};
