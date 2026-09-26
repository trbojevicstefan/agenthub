'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');const crypto=require('node:crypto');const {execFileSync}=require('node:child_process');const {Readable}=require('node:stream');
const {temp}=require('./helpers.cjs');const t=require('../desktop/toolchain.cjs');
const skip=process.platform==='win32'?'builds POSIX archives':false;
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
async function archive(root,top,files){const src=path.join(root,'src');await fs.rm(src,{recursive:true,force:true});for(const [f,c] of Object.entries(files)){const p=path.join(src,top,f);await fs.mkdir(path.dirname(p),{recursive:true});await fs.writeFile(p,c,{mode:0o755});}const out=path.join(root,`${top||'a'}.tar.gz`);execFileSync('tar',['-czf',out,'-C',src,'.']);return fs.readFile(out);}
// A stand-in for fetch: fixed answers per URL, GitHub's releases/latest as a redirect.
function net(routes){const seen=[];return {seen,fetch:async(url,init={})=>{seen.push(url);const r=routes[url];if(r===undefined)return {ok:false,status:404,headers:{get:()=>null}};
  if(r&&r.redirect)return {ok:false,status:302,headers:{get:k=>k==='location'?r.redirect:null}};
  const body=Buffer.isBuffer(r)?r:Buffer.from(typeof r==='string'?r:JSON.stringify(r));
  return {ok:true,status:200,headers:{get:k=>k==='content-length'?String(body.length):null},json:async()=>JSON.parse(body),text:async()=>body.toString(),body:Readable.from([body])};}};}
