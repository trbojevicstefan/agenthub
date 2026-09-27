'use strict';
// What a terminal shows right now, and the select menu on it. The Opaya Agent reads installer and onboarding wizards
// from the rendered screen (not the raw output stream, which full-screen programs fill with cursor moves), so it can
// pick an option by its text and press the arrow key exactly as many times as needed.
// Menus it understands: @clack/prompts (OpenClaw: "│  ● OpenAI" / "│  ○ ..."), Hermes' curses menus (" → (●) ..."),
// inquirer-style ("❯ ..."), Claude Code and Codex ("› 1. Yes"), and plain "> ..." cursors. Checklists too.
const {Terminal}=require('@xterm/headless');

// Render the saved output of a terminal at its size. The last screen is what the program drew last.
function render(buffer,cols=110,rows=30){
  const term=new Terminal({cols:Math.max(20,Math.min(400,cols|0||110)),rows:Math.max(5,Math.min(200,rows|0||30)),allowProposedApi:true,scrollback:0});
  return new Promise(resolve=>term.write(String(buffer||''),()=>{
    const b=term.buffer.active,lines=[];
    for(let i=0;i<term.rows;i++)lines.push(b.getLine(b.viewportY+i)?.translateToString(true)||'');
    const result={lines,cursor:{x:b.cursorX,y:b.cursorY},appCursor:!!term.modes.applicationCursorKeysMode,alternate:b.type==='alternate'};
    term.dispose();resolve(result);
  }));
}
// The screen as text, without trailing blank lines.
const screenText=lines=>{const out=[...lines];while(out.length&&!out.at(-1).trim())out.pop();return out.join('\n');};

const GUTTER=/^[\s│|┃]*$/;
// An explicit cursor in front of the highlighted option.
const CURSOR=/^([\s│|┃]*?)(→|❯|›|➜|▶|▸|>)\s+(?=\S)/;
// Radio buttons, checkboxes and bullets in front of an option (the filled ones mark clack's highlighted row).
const MARK=/^(\((?:\s|●|○|x|X|✓|✔|\*)?\)|\[(?:\s|x|X|✓|✔|\*|•)?\]|●|○|◉|◯|◻|◼|☐|☑|☒|◆|◇|•|\*|o(?=\s))\s*/;
const FILLED=/^(●|◉|◼|☑|☒|\(●\)|\[[xX✓✔*•]\])/;
// Hints, footers and scroll indicators that end a menu.
const FOOTER=/(↑|↓|navigate|to select|to confirm|enter[:/ ]|space|esc\b|ctrl\+|type:? to search|\/ search|more choices|\(\d+ more\)|^\.\.\.|…$)/i;

