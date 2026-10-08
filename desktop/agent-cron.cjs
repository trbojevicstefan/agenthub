'use strict';
// Agents' own schedules, read and changed where each agent runs, with that agent's own tools: Hermes cron jobs
// (hermes cron, read from its cron/jobs.json), OpenClaw cron (openclaw cron ... --json), Goose schedules (goose schedule,
// with a recipe Opaya writes) and the crontab of the machine or container. The Schedules screen shows them as plain jobs
// and edits them with the same options each agent offers.
const {quote: q, REMOTE_PATH, dockerExecContainerIndex} = require('./process.cjs');

const MARK = '@@opaya:';
// What each kind can do, and the schedule shapes it takes. The Schedules screen draws its forms from this.
const KINDS = {
  hermes: {label: 'Hermes cron jobs', tool: 'hermes cron', schedules: ['cron', 'every', 'at'], pause: true, run: true, edit: true},
  openclaw: {label: 'OpenClaw cron', tool: 'openclaw cron', schedules: ['cron', 'every', 'at'], pause: true, run: true, edit: true},
  goose: {label: 'Goose schedules', tool: 'goose schedule', schedules: ['cron'], pause: false, run: true, edit: true},
  crontab: {label: 'Crontab', tool: 'crontab', schedules: ['cron'], pause: true, run: true, edit: true},
};
const HERMES_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const OPENCLAW_THINKING = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];

function kindsFor(agent) {
  const own = ['hermes', 'openclaw', 'goose'].includes(agent.provider) ? [agent.provider] : [];
  return [...own, 'crontab'];
}
// Hermes: its CLI with the agent's profile (-p name) and HERMES_HOME, and the home that holds cron/jobs.json.
function hermesCli(agent) {
  const args = agent.args || [], i = agent.command === 'docker' ? dockerExecContainerIndex(args) : -1;
  const rest = i >= 0 ? args.slice(i + 1) : args, cli = i >= 0 ? rest[0] || 'hermes' : agent.command || 'hermes';
  const pre = (i >= 0 ? rest.slice(1) : rest).filter(x => !['acp', '--acp', 'chat'].includes(x));
  const env = agent.hermesHome ? `HERMES_HOME=${q(agent.hermesHome)} ` : '';
  return `${env}${q(cli)}${pre.length ? ' ' + pre.map(q).join(' ') : ''}`;
}
function hermesProfile(agent) {
  const args = agent.args || [];
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '-p' || args[i] === '--profile') && args[i + 1]) return args[i + 1];
    const m = /^--profile=(.+)$/.exec(args[i]); if (m) return m[1];
  }
  return '';
}
function hermesHome(agent) {
  if (agent.hermesHome) return q(agent.hermesHome);
  const root = agent.command === 'docker' ? '${HERMES_HOME:-/opt/data}' : '${HERMES_HOME:-$HOME/.hermes}', p = hermesProfile(agent);
  return p ? `"${root}/profiles/"${q(p)}` : `"${root}"`;
}
// OpenClaw: the agent of the gateway this connection talks to (model openclaw/<id>), when it is not the default one.
function openclawAgent(agent) {
  const m = /^openclaw\/([\w.-]+)$/.exec(String(agent.model || ''));
  return m && m[1] !== 'main' && m[1] !== 'default' ? m[1] : '';
}

