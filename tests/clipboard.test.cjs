'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');const {spawn}=require('node:child_process');
const clip=require('../desktop/clipboard.cjs');const attach=require('../desktop/attachments.cjs');
const {Terminals,sessionAgent}=require('../desktop/terminal.cjs');const {Broker}=require('../desktop/broker.cjs');const {Store,Vault}=require('../desktop/store.cjs');
const {temp,secure}=require('./helpers.cjs');
const posix=process.platform==='win32'?'runs a POSIX shell':false;
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==','base64');
// Finder's NSFilenamesPboardType as XML, and the same list as a binary property list (both written by Python's plistlib).
const XML='<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<array>\n\t<string>/Users/stefan/Desktop/Screen Shot 1.png</string>\n\t<string>/Users/stefan/Documents/čćž &amp; &lt;x&gt;.pdf</string>\n</array>\n</plist>\n';
const BINARY=Buffer.from('YnBsaXN0MDCiAQJfECcvVXNlcnMvc3RlZmFuL0Rlc2t0b3AvU2NyZWVuIFNob3QgMS5wbmdvECUALwBVAHMAZQByAHMALwBzAHQAZQBmAGEAbgAvAEQAbwBjAHUAbQBlAG4AdABzAC8BDQEHAX4AIAAmACAAPAB4AD4ALgBwAGQAZggLNQAAAAAAAAEBAAAAAAAAAAMAAAAAAAAAAAAAAAAAAACC','base64');
const FINDER=['/Users/stefan/Desktop/Screen Shot 1.png','/Users/stefan/Documents/čćž & <x>.pdf'];
const utf16=s=>Buffer.from(s,'utf16le');
// Electron's clipboard as the main process sees it: formats it does not hold read as empty.
function board({text='',buffers={},strings={},image=null,fail=false}={}){
  return {readText:()=>text,readBuffer:f=>{if(fail)throw new Error('format');return buffers[f]||Buffer.alloc(0);},read:f=>{if(fail)throw new Error('format');return strings[f]||'';},
    readImage:()=>image?{isEmpty:()=>false,toPNG:()=>image}:{isEmpty:()=>true,toPNG:()=>Buffer.alloc(0)}};
}
// Runs an upload script with a local sh, HOME pointing at a folder that stands in for the remote home.
const shell=(home,seen=[])=>(agent,args)=>{seen.push({agent,args});const i=args.indexOf('-c');return spawn('/bin/sh',['-c',args[i+1]],{env:{...process.env,HOME:home}});};

