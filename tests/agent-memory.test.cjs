'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawn}=require('node:child_process');
const mem=require('../desktop/agent-memory.cjs');
const {collect}=require('../desktop/process.cjs');
const tmp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'opaya-mem-'));

test('every supported agent has a personality, about-you and memory entry',()=>{
  for(const fw of Object.keys(mem.FRAMEWORKS)){
    const kinds=mem.spec(fw).entries.map(e=>e.kind);
    for(const k of ['personality','user','memory'])assert.ok(kinds.includes(k),`${fw} has ${k}`);
  }
  assert.equal(mem.spec('hermes').entries.find(e=>e.id==='personality').file,'SOUL.md');
  assert.equal(mem.spec('openclaw').entries.find(e=>e.id==='personality').file,'SOUL.md');
  assert.equal(mem.spec('claude').entries.find(e=>e.id==='personality').block,'personality');
  assert.equal(mem.supported('aider'),false);
});

test('marked sections are added, replaced and removed without touching the rest',()=>{
  let t=mem.writeBlock('# Mine\nkeep\n','personality','Be calm.');
  assert.match(t,/^# Mine\nkeep\n\n<!-- opaya:personality -->/);
  assert.equal(mem.readBlock(t,'personality'),'Be calm.');
  t=mem.writeBlock(t,'personality','Be kind.');
  assert.equal(mem.readBlock(t,'personality'),'Be kind.');
  assert.equal(t.match(/<!-- opaya:personality -->/g).length,1);
  assert.equal(mem.stripBlocks(t,['personality','user']),'# Mine\nkeep\n');
  assert.equal(mem.keepBlocks('# New\n',t,['personality']).includes('Be kind.'),true);
  assert.equal(mem.readBlock(mem.writeBlock(t,'personality',''),'personality'),null);
});

test('files on this computer: write, read, keep sections, back up',async()=>{
  const home=tmp(),io=await mem.ioFor('claude',{args:[]},{local:true,home,env:{}});
  await mem.write('claude',io,'instructions','# Rules\n- tests first\n');
  await mem.write('claude',io,'personality','Short answers.');
  await mem.write('claude',io,'instructions','# Rules\n- tests first\n- small commits\n');
  const r=await mem.read('claude',io),get=id=>r.entries.find(e=>e.id===id);
  assert.equal(get('instructions').content,'# Rules\n- tests first\n- small commits\n');
  assert.equal(get('personality').content,'Short answers.');
  assert.equal(get('user').exists,false);
  const file=fs.readFileSync(path.join(home,'.claude','CLAUDE.md'),'utf8');
  assert.match(file,/small commits[\s\S]*opaya:personality/);
  assert.ok(fs.existsSync(path.join(home,'.claude','CLAUDE.md.opaya-bak')));
  const h=await mem.ioFor('hermes',{args:[],hermesHome:path.join(home,'h')},{local:true,home,env:{}});
  await mem.write('hermes',h,'memory','likes tea\n§\nuses vim');
  assert.equal(fs.readFileSync(path.join(home,'h','memories','MEMORY.md'),'utf8'),'likes tea\n§\nuses vim');
  const oc=await mem.ioFor('openclaw',{args:['--profile','work']},{local:true,home,env:{}});
  assert.equal(oc.root,path.join(home,'.openclaw-work','workspace'));
});

test('files where the agent runs, through a shell, with notes',{skip:process.platform==='win32'},async()=>{
  const home=tmp(),run=(s,input='')=>collect(spawn('/bin/sh',['-c',s],{env:{...process.env,HOME:home}}),{input,timeout:15000});
  const io=mem.shellIo(mem.rootShell('openclaw',{args:[]},{}),run);
  await mem.write('openclaw',io,'personality','Ćao! "quotes" $HOME `x`\n');
  await mem.writeNote('openclaw',io,'2026-10-16.md','did things');
  await assert.rejects(mem.writeNote('openclaw',io,'../x.md','no'));
  const r=await mem.read('openclaw',io);
  assert.equal(r.entries.find(e=>e.id==='personality').content,'Ćao! "quotes" $HOME `x`\n');
  assert.equal(r.root,path.join(home,'.openclaw','workspace'));
  assert.deepEqual(r.notes.map(n=>n.name),['2026-10-16.md']);
  assert.equal((await mem.readNote('openclaw',io,'2026-10-16.md')).content,'did things');
  assert.equal(mem.rootShell('hermes',{args:[]},{container:'c1'}),'/opt/data');
});
