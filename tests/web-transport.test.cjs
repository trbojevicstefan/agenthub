'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const vm=require('node:vm');const Module=require('node:module');
// The web app's window.agenthub (ui/web-transport.js) must offer exactly what the Electron preload offers, so ui/app.js
// runs unchanged in both. The preload runs sandboxed and cannot load a shared file, so this test compares them.
// Objects made in the vm context have its prototypes; compare their JSON.
const plain=v=>JSON.parse(JSON.stringify(v));
function preloadApi(){
  let exposed=null;const electron={contextBridge:{exposeInMainWorld:(_n,api)=>{exposed=api;}},ipcRenderer:{invoke:async()=>({ok:true}),on(){},removeListener(){}},webUtils:{}};
  const file=path.join(__dirname,'../desktop/preload.cjs'),m=new Module(file);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));
  m.require=name=>name==='electron'?electron:require(name);m._compile(fs.readFileSync(file,'utf8'),file);return exposed;
}
function webApi(){
  const sent=[],sockets=[];
  class FakeSocket{constructor(url){this.url=url;this.readyState=0;sockets.push(this);}send(t){sent.push(JSON.parse(t));}}
  const window={},context={window,document:{documentElement:{dataset:{}},createElement:()=>({}),body:{append(){}}},location:{protocol:'https:',host:'app.opaya.dev',origin:'https://app.opaya.dev'},WebSocket:FakeSocket,fetch:async()=>({ok:false}),setInterval:()=>0,setTimeout,clearTimeout,navigator:{},URL,Blob:class{},console};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../ui/web-transport.js'),'utf8'),context);
  return {api:window.agenthub,sent,sockets,context};
}
test('the web transport offers the same methods and events as the Electron preload',()=>{
  const desktop=Object.keys(preloadApi()).sort(),web=webApi(),names=Object.keys(web.api).sort();
  assert.deepEqual(names,desktop);
  assert.ok(Object.isFrozen(web.api));assert.equal(web.api.pathForFile({}),'');
  assert.equal(web.sockets[0].url,'wss://app.opaya.dev/app/ws');assert.equal(web.context.document.documentElement.dataset.runtime,'web');
});
test('calls wait for the hello, then go over the socket; desktop-only methods say so',async()=>{
  const {api,sent,sockets}=webApi(),socket=sockets[0];
  const result=api.saveHost({name:'vps'});
  assert.equal(sent.length,0,'queued until the server says hello');
  socket.readyState=1;socket.onmessage({data:JSON.stringify({kind:'hello',value:{agents:[]}})});
  assert.deepEqual(sent[0],{kind:'call',id:1,method:'saveHost',input:{name:'vps'}});
  socket.onmessage({data:JSON.stringify({kind:'result',id:1,value:{id:'h1'}})});assert.deepEqual(plain(await result),{id:'h1'});
  const failing=api.discover({});socket.onmessage({data:JSON.stringify({kind:'result',id:2,error:'In the web app...'})});await assert.rejects(failing,/In the web app/);
  await assert.rejects(api.cordConnect({}),/desktop app only/);await assert.rejects(api.updateInstall({}),/desktop app only/);
  assert.deepEqual(plain(await api.loginItem({})),{supported:false,on:false});
  const states=[];api.onState(s=>states.push(s));socket.onmessage({data:JSON.stringify({kind:'event',event:'state',value:{agents:[],account:{enabled:false}}})});
  assert.equal(states.length,1);assert.deepEqual(plain(states[0].account),{enabled:false},'no web account loaded yet');
});
