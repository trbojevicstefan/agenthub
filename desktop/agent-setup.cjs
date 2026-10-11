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
  // Sign-ins with a code the user enters on the provider's page (device code): Opaya shows the code and opens the page.
  {id:'xai-oauth',label:'Grok (SuperGrok, X Premium+)',login:'device',detail:'Your Grok plan. Enter a code on x.ai.',hermes:'xai-oauth',openclaw:'xai',
    loginArgs:{hermes:['auth','add','xai-oauth','--type','oauth','--no-browser'],openclaw:['models','auth','login','--provider','xai','--method','oauth']},model:'grok-4.7',models:['grok-4.7']},
  {id:'copilot',label:'GitHub Copilot',login:'device',detail:'Your Copilot plan. Enter a code on github.com.',hermes:null,openclaw:'github-copilot',
    loginArgs:{openclaw:['models','auth','login-github-copilot','--yes']},model:'claude-sonnet-5',models:['claude-sonnet-5','gpt-5.6-sol']},
  {id:'nous',label:'Nous Portal',login:'device',detail:'Free sign-in from Nous Research. Enter a code on their page.',hermes:'nous',openclaw:null,
    loginArgs:{hermes:['auth','add','nous','--type','oauth','--no-browser']},model:'',models:[]},
  {id:'ollama-cloud',label:'Ollama Cloud',env:'OLLAMA_API_KEY',free:'Free account',signup:'https://ollama.com/settings/keys',hermes:'ollama-cloud',openclaw:'ollama-cloud',
    model:'gpt-oss:120b',models:['gpt-oss:120b','gpt-oss:20b','deepseek-v4-flash','kimi-k3','glm-5.2']},
  {id:'groq',label:'Groq',env:'GROQ_API_KEY',free:'Free tier',signup:'https://console.groq.com/keys',hermes:null,openclaw:'groq',
    model:'openai/gpt-oss-120b',models:['openai/gpt-oss-120b','openai/gpt-oss-20b']},
  {id:'google',label:'Google Gemini',env:'GEMINI_API_KEY',free:'Free tier',signup:'https://aistudio.google.com/apikey',hermes:'gemini',openclaw:'google',
    model:'gemini-3.8-flash',models:['gemini-3.8-flash','gemini-3.1-pro-preview']},
  {id:'openrouter',label:'OpenRouter',env:'OPENROUTER_API_KEY',free:'Free models',signup:'https://openrouter.ai/keys',hermes:'openrouter',openclaw:'openrouter',
    model:'deepseek/deepseek-chat-v3.1:free',models:['deepseek/deepseek-chat-v3.1:free','qwen/qwen3-coder:free','openrouter/auto']},
  {id:'mistral',label:'Mistral',env:'MISTRAL_API_KEY',free:'Free tier',signup:'https://console.mistral.ai/api-keys',hermes:null,openclaw:'mistral',
    model:'mistral-large-latest',models:['mistral-large-latest','mistral-small-latest']},
  {id:'openai',label:'OpenAI',env:'OPENAI_API_KEY',signup:'https://platform.openai.com/api-keys',hermes:'openai-api',openclaw:'openai',
    model:'gpt-6-sol',models:['gpt-6-sol','gpt-6-luna','gpt-6.1-sol']},
  {id:'anthropic',label:'Anthropic (Claude)',env:'ANTHROPIC_API_KEY',signup:'https://console.anthropic.com/settings/keys',hermes:'anthropic',openclaw:'anthropic',
    model:'claude-sonnet-5-5',models:['claude-sonnet-5-5','claude-opus-5-5','claude-haiku-5-5']},
  {id:'deepseek',label:'DeepSeek',env:'DEEPSEEK_API_KEY',signup:'https://platform.deepseek.com/api_keys',hermes:'deepseek',openclaw:'deepseek',
    model:'deepseek-v4-pro',models:['deepseek-v4-pro','deepseek-flash']},
  {id:'xai',label:'xAI (Grok)',env:'XAI_API_KEY',signup:'https://console.x.ai',hermes:'xai',openclaw:'xai',
    model:'grok-4.7',models:['grok-4.7']},
  // More of Hermes' own providers (its auth registry). OpenClaw offers its whole catalog live (openclawCatalog below).
  {id:'zai',label:'Z.AI (GLM)',env:'ZAI_API_KEY',signup:'https://z.ai/manage-apikey/apikey-list',hermes:'zai',openclaw:'zai',model:'glm-5.2',models:['glm-5.2']},
  {id:'huggingface',label:'Hugging Face',env:'HF_TOKEN',free:'Free tier',signup:'https://huggingface.co/settings/tokens',hermes:'huggingface',openclaw:null,model:'openai/gpt-oss-120b',models:['openai/gpt-oss-120b','openai/gpt-oss-20b']},
  {id:'nvidia',label:'NVIDIA NIM',env:'NVIDIA_API_KEY',free:'Free tier',signup:'https://build.nvidia.com/settings/api-keys',hermes:'nvidia',openclaw:null,model:'openai/gpt-oss-120b',models:['openai/gpt-oss-120b']},
  {id:'alibaba',label:'Qwen Cloud (Alibaba)',env:'DASHSCOPE_API_KEY',signup:'https://modelstudio.console.alibabacloud.com',hermes:'alibaba',openclaw:null,model:'qwen3-max',models:['qwen3-max']}
];
// A provider only OpenClaw's own catalog knows (id oc:<provider>): its key is given with openclaw models auth
// paste-api-key on the command's input.
const PROVIDER_ID=/^[a-z0-9][a-z0-9._-]{0,60}$/;
const catalogProvider=id=>{const oc=String(id).slice(3);if(!PROVIDER_ID.test(oc))throw new Error('Choose one of the providers in the list.');return {id,label:oc,openclaw:oc,hermes:null,model:'',models:[],pasteKey:true};};
const MODEL=/^[\w.:@+\/-]{1,160}$/;
const FRAMEWORKS=['hermes','openclaw'];
const provider=id=>{if(id==='codex-login')id='chatgpt';if(String(id).startsWith('oc:'))return catalogProvider(id);const p=PROVIDERS.find(x=>x.id===id);if(!p)throw new Error('Choose one of the providers in the list.');return p;};
const checkModel=(p,model)=>{const m=String(model||'').trim()||p.model;if(!m&&!p.model)return '';if(!MODEL.test(m))throw new Error('The model name has characters a model name does not use.');return m;};
// OpenClaw's model reference: <provider>/<model> (a model of an aggregator keeps its own slashes).
const openclawRef=(p,model)=>model.startsWith(`${p.openclaw}/`)?model:`${p.openclaw}/${model}`;

