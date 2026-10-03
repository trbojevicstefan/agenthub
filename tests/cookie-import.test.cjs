'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const crypto=require('node:crypto');
const ci=require('../desktop/cookie-import.cjs');
let sqlite;try{sqlite=require('node:sqlite');}catch{}
const cbc=(value,host)=>{const k=crypto.pbkdf2Sync('peanuts','saltysalt',1,16,'sha1'),c=crypto.createCipheriv('aes-128-cbc',k,Buffer.alloc(16,0x20));return Buffer.concat([Buffer.from('v10'),c.update(Buffer.concat([crypto.createHash('sha256').update(host).digest(),Buffer.from(value)])),c.final()]);};
test('Chrome on Linux: v10 cookies are decrypted and filtered by domain; app-bound v20 ones are counted, not imported',{skip:!sqlite&&'node:sqlite builds the fixture'},()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'opaya-ck-')),dir=path.join(home,'.config','google-chrome','Default','Network');fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(home,'.config','google-chrome','Local State'),JSON.stringify({profile:{info_cache:{Default:{name:'Work'}}}}));
  try{
    const d=new sqlite.DatabaseSync(path.join(dir,'Cookies'));
    d.exec('CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);CREATE TABLE cookies(creation_utc INTEGER NOT NULL,host_key TEXT NOT NULL,top_frame_site_key TEXT NOT NULL,name TEXT NOT NULL,value TEXT NOT NULL,encrypted_value BLOB NOT NULL,path TEXT NOT NULL,expires_utc INTEGER NOT NULL,is_secure INTEGER NOT NULL,is_httponly INTEGER NOT NULL,last_access_utc INTEGER NOT NULL,has_expires INTEGER NOT NULL,is_persistent INTEGER NOT NULL,priority INTEGER NOT NULL,samesite INTEGER NOT NULL,source_scheme INTEGER NOT NULL,source_port INTEGER NOT NULL)');
    d.prepare("INSERT INTO meta VALUES ('version','24')").run();
    const ins=d.prepare('INSERT INTO cookies VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    ins.run(1,'.youtube.com','','SID','',cbc('youtube-secret','.youtube.com'),'/',13400000000000000,1,1,0,1,1,1,0,2,443);
    ins.run(2,'accounts.google.com','','LSID','',cbc('google-secret','accounts.google.com'),'/',13400000000000000,1,1,0,1,1,1,2,2,443);
    ins.run(3,'.example.com','','other','',cbc('x','.example.com'),'/',0,0,0,0,0,0,1,-1,2,443);
    ins.run(4,'.youtube.com','','LOCKED','',Buffer.concat([Buffer.from('v20'),crypto.randomBytes(40)]),'/',13400000000000000,1,1,0,1,1,1,1,2,443);
    d.close();
    const found=ci.profiles({platform:'linux',home,env:{}});assert.deepEqual(found.map(p=>[p.browser,p.profile,p.name]),[['chrome','Default','Work']]);
    const r=ci.readBrowser({browser:'chrome',profile:'Default',domains:['youtube.com','google.com']},{platform:'linux',home,env:{}});
    assert.deepEqual(r.cookies.map(c=>[c.name,c.value,c.domain||'',c.sameSite,c.secure]),[['SID','youtube-secret','.youtube.com','no_restriction',true],['LSID','google-secret','','strict',true]]);
    assert.equal(r.cookies[0].expirationDate,Math.floor(13400000000000000/1e6-11644473600));
    assert.equal(r.unreadable,1);assert.deepEqual(r.locked,['youtube.com']);
  }finally{fs.rmSync(home,{recursive:true,force:true});}
});
test('Windows v10 values (AES-256-GCM) decrypt with the unlocked key',()=>{
  const key=crypto.randomBytes(32),iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',key,iv),data=Buffer.concat([c.update(Buffer.concat([Buffer.alloc(32,7),Buffer.from('token')])),c.final()]);
  assert.equal(ci.decrypt(Buffer.concat([Buffer.from('v10'),iv,data,c.getAuthTag()]),{gcm:key},true),'token');
  assert.equal(ci.decrypt(Buffer.concat([Buffer.from('v20'),crypto.randomBytes(30)]),{gcm:key},true),null);
});
test('cookies.txt and JSON exports from the browser',()=>{
  const txt=ci.parseFile('# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t2000000000\tSID\tabc\n#HttpOnly_accounts.google.com\tFALSE\t/\tTRUE\t0\tLSID\txyz\n.other.com\tTRUE\t/\tFALSE\t0\tz\t1\n',{domains:['youtube.com','google.com']});
  assert.deepEqual(txt.map(c=>[c.name,c.value,c.httpOnly,c.domain||'',c.expirationDate||0]),[['SID','abc',false,'.youtube.com',2000000000],['LSID','xyz',true,'',0]]);
  const json=ci.parseFile(JSON.stringify([{domain:'.github.com',name:'user_session',value:'s',path:'/',secure:true,httpOnly:true,sameSite:'lax',expirationDate:1999999999.5}]));
  assert.deepEqual(json.map(c=>[c.name,c.sameSite,c.expirationDate,c.url]),[['user_session','lax',1999999999,'https://github.com/']]);
  assert.throws(()=>ci.parseFile('hello world'),/not a cookies.txt/);
});
