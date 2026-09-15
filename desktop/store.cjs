'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {id} = require('./schema.cjs');
async function readJson(file, fallback) {
  try {
    const info = await fs.stat(file);
    if (info.size > 16 * 1024 * 1024) throw new Error('Local data file exceeds the safety limit.');
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new Error(`Cannot read ${path.basename(file)}. The original file was preserved; back it up before repair.`);
  }
}
async function atomicJson(file, data) {
  const serialized = JSON.stringify(data, null, 2);
  if (Buffer.byteLength(serialized) > 16 * 1024 * 1024) throw new Error('Local data safety limit reached. Export history before continuing.');
  await fs.mkdir(path.dirname(file), {recursive: true, mode: 0o700});
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(tmp, 'wx', 0o600);
    try { await handle.writeFile(serialized); await handle.sync(); } finally { await handle.close(); }
    // Keep one verified prior workspace, never back up malformed JSON over it.
    if (path.basename(file) === 'workspace.json') {
      try { const prior = await fs.readFile(file, 'utf8'); JSON.parse(prior); await fs.writeFile(file + '.bak', prior, {mode:0o600}); } catch {}
    }
    await fs.rename(tmp, file);
  } finally { await fs.rm(tmp, {force: true}).catch(() => {}); }
}
class Store {
  constructor(root) { this.root = root; this.queue = Promise.resolve(); }
  async load() {
    let data;
    try { data = await readJson(path.join(this.root, 'workspace.json'), {version: 1, agents: [], hosts: [], conversations: []}); }
    catch (error) {
      const backup = await readJson(path.join(this.root, 'workspace.json.bak'), null);
      if (!backup) throw error;
      await fs.copyFile(path.join(this.root,'workspace.json'), path.join(this.root,`workspace.${Date.now()}.corrupt.json`));
      data = backup; data.recoveryNotice = 'Recovered the previous workspace backup. The damaged original was preserved.';
    }
    if (data.version !== 1 || !Array.isArray(data.agents) || !Array.isArray(data.hosts) || !Array.isArray(data.conversations)) throw new Error('Unsupported workspace format. Your data was not modified.');
    return data;
  }
  write(data) {
    // Snapshot now, not when a previous disk operation completes.
    const copy = structuredClone(data);
    const task = this.queue.catch(() => {}).then(() => atomicJson(path.join(this.root, 'workspace.json'), copy));
    this.queue = task;
    return task;
  }
  async transcript(conversationId) {
    return readJson(path.join(this.root, 'conversations', `${id(conversationId)}.json`), []);
  }
  writeTranscript(conversationId, messages) {
    const copy = structuredClone(messages);
    const task = this.queue.catch(() => {}).then(() => atomicJson(path.join(this.root, 'conversations', `${id(conversationId)}.json`), copy));
    this.queue = task;
    return task;
  }
  async deleteTranscript(conversationId) {
    await this.queue.catch(() => {});
    await fs.rm(path.join(this.root, 'conversations', `${id(conversationId)}.json`), {force: true});
  }
}
class Vault {
  constructor(root, secureStorage) { this.root = root; this.storage = secureStorage; this.memory = new Map(); this.data = {}; this.queue = Promise.resolve(); }
  async load() { this.data = await readJson(path.join(this.root, 'vault.json'), {}); }
  available() { return this.storage.isEncryptionAvailable() && this.storage.getSelectedStorageBackend?.() !== 'basic_text'; }
  has(key) { return this.memory.has(key) || Boolean(this.data[key]); }
  async set(key, value, persist = true) {
    id(key);
    if (typeof value !== 'string' || value.length > 16000 || /[\r\n\0]/.test(value)) throw new Error('Invalid API token.');
    if (persist && value && !this.available()) throw new Error('OS encryption is unavailable. Uncheck Remember token to keep it in memory for this app session only.');
    if (value && persist) this.data[key] = this.storage.encryptString(value).toString('base64');
    else delete this.data[key];
    if (value && !persist) this.memory.set(key, value); else this.memory.delete(key);
    const copy=structuredClone(this.data);
    this.queue=this.queue.catch(()=>{}).then(()=>atomicJson(path.join(this.root,'vault.json'),copy));
    await this.queue;
  }
  get(key) {
    if (this.memory.has(key)) return this.memory.get(key);
    if (!this.data[key]) return '';
    if (!this.available()) throw new Error('Unlock the OS keychain to use this saved token.');
    return this.storage.decryptString(Buffer.from(this.data[key], 'base64'));
  }
  async remove(key) { await this.set(key, '', false); }
}
module.exports = {Store, Vault, readJson, atomicJson};
