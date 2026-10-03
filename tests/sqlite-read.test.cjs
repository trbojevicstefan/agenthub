'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const os=require('node:os');
const {Db}=require('../desktop/sqlite-read.cjs');
let sqlite;try{sqlite=require('node:sqlite');}catch{}
test('reads every row of a Chrome-like cookies table: interior pages, overflow blobs, negative and large numbers',{skip:!sqlite&&'node:sqlite is not available to build the fixture'},()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'opaya-sql-')),file=path.join(dir,'Cookies');
  try{
    const d=new sqlite.DatabaseSync(file);
    d.exec(`CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);CREATE TABLE cookies(creation_utc INTEGER NOT NULL,host_key TEXT NOT NULL,top_frame_site_key TEXT NOT NULL,name TEXT NOT NULL,value TEXT NOT NULL,encrypted_value BLOB NOT NULL,path TEXT NOT NULL,expires_utc INTEGER NOT NULL,is_secure INTEGER NOT NULL,is_httponly INTEGER NOT NULL,last_access_utc INTEGER NOT NULL,has_expires INTEGER NOT NULL,is_persistent INTEGER NOT NULL,priority INTEGER NOT NULL,samesite INTEGER NOT NULL,source_scheme INTEGER NOT NULL,source_port INTEGER NOT NULL,last_update_utc INTEGER NOT NULL,source_type INTEGER NOT NULL,has_cross_site_ancestor INTEGER NOT NULL,UNIQUE (host_key, top_frame_site_key, name, path, source_scheme, source_port))`);
    d.prepare('INSERT INTO meta VALUES (?,?)').run('version','24');
    const ins=d.prepare('INSERT INTO cookies VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'),want=[];
    for(let i=0;i<1500;i++){const blob=Buffer.alloc(i%97===0?9000:40+(i%30),i%256);const row=[13371337000000000+i,`.site${i}.com`,'',`c${i}`,'',blob,'/',13400000000000000+i,i%2,1,0,1,1,1,i%3-1,2,443,0,0,0];ins.run(...row);want.push(row);}
    d.close();
    const db=new Db(file);assert.equal([...db.select('meta')].find(r=>r.key==='version').value,'24');
    const rows=[...db.select('cookies')];assert.equal(rows.length,1500);
    for(const [i,r] of rows.entries()){assert.equal(r.host_key,want[i][1]);assert.equal(r.name,want[i][3]);assert(Buffer.compare(r.encrypted_value,want[i][5])===0,`blob ${i}`);assert.equal(r.samesite,want[i][14]);assert.equal(r.expires_utc,want[i][7]);}
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
