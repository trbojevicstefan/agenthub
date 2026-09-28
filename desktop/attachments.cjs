'use strict';
// Files attached to a chat message. The renderer sends {path} for a file the user chose on this computer, or
// {name,mime,data} (base64) for pasted content, which is saved under Opaya's data folder first. Text files are inlined
// into the prompt for every protocol; images go as native image input where the protocol has one; any other file is
// passed by its path, copied first to the machine or container where the agent runs. File data never goes into the
// transcript or on a command line: copies to other machines travel on the stdin of ssh or docker exec.
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {pathToFileURL}=require('node:url');
const {launch,collect,quote,dockerExecContainerIndex}=require('./process.cjs');
const schema=require('./schema.cjs');
const MAX_FILES=10,MAX_FILE=20*1024*1024,MAX_TOTAL=40*1024*1024,MAX_TEXT=512*1024;
// Images up to this size go inline (base64 grows them to 5 MB, the most model APIs such as Anthropic's take per image).
const INLINE_IMAGE=Math.floor(5*1024*1024*3/4);
const MIME={txt:'text/plain',log:'text/plain',ini:'text/plain',conf:'text/plain',env:'text/plain',md:'text/markdown',markdown:'text/markdown',csv:'text/csv',tsv:'text/tab-separated-values',json:'application/json',jsonl:'application/jsonl',xml:'application/xml',yaml:'application/yaml',yml:'application/yaml',toml:'application/toml',html:'text/html',htm:'text/html',css:'text/css',js:'text/javascript',mjs:'text/javascript',cjs:'text/javascript',jsx:'text/javascript',ts:'text/x-typescript',tsx:'text/x-typescript',py:'text/x-python',rb:'text/x-ruby',go:'text/x-go',rs:'text/x-rust',java:'text/x-java',kt:'text/x-kotlin',swift:'text/x-swift',c:'text/x-c',h:'text/x-c',cpp:'text/x-c++',hpp:'text/x-c++',cs:'text/x-csharp',php:'text/x-php',sh:'text/x-shellscript',ps1:'text/plain',sql:'application/sql',svg:'image/svg+xml',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',bmp:'image/bmp',tif:'image/tiff',tiff:'image/tiff',heic:'image/heic',heif:'image/heif',ico:'image/x-icon',pdf:'application/pdf',zip:'application/zip',gz:'application/gzip',tgz:'application/gzip',tar:'application/x-tar','7z':'application/x-7z-compressed',rar:'application/vnd.rar',doc:'application/msword',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',xls:'application/vnd.ms-excel',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',ppt:'application/vnd.ms-powerpoint',pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation',odt:'application/vnd.oasis.opendocument.text',rtf:'application/rtf',epub:'application/epub+zip',mp3:'audio/mpeg',wav:'audio/wav',m4a:'audio/mp4',ogg:'audio/ogg',mp4:'video/mp4',mov:'video/quicktime',webm:'video/webm',wasm:'application/wasm',exe:'application/vnd.microsoft.portable-executable',dmg:'application/x-apple-diskimage'};
const MIME_RE=/^[a-z0-9][\w.+-]{0,63}\/[a-z0-9][\w.+-]{0,127}$/i;
const IMAGES=new Set(['image/png','image/jpeg','image/gif','image/webp']);
const size=n=>n<1024?`${n} B`:n<1024*1024?`${(n/1024).toFixed(n<10240?1:0)} KB`:`${(n/1024/1024).toFixed(1)} MB`;
const mimeOf=(name,fallback='application/octet-stream')=>MIME[String(name).toLowerCase().split('.').pop()]||fallback;
// A file name that is safe to show and to save: no folders, control or reserved characters, no leading dots.
function safeName(name){const base=String(name||'').split(/[\\/]/).pop().replace(/[\x00-\x1f\x7f<>:"|?*]/g,'').replace(/^[.\s]+/,'').trim();return (base.length>120?base.slice(-120):base)||'attachment';}
// Images are recognised by their bytes, so a renamed file is still sent as what it is.
function sniff(b){
  if(b.length>=8&&b[0]===0x89&&b.toString('latin1',1,4)==='PNG')return 'image/png';
  if(b.length>=3&&b[0]===0xff&&b[1]===0xd8&&b[2]===0xff)return 'image/jpeg';
  if(b.length>=6&&/^GIF8[79]a$/.test(b.toString('latin1',0,6)))return 'image/gif';
  if(b.length>=12&&b.toString('latin1',0,4)==='RIFF'&&b.toString('latin1',8,12)==='WEBP')return 'image/webp';
  return '';
}
// Text when there is no NUL byte and the sample is valid UTF-8 (a character cut at the end of the sample is fine).
function isText(sample){if(sample.subarray(0,8192).includes(0))return false;try{new TextDecoder('utf-8',{fatal:true}).decode(sample,{stream:true});return true;}catch{return false;}}
const tooBig=(name,bytes)=>new Error(`${name} is ${size(bytes)}. Each attachment can be at most ${size(MAX_FILE)}.`);
const tooMuch=bytes=>new Error(`These attachments add up to ${size(bytes)}. One message can carry at most ${size(MAX_TOTAL)}.`);
async function head(file,bytes){const handle=await fs.open(file,'r');try{const b=Buffer.alloc(bytes);const {bytesRead}=await handle.read(b,0,bytes,0);return b.subarray(0,bytesRead);}finally{await handle.close();}}
async function statFile(file){
  let st;try{st=await fs.stat(file);}catch{throw new Error(`${path.basename(file)||file} was not found. It may have been moved or deleted.`);}
  if(st.isDirectory())throw new Error(`${path.basename(file)} is a folder. Attach files, not folders.`);
  if(!st.isFile())throw new Error(`${path.basename(file)} is not a regular file.`);
  return st;
}
const validPath=p=>typeof p==='string'&&p.length>0&&p.length<=4096&&!/[\0\r\n]/.test(p)&&path.isAbsolute(p);
const inside=(file,dir)=>{const r=path.relative(dir,path.resolve(file));return !!r&&!r.startsWith('..')&&!path.isAbsolute(r);};
const pastedDir=root=>path.join(root,'attachments','pasted');
// Synchronous checks, before the broker reserves the turn: count, shape, and the size of pasted data.
function check(list){
  if(list===undefined||list===null)return [];
  if(!Array.isArray(list))throw new Error('Attachments must be a list.');
  if(list.length>MAX_FILES)throw new Error(`Attach at most ${MAX_FILES} files to one message.`);
  let total=0;
  return list.map(x=>{
    if(!x||typeof x!=='object')throw new Error('Invalid attachment.');
    const declared=typeof x.mime==='string'&&MIME_RE.test(x.mime)?x.mime.toLowerCase():'';
    if(x.data===undefined){
      if(!validPath(x.path))throw new Error('Attach files by their full path on this computer.');
      return {path:x.path,...(typeof x.name==='string'&&x.name.trim()?{name:safeName(x.name)}:{}),...(declared?{mime:declared}:{})};
    }
    if(typeof x.data!=='string')throw new Error('Invalid attachment data.');
    let data=x.data,mime=declared;
    const url=/^data:([^;,]*)(?:;[^,]*)?;base64,/i.exec(data.slice(0,300));if(url){data=data.slice(url[0].length);if(!mime&&MIME_RE.test(url[1]))mime=url[1].toLowerCase();}
    data=data.replace(/\s+/g,'');
    const name=safeName(typeof x.name==='string'?x.name:'');
    if(!/^[A-Za-z0-9+/]*={0,2}$/.test(data)||data.length%4===1)throw new Error(`${name} is not valid base64 data.`);
    const bytes=Math.floor(data.length*3/4)-(data.endsWith('==')?2:data.endsWith('=')?1:0);
    if(bytes>MAX_FILE)throw tooBig(name,bytes);
    total+=bytes;if(total>MAX_TOTAL)throw tooMuch(total);
    return {name,mime,data};
  });
}
function classify(item,sample,declared=''){
  const image=sniff(sample);
  if(image){item.kind='image';item.mime=image;return item;}
  if(!sample.length||isText(sample)){
    item.kind='text';item.mime=[declared,mimeOf(item.name,'')].find(m=>m&&!IMAGES.has(m))||'text/plain';
    item.text=new TextDecoder('utf-8').decode(sample.subarray(0,MAX_TEXT));item.truncated=item.size>MAX_TEXT;return item;
  }
  item.kind='file';item.mime=declared||mimeOf(item.name);return item;
}
// Reads what each attachment is (image, text or another file) and its text. Writes nothing. Opaya's own data files
// (settings, the token vault) cannot be attached; its attachments folder can.
async function load(list,{root}={}){
  const items=[];let total=0;
  for(const x of list){
    let item;
    if(x.path){
      const name=x.name||safeName(path.basename(x.path));
      if(root&&inside(x.path,root)&&!inside(x.path,path.join(root,'attachments')))throw new Error(`${name} is one of Opaya's own data files and cannot be attached.`);
      const st=await statFile(x.path);
      if(st.size>MAX_FILE)throw tooBig(name,st.size);
      item=classify({name,size:st.size,path:x.path},await head(x.path,MAX_TEXT+4),x.mime);
    }else{
      const buffer=Buffer.from(x.data,'base64');
      item=classify({name:x.name,size:buffer.length,buffer},buffer.subarray(0,MAX_TEXT+4),x.mime);
    }
    total+=item.size;if(total>MAX_TOTAL)throw tooMuch(total);
    items.push(item);
  }
  return items;
}
// Pasted content ends up in <Opaya data>/attachments/<conversation>, so every attachment has a path on this computer:
// data sent to the service is written there, files the window saved in attachments/pasted are moved there.
const folder=(root,conversationId)=>path.join(root,'attachments',schema.id(conversationId));
async function save(items,{root,conversationId}){
  const dir=folder(root,conversationId);
  for(const item of items){
    const staged=!item.buffer&&inside(item.path,pastedDir(root));
    if(!item.buffer&&!staged)continue;
    await fs.mkdir(dir,{recursive:true,mode:0o700});
    if(staged){const file=path.join(dir,path.basename(item.path));await fs.rename(item.path,file);item.path=file;continue;}
    const file=path.join(dir,`${randomUUID().slice(0,8)}-${item.name}`);await fs.writeFile(file,item.buffer,{mode:0o600,flag:'wx'});
    item.path=file;delete item.buffer;
  }
  return items;
}
const remove=(root,conversationId)=>fs.rm(folder(root,conversationId),{recursive:true,force:true}).catch(()=>{});
// In the main process: pasted data is written to attachments/pasted and passed on by path, so a large paste never has to
// fit in one message to the session service. `files` are removed again when the send fails.
async function stage(input,root){
  const list=Array.isArray(input?.attachments)?input.attachments:[];
  if(!list.some(x=>x&&typeof x==='object'&&x.data!==undefined))return {input,files:[]};
  const checked=check(list),files=[],attachments=[];
  try{
    for(const x of checked){
      if(x.data===undefined){attachments.push(x);continue;}
      const dir=pastedDir(root);await fs.mkdir(dir,{recursive:true,mode:0o700});
      const file=path.join(dir,`${randomUUID().slice(0,8)}-${x.name}`);await fs.writeFile(file,Buffer.from(x.data,'base64'),{mode:0o600,flag:'wx'});files.push(file);
      attachments.push({path:file,name:x.name,...(x.mime?{mime:x.mime}:{})});
    }
  }catch(error){await unstage(files);throw error;}
  return {input:{...input,attachments},files};
}
const unstage=files=>Promise.all((files||[]).map(f=>fs.rm(f,{force:true}).catch(()=>{})));
// Pasted files no send picked up (the service was restarting, say) are removed after a day.
async function prune(root,age=24*60*60*1000){
  let names=[];try{names=await fs.readdir(pastedDir(root));}catch{return;}
  for(const name of names){const file=path.join(pastedDir(root),name);try{if(Date.now()-(await fs.stat(file)).mtimeMs>age)await fs.rm(file,{force:true});}catch{}}
}
// What the transcript keeps: enough for the chat to show a chip, no data and no path.
const meta=items=>items.map(({name,size,mime,kind})=>({name,size,mime,kind}));
// What a picked or dropped file is, before it is sent. Folders, missing and oversized files are refused here already.
async function inspect(paths){
  if(!Array.isArray(paths)||!paths.length)throw new Error('Choose files to attach.');
  if(paths.length>100)throw new Error('Choose fewer files.');
  return Promise.all(paths.map(async p=>{
    if(!validPath(p))throw new Error('Attach files by their full path on this computer.');
    const st=await statFile(p),name=path.basename(p);
    if(st.size>MAX_FILE)throw tooBig(name,st.size);
    const sample=await head(p,8192);
    return {path:p,name,size:st.size,mime:sniff(sample)||mimeOf(name,isText(sample)?'text/plain':'application/octet-stream')};
  }));
}
// ---- In the prompt ---------------------------------------------------------------------------------------------
// How much of each text file is inlined: all of it while `budget` characters last. Returns the files that do not fit
// whole (always those over 512 KB); the agent should get their path too.
function plan(items,budget=Infinity){
  const cut=new Set();let left=budget;
  for(const item of items){
    if(item.kind!=='text')continue;
    const n=Math.min(item.text.length,Math.max(0,left));item.shown=item.text.slice(0,n);left-=n;
    if(item.truncated||n<item.text.length)cut.add(item);
  }
  return cut;
}
// A fence longer than any backtick run in the file, so the file cannot close the block early.
function fence(text){let n=3;for(const m of text.matchAll(/`{3,}/g))n=Math.max(n,m[0].length+1);return '`'.repeat(n);}
// The user's text followed by each attachment: text files as fenced blocks with their name, the rest as a line that
// names the file and, when `where` gives one, the path the agent can open it at.
function compose(text,items,where=()=>''){
  const parts=text&&text.trim()?[text]:[];
  for(const item of items){
    const at=where(item)||'';
    if(item.kind==='text'){
      const shown=item.shown??item.text,cut=item.truncated||shown.length<item.text.length;
      const f=fence(shown),ext=item.name.includes('.')?item.name.split('.').pop().toLowerCase():'',lang=/^[\w+-]{1,12}$/.test(ext)?ext:'';
      const head=`[Attached file: ${item.name} (${size(item.size)})${cut?`. ${shown.length?'Only the start is shown here':'It is too long to show here'}${at?`; the whole file is at ${at}`:''}`:''}]`;
      parts.push(shown.length||!cut?`${head}\n${f}${lang}\n${shown}${shown.endsWith('\n')?'':'\n'}${f}`:head);
    }else if(item.kind==='image')parts.push(`[Attached image: ${item.name} (${size(item.size)})${at?` saved at ${at}`:''}]`);
    else parts.push(`[Attached file: ${item.name} (${item.mime}, ${size(item.size)})${at?` saved at ${at}`:''}]`);
  }
  return parts.join('\n\n');
}
// A line for each attachment of an earlier message, when a stateless API gets the history again without the files.
const earlier=list=>(Array.isArray(list)?list:[]).map(a=>`[Attached earlier, not sent again: ${a.name} (${a.kind==='image'?'image':a.mime}, ${size(a.size)})]`).join('\n');
const base64=async item=>(await fs.readFile(item.path)).toString('base64');
// ---- Where the agent can open a file -----------------------------------------------------------------------------
const loopback=endpoint=>{try{return ['127.0.0.1','[::1]','localhost'].includes(new URL(endpoint).hostname);}catch{return false;}};
// 'docker' (in a container, on this computer or over SSH), 'ssh' (on a machine over SSH), 'api' (a gateway Opaya reaches
// only over HTTPS, so it cannot give it files) or 'local'.
function placeOf(agent){
  if(agent.command==='docker'&&dockerExecContainerIndex(agent.args||[])>=0)return 'docker';
  if(agent.transport==='ssh')return 'ssh';
  return agent.endpoint&&agent.transport!=='local'&&!loopback(agent.endpoint)?'api':'local';
}
const placeName=(agent,host)=>placeOf(agent)==='docker'?`the ${agent.name||'agent'} container`:host?.name||'the server';
// Copies one attachment to ~/.opaya/attachments/<conversation>/ where the agent runs. The content goes on stdin of ssh or
// `docker exec -i`, the same way the agent itself is started; the remote shell prints the absolute path. keep: files in
// that folder older than this many days are removed first (terminal pastes share one folder that nothing else empties).
async function upload(agent,host,item,conversationId,{signal,spawn=launch,keep=0}={}){
  const file=quote(`${randomUUID().slice(0,8)}-${item.name}`),old=Number.isInteger(keep)&&keep>0?`{ find "$d" -type f -mtime +${keep} -exec rm -f {} \\; 2>/dev/null || :; } && `:'';
  const script=`umask 077; d="$HOME/.opaya/attachments/${schema.id(conversationId)}" && mkdir -p "$d" && ${old}cat > "$d/"${file} && printf '%s' "$d/"${file}`;
  let child;
  if(placeOf(agent)==='docker'){
    // The agent's own docker exec options (user, environment, workdir), with stdin and without a terminal.
    const args=agent.args,index=dockerExecContainerIndex(args),options=args.slice(1,index).map(a=>/^-[it]{2}$/.test(a)?'-i':a).filter(a=>!['-t','--tty'].includes(a));
    child=spawn({...agent,command:'docker',args:[]},['exec',...(options.some(a=>a==='-i'||a==='--interactive')?[]:['-i']),...options,args[index],'sh','-c',script],host);
  }else child=spawn({...agent,command:'sh',args:[],cwd:'',hermesHome:''},['-c',script],host);
  let out;
  try{out=await collect(child,{input:await fs.readFile(item.path),timeout:10*60*1000,maxBytes:16384,signal});}
  catch(error){throw new Error(`Could not copy ${item.name} to ${placeName(agent,host)}: ${String(error?.message||error).trim().slice(0,300)}`);}
  const remote=String(out).trim().split('\n').pop();
  if(!remote.startsWith('/'))throw new Error(`Could not copy ${item.name} to ${placeName(agent,host)}.`);
  return remote;
}
// The path each item has where the agent runs: a copy made there first for an agent on another machine or in a
// container; on this computer its own path, or a copy in `copyTo` (an agent that may read only that folder).
async function locate(agent,host,items,conversationId,{signal,onEvent=()=>{},spawn,copyTo=''}={}){
  const out=new Map(),remote=placeOf(agent)!=='local';
  for(const item of items){
    if(remote){onEvent({type:'activity',text:`Copying ${item.name} to ${placeName(agent,host)}`});out.set(item,await upload(agent,host,item,conversationId,{signal,spawn}));continue;}
    if(!copyTo||inside(item.path,copyTo)){out.set(item,item.path);continue;}
    await fs.mkdir(copyTo,{recursive:true,mode:0o700});
    const file=path.join(copyTo,`${randomUUID().slice(0,8)}-${item.name}`);await fs.copyFile(item.path,file);await fs.chmod(file,0o600).catch(()=>{});
    out.set(item,file);
  }
  return out;
}
// A file:// URI for a path on this computer, or for a POSIX path on the agent's machine.
const fileUri=(p,remote=false)=>remote?'file://'+p.split('/').map(encodeURIComponent).join('/'):pathToFileURL(p).href;
module.exports={MAX_FILES,MAX_FILE,MAX_TOTAL,MAX_TEXT,INLINE_IMAGE,IMAGES,check,load,save,remove,stage,unstage,prune,folder,meta,inspect,plan,compose,earlier,base64,placeOf,placeName,upload,locate,fileUri,sniff,isText,safeName,mimeOf,size};
