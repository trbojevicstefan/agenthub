'use strict';
// Every command Opaya types into a terminal must be valid for the shell it runs in: POSIX sh on macOS, Linux and
// servers, PowerShell on Windows. The POSIX set is checked with sh -n (and bash -n) wherever those exist; the
// PowerShell set with PowerShell's own parser wherever PowerShell exists (the Windows build runs this).
const {test}=require('node:test');const assert=require('node:assert/strict');const {execFileSync}=require('node:child_process');
const catalog=require('../desktop/catalog.cjs');const maintenance=require('../desktop/maintenance.cjs');const guide=require('../desktop/guide.cjs');const containers=require('../desktop/containers.cjs');
const {findExecutable,environment}=require('../desktop/process.cjs');
const AGENTS=[
  {id:'x1',name:'Hermes',provider:'hermes',protocol:'acp',transport:'local',command:'hermes',args:[]},
  {id:'x2',name:'Claude',provider:'claude',protocol:'claude',transport:'local',command:'claude',args:[]},
  {id:'x3',name:'Codex',provider:'codex',protocol:'codex',transport:'local',command:'codex',args:[]},
  {id:'x4',name:'Gemini',provider:'custom',protocol:'acp',transport:'local',command:'gemini',args:['--acp']},
  {id:'x5',name:'OpenCode',provider:'custom',protocol:'acp',transport:'local',command:'opencode',args:['acp']}
];
function commands(windows){
  const out=[],add=(name,text)=>{if(text)out.push({name,text});};
  for(const f of catalog.FRAMEWORKS)add(`install ${f.id}`,windows?f.windows:f.posix);
  for(const [id,u] of Object.entries(catalog.UPDATES))add(`update ${id}`,windows?u.windows:u.posix);
  if(!windows)add('essentials (machine)',catalog.command('essentials',{remote:true}).command);
  else add('essentials (Windows)',['node','python','git','uv'].map(id=>`& {${catalog.FRAMEWORKS.find(f=>f.id===id).windows}}`).join('; '));
  for(const a of AGENTS){
    for(const [label,fn] of [['update',()=>maintenance.updateCommand(a,{remote:false,windows})],['uninstall',()=>maintenance.uninstallCommand(a,{remote:false,windows,data:true})]]){
      let c;try{c=fn();}catch{continue;}add(`${label} ${a.name}`,c.command);
    }
  }
  for(const [id,a] of Object.entries(guide.AGENTS))if(a.signIn)add(`sign in ${id}`,guide.withPath(windows?a.signIn.windows:a.signIn.posix,{windows}));
  add('guide step',guide.marked('install-node-1',guide.withPath(windows?catalog.FRAMEWORKS.find(f=>f.id==='node').windows:catalog.FRAMEWORKS.find(f=>f.id==='node').posix,{windows}),{windows}));
  if(!windows)for(const id of Object.keys(containers.PLANS))add(`docker ${id}`,containers.plan(id,{name:'test'}).command);
  return out;
}
test('every POSIX command parses in sh and bash',{skip:process.platform==='win32'?'no POSIX shell on Windows':false},()=>{
  const list=commands(false),bad=[];
  for(const shell of ['sh','bash'].filter(s=>findExecutable(s,environment())))for(const c of list){try{execFileSync(shell,['-n','-c',c.text],{stdio:'pipe'});}catch(e){bad.push(`${shell}: ${c.name}: ${String(e.stderr||e.message).trim().slice(0,200)}`);}}
  assert.deepEqual(bad,[]);assert(list.length>40,`checked ${list.length} commands`);
});
const ps=findExecutable('powershell.exe',environment())||findExecutable('powershell',environment())||findExecutable('pwsh',environment());
test('every Windows command parses in PowerShell',{skip:ps?false:'PowerShell is not installed here (the Windows build checks this)'},()=>{
  const list=commands(true);
  const script="$list = $env:OPAYA_COMMANDS | ConvertFrom-Json; foreach ($c in $list) { $errors = $null; [void][System.Management.Automation.Language.Parser]::ParseInput($c.text, [ref]$null, [ref]$errors); if ($errors.Count) { Write-Output ($c.name + ': ' + $errors[0].Message) } }";
  const out=execFileSync(ps,['-NoProfile','-NonInteractive','-Command',script],{env:{...process.env,OPAYA_COMMANDS:JSON.stringify(list)},encoding:'utf8'}).trim();
  assert.equal(out,'');assert(list.length>25,`checked ${list.length} commands`);
});
test('the setup guide only offers what each platform can install',()=>{
  for(const [id] of Object.entries(guide.AGENTS)){const f=catalog.FRAMEWORKS.find(x=>x.id===id);assert(f&&f.posix&&f.windows,`${id} installs on every platform`);}
  for(const g of Object.values(guide.GOALS))for(const id of g.tools){const f=catalog.FRAMEWORKS.find(x=>x.id===id);assert(f&&f.posix&&f.windows,`${id} installs on every platform`);}
  // Codex needs Node.js and Claude Code on Windows needs Git: both come first in any plan.
  for(const platform of ['darwin','win32','linux']){
    const steps=guide.plan({way:'chatgpt',goals:['all'],agents:['claude','gemini-cli','opencode'],facts:{tools:{},signedIn:{}},platform}).map(s=>s.tool);
    assert(steps.indexOf('node')<steps.indexOf('codex'));if(platform==='win32')assert(steps.indexOf('git')<steps.indexOf('claude'));
  }
});