test('the right official file is chosen for every computer',()=>{
  const index=[{version:'v25.1.0',lts:false},{version:'v24.21.0',lts:'Krypton'}];
  assert.equal(t.nodeAsset(index,{platform:'win32',arch:'arm64'}).file,'node-v24.21.0-win-arm64.zip','LTS, not the newest');
  assert.equal(t.nodeAsset(index,{platform:'darwin',arch:'arm64'}).url,'https://nodejs.org/dist/v24.21.0/node-v24.21.0-darwin-arm64.tar.gz');
  assert.equal(t.nodeAsset(index,{platform:'linux',arch:'x64'}).layout.from,'node-v24.21.0-linux-x64');
  assert.equal(t.githubAsset('git','v2.55.0.windows.5',{platform:'win32',arch:'x64'}).file,'PortableGit-2.55.0.5-64-bit.7z.exe');
  assert.equal(t.githubAsset('git','v2.51.0.windows.1',{platform:'win32',arch:'arm64'}).file,'PortableGit-2.51.0-arm64.7z.exe');
  assert.equal(t.githubAsset('gh','v2.101.0',{platform:'darwin',arch:'x64'}).file,'gh_2.101.0_macOS_amd64.zip');
  assert.equal(t.githubAsset('uv','0.12.19',{platform:'win32',arch:'x64'}).file,'uv-x86_64-pc-windows-msvc.zip');
  const sums=`${'a'.repeat(64)}  cpython-3.13.15+20260924-aarch64-apple-darwin-install_only_stripped.tar.gz\n${'b'.repeat(64)}  cpython-3.13.15+20260924-aarch64-apple-darwin-install_only.tar.gz\n`;
  const py=t.githubAsset('python','20260924',{platform:'darwin',arch:'arm64',sums});
  assert.equal(py.file,'cpython-3.13.15+20260924-aarch64-apple-darwin-install_only.tar.gz');assert.equal(t.checksumFrom(sums,py.file),'b'.repeat(64),'the checksum on the same line');
  assert.equal(t.supports('git','linux'),false,'Linux gets Git from its package manager');assert.equal(t.supports('git','darwin'),true);
});
test('Node.js with npm is downloaded, verified, unpacked into Opaya\'s tools folder; a wrong checksum installs nothing',{skip},async t_=>{
  const root=await temp(t_),tools=path.join(root,'tools'),tgz=await archive(root,'node-v24.21.0-linux-x64',{'bin/node':'#!/bin/sh\necho v24.21.0\n','bin/npm':'#!/bin/sh\necho 11.0.0\n'});
  const routes={'https://nodejs.org/dist/index.json':[{version:'v24.21.0',lts:'Krypton'}],'https://nodejs.org/dist/v24.21.0/SHASUMS256.txt':`${sha(tgz)}  node-v24.21.0-linux-x64.tar.gz\n`,'https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.gz':tgz};
  const steps=[],r=await t.install('node',{platform:'linux',arch:'x64',root:tools,persist:false,fetchImpl:net(routes).fetch,progress:e=>steps.push(e)});
  assert.equal(r.version,'v24.21.0');assert.equal(execFileSync(path.join(tools,'node','bin','npm')).toString().trim(),'11.0.0');
  assert(steps.some(e=>e.bytes===tgz.length),'download progress is reported');
  assert.deepEqual((await fs.readdir(tools)).sort(),['node'],'no staging folder is left behind');
  routes['https://nodejs.org/dist/v24.21.0/SHASUMS256.txt']=`${'0'.repeat(64)}  node-v24.21.0-linux-x64.tar.gz\n`;
  await fs.rm(path.join(tools,'node'),{recursive:true});
  await assert.rejects(()=>t.install('node',{platform:'linux',arch:'x64',root:tools,persist:false,fetchImpl:net(routes).fetch}),/did not match its official checksum/);
  assert.deepEqual(await fs.readdir(tools),[],'nothing was installed');
  delete routes['https://nodejs.org/dist/v24.21.0/SHASUMS256.txt'];
  await assert.rejects(()=>t.install('node',{platform:'linux',arch:'x64',root:tools,persist:false,fetchImpl:net(routes).fetch}),/answered 404/);
});
test('GitHub tools come from the releases/latest redirect, not the rate-limited API, and land in tools/bin',{skip},async t_=>{
  const root=await temp(t_),tools=path.join(root,'tools'),tgz=await archive(root,'gh_2.101.0_linux_amd64',{'bin/gh':'#!/bin/sh\necho gh version 2.101.0\n','LICENSE':'x'});
  const n=net({'https://github.com/cli/cli/releases/latest':{redirect:'https://github.com/cli/cli/releases/tag/v2.101.0'},
    'https://github.com/cli/cli/releases/download/v2.101.0/gh_2.101.0_checksums.txt':`${sha(tgz)}  gh_2.101.0_linux_amd64.tar.gz\n`,
    'https://github.com/cli/cli/releases/download/v2.101.0/gh_2.101.0_linux_amd64.tar.gz':tgz});
  await t.install('gh',{platform:'linux',arch:'x64',root:tools,persist:false,fetchImpl:n.fetch});
  assert.equal(execFileSync(path.join(tools,'bin','gh')).toString().trim(),'gh version 2.101.0');
  assert(!n.seen.some(u=>u.includes('api.github.com')),'no GitHub API calls');
});
test('PATH is added once to the shell profiles, and updated in place',{skip},async t_=>{
  const home=await temp(t_),root=path.join(home,'.opaya','tools');await fs.writeFile(path.join(home,'.bashrc'),'alias ll="ls -l"');
  const first=await t.persistPath({platform:'linux',root,home});assert.deepEqual(first.files.map(f=>path.basename(f)).sort(),['.bashrc','.profile'],'.profile is created; .zshrc only if it exists');
  const bashrc=await fs.readFile(path.join(home,'.bashrc'),'utf8');
  assert.match(bashrc,/^alias ll="ls -l"\n# >>> Opaya tools >>>\nexport PATH="\$HOME\/\.opaya\/tools\/node\/bin:\$HOME\/\.opaya\/tools\/python\/bin:\$HOME\/\.opaya\/tools\/bin:\$PATH"\n# <<< Opaya tools <<<\n$/);
  assert.deepEqual((await t.persistPath({platform:'linux',root,home})).files,[],'nothing changes the second time');
  execFileSync('sh',['-n',path.join(home,'.profile')]);
});
