'use strict';
// Opaya's schedules: a message Opaya sends to an agent (or the Opaya Agent) on a cron schedule, while its session service
// runs. Cron is the usual five fields (minute hour day-of-month month day-of-week) with *, lists, ranges and steps, in
// this computer's local time. Agents' own schedules (Hermes cron jobs, OpenClaw cron, Goose, crontab) are in agent-cron.cjs.
const {randomUUID}=require('node:crypto');
const FIELDS=[[0,59],[0,23],[1,31],[1,12],[0,7]];
const NAMES=[null,null,null,{jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12},{sun:0,mon:1,tue:2,wed:3,thu:4,fri:5,sat:6}];
const MACROS={'@hourly':'0 * * * *','@daily':'0 0 * * *','@midnight':'0 0 * * *','@weekly':'0 0 * * 0','@monthly':'0 0 1 * *','@yearly':'0 0 1 1 *','@annually':'0 0 1 1 *'};
function field(text,i){
  const [lo,hi]=FIELDS[i],set=new Set(),names=NAMES[i];
  for(const part of String(text).toLowerCase().split(',')){
    const [range,stepText]=part.split('/'),step=stepText===undefined?1:Number(stepText);
    if(!Number.isInteger(step)||step<1)throw new Error(`Invalid step in "${text}".`);
    const val=v=>{const n=names&&v in names?names[v]:Number(v);if(!Number.isInteger(n)||n<lo||n>hi)throw new Error(`"${v}" is out of range (${lo}-${hi}).`);return n;};
    let a,b;if(range==='*'){a=lo;b=hi;}else if(range.includes('-')){[a,b]=range.split('-').map(val);}else{a=val(range);b=stepText===undefined?a:hi;}
    if(a>b)throw new Error(`Invalid range "${range}".`);
    for(let n=a;n<=b;n+=step)set.add(i===4&&n===7?0:n);
  }
  return set;
}
function parse(expr){
  const e=MACROS[String(expr||'').trim().toLowerCase()]||String(expr||'').trim();const parts=e.split(/\s+/);
  if(parts.length!==5)throw new Error('A schedule needs five fields: minute hour day month weekday (for example 0 9 * * 1-5).');
  const sets=parts.map(field);return {expr:e,sets,dayAny:parts[2]==='*',weekAny:parts[4]==='*'};
}
// Cron's rule: when both day-of-month and day-of-week are restricted, either one matching is enough.
function matches(cron,date){
  const c=typeof cron==='string'?parse(cron):cron,[mi,h,dom,mon,dow]=c.sets;
  if(!mi.has(date.getMinutes())||!h.has(date.getHours())||!mon.has(date.getMonth()+1))return false;
  const d=dom.has(date.getDate()),w=dow.has(date.getDay());
  return c.dayAny&&c.weekAny?true:c.dayAny?w:c.weekAny?d:d||w;
}
function next(cron,from=new Date(),limit=366*24*60){
  const c=typeof cron==='string'?parse(cron):cron,t=new Date(from);t.setSeconds(0,0);t.setMinutes(t.getMinutes()+1);
  for(let i=0;i<limit;i++){if(matches(c,t))return t;t.setMinutes(t.getMinutes()+1);}
  return null;
}
// In words, for the common shapes; the cron text otherwise.
function describe(expr){
  let c;try{c=parse(expr);}catch{return String(expr||'');}
  const [m,h,dom,mon,dow]=c.expr.split(/\s+/),hhmm=/^\d+$/.test(m)&&/^\d+$/.test(h)?`${h.padStart(2,'0')}:${m.padStart(2,'0')}`:'';
  const days=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  if(/^\*\/\d+$/.test(m)&&h==='*'&&dom==='*'&&mon==='*'&&dow==='*')return `Every ${m.slice(2)} minutes`;
  if(/^\d+$/.test(m)&&h==='*'&&dom==='*'&&mon==='*'&&dow==='*')return m==='0'?'Every hour':`Every hour at :${m.padStart(2,'0')}`;
  if(hhmm&&dom==='*'&&mon==='*'&&dow==='*')return `Every day at ${hhmm}`;
  if(hhmm&&dom==='*'&&mon==='*'&&dow==='1-5')return `Weekdays at ${hhmm}`;
  if(hhmm&&dom==='*'&&mon==='*'&&/^[0-7]$/.test(dow))return `Every ${days[Number(dow)%7]} at ${hhmm}`;
  if(hhmm&&/^\d+$/.test(dom)&&mon==='*'&&dow==='*')return `Monthly on day ${dom} at ${hhmm}`;
  return c.expr;
}
function schedule(input,existing={}){
  const name=String(input.name??existing.name??'').trim().slice(0,80),prompt=String(input.prompt??existing.prompt??'').trim();
  const agentId=String(input.agentId??existing.agentId??'');
  if(!agentId)throw new Error('Choose who runs it.');if(!prompt)throw new Error('Write what it should do.');if(prompt.length>8000)throw new Error('The message is too long (8000 characters at most).');
  const cron=parse(input.cron??existing.cron).expr;
  return {id:existing.id||randomUUID(),name:name||prompt.split('\n')[0].slice(0,60),agentId,cron,prompt,enabled:input.enabled??existing.enabled??true,createdAt:existing.createdAt||new Date().toISOString(),
    lastRun:existing.lastRun||'',lastStatus:existing.lastStatus||'',conversationId:existing.conversationId||''};
}
module.exports={parse,matches,next,describe,schedule};
