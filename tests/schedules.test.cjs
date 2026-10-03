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
test("an agent's own schedules are read with its own CLI and profile",()=>{
  assert.match(sch.nativeListScript({provider:'hermes',command:'hermes',args:['-p','blondie','acp']}),/'hermes' '-p' 'blondie' cron list/);
  assert.match(sch.nativeListScript({provider:'hermes',command:'docker',args:['exec','-i','box','hermes','acp']}),/hermes\s+cron list/);
  assert.match(sch.nativeListScript({provider:'openclaw',command:'openclaw',args:[]}),/openclaw cron list/);
  assert.match(sch.nativeListScript({provider:'claude',command:'claude',args:[]}),/crontab -l/);
});
