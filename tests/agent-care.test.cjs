'use strict';
// Hermes and OpenClaw care: backups made by the agent itself, SQLite snapshots, OpenClaw's background updates, repairs
// and messaging channels.
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');const {execFileSync}=require('node:child_process');
const {temp}=require('./helpers.cjs');
const m=require('../desktop/maintenance.cjs');
const management=require('../desktop/management.cjs');
const updates=require('../desktop/updates.cjs');
const skip=process.platform==='win32'?'uses POSIX sh and tar':false;
const hermes={id:'h1',name:'Tuco',provider:'hermes',protocol:'acp',transport:'local',command:'hermes',args:['acp']};
const openclaw={id:'o1',name:'Claw',provider:'openclaw',protocol:'openai',transport:'local',command:'openclaw',args:[],endpoint:'http://127.0.0.1:18789/v1'};

// A home folder of its own whose ~/.local/bin (first on the PATH Opaya's scripts use) holds fake CLIs.
async function sandbox(t,bins){
  const root=await temp(t),bin=path.join(root,'.local','bin'),tmp=path.join(root,'tmp');
  await fs.mkdir(bin,{recursive:true});await fs.mkdir(tmp);
  for(const [name,body] of Object.entries(bins)){await fs.writeFile(path.join(bin,name),`#!/bin/sh\n${body}\n`,{mode:0o755});}
  const old={HOME:process.env.HOME,TMPDIR:process.env.TMPDIR};process.env.HOME=root;process.env.TMPDIR=tmp;
  t.after(()=>{for(const [k,v] of Object.entries(old)){if(v===undefined)delete process.env[k];else process.env[k]=v;}});
  return {root,tmp,dest:path.join(root,'backups')};
}
const leftovers=async tmp=>(await fs.readdir(tmp)).filter(n=>/^opaya-(backup|snap)\./.test(n));

test('a full OpenClaw backup is made by openclaw backup create --verify and copied here as it is',{skip},async t=>{
  const s=await sandbox(t,{openclaw:`case "$1 $2" in "backup create") [ "$3" = --help ] && exit 0; [ "$3" = --verify ] && [ "$4" = --output ] || exit 9; printf 'archive-bytes' > "$5/2026-10-11T08-00-00.000+00-00-openclaw-backup.tar.gz"; echo "Backup verified" ;; *) exit 1;; esac`});
  const steps=[];
  const r=await m.backup({agent:openclaw,host:null,dest:s.dest,progress:e=>e.message&&steps.push(e.message)});
  assert.equal(r.native,'openclaw backup create --verify');
  assert(r.file.startsWith(path.join(s.dest,'claw')+path.sep)&&r.file.endsWith('.tar.gz'));
  assert.equal(await fs.readFile(r.file,'utf8'),'archive-bytes');
  assert.equal((await fs.stat(r.file)).mode&0o777,0o600);
  const manifest=JSON.parse(await fs.readFile(r.file.replace(/\.tar\.gz$/,'.json'),'utf8'));
  assert.equal(manifest.contents.native,'openclaw backup create --verify');assert.match(manifest.contents.restore,/openclaw backup restore/);
  assert(steps.some(x=>/openclaw backup restore/.test(x)),'the last step says how to restore it');
  assert.deepEqual(await leftovers(s.tmp),[],'the archive on the source is removed');
  const list=await m.listBackups(openclaw,{backupDir:s.dest});assert.equal(list.backups[0].native,'openclaw backup create --verify');
});

test('a failed openclaw backup is an error, not a silent file copy',{skip},async t=>{
  const s=await sandbox(t,{openclaw:`[ "$3" = --help ] && exit 0; echo 'database is locked' >&2; exit 1`});
  await assert.rejects(()=>m.backup({agent:openclaw,host:null,dest:s.dest}),/openclaw backup create --verify failed: database is locked/);
  assert.deepEqual(await leftovers(s.tmp),[]);
});

test('without keys or history, or with an OpenClaw that has no backup command, Opaya copies the files',{skip},async t=>{
  const s=await sandbox(t,{openclaw:'exit 2'});
  for(const [f,c] of Object.entries({'.openclaw/openclaw.json':'{}','.openclaw/credentials/x.json':'secret','.openclaw/sessions/a.jsonl':'x'})){await fs.mkdir(path.dirname(path.join(s.root,f)),{recursive:true});await fs.writeFile(path.join(s.root,f),c);}
  const old=await m.backup({agent:openclaw,host:null,dest:s.dest});
  assert.equal(old.native,undefined);assert(old.file.endsWith('.tar.gz'));
  const files=execFileSync('tar',['-tzf',old.file],{encoding:'utf8'});assert.match(files,/\.openclaw\/openclaw\.json/);
  // A backup without keys never goes through openclaw backup (its archive always holds credentials).
  await fs.writeFile(path.join(s.root,'.local','bin','openclaw'),'#!/bin/sh\necho called >> "$HOME/called"\nexit 0\n',{mode:0o755});
  await new Promise(r=>setTimeout(r,1100));
  const slim=await m.backup({agent:openclaw,host:null,dest:s.dest,keys:false});
  assert.doesNotMatch(execFileSync('tar',['-tzf',slim.file],{encoding:'utf8'}),/credentials/);
  await assert.rejects(()=>fs.access(path.join(s.root,'called')));
});

