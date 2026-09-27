'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');
const {temp}=require('./helpers.cjs');
const cli=require('../desktop/clone-cli.cjs');
const skip=process.platform==='win32'?'uses HOME and tar the POSIX way':false;
const write=async(file,text='x')=>{await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,text);};
const exists=file=>fs.stat(file).then(()=>true,()=>false);

test('a CLI clone copies settings, skills and memory but never chat history, and logins only when asked',{skip},async t=>{
  const src=await temp(t),dst=await temp(t),home=process.env.HOME;t.after(()=>{process.env.HOME=home;});
  for(const f of ['.claude/settings.json','.claude/CLAUDE.md','.claude/skills/deploy/SKILL.md','.claude/projects/p1/chat.jsonl','.claude/.credentials.json','.claude.json'])await write(path.join(src,f));
  await write(path.join(dst,'.claude/settings.json'),'old');
  process.env.HOME=src;
  const agent={id:'a1',name:'Claude',provider:'claude',protocol:'claude',transport:'local',command:'claude',args:[]};
  const copied=await cli.copy({agent,sourceHost:null,id:'claude',scope:'everything',keys:false,to:{host:null,container:''},dest:dst,backup:true,progress:()=>{}});
  assert.deepEqual(copied,['.claude']);
  assert.equal(await exists(path.join(dst,'.claude/skills/deploy/SKILL.md')),true);
  assert.equal(await exists(path.join(dst,'.claude/CLAUDE.md')),true);
  assert.equal(await exists(path.join(dst,'.claude/projects')),false,'chat history stays behind');
  assert.equal(await exists(path.join(dst,'.claude/.credentials.json')),false,'logins stay behind');
  assert.equal(await exists(path.join(dst,'.claude.json')),false);
  const kept=(await fs.readdir(dst)).find(n=>n.startsWith('.claude.before-clone-'));assert(kept,'what was there is kept');
  assert.equal(await fs.readFile(path.join(dst,kept,'settings.json'),'utf8'),'old');
});
test('a CLI agent cannot be cloned over itself, and API connections are not clones',()=>{
  assert.equal(cli.sameAccount({transport:'local',command:'claude'},null),true);
  assert.equal(cli.sameAccount({transport:'local',command:'claude'},{id:'vps'}),false);
  assert.equal(cli.sameAccount({transport:'ssh',hostId:'vps',command:'codex'},{id:'vps'}),true);
  return assert.rejects(cli.clone({agent:{id:'x',name:'DeepSeek',provider:'custom',protocol:'openai',transport:'http',endpoint:'https://api.deepseek.com/v1',command:'',args:[]},host:null,name:'c'}),/Opaya can clone Hermes/);
});
test('clone scopes pick only their parts',()=>{
  const p=cli.plan('codex','skills',false);
  assert.deepEqual(p.wanted,['.codex/config.toml','.codex/skills','.codex/prompts']);
  assert(p.excludes.includes('.codex/auth.json')&&p.excludes.includes('.codex/sessions'));
  assert(cli.plan('codex','memory',true).wanted.includes('.codex/auth.json'));
});
