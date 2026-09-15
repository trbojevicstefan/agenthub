'use strict';
const net = require('node:net');
const {spawn} = require('node:child_process');
const {EventEmitter} = require('node:events');
const {findExecutable, sshArgs, target, environment, terminate} = require('./process.cjs');
async function freePort() {
  return new Promise((resolve,reject) => {
    const server = net.createServer(); server.once('error', reject);
    server.listen(0,'127.0.0.1', () => { const port = server.address().port; server.close(error => error ? reject(error) : resolve(port)); });
  });
}
class Tunnel extends EventEmitter {
  constructor(host, endpoint) { super(); this.host = host; this.original = new URL(endpoint); this.child = null; this.closed = false; }
  async start() {
    const ssh = findExecutable('ssh'); if (!ssh) throw new Error('OpenSSH client is not installed.');
    const localPort = await freePort();
    if(this.closed)throw new Error('SSH connection was cancelled.');
    const remoteHost = this.original.hostname === '[::1]' ? '[::1]' : '127.0.0.1';
    const remotePort = Number(this.original.port || 80);
    this.child = spawn(ssh, [...sshArgs(this.host), '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-v', '-N', '-L', `127.0.0.1:${localPort}:${remoteHost}:${remotePort}`, target(this.host)], {env:environment(), windowsHide:true, detached:process.platform !== 'win32', stdio:['ignore','ignore','pipe']});
    this.child.stderr.setEncoding('utf8');
    let stderr = '', failed, handshakeReady=false;
    this.child.stderr.on('data', c => { stderr = (stderr+c).slice(-8000); handshakeReady=handshakeReady||stderr.includes('Entering interactive session.'); });
    this.child.on('error', e => { failed=e; this.emit('closed',e); });
    this.child.on('exit', () => { failed = new Error(stderr || 'SSH tunnel closed.'); this.closed=true; this.emit('closed',failed); });
    const deadline = Date.now()+12000;
    while (Date.now()<deadline) {
      if(this.closed&&!failed)throw new Error('SSH connection was cancelled.');
      if (failed) throw failed;
      const listening = await new Promise(resolve => {
        const socket = net.connect({host:'127.0.0.1',port:localPort}); let done=false;
        const finish = value => { if(done)return; done=true; socket.destroy(); resolve(value); };
        socket.setTimeout(200); socket.once('connect',()=>finish(true)); socket.once('error',()=>finish(false)); socket.once('timeout',()=>finish(false));
      });
      if (listening && handshakeReady) {
        // Both our SSH process handshake and listener must be ready. A random
        // process winning the ephemeral-port race cannot receive the bearer token.
        await new Promise(r=>setTimeout(r,100));
        if(failed)throw failed;
        const url = new URL(this.original); url.hostname='127.0.0.1'; url.port=String(localPort); this.url=url.toString().replace(/\/$/,''); return this.url;
      }
      await new Promise(r=>setTimeout(r,100));
    }
    this.close(); throw new Error('SSH tunnel timed out. Verify the host fingerprint and unlock its SSH key in Terminal.');
  }
  close() { this.closed=true; terminate(this.child); }
}
module.exports = {Tunnel, freePort};
