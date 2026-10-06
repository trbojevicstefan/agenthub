'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');const {spawnSync}=require('node:child_process');
const {browse,isSecret,REMOTE}=require('../desktop/files.cjs');const {temp}=require('./helpers.cjs');
async function project(t){const dir=await temp(t);await fs.mkdir(path.join(dir,'src'));await fs.writeFile(path.join(dir,'README.md'),'# Demo\n');await fs.writeFile(path.join(dir,'package.json'),'{}');await fs.writeFile(path.join(dir,'blob.bin'),Buffer.from([1,0,2,3]));return dir;}
test('local browsing lists folders, reads text and flags binary files',async t=>{
  const dir=await project(t);
  const list=await browse({op:'list',path:dir});assert.equal(list.path,dir);assert.deepEqual(list.entries.map(e=>e.name).sort(),['README.md','blob.bin','package.json','src']);assert.equal(list.entries.find(e=>e.name==='src').type,'dir');
  const read=await browse({op:'read',path:path.join(dir,'README.md')});assert.equal(read.text,'# Demo\n');assert.equal(read.binary,false);
  assert.equal((await browse({op:'read',path:path.join(dir,'blob.bin')})).binary,true);
  const info=await browse({op:'project',path:dir});assert.deepEqual(info.markers.sort(),['README.md','package.json']);
  await assert.rejects(()=>browse({op:'write',path:dir}),/Unknown file operation/);await assert.rejects(()=>browse({op:'list',path:'a\nb'}),/Invalid path/);
});
test('the remote reader gives the same answers as the local one',{skip:spawnSync('python3',['--version']).status!==0},async t=>{
  const dir=await project(t);
  const run=request=>JSON.parse(spawnSync('python3',['-c',REMOTE],{input:JSON.stringify(request),encoding:'utf8'}).stdout);
  const list=run({op:'list',path:dir});assert.deepEqual(list.entries.map(e=>e.name).sort(),['README.md','blob.bin','package.json','src']);
  assert.equal(run({op:'read',path:path.join(dir,'README.md')}).text,'# Demo\n');assert.equal(run({op:'read',path:path.join(dir,'blob.bin')}).binary,true);
  assert.deepEqual(run({op:'project',path:dir}).markers.sort(),['README.md','package.json']);assert.match(run({op:'list',path:path.join(dir,'missing')}).error,/No such file|cannot find/);
});
test('secret files are recognised so the Opaya Agent never reads them',()=>{
  for(const f of ['/home/u/.env','/p/.env.local','C:\\Users\\u\\.ssh\\id_ed25519','/x/server.pem','/h/.hermes/auth.json','/a/api_token.txt','/r/vault.json','/u/.npmrc'])assert.equal(isSecret(f),true,f);
  for(const f of ['/p/README.md','/p/src/index.js','/h/.hermes/config.yaml','/p/package.json'])assert.equal(isSecret(f),false,f);
});
test('restricted local reads check requested and resolved paths before opening files',{skip:process.platform==='win32'},async t=>{
  const dir=await project(t),p=name=>path.join(dir,name);
  await fs.writeFile(p('.netrc'),'fixture private content');
  await fs.symlink(p('.netrc'),p('notes.txt'));await fs.symlink(p('notes.txt'),p('chain.txt'));
  await fs.symlink(p('README.md'),p('auth.json'));await fs.symlink(p('README.md'),p('guide.txt'));
  const opened=[],open=fs.open;t.mock.method(fs,'open',async(...args)=>{opened.push(args[0]);return open(...args);});
  for(const name of ['.netrc','notes.txt','chain.txt','auth.json'])await assert.rejects(()=>browse({op:'read',path:p(name),allowSecrets:false}),/may contain secrets/);
  assert.deepEqual(opened,[]);
  const allowed=await browse({op:'read',path:p('guide.txt'),allowSecrets:false});assert.equal(allowed.text,'# Demo\n');assert.equal(allowed.path,p('README.md'));
  assert.equal((await browse({op:'read',path:p('notes.txt')})).text,'fixture private content','the Files panel can still show secrets');
});
test('restricted remote reads check requested and resolved paths',{skip:process.platform==='win32'||spawnSync('python3',['--version']).status!==0},async t=>{
  const dir=await project(t),p=name=>path.join(dir,name);
  await fs.writeFile(p('.netrc'),'fixture private content');
  await fs.symlink(p('.netrc'),p('notes.txt'));await fs.symlink(p('notes.txt'),p('chain.txt'));
  await fs.symlink(p('README.md'),p('auth.json'));await fs.symlink(p('README.md'),p('guide.txt'));
  const run=(name,allowSecrets=false)=>JSON.parse(spawnSync('python3',['-c',REMOTE],{input:JSON.stringify({op:'read',path:p(name),allowSecrets}),encoding:'utf8'}).stdout);
  for(const name of ['.netrc','notes.txt','chain.txt','auth.json']){const result=run(name);assert.match(result.error||'',/may contain secrets/);assert.equal(result.text,undefined);}
  assert.equal(run('guide.txt').text,'# Demo\n');assert.equal(run('guide.txt').path,p('README.md'));
  assert.equal(run('notes.txt',true).text,'fixture private content');
});
