'use strict';
// Reasoning effort ("thinking") levels. Agents name their own; this ladder orders the known names low to high, so a
// level one model does not offer maps to the nearest one it does. '' always means the agent's own setting.
const RANK={none:0,off:0,minimal:1,low:2,medium:3,high:4,xhigh:5,max:6,ultra:7};
const CLAUDE=['low','medium','high','xhigh','max'],CODEX=['minimal','low','medium','high','xhigh'],API=['low','medium','high'];
const NAME=/^[a-z][a-z0-9_-]{0,31}$/;
const known=level=>Object.hasOwn(RANK,level);
// Levels as an agent lists them: valid names once, known ones low to high, unknown ones after them in their own order.
function order(list){
  const names=[...new Set((Array.isArray(list)?list:[]).filter(x=>typeof x==='string'&&NAME.test(x)))];
  return [...names.filter(known).sort((a,b)=>RANK[a]-RANK[b]),...names.filter(x=>!known(x))];
}
// The level to use from `levels` for the chosen one: itself, else the nearest known one (a tie goes to the higher), else ''.
function nearest(level,levels){
  if(!level||!Array.isArray(levels))return '';
  if(levels.includes(level))return level;
  if(!known(level))return '';
  let best='';
  for(const l of levels){
    if(!known(l))continue;
    const d=Math.abs(RANK[l]-RANK[level]),b=best?Math.abs(RANK[best]-RANK[level]):Infinity;
    if(d<b||d===b&&RANK[l]>RANK[best])best=l;
  }
  return best;
}
module.exports={RANK,CLAUDE,CODEX,API,NAME,order,nearest};
