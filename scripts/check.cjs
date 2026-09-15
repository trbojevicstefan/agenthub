'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),files=[];
for(const directory of ['desktop','ui','scripts','tests']){
  const walk=d=>{for(const x of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,x.name);if(x.isDirectory()&&!['__pycache__','node_modules'].includes(x.name))walk(p);else if(/\.(cjs|js)$/.test(x.name))files.push(p);}};walk(path.join(root,directory));
}
for(const file of files){const r=spawnSync(process.execPath,['--check',file],{stdio:'inherit'});if(r.status!==0)process.exit(r.status||1);}
const renderer=fs.readFileSync(path.join(root,'ui/app.js'),'utf8');
for(const prohibited of ['localStorage.setItem','eval(','new Function(','ipcRenderer','require('])if(renderer.includes(prohibited))throw new Error('Unsafe renderer primitive: '+prohibited);
const main=fs.readFileSync(path.join(root,'desktop/main.cjs'),'utf8');for(const required of ['contextIsolation:true','sandbox:true','nodeIntegration:false',"setWindowOpenHandler(()=>({action:'deny'}))"])if(!main.includes(required))throw new Error('Missing Electron boundary: '+required);
for(const file of files.filter(p=>p.includes(path.sep+'desktop'+path.sep)||p.includes(path.sep+'ui'+path.sep)))if(/a2agent\.io|a2desktop:|A2AGENT_/.test(fs.readFileSync(file,'utf8')))throw new Error('Legacy application coupling found: '+file);
console.log(`Syntax checked ${files.length} JavaScript files. Static renderer, sandbox configuration and standalone boundaries passed. This is not a native runtime test.`);
