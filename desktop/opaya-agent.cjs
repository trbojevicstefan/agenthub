'use strict';
// Opaya Agent: a built-in assistant that helps install, connect, maintain and troubleshoot agents and machines.
// Safety boundary:
// - It only acts through the tools below. There is no generic shell, file or network tool.
// - Connections and machines change only through the broker, so the same schema validation applies as in the UI.
// - Every change and every command asks for native approval first. Commands come from fixed templates (catalog.cjs,
//   DIAGNOSTICS, SSH key templates) with validated parameters, and they run in a visible terminal.
// - Its only writable files are in its home folder: <userData>/opaya-agent (config, chat, notes). API keys stay in the vault.
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const schema=require('./schema.cjs');
const catalog=require('./catalog.cjs');
const files=require('./files.cjs');
const {atomicJson,readJson}=require('./store.cjs');
const {quote,target}=require('./process.cjs');

const PRESETS={
  openai:{label:'OpenAI',baseUrl:'https://api.openai.com/v1',model:''},
  anthropic:{label:'Anthropic',baseUrl:'https://api.anthropic.com/v1',model:'claude-sonnet-5'},
  openrouter:{label:'OpenRouter',baseUrl:'https://openrouter.ai/api/v1',model:''},
  ollama:{label:'Ollama (this computer)',baseUrl:'http://127.0.0.1:11434/v1',model:''},
  lmstudio:{label:'LM Studio (this computer)',baseUrl:'http://127.0.0.1:1234/v1',model:''},
  hermes:{label:'Hermes gateway',baseUrl:'http://127.0.0.1:8642/v1',model:'hermes-agent'},
  custom:{label:'Custom OpenAI-compatible API',baseUrl:'',model:''}
};
const KEY='opaya-agent',MAX_STEPS=12,TIMEOUT=120000;
const DIAGNOSTICS={
  versions:{label:'Installed agent tools',
    posix:"for c in hermes claude codex openclaw gemini opencode goose aider ollama node npm python3 tmux ssh; do printf '%s: ' \"$c\"; if command -v \"$c\" >/dev/null 2>&1; then \"$c\" --version 2>&1 | head -1; else echo 'not installed'; fi; done",
    windows:"foreach($c in 'hermes','claude','codex','openclaw','gemini','opencode','ollama','node','npm','python','ssh'){ $p=Get-Command $c -ErrorAction SilentlyContinue; if($p){ \"${c}: \"+$p.Source } else { \"${c}: not installed\" } }"},
  ports:{label:'Listening agent ports',
    posix:"(ss -ltn 2>/dev/null || netstat -an 2>/dev/null) | grep -E ':(8642|8643|8644|8645|18789|11434|1234|8000|8080)\\b' || echo 'No known agent ports are listening.'",
    windows:"Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in 8642,8643,8644,8645,18789,11434,1234,8000,8080 } | Format-Table LocalAddress,LocalPort,OwningProcess -AutoSize"},
  hermes:{label:'Hermes status',posix:"hermes status 2>&1 | tail -40; ls -1 ~/.hermes/profiles 2>/dev/null | sed 's/^/profile: /'",windows:"hermes status"},
  docker:{label:'Running containers',posix:"docker ps --format '{{.Names}}  {{.Image}}  {{.Status}}' 2>&1 | head -40",windows:"docker ps --format '{{.Names}}  {{.Image}}  {{.Status}}'"},
  resources:{label:'Disk and memory',posix:"df -h ~ | tail -1; (free -h 2>/dev/null || vm_stat 2>/dev/null) | head -3; uptime",windows:"Get-PSDrive C | Format-Table Used,Free -AutoSize; Get-CimInstance Win32_OperatingSystem | Format-List FreePhysicalMemory,TotalVisibleMemorySize"}
};
const fn=(name,description,properties={},required=[])=>({type:'function',function:{name,description,parameters:{type:'object',properties,required,additionalProperties:false}}});
const TOOLS=[
  fn('get_workspace','Read all saved agent connections (with live status and last error), SSH machines and open terminals. Start here.'),
  fn('list_frameworks','List everything that can be installed: agent frameworks (kind agent), dependencies such as Node.js, Python, Git, uv, tmux, OpenSSH and Homebrew (kind dependency), and the essentials bundle that installs whatever of Node.js, Python, Git, uv and tmux is missing (kind bundle).'),
  fn('discover_agents','Read-only scan for installed agents on this computer, or on a saved SSH machine. Returns candidates; it does not add them.',{machine_id:{type:'string',description:'Saved machine id; omit for this computer.'}}),
  fn('connect_agent','Connect (or reconnect) a saved agent and report its status or error.',{agent_id:{type:'string'}},['agent_id']),
  fn('disconnect_agent','Disconnect a saved agent.',{agent_id:{type:'string'}},['agent_id']),
  fn('clear_agent_error','Clear a stale connection error on a saved agent.',{agent_id:{type:'string'}},['agent_id']),
  fn('read_terminal','Read the recent output of a terminal, for example an install or diagnostic.',{terminal_id:{type:'string'},max_chars:{type:'integer'}},['terminal_id']),
  fn('read_app_logs','Read Opaya startup diagnostics and every agent connection error.'),
  fn('run_diagnostic','Run a fixed read-only check in a visible terminal and return its output.',{check:{type:'string',enum:Object.keys(DIAGNOSTICS)},machine_id:{type:'string',description:'Saved machine id; omit for this computer.'}},['check']),
  fn('save_connection','Add or update an agent connection. The user approves it first. Never include API tokens; the user enters tokens in the connection form.',{connection:{type:'object',description:'Fields: id (to update), name, provider (hermes|codex|claude|openclaw|custom), protocol (openai|acp|codex|claude|terminal), transport (http|local|ssh), hostId, endpoint, model, command, args, cwd, hermesHome, displayName, description, note, group (sidebar group name), tags (array of labels).'}},['connection']),
  fn('remove_connection','Remove a saved agent connection and its local chats. The user approves it first.',{agent_id:{type:'string'}},['agent_id']),
  fn('save_machine','Add or update a saved SSH machine. The user approves it first.',{machine:{type:'object',description:'Fields: id (to update), name, alias, hostname, username, port, identityFile.'}},['machine']),
  fn('remove_machine','Remove a saved SSH machine that no agent uses. The user approves it first.',{machine_id:{type:'string'}},['machine_id']),
  fn('install_framework','Install an agent framework, a dependency or the essentials bundle in a visible terminal, on this computer or a saved machine. The user approves the exact command first. Dependency commands skip what is already installed.',{framework_id:{type:'string',description:'An id from list_frameworks, for example codex, node, python or essentials.'},machine_id:{type:'string',description:'Saved machine id; omit for this computer.'}},['framework_id']),
  fn('ssh_key','Create an ed25519 SSH key on this computer, or install a public key on a saved machine, in a visible terminal. The user approves it first and types any passphrase or password.',{action:{type:'string',enum:['generate','install']},key_name:{type:'string',description:'File name in ~/.ssh, letters, numbers, _ and -.'},machine_id:{type:'string'}},['action','key_name']),
  fn('list_directory','Read-only: list a folder on this computer or a saved machine (default: home folder).',{path:{type:'string'},machine_id:{type:'string'}}),
  fn('read_file','Read-only: read up to 256 KB of a text file on this computer or a saved machine. Secret files such as .env, keys and tokens are refused.',{path:{type:'string'},machine_id:{type:'string'}},['path']),
  fn('project_info','Read-only: project markers, git branch, uncommitted changes and recent commits for a folder.',{path:{type:'string'},machine_id:{type:'string'}},['path']),
  fn('read_notes','Read your notes file in your home folder.'),
  fn('write_notes','Replace your notes file in your home folder (max 20000 characters). Use it to remember setup decisions.',{content:{type:'string'}},['content'])
];
const stripAnsi=text=>String(text||'').replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)/g,'').replace(/\r/g,'');

