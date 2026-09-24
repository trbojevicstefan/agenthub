'use strict';
const {spawn} = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
function quote(value) { return "'" + String(value).replace(/'/g, "'\\''") + "'"; }
// Installs made while Opaya runs (winget, installers) only update PATH in the registry. Read it back so new tools are
// found without restarting the session service. Cached briefly because every process launch builds an environment.
let registryEnv = {values: {}, at: 0};
function windowsRegistryEnv() {
  if (process.platform !== 'win32') return {};
  if (Date.now() - registryEnv.at < 15000) return registryEnv.values;
  const read = key => { const values = {}; try { const out = require('node:child_process').execFileSync('reg', ['query', key], {encoding: 'utf8', windowsHide: true, timeout: 3000}); for (const m of out.matchAll(/^\s+(\S+)\s+REG_(?:EXPAND_)?SZ\s+(.*)$/gim)) values[m[1].toUpperCase()] = m[2].trim().replace(/%([^%]+)%/g, (x, name) => process.env[name] ?? x); } catch {} return values; };
  const machine = read('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'), user = read('HKCU\\Environment');
  registryEnv = {values: {...machine, ...user, PATH: [machine.PATH, user.PATH].filter(Boolean).join(';')}, at: Date.now()}; return registryEnv.values;
}
function windowsRegistryPath() { return windowsRegistryEnv().PATH || ''; }
// Hermes' Windows installer sets these as user variables. Opaya may have started before the install, so read them back.
const REGISTRY_VARS = ['HERMES_HOME', 'HERMES_GIT_BASH_PATH'];
function windowsToolDirs() {
  const local = process.env.LOCALAPPDATA || '', roaming = process.env.APPDATA || '', programs = process.env.ProgramFiles || 'C:\\Program Files';
  const dirs = [path.join(programs, 'nodejs'), path.join(programs, 'Git', 'cmd'), path.join(local, 'Microsoft', 'WinGet', 'Links'), path.join(local, 'Programs', 'Python', 'Launcher')];
  for (const base of [path.join(local, 'Programs', 'Python'), path.join(roaming, 'Python')]) {
    try { for (const entry of fs.readdirSync(base)) if (/^Python3\d+/i.test(entry)) dirs.push(path.join(base, entry), path.join(base, entry, 'Scripts')); } catch {}
  }
  return dirs;
}
function environment(extra = {}) {
  const env = {...process.env};
  // Windows environment keys are case-insensitive; avoid passing both Path and PATH.
  if(process.platform==='win32'){const key=Object.keys(env).find(k=>k.toUpperCase()==='PATH');const value=key?env[key]:'';for(const k of Object.keys(env))if(k.toUpperCase()==='PATH')delete env[k];env.PATH=value;}
  // GUI applications do not reliably inherit the user's terminal PATH.
  const dirs = [path.join(os.homedir(), '.local', 'bin'), path.join(os.homedir(), '.cargo', 'bin'), path.join(os.homedir(), '.npm-global', 'bin')];
  if (process.platform === 'win32') {
    dirs.push(path.join(process.env.APPDATA || '', 'npm'), path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH'), ...windowsToolDirs(), ...windowsRegistryPath().split(';'));
    const registry = windowsRegistryEnv();
    for (const name of REGISTRY_VARS) if (!env[name] && registry[name]) env[name] = registry[name];
  } else dirs.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin');
  env.PATH = [...new Set([...(env.PATH || '').split(path.delimiter), ...dirs].filter(Boolean))].join(path.delimiter);
  // Never inherit debugging/runtime injection from an embedding Electron launcher.
  delete env.NODE_OPTIONS; delete env.ELECTRON_RUN_AS_NODE;
  return {...env, ...extra};
}
function findExecutable(name, env = environment()) {
  if (path.isAbsolute(name)) return fs.existsSync(name) ? name : null;
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of (env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const file = path.join(dir, name + extension);
      try { if (fs.statSync(file).isFile()) { fs.accessSync(file, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK); return file; } } catch {}
    }
  }
  return null;
}
function windowsLaunch(executable, args) {
  // npm's .cmd launchers cannot be spawned with shell:false. Prefer the JS entrypoint,
  // run with the user's Node (not Electron) and never interpolate a cmd.exe command.
  if (process.platform !== 'win32' || !/\.(cmd|bat)$/i.test(executable)) return {command: executable, args};
  const dir = path.dirname(executable);
  const name = path.basename(executable, path.extname(executable)).toLowerCase();
  const entry = name === 'codex' ? path.join(dir, 'node_modules/@openai/codex/bin/codex.js') : name === 'claude' ? path.join(dir, 'node_modules/@anthropic-ai/claude-code/cli.js') : name==='openclaw'?path.join(dir,'node_modules/openclaw/openclaw.mjs'):null;
  const node = findExecutable('node.exe');
  if (entry && fs.existsSync(entry) && node) return {command: node, args: [entry, ...args]};
  throw new Error('This Windows batch launcher is not supported for structured chat. Choose its .exe or a Node entrypoint, or use Terminal.');
}
function dockerExecContainerIndex(args = []) {
  if (args[0] !== 'exec') return -1;
  const takesValue = new Set(['-e', '--env', '--env-file', '-u', '--user', '-w', '--workdir', '--name']);
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (takesValue.has(arg)) { i++; continue; }
    if (/^(--env|--env-file|--user|--workdir|--name)=/.test(arg)) continue;
    if (arg === '-i' || arg === '-t' || arg === '--interactive' || arg === '--tty' || arg === '--privileged') continue;
    if (arg.startsWith('-')) continue;
    return i;
  }
  return -1;
}
function dockerExecArgs(agent, args = []) {
  if (agent.command !== 'docker' || args[0] !== 'exec' || !agent.hermesHome) return args;
  const index = dockerExecContainerIndex(args);
  if (index < 0) return args;
  const before = args.slice(0, index), after = args.slice(index);
  const hasHome = args.some((arg, i) => arg === 'HOME=' + agent.hermesHome || ((args[i - 1] === '-e' || args[i - 1] === '--env') && arg.startsWith('HOME=')) || /^--env=HOME=/.test(arg));
  const hasHermesHome = args.some((arg, i) => arg === 'HERMES_HOME=' + agent.hermesHome || ((args[i - 1] === '-e' || args[i - 1] === '--env') && arg.startsWith('HERMES_HOME=')) || /^--env=HERMES_HOME=/.test(arg));
  const hasWorkdir = args.some((arg, i) => arg === '-w' || arg === '--workdir' || args[i - 1] === '-w' || args[i - 1] === '--workdir' || /^--workdir=/.test(arg));
  const injected = [];
  if (!hasHome) injected.push('-e', 'HOME=' + agent.hermesHome);
  if (!hasHermesHome) injected.push('-e', 'HERMES_HOME=' + agent.hermesHome);
  if (!hasWorkdir) injected.push('-w', agent.hermesHome);
  return [...before, ...injected, ...after];
}
function sshArgs(host, {interactive = false} = {}) {
  const args = ['-o', `BatchMode=${interactive ? 'no' : 'yes'}`, '-o', `StrictHostKeyChecking=${interactive ? 'ask' : 'yes'}`, '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-o', 'ForwardAgent=no', '-o', 'ExitOnForwardFailure=yes'];
  // A config alias delegates HostName, User, Port, IdentityFile and ProxyJump to OpenSSH.
  if (!host.alias) {
    args.push('-p', String(host.port || 22));
    if (host.username) args.push('-l', host.username);
  }
  if (host.identityFile) args.push('-i', host.identityFile, '-o', 'IdentitiesOnly=yes');
  return args;
}
function target(host) { return host.alias || host.hostname; }
function remoteCommand(agent, args, {interactive = false} = {}) {
  const prefix = 'export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$HOME/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; ';
  const cwd = agent.command === 'docker' ? '' : agent.cwd ? `cd ${quote(agent.cwd)} && ` : '';
  args = dockerExecArgs(agent, args);
  const home = agent.hermesHome ? `env HERMES_HOME=${quote(agent.hermesHome)} ` : '';
  return prefix + cwd + (interactive ? '' : 'exec ') + home + [agent.command, ...args].map(quote).join(' ');
}
function launch(agent, args, host, overrides = {}) {
  const env = environment(agent.hermesHome && agent.transport !== 'ssh' ? {HERMES_HOME: agent.hermesHome} : {});
  args = dockerExecArgs(agent, args);
  if (agent.transport === 'ssh') {
    if (!host) throw new Error('This agent has no saved SSH host.');
    const ssh = findExecutable('ssh', env);
    if (!ssh) throw new Error('OpenSSH client is missing. Install the Windows OpenSSH Client optional feature or your OS ssh package.');
    return spawn(ssh, [...sshArgs(host), '-T', target(host), remoteCommand(agent, args)], {env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe','pipe','pipe'], ...overrides});
  }
  const executable = findExecutable(agent.command, env);
  if (!executable) throw new Error(`${agent.command} was not found. Install or sign in to this agent in Terminal, then Discover again.`);
  const resolved = windowsLaunch(executable, args);
  return spawn(resolved.command, resolved.args, {cwd: agent.command === 'docker' ? os.homedir() : agent.cwd || os.homedir(), env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe','pipe','pipe'], ...overrides});
}
function terminate(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM');
    else child.kill();
  } catch { try { child.kill(); } catch {} }
  const force = setTimeout(() => {
    try {
      if (child.exitCode !== null || child.signalCode) return;
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch {}
  }, 2000);
  force.unref();
}
function collect(child, {timeout = 15000, maxBytes = 1024 * 1024, input = '', signal} = {}) {
  return new Promise((resolve, reject) => {
    let out = '', err = '', done = false;
    const finish = (error, result) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(result); };
    const abort = () => { terminate(child); finish(new Error('Operation cancelled.')); };
    const timer = setTimeout(() => { terminate(child); finish(new Error('Connection timed out. Check the host and SSH credentials.')); }, timeout);
    signal?.addEventListener('abort', abort, {once: true});
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { out += chunk; if (out.length > maxBytes) { terminate(child); finish(new Error('Discovery response exceeded the safety limit.')); } });
    child.stderr.on('data', chunk => { err = (err + chunk).slice(-4000); });
    child.on('error', error => finish(error));
    child.on('close', code => finish(code === 0 ? null : new Error(err.trim() || `Process exited with code ${code}.`), out));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    if (signal?.aborted) abort();
  });
}
module.exports = {quote, environment, findExecutable, windowsLaunch, dockerExecArgs, dockerExecContainerIndex, sshArgs, target, remoteCommand, launch, terminate, collect};
