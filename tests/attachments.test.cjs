'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const http=require('node:http');const fs=require('node:fs/promises');const path=require('node:path');const {spawn}=require('node:child_process');const {EventEmitter}=require('node:events');const {PassThrough}=require('node:stream');
const attach=require('../desktop/attachments.cjs');const {collect}=require('../desktop/process.cjs');
const {Broker}=require('../desktop/broker.cjs');const {Store,Vault}=require('../desktop/store.cjs');
const {HttpAdapter}=require('../desktop/adapters/http.cjs');const {ClaudeAdapter}=require('../desktop/adapters/claude.cjs');const {CodexAdapter}=require('../desktop/adapters/codex.cjs');const {AcpAdapter}=require('../desktop/adapters/acp.cjs');
const {childMock,context,temp,secure}=require('./helpers.cjs');
const posix=process.platform==='win32'?'runs a POSIX shell':false;
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==','base64');
const PDF=Buffer.concat([Buffer.from('%PDF-1.7\n%'),Buffer.from([0xe2,0xe3,0xcf,0xd3]),Buffer.from('\n1 0 obj\n<<>>\nendobj\n')]);
async function files(t){const dir=await temp(t),p=name=>path.join(dir,name);
  await fs.writeFile(p('notes.md'),'# Notes\nSee ```js\nx()\n```\n');await fs.writeFile(p('photo.txt'),PNG);await fs.writeFile(p('doc.pdf'),PDF);await fs.writeFile(p('empty.txt'),'');
  await fs.writeFile(p('data.bin'),Buffer.from([1,2,0,3]));await fs.writeFile(p('big.log'),'line\n'.repeat(130*1024));await fs.mkdir(p('folder'));return {dir,p};}
async function server(t,handler){const s=http.createServer(handler);await new Promise(r=>s.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{s.closeAllConnections();s.close(r);}));return `http://127.0.0.1:${s.address().port}/v1`;}
function sse(res,text){res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: '+JSON.stringify({choices:[{delta:{content:text}}]})+'\n\n');res.end('data: [DONE]\n\n');}
const body=async req=>{let raw='';for await(const c of req)raw+=c;return JSON.parse(raw);};
// Runs an upload script with a local sh, HOME pointing at a folder that stands in for the remote home.
const shell=(home,seen=[])=>(agent,args)=>{seen.push({agent,args});const i=args.indexOf('-c');return spawn('/bin/sh',['-c',args[i+1]],{env:{...process.env,HOME:home}});};
function claudeChild(onInput){const c=new EventEmitter();Object.assign(c,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),exitCode:null,signalCode:null});c.kill=()=>{};let input='';c.stdin.on('data',d=>input+=d.toString());c.stdin.on('finish',()=>{onInput?.(input);queueMicrotask(()=>{c.stdout.write(JSON.stringify({type:'result',result:'seen',session_id:'s'})+'\n');c.exitCode=0;c.emit('close',0);});});return c;}