test('copied files are read from Finder, Explorer and Linux file managers, every file where the system lists them',()=>{
  assert.deepEqual(clip.plistPaths(Buffer.from(XML)),FINDER,'XML property list, entities decoded');
  assert.deepEqual(clip.plistPaths(BINARY),FINDER,'binary property list, ASCII and UTF-16 strings');
  assert.deepEqual(clip.plistPaths(Buffer.from('YnBsaXN0MDBfEBUvVXNlcnMvc3RlZmFuL29uZS50eHQIAAAAAAAAAQEAAAAAAAAAAQAAAAAAAAAAAAAAAAAAACA=','base64')),['/Users/stefan/one.txt'],'a single string');
  assert.deepEqual(clip.plistPaths(Buffer.from('YnBsaXN0MDDRAQJRYRABCAsNAAAAAAAAAQEAAAAAAAAAAwAAAAAAAAAAAAAAAAAAAA8=','base64')),[],'a dictionary is not a file list');
  for(const junk of [Buffer.from('bplist00'),Buffer.concat([Buffer.from('bplist00'),Buffer.alloc(40,0xff)]),Buffer.alloc(0),Buffer.from('<string>relative/a.txt</string><string>/tmp/line\nbreak</string>')])assert.deepEqual(clip.plistPaths(junk),[]);
  assert.deepEqual(clip.uriListPaths('# copied by Nautilus\r\nfile:///home/me/My%20Notes.md\r\nfile://localhost/tmp/a.png\r\nhttps://example.com/x\r\nfile://other-host/etc/passwd\r\n\r\n',{windows:false}),['/home/me/My Notes.md','/tmp/a.png']);
  assert.deepEqual(clip.uriListPaths('copy\nfile:///home/me/one.txt\nfile:///home/me/two.txt',{windows:false}),['/home/me/one.txt','/home/me/two.txt'],'GNOME copied-files list');
  assert.deepEqual(clip.uriListPaths('file:///.file/id=6571367.8603449',{windows:false}),[],'a macOS file reference names no path');
  assert.deepEqual(clip.uriListPaths('file:///C:/Users/me/a%20b.txt',{windows:true}),['C:\\Users\\me\\a b.txt']);
  assert.deepEqual(clip.fileNameW(utf16('C:\\Users\\Stefan\\Desktop\\shot 1.png\0\0')),['C:\\Users\\Stefan\\Desktop\\shot 1.png']);
  assert.deepEqual(clip.fileNameW(utf16('\\\\nas\\share\\report.pdf\0')),['\\\\nas\\share\\report.pdf']);
  assert.deepEqual(clip.fileNameW(utf16('not a path\0')),[]);assert.deepEqual(clip.fileNameW(Buffer.alloc(0)),[]);assert.deepEqual(clip.fileNameW(undefined),[]);
});
test('a paste takes the copied files over their bare names, text over an image, and says when there is nothing',async t=>{
  const root=await temp(t);
  assert.deepEqual(clip.choose({files:FINDER,text:'Screen Shot 1.png',image:true}),{kind:'files',paths:FINDER});
  assert.deepEqual(clip.choose({text:'hello',image:true}),{kind:'text',text:'hello'},'Excel cells: text and a picture of them');
  assert.deepEqual(clip.choose({image:true}),{kind:'image'});assert.deepEqual(clip.choose({}),{kind:'empty'});assert.deepEqual(clip.choose({files:['/tmp/a\nb']}),{kind:'empty'});
  const mac=board({text:'Screen Shot 1.png\rčćž & <x>.pdf',buffers:{NSFilenamesPboardType:Buffer.from(XML)},image:PNG});
  assert.deepEqual(await clip.read(mac,root,{platform:'darwin'}),{kind:'files',paths:FINDER},'Finder: the paths, not the names');
  assert.deepEqual(await clip.read(board({text:'a.txt',strings:{'public.file-url':'file:///Users/me/a.txt'}}),root,{platform:'darwin'}),{kind:'files',paths:['/Users/me/a.txt']});
  assert.deepEqual(await clip.read(board({text:'a.txt',strings:{'public.file-url':'file:///.file/id=1.2'}}),root,{platform:'darwin'}),{kind:'text',text:'a.txt'});
  assert.deepEqual(await clip.read(board({buffers:{FileNameW:utf16('C:\\Users\\me\\a.png\0')}}),root,{platform:'win32'}),{kind:'files',paths:['C:\\Users\\me\\a.png']});
  assert.deepEqual(await clip.read(board({text:'/home/me/a.txt',strings:{'x-special/gnome-copied-files':'copy\nfile:///home/me/a.txt'}}),root,{platform:'linux'}),{kind:'files',paths:['/home/me/a.txt']});
  assert.deepEqual(await clip.read(board({text:'ls -la',fail:true}),root,{platform:'darwin'}),{kind:'text',text:'ls -la'},'a format that cannot be read leaves the text');
  assert.deepEqual(await clip.read(board(),root,{platform:'linux'}),{kind:'empty'});
  // Over 1 MB: cut there, never in the middle of a character.
  const long='x'.repeat(clip.MAX_TEXT-1)+'😀tail',cut=await clip.read(board({text:long}),root,{platform:'linux'});
  assert.equal(cut.truncated,true);assert.equal(cut.text,'x'.repeat(clip.MAX_TEXT-1));
});
test('a copied image becomes a PNG in the data folder, private, one file per image, older ones pruned',async t=>{
  const root=await temp(t),dir=path.join(root,'pasted');
  await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,'image-old.png'),'x');await fs.writeFile(path.join(dir,'image-recent.png'),'y');
  const past=new Date(Date.now()-(clip.KEEP_DAYS+1)*24*60*60*1000);await fs.utimes(path.join(dir,'image-old.png'),past,past);
  const first=await clip.read(board({image:PNG}),root,{platform:'darwin'});
  assert.equal(first.kind,'image');assert.equal(path.dirname(first.path),dir);assert.match(path.basename(first.path),/^image-[0-9a-f]{16}\.png$/);assert.deepEqual(await fs.readFile(first.path),PNG);
  if(process.platform!=='win32')assert.equal((await fs.stat(first.path)).mode&0o777,0o600);
  assert.deepEqual((await fs.readdir(dir)).sort(),[path.basename(first.path),'image-recent.png'].sort(),'files older than a few days go');
  await fs.utimes(first.path,past,past);const again=await clip.read(board({image:PNG}),root,{platform:'win32'});
  assert.equal(again.path,first.path,'the same screenshot keeps its file');assert((await fs.stat(again.path)).mtimeMs>past.getTime(),'and counts as new again');
});
test('pasted files keep their paths in a terminal on this computer and are copied first to a machine or container',{skip:posix},async t=>{
  const root=await temp(t),home=await temp(t),files=await temp(t),seen=[];
  const b=new Broker({store:new Store(root),vault:new Vault(root,secure()),emit:()=>{},approve:async()=>true});await b.init();t.after(()=>b.close());
  const host=await b.saveHost({alias:'my-vps'});
  const vps=await b.saveAgent({agent:{name:'vps claude',provider:'claude',protocol:'claude',transport:'ssh',hostId:host.id,command:'claude'}});
  const box=await b.saveAgent({agent:{name:'Box',provider:'hermes',protocol:'acp',transport:'local',command:'docker',args:['exec','-it','-e','A=1','box','hermes','acp']}});
  const gateway=await b.saveAgent({agent:{name:'Gateway',provider:'custom',protocol:'openai',transport:'http',endpoint:'https://gw.example.com/v1'}});
  const here=await b.saveAgent({agent:{name:'claude',provider:'claude',protocol:'claude',transport:'local',command:'claude'}});
  const shot=path.join(files,'Screen Shot.png');await fs.writeFile(shot,PNG);
  // What the service does for terminalPaste: the session's agent, its machine, then place().
  const paste=async(session,paths=[shot])=>{const a=sessionAgent({title:'Terminal',hostId:'',remote:false,...session},{broker:b,home:files});return clip.place(a,a.transport==='ssh'?b.host(a.hostId):null,paths,{root,spawn:shell(home,seen)});};
  for(const agentId of ['local-shell',here.id,gateway.id,'svc_setup_local'])assert.deepEqual(await paste({agentId}),{paths:[shot],posix:true},`${agentId} runs on this computer`);
  assert.equal(seen.length,0,'nothing is copied for a terminal on this computer');
  const remote=/\/\.opaya\/attachments\/pasted\/[0-9a-f]{8}-Screen Shot\.png$/;
  for(const [session,where] of [[{agentId:`host_${host.id}`,remote:true},'my-vps'],[{agentId:vps.id,remote:true},'my-vps'],[{agentId:`svc_install_${host.id}`,hostId:host.id,remote:true},'my-vps'],[{agentId:box.id},'the Box container']]){
    const r=await paste(session);assert.equal(r.copied,where);assert.equal(r.posix,true);assert.match(r.paths[0],remote);assert.equal(r.paths[0].startsWith(home),true);assert.deepEqual(await fs.readFile(r.paths[0]),PNG);
  }
  assert.deepEqual(seen.map(s=>s.agent.transport),['ssh','ssh','ssh','local']);assert.deepEqual(seen[3].args.slice(0,6),['exec','-i','-e','A=1','box','sh'],'into the container over docker exec -i');
  // A real session of this computer's shell maps the same way.
  const pty={spawn:()=>({onData(){},onExit(){},write(){},resize(){},kill(){}})},terminals=new Terminals(()=>{},{ptyFactory:pty});
  terminals.open({id:'local-shell',name:'This computer',provider:'custom',transport:'local',command:'',args:[],cwd:files},null,'shell');
  assert.equal(sessionAgent(terminals.describe()[0],{broker:b,home:files}).id,'local-shell');
  await assert.rejects(()=>paste({agentId:'removed-agent'}),/agent of this terminal was removed/);await assert.rejects(()=>paste({agentId:'host_gone',remote:true}),/machine of this terminal was removed/);
});
test('pasted files for another machine keep the attachment limits and say what is wrong',{skip:posix},async t=>{
  const root=await temp(t),home=await temp(t),files=await temp(t),p=name=>path.join(files,name);
  const vps={id:'vps',name:'vps',provider:'claude',protocol:'claude',transport:'ssh',hostId:'h',command:'claude',args:[]},host={id:'h',name:'my-vps',alias:'my-vps'},local={id:'local-shell',transport:'local',command:'',args:[]};
  const place=(agent,paths)=>clip.place(agent,agent===vps?host:null,paths,{root,spawn:shell(home)});
  await fs.writeFile(p('big.bin'),'');await fs.truncate(p('big.bin'),attach.MAX_FILE+1);await fs.mkdir(p('folder'));await fs.writeFile(p('a.txt'),'a');
  await assert.rejects(()=>place(vps,[p('big.bin')]),/big\.bin is 20\.0 MB\. A file pasted into a terminal on my-vps can be at most 20\.0 MB/);
  await assert.rejects(()=>place(vps,[p('folder')]),/folder is a folder\. Only files can be copied to my-vps/);
  await assert.rejects(()=>place(vps,[p('gone.txt')]),/gone\.txt was not found/);
  await assert.rejects(()=>place(vps,Array.from({length:attach.MAX_FILES+1},()=>p('a.txt'))),/at most 10 files at once into a terminal on my-vps/);
  await fs.writeFile(path.join(root,'workspace.json'),'{}');await assert.rejects(()=>place(vps,[path.join(root,'workspace.json')]),/Opaya's own data files and is not copied to my-vps/);
  await fs.mkdir(path.join(root,'pasted'));await fs.writeFile(path.join(root,'pasted','image-1.png'),PNG);assert.match((await place(vps,[path.join(root,'pasted','image-1.png')])).paths[0],/-image-1\.png$/,'pasted images can go');
  for(const agent of [vps,local]){
    await assert.rejects(()=>place(agent,['relative/a.txt']),/full path/);await assert.rejects(()=>place(agent,[]),/between 1 and 100/);
    await assert.rejects(()=>place(agent,[p('line\nbreak.txt')]),/line break or another control character/);
  }
  assert.deepEqual(await place(local,[p('big.bin'),p('folder')]),{paths:[p('big.bin'),p('folder')],posix:true},'this computer types any path');
  // Copies older than a few days are removed on the machine when the next one arrives.
  const dir=path.join(home,'.opaya','attachments','pasted'),old=path.join(dir,'old.png'),past=new Date(Date.now()-10*24*60*60*1000);await fs.writeFile(old,'x');await fs.utimes(old,past,past);
  await place(vps,[p('a.txt')]);await assert.rejects(()=>fs.stat(old));assert.equal((await fs.readdir(dir)).length,2);
  assert.equal(clip.terminalPlace({transport:'http',protocol:'openai',endpoint:'https://gw.example.com/v1'}),'local','the shell of an HTTPS agent runs here');
});