// One row: where its marker starts, where its label starts, and the label with markers, numbering and hints removed.
function row(line){
  let rest=line,col=0,cursor=false,marks=[];
  const c=CURSOR.exec(rest);
  if(c){col=c[1].length;cursor=true;rest=rest.slice(c[0].length);}
  else{const g=/^[\s│|┃]*/.exec(rest)[0];col=g.length;rest=rest.slice(g.length);}
  let m;while((m=MARK.exec(rest))&&marks.length<2){marks.push(m[1]);rest=rest.slice(m[0].length);}
  const labelAt=line.length-rest.length;
  const numbered=/^(\d{1,2})[.)]\s+/.exec(rest);
  const label=rest.replace(/\s+←\s*currently active.*$/i,'').replace(/\s+▸(?=\s|$)/,'').trim();
  return {col,labelAt,cursor,marks,filled:marks.some(x=>FILLED.test(x)),number:numbered?Number(numbered[1]):0,label};
}
// The select menu on the screen, if there is one: its options top to bottom and which one is highlighted.
function readMenu(lines){
  const rows=lines.map(row);
  // The highlighted row: an explicit cursor, or else clack's filled bullet among hollow ones. The lowest one wins,
  // because the question being asked now is at the bottom.
  let at=-1;
  for(let i=rows.length-1;i>=0&&at<0;i--)if(rows[i].cursor&&rows[i].label&&!FOOTER.test(rows[i].label))at=i;
  if(at<0)for(let i=rows.length-1;i>=0&&at<0;i--){
    const r=rows[i];if(!r.filled||!r.label)continue;
    // A hollow sibling next to it, or (a search that left one match) navigation hints just below it.
    const near=[rows[i-1],rows[i+1]].some(n=>n&&n.marks.length&&!n.filled&&n.col===r.col)||lines.slice(i+1,i+3).some(l=>/↑|↓/.test(l)&&FOOTER.test(l));if(near)at=i;
  }
  if(at<0)return null;
  const head=rows[at];
  const isOption=i=>{
    const line=lines[i],r=rows[i];if(!line.trim()||!r.label)return false;
    if(!GUTTER.test(line.slice(0,head.col)))return false;
    if(r.col!==head.col&&!(r.col>head.col&&r.labelAt===head.labelAt))return false;
    if(!r.marks.length&&!r.cursor&&r.labelAt!==head.labelAt)return false;
    if(!r.marks.length&&!r.cursor&&FOOTER.test(r.label))return false;
    return true;
  };
  let start=at,end=at;
  while(start>0&&isOption(start-1))start--;
  while(end<rows.length-1&&isOption(end+1))end++;
  const options=rows.slice(start,end+1).map(r=>r.label);
  // The question is the nearest text line above the options.
  let question='',filter='';
  for(let i=start-1;i>=0&&i>=start-5;i--){
    const t=lines[i].replace(/^[\s│|┃◆◇?]+/,'').trim(),f=/^search:\s*(.*?)[█_]?\s*(\(\d+ match(?:es)?\))?$/i.exec(t);
    if(f){filter=f[1].trim();continue;}
    if(t&&!FOOTER.test(t)){question=t;break;}
  }
  const hint=lines.slice(Math.max(0,start-3),Math.min(lines.length,end+4)).join('\n');
  return {question,filter,options,active:at-start,checklist:rows.slice(start,end+1).some(r=>r.marks.some(x=>/^\[|^◻|^◼|^☐|^☑/.test(x))),
    search:/\/ search/i.test(hint)?'slash':/type:? to search|^\s*[│|]?\s*search:/im.test(hint)?'type':''};
}
// A numbered list with a prompt below it and no cursor (Hermes on Windows: "Choice [default 1]:", "Select [1-5]:").
function readNumbered(lines){
  const text=lines.map(l=>l.replace(/\s+$/,''));let end=text.length-1;while(end>=0&&!text[end].trim())end--;
  if(end<0||!/[:?>]\s*\S{0,3}$/.test(text[end].trim())||/^\s*\d{1,2}[.)]\s/.test(text[end]))return null;
  const options=[];
  for(let i=end-1;i>=0&&i>=end-40;i--){
    const m=/^\s*[│|]?\s*[\[(]?(\d{1,2})[.)\]]\s+(.+)$/.exec(text[i]);
    if(m){options.unshift({number:Number(m[1]),label:m[2].replace(/\s+←\s*currently active.*$/i,'').trim()});continue;}
    if(options.length)break;
  }
  return options.length>=2?{question:text[end].trim(),options}:null;
}
const norm=s=>String(s||'').toLowerCase().replace(/\s+/g,' ').replace(/[“”"']/g,'').trim();
// The option to pick for `text`: exact, then starts with, then contains (either way). -1 when none fits.
function pick(options,text){
  const t=norm(text);if(!t)return -1;const o=options.map(x=>norm(x).replace(/^\d{1,2}[.)]\s+/,''));const full=options.map(norm);
  for(const test of [x=>x===t,x=>x.startsWith(t),x=>x.includes(t),x=>x.length>2&&t.includes(x)]){
    const i=o.findIndex(test);if(i>=0)return i;const j=full.findIndex(test);if(j>=0)return j;
  }
  return -1;
}
// Arrow keys as the program expects them (application cursor mode sends ESC O B, like a real terminal).
const arrow=(dir,appCursor)=>(appCursor?'\u001bO':'\u001b[')+(dir==='up'?'A':'B');
module.exports={render,screenText,readMenu,readNumbered,pick,arrow,row};
