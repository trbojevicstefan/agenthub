'use strict';
// Opaya finishes a new Hermes or OpenClaw itself, without the vendor's interactive setup in a terminal: the user picks a
// model in Opaya's setup wizard, with a key they already have (the Opaya Vault, the Opaya Agent's own model key) or one
// they add there, a free one included. Opaya writes the key where the agent reads keys (its .env, the value travelling
// from Opaya's vault, never on a command line) and sets the model with the agent's own CLI: `hermes config set
// model.provider/model.default`, `openclaw models set <provider>/<model>`. Commands are fixed; the only values put in
// are a provider id from the table below and a model name checked against MODEL.
const {launch,collect,dockerExecContainerIndex,dockerExecArgs}=require('./process.cjs');
const {cliArgs}=require('./management.cjs');

// Providers the wizard offers, each with the key name both agents read, its id in Hermes and in OpenClaw, and a model
// that works with a new key. Free ones first: a free account is enough to finish the setup.
const PROVIDERS=[
  // Subscriptions, signed in in the browser: ChatGPT (Plus, Pro, Business) through Codex's sign-in, which Opaya passes
  // from the browser here to the agent on a VPS or in a container (codex-login.cjs); Claude (Pro, Max) through a
  // long-lived token from `claude setup-token` on this computer.
  {id:'chatgpt',label:'ChatGPT',login:'chatgpt',detail:'Your ChatGPT plan (Plus, Pro, Business). Sign in in the browser.',hermes:'openai-codex',openclaw:'openai',
    model:'gpt-6-astra',models:['gpt-6-astra','gpt-6.1-sol','gpt-6-sol','gpt-6-luna']},
  {id:'claude',label:'Claude',login:'claude',env:'CLAUDE_CODE_OAUTH_TOKEN',detail:'Your Claude plan (Pro, Max). Sign in in the browser.',hermes:'anthropic',openclaw:'anthropic',
    model:'claude-sonnet-5-5',models:['claude-sonnet-5-5','claude-opus-5-5','claude-haiku-5-5']},
  {id:'ollama-cloud',label:'Ollama Cloud',env:'OLLAMA_API_KEY',free:'Free account',signup:'https://ollama.com/settings/keys',hermes:'ollama-cloud',openclaw:'ollama-cloud',
    model:'gpt-oss:120b',models:['gpt-oss:120b','gpt-oss:20b','deepseek-v4-flash','kimi-k3','glm-5.2']},
  {id:'groq',label:'Groq',env:'GROQ_API_KEY',free:'Free tier',signup:'https://console.groq.com/keys',hermes:'groq',openclaw:'groq',
    model:'openai/gpt-oss-120b',models:['openai/gpt-oss-120b','openai/gpt-oss-20b']},
  {id:'google',label:'Google Gemini',env:'GEMINI_API_KEY',free:'Free tier',signup:'https://aistudio.google.com/apikey',hermes:'gemini',openclaw:'google',
    model:'gemini-3.8-flash',models:['gemini-3.8-flash','gemini-3.1-pro-preview']},
  {id:'openrouter',label:'OpenRouter',env:'OPENROUTER_API_KEY',free:'Free models',signup:'https://openrouter.ai/keys',hermes:'openrouter',openclaw:'openrouter',
    model:'deepseek/deepseek-chat-v3.1:free',models:['deepseek/deepseek-chat-v3.1:free','qwen/qwen3-coder:free','openrouter/auto']},
  {id:'mistral',label:'Mistral',env:'MISTRAL_API_KEY',free:'Free tier',signup:'https://console.mistral.ai/api-keys',hermes:'mistral',openclaw:'mistral',
    model:'mistral-large-latest',models:['mistral-large-latest','mistral-small-latest']},
  {id:'openai',label:'OpenAI',env:'OPENAI_API_KEY',signup:'https://platform.openai.com/api-keys',hermes:'openai-api',openclaw:'openai',
    model:'gpt-6-sol',models:['gpt-6-sol','gpt-6-luna','gpt-6.1-sol']},
  {id:'anthropic',label:'Anthropic (Claude)',env:'ANTHROPIC_API_KEY',signup:'https://console.anthropic.com/settings/keys',hermes:'anthropic',openclaw:'anthropic',
    model:'claude-sonnet-5-5',models:['claude-sonnet-5-5','claude-opus-5-5','claude-haiku-5-5']},
  {id:'deepseek',label:'DeepSeek',env:'DEEPSEEK_API_KEY',signup:'https://platform.deepseek.com/api_keys',hermes:'deepseek',openclaw:'deepseek',
    model:'deepseek-v4-pro',models:['deepseek-v4-pro','deepseek-flash']},
  {id:'xai',label:'xAI (Grok)',env:'XAI_API_KEY',signup:'https://console.x.ai',hermes:'xai',openclaw:'xai',
    model:'grok-4.7',models:['grok-4.7']}
];
const MODEL=/^[\w.:@+\/-]{1,160}$/;
const FRAMEWORKS=['hermes','openclaw'];
const provider=id=>{const p=PROVIDERS.find(x=>x.id===id);if(!p)throw new Error('Choose one of the providers in the list.');return p;};
const checkModel=(p,model)=>{const m=String(model||'').trim()||p.model;if(!MODEL.test(m))throw new Error('The model name has characters a model name does not use.');return m;};
// OpenClaw's model reference: <provider>/<model> (a model of an aggregator keeps its own slashes).
const openclawRef=(p,model)=>model.startsWith(`${p.openclaw}/`)?model:`${p.openclaw}/${model}`;

