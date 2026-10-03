'use strict';
// A backup of the Opaya Vault: the keys the user keeps (name, value, endpoint) in one file, encrypted with a password
// the user chooses (scrypt, then AES-256-GCM). The OS keychain encrypts the Vault on this computer only; this file can
// move to a new computer and be restored there with the same password. Without the password it is useless.
const crypto=require('node:crypto');
const FORMAT='opaya-vault-backup',VERSION=1,MAX_BYTES=5*1024*1024,KDF={N:2**15,r:8,p:1,maxmem:64*1024*1024};
const key=(password,salt)=>new Promise((resolve,reject)=>crypto.scrypt(String(password).normalize('NFC'),salt,32,KDF,(e,k)=>e?reject(e):resolve(k)));
function checkPassword(password){
  password=String(password??'');
  if(password.length<8)throw new Error('Choose a password of at least 8 characters for the backup.');
  if(password.length>1024)throw new Error('The password is too long.');
  return password;
}
// entries: [{name, value, endpoint}] -> the text of the backup file.
async function seal(entries,password){
  password=checkPassword(password);
  const keys=(entries||[]).filter(e=>e&&e.name&&e.value).map(e=>({name:String(e.name),value:String(e.value),...(e.endpoint?{endpoint:String(e.endpoint)}:{})}));
  if(!keys.length)throw new Error('The Vault has no keys to back up yet.');
  const salt=crypto.randomBytes(16),iv=crypto.randomBytes(12),k=await key(password,salt);
  const cipher=crypto.createCipheriv('aes-256-gcm',k,iv);cipher.setAAD(Buffer.from(`${FORMAT}/${VERSION}`));
  const data=Buffer.concat([cipher.update(JSON.stringify({keys}),'utf8'),cipher.final()]);
  return JSON.stringify({format:FORMAT,version:VERSION,created:new Date().toISOString(),count:keys.length,
    kdf:{name:'scrypt',N:KDF.N,r:KDF.r,p:KDF.p,salt:salt.toString('base64')},cipher:'aes-256-gcm',iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')},null,2)+'\n';
}
// The text of a backup file -> [{name, value, endpoint}]. A wrong password and a damaged file read the same.
async function open(text,password){
  let b;try{b=JSON.parse(String(text||''));}catch{b=null;}
  if(!b||b.format!==FORMAT)throw new Error('This is not an Opaya Vault backup.');
  if(b.version!==VERSION)throw new Error('This backup was made by a newer Opaya. Update Opaya, then restore it.');
  if(b.kdf?.name!=='scrypt'||b.cipher!=='aes-256-gcm'||![b.kdf.N,b.kdf.r,b.kdf.p].every(Number.isInteger)||b.kdf.N>2**20)throw new Error('This backup is damaged.');
  try{
    const k=await new Promise((resolve,reject)=>crypto.scrypt(String(password??'').normalize('NFC'),Buffer.from(b.kdf.salt,'base64'),32,{N:b.kdf.N,r:b.kdf.r,p:b.kdf.p,maxmem:256*1024*1024},(e,x)=>e?reject(e):resolve(x)));
    const d=crypto.createDecipheriv('aes-256-gcm',k,Buffer.from(b.iv,'base64'));d.setAAD(Buffer.from(`${FORMAT}/${b.version}`));d.setAuthTag(Buffer.from(b.tag,'base64'));
    const keys=JSON.parse(Buffer.concat([d.update(Buffer.from(b.data,'base64')),d.final()]).toString('utf8')).keys;
    if(!Array.isArray(keys))throw new Error('bad');
    return keys.filter(x=>x&&typeof x.name==='string'&&typeof x.value==='string'&&x.value).map(x=>({name:x.name,value:x.value,endpoint:typeof x.endpoint==='string'?x.endpoint:''}));
  }catch{throw new Error('Wrong password, or the backup is damaged.');}
}
module.exports={seal,open,checkPassword,FORMAT,MAX_BYTES};
