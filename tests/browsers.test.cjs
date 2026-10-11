'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const b=require('../desktop/browsers.cjs');

test('the browsers installed here are found per platform, and a sign-in opens in the one picked',()=>{
  const win=b.list({platform:'win32',env:{ProgramFiles:'C:\\Program Files','ProgramFiles(x86)':'C:\\Program Files (x86)',LOCALAPPDATA:'C:\\Users\\me\\AppData\\Local'}},p=>/chrome\.exe$|msedge\.exe$/.test(p)&&!/Local/.test(p));
  assert.deepEqual(win.map(x=>x.id),['chrome','edge']);
  const mac=b.list({platform:'darwin',env:{HOME:'/Users/me'}},p=>['/Applications/Google Chrome.app','/Applications/Safari.app'].includes(p));
  assert.deepEqual(mac.map(x=>[x.id,x.label]),[['chrome','Google Chrome'],['safari','Safari']]);
  const calls=[];const run=(cmd,args)=>{calls.push([cmd,...args]);return {on(){},unref(){}};};
  b.open('https://auth.openai.com/oauth/authorize?x=1','chrome',{platform:'win32',run,found:win});
  b.open('https://auth.openai.com/a','chrome',{platform:'darwin',run,found:mac});
  assert.deepEqual(calls,[['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe','https://auth.openai.com/oauth/authorize?x=1'],['open','-a','/Applications/Google Chrome.app','https://auth.openai.com/a']]);
  assert.throws(()=>b.open('file:///etc/passwd','chrome',{run,found:win}),/Only web addresses/);
  assert.throws(()=>b.open('https://x.io','firefox',{run,found:win}),/not installed/);
});