// What the wizard offers: keys the user already has (by name only) and every provider for a new key.
// vault: [{id, name, mask}] (the Opaya Vault); opaya: {preset, model, hasKey} (the Opaya Agent's model).
function choices({vault=[],opaya=null,claudeHere=false}={}){
  const saved=[];
  // The subscription the Opaya Agent itself uses comes first.
  const subscriptions=PROVIDERS.filter(p=>p.login).map(p=>({id:p.id,label:p.label,detail:p.detail,model:p.model,models:p.models,login:p.login,
    recommended:opaya?.preset===(p.login==='chatgpt'?'codex':'claude'),
    ...(p.login==='claude'&&!claudeHere?{unavailable:'Needs Claude Code on this computer (Install agents > Claude Code), signed in.'}:{})}));
  if(opaya?.hasKey&&PROVIDERS.some(p=>p.id===opaya.preset)){const p=provider(opaya.preset);saved.push({source:'opaya',provider:p.id,label:`Same as the Opaya Agent`,detail:`${p.label}${opaya.model?` / ${opaya.model}`:''}`,model:opaya.model&&MODEL.test(opaya.model)?opaya.model:p.model});}
  for(const k of vault){const p=PROVIDERS.find(x=>!x.login&&x.env===k.name);if(p&&!saved.some(s=>s.source==='vault'&&s.provider===p.id))saved.push({source:'vault',secret:k.id,provider:p.id,label:`${p.label} key from your Vault`,detail:`${k.name} ${k.mask||''}`.trim(),model:p.model});}
  return {subscriptions,saved,providers:PROVIDERS.filter(p=>!p.login).map(({id,label,env,free,signup,model,models})=>({id,label,env,free:free||'',signup,model,models}))};
}

// The CLI commands that set the model, as arguments for launch() with the agent's own command.
function modelSteps(agent,providerId,model){
  if(!FRAMEWORKS.includes(agent.provider))throw new Error('Opaya sets up Hermes and OpenClaw this way.');
  const p=provider(providerId),m=checkModel(p,model);
  if(agent.provider==='hermes')return [['config','set','model.provider',p.hermes],['config','set','model.default',m]];
  return [['models','set',openclawRef(p,m)]];
}
// A first OpenClaw config without its wizard (the model and key come from Opaya; no daemon: Opaya starts the gateway).
const OPENCLAW_ONBOARD=['onboard','--non-interactive','--accept-risk','--mode','local','--auth-choice','skip','--no-install-daemon','--skip-channels','--skip-search','--skip-skills','--skip-ui','--skip-health'];
// Inside an OpenClaw container: the gateway keeps the container's token, and its chat API (what Opaya talks to) is on.
const OPENCLAW_GATEWAY='openclaw config set gateway.auth.mode token >/dev/null && openclaw config set gateway.auth.token "$OPENCLAW_GATEWAY_TOKEN" >/dev/null && openclaw config set gateway.http.endpoints.chatCompletions.enabled true >/dev/null';
// The agent's own ChatGPT sign-in (OAuth on 127.0.0.1:1455 where it runs, like Codex). Where Opaya relays the
// browser's answer (a machine, a container) the agent must not try to open a browser itself.
function chatgptLoginArgs(agent,{relay=false}={}){
  if(agent.provider==='openclaw')return ['models','auth','login','--provider','openai'];
  return ['auth','add','openai-codex','--type','oauth','--browser',...(relay?['--no-browser']:[])];
}
// OpenClaw takes a Claude setup token on its input (never on the command line).
const CLAUDE_TOKEN_ARGS=['models','auth','paste-token','--provider','anthropic','--expires-in','365d'];
const CLAUDE_TOKEN=/sk-ant-oat01-[A-Za-z0-9_-]{40,}/;
const containerOf=agent=>{const i=agent.command==='docker'?dockerExecContainerIndex(agent.args||[]):-1;return i>=0?agent.args[i]:'';};
// `sh -c script` in the agent's container, with the same docker exec options (user, HOME, HERMES_HOME).
function shInContainer(agent,script){const all=dockerExecArgs(agent,agent.args||[]),i=dockerExecContainerIndex(all);return [...all.slice(0,i+1),'sh','-c',script];}

