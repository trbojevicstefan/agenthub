'use strict';
// The Vault in a web runtime container (OPAYA_RUNTIME=web). The container has no keys of its own: its user's secrets
// are encrypted on the web server (Cloud KMS, web/src/secret-store.ts) and reach it through a Unix socket that only
// this container can see (/data/vault.sock), with the same authenticated line protocol as the session service
// (wire.cjs). The interface is the desktop Vault's (store.cjs): get and has stay synchronous because the secrets are
// loaded at start, and every change is written to the server before it shows here.
const {id}=require('./schema.cjs');
class RemoteVault{
  constructor({address,token,connect=require('./wire.cjs').connect}){Object.assign(this,{address,token,connectTo:connect});this.values=new Map();this.client=null;}
  async connection(){
    if(this.client&&!this.client.socket.destroyed)return this.client;
    this.client=await this.connectTo(this.address,this.token);this.client.on('closed',()=>{this.client=null;});return this.client;
  }
  async load(){const all=await (await this.connection()).call('vaultLoad',{},60000);this.values=new Map(Object.entries(all&&typeof all==='object'?all:{}).filter(([k,v])=>typeof v==='string'&&v));}
  available(){return true;}
  has(key){return this.values.has(key);}
  get(key){return this.values.get(key)||'';}
  async set(key,value){
    id(key);
    if(typeof value!=='string'||value.length>16000||/[\r\n\0]/.test(value))throw new Error('Invalid API token.');
    const client=await this.connection();
    if(value){await client.call('vaultSet',{key,value});this.values.set(key,value);}
    else{await client.call('vaultRemove',{key});this.values.delete(key);}
  }
  async remove(key){await this.set(key,'');}
  async list(){return [...this.values.keys()];}
  close(){this.client?.close();this.client=null;}
}
module.exports={RemoteVault};
