'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');
const {Broker}=require('../desktop/broker.cjs');const {Store,Vault}=require('../desktop/store.cjs');const {OpayaAgent}=require('../desktop/opaya-agent.cjs');
const vaultImport=require('../desktop/vault-import.cjs');const {temp,secure}=require('./helpers.cjs');
const OPENAI_KEY='sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd',ROUTER_KEY='sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef',GH='ghp_0123456789abcdefABCDEF0123456789abcd';
async function fixture(t,options={}){
  const root=await temp(t),broker=new Broker({store:new Store(root),vault:new Vault(root,secure()),emit:()=>{},approve:async()=>true,adapterFactory:()=>({connect:async()=>({}),close(){},run:async()=>({})})});await broker.init();t.after(()=>broker.close());
  const agent=new OpayaAgent({root,vault:broker.vault,broker,terminals:{describe:()=>[]},approve:async()=>true,emit:()=>{},runInTerminal:async()=>({id:'x'}),fetchImpl:async()=>({ok:true,status:200,json:async()=>({})}),trusted:()=>false,...options});
  await agent.init();return {root,agent,broker};
}
test('a .env file: key-like names with their values; settings, paths and placeholders are left out',()=>{
  const items=vaultImport.scanText([
    '# keys','export OPENAI_API_KEY="'+OPENAI_KEY+'"','OPENROUTER_API_KEY='+ROUTER_KEY+' # router',"DB_PASSWORD='s3cr3t-Pa55'",
    'API_KEY_FILE=/run/secrets/key','PORT=8080','ANTHROPIC_API_KEY=your-key-here','EMPTY_TOKEN=','DEBUG=true'
  ].join('\n'));
  assert.deepEqual(items.map(x=>[x.name,x.value]),[['OPENAI_API_KEY',OPENAI_KEY],['OPENROUTER_API_KEY',ROUTER_KEY],['DB_PASSWORD','s3cr3t-Pa55']]);
});
test('any text file: JSON settings, YAML and known key formats in prose, each value once',()=>{
  const json=vaultImport.scanText(JSON.stringify({env:{OPENAI_API_KEY:OPENAI_KEY},other:{apiKey:ROUTER_KEY},name:'x'},null,2));
  assert.deepEqual(json.map(x=>x.name).sort(),['OPENAI_API_KEY','OPENROUTER_API_KEY']);
  const yaml=vaultImport.scanText(`github.com:\n    oauth_token: ${GH}\n    user: me\n`);assert.deepEqual(yaml.map(x=>[x.name,x.value]),[['GITHUB_TOKEN',GH]]);
  const prose=vaultImport.scanText(`My router key is ${ROUTER_KEY} and again ${ROUTER_KEY}.`);assert.deepEqual(prose.map(x=>x.value),[ROUTER_KEY]);
  const aws=vaultImport.scanText('[default]\naws_access_key_id = AKIAABCDEFGHIJKLMNOP\naws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEYab\n');
  assert.deepEqual(aws.map(x=>x.name).sort(),['AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY']);
});
test('pasted text also finds unknown random-looking keys; a file only named ones',()=>{
  const odd='Zq8xT2mK9vB4nR7wL1pC6yH3jF5dG0sA8eU2iO4';
  assert.equal(vaultImport.scanText(`here: ${odd}`,{long:true}).length,1);assert.equal(vaultImport.scanText(`here: ${odd}`).length,0);
});
test('tools: shell profiles, npm and the GitHub CLI on this computer, with their own names renamed',async t=>{
  const home=await temp(t);await fs.mkdir(path.join(home,'.config','gh'),{recursive:true});
  await fs.writeFile(path.join(home,'.zshrc'),`alias ll='ls -l'\nexport OPENAI_API_KEY=${OPENAI_KEY}\n`);
  await fs.writeFile(path.join(home,'.npmrc'),'//registry.npmjs.org/:_authToken=npm_abcdefghijklmnopqrstuvwxyz0123456789\n');
  await fs.writeFile(path.join(home,'.config','gh','hosts.yml'),`github.com:\n  oauth_token: ${GH}\n`);
  const sources=await vaultImport.scanTools({home,platform:'linux',env:{GROQ_API_KEY:'gsk_abcdefghijklmnopqrstuvwxyz012345',PATH:'/usr/bin'}});
  const by=Object.fromEntries(sources.map(s=>[s.id,s.items.map(x=>x.name)]));
  assert.deepEqual(by,{'shell.zshrc':['OPENAI_API_KEY'],gh:['GITHUB_TOKEN'],npm:['NPM_TOKEN'],environment:['GROQ_API_KEY']});
});
test('tools: each agent\'s own key file, and an agent that does not answer is listed with the reason',async t=>{
  const agents=[{id:'a',name:'Hermes'},{id:'b',name:'Remote'}];
  const readKeys=async a=>{if(a.id==='b')throw new Error('ssh: connection refused');return {kind:'hermes',file:'/h/.env',values:new Map([['OPENROUTER_API_KEY',ROUTER_KEY]])};};
  const home=await temp(t),sources=await vaultImport.scanTools({agents,readKeys,home,platform:'linux',env:{}});
  assert.deepEqual(sources.map(s=>[s.label,s.items.map(x=>x.name),s.error||'']),[['Hermes',['OPENROUTER_API_KEY'],''],['Remote',[],'ssh: connection refused']]);
});
test('import: a scan returns names and masks only, the picked keys go into the vault once, under the name the user chose',async t=>{
  const {agent,root}=await fixture(t),file=path.join(root,'project.env');
  await fs.writeFile(file,`OPENAI_API_KEY=${OPENAI_KEY}\nOPENROUTER_API_KEY=${ROUTER_KEY}\n`);
  const before=await agent.holdFromUser({value:ROUTER_KEY});
  const scan=await agent.vaultImportScan({file});
  assert(!JSON.stringify(scan).includes(OPENAI_KEY.slice(8))&&!JSON.stringify(scan).includes(ROUTER_KEY.slice(10)),'no values leave the service');
  const [src]=scan.sources;assert.equal(src.label,'project.env');assert.deepEqual(src.items.map(x=>[x.name,x.inVault]),[['OPENAI_API_KEY',''],['OPENROUTER_API_KEY',before.name]]);
  const r=await agent.vaultImportCommit({id:scan.id,picks:src.items.map(x=>({key:x.key,name:x.name==='OPENAI_API_KEY'?'work openai key':x.name}))});
  assert.deepEqual(r.imported.map(x=>x.name),['WORK_OPENAI_KEY']);assert.deepEqual(r.skipped,[{name:'OPENROUTER_API_KEY',why:'already in the Vault'}]);
  const kept=agent.describe().secrets.filter(s=>s.kept);assert.deepEqual(kept.map(s=>s.name).sort(),['OPENROUTER_API_KEY','WORK_OPENAI_KEY']);
  assert.equal(agent.secretValue(agent.secrets.find(s=>s.name==='WORK_OPENAI_KEY')),OPENAI_KEY);
  await assert.rejects(()=>agent.vaultImportCommit({id:scan.id,picks:[{key:src.items[0].key}]}),/expired/,'a scan is used once');
});
test('import: pasted text, binary and large files, and a file that is not there',async t=>{
  const {agent,root}=await fixture(t);
  const scan=await agent.vaultImportScan({text:`openai: ${OPENAI_KEY}`});assert.deepEqual(scan.sources[0].items.map(x=>x.name),['OPENAI_API_KEY']);
  const bin=path.join(root,'x.bin');await fs.writeFile(bin,Buffer.from([1,0,2]));await assert.rejects(()=>agent.vaultImportScan({file:bin}),/not a text file/);
  const big=path.join(root,'big.txt');await fs.writeFile(big,'x'.repeat(vaultImport.MAX_BYTES+1));await assert.rejects(()=>agent.vaultImportScan({file:big}),/larger than 1 MB/);
  await assert.rejects(()=>agent.vaultImportScan({file:path.join(root,'none.env')}),/does not exist/);
  await assert.rejects(()=>agent.vaultImportScan({}),/Choose a file/);
});
test('a .env saved as UTF-16 (Windows Notepad) and a PowerShell profile are read as text',async t=>{
  const home=await temp(t),file=path.join(home,'win.env');await fs.writeFile(file,Buffer.concat([Buffer.from([0xff,0xfe]),Buffer.from(`OPENAI_API_KEY=${OPENAI_KEY}\r\n`,'utf16le')]));
  assert.deepEqual(vaultImport.scanText(await vaultImport.readTextFile(file)).map(x=>x.name),['OPENAI_API_KEY']);
  await fs.mkdir(path.join(home,'Documents','PowerShell'),{recursive:true});await fs.writeFile(path.join(home,'Documents','PowerShell','Microsoft.PowerShell_profile.ps1'),`$env:OPENROUTER_API_KEY = "${ROUTER_KEY}"\n`);
  const sources=await vaultImport.scanTools({home,platform:'win32',env:{}});
  assert.deepEqual(sources.map(s=>[s.label,s.items.map(x=>x.name)]),[['PowerShell profile',['OPENROUTER_API_KEY']]]);
});
