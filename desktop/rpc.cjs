'use strict';
const {EventEmitter} = require('node:events');
const {terminate} = require('./process.cjs');
class Rpc extends EventEmitter {
  constructor(child, {jsonrpc = true, onRequest = async () => { throw new Error('Unsupported agent request.'); }} = {}) {
    super(); this.child = child; this.jsonrpc = jsonrpc; this.onRequest = onRequest; this.sequence = 0; this.pending = new Map(); this.buffer = ''; this.closed = false; this.stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => this.feed(chunk));
    child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk).slice(-8000); });
    child.on('error', e => this.fail(e));
    child.on('close', code => this.fail(new Error(code === 0 ? 'Agent connection closed.' : `Agent exited (${code}). ${this.stderr.slice(-1800)}`)));
    child.stdin.on('error', e => this.fail(e));
  }
  feed(chunk) {
    if (this.closed) return;
    this.buffer += chunk;
    if (this.buffer.length > 4 * 1024 * 1024) return this.fail(new Error('Agent protocol frame exceeds the safety limit.'));
    let position;
    while ((position = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0,position).trim(); this.buffer = this.buffer.slice(position+1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { this.fail(new Error('Agent stdout was not valid JSON-RPC. Use Terminal to diagnose its startup.')); return; }
      if (!message || typeof message !== 'object' || Array.isArray(message)) { this.fail(new Error('Invalid agent frame.')); return; }
      if (message.method && Object.hasOwn(message, 'id')) {
        const method = message.method;
        Promise.resolve().then(() => this.onRequest(method, message.params || {})).then(result => this.write({id: message.id, result}), () => this.write({id: message.id, error:{code:-32601,message:'Request denied or unsupported by AgentHub.'}})).catch(() => {});
      } else if (message.method) this.emit('notification', message.method, message.params || {});
      else if (Object.hasOwn(message,'id')) {
        const request = this.pending.get(message.id); if (!request) continue;
        clearTimeout(request.timer); this.pending.delete(message.id);
        if (message.error) request.reject(new Error(String(message.error.message || 'Agent request failed.').slice(0,2000))); else request.resolve(message.result);
      }
    }
  }
  write(message) {
    if (this.closed) throw new Error('Agent connection is closed.');
    this.child.stdin.write(JSON.stringify(this.jsonrpc ? {jsonrpc:'2.0',...message} : message) + '\n');
  }
  request(method, params, timeout = 30000) {
    if (this.closed) return Promise.reject(new Error('Agent connection is closed.'));
    const id = ++this.sequence;
    return new Promise((resolve,reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out. Check the agent in Terminal.`)); }, timeout);
      this.pending.set(id,{resolve,reject,timer});
      try { this.write({id,method,params}); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  notify(method, params) { this.write({method,params}); }
  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear(); terminate(this.child); this.emit('closed',error);
  }
  close() { this.fail(new Error('Disconnected by user.')); }
}
module.exports = {Rpc};