// Sets the model with the agent's CLI where it runs. `run(args)` runs the agent's command with args (tests replace it);
// `restart()` restarts what has to load the new key and model (a container, OpenClaw's gateway). Returns what it did.
async function apply({agent,host,provider:providerId,model,run,restart,signIn,progress=()=>{}}){
  run??=args=>collect(launch(agent,args,host),{timeout:180000,maxBytes:1024*1024});
  const steps=modelSteps(agent,providerId,model),p=provider(providerId),m=checkModel(p,model),done=[];
  if(agent.provider==='openclaw'){
    try{await run(cliArgs(agent,steps[0]));}
    catch(error){
      // A new OpenClaw has no config yet: make one without its wizard, then set the model.
      progress({message:'OpenClaw has no settings yet: creating them (openclaw onboard --non-interactive)'});
      try{await run(cliArgs(agent,OPENCLAW_ONBOARD));}catch(e){throw new Error(`openclaw onboard failed: ${String(e.message||e).slice(0,300)}`);}
      done.push('openclaw onboard');
      try{await run(cliArgs(agent,steps[0]));}catch(e){throw new Error(`openclaw models set ${openclawRef(p,m)} failed: ${String(e.message||error.message||e).slice(0,300)}`);}
    }
    done.push(`openclaw models set ${openclawRef(p,m)}`);
    if(containerOf(agent))await run(shInContainer(agent,OPENCLAW_GATEWAY)).then(()=>done.push('gateway token and chat API'),()=>progress({message:'Could not check the gateway token and chat API in the container; Opaya continues.'}));
    else await run(cliArgs(agent,['config','set','gateway.http.endpoints.chatCompletions.enabled','true'])).then(()=>done.push('gateway chat API on'),()=>{});
  }else{
    for(const s of steps){try{await run(cliArgs(agent,s));}catch(e){throw new Error(`hermes ${s.join(' ')} failed: ${String(e.message||e).slice(0,300)}`);}done.push(`hermes ${s.join(' ')}`);}
  }
  if(signIn){await signIn();done.push('signed in');}
  if(restart){progress({message:containerOf(agent)?`Restarting container ${containerOf(agent)} so it loads the key`:'Restarting its gateway so it loads the key'});await restart();done.push('restarted');}
  return {provider:p.id,label:p.label,model:m,env:p.env,done};
}
// `claude setup-token` on this computer in a pseudo terminal of its own (it needs one), output kept in memory only:
// Claude Code opens the browser here, the user signs in, and it prints a token that is valid for a year. Never through
// Opaya's terminals, whose history is saved to disk.
function claudeSetupToken({spawn,bin,args=['setup-token'],env,timeout=10*60*1000}){
  return new Promise((resolve,reject)=>{
    let out='',settled=false;const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);try{p.kill();}catch{}error?reject(error):resolve(value);};
    const p=spawn(bin,args,{name:'xterm-256color',cols:500,rows:40,env});
    const timer=setTimeout(()=>finish(new Error('The Claude sign-in was not finished within 10 minutes.')),timeout);
    p.onData(d=>{out=(out+d).slice(-100000);});
    p.onExit(()=>{const m=CLAUDE_TOKEN.exec(out.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g,'').replace(/\x1b\][^\x07]*\x07/g,''));
      m?finish(null,m[0]):finish(new Error(/not logged in|login|sign in/i.test(out)?'Claude Code did not finish the sign-in. Try again and sign in in the browser.':'Claude Code did not print a setup token.'));});
  });
}
module.exports={PROVIDERS,choices,modelSteps,openclawRef,apply,OPENCLAW_ONBOARD,OPENCLAW_GATEWAY,containerOf,chatgptLoginArgs,CLAUDE_TOKEN_ARGS,CLAUDE_TOKEN,claudeSetupToken};
