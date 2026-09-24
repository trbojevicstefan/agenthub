'use strict';
const {randomUUID} = require('node:crypto');
const path = require('node:path');
const net = require('node:net');
const {PROVIDERS:PROVIDER_PRESETS}=require('./providers.cjs');
const PROVIDERS = new Set(Object.keys(PROVIDER_PRESETS));
const PROTOCOLS = new Set(['openai', 'acp', 'codex', 'claude', 'terminal']);
const TRANSPORTS = new Set(['local', 'ssh', 'http']);
function text(value, label, max = 1024, fallback = '') {
  if (value === undefined || value === null) value = fallback;
  if (typeof value !== 'string' || value.length > max || /[\0\r\n]/.test(value)) throw new Error(`Invalid ${label}.`);
  return value;
}
function id(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(value) || Object.hasOwn(Object.prototype,value)) throw new Error('Invalid identifier.');
  return value;
}
function port(value, fallback = 22) {
  const n = value === '' || value === undefined ? fallback : Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error('Port must be between 1 and 65535.');
  return n;
}
function endpoint(value, {ssh = false} = {}) {
  let u;
  try { u = new URL(text(value, 'endpoint', 2048)); } catch { throw new Error('Enter a full API base URL, for example http://127.0.0.1:8642/v1.'); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.hash || u.search) throw new Error('Use an HTTP(S) base URL without credentials, query parameters or fragments.');
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(u.hostname);
  if (ssh && (!loopback || u.protocol !== 'http:')) throw new Error('SSH APIs must use an HTTP loopback address on the remote machine.');
  if (u.protocol === 'http:' && !loopback) throw new Error('Unencrypted remote HTTP is not allowed. Use HTTPS or an SSH connection.');
  if (u.hostname === 'localhost') u.hostname = '127.0.0.1';
  u.pathname = u.pathname.replace(/\/$/, '');
  return u.toString().replace(/\/$/, '');
}
function parseAddress(value) {
  value=text(value,'SSH address',600).trim();
  if(!value)return {};
  if(value.startsWith('ssh '))value=value.slice(4).trim();
  if(!value.includes('@')&&!value.includes(':')&&!value.includes('/'))return {alias:value};
  let u;try{u=new URL(value.startsWith('ssh://')?value:'ssh://'+value);}catch{throw new Error('Use user@host:22 or a saved SSH alias.');}
  if(u.protocol!=='ssh:'||u.password||u.search||u.hash||(u.pathname&&u.pathname!=='/'))throw new Error('SSH address must not contain passwords, commands or paths.');
  return {alias:'',hostname:u.hostname.replace(/^\[|\]$/g,''),username:decodeURIComponent(u.username),port:u.port||22};
}
function host(input) {
  if (!input || typeof input !== 'object') throw new Error('Missing host.');
  if(input.address?.trim())input={...input,...parseAddress(input.address)};
  const alias = text(input.alias, 'SSH alias', 160);
  if (alias && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(alias)) throw new Error('SSH alias may contain letters, numbers, dots, underscores and hyphens.');
  const hostname = text(input.hostname, 'hostname', 253);
  if (!alias && !hostname) throw new Error('Enter an SSH alias or hostname.');
  if (hostname && !net.isIP(hostname) && !/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(hostname)) throw new Error('Invalid SSH hostname.');
  const username = text(input.username, 'SSH username', 128);
  if (username && !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(username)) throw new Error('Invalid SSH username.');
  const identityFile = text(input.identityFile, 'identity file', 2048);
  if (identityFile && !(path.posix.isAbsolute(identityFile) || path.win32.isAbsolute(identityFile))) throw new Error('Choose an absolute path to the SSH identity file.');
  return {id: input.id ? id(input.id) : randomUUID(), name: text(input.name, 'host name', 80, alias || hostname).trim() || alias || hostname, alias, hostname, username, port: port(input.port), identityFile};
}
// Sidebar group and free-form labels; only shown in Opaya.
function group(value) { return text(value ?? '', 'group', 40).replace(/[\x00-\x1f\x7f]/g, '').trim(); }
function tags(value) {
  if (value === undefined || value === null || value === '') return [];
  const list = Array.isArray(value) ? value : String(value).split(',');
  if (list.length > 12) throw new Error('Use at most 8 tags.');
  const clean = [...new Set(list.map(t => text(String(t), 'tag', 24).replace(/[\x00-\x1f\x7f,]/g, '').trim()).filter(Boolean))];
  if (clean.length > 8) throw new Error('Use at most 8 tags.');
  return clean;
}
// Agent picture: '' (provider default), 'lib:<name>' from the bundled icon library, or a small uploaded raster image.
function avatar(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') throw new Error('Invalid agent icon.');
  if (/^lib:[a-z0-9-]{1,40}$/.test(value)) return value;
  if (value.length <= 200000 && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) return value;
  throw new Error('Agent icons must be a library icon or a PNG, JPEG or WebP image under 150 KB.');
}
// How a cloned agent was made, so it can be redeployed from its source.
function cloneRecipe(c) {
  if (!c || typeof c !== 'object') return null;
  if (!['skills', 'memory', 'personality', 'everything'].includes(c.scope) || !['regular', 'docker'].includes(c.runtime)) return null;
  return {from: id(c.from), scope: c.scope, keys: Boolean(c.keys), runtime: c.runtime, dir: text(c.dir, 'clone folder', 2048), container: text(c.container || '', 'container', 120)};
}
function agent(input) {
  if (!input || typeof input !== 'object') throw new Error('Missing agent.');
  const provider = input.provider || 'custom';
  const protocol = input.protocol || 'openai';
  const transport = input.transport || (protocol === 'openai' ? 'http' : 'local');
  if (!PROVIDERS.has(provider) || !PROTOCOLS.has(protocol) || !TRANSPORTS.has(transport)) throw new Error('Unsupported provider, protocol or transport.');
  if (transport === 'http' && protocol !== 'openai') throw new Error('Only the OpenAI-compatible protocol uses direct HTTP.');
  const name = text(input.name, 'agent name', 80).trim();
  if (!name) throw new Error('Give this agent a name.');
  const args = input.args || [];
  if (!Array.isArray(args) || args.length > 32) throw new Error('Arguments must be an array with at most 32 entries.');
  const command = text(input.command, 'command', 2048, provider === 'custom' ? '' : provider);
  if (protocol !== 'openai' && (!command || command.startsWith('-'))) throw new Error('Enter an executable, not a shell command.');
  const cwd = text(input.cwd, 'working directory', 2048);
  if (cwd && transport === 'ssh' && !path.posix.isAbsolute(cwd)) throw new Error('A remote working directory must be an absolute POSIX path.');
  if (cwd && transport !== 'ssh' && !path.isAbsolute(cwd)) throw new Error('The working directory must be an absolute path.');
  const hermesHome = text(input.hermesHome, 'Hermes home', 2048);
  if (hermesHome && !(transport === 'ssh' ? path.posix.isAbsolute(hermesHome) : path.isAbsolute(hermesHome))) throw new Error('Hermes home must be an absolute path.');
  return {
    id: input.id ? id(input.id) : randomUUID(), name, provider, protocol, transport,
    hostId: transport === 'ssh' ? id(input.hostId) : '', command, args: args.map(a => text(a, 'argument', 2048)), cwd, hermesHome,
    endpoint: protocol === 'openai' ? endpoint(input.endpoint, {ssh: transport === 'ssh'}) : '',
    model: text(input.model, 'model', 256, provider === 'hermes' && protocol==='openai' ? 'hermes-agent' : provider === 'openclaw' ? 'openclaw/default' : ''),
    tmuxSession: input.tmuxSession ? id(input.tmuxSession) : '',
    note: text(input.note, 'note', 400), displayName: text(input.displayName, 'display name', 80).trim(),
    description: text(input.description, 'description', 500).trim(), icon: text(input.icon, 'icon', 16).trim(),
    avatar: avatar(input.avatar), group: group(input.group), tags: tags(input.tags),
    clone: cloneRecipe(input.clone),
    pinned: Boolean(input.pinned), itrust: Boolean(input.itrust), browser: Boolean(input.browser), createdAt: input.createdAt || new Date().toISOString()
  };
}
function prompt(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 80000 || value.includes('\0')) throw new Error('Enter a message shorter than 80,000 characters.');
  return value;
}
module.exports = {text, id, port, endpoint, host, agent, avatar, group, tags, prompt, parseAddress};