// One run reads every kind: each section starts with a marker line, then that tool's own output.
function listScript(agent) {
  const parts = [REMOTE_PATH];
  for (const kind of kindsFor(agent)) {
    parts.push(`printf '\\n%s\\n' '${MARK}${kind}'`);
    if (kind === 'hermes') parts.push(`H=${hermesHome(agent)}; echo "@@home:$H"; if [ -f "$H/cron/jobs.json" ]; then cat "$H/cron/jobs.json"; else echo '{"jobs":[]}'; fi`);
    if (kind === 'openclaw') parts.push(`if command -v openclaw >/dev/null 2>&1; then openclaw cron list --all --json 2>&1; else echo '@@missing'; fi`);
    if (kind === 'goose') parts.push(`if command -v goose >/dev/null 2>&1; then out=$(goose schedule list 2>&1); printf '%s\\n' "$out"; printf '%s\\n' "$out" | sed -n 's/^ *Recipe Source[^:]*: *//p' | while IFS= read -r f; do echo "@@recipe:$f"; head -c 16000 "$f" 2>/dev/null; echo; done; else echo '@@missing'; fi`);
    if (kind === 'crontab') parts.push(`if command -v crontab >/dev/null 2>&1; then crontab -l 2>/dev/null; true; else echo '@@missing'; fi`);
  }
  parts.push(`printf '\\n%s\\n' '${MARK}end'`);
  return parts.join('; ');
}
function sections(text) {
  const out = {}; let cur = null;
  // A tool's output may not end with a newline (Hermes writes jobs.json without one): a marker can follow it on a line.
  for (const line of String(text || '').split('\n')) {
    const at = line.indexOf(MARK);
    if (at >= 0 && /^[\w-]+\s*$/.test(line.slice(at + MARK.length))) {
      if (at > 0 && cur && out[cur]) out[cur].push(line.slice(0, at));
      cur = line.slice(at + MARK.length).trim(); if (cur !== 'end') out[cur] = []; continue;
    }
    if (cur && out[cur]) out[cur].push(line);
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.join('\n').replace(/\n+$/, '')]));
}
function json(text) {
  const s = String(text || ''), i = s.search(/[[{]/);
  if (i < 0) throw new Error(s.trim().split('\n').slice(-2).join(' ').slice(0, 300) || 'No output.');
  try { return JSON.parse(s.slice(i)); } catch (error) { throw new Error(`Could not read its output as JSON (${error.message}): ${s.trim().slice(0, 160)}`); }
}
const iso = v => { if (v === null || v === undefined || v === '') return ''; const d = new Date(typeof v === 'number' ? v : String(v)); return Number.isNaN(d.getTime()) ? '' : d.toISOString(); };
const str = v => v === null || v === undefined ? '' : String(v);

function parseHermes(text) {
  const home = (/^@@home:(.*)$/m.exec(text) || [])[1] || '', body = String(text).replace(/^@@home:.*\n?/m, '');
  const data = json(body), list = Array.isArray(data) ? data : Array.isArray(data.jobs) ? data.jobs : data.jobs && typeof data.jobs === 'object' ? Object.entries(data.jobs).map(([id, j]) => ({id, ...j})) : [];
  const jobs = list.filter(j => j && typeof j === 'object').map(j => {
    const s = j.schedule || {}, kind = s.kind === 'interval' ? 'every' : s.kind === 'once' ? 'at' : 'cron';
    const paused = j.enabled === false || j.state === 'paused';
    return {kind: 'hermes', id: str(j.id), name: str(j.name), enabled: !paused, state: str(j.state || (paused ? 'paused' : 'scheduled')),
      schedule: {kind, expr: kind === 'cron' ? str(s.expr) : '', every: kind === 'every' ? Number(s.minutes) || 0 : 0, at: kind === 'at' ? str(s.run_at) : ''},
      scheduleText: str(j.schedule_display || s.display || s.expr || ''), prompt: str(j.prompt),
      nextRun: iso(j.next_run_at), lastRun: iso(j.last_run_at), lastStatus: str(j.last_status), lastError: str(j.last_error || j.last_delivery_error),
      opts: {deliver: str(j.deliver), repeat: j.repeat?.times ?? '', completed: j.repeat?.completed || 0, skills: Array.isArray(j.skills) ? j.skills.map(String) : j.skill ? [String(j.skill)] : [],
        model: str(j.model), provider: str(j.provider), reasoningEffort: str(j.reasoning_effort), workdir: str(j.workdir), script: str(j.script), noAgent: !!j.no_agent,
        continuity: Array.isArray(j.context_from) && j.context_from.includes('self')}};
  });
  return {jobs, where: home ? `${home}/cron/jobs.json` : ''};
}
function parseOpenclaw(text, agent) {
  const data = json(text), list = Array.isArray(data) ? data : Array.isArray(data.jobs) ? data.jobs : Array.isArray(data.items) ? data.items : [];
  const only = openclawAgent(agent);
  const jobs = list.filter(j => j && typeof j === 'object' && (!only || j.agentId === only)).map(j => {
    const s = j.schedule || {}, p = j.payload || {}, d = j.delivery || {}, st = j.state || {};
    const kind = s.kind === 'every' ? 'every' : s.kind === 'at' ? 'at' : s.kind === 'cron' ? 'cron' : str(s.kind);
    const payload = p.kind === 'systemEvent' ? 'systemEvent' : p.kind === 'command' ? 'command' : p.kind === 'script' ? 'script' : p.kind === 'heartbeat' ? 'heartbeat' : 'agentTurn';
    const prompt = payload === 'systemEvent' ? str(p.text) : payload === 'command' ? (Array.isArray(p.argv) ? (p.argv[0] === 'sh' && p.argv[1] === '-lc' ? str(p.argv[2]) : p.argv.join(' ')) : '') : payload === 'script' ? str(p.script) : str(p.message);
    const text = kind === 'cron' ? str(s.expr) + (s.tz ? ` (${s.tz})` : '') : kind === 'every' ? `every ${Math.round((Number(s.everyMs) || 0) / 60000)}m` : kind === 'at' ? `at ${s.at}` : kind;
    return {kind: 'openclaw', id: str(j.id), name: str(j.displayName || j.name), enabled: j.enabled !== false, state: j.enabled === false ? 'disabled' : st.runningAtMs ? 'running' : 'scheduled',
      schedule: {kind, expr: kind === 'cron' ? str(s.expr) : '', every: kind === 'every' ? Math.max(1, Math.round((Number(s.everyMs) || 0) / 60000)) : 0, at: kind === 'at' ? str(s.at) : '', tz: str(s.tz)},
      scheduleText: text, prompt, nextRun: iso(st.nextRunAtMs), lastRun: iso(st.lastRunAtMs), lastStatus: str(st.lastRunStatus || st.lastStatus), lastError: str(st.lastError),
      editable: ['cron', 'every', 'at'].includes(kind) && ['agentTurn', 'systemEvent', 'command'].includes(payload),
      opts: {stableName: str(j.name), description: str(j.description), agent: str(j.agentId), payload, session: str(j.sessionTarget || ''), model: str(p.model), thinking: str(p.thinking),
        timeoutSeconds: p.timeoutSeconds ?? '', delivery: str(d.mode || ''), channel: str(d.channel), to: str(d.to), deleteAfterRun: !!j.deleteAfterRun}};
  });
  return {jobs, filteredBy: only};
}
// Goose prints each job as "- ID: x / Status: / Cron: / Recipe Source (in store): / Last Run:"; recipes follow.
function parseGoose(text) {
  const recipes = {}, main = [];let cur = null;
  for (const line of String(text).split('\n')) {
    const r = /^@@recipe:(.*)$/.exec(line); if (r) { cur = r[1]; recipes[cur] = []; continue; }
    if (cur !== null) recipes[cur].push(line); else main.push(line);
  }
  const jobs = [];let j = null;
  for (const line of main) {
    const id = /^- ID:\s*(.+)$/.exec(line.trim()); if (id) { j = {id: id[1].trim()}; jobs.push(j); continue; }
    if (!j) continue;
    const m = /^\s*(Status|Cron|Recipe Source[^:]*|Last Run):\s*(.*)$/.exec(line); if (!m) continue;
    const k = m[1].startsWith('Recipe') ? 'source' : m[1] === 'Last Run' ? 'lastRun' : m[1].toLowerCase(); j[k] = m[2].trim();
  }
  if (!jobs.length && /error|failed/i.test(main.join('\n')) && !/No scheduled jobs/i.test(main.join('\n'))) throw new Error(main.join(' ').trim().slice(0, 300));
  return {jobs: jobs.map(x => {
    const recipe = (recipes[x.source] || []).join('\n'), status = String(x.status || '');
    return {kind: 'goose', id: x.id, name: recipeField(recipe, 'title') || x.id, enabled: !/PAUSED/i.test(status), state: /RUNNING/i.test(status) ? 'running' : /PAUSED/i.test(status) ? 'paused' : 'scheduled',
      schedule: {kind: 'cron', expr: str(x.cron)}, scheduleText: str(x.cron), prompt: recipeField(recipe, 'prompt') || recipeField(recipe, 'instructions'),
      nextRun: '', lastRun: x.lastRun && x.lastRun !== 'Never' ? iso(x.lastRun) : '', lastStatus: '', lastError: '', opts: {source: str(x.source), description: recipeField(recipe, 'description')}};
  })};
}
// A recipe value: a quoted or plain line, or a block (| or >) of indented lines.
function recipeField(yaml, key) {
  const lines = String(yaml || '').split('\n'), i = lines.findIndex(l => new RegExp(`^${key}:`).test(l)); if (i < 0) return '';
  const v = lines[i].slice(key.length + 1).trim();
  if (/^[|>][-+]?$/.test(v)) { const out = []; for (const l of lines.slice(i + 1)) { if (l.trim() && !/^\s/.test(l)) break; out.push(l.replace(/^ {2}/, '')); } return out.join(v.startsWith('>') ? ' ' : '\n').trim(); }
  if (/^".*"$/.test(v)) { try { return JSON.parse(v); } catch { return v.slice(1, -1); } }
  if (/^'.*'$/.test(v)) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

// Crontab: every schedule line is a job; Opaya pauses one by commenting it out with a marker, and names it with a
// comment on the line before. Other lines (variables, comments) are kept as they are.
const OFF = '#opaya-off# ', NAME = '# opaya-name: ';
const cronLine = /^\s*(@(?:reboot|yearly|annually|monthly|weekly|daily|midnight|hourly)|(?:\S+\s+){4}\S+)\s+(.+)$/;
function isEntry(line) {
  const m = cronLine.exec(line); if (!m || /^\s*#/.test(line) || /^\s*[A-Za-z_][A-Za-z0-9_]*\s*=/.test(line)) return null;
  const when = m[1].trim(); if (!when.startsWith('@') && !when.split(/\s+/).every(f => /^[\d*\/,\-A-Za-z?LW#]+$/.test(f))) return null;
  return {expr: when, command: m[2].trim()};
}
function parseCrontab(text) {
  const lines = String(text || '').split('\n'), jobs = [];
  lines.forEach((line, index) => {
    const off = line.startsWith(OFF), e = isEntry(off ? line.slice(OFF.length) : line); if (!e) return;
    const prev = lines[index - 1] || '', name = prev.startsWith(NAME) ? prev.slice(NAME.length).trim() : '';
    jobs.push({kind: 'crontab', id: `${index}`, name: name || e.command.slice(0, 60), enabled: !off, state: off ? 'paused' : 'scheduled',
      schedule: {kind: 'cron', expr: e.expr}, scheduleText: e.expr, prompt: e.command, nextRun: '', lastRun: '', lastStatus: '', lastError: '',
      opts: {line: index, raw: line, named: !!name}});
  });
  return {jobs};
}
function parse(agent, text) {
  const s = sections(text), result = [];
  for (const kind of kindsFor(agent)) {
    const body = s[kind];
    if (body === undefined) { result.push({kind, ...KINDS[kind], available: false, error: 'Not read.', jobs: []}); continue; }
    if (body.trim() === '@@missing') { result.push({kind, ...KINDS[kind], available: false, error: `${KINDS[kind].tool.split(' ')[0]} is not installed there.`, jobs: []}); continue; }
    try {
      const r = kind === 'hermes' ? parseHermes(body) : kind === 'openclaw' ? parseOpenclaw(body, agent) : kind === 'goose' ? parseGoose(body) : parseCrontab(body);
      result.push({kind, ...KINDS[kind], available: true, error: '', ...r});
    } catch (error) { result.push({kind, ...KINDS[kind], available: true, error: String(error?.message || error).slice(0, 300), jobs: []}); }
  }
  return result;
}

// ---- Changes ---------------------------------------------------------------------------------------------------------
const flag = (name, value) => `--${name}=${q(value)}`;
const clean = (v, max = 8000) => String(v ?? '').replace(/\r/g, '').trim().slice(0, max);
const oneLine = (v, max = 400) => String(v ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, max);
function checkCron(expr) {
  const e = oneLine(expr, 120);
  if (/^@(reboot|yearly|annually|monthly|weekly|daily|midnight|hourly)$/i.test(e)) return e;
  const p = e.split(/\s+/);
  if (p.length < 5 || p.length > 6 || !p.every(f => /^[\d*\/,\-A-Za-z?LW#]+$/.test(f))) throw new Error('A cron schedule needs five fields: minute hour day month weekday (for example 0 9 * * 1-5).');
  return p.join(' ');
}
function checkSchedule(s, kinds) {
  const kind = s?.kind || 'cron';
  if (!kinds.includes(kind)) throw new Error('This schedule type is not supported here.');
  if (kind === 'cron') return {kind, expr: checkCron(s.expr)};
  if (kind === 'every') { const n = Math.round(Number(s.every)); if (!Number.isFinite(n) || n < 1 || n > 525600) throw new Error('Every how many minutes? (1 or more)'); return {kind, every: n}; }
  const at = oneLine(s.at, 64); if (!at || Number.isNaN(new Date(at).getTime())) throw new Error('Choose the date and time it runs.'); return {kind, at};
}
const jobId = v => { const id = oneLine(v, 200); if (!id || /[\s'"`$\\/]/.test(id)) throw new Error('Invalid job id.'); return id; };
// A prompt passed as a positional argument must not look like an option.
const positional = v => (String(v).startsWith('-') ? ' ' : '') + v;

function hermesCommand(agent, op, job = {}) {
  const cli = `${hermesCli(agent)} cron`;
  if (op !== 'save') { const id = jobId(job.id), sub = {pause: 'pause', resume: 'resume', run: 'run', remove: 'remove'}[op]; if (!sub) throw new Error('Unknown action.'); return `${cli} ${sub} ${q(id)}`; }
  const s = checkSchedule(job.schedule, KINDS.hermes.schedules), when = s.kind === 'cron' ? s.expr : s.kind === 'every' ? `every ${s.every}m` : s.at;
  const o = job.opts || {}, prompt = clean(job.prompt), name = oneLine(job.name, 80);
  if (!prompt && !o.script) throw new Error('Write what it should do (or choose a script).');
  const effort = oneLine(o.reasoningEffort, 20); if (effort && !HERMES_EFFORTS.includes(effort)) throw new Error('Unknown reasoning effort.');
  const repeat = o.repeat === '' || o.repeat === null || o.repeat === undefined ? null : Math.round(Number(o.repeat));
  if (repeat !== null && (!Number.isFinite(repeat) || repeat < 0)) throw new Error('Repeat must be a number of runs.');
  const skills = (Array.isArray(o.skills) ? o.skills : String(o.skills || '').split(',')).map(x => oneLine(x, 120)).filter(Boolean);
  const common = [];
  if (oneLine(o.deliver)) common.push(flag('deliver', oneLine(o.deliver)));
  if (repeat) common.push(flag('repeat', String(repeat)));
  if (job.id) {
    const a = [`${cli} edit ${q(jobId(job.id))}`, flag('schedule', when), flag('prompt', prompt), ...(name ? [flag('name', name)] : []), ...common,
      ...(skills.length ? skills.map(x => flag('skill', x)) : ['--clear-skills']), flag('workdir', oneLine(o.workdir, 1024)), flag('model', oneLine(o.model, 200)),
      flag('provider', oneLine(o.provider, 80)), flag('reasoning-effort', effort), flag('script', oneLine(o.script, 1024)),
      ...(o.script ? [o.noAgent ? '--no-agent' : '--agent'] : []), o.continuity ? '--continuity' : '--no-continuity'];
    return a.join(' ');
  }
  const a = [`${cli} create`, ...(name ? [flag('name', name)] : []), ...common, ...skills.map(x => flag('skill', x)),
    ...(oneLine(o.workdir) ? [flag('workdir', oneLine(o.workdir, 1024))] : []), ...(oneLine(o.model) ? [flag('model', oneLine(o.model, 200))] : []),
    ...(oneLine(o.provider) ? [flag('provider', oneLine(o.provider, 80))] : []), ...(effort ? [flag('reasoning-effort', effort)] : []),
    ...(oneLine(o.script) ? [flag('script', oneLine(o.script, 1024)), ...(o.noAgent ? ['--no-agent'] : [])] : []), ...(o.continuity ? ['--continuity'] : []),
    ...(job.enabled === false ? ['--paused'] : []), q(when), ...(prompt ? [q(positional(prompt))] : [])];
  return a.join(' ');
}
function openclawCommand(agent, op, job = {}) {
  const cli = 'openclaw cron';
  if (op !== 'save') { const id = jobId(job.id), sub = {pause: 'disable', resume: 'enable', run: 'run', remove: 'rm'}[op]; if (!sub) throw new Error('Unknown action.'); return `${cli} ${sub} ${q(id)}`; }
  const s = checkSchedule(job.schedule, KINDS.openclaw.schedules), o = job.opts || {}, text = clean(job.prompt), name = oneLine(job.name, 80);
  const payload = ['agentTurn', 'systemEvent', 'command'].includes(o.payload) ? o.payload : 'agentTurn';
  if (!text) throw new Error(payload === 'command' ? 'Write the command it runs.' : 'Write what it should do.');
  if (!name && !job.id) throw new Error('Give the job a name.');
  const thinking = oneLine(o.thinking, 20); if (thinking && !OPENCLAW_THINKING.includes(thinking)) throw new Error('Unknown thinking level.');
  const tz = oneLine(s.kind === 'cron' || s.kind === 'at' ? job.schedule?.tz : '', 64); if (tz && !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+\-]+)*$/.test(tz)) throw new Error('Time zone must be an IANA name such as Europe/Belgrade.');
  const timeout = o.timeoutSeconds === '' || o.timeoutSeconds === undefined || o.timeoutSeconds === null ? null : Math.round(Number(o.timeoutSeconds));
  if (timeout !== null && (!Number.isFinite(timeout) || timeout < 0)) throw new Error('Timeout must be seconds (0 or more).');
  const a = [job.id ? `${cli} edit ${q(jobId(job.id))}` : `${cli} add`];
  if (name) a.push(job.id && o.stableName && o.stableName !== name ? flag('display-name', name) : flag('name', name));
  if (oneLine(o.description)) a.push(flag('description', oneLine(o.description, 400)));
  a.push(s.kind === 'cron' ? flag('cron', s.expr) : s.kind === 'every' ? flag('every', `${s.every}m`) : flag('at', s.at));
  if (tz) a.push(flag('tz', tz));
  if (payload === 'systemEvent') a.push(flag('system-event', text), flag('session', 'main'));
  else if (payload === 'command') a.push(flag('command', text));
  else {
    a.push(flag('message', text));
    const session = oneLine(o.session, 120); if (session && !/^(main|isolated|current|session:[\w:.\-]+)$/.test(session)) throw new Error('Session is main, isolated, current or session:<id>.');
    if (session) a.push(flag('session', session));
    if (oneLine(o.model)) a.push(flag('model', oneLine(o.model, 200)));
    if (thinking) a.push(flag('thinking', thinking));
  }
  if (timeout !== null && payload !== 'systemEvent') a.push(flag('timeout-seconds', String(timeout)));
  if (!job.id) { const who = oneLine(o.agent, 80) || openclawAgent(agent); if (who) a.push(flag('agent', who)); }
  const delivery = ['none', 'announce', 'webhook'].includes(o.delivery) ? o.delivery : '';
  if (delivery === 'none') a.push('--no-deliver');
  if (delivery === 'announce') { a.push('--announce'); if (oneLine(o.channel)) a.push(flag('channel', oneLine(o.channel, 60))); if (oneLine(o.to)) a.push(flag('to', oneLine(o.to, 200))); }
  if (delivery === 'webhook') { const url = oneLine(o.to, 1000); if (!/^https?:\/\//.test(url)) throw new Error('The webhook needs an http(s) URL.'); a.push(flag('webhook', url)); }
  if (o.deleteAfterRun && s.kind === 'at') a.push('--delete-after-run');
  if (!job.id && job.enabled === false) a.push('--disabled');
  a.push('--json');
  return a.join(' ');
}
// Goose runs recipes: Opaya writes one with the prompt (in Goose's recipes folder) and schedules it. An edit replaces
// the schedule under the same id.
function gooseRecipe(job) {
  const block = v => '|\n' + String(v).split('\n').map(l => '  ' + l).join('\n');
  const name = oneLine(job.name, 80) || 'Scheduled from Opaya';
  return `version: 1.0.0\ntitle: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(oneLine(job.opts?.description, 400) || 'Scheduled from Opaya')}\nprompt: ${block(clean(job.prompt))}\n`;
}
function gooseCommand(agent, op, job = {}) {
  if (op !== 'save') { const id = jobId(job.id), sub = {run: 'run-now', remove: 'remove'}[op]; if (!sub) throw new Error('Goose schedules cannot be paused from the command line; delete it or change its schedule.'); return `goose schedule ${sub} --schedule-id ${q(id)}`; }
  const s = checkSchedule(job.schedule, KINDS.goose.schedules); if (!clean(job.prompt)) throw new Error('Write what it should do.');
  const id = job.id ? jobId(job.id) : (oneLine(job.name, 60).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'opaya') + '-' + Date.now().toString(36);
  const file = `"$HOME/.config/goose/recipes/opaya-"${q(id)}.yaml`;
  return [`mkdir -p "$HOME/.config/goose/recipes"`, `printf '%s' ${q(gooseRecipe(job))} > ${file}`,
    ...(job.id ? [`goose schedule remove --schedule-id ${q(id)} >/dev/null 2>&1 || true`] : []),
    `goose schedule add --schedule-id ${q(id)} --cron ${q(s.expr)} --recipe-source ${file}`].join(' && ');
}
// Crontab changes are made on a fresh copy: the line must still be what the screen showed.
function crontabEdit(current, op, job = {}) {
  const lines = String(current || '').replace(/\n+$/, '').split('\n').filter((l, i, all) => all.length > 1 || l !== '');
  const o = job.opts || {}, at = job.id === undefined || job.id === '' ? -1 : Number(o.line ?? job.id);
  if (at >= 0 && lines[at] !== o.raw) throw new Error('The crontab changed meanwhile. Refresh and try again.');
  const named = at > 0 && lines[at - 1]?.startsWith(NAME);
  if (op === 'remove') { lines.splice(named ? at - 1 : at, named ? 2 : 1); return lines; }
  if (op === 'pause' || op === 'resume') { const raw = lines[at].startsWith(OFF) ? lines[at].slice(OFF.length) : lines[at]; lines[at] = op === 'pause' ? OFF + raw : raw; return lines; }
  if (op !== 'save') throw new Error('Unknown action.');
  const s = checkSchedule(job.schedule, ['cron']), command = oneLine(job.prompt, 4000); if (!command) throw new Error('Write the command it runs.');
  const line = (job.enabled === false ? OFF : '') + `${s.expr} ${command}`, name = oneLine(job.name, 80).replace(/#/g, ''), label = name && name !== command.slice(0, 60) ? [NAME + name] : [];
  if (at < 0) return [...lines, ...label, line];
  lines.splice(named ? at - 1 : at, named ? 2 : 1, ...label, line);
  return lines;
}
function crontabRun(job) { const o = job.opts || {}, raw = String(o.raw || ''), e = isEntry(raw.startsWith(OFF) ? raw.slice(OFF.length) : raw); if (!e) throw new Error('Not a crontab entry.'); return `nohup sh -c ${q(e.command)} >/dev/null 2>&1 &`; }

module.exports = {KINDS, HERMES_EFFORTS, OPENCLAW_THINKING, kindsFor, listScript, parse, sections, hermesCli, hermesHome, openclawAgent,
  hermesCommand, openclawCommand, gooseCommand, gooseRecipe, recipeField, crontabEdit, crontabRun, parseCrontab, OFF, NAME};
