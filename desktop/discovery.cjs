'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {spawn} = require('node:child_process');
const {findExecutable, environment, sshArgs, target, quote, collect} = require('./process.cjs');
const schema = require('./schema.cjs');
function fingerprint(a) {
  return createHash('sha256').update(JSON.stringify([a.provider, a.protocol, a.transport, a.hostId || '', a.command || '', a.args || [], a.hermesHome || '', a.endpoint || '', a.model || '', a.cwd || '', a.tmuxSession || ''])).digest('hex');
}
function candidate(a, detail, readiness = 'detected') {
  return {...a, discoveryId: fingerprint(a), detail, readiness};
}
function envMetadata(raw) {
  const result = {};
  for (const line of raw.split(/\r?\n/)) {
    // Deliberate allowlist. Never return API_SERVER_KEY or any provider credential.
    const match = line.match(/^\s*(?:export\s+)?(API_SERVER_ENABLED|API_SERVER_PORT)\s*=\s*["']?([^"'#\s]+)/);
    if (match) result[match[1]] = match[2];
  }
  return result;
}
async function readSmall(file, max = 256 * 1024) {
  const info = await fs.stat(file);
  if (info.size > max) throw new Error('File too large for discovery.');
  return fs.readFile(file, 'utf8');
}
async function directories(root) {
  try { return (await fs.readdir(root, {withFileTypes: true})).filter(x => x.isDirectory()).slice(0, 128).map(x => path.join(root, x.name)); } catch { return []; }
}
function sshTokens(raw) {
  const tokens=[];let token='',quoteChar='';
  for(const char of raw){
    if(quoteChar){if(char===quoteChar)quoteChar='';else token+=char;continue;}
    if(char==='#')break;
    if(char==='"'||char==="'"){quoteChar=char;continue;}
    if(/\s/.test(char)){if(token){tokens.push(token);token='';}}else token+=char;
  }
  if(token&&!quoteChar)tokens.push(token);
  return tokens;
}
function parseSSH(raw) {
  const entries = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*Host\s+(.+)$/i);
    if (!m) continue;
    for (const token of sshTokens(m[1])) {
      const alias = token.replace(/^["']|["']$/g, '');
      if (/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(alias)) entries.push({name: alias, alias});
    }
  }
  return [...new Map(entries.map(e => [e.alias, e])).values()];
}
async function sshConfigHosts(home = os.homedir()) {
  const sshRoot = path.join(home, '.ssh');
  const seen = new Set(); const hosts = [];
  async function visit(file, depth = 0) {
    if (depth > 6 || seen.size >= 64 || seen.has(file)) return;
    seen.add(file);
    let raw; try { raw = await readSmall(file); } catch { return; }
    hosts.push(...parseSSH(raw));
    for (const line of raw.split(/\r?\n/)) {
      const match = line.match(/^\s*Include\s+(.+)$/i);
      if (!match) continue;
      for (const token of sshTokens(match[1])) {
        let pattern = token.replace(/^["']|["']$/g, '');
        if (pattern.startsWith('~/')) pattern = path.join(home, pattern.slice(2));
        if (!path.isAbsolute(pattern)) pattern = path.join(sshRoot, pattern);
        const dirname = path.dirname(pattern); const basename = path.basename(pattern);
        if (/[?*]/.test(dirname)) continue;
        if (!/[?*]/.test(basename)) { await visit(pattern, depth + 1); continue; }
        const re = new RegExp('^' + basename.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
        const files = await fs.readdir(dirname).catch(() => []);
        for (const name of files.filter(f => re.test(f)).sort().slice(0,64)) await visit(path.join(dirname,name), depth + 1);
      }
    }
  }
  await visit(path.join(sshRoot, 'config'));
  return [...new Map(hosts.map(h => [h.alias, h])).values()];
}
async function scanLocal({home = os.homedir(), extraHomes = [], probe = true} = {}) {
  const found = [], warnings = [], env = environment();
  const binary = name => findExecutable(name, env);
  const hermesBinary = binary('hermes') || (await fs.stat(path.join(home, '.hermes/hermes-agent/.venv/bin/hermes')).catch(() => null) ? path.join(home,'.hermes/hermes-agent/.venv/bin/hermes') : 'hermes');
  const homes = [...new Set([path.join(home, '.hermes'), ...(await directories(path.join(home, '.hermes/profiles'))), ...extraHomes])];
  for (const root of homes) {
    if (!(await fs.stat(root).catch(() => null))?.isDirectory()) continue;
    const meta = envMetadata(await readSmall(path.join(root, '.env')).catch(() => ''));
    const profile = root === path.join(home, '.hermes') ? 'default' : path.basename(root);
    let port = 8642; try { port = schema.port(meta.API_SERVER_PORT, 8642); } catch { warnings.push(`Invalid API port in Hermes profile ${profile}.`); }
    const enabled = /^(true|1|yes)$/i.test(meta.API_SERVER_ENABLED || '');
    found.push(candidate({name: `Hermes / ${profile}`, provider: 'hermes', protocol: 'openai', transport: 'http', command: hermesBinary, args: [], cwd: home, hermesHome: root, endpoint: `http://127.0.0.1:${port}/v1`, model: profile === 'default' ? 'hermes-agent' : profile}, enabled ? 'Existing Hermes profile. Add its gateway API token to chat.' : 'Profile found. Enable its gateway API, or explicitly choose ACP in advanced settings.', enabled ? 'configured' : 'setup'));
  }
  for (const name of ['codex','claude']) {
    const command = binary(name);
    if (command) found.push(candidate({name: name === 'codex' ? 'Codex' : 'Claude Code', provider: name, protocol: name, transport: 'local', command, args: [], cwd: home}, 'Uses the CLI login already on this machine.'));
  }
  const openclaw = binary('openclaw');
  const openclawRoot = path.join(home,'.openclaw');
  if (openclaw || await fs.stat(openclawRoot).catch(() => null)) {
    let config = {};
    try { config = JSON.parse(await readSmall(path.join(openclawRoot, 'openclaw.json'))); } catch { warnings.push('OpenClaw: a JSON5/nonstandard config may need its port entered manually.'); }
    let port = 18789; try { port = schema.port(config.gateway?.port, 18789); } catch {}
    const agents = Array.isArray(config.agents?.list) ? config.agents.list.slice(0,64) : [{id: 'default', name: 'OpenClaw'}];
    for (const a of agents) {
      const agentId = typeof a.id === 'string' && a.id.length <= 100 ? a.id : 'default';
      found.push(candidate({name: a.name || `OpenClaw / ${agentId}`, provider: 'openclaw', protocol: 'openai', transport: 'http', command: openclaw || 'openclaw', args: [], cwd: home, endpoint: `http://127.0.0.1:${port}/v1`, model: `openclaw/${agentId}`}, 'Enable gateway.http.endpoints.chatCompletions and enter the gateway token.', 'setup'));
    }
  }
  if (probe) {
    const existing = new Set(found.map(a => a.endpoint));
    // Bounded loopback probes only. No LAN, subnet or Internet scan.
    for (const [port, name] of [[8642, 'Hermes API'], [18789, 'OpenClaw gateway'], [11434, 'Ollama'], [1234, 'Local model server']]) {
      const endpoint = `http://127.0.0.1:${port}/v1`;
      if (existing.has(endpoint)) continue;
      try {
        const r = await fetch(`${endpoint}/models`, {signal: AbortSignal.timeout(650), redirect: 'error'});
        if (r.status === 401 || r.status === 403) {
          await r.body?.cancel();
          found.push(candidate({name, provider: port === 8642 ? 'hermes' : port === 18789 ? 'openclaw' : 'custom', protocol: 'openai', transport: 'http', endpoint, model: port === 8642 ? 'hermes-agent' : port === 18789 ? 'openclaw/default' : '', cwd: home}, 'A protected API responded. An API token is required.', 'locked')); continue;
        }
        if (!r.ok) { await r.body?.cancel(); continue; }
        const raw = await limitedBody(r, 65536);
        const data = JSON.parse(raw);
        if (!Array.isArray(data.data)) continue;
        const models = data.data.slice(0, 8).map(m => m.id).filter(m => typeof m === 'string' && m.length < 256);
        found.push(candidate({name, provider: port === 8642 ? 'hermes' : port === 18789 ? 'openclaw' : 'custom', protocol: 'openai', transport: 'http', endpoint, model: models[0] || '', cwd: home}, `API responded${models.length ? `: ${models.join(', ')}` : ''}.`, 'reachable'));
      } catch {}
    }
  }
  return {agents: found, hosts: await sshConfigHosts(home), warnings, machine: {hostname: os.hostname(), home}, scope: 'Known install folders, PATH, SSH aliases and four loopback API ports. No secrets imported.'};
}
async function limitedBody(response, max) {
  if (!response.body) return '';
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let result = '';
  try {
    while (true) { const {done,value} = await reader.read(); if (done) break; result += decoder.decode(value,{stream:true}); if (result.length > max) throw new Error('Response too large.'); }
    return result + decoder.decode();
  } finally { await reader.cancel().catch(() => {}); }
}
async function scanRemote(host, {signal} = {}) {
  const ssh = findExecutable('ssh');
  if (!ssh) throw new Error('OpenSSH client is not installed.');
  const script = await fs.readFile(path.join(__dirname, '../scripts/probe.py'), 'utf8');
  const command = 'export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$HOME/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; python3 -c ' + quote(script);
  const child = spawn(ssh, [...sshArgs(host), '-T', target(host), command], {env: environment(), windowsHide: true, detached: process.platform !== 'win32', stdio:['pipe','pipe','pipe']});
  let result;
  try { result = JSON.parse(await collect(child, {timeout:20000, signal})); }
  catch (error) {
    if (/Host key verification|REMOTE HOST IDENTIFICATION|Permission denied|sign_and_send_pubkey/i.test(error.message)) throw new Error('SSH trust or authentication failed. Open this host in Terminal, verify its fingerprint, and unlock your key in ssh-agent. Discovery never accepts an unknown or changed host key automatically.');
    throw error;
  }
  if (!Array.isArray(result.agents) || result.agents.length > 256) throw new Error('Invalid remote discovery response.');
  const agents = result.agents.map(a => {
    const normalized = schema.agent({...a, transport: 'ssh', hostId: host.id});
    const {id, ...draft} = normalized;
    return candidate(draft, a.detail || `Found on ${host.name}. API tokens remain on the host until you enter one.`, a.readiness || 'detected');
  });
  return {agents, hosts: [], warnings: result.warnings || [], machine: result.machine, scope: 'Read-only inspection of the selected SSH account. No services installed or restarted; no .env values returned.'};
}
module.exports = {scanLocal, scanRemote, parseSSH, sshConfigHosts, envMetadata, fingerprint, candidate, limitedBody};
