'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const sch=require('../desktop/schedules.cjs');
const at=(y,mo,d,h,mi)=>new Date(y,mo-1,d,h,mi);
test('cron: fields, lists, ranges, steps, names, macros and the day-of-month / weekday rule',()=>{
  assert(sch.matches('0 9 * * 1-5',at(2026,10,5,9,0)));assert(!sch.matches('0 9 * * 1-5',at(2026,10,4,9,0)),'Sunday');
  assert(sch.matches('*/15 * * * *',at(2026,1,1,3,45)));assert(!sch.matches('*/15 * * * *',at(2026,1,1,3,44)));
  assert(sch.matches('30 8 * * mon,wed',at(2026,10,7,8,30)));assert(sch.matches('0 0 * * 7',at(2026,10,4,0,0)),'7 is Sunday');
  assert(sch.matches('@daily',at(2026,3,3,0,0)));
  assert(sch.matches('0 12 1 * 1',at(2026,6,1,12,0))&&sch.matches('0 12 1 * 1',at(2026,6,8,12,0)),'either day field');
  assert.deepEqual(sch.next('0 9 * * 1-5',at(2026,10,3,10,0)),at(2026,10,5,9,0));
  assert.throws(()=>sch.parse('0 25 * * *'),/out of range/);assert.throws(()=>sch.parse('every day'),/five fields/);
});
test('schedules in words, and a schedule needs who, what and when',()=>{
  assert.equal(sch.describe('0 9 * * *'),'Every day at 09:00');assert.equal(sch.describe('30 7 * * 1-5'),'Weekdays at 07:30');assert.equal(sch.describe('*/10 * * * *'),'Every 10 minutes');
  assert.equal(sch.describe('0 18 * * 5'),'Every Friday at 18:00');assert.equal(sch.describe('0 * * * *'),'Every hour');
  const s=sch.schedule({agentId:'a1',cron:'0 9 * * *',prompt:'Summarise new leads\nand send them'});assert.equal(s.name,'Summarise new leads');assert.equal(s.enabled,true);
  assert.throws(()=>sch.schedule({agentId:'a1',cron:'0 9 * * *',prompt:''}),/what it should do/);assert.throws(()=>sch.schedule({cron:'0 9 * * *',prompt:'x'}),/who runs/);
});
const cron=require('../desktop/agent-cron.cjs');
test("an agent's own schedules are read with its own CLI, profile and home",()=>{
  assert.equal(cron.hermesCli({provider:'hermes',command:'hermes',args:['-p','blondie','acp']}),"'hermes' '-p' 'blondie'");
  assert.equal(cron.hermesCli({provider:'hermes',command:'docker',args:['exec','-i','box','hermes','acp']}),"'hermes'");
  assert.equal(cron.hermesCli({provider:'hermes',command:'hermes',args:[],hermesHome:'/srv/h'}),"HERMES_HOME='/srv/h' 'hermes'");
  assert.equal(cron.hermesHome({command:'hermes',args:['-p','blondie']}),'"${HERMES_HOME:-$HOME/.hermes}/profiles/"\'blondie\'');
  const script=cron.listScript({provider:'hermes',command:'hermes',args:[]});assert.match(script,/cron\/jobs\.json/);assert.match(script,/crontab -l/);assert.doesNotMatch(script,/openclaw/);
  assert.match(cron.listScript({provider:'openclaw',command:'openclaw',args:[]}),/openclaw cron list --all --json/);
  assert.match(cron.listScript({provider:'goose',command:'goose',args:[]}),/goose schedule list/);
  assert.deepEqual(cron.kindsFor({provider:'claude'}),['crontab']);
});
test('agent cron jobs come back as plain jobs',()=>{
  const out=['@@opaya:hermes','@@home:/root/.hermes',JSON.stringify({jobs:[{id:'a1',name:'Brief',prompt:'Summarize',schedule:{kind:'cron',expr:'0 9 * * *'},schedule_display:'0 9 * * *',enabled:true,state:'scheduled',deliver:'telegram',repeat:{times:null,completed:2},skills:['web'],context_from:['self'],next_run_at:'2026-10-09T09:00:00+00:00'},
    {id:'b2',name:'Ping',prompt:'x',schedule:{kind:'interval',minutes:30},enabled:false,state:'paused'}]}),'@@opaya:crontab','MAILTO=me','# opaya-name: Backup','0 3 * * * /bin/backup.sh','#opaya-off# */5 * * * * echo hi','# just a comment','@@opaya:end'].join('\n');
  const [h,c]=cron.parse({provider:'hermes',command:'hermes',args:[]},out);
  assert.equal(h.jobs.length,2);assert.equal(h.jobs[0].opts.deliver,'telegram');assert.equal(h.jobs[0].opts.continuity,true);assert.deepEqual(h.jobs[1].schedule,{kind:'every',expr:'',every:30,at:''});assert.equal(h.jobs[1].enabled,false);
  assert.equal(h.where,'/root/.hermes/cron/jobs.json');
  assert.deepEqual(c.jobs.map(j=>[j.name,j.schedule.expr,j.enabled]),[['Backup','0 3 * * *',true],['echo hi','*/5 * * * *',false]]);
  const oc=cron.parse({provider:'openclaw',model:'openclaw/ops'},['@@opaya:openclaw','{"jobs":[{"id":"j1","name":"brief","agentId":"ops","enabled":true,"schedule":{"kind":"cron","expr":"0 7 * * *","tz":"Europe/Belgrade"},"sessionTarget":"isolated","payload":{"kind":"agentTurn","message":"Hi","model":"x/y"},"delivery":{"mode":"announce","channel":"telegram","to":"123"},"state":{"nextRunAtMs":1790000000000}},{"id":"j2","name":"other","agentId":"main","schedule":{"kind":"every","everyMs":600000},"payload":{"kind":"systemEvent","text":"t"}}]}','@@opaya:crontab','@@missing','@@opaya:end'].join('\n'));
  assert.equal(oc[0].jobs.length,1,'only this agent');assert.equal(oc[0].jobs[0].schedule.tz,'Europe/Belgrade');assert.equal(oc[0].jobs[0].opts.channel,'telegram');assert.equal(oc[1].available,false);
  const g=cron.parse({provider:'goose'},['@@opaya:goose','Scheduled Jobs:','- ID: daily','  Status: ⏸️  PAUSED','  Cron: 0 9 * * *','  Recipe Source (in store): /r/daily.yaml','  Last Run: Never','@@recipe:/r/daily.yaml','version: 1.0.0','title: "Daily"','prompt: |','  Line one','  Line two','@@opaya:crontab','@@opaya:end'].join('\n'));
  assert.deepEqual([g[0].jobs[0].name,g[0].jobs[0].prompt,g[0].jobs[0].enabled],['Daily','Line one\nLine two',false]);
});
test('agent cron changes use each agent\'s own command and options',()=>{
  const herm={provider:'hermes',command:'hermes',args:['-p','blondie']};
  const create=cron.hermesCommand(herm,'save',{name:'Brief',prompt:'-start here',schedule:{kind:'every',every:30},opts:{deliver:'telegram',skills:['a','b'],reasoningEffort:'high',continuity:true}});
  assert.match(create,/^'hermes' '-p' 'blondie' cron create --name='Brief' --deliver='telegram' --skill='a' --skill='b' --reasoning-effort='high' --continuity 'every 30m' ' -start here'$/);
  const edit=cron.hermesCommand(herm,'save',{id:'a1',name:'Brief',prompt:'P',schedule:{kind:'cron',expr:'0 9 * * 1-5'},opts:{}});
  assert.match(edit,/cron edit 'a1' --schedule='0 9 \* \* 1-5' --prompt='P'/);assert.match(edit,/--clear-skills/);assert.match(edit,/--no-continuity/);
  assert.equal(cron.hermesCommand(herm,'pause',{id:'a1'}),"'hermes' '-p' 'blondie' cron pause 'a1'");
  assert.throws(()=>cron.hermesCommand(herm,'remove',{id:'a1; rm -rf /'}),/Invalid job id/);
  assert.throws(()=>cron.hermesCommand(herm,'save',{prompt:'x',schedule:{kind:'cron',expr:'every day'}}),/five fields/);
  const oc=cron.openclawCommand({provider:'openclaw',model:'openclaw/ops'},'save',{name:'Brief',prompt:'Hi',schedule:{kind:'cron',expr:'0 7 * * *',tz:'Europe/Belgrade'},opts:{payload:'agentTurn',session:'isolated',thinking:'low',delivery:'announce',channel:'telegram',to:'123'}});
  assert.equal(oc,"openclaw cron add --name='Brief' --cron='0 7 * * *' --tz='Europe/Belgrade' --message='Hi' --session='isolated' --thinking='low' --agent='ops' --announce --channel='telegram' --to='123' --json");
  assert.match(cron.openclawCommand({},'save',{id:'j1',prompt:'echo 1',schedule:{kind:'every',every:10},opts:{payload:'command',delivery:'none'}}),/^openclaw cron edit 'j1' --every='10m' --command='echo 1' --no-deliver --json$/);
  assert.equal(cron.openclawCommand({},'pause',{id:'j1'}),"openclaw cron disable 'j1'");
  assert.match(cron.gooseCommand({},'save',{name:'Daily',prompt:'Do it',schedule:{kind:'cron',expr:'0 9 * * *'}}),/goose schedule add --schedule-id 'daily-[a-z0-9]+' --cron '0 9 \* \* \*' --recipe-source/);
  assert.equal(cron.recipeField(cron.gooseRecipe({name:'Daily',prompt:'One\nTwo'}),'prompt'),'One\nTwo');
  assert.throws(()=>cron.gooseCommand({},'pause',{id:'daily'}),/cannot be paused/);
});
test('crontab edits keep other lines and check the line is unchanged',()=>{
  const tab='MAILTO=me\n# opaya-name: Backup\n0 3 * * * /bin/backup.sh\n*/5 * * * * echo hi\n',jobs=cron.parseCrontab(tab).jobs;
  assert.deepEqual(cron.crontabEdit(tab,'pause',jobs[1]),['MAILTO=me','# opaya-name: Backup','0 3 * * * /bin/backup.sh','#opaya-off# */5 * * * * echo hi']);
  assert.deepEqual(cron.crontabEdit(tab,'remove',jobs[0]),['MAILTO=me','*/5 * * * * echo hi']);
  assert.deepEqual(cron.crontabEdit(tab,'save',{...jobs[0],name:'Nightly',prompt:'/bin/backup.sh --all',schedule:{kind:'cron',expr:'30 2 * * *'}}),['MAILTO=me','# opaya-name: Nightly','30 2 * * * /bin/backup.sh --all','*/5 * * * * echo hi']);
  assert.deepEqual(cron.crontabEdit('','save',{name:'',prompt:'date',schedule:{kind:'cron',expr:'@hourly'}}),['@hourly date']);
  assert.throws(()=>cron.crontabEdit(tab.replace('echo hi','echo bye'),'pause',jobs[1]),/changed meanwhile/);
});
