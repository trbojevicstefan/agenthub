'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');

test('create, read, edit, share and remove an agent\'s skills on this computer',{skip:process.platform==='win32'},async()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'opaya-skills-')),old=process.env.HOME;process.env.HOME=home;
  try{
    const moves=require('../desktop/transfer.cjs'),{listSkills}=require('../desktop/skills.cjs');
    const claude={id:'c',name:'Claude',provider:'claude',transport:'local',command:'claude',args:[]};
    const codex={id:'x',name:'Codex',provider:'codex',transport:'local',command:'codex',args:[]};
    const opencode={id:'o',name:'OpenCode',provider:'custom',transport:'local',command:'opencode',args:['acp']};
    await assert.rejects(moves.createSkill({agent:claude,host:null,name:'Bad Name!'}),/short name/);
    const c=await moves.createSkill({agent:claude,host:null,name:'release-notes',description:'Write release notes: short',body:'# Steps\n1. Read the log'});
    assert.equal(c.path,path.join(home,'.claude','skills','release-notes','SKILL.md'));
    await assert.rejects(moves.createSkill({agent:claude,host:null,name:'release-notes'}),/already has/);
    const r=await moves.readSkill({agent:claude,host:null,name:'release-notes'});
    assert.match(r.content,/^---\nname: release-notes\ndescription: "Write release notes: short"\n---/);
    await moves.saveSkill({agent:claude,host:null,name:'release-notes',content:r.content.replace('Read the log','Read git log')});
    assert.match(fs.readFileSync(c.path,'utf8'),/Read git log/);
    await moves.createSkill({agent:claude,host:null,name:'deploy',description:'Deploy'});
    const share=await moves.shareSkills({source:claude,sourceHost:null,targets:[{agent:codex,host:null,step:'t0'},{agent:opencode,host:null,step:'t1'}],names:['release-notes','deploy']});
    assert.deepEqual(share.agents,['Codex','OpenCode']);
    assert.deepEqual((await listSkills(codex,null)).skills.map(s=>s.name),['deploy','release-notes']);
    assert.deepEqual((await listSkills(opencode,null)).skills.map(s=>s.name),['deploy','release-notes']);
    const rm=await moves.removeSkills({agent:claude,host:null,names:['deploy','nope']});
    assert.deepEqual(rm.removed,['deploy']);assert.deepEqual(rm.skipped,[{name:'nope',why:'not found'}]);
    assert.ok(fs.existsSync(path.join(rm.bin,'deploy','SKILL.md')));
    assert.deepEqual((await listSkills(claude,null)).skills.map(s=>s.name),['release-notes']);
  }finally{process.env.HOME=old;}
});
