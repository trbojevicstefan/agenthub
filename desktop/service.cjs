'use strict';
// Independent Electron main process; no BrowserWindow and no public port.
const fs = require('node:fs/promises');
const path = require('node:path');
const {randomBytes, randomUUID} = require('node:crypto');
const {Store, Vault, atomicJson} = require('./store.cjs');
const {Broker, safeError} = require('./broker.cjs');
const {Terminals} = require('./terminal.cjs');
const {server, endpoint} = require('./wire.cjs');
const {alive} = require('./host-client.cjs');
const schema = require('./schema.cjs');
async function start({app, safeStorage}, root) {
  let broker, terminals, listener, stopping = false;
  const startedAt = new Date().toISOString(), approvals = new Map();
  const descriptor = path.join(root, 'session-service.json');
  await fs.mkdir(root,{recursive:true,mode:0o700});
  const old = await fs.readFile(descriptor,'utf8').then(JSON.parse).catch(()=>null);
  if (old && old.pid !== process.pid && alive(old.pid)) throw new Error('A session service is already running.');
  if (process.platform !== 'win32') await fs.rm(endpoint(root),{force:true});
  function snapshot() { return {...broker.snapshot(), terminals:terminals?.describe() || [], service:{pid:process.pid, startedAt, persistent:true}}; }
  const emit = () => listener?.broadcast('state', snapshot());
  async function approve(agent, title, detail) {
    const socket = [...(listener?.clients || [])].at(-1);
    if (!socket) return false; // No UI present: never approve unattended operations.
    const id = randomUUID();
    return new Promise(resolve => {
      const timer = setTimeout(() => finish(false), 120000);
      function finish(value) { clearTimeout(timer); approvals.delete(id); resolve(value); }
      approvals.set(id,{socket,finish}); listener.notify(socket,'approval',{id,agent:{name:agent.name},title,detail});
    });
  }
  broker = new Broker({store:new Store(root),vault:new Vault(root,safeStorage),emit,approve});
  await broker.init();
  terminals = new Terminals(event => { listener?.broadcast('terminal',event); if (event.type !== 'data') emit(); },{root});
  await terminals.init();
  async function shutdown() {
    if (stopping) return true; stopping = true;
    for (const a of approvals.values()) a.finish(false);
    await terminals.shutdown(); await broker.close();
    await fs.rm(descriptor,{force:true});
    setTimeout(()=>app.exit(0),100).unref(); return true;
  }
  const actions = {
    snapshot, saveAgent:x=>broker.saveAgent(x), saveHost:x=>broker.saveHost(x), removeHost:x=>broker.removeHost(x.id),
    removeAgent:async x=>{const a=broker.agent(x.id); if(!await approve(a,'Remove this agent connection?','Deletes its saved connection and local chat transcripts, not the agent installation.'))return false;terminals.closeAgent(a.id);await broker.removeAgent(a.id);return true;},
    discover:x=>broker.discover(x), connect:x=>broker.connect(x.id), disconnect:x=>broker.disconnect(x.id),
    select:x=>broker.select(x.id), newConversation:x=>broker.newConversation(x.agentId), selectConversation:x=>broker.selectConversation(x.id),
    send:x=>broker.send(x), stop:x=>broker.stop(x.id), saveDraft:x=>broker.saveDraft(x), saveView:x=>broker.saveView(x),
    transcript:async x=>{const c=broker.data.conversations.find(c=>c.id===schema.id(x.id));if(!c)throw new Error('Conversation not found.');return {conversation:c,agent:broker.agent(c.agentId),messages:broker.histories.get(c.id)||await broker.store.transcript(c.id)};},
    terminalOpen:async x=>{
      const a=x.local===true?{id:'local-shell',name:'This computer',provider:'custom',transport:'local',command:'',args:[],cwd:app.getPath('home')}:x.agentId?broker.agent(x.agentId):{id:`host_${schema.id(x.hostId)}`,name:broker.host(x.hostId).name,provider:'custom',transport:'ssh',hostId:x.hostId,command:'',args:[],cwd:''};
      if(x.mode==='agent'&&a.provider==='hermes'&&!terminals.hasLive(a.id,x.mode)&&!await approve(a,'Start a new Hermes CLI process?','This does not attach to an existing gateway. Do not run another writer against a Hermes profile already used by a gateway. Use its gateway API or existing tmux session instead.'))throw new Error('CLI launch cancelled.');
      const result=terminals.open(a,a.transport==='ssh'?broker.host(a.hostId):null,x.mode||'shell',{cols:x.cols||100,rows:x.rows||28});emit();return result;
    },
    terminalAttach:x=>terminals.attach(schema.id(x.id)), terminalWrite:x=>terminals.write(schema.id(x.id),x.data),
    terminalResize:x=>terminals.resize(schema.id(x.id),x.cols,x.rows),
    terminalClose:async x=>{const s=terminals.describe().find(s=>s.id===schema.id(x.id));if(!s)return false;if(!await approve({name:s.title},'Close this terminal connection?',s.remote?'Detaches SSH. The tmux session on the remote host is kept.':'Ends the local terminal process. This cannot be undone.'))return false;terminals.close(x.id);emit();return true;},
    shutdown
  };
  const token = randomBytes(32).toString('hex');
  listener = server({token,snapshot,
    dispatch:async (method,input)=>{if(!Object.hasOwn(actions,method))throw new Error('Unsupported desktop action.');try{return await actions[method](input||{});}catch(error){throw new Error(safeError(error));}},
    onApproval:(socket,message)=>{const a=approvals.get(message.id);if(a?.socket===socket)a.finish(message.allow===true);},
    onDetach:socket=>{for(const a of approvals.values())if(a.socket===socket)a.finish(false);}
  });
  await new Promise((resolve,reject)=>{listener.once('error',reject);listener.listen(endpoint(root),resolve);});
  if(process.platform!=='win32')await fs.chmod(endpoint(root),0o600);
  await atomicJson(descriptor,{protocol:1,pid:process.pid,token,startedAt});
  app.on('before-quit',event=>{if(!stopping){event.preventDefault();shutdown().catch(()=>app.exit(1));}});
  process.on('SIGTERM',()=>shutdown().catch(()=>app.exit(1)));
  process.on('SIGINT',()=>shutdown().catch(()=>app.exit(1)));
  // Referenced listener keeps the service alive after every UI client detaches.
  return {broker,terminals,listener,shutdown};
}
module.exports = {start};
