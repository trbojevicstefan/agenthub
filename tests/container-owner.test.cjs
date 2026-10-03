'use strict';
// A key written by Opaya as root (docker exec into a container) must stay readable by the agent's own user: a Hermes
// container runs as "hermes" and could not read a root:root 600 .env (Agent exited (1)).
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const {execFileSync}=require('node:child_process');
const root=typeof process.getuid==='function'&&process.getuid()===0;
const quote=s=>`'${String(s).replace(/'/g,`'\\''`)}'`;
test('a key written as root keeps the agent user as owner, and repairs a root-owned .env',{skip:!root||process.platform==='win32'?'needs root on Linux or macOS':false},()=>{
  const src=fs.readFileSync(path.join(__dirname,'../desktop/secrets.cjs'),'utf8'),script=src.match(/const script=`(umask 077; f=\$\{quote\(file\)\};[^`]*)`;/)[1];
  const run=(file,content)=>execFileSync('sh',['-c',script.replace('${quote(file)}',quote(file))],{input:content});
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'opaya-own-')),data=path.join(dir,'data');fs.mkdirSync(data);fs.chownSync(data,4321,4321);
  try{
    fs.writeFileSync(path.join(data,'.env'),'OLD=1\n',{mode:0o600});// root:root, as an older Opaya left it
    run(path.join(data,'.env'),'NEW=1\n');run(path.join(data,'new','x.env'),'X=1\n');
    for(const f of ['.env','new','new/x.env']){const st=fs.statSync(path.join(data,f));assert.equal(st.uid,4321,f);assert.equal(st.gid,4321,f);}
    assert.equal(fs.statSync(path.join(data,'.env')).mode&0o777,0o600);assert.equal(fs.readFileSync(path.join(data,'.env'),'utf8'),'NEW=1\n');
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
