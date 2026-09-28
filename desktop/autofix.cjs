'use strict';
// What went wrong with an agent, from its error, and the fix Opaya knows for it. The service runs the known fixes by
// itself (update what is too old, start a gateway that is down, open the first-time setup or sign-in the agent still
// needs) and hands everything else, and every fix that did not work, to the Opaya Agent in a thread.
const path=require('node:path');
const {fixTarget}=require('./versions.cjs');
const {quote,dockerExecContainerIndex}=require('./process.cjs');
const UNREACHABLE=/ECONNREFUSED|connection refused|fetch failed|ETIMEDOUT|timed? ?out|socket hang up|ECONNRESET|EHOSTUNREACH|ENOTFOUND|\b50[234]\b|bad gateway|service unavailable|could not connect|failed to connect|not reachable|unreachable|tunnel (closed|failed|exited)/i;
const MISSING=/ENOENT|command not found|not recognized as|no such file or directory|executable (was )?not found|is not installed|was not found on this computer/i;
// Agents that still need their first-time setup or sign-in say so in their own words.
const ONBOARDING={
  codex:/not logged in|login required|please (run )?(`?codex login`?|log ?in)|no (credentials|auth)|auth\.json|401 unauthorized/i,
  claude:/not (logged|signed) in|please run \/login|\/login|invalid api key|authentication_error|oauth token/i,
  hermes:/hermes setup|run (the )?setup|no (model|provider|inference provider) (is )?configured|no api key (is )?(set|configured)|not configured yet/i,
  openclaw:/openclaw onboard|not onboarded|onboarding|run `?openclaw (setup|configure)/i,
  opencode:/opencode auth login|no providers? (configured|found)|not authenticated/i
};
const GENERIC_ONBOARDING=/finish (the )?(setup|onboarding)|setup (is )?(not|in)complete|not signed in|sign in first|log ?in first/i;
// The CLI behind a connection: codex, claude, hermes, openclaw or opencode (docker exec agents: the program they run).
function program(agent){
  if(['codex','claude','hermes','openclaw'].includes(agent.provider))return agent.provider;
  const i=agent.command==='docker'?dockerExecContainerIndex(agent.args||[]):-1;
  const bin=path.basename(String(i>=0?agent.args[i+1]||'':agent.command||'')).replace(/\.(exe|cmd|bat|ps1)$/i,'').toLowerCase();
  return bin==='opencode'?'opencode':'';
}
const gatewayAgent=a=>['hermes','openclaw'].includes(a.provider)&&a.protocol==='openai'&&!!a.command;
function classify(agent,error){
  const text=String(error||''),cli=program(agent);
  if(fixTarget(text))return {kind:'outdated',target:fixTarget(text)};
  if(cli&&(ONBOARDING[cli]?.test(text)||GENERIC_ONBOARDING.test(text)))return {kind:'onboarding',program:cli};
  if(gatewayAgent(agent)&&UNREACHABLE.test(text))return {kind:'gateway'};
  if(agent.protocol!=='openai'&&MISSING.test(text))return {kind:'missing',program:cli};
  return {kind:'other',program:cli};
}
// The first-time setup or sign-in of an agent, run in a visible terminal where it runs (a container: inside it).
const SIGN_IN={codex:{local:'codex login',remote:'codex login --device-auth'},claude:{local:'claude',remote:'claude'},hermes:{local:'hermes setup',remote:'hermes setup'},openclaw:{local:'openclaw onboard',remote:'openclaw onboard'},opencode:{local:'opencode auth login',remote:'opencode auth login'}};
const NOTE={codex:'Sign in with your ChatGPT account (on a server: open the link and enter the code).',claude:'Choose how to sign in (your Claude account), finish in the browser, then type /exit.',hermes:'Hermes asks for your model provider and API key.',openclaw:'OpenClaw asks for your model provider and sign-in.',opencode:'OpenCode asks for a provider and key.'};
function signIn(agent,{windows=false}={}){
  const cli=program(agent),plan=SIGN_IN[cli];if(!plan)return null;
  const remote=agent.transport==='ssh'||agent.command==='docker';let command=remote?plan.remote:plan.local;
  if(agent.command==='docker'){
    const i=dockerExecContainerIndex(agent.args||[]),container=i>=0?agent.args[i]:'';if(!container)return null;
    command=`docker exec -it ${quote(container)} ${command}`;
  }else if(cli==='hermes'&&agent.hermesHome&&path.posix.basename(path.posix.dirname(agent.hermesHome))==='profiles'){
    // A Hermes profile keeps its own setup in its home.
    command=windows&&agent.transport!=='ssh'?`$env:HERMES_HOME='${String(agent.hermesHome).replace(/'/g,"''")}'; ${command}`:`HERMES_HOME=${quote(agent.hermesHome)} ${command}`;
  }
  return {program:cli,command,note:NOTE[cli]};
}
module.exports={classify,signIn,program,gatewayAgent,UNREACHABLE,MISSING};
