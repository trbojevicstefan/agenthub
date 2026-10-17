'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');const {execFileSync}=require('node:child_process');
const schema=require('../desktop/schema.cjs');const {quote,remoteCommand,sshArgs,environment,dockerExecArgs,dockerExecContainerIndex}=require('../desktop/process.cjs');
const {parseSSH,sshConfigHosts,scanLocal,envMetadata,fingerprint}=require('../desktop/discovery.cjs');
const {parseGatewayToken}=require('../desktop/credentials.cjs');const {Store,Vault,readJson}=require('../desktop/store.cjs');const {safeError}=require('../desktop/broker.cjs');const {temp,secure}=require('./helpers.cjs');

test('endpoints reject public plaintext, credentials, query and non-HTTP schemes',()=>{for(const u of ['http://vps.example/v1','https://u:p@host/v1','https://host/v1?key=a','file:///etc/passwd','javascript:alert(1)'])assert.throws(()=>schema.endpoint(u));});
test('loopback and authenticated HTTPS addresses normalize correctly',()=>{assert.equal(schema.endpoint('http://localhost:8642/v1/'),'http://127.0.0.1:8642/v1');assert.equal(schema.endpoint('https://host.example/v1'),'https://host.example/v1');assert.equal(schema.endpoint('http://[::1]:8642/v1',{ssh:true}),'http://[::1]:8642/v1');});
test('SSH tunnel endpoints are constrained to remote loopback',()=>{assert.throws(()=>schema.endpoint('https://example.com/v1',{ssh:true}));assert.throws(()=>schema.endpoint('http://192.168.1.2/v1',{ssh:true}));});
test('host validation prevents SSH option and command injection',()=>{for(const alias of ['-oProxyCommand=id','user@host','foo;whoami','foo\nbar'])assert.throws(()=>schema.host({alias}));assert.throws(()=>schema.host({hostname:'server',username:'x;id'}));assert.throws(()=>schema.host({hostname:'server',identityFile:'relative/key'}));});
test('identifiers and prompt lengths are bounded',()=>{for(const value of ['../x','x/y','',null,'a'.repeat(81),'__proto__','constructor','toString'])assert.throws(()=>schema.id(value));assert.throws(()=>schema.prompt('a'.repeat(80001)));assert.equal(schema.prompt('line1\nline2'),'line1\nline2');});
test('remote working directory, protocols and argument arrays validate',()=>{assert.throws(()=>schema.agent({name:'x',protocol:'acp',transport:'http'}));assert.throws(()=>schema.agent({name:'x',protocol:'codex',transport:'ssh',hostId:'h',command:'codex',cwd:'relative'}));assert.throws(()=>schema.agent({name:'x',protocol:'acp',command:'agent',args:'--unsafe'}));assert.equal(schema.agent({name:'x',protocol:'codex',command:'codex',cwd:path.resolve('.')}).provider,'custom');});
test('noninteractive SSH verifies host keys and does not forward the SSH agent',()=>{const a=sshArgs({alias:'my-vps'});assert(a.includes('StrictHostKeyChecking=yes'));assert(a.includes('BatchMode=yes'));assert(a.includes('ForwardAgent=no'));assert(!a.includes('-p'));const b=sshArgs({hostname:'x',username:'dev',port:2222},{interactive:true});assert(b.includes('StrictHostKeyChecking=ask'));assert(b.includes('2222'));});
test('POSIX quoting treats shell metacharacters as literal arguments',{skip:process.platform==='win32'},()=>{const input="a' ; echo INJECTED $(whoami)";const result=execFileSync('/bin/sh',['-c','printf %s '+quote(input)],{encoding:'utf8'});assert.equal(result,input);});
test('remote command quoting preserves argv, cwd and Hermes home',{skip:process.platform==='win32'},async t=>{const dir=await temp(t);const agent={cwd:dir,hermesHome:"/home/test/profile 'special'",command:process.execPath};const cmd=remoteCommand(agent,['-e','console.log(JSON.stringify([process.cwd(),process.env.HERMES_HOME,process.argv[1]]))',"literal;$(id)' x"]);const out=JSON.parse(execFileSync('/bin/sh',['-c',cmd],{encoding:'utf8'}));assert.deepEqual(out,[dir,agent.hermesHome,"literal;$(id)' x"]);});
test('Docker Hermes commands run inside the profile home, not /root',()=>{const agent={command:'docker',cwd:'/root',hermesHome:'/opt/data'};const args=dockerExecArgs(agent,['exec','-i','a2a-hermes-leads','hermes','acp']);assert.deepEqual(args,['exec','-i','-e','HOME=/opt/data','-e','HERMES_HOME=/opt/data','-w','/opt/data','a2a-hermes-leads','hermes','acp']);assert.equal(dockerExecContainerIndex(args),8);const cmd=remoteCommand(agent,['exec','-i','a2a-hermes-leads','hermes','acp']);assert(!cmd.includes("cd '/root'"));assert(cmd.includes("'HOME=/opt/data'"));assert(cmd.includes("'-w' '/opt/data'"));});
test('runtime injection variables are not inherited by agent children',()=>{const old=process.env.NODE_OPTIONS;process.env.NODE_OPTIONS='--inspect';assert.equal(environment().NODE_OPTIONS,undefined);if(old===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=old;});
test('SSH aliases skip wildcards, negation, comments and duplicate names',()=>{assert.deepEqual(parseSSH('Host * !bad\nHost alpha beta # not-a-host\nHost "gamma" alpha\nHost *.example\nMatch all\n'),[{name:'alpha',alias:'alpha'},{name:'beta',alias:'beta'},{name:'gamma',alias:'gamma'}]);});
test('SSH Include globs resolve without executing configuration directives',async t=>{const dir=await temp(t);await fs.mkdir(path.join(dir,'.ssh/conf.d'),{recursive:true});await fs.writeFile(path.join(dir,'.ssh/config'),'Host root\nInclude conf.d/*.conf # not-a-file\nProxyCommand touch /never-executed\n');await fs.writeFile(path.join(dir,'.ssh/conf.d/a.conf'),'Host private\nInclude ../config\n');const out=await sshConfigHosts(dir);assert.deepEqual(out.map(h=>h.alias).sort(),['private','root']);});
test('discovery metadata never includes API/provider secrets',()=>{const data=envMetadata('API_SERVER_ENABLED=true\nAPI_SERVER_PORT=8643\nAPI_SERVER_KEY=GATEWAY_SECRET\nOPENAI_API_KEY=PROVIDER_SECRET');assert.deepEqual(data,{API_SERVER_ENABLED:'true',API_SERVER_PORT:'8643'});assert(!JSON.stringify(data).includes('SECRET'));});
// A Hermes installation in its own venv, so discovery sees Hermes as installed.
const fakeHermes=async root=>{const file=process.platform==='win32'?path.join(root,'hermes-agent','.venv','Scripts','hermes.exe'):path.join(root,'hermes-agent','.venv','bin','hermes');await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,'',{mode:0o755});return file;};
test('local discovery separates four Hermes profiles without reading their tokens into results',async t=>{const dir=await temp(t);await fakeHermes(path.join(dir,'.hermes'));for(const [i,name]of ['default','research','ops','support'].entries()){const root=name==='default'?path.join(dir,'.hermes'):path.join(dir,'.hermes/profiles',name);await fs.mkdir(root,{recursive:true});await fs.writeFile(path.join(root,'.env'),`API_SERVER_ENABLED=true\nAPI_SERVER_PORT=${8642+i}\nAPI_SERVER_KEY=DO_NOT_EXPOSE\n`);}const result=await scanLocal({home:dir,probe:false});const hermes=result.agents.filter(a=>a.provider==='hermes');assert.equal(hermes.length,4);assert.equal(new Set(hermes.map(a=>a.endpoint)).size,4);assert(!JSON.stringify(result).includes('DO_NOT_EXPOSE'));});
test('local discovery includes profiles below an alternate Hermes home',async t=>{const dir=await temp(t),appRoot=path.join(dir,'AppData','Local','hermes');await fakeHermes(appRoot);for(const name of ['blondie','coder','daemon']){const root=path.join(appRoot,'profiles',name);await fs.mkdir(root,{recursive:true});await fs.writeFile(path.join(root,'.env'),'API_SERVER_ENABLED=true\nAPI_SERVER_PORT=8700\nAPI_SERVER_KEY=DO_NOT_EXPOSE\n');}const result=await scanLocal({home:dir,extraHomes:[appRoot],probe:false});const names=result.agents.filter(a=>a.provider==='hermes').map(a=>a.name);assert(names.includes('Hermes / blondie'));assert(names.includes('Hermes / coder'));assert(names.includes('Hermes / daemon'));assert(!JSON.stringify(result).includes('DO_NOT_EXPOSE'));});
test('discovery fingerprints ignore display name but preserve instance identity',()=>{const a={provider:'hermes',transport:'ssh',hostId:'host-a',endpoint:'http://127.0.0.1:8642/v1'};assert.equal(fingerprint({...a,name:'one'}),fingerprint({...a,name:'two'}));assert.notEqual(fingerprint(a),fingerprint({...a,hostId:'host-b'}));});
test('explicit gateway token import returns only the named key',()=>{assert.equal(parseGatewayToken('OPENAI_API_KEY=provider\nAPI_SERVER_KEY="gateway-token"'),'gateway-token');assert.equal(parseGatewayToken('export API_SERVER_KEY=token # comment'),'token');assert.throws(()=>parseGatewayToken('API_SERVER_KEY=${OTHER}'));assert.throws(()=>parseGatewayToken('OPENAI_API_KEY=other'));});
test('atomic store queues immutable snapshots and reloads transcripts',async t=>{const dir=await temp(t),store=new Store(dir),data=await store.load();data.agents.push({id:'first'});const p=store.write(data);data.agents.push({id:'second'});await p;assert.equal((await store.load()).agents.length,1);await store.writeTranscript('conv',[{role:'user',content:'hello'}]);assert.equal((await store.transcript('conv'))[0].content,'hello');await store.deleteTranscript('conv');assert.deepEqual(await store.transcript('conv'),[]);});
test('corrupt workspace data is preserved rather than overwritten',async t=>{const dir=await temp(t),file=path.join(dir,'workspace.json');await fs.writeFile(file,'{bad json');await assert.rejects(()=>new Store(dir).load(),/preserved/);assert.equal(await fs.readFile(file,'utf8'),'{bad json');});
test('vault persists ciphertext through an injected OS storage interface',async t=>{const dir=await temp(t),v=new Vault(dir,secure());await v.load();await v.set('a','secret');assert.equal(v.get('a'),'secret');const raw=await readJson(path.join(dir,'vault.json'),{});assert(!JSON.stringify(raw).includes('secret'));const v2=new Vault(dir,secure());await v2.load();assert.equal(v2.get('a'),'secret');await v2.remove('a');assert.equal(v2.has('a'),false);});
test('vault refuses plaintext Linux fallback and allows RAM-only tokens',async t=>{const dir=await temp(t),v=new Vault(dir,{...secure(),getSelectedStorageBackend:()=> 'basic_text'});await v.load();assert.equal(v.available(),false);await assert.rejects(()=>v.set('a','secret',true),/OS encryption/);await v.set('a','secret',false);assert.equal(v.get('a'),'secret');assert(!JSON.stringify(await readJson(path.join(dir,'vault.json'),{})).includes('secret'));});
test('concurrent vault updates do not lose encrypted credentials',async t=>{const dir=await temp(t),v=new Vault(dir,secure());await v.load();await Promise.all([v.set('a','one'),v.set('b','two')]);const v2=new Vault(dir,secure());await v2.load();assert.equal(v2.get('a'),'one');assert.equal(v2.get('b'),'two');});
test('error presentation redacts API credentials',()=>{assert(!safeError(new Error('Bearer value; sk-abcdefghijklmnop TOKEN'),'TOKEN').includes('TOKEN'));assert(!safeError(new Error('Bearer supersecret')).includes('supersecret'));});
test('agent icons accept only library names or small raster data URLs',()=>{const schema=require('../desktop/schema.cjs');assert.equal(schema.avatar('lib:codex'),'lib:codex');assert.equal(schema.avatar(''),'');assert.equal(schema.avatar('data:image/png;base64,iVBORw0KGgo='),'data:image/png;base64,iVBORw0KGgo=');for(const bad of ['lib:../x','data:image/svg+xml;base64,PHN2Zz4=','javascript:alert(1)','https://example.com/x.png','data:image/png;base64,'+'A'.repeat(200001)])assert.throws(()=>schema.avatar(bad),/icon/);});
test('OpenClaw gateway token import reads only gateway.auth.token',()=>{
  const {parseOpenclawToken}=require('../desktop/credentials.cjs');
  assert.equal(parseOpenclawToken(JSON.stringify({models:{providers:{openai:{apiKey:'sk-secret'}}},gateway:{auth:{token:'gw-token'}}})),'gw-token');
  assert.throws(()=>parseOpenclawToken(JSON.stringify({models:{apiKey:'sk-secret'}})),/No OpenClaw gateway token/);
  assert.throws(()=>parseOpenclawToken('{gateway:{auth:{token:"x"}}}'),/not plain JSON/);
  assert.throws(()=>parseOpenclawToken(JSON.stringify({gateway:{auth:{token:'${OPENCLAW_TOKEN}'}}})),/environment expansion/);
});
test('OpenClaw config without keys drops credentials and keeps settings and SecretRefs',()=>{
  const {openclawWithoutSecrets}=require('../desktop/credentials.cjs');
  const ref={source:'env',provider:'default',id:'ANTHROPIC_API_KEY'};
  const config={gateway:{port:18789,auth:{mode:'token',token:'gw-token',password:'gw-pass'},remote:{token:'remote-token'}},
    models:{providers:{openai:{apiKey:'sk-secret',headers:{Authorization:'Bearer sk-header','x-api-key':'sk-x'},models:[{id:'gpt',maxTokens:8192}]},anthropic:{apiKey:ref}}},
    channels:{telegram:{botToken:'123:abc',dmPolicy:'pairing'},slack:{appToken:'xapp',signingSecret:'sig',relay:{authToken:'relay-secret'}}},
    skills:{entries:{lab:{apiKey:'skill-key',enabled:true}}},env:{OPENROUTER_API_KEY:'sk-or',vars:{GROQ:'gsk'},shellEnv:{enabled:true}},agents:{defaults:{model:'openai/gpt'}}};
  const out=openclawWithoutSecrets(JSON.stringify(config));
  for(const value of ['gw-token','gw-pass','remote-token','sk-secret','sk-header','sk-x','123:abc','xapp','sig','relay-secret','skill-key','sk-or','gsk'])assert(!out.includes(value),value);
  assert.deepEqual(JSON.parse(out),{gateway:{port:18789,auth:{mode:'token'},remote:{}},models:{providers:{openai:{headers:{},models:[{id:'gpt',maxTokens:8192}]},anthropic:{apiKey:ref}}},
    channels:{telegram:{dmPolicy:'pairing'},slack:{relay:{}}},skills:{entries:{lab:{enabled:true}}},env:{vars:{},shellEnv:{enabled:true}},agents:{defaults:{model:'openai/gpt'}}});
  const kept=JSON.parse(openclawWithoutSecrets(JSON.stringify(config),JSON.stringify({gateway:{auth:{token:'clone-token'}},channels:{telegram:{botToken:'clone-bot'}}})));
  assert.equal(kept.gateway.auth.token,'clone-token');assert.equal(kept.channels.telegram.botToken,'clone-bot');assert.equal(kept.models.providers.openai.apiKey,undefined);
  assert.equal(openclawWithoutSecrets('{gateway:{auth:{token:"x"}}}'),null);
  assert.equal(openclawWithoutSecrets('[]'),null);
});
test('discovery ignores data an uninstall left behind',async t=>{
  const dir=await temp(t);await fs.mkdir(path.join(dir,'.hermes','profiles','work'),{recursive:true});await fs.writeFile(path.join(dir,'.hermes','.env'),'API_SERVER_ENABLED=true\n');await fs.writeFile(path.join(dir,'.hermes','profiles','work','.env'),'X=1\n');
  await fs.mkdir(path.join(dir,'.openclaw'),{recursive:true});await fs.writeFile(path.join(dir,'.openclaw','openclaw.json'),'{}');
  const result=await scanLocal({home:dir,probe:false});
  if(!require('../desktop/process.cjs').findExecutable('hermes'))assert.equal(result.agents.some(a=>a.provider==='hermes'),false);
  if(!require('../desktop/process.cjs').findExecutable('openclaw'))assert.equal(result.agents.some(a=>a.provider==='openclaw'),false);
  assert(result.warnings.some(w=>/OpenClaw is not installed/.test(w)));
  const installed=await fakeHermes(path.join(dir,'.hermes'));
  const again=await scanLocal({home:dir,probe:false});assert.equal(again.agents.filter(a=>a.provider==='hermes').length,2);assert(again.agents.every(a=>a.provider!=='hermes'||a.command===installed||a.command.endsWith('hermes')||a.command.endsWith('hermes.exe')));
});
test('browser addresses with a hostname and port open, other schemes stay refused',()=>{
  const {normalize}=require('../desktop/browser.cjs');
  assert.equal(normalize('localhost:3000'),'http://localhost:3000');
  assert.equal(normalize('localhost:3000/app?x=1'),'http://localhost:3000/app?x=1');
  assert.equal(normalize('example.com:8443/path'),'https://example.com:8443/path');
  assert.equal(normalize('example.com:8443?q=1'),'https://example.com:8443?q=1');
  assert.equal(normalize('127.0.0.1:3000'),'http://127.0.0.1:3000');assert.equal(normalize('http://localhost:3000'),'http://localhost:3000');
  assert.equal(normalize('example.com'),'https://example.com');assert.match(normalize('what is node'),/^https:\/\/duckduckgo\.com\/\?q=/);
  for(const bad of ['javascript:alert(1)','file:///etc/passwd','mailto:x@y.z','about:blank','data:text/html,<b>x</b>'])assert.throws(()=>normalize(bad),/Only http and https/,bad);
});
test('OpenClaw stores without keys keep their state and lose auth profiles, the secret store and device keys',{skip:require('./helpers.cjs').noPython||(process.platform==='win32'&&'uses POSIX sh')},async t=>{
  const {openclawStores}=require('../desktop/credentials.cjs'),home=await temp(t),fixture=await require('./helpers.cjs').openclawStores(home),here={host:null,container:''};
  const r=await openclawStores(here,home);t.after(()=>fs.rm(r.dir,{recursive:true,force:true}));
  assert.deepEqual(r.files.sort(),Object.keys(fixture.state).sort());assert.deepEqual(r.missing,[]);
  for(const f of r.files){
    const raw=await fs.readFile(path.join(r.dir,f));
    for(const x of fixture.secrets)assert(!raw.includes(x),`${f} still holds ${x}`);
    for(const x of fixture.state[f])assert(raw.includes(x),`${f} keeps ${x}`);
  }
  assert.deepEqual(await fs.readdir(path.join(r.dir,'.openclaw/state')),['openclaw.sqlite'],'one file, without the WAL');
  // A python3 that cannot make the copy: the stores are left out, never copied as they are.
  const bin=path.join(home,'.local','bin'),old=process.env.HOME;await fs.mkdir(bin,{recursive:true});await fs.writeFile(path.join(bin,'python3'),'#!/bin/sh\nexit 1\n',{mode:0o755});
  process.env.HOME=home;t.after(()=>{process.env.HOME=old;});
  const failed=await openclawStores(here,home);
  assert.equal(failed.dir,'');assert.deepEqual(failed.files,[]);assert.deepEqual(failed.missing.sort(),Object.keys(fixture.state).sort());
});
