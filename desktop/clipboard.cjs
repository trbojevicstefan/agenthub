'use strict';
// Pasting into a terminal. The clipboard holds text, the files copied in Finder / Explorer / a Linux file manager (their
// bare names come along as text), or an image and nothing else (a screenshot for Claude Code or Codex). Files win over
// text, text over an image. An image is saved as a PNG in Opaya's data folder and pasted as its path, like a file.
// A terminal on another machine or in a container gets copies of the files there first, and their paths are typed.
// main.cjs reads the clipboard with read(); the session service copies files with place(). The parsing is pure.
const fs=require('node:fs/promises');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {fileURLToPath}=require('node:url');
const attachments=require('./attachments.cjs');
const MAX_TEXT=1024*1024,MAX_PATHS=100,KEEP_DAYS=3;
// A path that can be typed into a terminal: no line breaks or other control characters (they would run commands).
const typeable=p=>typeof p==='string'&&p.length>0&&p.length<=4096&&!/[\0-\x1f\x7f]/.test(p);
const ENTITY={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"};
const unxml=s=>s.replace(/&(?:#x([0-9a-f]{1,6})|#(\d{1,7})|(\w+));/gi,(m,hex,dec,name)=>{if(name)return ENTITY[name]??m;const n=parseInt(hex||dec,hex?16:10);return n>0&&n<=0x10ffff?String.fromCodePoint(n):m;});
// A binary property list (bplist00): the strings of its top array, or its top string. Anything unexpected gives [].
function bplistStrings(b){
  try{
    const t=b.length-32,size=b[t+6],ref=b[t+7],count=Number(b.readBigUInt64BE(t+8)),top=Number(b.readBigUInt64BE(t+16)),table=Number(b.readBigUInt64BE(t+24));
    if(!size||!ref||count>100000||top>=count||table+count*size>t)return [];
    const int=(at,n)=>{if(at+n>t)throw new Error('Outside the property list.');let v=0;for(let i=0;i<n;i++)v=v*256+b[at+i];return v;};
    // An object's length is in its marker's low four bits, or in the integer object after it when those are all set.
    const length=at=>{const low=b[at]&15;return low<15?[low,at+1]:[int(at+2,1<<(b[at+1]&15)),at+2+(1<<(b[at+1]&15))];};
    const string=i=>{const at=int(table+i*size,size),type=b[at]>>4;if(type!==5&&type!==6)return null;const [n,start]=length(at),end=start+(type===6?2*n:n);if(end>t)return null;
      return type===5?b.toString('latin1',start,end):Buffer.from(b.subarray(start,end)).swap16().toString('utf16le');};
    const at=int(table+top*size,size);
    if(b[at]>>4!==10){const one=string(top);return one===null?[]:[one];}
    const [n,start]=length(at);if(n>MAX_PATHS*10)return [];
    return Array.from({length:n},(_,k)=>string(int(start+k*ref,ref))).filter(s=>typeof s==='string');
  }catch{return [];}
}
// macOS NSFilenamesPboardType: a property list with the path of every copied file (XML; binary is read as well).
function plistPaths(data){
  const b=Buffer.isBuffer(data)?data:Buffer.from(String(data||''),'utf8');
  const strings=b.subarray(0,8).toString('latin1')==='bplist00'?bplistStrings(b):[...b.toString('utf8').matchAll(/<string>([^<]*)<\/string>/g)].map(m=>unxml(m[1]));
  return strings.filter(p=>p.startsWith('/')&&typeable(p));
}
// text/uri-list (Linux file managers; macOS public.file-url is one such URI): a file:// URI per line, # starts a comment.
// macOS file reference URLs (file:///.file/id=...) name no path and are skipped.
function uriListPaths(text,{windows=process.platform==='win32'}={}){
  const out=[];
  for(const line of String(text||'').split(/\r?\n/).map(l=>l.trim())){
    if(!/^file:\/\//i.test(line))continue;
    try{const p=fileURLToPath(line,{windows});if(!p.startsWith('/.file/id=')&&typeable(p))out.push(p);}catch{}
  }
  return out;
}
// Windows FileNameW: the first copied file's path, UTF-16 and ended by a NUL (Explorer lists the others only in CF_HDROP,
// which Electron cannot read; the paste event carries all of them).
function fileNameW(data){const p=Buffer.isBuffer(data)?data.toString('utf16le').split('\0')[0]:'';return /^(?:[a-zA-Z]:\\|\\\\[^\\])/.test(p)&&typeable(p)?[p]:[];}
// What the clipboard offers a paste, read with Electron's clipboard: the copied files' paths and the text. A format that
// cannot be read counts as absent, so text still pastes.
function contents(clipboard,platform=process.platform){
  const get=(read,fallback)=>{try{return read()??fallback;}catch{return fallback;}},none=Buffer.alloc(0);
  let files;
  if(platform==='darwin'){files=plistPaths(get(()=>clipboard.readBuffer('NSFilenamesPboardType'),none));if(!files.length)files=uriListPaths(get(()=>clipboard.read('public.file-url'),''),{windows:false});}
  else if(platform==='win32')files=fileNameW(get(()=>clipboard.readBuffer('FileNameW'),none));
  else{files=uriListPaths(get(()=>clipboard.read('text/uri-list'),''),{windows:false});if(!files.length)files=uriListPaths(get(()=>clipboard.read('x-special/gnome-copied-files'),''),{windows:false});}
  return {files:files.slice(0,MAX_PATHS),text:String(get(()=>clipboard.readText(),'')||'')};
}
// Files when there are any (Finder also puts their bare names as text), else the text, else the image, else nothing.
function choose({files=[],text='',image=false}={}){
  const paths=files.filter(typeable);
  if(paths.length)return {kind:'files',paths};
  if(text)return {kind:'text',text};
  return image?{kind:'image'}:{kind:'empty'};
}
// At most `max` characters, never half of a surrogate pair.
const cut=(text,max)=>{if(text.length<=max)return text;const c=text.charCodeAt(max-1);return text.slice(0,c>=0xd800&&c<=0xdbff?max-1:max);};
// Pasted images live in <data>/pasted for a few days, readable only by this user. The same image keeps its file name.
async function prune(dir,age=KEEP_DAYS*24*60*60*1000){
  let names=[];try{names=await fs.readdir(dir);}catch{return;}
  for(const name of names){const file=path.join(dir,name);try{if(Date.now()-(await fs.stat(file)).mtimeMs>age)await fs.rm(file,{force:true});}catch{}}
}
async function saveImage(root,png){
  const dir=path.join(root,'pasted');await fs.mkdir(dir,{recursive:true,mode:0o700});await prune(dir);
  const file=path.join(dir,`image-${createHash('sha256').update(png).digest('hex').slice(0,16)}.png`);
  try{await fs.writeFile(file,png,{mode:0o600,flag:'wx'});}
  catch(error){if(error.code!=='EEXIST')throw error;const now=new Date();await fs.utimes(file,now,now);}
  return file;
}
// The main process's read for a paste: {kind:'files',paths}, {kind:'text',text,truncated}, {kind:'image',path} or
// {kind:'empty'}. The image is decoded only when it is all there is (encoding a large screenshot takes a moment).
async function read(clipboard,root,{platform=process.platform}={}){
  const {files,text}=contents(clipboard,platform),pick=choose({files,text});
  if(pick.kind==='text')return pick.text.length>MAX_TEXT?{kind:'text',text:cut(pick.text,MAX_TEXT),truncated:true}:pick;
  if(pick.kind==='files')return pick;
  let image=null;try{image=clipboard.readImage();}catch{}
  if(!image||image.isEmpty())return {kind:'empty'};
  return {kind:'image',path:await saveImage(root,image.toPNG())};
}
// Where a terminal of this agent runs: 'docker' (inside its container, on this computer or on a machine), 'ssh' (on a
// machine) or 'local'. The shell of an agent Opaya reaches over HTTPS runs on this computer.
function terminalPlace(agent){const place=attachments.placeOf(agent);return place==='api'?'local':place;}
const inside=(file,dir)=>{const r=path.relative(dir,path.resolve(file));return !!r&&!r.startsWith('..')&&!path.isAbsolute(r);};
// The paths a paste types into a terminal of `agent`: the same paths on this computer; on a machine or in a container,
// copies made there first in ~/.opaya/attachments/pasted (older ones go after a few days). posix: how to quote them.
async function place(agent,host,paths,{root='',spawn,keep=KEEP_DAYS}={}){
  if(!Array.isArray(paths)||!paths.length||paths.length>MAX_PATHS)throw new Error(`Paste between 1 and ${MAX_PATHS} files at once.`);
  for(const p of paths){
    if(typeof p!=='string'||!p||p.length>4096||!path.isAbsolute(p))throw new Error('Files are pasted by their full path on this computer.');
    if(!typeable(p))throw new Error(`${attachments.safeName(path.basename(p))} has a line break or another control character in its name. Rename it, then paste it again.`);
  }
  if(terminalPlace(agent)==='local')return {paths,posix:process.platform!=='win32'};
  const where=attachments.placeName(agent,host),items=[];let total=0;
  if(paths.length>attachments.MAX_FILES)throw new Error(`Paste at most ${attachments.MAX_FILES} files at once into a terminal on ${where}.`);
  for(const p of paths){
    const name=attachments.safeName(path.basename(p));let st;
    // Opaya's own data (settings, the token vault) never leaves this computer; pasted images and attachments can.
    if(root&&inside(p,root)&&!inside(p,path.join(root,'pasted'))&&!inside(p,path.join(root,'attachments')))throw new Error(`${name} is one of Opaya's own data files and is not copied to ${where}.`);
    try{st=await fs.stat(p);}catch{throw new Error(`${name} was not found. It may have been moved or deleted.`);}
    if(st.isDirectory())throw new Error(`${name} is a folder. Only files can be copied to ${where}; paste the files in it instead.`);
    if(!st.isFile())throw new Error(`${name} is not a regular file.`);
    if(st.size>attachments.MAX_FILE)throw new Error(`${name} is ${attachments.size(st.size)}. A file pasted into a terminal on ${where} can be at most ${attachments.size(attachments.MAX_FILE)}.`);
    total+=st.size;if(total>attachments.MAX_TOTAL)throw new Error(`These files add up to ${attachments.size(total)}. One paste into a terminal on ${where} can carry at most ${attachments.size(attachments.MAX_TOTAL)}.`);
    items.push({name,path:p});
  }
  const out=[];for(const item of items)out.push(await attachments.upload(agent,host,item,'pasted',{spawn,keep}));
  return {paths:out,posix:true,copied:where};
}
module.exports={MAX_TEXT,KEEP_DAYS,plistPaths,uriListPaths,fileNameW,contents,choose,read,saveImage,prune,terminalPlace,place};
