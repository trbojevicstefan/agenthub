'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {temp}=require('./helpers.cjs');
const {transfer}=require('../desktop/clone.cjs');
const {backup}=require('../desktop/maintenance.cjs');
const {findExecutable,environment}=require('../desktop/process.cjs');
const skip=process.platform==='win32'?'uses POSIX sh and tar':false;

async function fixture(t,remote){
  const root=await temp(t),source=path.join(root,"source's files"),dest=path.join(root,'destination');
  await fs.mkdir(source);
  const names=['--use-compress-program=false','--exclude=keep.txt','-C','--','keep.txt',"a'b file.txt"];
  for(const name of names)await fs.writeFile(path.join(source,name),`Contents of ${name}`);
  let host=null;
  if(remote){
    const bin=path.join(root,'bin'),ssh=path.join(bin,'ssh');
    await fs.mkdir(bin);
    // Execute the generated remote command locally. No SSH connection is made.
    await fs.writeFile(ssh,'#!/bin/sh\nfor last; do :; done\nexec /bin/sh -c "$last"\n',{mode:0o755});
    const oldPath=process.env.PATH;process.env.PATH=`${bin}:${oldPath}`;
    t.after(()=>{process.env.PATH=oldPath;});
    assert.equal(findExecutable('ssh',environment()),ssh);
    host={name:'Fixture',hostname:'fixture.invalid',username:'fixture',port:22};
  }
  return {root,source,dest,names,host};
}

for(const remote of [false,true]){
  const location=remote?'remote':'local';
  test(`${location} transfers preserve option-like filenames and apply exclusions`,{skip},async t=>{
    const {source,dest,names,host}=await fixture(t,remote);
    await fs.mkdir(path.join(source,'nested'));
    await fs.writeFile(path.join(source,'nested','keep.txt'),'nested content');
    await fs.writeFile(path.join(source,'nested','omit.log'),'excluded');
    await transfer({host},source,[...names,'nested'],{},dest,{excludes:['*.log']});
    assert.deepEqual((await fs.readdir(dest)).sort(),[...names,'nested'].sort());
    for(const name of names)assert.equal(await fs.readFile(path.join(dest,name),'utf8'),`Contents of ${name}`);
    assert.deepEqual(await fs.readdir(path.join(dest,'nested')),['keep.txt']);
    assert.equal(await fs.readFile(path.join(dest,'nested','keep.txt'),'utf8'),'nested content');
  });
  test(`${location} backups preserve option-like filenames`,{skip},async t=>{
    const {root,source,dest,names,host}=await fixture(t,remote);
    const agent={id:'fixture',name:'Fixture',provider:'hermes',protocol:'acp',transport:remote?'ssh':'local',command:'hermes',args:[],hermesHome:source};
    const result=await backup({agent,host,dest:path.join(root,'backups')});
    await fs.mkdir(dest);
    execFileSync('tar',['-xzf',result.file,'-C',dest]);
    assert.deepEqual((await fs.readdir(dest)).sort(),names.slice().sort());
    for(const name of names)assert.equal(await fs.readFile(path.join(dest,name),'utf8'),`Contents of ${name}`);
  });
}
