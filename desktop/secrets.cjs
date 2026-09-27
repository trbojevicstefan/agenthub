'use strict';
// Secrets the user hands the Opaya Agent: API keys, tokens and passwords pasted into its chat or typed into Opaya's
// secure prompt. The values stay in Opaya's vault (OS keychain encryption); the model, the chat saved on disk and the
// UI only get a reference such as [secret S1 · OPENAI_API_KEY · sk-p…9f3a]. This file finds secret-looking values in
// text, names and masks them, hides values in what the model gets back (also a key a terminal wrapped over two lines)
// and writes them into .env and JSON settings files on this computer, an SSH machine or in a container.
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {collect,quote}=require('./process.cjs');
const {run,shell,isLocal}=require('./clone.cjs');
// Known key formats, most specific first, with the variable agents read each from. `generic` ones may belong to
// another provider, so the words before them (for example "my DeepSeek key") can rename them.
const B='(?<![A-Za-z0-9_-])';
const PATTERNS=[
  [B+'sk-ant-[A-Za-z0-9_-]{20,}','ANTHROPIC_API_KEY'],
  [B+'sk-or-[A-Za-z0-9_-]{20,}','OPENROUTER_API_KEY'],
  [B+'sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}','OPENAI_API_KEY'],
  [B+'sk-[A-Za-z0-9_-]{16,}',v=>/^sk-[0-9a-f]{32}$/.test(v)?'DEEPSEEK_API_KEY':'OPENAI_API_KEY',true],
  [B+'(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}','STRIPE_SECRET_KEY'],
  [B+'(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,})','GITHUB_TOKEN'],
  [B+'glpat-[A-Za-z0-9_-]{20,}','GITLAB_TOKEN'],
  [B+'xai-[A-Za-z0-9_-]{20,}','XAI_API_KEY'],
  [B+'AIza[0-9A-Za-z_-]{30,}','GEMINI_API_KEY'],
  [B+'gsk_[A-Za-z0-9]{20,}','GROQ_API_KEY'],
  [B+'hf_[A-Za-z0-9]{20,}','HF_TOKEN'],
  [B+'r8_[A-Za-z0-9]{20,}','REPLICATE_API_TOKEN'],
  [B+'csk-[A-Za-z0-9]{20,}','CEREBRAS_API_KEY'],
  [B+'pplx-[A-Za-z0-9]{20,}','PERPLEXITY_API_KEY'],
  [B+'nvapi-[A-Za-z0-9_-]{20,}','NVIDIA_API_KEY'],
  [B+'tvly-[A-Za-z0-9_-]{16,}','TAVILY_API_KEY'],
  [B+'xapp-[A-Za-z0-9-]{10,}','SLACK_APP_TOKEN'],
  [B+'xox[bpars]-[A-Za-z0-9-]{10,}','SLACK_BOT_TOKEN'],
  ['(?<![0-9])[0-9]{6,12}:AA[A-Za-z0-9_-]{30,}','TELEGRAM_BOT_TOKEN'],
  [B+'[MNO][A-Za-z0-9_-]{23,27}\\.[A-Za-z0-9_-]{6}\\.[A-Za-z0-9_-]{27,40}','DISCORD_BOT_TOKEN'],
  [B+'eyJ[A-Za-z0-9_-]{8,}\\.eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}','TOKEN'],
  [B+'AKIA[0-9A-Z]{16}(?![0-9A-Z])','AWS_ACCESS_KEY_ID'],
  ['(?<=\\bBearer\\s+)[A-Za-z0-9._~+/-]{16,}=*','TOKEN',true]
].map(([source,name,generic])=>({re:new RegExp(source,'g'),name,generic:!!generic}));
const PEM=/-----BEGIN ([A-Z0-9 ]*?)PRIVATE KEY-----[\s\S]*?-----END \1PRIVATE KEY-----/g;
// NAME=value (any case), and NAME: value for UPPER_SNAKE or quoted JSON names. Values stop at quotes, spaces and &.
const ASSIGN=/(?<![A-Za-z0-9_$.-])(?<name>[A-Za-z_][A-Za-z0-9_]{0,79})[ \t]*=[ \t]*(?:"(?<q1>[^"\r\n]+)"|'(?<q2>[^'\r\n]+)'|(?<bare>[^\s"'<>&]+))/dg;
const COLON=/(?<![A-Za-z0-9_$.-])(?:"(?<qname>[A-Za-z_][A-Za-z0-9_]{0,79})"|(?<name>[A-Z][A-Z0-9_]{2,79}))[ \t]*:[ \t]*(?:"(?<q1>[^"\r\n]+)"|'(?<q2>[^'\r\n]+)'|(?<bare>[^\s"'<>&,}]+))/dg;
// Plain words: "password: hunter2!", "my API key is abc123...", and in Serbian "lozinka je ...".
const PHRASE=/(?<![A-Za-z0-9_])(?<word>passwords?|passwd|passphrase|pass ?code|api[ _-]?key|access[ _-]?token|token|secret|lozink[aeu]|šifr[aeu]|sifr[aeu]|ključ|kljuc)(?:\s+(?:is|je))?\s*[:=]?\s+(?<bare>[^\s"'<>]+)/dgi;
// Long random-looking runs (unknown key formats), outside links.
const LONG=/(?<![A-Za-z0-9_+/.=@-])[A-Za-z0-9_+-]{32,}={0,2}(?![A-Za-z0-9_+/=@-])/g;
const URL_RE=/\bhttps?:\/\/[^\s<>"'`)\]]+/gi;
const REF=/\[secret (S\d{1,6}) · ([A-Za-z_][A-Za-z0-9_]{0,79}) · ([^\]\n]{0,40})\]/g;
const HIDDEN=/\[hidden [A-Za-z_][A-Za-z0-9_]{0,79} · [^\]\n]{0,40}\]/g;
const SECRET_WORDS=new Set(['KEY','KEYS','APIKEY','TOKEN','TOKENS','SECRET','SECRETS','PASSWORD','PASSWORDS','PASSWD','PASS','PWD','PASSPHRASE','CREDENTIAL','CREDENTIALS','PAT','AUTH']);
// KEY_FILE, TOKEN_URL, PASSWORD_ENABLED...: settings about a secret, not the secret.
const NOT_SECRET_END=new Set(['FILE','PATH','DIR','URL','URI','HOST','PORT','NAME','TYPE','MODE','ENABLED','LENGTH','EXPIRY','EXPIRES','TTL','HEADER','PREFIX','ENV','ID','COUNT','LIMIT','TIMEOUT','PROVIDER','SOURCE','FORMAT','VERSION','REQUIRED','HELPER','CMD','COMMAND','STORE','BACKEND']);
const words=name=>String(name).replace(/([a-z0-9])([A-Z])/g,'$1_$2').toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
function secretName(name){const w=words(name);return (w.some(x=>SECRET_WORDS.has(x))||/(KEY|TOKEN|SECRET|PASSWORD|PASSWD)$/i.test(name))&&!NOT_SECRET_END.has(w.at(-1));}
const PLACEHOLDER=/^(?:<[^>]*>|\$\{?[A-Za-z_]\w*\}?|%[A-Za-z_]\w*%|x{3,}|\*+|\.{2,}|…|your[\w-]*|changeme|replace[\w-]*|example|none|null|nil|undefined|true|false|yes|no|on|off|empty|required|optional|set|unset|\d{1,5})$/i;
// A value worth holding: not empty, a placeholder, a path, a link, a variable or an already masked value.
function plausible(v){v=String(v||'');return v.length>=4&&v.length<=16000&&!PLACEHOLDER.test(v)&&!/^(?:\/|~[\/\\]|\.{1,2}[\/\\]|[A-Za-z]:[\\\/])/.test(v)&&!v.includes('://')&&!/\$[({]|^\$|\*\*\*|…|\.\.\.|•/.test(v)&&!v.startsWith('[secret')&&!v.startsWith('[hidden');}
// Random enough to be a key: letters and digits, not a UUID or a words-and-numbers identifier, varied characters.
function random(v){
  const s=v.replace(/=+$/,'');if(s.length<32||!/[0-9]/.test(s)||!/[A-Za-z]/.test(s))return false;
  const parts=s.split(/[-_]+/).filter(Boolean);if(parts.length>=3&&parts.every(p=>p.length<=12))return false;
  const counts=new Map();for(const c of s)counts.set(c,(counts.get(c)||0)+1);let h=0;for(const n of counts.values()){const p=n/s.length;h-=p*Math.log2(p);}
  return h>=3.3;
}
const PROVIDER_WORDS=[[/open ?router/i,'OPENROUTER_API_KEY'],[/deep ?seek/i,'DEEPSEEK_API_KEY'],[/anthropic|claude/i,'ANTHROPIC_API_KEY'],[/open ?ai|chat ?gpt|codex/i,'OPENAI_API_KEY'],[/gemini|google/i,'GEMINI_API_KEY'],[/groq/i,'GROQ_API_KEY'],[/\bxai\b|\bgrok/i,'XAI_API_KEY'],[/mistral/i,'MISTRAL_API_KEY'],[/moonshot|kimi/i,'MOONSHOT_API_KEY'],[/together/i,'TOGETHER_API_KEY'],[/fireworks/i,'FIREWORKS_API_KEY'],[/cerebras/i,'CEREBRAS_API_KEY'],[/perplexity/i,'PERPLEXITY_API_KEY'],[/tavily/i,'TAVILY_API_KEY'],[/\bbrave\b/i,'BRAVE_API_KEY'],[/eleven ?labs/i,'ELEVENLABS_API_KEY'],[/\bz\.?ai\b|zhipu|\bglm\b/i,'ZAI_API_KEY'],[/minimax/i,'MINIMAX_API_KEY'],[/qwen|dashscope/i,'DASHSCOPE_API_KEY'],[/\bnous\b/i,'NOUS_API_KEY'],[/ollama/i,'OLLAMA_API_KEY'],[/telegram/i,'TELEGRAM_BOT_TOKEN'],[/discord/i,'DISCORD_BOT_TOKEN'],[/slack/i,'SLACK_BOT_TOKEN'],[/git ?hub/i,'GITHUB_TOKEN'],[/hugging ?face/i,'HF_TOKEN'],[/replicate/i,'REPLICATE_API_TOKEN']];
// The name the words just before a value suggest: an env-style name ("OPENROUTER_API_KEY is ..."), a provider
// ("my DeepSeek key: ..."), or password / token. Looks at the same line and the one before.
function contextName(text,start,fallback){
  const before=text.slice(Math.max(0,start-160),start),lines=before.split('\n'),near=lines.slice(-2).join(' ').slice(-120);
  const named=[...near.matchAll(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]*[A-Z0-9]\b/g)].map(m=>m[0]).filter(secretName).pop();if(named)return named;
  let best=null,at=-1;for(const [re,name] of PROVIDER_WORDS){const g=new RegExp(re.source,'gi');for(const m of near.matchAll(g))if(m.index>at){at=m.index;best=name;}}
  if(best)return best;
  if(/passw|passphrase|lozink|šifr|sifr/i.test(near))return 'PASSWORD';
  if(/token/i.test(near)&&!/api[ _-]?key|ključ|kljuc/i.test(near))return 'TOKEN';
  return fallback;
}
function envName(value,fallback=''){
  let s=String(value??'').trim()||fallback;
  if(!/^[A-Za-z_][A-Za-z0-9_]{0,79}$/.test(s))s=s.replace(/[\s./-]+/g,'_').replace(/[^A-Za-z0-9_]/g,'').replace(/^(\d)/,'_$1').toUpperCase().slice(0,80);
  if(!/^[A-Za-z_][A-Za-z0-9_]{0,79}$/.test(s))throw new Error('Use a variable name such as OPENAI_API_KEY (letters, digits and _).');
  return s;
}
// The variable a whole value's format suggests ('' when none fits).
function patternName(value){
  const v=String(value||'').trim();
  for(const p of PATTERNS){p.re.lastIndex=0;const m=p.re.exec(v);p.re.lastIndex=0;if(m&&m.index===0&&m[0].length===v.length)return {name:typeof p.name==='function'?p.name(v):p.name,generic:p.generic};}
  return null;
}
// The variable for a key pasted on its own, with the words the user wrote around it.
function guessName(value,context=''){
  const p=patternName(value),at=String(context).length+1;
  if(p)return p.generic&&context?contextName(context+' ',at,p.name):p.name;
  return context?contextName(context+' ',at,'API_KEY'):'API_KEY';
}
// A name the user wrote: env style (camelCase and lower case become UPPER_SNAKE); a generic one such as apiKey or
// token takes the name the value's format suggests.
const GENERIC=new Set(['API','KEY','KEYS','APIKEY','TOKEN','SECRET','ACCESS','AUTH','PASSWORD','PASS','PWD','PASSWD','VALUE','BEARER','PRIVATE','CLIENT','X']);
function explicitName(name,value){const w=words(name),n=envName(/[a-z]/.test(name)?w.join('_'):name);const p=w.every(x=>GENERIC.has(x))?patternName(value):null;return p?p.name:n;}
// First and last four characters of a key (two of a short one). Passwords and other values that are not keys show
// nothing: a few characters of a password say too much about it.
function mask(value){const v=String(value||'');if(/^-----BEGIN /.test(v))return 'private key';const n=v.length;if(!keyLike(v))return '•••';return n>=24?`${v.slice(0,4)}…${v.slice(-4)}`:`${v.slice(0,2)}…${v.slice(-2)}`;}
const reference=s=>`[secret ${s.id} · ${s.name} · ${s.mask}]`;
// "S1", "s1" or a whole reference: the secret id.
function secretId(value){const m=/\bS(\d{1,6})\b/i.exec(String(value||''));if(!m)throw new Error('Give the secret id, for example S1, from a [secret S1 · ...] reference.');return `S${Number(m[1])}`;}
// Secret-looking values in text, without overlaps, in order. long: also unknown formats that look random (user
// messages); phrase: "password: ..." in plain words (user messages).
function detect(text,{long=true,phrase=true}={}){
  text=String(text||'');const found=[],taken=[];
  const free=(s,e)=>!taken.some(([a,b])=>s<b&&e>a);
  const add=(start,end,value,name)=>{if(!value||end<=start||!free(start,end))return;taken.push([start,end]);found.push({start,end,value,name});};
  for(const re of [REF,HIDDEN])for(const m of text.matchAll(re))taken.push([m.index,m.index+m[0].length]);
  for(const m of text.matchAll(PEM))add(m.index,m.index+m[0].length,m[0],/OPENSSH|RSA|DSA|EC/.test(m[1])?'SSH_PRIVATE_KEY':'PRIVATE_KEY');
  for(const re of [ASSIGN,COLON])for(const m of text.matchAll(re)){
    const g=m.groups,name=g.name||g.qname,group=g.q1!==undefined?'q1':g.q2!==undefined?'q2':'bare';
    let value=g[group],[start]=m.indices.groups[group];if(group==='bare')value=value.replace(/[,;]+$|[.)\]}]+$/,'');
    if(!secretName(name)||!plausible(value))continue;
    add(start,start+value.length,value,explicitName(name,value));
  }
  for(const p of PATTERNS)for(const m of text.matchAll(p.re)){const name=typeof p.name==='function'?p.name(m[0]):p.name;add(m.index,m.index+m[0].length,m[0],p.generic?contextName(text,m.index,name):name);}
  if(phrase)for(const m of text.matchAll(PHRASE)){
    const value=m.groups.bare.replace(/[,;]+$|[.)\]}]+$/,''),[start]=m.indices.groups.bare,word=m.groups.word.toLowerCase();
    if(value.length<6||!plausible(value)||!/[^A-Za-z]/.test(value))continue;
    const name=/pass|lozink|šifr|sifr/.test(word)?'PASSWORD':/secret/.test(word)?'SECRET':contextName(text,m.index+m[0].length-m.groups.bare.length,/token/.test(word)?'TOKEN':'API_KEY');
    add(start,start+value.length,value,name);
  }
  if(long){
    const links=[...text.matchAll(URL_RE)].map(m=>[m.index,m.index+m[0].length]);
    for(const m of text.matchAll(LONG)){
      // Not secrets: hashes and digests, and SSH public keys (ssh-ed25519 AAAA...).
      const before=text.slice(Math.max(0,m.index-48),m.index);
      if(links.some(([a,b])=>m.index>=a&&m.index<b)||!random(m[0])||/(?:sha\d*[:-]|commit\s+|digest\s+)$/i.test(before)||/(?:ssh-[a-z0-9-]+|ecdsa-[a-z0-9-]+|sk-[a-z0-9-]+@openssh\.com)\s+$/i.test(before))continue;
      add(m.index,m.index+m[0].length,m[0],contextName(text,m.index,'API_KEY'));
    }
  }
  return found.sort((a,b)=>a.start-b.start);
}
// Replace spans found by detect() with what `label` returns for each.
function replaceSpans(text,spans,label){let out='',at=0;for(const s of spans){out+=text.slice(at,s.start)+label(s);at=s.end;}return out+text.slice(at);}
// Known prefixes are public ("sk-ant-api03-"): a fragment must reach past them to count.
function publicPrefix(v){const m=/^(?:sk-(?:ant-(?:api\d+-)?|or-(?:v\d+-)?|proj-|svcacct-|admin-)?|github_pat_|gh[pousr]_|xai-|AIza|gsk_|hf_|r8_|glpat-|xox[bpars]-|xapp-|pplx-|nvapi-|tvly-|csk-)/.exec(v);return m?m[0].length:0;}
// Keys (a known format or random-looking), not passwords: only their pieces are looked for, so a password such as
// mysecretpassword1 never hides the word "password" in a terminal.
const keyLike=v=>v.length>=16&&!/\s/.test(v)&&(publicPrefix(v)>0||random(v));
// Held values in text become their reference: whole values, and the pieces of a key a terminal wrapped over two lines
// or cut at its edge (a run that is part of the key, starts with its end or ends with its start).
function conceal(text,held){
  let out=String(text);if(!held?.length)return out;held=[...held].sort((a,b)=>String(b.value).length-String(a.value).length);
  // Short values (a PIN, a short password) only as a whole word, so they do not eat into port numbers and names.
  for(const h of held){const v=h.value;if(!v||v.length<4||!out.includes(v))continue;out=v.length>=8?out.split(v).join(h.ref):out.replace(new RegExp(`(?<![A-Za-z0-9])${v.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}(?![A-Za-z0-9])`,'g'),()=>h.ref);}
  const keys=held.filter(h=>h.value&&keyLike(h.value));if(!keys.length)return out;
  return out.replace(/[^\s│|┃]{8,}/g,run=>{
    const lead=/^["'`(\[{<]*/.exec(run)[0],core0=run.slice(lead.length),trail=/["'`)\]}>,;:.]*$/.exec(core0)[0],core=core0.slice(0,core0.length-trail.length);
    for(const h of keys){
      const v=h.value,min=Math.max(8,publicPrefix(v)+4),last=v[v.length-1];
      if(core.length>=8&&core.length<=v.length&&v.includes(core)&&(core.length>=min||!v.startsWith(core)))return lead+h.ref+trail;
      for(let i=core.indexOf(v[0],Math.max(0,core.length-v.length));i>=0&&core.length-i>=min;i=core.indexOf(v[0],i+1))if(v.startsWith(core.slice(i)))return lead+core.slice(0,i)+h.ref+trail;
      for(let j=Math.min(core.length,v.length);j>=8;j--)if(core[j-1]===last&&v.endsWith(core.slice(0,j)))return lead+h.ref+core.slice(j)+trail;
    }
    return run;
  });
}
// Text the model gets back: held values become their reference, other keys of known formats are hidden.
function shieldOutput(text,held){
  const concealed=conceal(text,held),spans=detect(concealed,{long:false,phrase:false});
  return spans.length?replaceSpans(concealed,spans,s=>`[hidden ${s.name} · ${mask(s.value)}]`):concealed;
}
function deep(value,fn,depth=0){
  if(typeof value==='string')return fn(value);
  if(depth>12||!value||typeof value!=='object')return value;
  if(Array.isArray(value))return value.map(v=>deep(v,fn,depth+1));
  const out={};for(const [k,v] of Object.entries(value))out[k]=deep(v,fn,depth+1);return out;
}
// A value as a .env line: bare when plain, single quotes otherwise (no ${} expansion in Hermes' python-dotenv or
// OpenClaw's dotenv), double quotes for a value with a single quote.
function envValue(v){
  if(/[\r\n\0]/.test(v))throw new Error('This secret has several lines, so it cannot go into a .env file.');
  if(/^[A-Za-z0-9_\-.:/+=@,~%^]+$/.test(v))return v;
  if(!v.includes("'"))return `'${v}'`;
  if(!/["\\$`]/.test(v))return `"${v}"`;
  throw new Error('This secret mixes quotes with \\, $ or `, so it cannot be written safely to a .env file.');
}
// Set NAME in .env text: the first NAME= line is replaced (export kept), later duplicates are dropped (the last one
// would win), a missing one is appended. Comments and other lines stay as they are.
function setEnv(text,name,value){
  const lines=String(text||'').replace(/\r\n/g,'\n').split('\n');if(lines.at(-1)==='')lines.pop();
  const re=new RegExp(`^\\s*(export\\s+)?${name}\\s*=`),out=[];let done=false;
  for(const line of lines){const m=re.exec(line);if(!m){out.push(line);continue;}if(done)continue;done=true;out.push(`${m[1]?'export ':''}${name}=${envValue(value)}`);}
  if(!done)out.push(`${name}=${envValue(value)}`);
  return out.join('\n')+'\n';
}
// Claude Code's settings.json with env.NAME set; everything else is kept. Invalid JSON is never overwritten.
function setJsonEnv(text,name,value){
  let data={};const raw=String(text||'').replace(/^\uFEFF/,'').trim();
  if(raw){try{data=JSON.parse(raw);}catch{throw new Error('settings.json is not valid JSON, so Opaya does not change it. Fix it first.');}}
  if(!data||typeof data!=='object'||Array.isArray(data))throw new Error('settings.json does not hold a JSON object, so Opaya does not change it.');
  if(data.env!==undefined&&(!data.env||typeof data.env!=='object'||Array.isArray(data.env)))throw new Error('settings.json has an env that is not an object, so Opaya does not change it.');
  data.env={...(data.env||{}),[name]:value};return JSON.stringify(data,null,2)+'\n';
}
// Files where an agent runs: this computer, an SSH machine or a container (see clone.cjs place()). dirAt resolves a
// fixed shell expression there, such as ${OPENCLAW_STATE_DIR:-$HOME/.openclaw}.
async function dirAt(where,expr='$HOME'){const dir=String(await run(where,`printf %s "${expr}"`)).trim();if(!dir.startsWith('/'))throw new Error('Could not find the home folder there.');return dir;}
async function readAt(where,file){
  if(isLocal(where)){try{const info=await fs.stat(file);if(info.size>1048576)throw new Error(`${file} is too large.`);return await fs.readFile(file,'utf8');}catch(error){if(error.code==='ENOENT')return '';throw error;}}
  // A file that exists but cannot be read fails here, so it is never replaced by one holding only the new line.
  return run(where,`f=${quote(file)}; if [ -e "$f" ]; then cat -- "$f"; fi`);
}
// Written to a temporary file next to it (mode 600) and moved over it, so a broken connection never leaves half a
// file. The content goes on stdin, never on a command line.
async function writeAt(where,file,content){
  if(isLocal(where)){
    await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});const real=await fs.realpath(file).catch(()=>file),tmp=`${real}.${randomUUID().slice(0,8)}.opaya-tmp`;
    try{await fs.writeFile(tmp,content,{mode:0o600,flag:'wx'});await fs.chmod(tmp,0o600).catch(()=>{});await fs.rename(tmp,real);}finally{await fs.rm(tmp,{force:true}).catch(()=>{});}
    return;
  }
  const script=`umask 077; f=${quote(file)}; [ -L "$f" ] && f=$(readlink -f -- "$f" 2>/dev/null || printf %s "$f"); mkdir -p -- "$(dirname -- "$f")" && cat > "$f.opaya-tmp" && chmod 600 "$f.opaya-tmp" && mv -f -- "$f.opaya-tmp" "$f"`;
  await collect(shell(where,script),{timeout:30000,input:content});
}
module.exports={PATTERNS,REF,detect,replaceSpans,guessName,patternName,contextName,envName,secretName,plausible,keyLike,mask,reference,secretId,conceal,shieldOutput,deep,envValue,setEnv,setJsonEnv,dirAt,readAt,writeAt};