test('attachment lists are checked before anything is read: count, paths, base64 and sizes',()=>{
  assert.deepEqual(attach.check(undefined),[]);
  assert.throws(()=>attach.check(Array.from({length:11},()=>({path:'/x'}))),/at most 10 files/);
  assert.throws(()=>attach.check([{path:'relative/file.txt'}]),/full path/);assert.throws(()=>attach.check('x'),/must be a list/);
  assert.deepEqual(attach.check([{name:'../../shot.png',data:'data:image/png;base64,'+PNG.toString('base64')}]),[{name:'shot.png',mime:'image/png',data:PNG.toString('base64')}]);
  assert.deepEqual(attach.check([{path:'/tmp/a.txt',name:'a.txt',mime:'text/plain',size:3}]),[{path:'/tmp/a.txt',name:'a.txt',mime:'text/plain'}]);
  assert.throws(()=>attach.check([{name:'x',data:'not base64!'}]),/x is not valid base64/);
  assert.throws(()=>attach.check([{name:'huge.png',data:'A'.repeat(28*1024*1024)}]),/huge\.png is 21\.0 MB\. Each attachment can be at most 20\.0 MB/);
  const fifteen='A'.repeat(20*1024*1024);assert.throws(()=>attach.check([{name:'a',data:fifteen},{name:'b',data:fifteen},{name:'c',data:fifteen}]),/add up to 45\.0 MB\. One message can carry at most 40\.0 MB/);
});
test('files are read as text, image or other file by their bytes, and Opaya\'s own data files are refused',async t=>{
  const {dir,p}=await files(t);
  const items=await attach.load(attach.check(['notes.md','photo.txt','doc.pdf','empty.txt','data.bin','big.log'].map(n=>({path:p(n)}))));
  assert.deepEqual(items.map(i=>[i.name,i.kind,i.mime]),[['notes.md','text','text/markdown'],['photo.txt','image','image/png'],['doc.pdf','file','application/pdf'],['empty.txt','text','text/plain'],['data.bin','file','application/octet-stream'],['big.log','text','text/plain']]);
  assert.match(items[0].text,/^# Notes/);assert.equal(items[5].truncated,true);assert.equal(items[5].text.length,attach.MAX_TEXT);assert.equal(items[0].truncated,false);
  await assert.rejects(()=>attach.load([{path:p('gone.txt')}]),/gone\.txt was not found/);await assert.rejects(()=>attach.load([{path:p('folder')}]),/folder is a folder/);
  await fs.writeFile(p('workspace.json'),'{}');await fs.mkdir(p('attachments'));await fs.writeFile(p('attachments/ok.txt'),'fine');
  await assert.rejects(()=>attach.load([{path:p('workspace.json')}],{root:dir}),/Opaya's own data files/);assert.equal((await attach.load([{path:p('attachments/ok.txt')}],{root:dir}))[0].kind,'text');
  for(const [n,s] of [['one',15],['two',15],['three',15]]){await fs.writeFile(p(n),'');await fs.truncate(p(n),s*1024*1024);}
  await assert.rejects(()=>attach.load(['one','two','three'].map(n=>({path:p(n)}))),/add up to 45\.0 MB/);
  await fs.truncate(p('one'),21*1024*1024);await assert.rejects(()=>attach.load([{path:p('one')}]),/one is 21\.0 MB/);
});
test('attachment restrictions check links and preserve allowed resolved paths',{skip:process.platform==='win32'},async t=>{
  const dir=await temp(t),root=path.join(dir,'opaya'),p=name=>path.join(dir,name);
  await fs.mkdir(path.join(root,'attachments'),{recursive:true});
  await fs.writeFile(path.join(root,'vault.json'),'fixture private content');await fs.writeFile(p('notes.txt'),'public notes');
  await fs.mkdir(path.join(root,'..private'));await fs.writeFile(path.join(root,'..private','workspace.json'),'fixture private content');
  await fs.symlink(path.join(root,'..private','workspace.json'),p('hidden.txt'));
  await fs.symlink(path.join(root,'vault.json'),p('readme.txt'));await fs.symlink(p('readme.txt'),p('chain.txt'));
  await fs.symlink(root,p('data-link'),'dir');await fs.symlink(path.join(root,'vault.json'),path.join(root,'attachments','innocent.txt'));
  await fs.symlink(p('notes.txt'),path.join(root,'workspace.json'));await fs.symlink(p('notes.txt'),p('guide.txt'));
  const opened=[],open=fs.open;t.mock.method(fs,'open',async(...args)=>{opened.push(args[0]);return open(...args);});
  for(const file of [p('readme.txt'),p('chain.txt'),p('data-link/vault.json'),p('hidden.txt'),path.join(root,'attachments','innocent.txt'),path.join(root,'workspace.json')]){
    await assert.rejects(()=>attach.load([{path:file}],{root}),/Opaya's own data files/);
  }
  await assert.rejects(()=>attach.load([{path:path.join(root,'vault.json')}],{root:p('data-link')}),/Opaya's own data files/);
  assert.deepEqual(opened,[]);
  const [item]=await attach.load([{path:p('guide.txt')}],{root});assert.equal(item.name,'guide.txt');assert.equal(item.path,p('notes.txt'));assert.equal(item.text,'public notes');
  await fs.unlink(p('guide.txt'));await fs.symlink(path.join(root,'vault.json'),p('guide.txt'));
  assert.equal(Buffer.from(await attach.base64(item),'base64').toString(),'public notes','later reads use the checked target');
  const staged=await attach.stage({attachments:[{name:'clip.txt',data:Buffer.from('pasted notes').toString('base64')}]},p('data-link'));
  const items=await attach.load(staged.input.attachments,{root:p('data-link')});await attach.save(items,{root:p('data-link'),conversationId:'linked-root'});
  assert.deepEqual(await fs.readdir(path.join(root,'attachments','pasted')),[]);
  assert.equal(await fs.readFile(items[0].path,'utf8'),'pasted notes');
});
test('fileInfo describes picked or dropped files',async t=>{
  const {p}=await files(t);
  assert.deepEqual(await attach.inspect([p('photo.txt'),p('notes.md'),p('doc.pdf'),p('data.bin')]),[{path:p('photo.txt'),name:'photo.txt',size:PNG.length,mime:'image/png'},{path:p('notes.md'),name:'notes.md',size:26,mime:'text/markdown'},{path:p('doc.pdf'),name:'doc.pdf',size:PDF.length,mime:'application/pdf'},{path:p('data.bin'),name:'data.bin',size:4,mime:'application/octet-stream'}]);
  await assert.rejects(()=>attach.inspect([p('folder')]),/is a folder/);await assert.rejects(()=>attach.inspect([]),/Choose files/);await assert.rejects(()=>attach.inspect(['x.txt']),/full path/);
});
test('the prompt carries text files as fenced blocks and names the rest with the path the agent can open',async t=>{
  const {p}=await files(t);const [notes,photo,pdf,big]=await attach.load(['notes.md','photo.txt','doc.pdf','big.log'].map(n=>({path:p(n)})));
  const text=attach.compose('Summarize these',[notes,photo,pdf,big],i=>i===pdf?'/remote/doc.pdf':i===big?'/remote/big.log':'');
  assert.match(text,/^Summarize these\n\n\[Attached file: notes\.md \(26 B\)\]\n````md\n# Notes\nSee ```js\nx\(\)\n```\n````/,'a longer fence than the file uses');
  assert.match(text,/\[Attached image: photo\.txt \(\d+ B\)\]/);assert.match(text,/\[Attached file: doc\.pdf \(application\/pdf, \d+ B\) saved at \/remote\/doc\.pdf\]/);
  assert.match(text,/\[Attached file: big\.log \(650 KB\)\. Only the start is shown here; the whole file is at \/remote\/big\.log\]/);
  const cut=attach.plan([notes,big],10);assert.deepEqual([...cut].map(i=>i.name),['notes.md','big.log']);assert.equal(notes.shown,'# Notes\nSe');
  assert.match(attach.compose('',[big]),/It is too long to show here\]$/);
  assert.equal(attach.earlier([{name:'a.png',kind:'image',mime:'image/png',size:2048}]),'[Attached earlier, not sent again: a.png (image, 2.0 KB)]');
});
test('pasted files are staged by the window, moved into the chat folder by the service and cleaned up',async t=>{
  const root=await temp(t),{p}=await files(t);
  const same={agentId:'a',text:'x',attachments:[{path:p('notes.md')}]};assert.equal((await attach.stage(same,root)).input,same,'nothing pasted, nothing written');
  const staged=await attach.stage({agentId:'a',text:'look',attachments:[{name:'shot.png',mime:'image/png',data:PNG.toString('base64')},{path:p('notes.md')}]},root);
  assert.equal(staged.files.length,1);assert.equal(path.dirname(staged.files[0]),path.join(root,'attachments','pasted'));assert.deepEqual(staged.input.attachments[1],{path:p('notes.md')});
  assert.deepEqual({...staged.input.attachments[0],path:''},{path:'',name:'shot.png',mime:'image/png'});assert.equal(JSON.stringify(staged.input).includes(PNG.toString('base64')),false,'only paths go on to the service');
  const items=await attach.load(attach.check(staged.input.attachments),{root});assert.equal(items[0].name,'shot.png');
  await attach.save(items,{root,conversationId:'conv-1'});
  assert.equal(path.dirname(items[0].path),path.join(root,'attachments','conv-1'));assert.deepEqual(await fs.readdir(path.join(root,'attachments','pasted')),[]);assert.equal(items[1].path,p('notes.md'),'files from elsewhere stay where they are');
  const direct=await attach.load(attach.check([{name:'clip.txt',data:Buffer.from('pasted text').toString('base64')}]));await attach.save(direct,{root,conversationId:'conv-1'});
  assert.equal(await fs.readFile(direct[0].path,'utf8'),'pasted text');assert.equal(direct[0].buffer,undefined);
  if(process.platform!=='win32')assert.equal((await fs.stat(direct[0].path)).mode&0o777,0o600);
  const again=await attach.stage({attachments:[{name:'a.txt',data:'YQ=='}]},root);await attach.unstage(again.files);await assert.rejects(()=>fs.stat(again.files[0]));
  const old=await attach.stage({attachments:[{name:'old.txt',data:'YQ=='},{name:'new.txt',data:'Yg=='}]},root);const past=new Date(Date.now()-2*24*60*60*1000);await fs.utimes(old.files[0],past,past);
  await attach.prune(root);assert.deepEqual(await fs.readdir(path.join(root,'attachments','pasted')),[path.basename(old.files[1])]);
  await attach.remove(root,'conv-1');await assert.rejects(()=>fs.stat(path.join(root,'attachments','conv-1')));
});
test('files for an agent on another machine or in a container are copied there over stdin',{skip:posix},async t=>{
  const home=await temp(t),{p}=await files(t),[pdf]=await attach.load([{path:p('doc.pdf')}]),seen=[],events=[];
  const ssh={name:'vps hermes',provider:'hermes',protocol:'acp',transport:'ssh',hostId:'h',command:'hermes',args:[],cwd:'/srv'};
  const where=await attach.locate(ssh,{name:'my-vps'},[pdf],'conv-1',{spawn:shell(home,seen),onEvent:e=>events.push(e)});
  const remote=where.get(pdf);assert.match(remote,new RegExp(`^${home}/\\.opaya/attachments/conv-1/[0-9a-f]{8}-doc\\.pdf$`));assert.deepEqual(await fs.readFile(remote),PDF);
  assert.equal((await fs.stat(remote)).mode&0o777,0o600);assert.equal(seen[0].agent.command,'sh');assert.equal(seen[0].args[0],'-c');assert.equal(seen[0].args.join(' ').includes(PDF.toString('latin1')),false,'the content is not on the command line');
  assert.deepEqual(events,[{type:'activity',text:'Copying doc.pdf to my-vps'}]);
  const docker={name:'Box',provider:'hermes',protocol:'acp',transport:'local',command:'docker',args:['exec','-it','-e','A=1','box','hermes'],hermesHome:'/opt/data'};
  await attach.locate(docker,null,[pdf],'conv-1',{spawn:shell(home,seen)});
  assert.deepEqual(seen[1].args.slice(0,6),['exec','-i','-e','A=1','box','sh']);assert.equal(seen[1].agent.command,'docker');
  await assert.rejects(()=>attach.upload(ssh,{name:'my-vps'},pdf,'conv-1',{spawn:()=>spawn('/bin/sh',['-c','cat >/dev/null; echo "Permission denied" >&2; exit 1'])}),/Could not copy doc\.pdf to my-vps: Permission denied/);
  const local={provider:'claude',protocol:'claude',transport:'local',command:'claude',args:[]},copyTo=path.join(home,'chat');
  const copied=await attach.locate(local,null,[pdf],'conv-1',{copyTo});assert.equal(path.dirname(copied.get(pdf)),copyTo);assert.deepEqual(await fs.readFile(copied.get(pdf)),PDF);
  assert.equal((await attach.locate(local,null,[pdf],'conv-1')).get(pdf),p('doc.pdf'),'an agent on this computer opens the file where it is');
  assert.equal(attach.placeOf({protocol:'openai',transport:'http',endpoint:'https://gw.example.com/v1'}),'api');assert.equal(attach.placeOf({protocol:'openai',transport:'http',endpoint:'http://127.0.0.1:8642/v1'}),'local');
});
test('the broker keeps only name, size, type and kind in the transcript and gives the adapter the files',async t=>{
  const root=await temp(t),{p}=await files(t),runs=[];
  const b=new Broker({store:new Store(root),vault:new Vault(root,secure()),emit:()=>{},approve:async()=>true,adapterFactory:()=>({connect:async()=>({}),close(){},run:async ctx=>{runs.push(ctx);return {};}})});await b.init();t.after(()=>b.close());
  const a=await b.saveAgent({agent:{name:'claude',provider:'claude',protocol:'claude',command:'claude'}});await b.connect(a.id);
  await assert.rejects(()=>b.send({agentId:a.id,text:'x',attachments:Array.from({length:11},()=>({path:p('notes.md')}))}),/at most 10/);
  await assert.rejects(()=>b.send({agentId:a.id,text:'',attachments:[{path:p('gone.pdf')}]}),/gone\.pdf was not found/);
  assert.equal(b.data.conversations.length,0,'a missing file creates no chat');assert.equal(b.turns.size,0);
  await assert.rejects(()=>b.send({agentId:a.id,text:''}),/Enter a message/);
  const sent=await b.send({agentId:a.id,text:'',attachments:[{path:p('notes.md')},{name:'screen.png',mime:'image/png',data:PNG.toString('base64')}]});await b.turns.get(a.id)?.done;
  const c=b.data.conversations.find(x=>x.id===sent.conversationId),user=b.histories.get(c.id)[0];
  assert.equal(c.title,'notes.md, screen.png');assert.deepEqual(user.attachments,[{name:'notes.md',size:26,mime:'text/markdown',kind:'text'},{name:'screen.png',size:PNG.length,mime:'image/png',kind:'image'}]);
  const saved=await fs.readFile(path.join(root,'conversations',c.id+'.json'),'utf8');assert.equal(saved.includes(PNG.toString('base64')),false);assert.equal(saved.includes(p('notes.md')),false);assert.equal(saved.includes('# Notes'),false);
  const ctx=runs[0];assert.equal(ctx.text,'');assert.equal(ctx.filesDir,path.join(root,'attachments',c.id));assert.deepEqual(ctx.attachments.map(i=>i.kind),['text','image']);
  assert.equal(path.dirname(ctx.attachments[1].path),ctx.filesDir);assert.deepEqual(await fs.readFile(ctx.attachments[1].path),PNG);
  await b.deleteConversation(c.id);await assert.rejects(()=>fs.stat(ctx.filesDir),'deleting the chat deletes its pasted files');
});
test('model APIs get images as image_url parts and text inline; other files and text-only models get a clear error',async t=>{
  const {p}=await files(t),seen=[];const endpoint=await server(t,async(req,res)=>{seen.push(await body(req));sse(res,'ok');});
  const items=async(...names)=>attach.load(names.map(n=>({path:p(n)})));
  const api=new HttpAdapter({agent:{provider:'openai',endpoint,model:'gpt-5.5'}});
  await api.run(context({text:'what is this?',attachments:await items('photo.txt','notes.md'),messages:[{id:'m1',role:'user',content:'what is this?',status:'done'}]}));
  const [partText,partImage]=seen[0].messages.at(-1).content;
  assert.match(partText.text,/^what is this\?\n\n\[Attached image: photo\.txt[^\n]*\n\n\[Attached file: notes\.md \(26 B\)\]\n````md/);assert.deepEqual(partImage,{type:'image_url',image_url:{url:'data:image/png;base64,'+PNG.toString('base64')}});
  await assert.rejects(async()=>api.run(context({attachments:await items('doc.pdf')})),/doc\.pdf cannot be sent to a model API/);
  await assert.rejects(async()=>new HttpAdapter({agent:{provider:'deepseek',endpoint,model:'deepseek-chat'}}).run(context({attachments:await items('photo.txt')})),/deepseek-chat reads text only, so it cannot see photo\.txt/);
  const heic=(await items('data.bin'))[0];heic.mime='image/heic';await assert.rejects(()=>api.run(context({attachments:[heic]})),/image format models do not read/);
  // The next turn of a stateless API gets the file text again on this connection, and a note after a restart.
  const history=[{id:'m1',role:'user',content:'what is this?',status:'done',attachments:attach.meta(await items('photo.txt','notes.md'))},{role:'assistant',content:'a pixel',status:'done'},{id:'m2',role:'user',content:'and the notes?',status:'done'}];
  await api.run(context({text:'and the notes?',messages:history}));
  assert.match(seen.at(-1).messages[0].content,/````md\n# Notes[\s\S]*\[Attached earlier, not sent again: photo\.txt \(image, \d+ B\)\]/);
  await new HttpAdapter({agent:{provider:'openai',endpoint,model:'gpt-5.5'}}).run(context({text:'and the notes?',messages:history}));
  assert.equal(seen.at(-1).messages[0].content,'what is this?\n\n[Attached earlier, not sent again: photo.txt (image, 70 B)]\n[Attached earlier, not sent again: notes.md (text/markdown, 26 B)]');
});
test('Hermes and OpenClaw get small images inline and other files by the path where they run',async t=>{
  const {p}=await files(t),seen=[];const endpoint=await server(t,async(req,res)=>{seen.push(await body(req));sse(res,'ok');});
  const items=async(...names)=>attach.load(names.map(n=>({path:p(n)})));
  const hermes=new HttpAdapter({agent:{provider:'hermes',transport:'http',endpoint,model:'hermes-agent'}});
  await hermes.run(context({text:'read',attachments:await items('doc.pdf','photo.txt','big.log')}));
  const [text,image]=seen[0].messages.at(-1).content;
  assert.match(text.text,new RegExp(`\\[Attached file: doc\\.pdf \\(application/pdf, \\d+ B\\) saved at ${p('doc.pdf').replace(/[\\/.]/g,'\\$&')}\\]`));assert.equal(image.type,'image_url');
  assert.match(text.text,/\[Attached file: big\.log \(650 KB\)\. Only the start is shown here; the whole file is at .*big\.log\]/);assert(text.text.length<62000,'Hermes keeps 64 KB of text per part');
  const claw=new HttpAdapter({agent:{provider:'openclaw',transport:'http',endpoint,model:'openclaw/default'}});await claw.run(context({text:'see',attachments:await items('photo.txt')}));
  assert.equal(seen[1].messages.length,1);assert.equal(seen[1].messages[0].content[1].type,'image_url');assert.equal(seen[1].user,'agenthub:conversation-one');
  const remote=new HttpAdapter({agent:{provider:'hermes',transport:'http',endpoint:'https://hermes.example.com/v1',model:'hermes-agent',name:'Cloud Hermes'},fetchImpl:async()=>new Response('data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}})});
  await assert.rejects(async()=>remote.run(context({attachments:await items('doc.pdf')})),/Opaya reaches Cloud Hermes only through its API/);
});
test('Claude gets images as stream-json image blocks and reads other files from a folder it is allowed',async t=>{
  const root=await temp(t),{p}=await files(t),filesDir=path.join(root,'attachments','c1');let argv,input;
  const a=new ClaudeAdapter({agent:{args:[]},spawnAgent:(_a,args)=>{argv=args;return claudeChild(x=>input=x);}});
  const items=await attach.load(['photo.txt','notes.md','doc.pdf'].map(n=>({path:p(n)})));
  await a.run(context({text:'check',attachments:items,filesDir,conversation:{id:'c1',externalSessionId:''}}));
  assert.equal(argv[argv.indexOf('--input-format')+1],'stream-json');assert.equal(argv[argv.indexOf('--add-dir')+1],filesDir);
  const message=JSON.parse(input);assert.equal(message.type,'user');const [block,image]=message.message.content;
  assert.deepEqual(image,{type:'image',source:{type:'base64',media_type:'image/png',data:PNG.toString('base64')}});
  const copy=/saved at (\S+doc\.pdf)\]/.exec(block.text)[1];assert.equal(path.dirname(copy),filesDir);assert.deepEqual(await fs.readFile(copy),PDF);assert.match(block.text,/````md\n# Notes/);
  assert.equal(argv.join(' ').includes('# Notes'),false,'files stay off the command line');
  await a.run(context({text:'plain',attachments:await attach.load([{path:p('notes.md')}]),filesDir}));assert.equal(argv.includes('--input-format'),false);assert.equal(argv.includes('--add-dir'),false);assert.match(input,/^plain\n\n\[Attached file: notes\.md/);
});
test('Claude over SSH gets other files copied to that machine first',{skip:posix},async t=>{
  const home=await temp(t),{p}=await files(t);let argv;
  const a=new ClaudeAdapter({agent:{name:'vps claude',transport:'ssh',command:'claude',args:[]},host:{name:'vps'},spawnAgent:(agent,args,host)=>{if(args[0]==='-c')return shell(home)(agent,args);argv=args;return claudeChild();}});
  await a.run(context({attachments:await attach.load([{path:p('doc.pdf')}]),conversation:{id:'c9',externalSessionId:''}}));
  assert.equal(argv[argv.indexOf('--add-dir')+1],path.join(home,'.opaya','attachments','c9'));
});
test('Codex gets images as local images and other files by path',async t=>{
  const {p}=await files(t);const child=childMock((m,c)=>{
    if(m.method==='initialize')c.reply(m,{});if(m.method==='model/list')c.reply(m,{data:[{id:'blind',model:'blind',isDefault:false,supportedReasoningEfforts:[],inputModalities:['text']}]});
    if(m.method==='thread/start')c.reply(m,{thread:{id:'t1'}});if(m.method==='turn/start'){c.reply(m,{turn:{id:'u1'}});c.send({method:'turn/completed',params:{threadId:'t1',turn:{id:'u1',status:'completed'}}});}
  });
  const a=new CodexAdapter({agent:{args:[],cwd:path.resolve('.')},approve:async()=>false,spawnAgent:()=>child});await a.connect();await new Promise(r=>setTimeout(r,20));
  await a.run(context({text:'look',attachments:await attach.load(['photo.txt','doc.pdf'].map(n=>({path:p(n)})))}));
  const input=child.frames.filter(f=>f.method==='turn/start')[0].params.input;
  assert.deepEqual(input[1],{type:'localImage',path:p('photo.txt')});assert.match(input[0].text,/\[Attached image: photo\.txt \(\d+ B\)\]/);assert.match(input[0].text,/doc\.pdf \(application\/pdf, \d+ B\) saved at /);
  await a.run(context({text:'look',attachments:await attach.load([{path:p('photo.txt')}]),conversation:{id:'c2',externalSessionId:'',model:'blind'}}));
  const blind=child.frames.filter(f=>f.method==='turn/start')[1].params.input;assert.equal(blind.length,1,'a model without image input gets the path');assert.match(blind[0].text,/photo\.txt \(\d+ B\) saved at /);a.close();
});
test('ACP gets image blocks when the agent takes images, and resource links to files otherwise',async t=>{
  const {p}=await files(t);const server=image=>childMock((m,c)=>{if(m.method==='initialize')c.reply(m,{protocolVersion:1,agentCapabilities:{promptCapabilities:{image,embeddedContext:false}}});if(m.method==='session/new')c.reply(m,{sessionId:'s1'});if(m.method==='session/prompt')c.reply(m,{stopReason:'end_turn'});});
  const run=async image=>{const child=server(image),a=new AcpAdapter({agent:{provider:'hermes',args:[],cwd:path.resolve('.')},approve:async()=>false,spawnAgent:()=>child});await a.connect();await a.run(context({text:'look',attachments:await attach.load(['photo.txt','doc.pdf'].map(n=>({path:p(n)})))}));a.close();return child.frames.find(f=>f.method==='session/prompt').params.prompt;};
  const [text,image,link]=await run(true);
  assert.equal(text.type,'text');assert.deepEqual(image,{type:'image',mimeType:'image/png',data:PNG.toString('base64')});
  assert.deepEqual(link,{type:'resource_link',uri:require('node:url').pathToFileURL(p('doc.pdf')).href,name:'doc.pdf',mimeType:'application/pdf',size:PDF.length});
  const blocks=await run(false);assert.deepEqual(blocks.map(b=>b.type),['text','resource_link','resource_link']);assert.equal(blocks[1].mimeType,'image/png');
});
test('a failed command keeps what it printed for callers that read JSON from it',{skip:posix},async()=>{
  await assert.rejects(()=>collect(spawn('/bin/sh',['-c','echo \'{"ok":false}\'; echo bad >&2; exit 1'])),e=>e.message==='bad'&&e.stdout.trim()==='{"ok":false}');
});
