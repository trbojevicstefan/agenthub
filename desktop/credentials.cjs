'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {launch,collect,dockerExecContainerIndex,quote,REMOTE_PATH}=require('./process.cjs');
function parseGatewayToken(raw){
  for(const line of raw.split(/\r?\n/)){
    const m=line.match(/^\s*(?:export\s+)?API_SERVER_KEY\s*=\s*(.*?)\s*$/);
    if(!m)continue;
    let value=m[1];
    if((value.startsWith('"')&&value.endsWith('"'))||(value.startsWith("'")&&value.endsWith("'")))value=value.slice(1,-1);
    else value=value.split(/\s+#/)[0].trim();
    if(!value||value.length>16000||/[\r\n\0]/.test(value))throw new Error('The gateway token is empty or unsupported. Enter it manually.');
    if(value.includes('${'))throw new Error('The gateway token uses environment expansion. Enter its resolved value manually.');
    return value;
  }
  throw new Error('API_SERVER_KEY was not found in this profile. Configure the gateway API first.');
}
// OpenClaw keeps its gateway token in ~/.openclaw/openclaw.json (gateway.auth.token).
function parseOpenclawToken(raw){
  let config;try{config=JSON.parse(raw);}catch{throw new Error('OpenClaw\'s config is not plain JSON, so Opaya cannot read its gateway token. Enter it manually (openclaw config get gateway.auth.token).');}
  const value=config?.gateway?.auth?.token;
  if(typeof value!=='string'||!value||value.length>16000||/[\r\n\0]/.test(value))throw new Error('No OpenClaw gateway token was found (gateway.auth.token). Finish openclaw onboard first, or enter the token manually.');
  if(value.includes('${'))throw new Error('The OpenClaw gateway token uses environment expansion. Enter its resolved value manually.');
  return value;
}
// openclaw.json keeps credentials next to settings: the gateway token and password, provider API keys, channel tokens
// and secrets, request headers and inline environment variables (`env`). A copy without keys drops those strings and
// keeps SecretRef objects ({source, provider, id}), which only point at a secret. `keep` is the config already at the
// target (a redeploy), whose own credentials stay. Returns null for a config that is not plain JSON (JSON5).
const OPENCLAW_SECRET=/(token|password|secret|api[_-]?key|private[_-]?key|access[_-]?key|service[_-]?account|authorization|cookie)s?$/i;
function openclawWithoutSecrets(raw,keep=''){
  let config,own=null;
  try{config=JSON.parse(raw);}catch{return null;}
  if(!config||typeof config!=='object'||Array.isArray(config))return null;
  try{own=JSON.parse(keep);}catch{}
  const secret=v=>typeof v==='string'||Array.isArray(v)&&v.length>0&&v.every(x=>typeof x==='string');
  const scrub=(node,mine,env)=>{
    if(!node||typeof node!=='object')return;
    for(const key of Object.keys(node)){
      const value=node[key],other=mine&&typeof mine==='object'?mine[key]:undefined;
      if((env||OPENCLAW_SECRET.test(key))&&secret(value)){if(secret(other))node[key]=other;else delete node[key];}
      else scrub(value,other,env||(node===config&&key==='env'));
    }
  };
  scrub(config,own,false);
  return JSON.stringify(config,null,2)+'\n';
}
// OpenClaw's SQLite stores keep credentials next to sessions, cron jobs and other state: auth profiles, the secret
// store, MCP OAuth tokens, device tokens and identities, and paired devices' tokens. A copy without keys takes each store
// with SQLite's online backup where OpenClaw runs (python3), deletes those rows and compacts it, so no deleted value
// stays in free pages. Without python3 a store is left out, never copied as it is. Paths are relative to the home folder.
const OPENCLAW_STORES=['.openclaw/state/openclaw.sqlite','.openclaw/agents/*/agent/openclaw-agent.sqlite'];
const STORE_SECRETS={clear:['auth_profile_store','auth_profile_state','auth_profile_stores','secret_store_entries','mcp_oauth_stores','mcp_oauth_pending_authorizations',
  'device_auth_tokens','device_bootstrap_tokens','gateway_origin_device_tokens','device_identities','device_pairing_paired','device_pairing_pending','device_pairing_join_codes'],
  rows:[['config_machine_state','state_key','authProfiles.%']]};
const SCRUB_PY=['import json,pathlib,sqlite3,sys','rules=json.loads(sys.argv[3])','s=sqlite3.connect(pathlib.Path(sys.argv[1]).as_uri()+"?mode=ro",uri=True,timeout=30)',
  'd=sqlite3.connect(sys.argv[2])','s.backup(d)','s.close()','d.execute("PRAGMA journal_mode=DELETE")','d.execute("PRAGMA secure_delete=ON")',
  'have={r[0] for r in d.execute("SELECT name FROM sqlite_master WHERE type=\'table\'")}',
  'for t in rules["clear"]:\n  if t in have:d.execute(\'DELETE FROM "%s"\'%t)',
  'for t,c,v in rules["rows"]:\n  if t in have:d.execute(\'DELETE FROM "%s" WHERE "%s" LIKE ?\'%(t,c),(v,))',
  'd.commit()','d.execute("VACUUM")','d.close()'].join('\n');
// The stores under `home`, without credentials, in a new temporary folder there under the same paths. Returns
// {dir, files, missing}: `files` are in `dir` (the caller removes it); `missing` were left out (no python3, a failed copy).
async function openclawStores(where,home){
  const {run,isLocal}=require('./clone.cjs');
  if(isLocal(where)&&process.platform==='win32'){
    const found=[],has=f=>fs.access(path.join(home,f)).then(()=>true,()=>false);
    if(await has(OPENCLAW_STORES[0]))found.push(OPENCLAW_STORES[0]);
    for(const id of await fs.readdir(path.join(home,'.openclaw','agents')).catch(()=>[])){const f=`.openclaw/agents/${id}/agent/openclaw-agent.sqlite`;if(await has(f))found.push(f);}
    return {dir:'',files:[],missing:found};
  }
  const script=[REMOTE_PATH,`cd ${quote(home)} || exit 1`,`stores() { for f in ${OPENCLAW_STORES.join(' ')}; do [ -f "$f" ] && printf '%s\\n' "$f"; done; }`,
    'if ! command -v python3 >/dev/null 2>&1; then stores | sed "s/^/@@fail /"; exit 0; fi',
    'tmp=$(mktemp -d "${TMPDIR:-/tmp}/opaya-stores.XXXXXX") || exit 1','printf "@@dir %s\\n" "$tmp"',
    `stores | while IFS= read -r f; do mkdir -p "$tmp/$(dirname "$f")" && python3 -c ${quote(SCRUB_PY)} "$PWD/$f" "$tmp/$f" ${quote(JSON.stringify(STORE_SECRETS))} >&2 && printf "@@ok %s\\n" "$f" || { rm -f "$tmp/$f"; printf "@@fail %s\\n" "$f"; }; done`].join('\n');
  const out=await run(where,script,10*60*1000),lines=tag=>[...out.matchAll(new RegExp(`^@@${tag} (.+)$`,'gm'))].map(m=>m[1].trim());
  const dir=lines('dir')[0]||'',files=lines('ok'),missing=lines('fail');
  if(dir&&!files.length){await run(where,`rm -rf ${quote(dir)}`).catch(()=>{});return {dir:'',files,missing};}
  return {dir,files,missing};
}
async function importOpenclawToken(agent,host){
  // In a container Opaya installed, the gateway token is in the container's environment (it is never written to a file).
  const index=agent.command==='docker'?dockerExecContainerIndex(agent.args||[]):-1;
  if(index>=0){
    const container=agent.args[index],run=args=>collect(launch({...agent,command:'docker',args:[],hermesHome:''},['exec',container,...args],host),{maxBytes:1100000,timeout:15000});
    const env=String(await run(['sh','-c','printf %s "$OPENCLAW_GATEWAY_TOKEN"']).catch(()=>'')).trim();
    if(env&&env.length<=16000&&!/\s/.test(env))return env;
    return parseOpenclawToken(await run(['cat','/home/node/.openclaw/openclaw.json']));
  }
  if(agent.transport!=='ssh'){
    const file=path.join(require('node:os').homedir(),'.openclaw','openclaw.json');const info=await fs.stat(file);
    if(info.size>1048576)throw new Error('OpenClaw config is too large.');
    return parseOpenclawToken(await fs.readFile(file,'utf8'));
  }
  const code=[
    'import sys,pathlib,json',
    'p=pathlib.Path.home()/".openclaw"/"openclaw.json"',
    'assert p.stat().st_size <= 1048576, "config too large"',
    'c=json.loads(p.read_text())',
    't=((c.get("gateway") or {}).get("auth") or {}).get("token") or ""',
    'print(json.dumps({"gateway":{"auth":{"token":t}}}))'
  ].join('\n');
  const child=launch({...agent,command:'python3',hermesHome:''},['-c',code],host);
  return parseOpenclawToken(await collect(child,{maxBytes:40000,timeout:15000}));
}
async function importGatewayToken(agent,host){
  if(agent.provider==='openclaw')return importOpenclawToken(agent,host);
  if(agent.provider!=='hermes'||!agent.hermesHome)throw new Error('Token import requires a Hermes profile path.');
  if(agent.transport!=='ssh'){
    const file=path.join(agent.hermesHome,'.env');const info=await fs.stat(file);
    if(info.size>262144)throw new Error('Profile environment file is too large.');
    return parseGatewayToken(await fs.readFile(file,'utf8'));
  }
  const dockerIndex = agent.command === 'docker' ? dockerExecContainerIndex(agent.args || []) : -1;
  const dockerExec = dockerIndex >= 0 ? agent.args[dockerIndex] : '';
  if(dockerExec){
    const child=launch({...agent,command:'docker',args:[],hermesHome:''},['exec',dockerExec,'cat',path.posix.join(agent.hermesHome,'.env')],host);
    try{return parseGatewayToken(await collect(child,{maxBytes:300000,timeout:15000}));}
    catch(error){
      if(/No such file|not found|API_SERVER_KEY was not found/i.test(String(error?.message||error)))throw new Error('API_SERVER_KEY was not found in the Docker Hermes profile. Enter the gateway token manually, or add API_SERVER_KEY to the container profile .env and restart the gateway.');
      throw error;
    }
  }
  const code=[
    'import sys,pathlib,re,json',
    'p=pathlib.Path(sys.argv[1])/".env"',
    'assert p.stat().st_size <= 262144, "environment file too large"',
    'lines=p.read_text().splitlines()',
    'm=next((re.match(r"^\\s*(?:export\\s+)?API_SERVER_KEY\\s*=\\s*(.*?)\\s*$",x) for x in lines if re.match(r"^\\s*(?:export\\s+)?API_SERVER_KEY\\s*=",x)),None)',
    'print(json.dumps({"line": "API_SERVER_KEY="+m.group(1) if m else ""}))'
  ].join('\n');
  const child=launch({...agent,command:'python3',hermesHome:''},['-c',code,agent.hermesHome],host);
  const response=JSON.parse(await collect(child,{maxBytes:20000,timeout:15000}));
  return parseGatewayToken(response.line||'');
}
module.exports={parseGatewayToken,parseOpenclawToken,openclawWithoutSecrets,OPENCLAW_STORES,openclawStores,importGatewayToken};