test('a full Hermes backup is made by hermes backup (a .zip for hermes import), listed and deleted like the others',{skip},async t=>{
  const s=await sandbox(t,{hermes:`[ "$1" = backup ] || exit 1; [ "$2" = --help ] && exit 0; [ "$2" = -o ] || exit 9; [ "$HERMES_HOME" = "$HOME/hh" ] || exit 8; printf 'PK-zip' > "$3"`});
  const agent={...hermes,hermesHome:path.join(s.root,'hh')};
  const r=await m.backup({agent,host:null,dest:s.dest});
  assert.equal(r.native,'hermes backup');assert(r.file.endsWith('.zip'));
  assert.equal(await fs.readFile(r.file,'utf8'),'PK-zip');
  const settings={backupDir:s.dest},list=await m.listBackups(agent,settings);
  assert.deepEqual(list.backups.map(b=>[b.file,b.native,b.restore]),[[r.file,'hermes backup','hermes import <archive>']]);
  await m.removeBackup(r.file,settings);
  assert.deepEqual((await m.listBackups(agent,settings)).backups,[]);
  await assert.rejects(()=>fs.access(r.file.replace(/\.zip$/,'.json')));
  assert.deepEqual(await leftovers(s.tmp),[]);
});

test('a Hermes profile is copied by Opaya, with its chat database as a SQLite snapshot instead of the live files',{skip},async t=>{
  const s=await sandbox(t,{hermes:'echo "hermes backup must not run for a profile" >&2; exit 1'});
  try{execFileSync('python3',['-c','import sqlite3']);}catch{t.skip('python3 with sqlite3 is not available');return;}
  const home=path.join(s.root,'.hermes','profiles','writer');await fs.mkdir(home,{recursive:true});
  await fs.writeFile(path.join(home,'config.yaml'),'model: x');
  execFileSync('python3',['-c','import sqlite3,sys\nc=sqlite3.connect(sys.argv[1])\nc.execute("pragma journal_mode=wal")\nc.execute("create table t(x)")\nc.execute("insert into t values (42)")\nc.commit()\nc.close()',path.join(home,'state.db')]);
  await fs.writeFile(path.join(home,'state.db-wal'),'stale');await fs.writeFile(path.join(home,'state.db-shm'),'stale');
  const steps=[];
  const r=await m.backup({agent:{...hermes,name:'Writer',hermesHome:home},host:null,dest:s.dest,progress:e=>e.message&&steps.push(e.message)});
  assert.equal(r.native,undefined);
  assert(steps.some(x=>/online backup/.test(x)));
  const out=path.join(s.root,'x');await fs.mkdir(out);execFileSync('tar',['-xzf',r.file,'-C',out]);
  assert.deepEqual((await fs.readdir(out)).sort(),['config.yaml','state.db']);
  assert.equal(execFileSync('python3',['-c','import sqlite3,sys\nprint(sqlite3.connect(sys.argv[1]).execute("select x from t").fetchone()[0])',path.join(out,'state.db')],{encoding:'utf8'}).trim(),'42');
  assert.deepEqual(await leftovers(s.tmp),[]);
});

test('OpenClaw updates wait when the updater answers 75 (accepted, still running)',{skip},async t=>{
  const s=await sandbox(t,{});
  const inner=execFileSync('sh',['-c',`printf %s ${updates.script('openclaw').replace(/^sh -c /,'')}`],{encoding:'utf8'});
  const fn=name=>inner.split('\n').find(l=>l.startsWith(`${name}(){`));
  assert(fn('oc_up'),'the update script defines oc_up');
  const run=(env)=>{try{return {code:0,out:execFileSync('sh',['-c',`${fn('say')}\n${fn('oc_up')}\nsleep(){ :; }\noc_up`],{encoding:'utf8',env:{...process.env,...env}})};}catch(e){return {code:e.status,out:String(e.stdout)};}};
  await fs.writeFile(path.join(s.root,'.local','bin','openclaw'),`#!/bin/sh
n=$(cat "$HOME/n" 2>/dev/null || echo 0)
case "$1 $2" in
  "update --yes") exit $RC;;
  "update status") if [ "$3" = --json ]; then n=$((n+1)); echo $n > "$HOME/n"; if [ $n -lt 3 ]; then echo '{"lastRun": {"status": "running"}}'; else echo "{\\"lastRun\\": {\\"status\\": \\"$END\\"}}"; fi; else echo 'Last update: done'; fi;;
esac
`,{mode:0o755});
  const PATH=`${path.join(s.root,'.local','bin')}:${process.env.PATH}`;
  const ok=run({PATH,RC:'75',END:'succeeded'});assert.equal(ok.code,0);assert.match(ok.out,/finishes it in the background/);assert.match(ok.out,/Last update: done/);
  await fs.rm(path.join(s.root,'n'));
  const bad=run({PATH,RC:'75',END:'rolled-back'});assert.equal(bad.code,1);assert.match(bad.out,/openclaw update repair --yes/);
  assert.equal(run({PATH,RC:'0',END:'x'}).code,0);
  assert.equal(run({PATH,RC:'1',END:'x'}).code,1,'other exit codes stay failures');
  assert.match(updates.plan('openclaw','installer'),/openclaw update --yes/);
  assert.match(updates.script('openclaw',{windows:true}),/\$LASTEXITCODE -eq 75/);
});