// OpenClaw's own catalog (openclaw models list --all --json): every provider it knows with its models and the default.
function openclawCatalog(text){
  const {json}=require('./openclaw.cjs');let data;try{data=json(text);}catch{return null;}
  const list=Array.isArray(data?.models)?data.models:Array.isArray(data)?data:[];const out=new Map();
  for(const m of list){const key=typeof m==='string'?m:m?.key||m?.id;if(typeof key!=='string'||!MODEL.test(key))continue;const i=key.indexOf('/');if(i<1)continue;
    const id=key.slice(0,i),model=key.slice(i+1);if(!PROVIDER_ID.test(id))continue;
    if(!out.has(id))out.set(id,{id,models:[],default:''});const p=out.get(id);if(p.models.length<200&&!p.models.includes(model))p.models.push(model);
    const tags=Array.isArray(m?.tags)?m.tags:[];if(tags.includes('default')&&!p.default)p.default=model;}
  return [...out.values()];
}
// What the wizard offers: keys the user already has (by name only) and every provider for a new key.
// vault: [{id, name, mask}] (the Opaya Vault); opaya: {preset, model, hasKey} (the Opaya Agent's model).
// found: keys Opaya found on this computer and in other agents, not in the Vault yet ([{scan, item, name, mask, where}]).
// framework: the agent being set up (hermes or openclaw); providers it cannot use are left out.
// codex: {models, default} from Codex on this computer, the real list for the ChatGPT sign-in.
// codexLogin: Codex is signed in on this computer and the agent runs here too (its login can be reused).
// catalog: OpenClaw's own providers and models (openclawCatalog), when the agent exists: the lists come from it.
function choices({vault=[],found=[],opaya=null,claudeHere=false,framework='',codex=null,codexLogin=false,catalog=null}={}){
  const saved=[],fits=p=>!framework||!!p[framework],keyFor=name=>PROVIDERS.find(x=>!x.login&&fits(x)&&x.env===name);
  // The subscription the Opaya Agent itself uses comes first.
  const subscriptions=PROVIDERS.filter(p=>p.login&&fits(p)).map(p=>({id:p.id,label:p.label,detail:p.detail,model:p.model,models:p.models,login:p.login,
    recommended:opaya?.preset===(p.login==='chatgpt'?'codex':'claude'),
    ...(p.login==='claude'&&!claudeHere?{unavailable:'Needs Claude Code on this computer (Install agents > Claude Code), signed in.'}:{}),
    ...(p.login==='chatgpt'&&codex?.models?.length?{models:codex.models,model:codex.default||codex.models[0],live:true}:{})}));
  // OpenClaw on this computer can take over the Codex sign-in that is already here (openclaw migrate apply codex).
  if(codexLogin&&framework==='openclaw'){const c=subscriptions.find(x=>x.id==='chatgpt');if(c)subscriptions.splice(subscriptions.indexOf(c),0,{...c,id:'codex-login',label:'Codex on this computer',detail:'Use the ChatGPT sign-in Codex already has here. Nothing to sign in.',login:'codex-login',recommended:true});}
  if(opaya?.hasKey&&PROVIDERS.some(p=>p.id===opaya.preset&&!p.login&&fits(p))){const p=provider(opaya.preset);saved.push({source:'opaya',provider:p.id,label:`Same as the Opaya Agent`,detail:`${p.label}${opaya.model?` / ${opaya.model}`:''}`,model:opaya.model&&MODEL.test(opaya.model)?opaya.model:p.model});}
  // A Vault key under another name counts when its endpoint says whose it is (API_KEY for https://openrouter.ai/...).
  for(const k of vault){const p=keyFor(k.name)||keyFor(k.endpointKey);if(p&&!saved.some(s=>s.source==='vault'&&s.provider===p.id))saved.push({source:'vault',secret:k.id,provider:p.id,label:`${p.label} key from your Vault`,detail:`${k.name} ${k.mask||''}`.trim(),model:p.model});}
  for(const f of found){const p=keyFor(f.name);if(p&&!saved.some(s=>s.provider===p.id))saved.push({source:'found',scan:f.scan,item:f.item,provider:p.id,label:`${p.label} key found in ${f.where}`,detail:`${f.name} ${f.mask||''}`.trim(),model:p.model});}
  let providers=PROVIDERS.filter(p=>!p.login&&fits(p)).map(({id,label,env,free,signup,model,models,openclaw})=>({id,label,env,free:free||'',signup,model,models,openclaw}));
  if(catalog?.length&&framework==='openclaw'){
    const by=new Map(catalog.map(c=>[c.id,c]));
    providers=providers.map(p=>{const c=by.get(p.openclaw);return c?.models.length?{...p,models:c.models,model:c.models.includes(p.model)?p.model:c.default||c.models[0],live:true}:p;});
    for(const c of catalog)if(!providers.some(p=>p.openclaw===c.id)&&!PROVIDERS.some(p=>p.login&&p.openclaw===c.id))providers.push({id:`oc:${c.id}`,label:c.id,env:'',free:'',signup:'',model:c.default||c.models[0]||'',models:c.models,live:true,openclaw:c.id,fromAgent:true});
    for(const s of subscriptions){const c=by.get(PROVIDERS.find(p=>p.id===s.id)?.openclaw||(s.id==='codex-login'?'openai':''));if(c?.models.length&&!s.live){s.models=c.models;s.model=c.models.includes(s.model)?s.model:c.default||c.models[0];s.live=true;}}
  }
  return {subscriptions,saved,providers:providers.map(({openclaw,...p})=>p)};
}