class OpayaAgent{
  constructor({root,vault,broker,terminals,approve,emit,runInTerminal,platform=process.platform,fetchImpl=globalThis.fetch}){
    Object.assign(this,{home:path.join(root,'opaya-agent'),root,vault,broker,terminals,approve,emit,runInTerminal,platform,fetch:fetchImpl});
    this.config={preset:'',baseUrl:'',model:''};this.messages=[];this.busy=false;this.status='';this.error='';this.controller=null;
  }
  async init(){
    await fs.mkdir(this.home,{recursive:true,mode:0o700});
    const config=await readJson(path.join(this.home,'config.json'),{});this.config={...this.config,...config};
    const history=await readJson(path.join(this.home,'history.json'),[]);this.messages=Array.isArray(history)?history.slice(-200):[];
  }
  configured(){return !!(this.config.baseUrl&&this.config.model);}
  describe(){
    const shown=this.messages.filter(m=>m.role==='user'||m.summary).slice(-80).map(({id,role,content,activity,createdAt,error})=>({id,role,content:content||'',activity:activity||[],createdAt,error}));
    return {configured:this.configured(),config:this.config,hasKey:this.vault.has(KEY),presets:PRESETS,busy:this.busy,status:this.status,error:this.error,messages:shown,home:this.home};
  }
  async saveConfig({preset='custom',baseUrl,model,apiKey,remember=true}){
    if(!Object.hasOwn(PRESETS,preset))throw new Error('Unknown model provider.');
    const config={preset,baseUrl:schema.endpoint(baseUrl||PRESETS[preset].baseUrl),model:schema.text(model,'model',256).trim()};
    if(!config.model)throw new Error('Enter the model ID the Opaya Agent should use.');
    if(apiKey!==undefined&&apiKey!=='')await this.vault.set(KEY,schema.text(apiKey,'API key',16000).trim(),Boolean(remember));
    this.config=config;await atomicJson(path.join(this.home,'config.json'),config);this.error='';this.emit();return this.describe();
  }
  async forgetKey(){await this.vault.set(KEY,'',true);this.emit();return true;}
  headers(){const key=this.vault.has(KEY)?this.vault.get(KEY):'';return {'Content-Type':'application/json',...(key?{Authorization:`Bearer ${key}`}:{}),'X-Title':'Opaya'};}
  async test(){
    if(!this.config.baseUrl)throw new Error('Choose a model provider first.');
    const response=await this.fetch(`${this.config.baseUrl}/models`,{headers:this.headers(),signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new Error(`The model API answered ${response.status}. Check the base URL and API key.`);
    const data=await response.json().catch(()=>({}));const models=(data.data||[]).map(m=>m.id).filter(Boolean).slice(0,200);
    return {ok:true,models,message:models.length?`Connected. ${models.length} models available.`:'Connected.'};
  }
  async clear(){if(this.busy)throw new Error('Stop the current answer first.');this.messages=[];this.error='';await this.persist();this.emit();return true;}
  stop(){this.controller?.abort();return true;}
  async persist(){await atomicJson(path.join(this.home,'history.json'),this.messages.slice(-200));}
  system(){
    const s=this.broker.snapshot();
    return [
      'You are the Opaya Agent, the built-in assistant of the Opaya desktop app ("One place. All your agents.").',
      'Opaya connects Hermes, Claude Code, Codex, OpenClaw and other agents on this computer and on SSH machines, keeps their chats and terminals, and lets the user switch between them.',
      'Your job: help install new agents, connect and maintain existing ones, manage SSH machines and keys, and troubleshoot agents that do not work.',
      'Work only through your tools. Check the workspace before changing anything. Prefer the smallest change. Explain briefly what you will do before a change; every change and command is approved by the user in a native dialog, and a declined approval is final.',
      'You cannot edit the app itself, its code or files outside your home folder, and you never see or handle API tokens: ask the user to enter tokens in the connection form.',
      'For agents that fail: read the connection and error, run diagnostics, check that the endpoint/port or executable exists, reconnect, and only then propose an edited connection. Do not remove connections unless asked.',
      'Before installing an agent, check its prerequisites with run_diagnostic versions (on the target machine) and install missing dependencies first, or the essentials bundle when several are missing. On Windows, new tools appear on PATH for terminals opened after the install.',
      'To understand a project or config, use list_directory, read_file and project_info (read-only). After an install finishes, use discover_agents and save_connection to add it. Terminal output may take a while; read it again if it is incomplete.',
      `Platform: ${this.platform}. Saved agents: ${s.agents.length}. Saved machines: ${s.hosts.length}. Your home folder: ${this.home}.`,
      'Answer in the language the user writes in. Be concise.'
    ].join('\n');
  }
  // Starts a request and returns at once; progress and the answer arrive through state updates.
  begin(text){if(this.busy)throw new Error('The Opaya Agent is already working.');if(!this.configured())throw new Error('Connect the Opaya Agent to a model first.');schema.prompt(text);this.send(text).catch(()=>{});return true;}
  async send(text){
    if(this.busy)throw new Error('The Opaya Agent is already working.');
    if(!this.configured())throw new Error('Connect the Opaya Agent to a model first.');
    text=schema.prompt(text);
    this.messages.push({id:randomUUID(),role:'user',content:text,createdAt:new Date().toISOString()});
    const reply={id:randomUUID(),role:'assistant',content:'',activity:[],createdAt:new Date().toISOString()};
    this.busy=true;this.error='';this.status='Thinking...';this.controller=new AbortController();this.emit();
    let recent=this.messages.filter(m=>!m.summary).slice(-40);const start=recent.findIndex(m=>m.role==='user');recent=start<0?[]:recent.slice(start);
    const context=recent.map(({role,content,tool_calls,tool_call_id})=>({role,content:content??'',...(tool_calls?{tool_calls}:{}),...(tool_call_id?{tool_call_id}:{})}));
    const conversation=[{role:'system',content:this.system()},...context];
    try{
      for(let step=0;step<MAX_STEPS;step++){
        const message=await this.complete(conversation);
        const calls=message.tool_calls||[];
        conversation.push({role:'assistant',content:message.content||'',...(calls.length?{tool_calls:calls}:{})});
        this.messages.push({role:'assistant',content:message.content||'',internal:true,...(calls.length?{tool_calls:calls}:{})});
        if(message.content)reply.content=message.content;
        if(!calls.length)break;
        for(const call of calls.slice(0,8)){
          const name=call.function?.name||'';let args={};try{args=JSON.parse(call.function?.arguments||'{}');}catch{}
          this.status=`Using ${name.replace(/_/g,' ')}...`;reply.activity.push(this.status.replace('...',''));this.emit();
          let result;try{result=await this.tool(name,args);}catch(error){result={error:String(error.message||error).slice(0,1000)};}
          const content=JSON.stringify(result).slice(0,24000);
          conversation.push({role:'tool',tool_call_id:call.id,content});this.messages.push({role:'tool',tool_call_id:call.id,content,internal:true});
        }
        if(step===MAX_STEPS-1)reply.content=(reply.content?reply.content+'\n\n':'')+'I stopped after the maximum number of steps. Ask me to continue if needed.';
      }
    }catch(error){reply.error=this.controller.signal.aborted?'Stopped.':String(error.message||error).slice(0,600);this.error=reply.error;}
    finally{
      // Internal tool turns stay in history for context; the chat shows one reply per request.
      this.messages.push({...reply,summary:true});
      // Save before reporting idle, so nothing still writes to the home folder once a request is finished.
      await this.persist().catch(()=>{});this.busy=false;this.status='';this.controller=null;this.emit();
    }
    return {ok:!reply.error};
  }
  async complete(messages){
    const signal=AbortSignal.any([this.controller.signal,AbortSignal.timeout(TIMEOUT)]);
    const response=await this.fetch(`${this.config.baseUrl}/chat/completions`,{method:'POST',headers:this.headers(),signal,body:JSON.stringify({model:this.config.model,messages,tools:TOOLS,tool_choice:'auto'})});
    const data=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(data?.error?.message?`Model API: ${String(data.error.message).slice(0,300)}`:`The model API answered ${response.status}.`);
    const message=data.choices?.[0]?.message;if(!message)throw new Error('The model API returned no answer.');
    return message;
  }
  host(id){return id?this.broker.host(id):null;}
  async ask(title,detail){if(!await this.approve({name:'Opaya Agent'},title,detail))throw new Error('The user declined this action.');}
  async terminalOutput(id,wait=0){
    const deadline=Date.now()+wait;
    for(;;){const view=this.terminals.attach(id);if(view.exited||Date.now()>=deadline)return stripAnsi(view.buffer).slice(-6000);await new Promise(r=>setTimeout(r,800));}
  }
  async tool(name,args){
    const b=this.broker;
    switch(name){
      case 'get_workspace':{const s=b.snapshot();return {platform:this.platform,agents:s.agents.map(({id,name,displayName,provider,protocol,transport,hostId,endpoint,model,command,args,cwd,hermesHome,status,error,busy,hasToken,note,group,tags,pinned})=>({id,name,displayName,provider,protocol,transport,hostId,endpoint,model,command,args,cwd,hermesHome,status,error,busy,hasToken,note,group,tags,pinned})),machines:s.hosts,terminals:this.terminals.describe()};}
      case 'list_frameworks':return catalog.list().map(({id,kind,name,description,requires,after,local,remote,localCommand,remoteCommand})=>({id,kind,name,description,requires,after,installableHere:local,installableOnMachines:remote,localCommand,remoteCommand}));
      case 'discover_agents':{const r=await b.discover({hostId:args.machine_id?schema.id(args.machine_id):undefined});return {scope:r.scope,agents:(r.agents||[]).map(({name,provider,protocol,transport,endpoint,command,args,hermesHome,detail,readiness,existingId,hostId})=>({name,provider,protocol,transport,endpoint,command,args,hermesHome,detail,readiness,existingId,hostId})),warnings:r.warnings||[]};}
      case 'connect_agent':{const id=schema.id(args.agent_id);await b.connect(id).catch(()=>{});const r=b.runtimeFor(id);return {status:r.status,error:r.error||''};}
      case 'disconnect_agent':{const id=schema.id(args.agent_id);await b.disconnect(id);return {status:b.runtimeFor(id).status};}
      case 'clear_agent_error':return {cleared:b.clearError(schema.id(args.agent_id))};
      case 'read_terminal':return {output:(await this.terminalOutput(schema.id(args.terminal_id))).slice(-Math.min(Math.max(Number(args.max_chars)||4000,200),6000))};
      case 'read_app_logs':{
        const read=file=>fs.readFile(path.join(this.root,file),'utf8').then(t=>t.slice(-4000)).catch(()=>'');
        return {startup:await read('startup-error.txt'),service:await read('service-startup-error.txt'),agentErrors:b.snapshot().agents.filter(a=>a.error).map(a=>({id:a.id,name:a.name,status:a.status,error:a.error}))};
      }
      case 'run_diagnostic':{
        const check=DIAGNOSTICS[args.check];if(!check)throw new Error('Unknown diagnostic.');const host=this.host(args.machine_id);
        const command=host||this.platform!=='win32'?check.posix:check.windows;
        const view=await this.runInTerminal({label:`Check / ${check.label}`,key:`check_${args.check}`,host,command});
        return {terminal_id:view.id,output:await this.terminalOutput(view.id,host?9000:5000)};
      }
      case 'save_connection':{
        const input=args.connection&&typeof args.connection==='object'?args.connection:{};
        const existing=input.id?b.agent(input.id):null;
        const {token,apiKey,importToken,...clean}=input;
        const agent=schema.agent({...(existing||{}),...clean});
        await this.ask(existing?`Update connection "${existing.name}"?`:`Add connection "${agent.name}"?`,JSON.stringify(Object.fromEntries(Object.entries(agent).filter(([k,v])=>v!==''&&!(Array.isArray(v)&&!v.length)&&!['createdAt','avatar'].includes(k))),null,2));
        const saved=await b.saveAgent({agent});return {saved:{id:saved.id,name:saved.name},note:'Ask the user to add an API token in the connection form if the agent needs one.'};
      }
      case 'remove_connection':{const a=b.agent(args.agent_id);await this.ask(`Remove connection "${a.name}"?`,'Deletes the saved connection and its local chats in Opaya, not the agent installation.');this.terminals.closeAgent(a.id);await b.removeAgent(a.id);return {removed:a.id};}
      case 'save_machine':{
        const input=args.machine&&typeof args.machine==='object'?args.machine:{};const existing=input.id?b.host(input.id):null;
        const host=schema.host({...(existing||{}),...input});
        await this.ask(existing?`Update machine "${existing.name}"?`:`Add machine "${host.name}"?`,JSON.stringify(host,null,2));
        const saved=await b.saveHost(host);return {saved:{id:saved.id,name:saved.name}};
      }
      case 'remove_machine':{const h=b.host(args.machine_id);await this.ask(`Remove machine "${h.name}"?`,'Only the saved machine entry is removed. Nothing changes on the machine.');await b.removeHost(h.id);return {removed:h.id};}
      case 'install_framework':{
        const host=this.host(args.machine_id);const {framework,command}=catalog.command(String(args.framework_id||''),{remote:!!host});
        await this.ask(`Install ${framework.name} ${host?`on ${host.name}`:'on this computer'}?`,`Runs in a visible terminal:\n\n${command}\n\n${framework.requires?`Requires ${framework.requires}.\n`:''}Afterwards: ${framework.after}`);
        const view=await this.runInTerminal({label:`Install ${framework.name}`,key:`install_${framework.id}`,host,command});
        return {terminal_id:view.id,started:true,next:framework.after,output:await this.terminalOutput(view.id,4000)};
      }
      case 'ssh_key':{
        const name=String(args.key_name||'');if(!/^[a-zA-Z0-9_-]{1,40}$/.test(name))throw new Error('Use a key name with letters, numbers, _ and -.');
        const win=this.platform==='win32',file=win?`$HOME\\.ssh\\${name}`:`~/.ssh/${name}`;
        let command,title;
        if(args.action==='generate'){title=`Create SSH key ${name}?`;command=win?`ssh-keygen -t ed25519 -C opaya -f "${file}"`:`mkdir -p ~/.ssh && chmod 700 ~/.ssh && ssh-keygen -t ed25519 -C opaya -f ${file}`;}
        else if(args.action==='install'){
          const host=this.host(schema.id(String(args.machine_id||'')));const dest=(host.username&&!host.alias?`${host.username}@`:'')+target(host),port=host.alias?'':` -p ${host.port||22}`;
          title=`Install public key ${name}.pub on ${host.name}?`;
          command=win?`type "${file}.pub" | ssh${port} ${dest} "umask 077; mkdir -p ~/.ssh; cat >> ~/.ssh/authorized_keys"`:`ssh-copy-id -i ${file}.pub${port} ${quote(dest)}`;
        }else throw new Error('Unknown SSH key action.');
        await this.ask(title,`Runs in a visible terminal on this computer. You type any passphrase or password there.\n\n${command}`);
        const view=await this.runInTerminal({label:`SSH key ${name}`,key:`sshkey_${name}`,host:null,command});
        return {terminal_id:view.id,output:await this.terminalOutput(view.id,3000),identity_file:win?path.join(require('node:os').homedir(),'.ssh',name):`~/.ssh/${name}`};
      }
      case 'list_directory':{const r=await files.browse({op:'list',path:String(args.path||''),host:this.host(args.machine_id)});return {...r,entries:r.entries.slice(0,300)};}
      case 'read_file':{const p=String(args.path||'');if(files.isSecret(p))throw new Error('That file may contain secrets, so the Opaya Agent does not read it. Ask the user to check it in the Files panel.');const r=await files.browse({op:'read',path:p,host:this.host(args.machine_id)});if(files.isSecret(r.path))throw new Error('That file may contain secrets.');return {...r,text:r.text.slice(0,24000)};}
      case 'project_info':return files.browse({op:'project',path:String(args.path||''),host:this.host(args.machine_id)});
      case 'read_notes':return {notes:await fs.readFile(path.join(this.home,'notes.md'),'utf8').catch(()=>'')};
      case 'write_notes':{const content=String(args.content??'');if(content.length>20000||content.includes('\0'))throw new Error('Notes must be under 20000 characters.');await fs.writeFile(path.join(this.home,'notes.md'),content,{mode:0o600});return {saved:true};}
      default:throw new Error('Unknown tool.');
    }
  }
}
module.exports={OpayaAgent,PRESETS,TOOLS,DIAGNOSTICS,stripAnsi};
