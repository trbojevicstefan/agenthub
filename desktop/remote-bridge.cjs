'use strict';
// Opaya's MCP servers (the browser) for agents on another machine or in a container. Their MCP servers run where they
// run, so a program on this computer is out of reach. Opaya opens its own channel there (ssh, docker exec, the same way
// terminals open) and starts a small relay on 127.0.0.1 inside that environment. The agent's MCP server is a tiny client
// that connects to the relay, proves itself with a one-time token, and its bytes travel over Opaya's channel to the
// session service, which answers as the MCP server. No port is opened on the machine's network and sshd needs no
// settings. The relay runs on python3 (any Hermes) or node (Claude Code, Codex, OpenCode containers).
const {randomBytes}=require('node:crypto');
const {StringDecoder}=require('node:string_decoder');
const {quote}=require('./process.cjs');
// Listener: prints {"port":n}, then one JSON line per chunk {"c":id,"d":base64} and {"c":id,"x":1} when a client goes;
// reads the same lines on stdin for the way back. Exits when Opaya's channel closes.
const PY_SERVER=`import socket,sys,threading,json,base64,os
s=socket.socket();s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);s.bind(('127.0.0.1',0));s.listen(16)
lock=threading.Lock();conns={};n=[0]
def send(o):
  with lock:
    sys.stdout.write(json.dumps(o)+'\\n');sys.stdout.flush()
send({'port':s.getsockname()[1]})
def reader(cid,c):
  try:
    while True:
      d=c.recv(65536)
      if not d:break
      send({'c':cid,'d':base64.b64encode(d).decode()})
  except Exception:pass
  conns.pop(cid,None);send({'c':cid,'x':1})
def acceptor():
  while True:
    c,_=s.accept();n[0]+=1;cid=n[0];conns[cid]=c
    threading.Thread(target=reader,args=(cid,c),daemon=True).start()
threading.Thread(target=acceptor,daemon=True).start()
for line in sys.stdin:
  try:m=json.loads(line)
  except Exception:continue
  c=conns.get(m.get('c'))
  if c is None:continue
  try:
    if m.get('x'):c.close()
    else:c.sendall(base64.b64decode(m['d']))
  except Exception:pass
os._exit(0)
`;
const NODE_SERVER=`const net=require('net'),rl=require('readline');let n=0;const conns=new Map(),send=o=>process.stdout.write(JSON.stringify(o)+'\\n');
const srv=net.createServer(c=>{const id=++n;conns.set(id,c);c.on('data',d=>send({c:id,d:d.toString('base64')}));c.on('close',()=>{conns.delete(id);send({c:id,x:1});});c.on('error',()=>{});});
srv.listen(0,'127.0.0.1',()=>send({port:srv.address().port}));
rl.createInterface({input:process.stdin}).on('line',l=>{let m;try{m=JSON.parse(l);}catch{return;}const c=conns.get(m.c);if(!c)return;if(m.x)c.destroy();else c.write(Buffer.from(m.d,'base64'));}).on('close',()=>process.exit(0));
`;
// The agent's MCP server: connects to the relay, sends the token, then passes stdin and stdout through.
const PY_CLIENT=`import socket,sys,os,threading
c=socket.create_connection(('127.0.0.1',int(sys.argv[1])));c.sendall((os.environ.get('OPAYA_BRIDGE_TOKEN','')+'\\n').encode())
def up():
  while True:
    d=os.read(0,65536)
    if not d:break
    c.sendall(d)
  try:c.shutdown(socket.SHUT_WR)
  except Exception:pass
threading.Thread(target=up,daemon=True).start()
while True:
  d=c.recv(65536)
  if not d:break
  os.write(1,d)
`;
const NODE_CLIENT=`const c=require('net').connect(+process.argv[1],'127.0.0.1',()=>{c.write((process.env.OPAYA_BRIDGE_TOKEN||'')+'\\n');process.stdin.pipe(c);c.pipe(process.stdout);});c.on('close',()=>process.exit(0));c.on('error',()=>process.exit(1));`;
const LAUNCH=`if command -v python3 >/dev/null 2>&1; then exec python3 -u -c ${quote(PY_SERVER)}; elif command -v node >/dev/null 2>&1; then echo '{"rt":"node"}'; exec node -e ${quote(NODE_SERVER)}; else echo '{"error":"Neither python3 nor node is available where this agent runs."}'; fi`;
class RemoteBridge{
  // shell: (where, script) => child process (clone.cjs shell). onConnection(conn): conn.lines(fn), conn.send(text), conn.close().
  constructor({where,shell,onConnection,timeout=20000}){Object.assign(this,{where,shell,onConnection,timeout});this.token=randomBytes(24).toString('hex');this.conns=new Map();this.rt='python3';}
  start(){
    if(this.ready)return this.ready;
    this.ready=new Promise((resolve,reject)=>{
      let child;try{child=this.shell(this.where,LAUNCH);}catch(error){reject(error);return;}
      this.child=child;let buf='',settled=false;const done=(fn,v)=>{if(!settled){settled=true;clearTimeout(timer);fn(v);}};
      const timer=setTimeout(()=>{done(reject,new Error('The Opaya browser relay did not start in time where this agent runs.'));this.close();},this.timeout);
      child.stdout.on('data',d=>{buf+=d;let i;while((i=buf.indexOf('\n'))>=0){const line=buf.slice(0,i);buf=buf.slice(i+1);let m;try{m=JSON.parse(line);}catch{continue;}
        if(m.rt)this.rt=m.rt;else if(m.error){done(reject,new Error(m.error));}else if(m.port){this.port=m.port;done(resolve,this.server());}else if(m.c)this.frame(m);}});
      child.stderr?.on('data',()=>{});child.stdin.on('error',()=>{});
      child.on('close',()=>{done(reject,new Error('The Opaya browser relay stopped where this agent runs.'));this.closed=true;for(const c of this.conns.values())c.end();this.conns.clear();this.onClose?.();});
      child.on('error',e=>done(reject,e));
    });
    return this.ready;
  }
  // The MCP server entry the agent starts where it runs (an ACP stdio server).
  server(){return {command:this.rt==='node'?'node':'python3',args:this.rt==='node'?['-e',NODE_CLIENT,String(this.port)]:['-u','-c',PY_CLIENT,String(this.port)],env:[{name:'OPAYA_BRIDGE_TOKEN',value:this.token}]};}
  frame(m){
    let c=this.conns.get(m.c);
    if(m.x){if(c){this.conns.delete(m.c);c.end();}return;}
    if(!c){c=this.connection(m.c);this.conns.set(m.c,c);}
    c.data(Buffer.from(String(m.d||''),'base64'));
  }
  connection(id){
    const decoder=new StringDecoder('utf8');
    const write=o=>{if(!this.closed)this.child.stdin.write(JSON.stringify(o)+'\n');};
    let buf='',authed=false,onLine=null,ended=false;
    const conn={
      send:text=>write({c:id,d:Buffer.from(String(text)+'\n').toString('base64')}),
      close:()=>write({c:id,x:1}),
      lines:fn=>{onLine=fn;},
      data:chunk=>{buf+=decoder.write(chunk);let i;while((i=buf.indexOf('\n'))>=0){const line=buf.slice(0,i);buf=buf.slice(i+1);
        // The first line is the token: anything else on that machine reaching the relay is cut off.
        if(!authed){if(line.trim()===this.token){authed=true;this.onConnection(conn);}else{conn.close();ended=true;return;}continue;}
        if(!ended)onLine?.(line);}},
      end:()=>{ended=true;conn.onEnd?.();}
    };
    return conn;
  }
  close(){this.closed=true;try{this.child?.stdin.end();this.child?.kill();}catch{}}
}
module.exports={RemoteBridge,PY_SERVER,PY_CLIENT,NODE_SERVER,NODE_CLIENT,LAUNCH};