test('repairs run the agent\'s own tools where it runs',()=>{
  assert.equal(management.repairCommand({...hermes,hermesHome:'/home/me/.hermes/profiles/w'}).command,"HERMES_HOME='/home/me/.hermes/profiles/w' hermes doctor --fix");
  assert.equal(management.repairCommand(openclaw).command,'openclaw update status; openclaw update repair --yes; openclaw doctor --fix');
  const box={...openclaw,command:'docker',args:['exec','-i','opaya-claw','openclaw']};
  assert.equal(management.repairCommand(box,{remote:true}).command.split('; ')[1],'docker exec -it opaya-claw openclaw update repair --yes');
  const hbox={...hermes,command:'docker',args:['exec','-i','opaya-h','hermes','acp'],hermesHome:'/opt/data'};
  assert.equal(management.channelSetupCommand(hbox,{remote:true}),'docker exec -it -e HOME=/opt/data -e HERMES_HOME=/opt/data -w /opt/data opaya-h hermes gateway setup');
  assert.equal(management.channelSetupCommand({...hermes,command:'C:\\Hermes\\hermes.exe',hermesHome:'C:\\Users\\me\\.hermes'},{windows:true}),"$env:HERMES_HOME='C:\\Users\\me\\.hermes'; & 'C:\\Hermes\\hermes.exe' gateway setup");
  assert.equal(management.channelSetupCommand(openclaw),'openclaw channels add');
  assert.deepEqual(management.cliArgs(box,['channels','list','--json']),['exec','-i','opaya-claw','openclaw','channels','list','--json']);
  assert.throws(()=>management.repairCommand({...hermes,provider:'claude'}),/Hermes and OpenClaw/);
  assert.throws(()=>management.repairCommand({...openclaw,command:''}),/no CLI/);
});

test('messaging channels are read from openclaw channels list --json and hermes status --full',()=>{
  const oc=management.parseOpenclawChannels('[plugins] loaded\n'+JSON.stringify({channels:[
    {id:'telegram',label:'Telegram',installed:true,accounts:[{accountId:'default',installed:true,configured:true,enabled:true},{accountId:'work',configured:true,enabled:false}]},
    {id:'discord',label:'Discord',installed:true,configured:false}]}));
  assert.deepEqual(oc.map(c=>[c.name,c.connected,c.detail]),[['Telegram',true,'configured'],['Telegram (work)',false,'disabled'],['Discord',false,'not configured']]);
  assert.equal(management.parseOpenclawChannels('no json here'),null);
  const status=['\u25c6 Gateway Service','  Status:       \u2713 running','','\x1b[36m\u25c6 Messaging Platforms\x1b[0m','  Telegram      \x1b[32m\u2713\x1b[0m configured (home: 123)','  Slack         \u2717 not configured','','\u25c6 Cron','  Jobs:  2'].join('\n');
  assert.deepEqual(management.parseHermesChannels(status),[{id:'telegram',name:'Telegram',connected:true,detail:'configured (home: 123)'},{id:'slack',name:'Slack',connected:false,detail:'not configured'}]);
  assert.equal(management.parseHermesChannels('Hermes Agent v0.1'),null);
});

test('an older Hermes without status --full is read with its plain status',async()=>{
  const calls=[],status='◆ Messaging Platforms\n  Telegram      ✓ configured\n';
  const run=async args=>{calls.push(args.join(' '));if(args.includes('--full'))throw Object.assign(new Error('usage: hermes [-h] [--version]\nhermes: error: unrecognized arguments: --full'),{stdout:''});return status;};
  const r=await management.channels({...hermes,command:'docker',args:['exec','-i','tuco','hermes','acp']},null,{run});
  assert.deepEqual(calls,['exec -i tuco hermes status --full','exec -i tuco hermes status']);
  assert.deepEqual(r.channels.map(c=>c.name),['Telegram']);
  await assert.rejects(()=>management.channels(hermes,null,{run:async()=>{throw new Error('usage: hermes [-h]');}}),/did not report its messaging platforms/);
});
