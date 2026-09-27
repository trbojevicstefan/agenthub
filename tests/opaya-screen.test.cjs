'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const screen=require('../desktop/screen.cjs');const {OpayaAgent}=require('../desktop/opaya-agent.cjs');
// A select menu program in a terminal: draws the menu (clack or Hermes curses style), reads arrow keys, Enter and
// typed search text like the real ones. `app` turns on application cursor keys (curses): then only ESC O A/B move.
function fakeMenu({options,active=0,app=false,window=0,search=false,style='clack'}){
  const state={active,top:0,filter:'',picked:null,keys:[]};let buffer='',seq=0;
  const visible=()=>options.filter(o=>o.toLowerCase().includes(state.filter.toLowerCase()));
  const draw=()=>{
    const list=visible();state.active=Math.min(state.active,Math.max(0,list.length-1));
    if(window){if(state.active<state.top)state.top=state.active;if(state.active>=state.top+window)state.top=state.active-window+1;}
    const shown=window?list.slice(state.top,state.top+window):list,at=i=>state.top+i===state.active;
    const lines=style==='clack'
      ?['◆  Model/auth provider',...(search?[`│  Search: ${state.filter}█`]:[]),...shown.map((o,i)=>`│  ${at(i)?'●':'○'} ${o}`),`│  ↑/↓ to navigate • Enter: confirm${search?' • Type: to search':''}`,'└']
      :['Select provider:','  ↑↓ navigate  ENTER/SPACE select  ESC cancel','',...shown.map((o,i)=>`${at(i)?' → (○)':'   (○)'} ${o}`)];
    buffer+=(app?'\x1b[?1h':'')+'\x1b[H\x1b[2J'+lines.join('\r\n');seq++;
  };
  draw();
  const move=d=>{const n=visible().length;state.active=(state.active+d+n)%n;};
  return {state,attach:id=>({id,buffer,seq,exited:false,cols:100,rows:30}),write(id,data){
    for(let i=0;i<data.length;){
      const rest=data.slice(i),arrow=/^\x1b(\[|O)([AB])/.exec(rest);
      if(arrow){state.keys.push(`${arrow[1]}${arrow[2]}`);if(!app||arrow[1]==='O')move(arrow[2]==='B'?1:-1);i+=3;continue;}
      const ch=data[i++];
      if(ch==='\r'){state.picked=visible()[state.active];buffer+=`\r\n\x1b[2J\x1b[HPICKED ${state.picked}\r\n`;seq++;return;}
      if(search&&/[\w .-]/.test(ch)){state.filter+=ch;state.active=0;state.top=0;}
    }
    draw();
  }};
}
function agentOn(terminals){
  const agent=Object.create(OpayaAgent.prototype);
  Object.assign(agent,{terminals,runs:new Map(),screens:new Map(),ownTerminals:new Set(['t1']),emit(){},platform:'linux'});
  return agent;
}
const PROVIDERS=['Detected on this machine (Claude Code)','OpenAI (ChatGPT/Codex sign-in or API key)','OpenRouter','xAI (Grok)','Google','Anthropic (Claude CLI + API key)','More…','Skip for now'];
test('the screen reader finds clack, Hermes and numbered menus and the highlighted option',async()=>{
  const clack=await screen.render('\x1b[H◆  Model/auth provider\r\n│  ○ Detected on this machine\r\n│  ● OpenAI (ChatGPT/Codex sign-in or API key)\r\n│  ○ OpenRouter\r\n│  ↑/↓ to navigate • Enter: confirm\r\n└',100,30);
  assert.deepEqual(screen.readMenu(clack.lines),{question:'Model/auth provider',filter:'',options:['Detected on this machine','OpenAI (ChatGPT/Codex sign-in or API key)','OpenRouter'],active:1,checklist:false,search:''});
  const hermes=await screen.render('\x1b[?1hSelect provider:\r\n  ↑↓ navigate  ENTER/SPACE select  ESC cancel\r\n\r\n   (●) Nous Portal\r\n → (○) OpenRouter\r\n   (○) OpenAI ▸ (ChatGPT/Codex subscription)  ← currently active',100,30);
  const m=screen.readMenu(hermes.lines);assert.equal(hermes.appCursor,true);assert.equal(m.active,1);assert.deepEqual(m.options,['Nous Portal','OpenRouter','OpenAI (ChatGPT/Codex subscription)']);
  const single=screen.readMenu(['◆  Model/auth provider','│','│  Search: mistral█ (1 match)','│  ● Mistral AI (API key)','│  ↑/↓ to select • Enter: confirm • Type: to search','└']);
  assert.deepEqual([single.options,single.filter,single.search],[['Mistral AI (API key)'],'mistral','type']);
  assert.equal(screen.readMenu(['$ ls','file.txt','$ ']),null);
  assert.deepEqual(screen.readNumbered(['Select provider:','  1. Nous Portal','  2. OpenRouter','','Choice [default 1]: ']).options.map(o=>o.number),[1,2]);
  assert.equal(screen.pick(['OpenAI (ChatGPT sign-in)','OpenRouter'],'openai'),0);assert.equal(screen.pick(['OpenRouter','OpenAI'],'OpenAI'),1);assert.equal(screen.pick(['A','B'],'zzz'),-1);
  assert.equal(screen.arrow('down',true),'\x1bOB');assert.equal(screen.arrow('up',false),'\x1b[A');
});
test('choose presses the arrow key exactly as many times as needed, then Enter',async()=>{
  const t=fakeMenu({options:PROVIDERS}),agent=agentOn(t);
  const r=await agent.tool('answer_prompt',{terminal_id:'t1',answer:'choose',option:'Anthropic'});
  assert.equal(t.state.picked,'Anthropic (Claude CLI + API key)');assert.equal(r.chose,'Anthropic (Claude CLI + API key)');
  assert.deepEqual(t.state.keys,Array(5).fill('[B'),'five presses down, none wasted');
  const up=fakeMenu({options:PROVIDERS,active:6}),other=agentOn(up);
  await other.tool('answer_prompt',{terminal_id:'t1',answer:'choose',option:'OpenAI'});
  assert.equal(up.state.picked,PROVIDERS[1]);assert.deepEqual(up.state.keys,Array(5).fill('[A'));
});
test('curses menus get application cursor keys, and long lists are paged until the option shows',async()=>{
  const options=Array.from({length:30},(_,i)=>`Provider ${i+1}`);options[22]='DeepSeek (V3, R1, coder, direct API)';
  const t=fakeMenu({options,app:true,window:8,style:'hermes'}),agent=agentOn(t);
  await agent.tool('answer_prompt',{terminal_id:'t1',answer:'choose',option:'DeepSeek'});
  assert.equal(t.state.picked,options[22]);assert(t.state.keys.every(k=>k==='OB'||k==='OA'),'ESC O arrows in application cursor mode');
});
test('choose searches a searchable list and types the number in a numbered one',async()=>{
  const names=['Arcee AI','Baseten','BytePlus','Cerebras','Chutes','DeepSeek','Fireworks','Groq','Microsoft Foundry','MiniMax','Mistral AI','Moonshot AI'];
  const t=fakeMenu({options:names,window:5,search:true}),agent=agentOn(t);
  const r=await agent.tool('answer_prompt',{terminal_id:'t1',answer:'choose',option:'Mistral AI'});
  assert.equal(t.state.picked,'Mistral AI');assert.match(r.pressed,/searched "Mistral AI"/);
  const writes=[],numbered=agentOn({attach:id=>({id,buffer:'Select provider:\r\n  1. Nous Portal\r\n  2. OpenRouter\r\n  3. OpenAI\r\n\r\nChoice [default 1]: ',seq:1,exited:false}),write:(id,d)=>writes.push(d)});
  assert.equal((await numbered.tool('answer_prompt',{terminal_id:'t1',answer:'choose',option:'OpenAI'})).by,'typed 3');assert.deepEqual(writes,['3\r']);
  await assert.rejects(()=>agentOn(fakeMenu({options:PROVIDERS.filter(o=>o!=='More…')})).tool('answer_prompt',{terminal_id:'t1',answer:'choose',option:'Hugging Face'}),/not in this menu. Options: Detected/);
});
test('the Opaya Agent sees menus while waiting and never types into a secret prompt',async()=>{
  const t=fakeMenu({options:PROVIDERS}),agent=agentOn(t);
  const waited=await agent.tool('wait_for_terminal',{terminal_id:'t1',seconds:5});
  assert.equal(waited.question,true);assert.equal(waited.menu.question,'Model/auth provider');assert.equal(waited.menu.highlighted,PROVIDERS[0]);assert.match(waited.next,/answer=choose/);
  const writes=[],secret=agentOn({attach:id=>({id,buffer:'No DeepSeek API key configured.\r\nDEEPSEEK_API_KEY (or Enter to cancel): ',seq:1,exited:false}),write:(id,d)=>writes.push(d)});
  const w=await secret.tool('wait_for_terminal',{terminal_id:'t1',seconds:5});assert.equal(w.password,true);assert.equal(w.question,false);
  await assert.rejects(()=>secret.tool('answer_prompt',{terminal_id:'t1',answer:'text',text:'sk-123'}),/Only the user can type it/);
  await assert.rejects(()=>secret.tool('answer_prompt',{terminal_id:'t1',answer:'choose',option:'x'}),/Only the user can type it/);
  assert.deepEqual(writes,[]);
});
