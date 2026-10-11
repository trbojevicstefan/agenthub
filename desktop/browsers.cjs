'use strict';
// The web browsers on this computer, so a sign-in (ChatGPT, Grok, GitHub...) opens in the one the user picks instead of
// always the default one: the account the user wants is often signed in only in one of them. Fixed install locations
// per platform; a URL is passed as one argument, never through a shell.
const fs=require('node:fs');
const path=require('node:path');
const {spawn}=require('node:child_process');

const LABELS={chrome:'Google Chrome',edge:'Microsoft Edge',firefox:'Firefox',brave:'Brave',opera:'Opera',vivaldi:'Vivaldi',chromium:'Chromium',safari:'Safari',arc:'Arc'};
function candidates({platform=process.platform,env=process.env}={}){
  if(platform==='win32'){
    const pf=env.ProgramFiles||'C:\\Program Files',pf86=env['ProgramFiles(x86)']||'C:\\Program Files (x86)',local=env.LOCALAPPDATA||'';
    const at=(...p)=>path.win32.join(...p);
    return {
      chrome:[at(pf,'Google','Chrome','Application','chrome.exe'),at(pf86,'Google','Chrome','Application','chrome.exe'),local&&at(local,'Google','Chrome','Application','chrome.exe')],
      edge:[at(pf86,'Microsoft','Edge','Application','msedge.exe'),at(pf,'Microsoft','Edge','Application','msedge.exe')],
      firefox:[at(pf,'Mozilla Firefox','firefox.exe'),at(pf86,'Mozilla Firefox','firefox.exe')],
      brave:[at(pf,'BraveSoftware','Brave-Browser','Application','brave.exe'),local&&at(local,'BraveSoftware','Brave-Browser','Application','brave.exe')],
      opera:[local&&at(local,'Programs','Opera','opera.exe')],
      vivaldi:[local&&at(local,'Vivaldi','Application','vivaldi.exe'),at(pf,'Vivaldi','Application','vivaldi.exe')]};
  }
  if(platform==='darwin'){
    const apps=['/Applications',path.join(env.HOME||'','Applications')];
    const app=name=>apps.map(d=>path.join(d,`${name}.app`));
    return {chrome:app('Google Chrome'),edge:app('Microsoft Edge'),firefox:app('Firefox'),brave:app('Brave Browser'),arc:app('Arc'),opera:app('Opera'),vivaldi:app('Vivaldi'),safari:['/Applications/Safari.app']};
  }
  const dirs=String(env.PATH||'/usr/bin:/usr/local/bin').split(':').concat(['/usr/bin','/usr/local/bin','/snap/bin']);
  const bin=(...names)=>names.flatMap(n=>dirs.map(d=>path.join(d,n)));
  return {chrome:bin('google-chrome','google-chrome-stable'),chromium:bin('chromium','chromium-browser'),firefox:bin('firefox'),edge:bin('microsoft-edge','microsoft-edge-stable'),brave:bin('brave-browser','brave'),opera:bin('opera'),vivaldi:bin('vivaldi')};
}
// [{id, label, path}] of the browsers that are installed.
function list(opts={},exists=p=>{try{return fs.statSync(p).isFile()||fs.statSync(p).isDirectory();}catch{return false;}}){
  const out=[];
  for(const [id,paths] of Object.entries(candidates(opts))){const p=paths.filter(Boolean).find(exists);if(p)out.push({id,label:LABELS[id]||id,path:p});}
  return out;
}
// Opens url in one browser (an id from list()). Only http and https.
function open(url,id,{platform=process.platform,run=spawn,found=list({platform})}={}){
  let u;try{u=new URL(String(url));}catch{throw new Error('Not a web address.');}
  if(!['http:','https:'].includes(u.protocol))throw new Error('Only web addresses open in a browser.');
  const b=found.find(x=>x.id===id);if(!b)throw new Error('That browser is not installed here.');
  const child=platform==='darwin'?run('open',['-a',b.path,u.toString()],{detached:true,stdio:'ignore'}):run(b.path,[u.toString()],{detached:true,stdio:'ignore',windowsHide:false});
  child.on?.('error',()=>{});child.unref?.();
  return b;
}
module.exports={list,open,candidates,LABELS};
