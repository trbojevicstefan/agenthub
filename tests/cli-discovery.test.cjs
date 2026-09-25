'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');const {execFileSync}=require('node:child_process');
const {temp}=require('./helpers.cjs');
const {cmdShimTarget}=require('../desktop/process.cjs');
const skip=process.platform==='win32'?'uses POSIX shell scripts as fake CLIs':false;

test('Windows .cmd shims from npm and pnpm resolve to the real program',async t=>{
  const dir=await temp(t);
  const files={'node_modules/@google/gemini-cli/bundle/gemini.js':'','node_modules/opencode-ai/bin/opencode.exe':''};
  for(const f of Object.keys(files)){await fs.mkdir(path.dirname(path.join(dir,f)),{recursive:true});await fs.writeFile(path.join(dir,f),'');}
  // What npm's cmd-shim writes for a Node script and for an .exe.
  await fs.writeFile(path.join(dir,'gemini.cmd'),'@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@google\\gemini-cli\\bundle\\gemini.js" %*\r\n');
  await fs.writeFile(path.join(dir,'opencode.cmd'),'@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe"   %*\r\n');
  await fs.writeFile(path.join(dir,'missing.cmd'),'"%dp0%\\node_modules\\gone\\cli.js" %*\r\n');
  assert.equal(cmdShimTarget(path.join(dir,'gemini.cmd')),path.join(dir,'node_modules','@google','gemini-cli','bundle','gemini.js'));
  assert.equal(cmdShimTarget(path.join(dir,'opencode.cmd')),path.join(dir,'node_modules','opencode-ai','bin','opencode.exe'));
  assert.equal(cmdShimTarget(path.join(dir,'missing.cmd')),null,'a shim whose target is gone is not used');
});

// Runs discovery in a fresh process with the bare PATH a macOS GUI app gets, so nothing leaks from the test runner.
function scanIn(home,shell='/bin/sh'){
  const script=`require(${JSON.stringify(path.join(__dirname,'../desktop/discovery.cjs'))}).scanLocal({home:process.env.HOME,probe:false}).then(r=>process.stdout.write(JSON.stringify(r.agents.filter(a=>a.protocol!=='openai').map(({name,provider,protocol,command,args,avatar})=>({name,provider,protocol,command,args,avatar})))))`;
  return JSON.parse(execFileSync(process.execPath,['-e',script],{env:{HOME:home,PATH:'/usr/bin:/bin',SHELL:shell},encoding:'utf8',timeout:60000}));
}
async function fakeCli(dir,name,help=''){await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,name),`#!/bin/sh\necho ${JSON.stringify(help)}\n`,{mode:0o755});}

test('discovery finds Codex, Gemini CLI and OpenCode installed with nvm, which a GUI app does not have on PATH',{skip},async t=>{
  const home=await temp(t),bin=path.join(home,'.nvm','versions','node','v22.11.0','bin');
  await fakeCli(bin,'codex');await fakeCli(bin,'gemini','  --acp  Starts the agent in ACP mode');await fakeCli(bin,'opencode');
  const found=scanIn(home);
  const by=name=>found.find(a=>a.name===name);
  assert.deepEqual(by('Codex CLI'),{name:'Codex CLI',provider:'codex',protocol:'codex',command:path.join(bin,'codex'),args:[]});
  assert.deepEqual(by('Gemini CLI'),{name:'Gemini CLI',provider:'custom',protocol:'acp',command:path.join(bin,'gemini'),args:['--acp'],avatar:'lib:gemini-cli'});
  assert.deepEqual(by('OpenCode'),{name:'OpenCode',provider:'custom',protocol:'acp',command:path.join(bin,'opencode'),args:['acp'],avatar:'lib:opencode'});
});
test('discovery reads the login shell PATH, and uses --experimental-acp for an older Gemini CLI',{skip},async t=>{
  const home=await temp(t),bin=path.join(home,'tools','bin');
  await fakeCli(bin,'gemini','  --experimental-acp  Starts the agent in ACP mode');await fakeCli(bin,'codex');
  // Only the login profile knows about this folder.
  await fs.writeFile(path.join(home,'.profile'),`PATH="${bin}:$PATH"; export PATH\n`);
  const found=scanIn(home,'/bin/sh');
  assert.equal(found.find(a=>a.name==='Codex CLI')?.command,path.join(bin,'codex'));
  assert.deepEqual(found.find(a=>a.name==='Gemini CLI')?.args,['--experimental-acp']);
});
