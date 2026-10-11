'use strict';
// Opaya's own setup of a new Hermes or OpenClaw: the wizard's choices and the CLI commands that set the model.
const {test}=require('node:test');const assert=require('node:assert/strict');
const s=require('../desktop/agent-setup.cjs');
const containers=require('../desktop/containers.cjs');
const hermes={id:'h',name:'Tuco',provider:'hermes',protocol:'acp',command:'docker',args:['exec','-i','opaya-tuco','hermes'],hermesHome:'/opt/data',transport:'ssh'};
const claw={id:'o',name:'Claw',provider:'openclaw',protocol:'openai',command:'docker',args:['exec','-i','opaya-claw','openclaw'],endpoint:'http://127.0.0.1:18888/v1',transport:'ssh'};

test('the wizard offers the keys the user has first, then free providers, by name only',()=>{
  const c=s.choices({vault:[{id:'S1',name:'OPENROUTER_API_KEY',mask:'sk-or-…ab'},{id:'S2',name:'GITHUB_TOKEN',mask:'gh…'},{id:'S3',name:'OPENROUTER_API_KEY',mask:'x'}],opaya:{preset:'deepseek',model:'deepseek-flash',hasKey:true}});
  assert.deepEqual(c.saved.map(x=>[x.source,x.provider,x.secret||'',x.model]),[['opaya','deepseek','','deepseek-flash'],['vault','openrouter','S1','deepseek/deepseek-chat-v3.1:free']]);
  assert.equal(JSON.stringify(c).includes('sk-or-'),true,'masks only');
  assert.equal(c.providers[0].id,'ollama-cloud');assert(c.providers[0].free&&c.providers[0].signup.startsWith('https://ollama.com'));
  // A CLI sign-in (Codex, Claude Code) has no key to give.
  assert.deepEqual(s.choices({opaya:{preset:'codex',model:'',hasKey:false}}).saved,[]);
});

test('the model is set with each agent\'s own CLI',()=>{
  assert.deepEqual(s.modelSteps(hermes,'ollama-cloud',''),[['config','set','model.provider','ollama-cloud'],['config','set','model.default','gpt-oss:120b']]);
  assert.deepEqual(s.modelSteps(claw,'openrouter','qwen/qwen3-coder:free'),[['models','set','openrouter/qwen/qwen3-coder:free']]);
  assert.deepEqual(s.modelSteps(claw,'google','google/gemini-3.8-flash'),[['models','set','google/gemini-3.8-flash']]);
  assert.throws(()=>s.modelSteps(claw,'nope',''),/providers in the list/);
  assert.throws(()=>s.modelSteps(claw,'openai','gpt; rm -rf /'),/characters/);
  assert.throws(()=>s.modelSteps({...claw,provider:'claude'},'openai',''),/Hermes and OpenClaw/);
});

test('a new OpenClaw gets its settings without the wizard, then the model, the container token and a restart',async()=>{
  const calls=[];let restarted=0;
  const run=async args=>{calls.push(args.join(' '));if(args.includes('models')&&!calls.some(c=>c.includes('onboard')))throw new Error('No config found. Run openclaw onboard.');return '';};
  const r=await s.apply({agent:claw,provider:'ollama-cloud',model:'',run,restart:async()=>{restarted++;}});
  assert.deepEqual(calls.slice(0,3),['exec -i opaya-claw openclaw models set ollama-cloud/gpt-oss:120b',`exec -i opaya-claw openclaw ${s.OPENCLAW_ONBOARD.join(' ')}`,'exec -i opaya-claw openclaw models set ollama-cloud/gpt-oss:120b']);
  assert.equal(calls[3],`exec -i opaya-claw sh -c ${s.OPENCLAW_GATEWAY}`);
  assert.equal(restarted,1);assert.deepEqual([r.provider,r.model,r.env],['ollama-cloud','gpt-oss:120b','OLLAMA_API_KEY']);
  assert(s.OPENCLAW_ONBOARD.includes('--non-interactive')&&s.OPENCLAW_ONBOARD.includes('--auth-choice'));
});

test('Hermes in its container gets provider and model in its own home; a failure says which command',async()=>{
  const calls=[];
  await s.apply({agent:hermes,provider:'anthropic',model:'claude-haiku-5-5',run:async a=>{calls.push(a.join(' '));return '';}});
  assert.deepEqual(calls,['exec -i opaya-tuco hermes config set model.provider anthropic','exec -i opaya-tuco hermes config set model.default claude-haiku-5-5']);
  await assert.rejects(()=>s.apply({agent:hermes,provider:'groq',model:'',run:async()=>{throw new Error('unknown key');}}),/hermes config set model.provider groq failed: unknown key/);
});

test('a Docker install for the wizard has no interactive sign-in',()=>{
  for(const id of ['hermes','openclaw']){
    const p=containers.plan(id,{name:'x',signIn:false});
    assert.doesNotMatch(p.preview,/hermes setup|openclaw onboard/);
  }
});

test('subscriptions come first: ChatGPT and Claude, signed in in the browser',async()=>{
  const c=s.choices({opaya:{preset:'codex'},claudeHere:false});
  assert.deepEqual(c.subscriptions.map(x=>[x.id,!!x.recommended,!!x.unavailable]),[['chatgpt',true,false],['claude',false,true]]);
  assert(!c.providers.some(p=>p.id==='chatgpt'||p.id==='claude'),'not offered as keys');
  assert.equal(s.choices({claudeHere:true}).subscriptions[1].unavailable,undefined);
  // The agent's own ChatGPT sign-in; where Opaya relays the browser's answer it must not open a browser there.
  assert.deepEqual(s.chatgptLoginArgs(claw),['models','auth','login','--provider','openai']);
  assert.deepEqual(s.chatgptLoginArgs(hermes,{relay:true}),['auth','add','openai-codex','--type','oauth','--browser','--no-browser']);
  assert.deepEqual(s.modelSteps(hermes,'chatgpt',''),[['config','set','model.provider','openai-codex'],['config','set','model.default','gpt-6-astra']]);
  assert.deepEqual(s.modelSteps(claw,'claude',''),[['models','set','anthropic/claude-sonnet-5-5']]);
  // The sign-in runs after the model is set and before the restart.
  const order=[];
  await s.apply({agent:claw,provider:'chatgpt',model:'',run:async a=>{order.push(a.includes('sh')?'sh -c':a.slice(4,6).join(' '));return '';},signIn:async()=>order.push('sign-in'),restart:async()=>order.push('restart')});
  assert.deepEqual(order,['models set','sh -c','sign-in','restart']);
});

test('the Claude setup token is read from Claude Code\'s output in memory, and only a finished sign-in gives one',async()=>{
  const fake=(chunks)=>(bin,args,opts)=>{assert.deepEqual(args,['setup-token']);assert.equal(opts.cols,500);let data,exit;setTimeout(()=>{for(const c of chunks)data(c);exit({exitCode:0});},5);return {onData:f=>{data=f;},onExit:f=>{exit=f;},kill(){}};};
  const token='sk-ant-oat01-'+'A1b2_C3d4-'.repeat(8);
  assert.equal(await s.claudeSetupToken({spawn:fake(['Opening browser...\r\n','\x1b[32mYour token: ',token.slice(0,30),token.slice(30),'\x1b[0m\r\n']),bin:'claude'}),token);
  await assert.rejects(()=>s.claudeSetupToken({spawn:fake(['Error: not logged in\r\n']),bin:'claude'}),/did not finish the sign-in/);
});
