'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {connect, endpoint} = require('./wire.cjs');
const {environment} = require('./process.cjs');
function alive(pid) { if (!Number.isSafeInteger(pid) || pid < 1) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
async function attach(app, root) {
  await fs.mkdir(root, {recursive:true, mode:0o700});
  const file = path.join(root, 'session-service.json');
  const read = async () => { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; } };
  const existing = await read();
  if (existing?.protocol === 1) {
    try { return await connect(endpoint(root), existing.token); } catch {
      if (alive(existing.pid)) throw new Error('The session service is still running but cannot be reached. Restart Opaya before stopping that process; active sessions may still be working.');
    }
  }
  await fs.rm(path.join(root,'service-startup-error.txt'), {force:true});
  const args = [...(app.isPackaged ? [] : [app.getAppPath()]), '--agenthub-host', `--agenthub-profile=${root}`];
  // The service's own output (Electron and native errors) goes to service-output.log for diagnostics.
  let out = 'ignore';
  try { out = require('node:fs').openSync(path.join(root,'service-output.log'),'w',0o600); } catch {}
  const child = spawn(process.execPath, args, {detached:true, windowsHide:true, stdio:['ignore',out,out], env:environment()});
  if (typeof out === 'number') require('node:fs').closeSync(out);
  let spawnError, exitCode = null; child.on('error', e => { spawnError = e; }); child.on('exit', code => { exitCode = code; }); child.unref();
  // Up to 60 seconds: the first launch on a slow or older Mac (Gatekeeper scan, cold disk) can take well over 15.
  for (let i=0; i<600; i++) {
    if (spawnError) throw spawnError;
    const data = await read();
    if (data?.protocol === 1 && data.pid !== existing?.pid) {
      try { return await connect(endpoint(root), data.token, 1000); } catch {}
    }
    const failure = await fs.readFile(path.join(root,'service-startup-error.txt'),'utf8').catch(()=> '');
    if (failure) throw new Error(failure);
    if (exitCode !== null && i > 10) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const last = (await fs.readFile(path.join(root,'service-startup.log'),'utf8').catch(()=>'')).trim().split('\n').pop()?.replace(/^\S+\s/,'') || 'before it logged anything';
  const output = (await fs.readFile(path.join(root,'service-output.log'),'utf8').catch(()=>'')).split('\n').map(l=>l.trim()).filter(l=>l&&!/dbus|Fontconfig/i.test(l)).pop() || '';
  throw new Error(`The session service did not start (${exitCode !== null ? `exited with code ${exitCode}` : 'still starting'}; last step: ${last}${output ? `; output: ${output.slice(0,300)}` : ''}). See service-startup.log and service-output.log in ${root}.`);
}
module.exports = {attach, alive};
