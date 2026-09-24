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
  const child = spawn(process.execPath, args, {detached:true, windowsHide:true, stdio:'ignore', env:environment()});
  let spawnError; child.on('error', e => { spawnError = e; }); child.unref();
  for (let i=0; i<150; i++) {
    if (spawnError) throw spawnError;
    const data = await read();
    if (data?.protocol === 1 && data.pid !== existing?.pid) {
      try { return await connect(endpoint(root), data.token, 1000); } catch {}
    }
    const failure = await fs.readFile(path.join(root,'service-startup-error.txt'),'utf8').catch(()=> '');
    if (failure) throw new Error(failure);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`The session service did not start. See the local logs in ${root}.`);
}
module.exports = {attach, alive};