// The CLI commands that set the model, as arguments for launch() with the agent's own command.
function modelSteps(agent,providerId,model){
  if(!FRAMEWORKS.includes(agent.provider))throw new Error('Opaya sets up Hermes and OpenClaw this way.');
  const p=provider(providerId),m=checkModel(p,model);
  if(!p[agent.provider])throw new Error(`${p.label} does not work with ${agent.provider==='hermes'?'Hermes':'OpenClaw'}. Choose another one.`);
  if(agent.provider==='hermes')return [['config','set','model.provider',p.hermes],...(m?[['config','set','model.default',m]]:[])];
  return m?[['models','set',openclawRef(p,m)]]:[];
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
// A device-code sign-in (Grok, GitHub Copilot, Nous Portal): the agent prints a page and a code to enter there.
function deviceLoginArgs(agent,p){const a=p.loginArgs?.[agent.provider];if(!a)throw new Error(`${p.label} sign-in does not work with this agent.`);return a;}
// The page and the code in what a device-code sign-in printed.
function deviceCode(text){
  const t=String(text||'').replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g,'').replace(/\x1b\][^\x07]*\x07/g,'');
  const urls=[...t.matchAll(/https:\/\/[^\s'"<>)\]]+/g)].map(m=>m[0].replace(/[.,;:]+$/,''));
  const url=urls.reverse().find(u=>/device|activate|login|verify|code|portal|oauth/i.test(u))||'';
  const code=[...t.matchAll(/\b([A-Z0-9]{4,5}-[A-Z0-9]{4,5})\b/g)].pop()?.[1]||'';
  return url&&code?{url,code}:null;
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
  const steps=modelSteps(agent,providerId,model),p=provider(providerId),done=[];let m=checkModel(p,model);
  if(agent.provider==='openclaw'){
    // Its own list of this provider's models; a new OpenClaw without settings gets them first (no wizard).
    const list=async()=>openclawCatalog(await run(cliArgs(agent,['models','list','--all','--provider',p.openclaw,'--json'])))?.find(c=>c.id===p.openclaw)||null;
    let offered;
    try{offered=await list();}
    catch{
      progress({message:'OpenClaw has no settings yet: creating them (openclaw onboard --non-interactive)'});
      try{await run(cliArgs(agent,OPENCLAW_ONBOARD));}catch(e){throw new Error(`openclaw onboard failed: ${String(e.message||e).slice(0,300)}`);}
      done.push('openclaw onboard');offered=await list().catch(()=>null);
    }
    // The model the wizard chose only when this OpenClaw offers it; else the one it offers for this provider.
    if(offered?.models.length&&m&&!offered.models.includes(m)&&!offered.models.includes(m.replace(`${p.openclaw}/`,''))){
      const instead=offered.default||offered.models[0];progress({message:`This OpenClaw does not offer ${m} for ${p.label}; using ${instead}, which it does.`});m=instead;
    }else if(offered?.models.length&&!m)m=offered.default||offered.models[0];
    if(m)try{await run(cliArgs(agent,['models','set',openclawRef(p,m)]));done.push(`openclaw models set ${openclawRef(p,m)}`);}
    catch(e){throw new Error(`openclaw models set ${openclawRef(p,m)} failed: ${String(e.message||e).slice(0,300)}`);}
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
function claudeSetupToken({spawn,bin,args=['setup-token'],env,signal,timeout=10*60*1000}){
  return new Promise((resolve,reject)=>{
    let out='',settled=false;const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);try{p.kill();}catch{}error?reject(error):resolve(value);};
    const p=spawn(bin,args,{name:'xterm-256color',cols:500,rows:40,env});
    const timer=setTimeout(()=>finish(new Error('The Claude sign-in was not finished within 10 minutes.')),timeout);
    signal?.addEventListener('abort',()=>finish(new Error('Cancelled.')),{once:true});
    p.onData(d=>{out=(out+d).slice(-100000);});
    p.onExit(()=>{const m=CLAUDE_TOKEN.exec(out.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g,'').replace(/\x1b\][^\x07]*\x07/g,''));
      m?finish(null,m[0]):finish(new Error(/not logged in|login|sign in/i.test(out)?'Claude Code did not finish the sign-in. Try again and sign in in the browser.':'Claude Code did not print a setup token.'));});
  });
}
// ---- Messaging channels, the same way: tokens in Opaya's wizard, no terminal ---------------------------------------
// Each channel with the tokens both agents read from their .env, and plain steps to get them. After the gateway starts
// with them, the user messages the bot, which answers with a pairing code; Opaya approves it (`pairing approve`).
const CHANNELS=[
  {id:'telegram',label:'Telegram',easiest:true,page:'https://t.me/BotFather',pageLabel:'Open BotFather',
    steps:['Open BotFather in Telegram with the button below.','Send /newbot, then a name, then a username that ends in "bot".','BotFather answers with a token like 123456789:AAE... Copy it and paste it here.'],
    tokens:[{env:'TELEGRAM_BOT_TOKEN',label:'Bot token',pattern:'^\\d{5,}:[\\w-]{20,}$'}]},
  {id:'discord',label:'Discord',page:'https://discord.com/developers/applications',pageLabel:'Open the Discord Developer Portal',
    steps:['Open the Developer Portal and click New Application, give it a name.','Open Bot: click Reset Token and copy the token. Turn on Message Content Intent there.','Open OAuth2 > URL Generator, tick bot, open the link and add the bot to your server.'],
    tokens:[{env:'DISCORD_BOT_TOKEN',label:'Bot token'}]},
  {id:'slack',label:'Slack',page:'https://api.slack.com/apps?new_app=1',pageLabel:'Open Slack apps',
    steps:['Create a new app From scratch in your workspace.','Socket Mode: turn it on and create an app-level token (xapp-...) with connections:write.','OAuth & Permissions: add chat:write, im:history, app_mentions:read, then Install to Workspace and copy the Bot token (xoxb-...).','Event Subscriptions: turn on and subscribe the bot to message.im and app_mention.'],
    tokens:[{env:'SLACK_BOT_TOKEN',label:'Bot token (xoxb-...)',pattern:'^xoxb-'},{env:'SLACK_APP_TOKEN',label:'App token (xapp-...)',pattern:'^xapp-'}]}
];
const channel=id=>{const c=CHANNELS.find(x=>x.id===id);if(!c)throw new Error('Choose Telegram, Discord or Slack.');return c;};
// After the tokens are in its .env: OpenClaw adds the channel from them (`--use-env`); Hermes starts it from .env.
function channelSteps(agent,id){channel(id);return agent.provider==='openclaw'?[['channels','add','--channel',id,'--use-env']]:[];}
function pairArgs(id,code){channel(id);const c=String(code||'').trim();if(!/^[A-Za-z0-9-]{3,24}$/.test(c))throw new Error('Paste the pairing code the bot sent you (letters and digits).');return ['pairing','approve',id,c];}
module.exports={openclawCatalog,catalogProvider,CHANNELS,channelSteps,pairArgs,deviceLoginArgs,deviceCode,PROVIDERS,choices,modelSteps,openclawRef,apply,OPENCLAW_ONBOARD,OPENCLAW_GATEWAY,containerOf,chatgptLoginArgs,CLAUDE_TOKEN_ARGS,CLAUDE_TOKEN,claudeSetupToken};
