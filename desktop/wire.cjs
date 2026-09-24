'use strict';
// Authenticated local IPC. No TCP listener, URLs, shell commands or generic eval.
const net = require('node:net');
const {EventEmitter} = require('node:events');
const {timingSafeEqual, createHash} = require('node:crypto');
const path = require('node:path');
const MAX_FRAME = 24 * 1024 * 1024;
function endpoint(root) {
  const suffix = createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 24);
  return process.platform === 'win32' ? `\\\\.\\pipe\\agenthub-${suffix}` : path.join(root, 'session.sock');
}
function sameToken(a, b) {
  return typeof a === 'string' && typeof b === 'string' && /^[a-f0-9]{64}$/.test(a) && /^[a-f0-9]{64}$/.test(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
function frames(socket, receive, limit = MAX_FRAME) {
  let pending = '';
  socket.setEncoding('utf8');
  socket.on('data', chunk => {
    pending += chunk;
    if (Buffer.byteLength(pending) > limit) { socket.destroy(); return; }
    let i;
    while ((i = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, i); pending = pending.slice(i + 1);
      try { receive(JSON.parse(line)); } catch { socket.destroy(); return; }
    }
  });
}
function send(socket, value) {
  if (socket.destroyed || !socket.writable) return false;
  const line = JSON.stringify(value) + '\n';
  if (Buffer.byteLength(line) > MAX_FRAME || socket.writableLength > MAX_FRAME) { socket.destroy(); return false; }
  return socket.write(line);
}
class Client extends EventEmitter {
  constructor(socket) {
    super(); this.socket = socket; this.pending = new Map(); this.next = 1; this.ready = false;
    frames(socket, message => {
      if (message.kind === 'hello') { this.ready = true; this.emit('ready', message.value); }
      else if (message.kind === 'event') this.emit(message.event, message.value);
      else if (message.kind === 'result') {
        const request = this.pending.get(message.id); if (!request) return;
        clearTimeout(request.timer); this.pending.delete(message.id);
        message.error ? request.reject(new Error(message.error)) : request.resolve(message.value);
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('The session service disconnected. Reopen Opaya to reconnect; do not resend an active task blindly.')); }
      this.pending.clear(); this.emit('closed');
    });
  }
  call(method, input = {}, timeout = 150000) {
    if (!this.ready || this.socket.destroyed) return Promise.reject(new Error('Session service is not connected.'));
    if (this.pending.size >= 256) return Promise.reject(new Error('Too many pending requests.'));
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out. Check the connection before retrying.`)); }, timeout);
      this.pending.set(id, {resolve, reject, timer}); send(this.socket, {kind:'call', id, method, input});
    });
  }
  answer(id, allow) { send(this.socket, {kind:'approval', id, allow: allow === true}); }
  close() { this.socket.destroy(); }
}
function connect(address, token, timeout = 2000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(address), client = new Client(socket);
    const timer = setTimeout(() => fail(new Error('Session service handshake timed out.')), timeout);
    function fail(error) { clearTimeout(timer); client.close(); reject(error); }
    socket.once('error', fail);
    socket.once('connect', () => send(socket, {kind:'hello', token}));
    client.once('ready', () => { clearTimeout(timer); socket.removeListener('error', fail); resolve(client); });
    client.once('closed', () => { if (!client.ready) fail(new Error('Session service rejected the connection.')); });
  });
}
// scopes(): Map of extra tokens to the only methods they may call. Scoped clients (for example the browser MCP bridge
// that agents start) get no state and no broadcasts.
function server({token, dispatch, snapshot, onApproval, onDetach, scopes = () => new Map()}) {
  const clients = new Set();
  const listener = net.createServer(socket => {
    let authenticated = false;
    const deadline = setTimeout(() => socket.destroy(), 3000);
    socket.on('error', () => {});
    socket.on('close', () => { clearTimeout(deadline); clients.delete(socket); onDetach?.(socket); });
    frames(socket, message => {
      if (!authenticated) {
        if (message.kind !== 'hello') { socket.destroy(); return; }
        if (sameToken(token, message.token)) { clearTimeout(deadline); authenticated = true; clients.add(socket); send(socket, {kind:'hello', value:snapshot()}); return; }
        const scope = [...scopes()].find(([t]) => sameToken(t, message.token));
        if (!scope) { socket.destroy(); return; }
        clearTimeout(deadline); authenticated = true; socket.scope = scope[1]; send(socket, {kind:'hello', value:null}); return;
      }
      if (socket.scope && (message.kind !== 'call' || !socket.scope.has(message.method))) { send(socket, {kind:'result', id:message.id, error:'Not allowed.'}); return; }
      if (message.kind === 'approval') { onApproval?.(socket, message); return; }
      if (message.kind !== 'call' || !Number.isSafeInteger(message.id) || typeof message.method !== 'string') { socket.destroy(); return; }
      Promise.resolve().then(() => dispatch(message.method, message.input, socket)).then(
        value => send(socket, {kind:'result', id:message.id, value}),
        error => send(socket, {kind:'result', id:message.id, error:String(error?.message || 'Request failed.').slice(0,2400)})
      );
    }, 1024 * 1024);
  });
  listener.broadcast = (event, value) => { for (const socket of clients) send(socket, {kind:'event', event, value}); };
  listener.notify = (socket, event, value) => send(socket, {kind:'event', event, value});
  listener.clients = clients;
  return listener;
}
module.exports = {endpoint, sameToken, connect, server, Client};
