'use strict';
// DeepSeek Harness's own Web UI (`dsh web`), opened from Opaya. It runs where the agent runs, in a visible terminal:
// on this computer on a free local port; on a machine behind an SSH tunnel; in a container on the port Opaya published
// for it (127.0.0.1 of the machine, see containers.cjs webPort). dsh prints "dsh web: <url>" with a sign-in token in
// the URL; Opaya takes the path and token from that line and puts its own address in front. dsh accepts browser
// requests only for the address it serves or one named with --trusted-host, so a tunnel's local address is named.
const {quote,dockerExecContainerIndex}=require('./process.cjs');
const WEB_PORT=3080;
// The docker exec part of a container agent's command, up to its container name (keeps -e HOME=... of a profile).
function execPrefix(agent){
  const i=agent.command==='docker'?dockerExecContainerIndex(agent.args||[]):-1;
  return i<0?null:{container:agent.args[i],args:['exec','-t',...agent.args.slice(1,i+1).filter(a=>a!=='-t'&&a!=='-it')]};
}
// The command that starts the Web UI. port: where dsh listens (0 lets the OS pick); trusted: extra authorities.
// unset: variable names the shell drops first (a stale key its credential store holds; see process.cjs dshStoreNames).
function command(agent,{port=0,trusted=[],windows=false,unset=[]}={}){
  const exec=execPrefix(agent),flags=['--no-open',...(exec?['--host','0.0.0.0']:[]),'--port',String(exec?WEB_PORT:port),...trusted.flatMap(t=>['--trusted-host',t])];
  if(exec)return `docker ${exec.args.map(a=>quote(a)).join(' ')} dsh web ${flags.join(' ')}`;
  const names=unset.filter(n=>/^[A-Za-z_][A-Za-z0-9_]*$/.test(n));
  if(windows)return `${names.map(n=>`Remove-Item Env:${n} -ErrorAction SilentlyContinue; `).join('')}dsh web ${flags.join(' ')}`;
  return `${names.length?`env ${names.map(n=>`-u ${n}`).join(' ')} `:''}${quote(agent.command||'dsh')} web ${flags.join(' ')}`;
}
// The URL dsh printed last in a terminal's text, or ''.
function printedUrl(text){
  const all=[...String(text||'').replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g,'').matchAll(/dsh web: (https?:\/\/[^\s)]+)/g)];
  return all.length?all.at(-1)[1]:'';
}
// The printed URL with Opaya's address in front (the token and path kept).
function atAddress(url,port){const u=new URL(url);u.protocol='http:';u.hostname='127.0.0.1';u.port=String(port);return u.toString();}
module.exports={WEB_PORT,execPrefix,command,printedUrl,atAddress};
