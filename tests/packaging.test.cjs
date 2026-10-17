'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const path=require('node:path');
// The Electron build packs only the app's own dependencies. The web workspace (web/package.json) and its packages stay
// out of it: electron-builder's collector decides what goes into app.asar, so the test asks the same collector.
test('the desktop package gets no web dependency',async()=>{
  const {getNodeModules}=require('app-builder-lib/out/node-module-collector');
  const names=new Set(),walk=list=>{for(const m of list||[]){names.add(m.name);walk(m.dependencies);}};walk(await getNodeModules(path.join(__dirname,'..')));
  const app=require('../package.json'),web=require('../web/package.json');
  for(const name of Object.keys(app.dependencies))assert.ok(names.has(name),`${name} is packed`);
  // The web app serves the same terminal packages (xterm, three) as the desktop window; only the web's own ones count.
  const webOnly=[web.name,...Object.keys(web.dependencies),...Object.keys(web.devDependencies)].filter(name=>!Object.hasOwn(app.dependencies,name));
  assert.ok(webOnly.includes('better-auth')&&webOnly.includes('stripe'));
  for(const name of webOnly)assert.ok(!names.has(name),`${name} must stay out of the desktop package`);
  assert.ok(!app.build.files.some(f=>/^(web|deploy)\b|node_modules/.test(f)),'build.files must not name web/, deploy/ or node_modules');
});
