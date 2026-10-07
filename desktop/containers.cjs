'use strict';
// Installing an agent on a machine as a Docker container instead of a regular install. Hermes and OpenClaw use their
// official images; the npm CLIs (Claude Code, Codex, OpenCode, DeepSeek Harness) are installed into a Node.js container. Each container
// keeps its data in a folder in the machine's home (~/opaya-hermes/<name> or ~/opaya-agents/<name>; OpenClaw in the
// Docker volume opaya-<name>-data), restarts with the machine, and is added to Opaya as a `docker exec` agent (OpenClaw
// over its gateway API, published on the machine's 127.0.0.1 only and reached through the SSH tunnel). Names are
// validated; everything interpolated is quoted.
const {quote}=require('./process.cjs');
const q=quote;
const NODE_IMAGE='node:24-bookworm';
const HERMES_IMAGE='nousresearch/hermes-agent';
const OPENCLAW_IMAGE='ghcr.io/openclaw/openclaw:latest';
// OpenClaw's gateway port on the machine: fixed per container name, so updates and Opaya's connection agree.
// A Web UI inside a container (DeepSeek Harness) is published on the machine's 127.0.0.1 at a port fixed per name.
const webPort=container=>13100+(require('node:crypto').createHash('sha256').update(container).digest().readUInt16BE(0)%800);
const openclawPort=container=>18800+(require('node:crypto').createHash('sha256').update(container).digest().readUInt16BE(0)%800);
// The OpenClaw container runs its gateway as the main process (official image, user node). The token comes from the
// environment ($tok in the script), is written to no file on the machine and is imported into Opaya's vault.
const openclawRun=(container,port,token='"$tok"')=>`docker run -d --name ${q(container)} --restart unless-stopped -v ${q(container+'-data')}:/home/node/.openclaw -p 127.0.0.1:${port}:18789 -e OPENCLAW_GATEWAY_TOKEN=${token} --entrypoint node ${OPENCLAW_IMAGE} dist/index.js gateway run --bind lan --port 18789 --auth token --allow-unconfigured >/dev/null`;
// signIn: what runs interactively after the install so the user can sign in (they quit it when done).
const PLANS={
  hermes:{name:'Hermes Agent',image:HERMES_IMAGE,dir:'opaya-hermes',mount:'/opt/data',signIn:'hermes setup',signInNote:'Hermes setup asks for your model provider and API key.',
    connection:c=>({provider:'hermes',protocol:'acp',command:'docker',args:['exec','-i',c,'hermes'],hermesHome:'/opt/data',cwd:''})},
  claude:{name:'Claude Code',npm:'@anthropic-ai/claude-code',signIn:'claude',signInNote:'Claude Code opens and asks you to sign in. Type /exit when you are signed in.',
    connection:c=>({provider:'claude',protocol:'claude',command:'docker',args:['exec','-i','-w','/root',c,'claude'],cwd:'/root'})},
  codex:{name:'Codex CLI',npm:'@openai/codex',signIn:"codex login || echo 'Sign in later with Run native CLI: codex login, or with an API key: printenv OPENAI_API_KEY | codex login --with-api-key'",signInNote:'The ChatGPT sign-in opens in your browser here; Opaya passes its answer to Codex in the container.',
    connection:c=>({provider:'codex',protocol:'codex',command:'docker',args:['exec','-i','-w','/root',c,'codex'],cwd:'/root'})},
  openclaw:{name:'OpenClaw',image:OPENCLAW_IMAGE,gateway:true,signIn:'openclaw onboard --mode local --no-install-daemon --skip-health',signInNote:'OpenClaw onboarding asks for your model provider and its sign-in or API key.',
    connection:(c,port)=>({provider:'openclaw',protocol:'openai',endpoint:`http://127.0.0.1:${port}/v1`,model:'openclaw',command:'docker',args:['exec','-i',c,'openclaw'],cwd:''})},
  dsh:{name:'DeepSeek Harness',npm:'@deepseek-ai/dsh',web:3080,signIn:"echo 'DeepSeek Harness has no sign-in: give it DEEPSEEK_API_KEY with the key button in its chat or from the Opaya Vault.'",signInNote:'Give it DEEPSEEK_API_KEY from its chat in Opaya when it is added.',
    connection:c=>({provider:'custom',protocol:'acp',command:'docker',args:['exec','-i','-w','/root',c,'dsh','--profile','acp'],cwd:'/root',avatar:'lib:deepseek'})},
  opencode:{name:'OpenCode',npm:'opencode-ai',signIn:'opencode auth login',signInNote:'OpenCode asks for a provider and key.',
    connection:c=>({provider:'custom',protocol:'acp',command:'docker',args:['exec','-i','-w','/root',c,'opencode','acp'],cwd:'/root',avatar:'lib:opencode'})}
};
const supported=id=>Object.hasOwn(PLANS,id);
const slug=value=>String(value||'').toLowerCase().replace(/[^a-z0-9_-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,40);
// Exit codes the job turns into clear messages.
const EXIT={3:'Docker is not installed on this machine. Install Docker first (Install agents > Docker on this machine), then try again.',4:'This SSH user cannot use Docker. On the machine run: sudo usermod -aG docker $USER, log in again, then retry.',5:'The port for this container is already used on the machine. Choose another name.'};
// OpenClaw: start the gateway container, onboard interactively in it, then turn on the chat API with the container's
// token and restart it. Opaya then imports the token and connects over the SSH tunnel.
function openclawPlan(p,n){
  const container=`opaya-${n}`.slice(0,60),port=openclawPort(container),c=q(container);
  const lines=[
    'export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"',
    "command -v docker >/dev/null 2>&1 || { echo 'Docker is not installed on this machine.'; exit 3; }",
    "docker info >/dev/null 2>&1 || { echo 'This user cannot talk to Docker (not in the docker group).'; exit 4; }",
    `if docker inspect ${c} >/dev/null 2>&1; then echo 'Container ${container} exists; reusing it.'; docker start ${c} >/dev/null; else`,
    `  if (ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -q ':${port} '; then echo 'Port ${port} is already in use on this machine.'; exit 5; fi`,
    `  docker image inspect ${p.image} >/dev/null 2>&1 || { echo 'Downloading ${p.image} (the first time can take a few minutes)'; docker pull ${p.image} || exit 1; }`,
    `  tok=$(openssl rand -hex 24 2>/dev/null || od -An -N24 -tx1 /dev/urandom | tr -d ' \\n')`,
    `  ${openclawRun(container,port)} || exit 1`,
    'fi',
    `echo; echo 'OpenClaw runs in container ${container} (data in the Docker volume ${container}-data, gateway on 127.0.0.1:${port} of this machine).'`,
    `echo '${p.signInNote} Opaya adds the agent when you are done here.'; echo`,
    `if [ -t 0 ]; then t=-it; else t=-i; fi; docker exec $t ${c} ${p.signIn} || echo 'Onboarding did not finish; you can do it later with Run native CLI: openclaw onboard.'`,
    // The gateway keeps the container's token; the chat API Opaya uses is switched on, then the gateway restarts.
    `docker exec ${c} sh -c 'openclaw config set gateway.auth.mode token >/dev/null && openclaw config set gateway.auth.token "$OPENCLAW_GATEWAY_TOKEN" >/dev/null && openclaw config set gateway.http.endpoints.chatCompletions.enabled true >/dev/null' || echo 'Could not turn on the gateway chat API yet.'`,
    `docker restart ${c} >/dev/null && echo 'Gateway restarted.'`,
    `i=0; while [ $i -lt 30 ]; do curl -fsS http://127.0.0.1:${port}/healthz >/dev/null 2>&1 && { echo 'Gateway is up.'; break; }; i=$((i+1)); sleep 1; done`,
    'true'
  ];
  return {framework:{id:'openclaw',name:p.name},container,folder:`Docker volume ${container}-data`,image:p.image,port,importToken:true,command:`sh -c ${q(lines.join('\n'))}`,preview:lines.join('\n'),
    connection:{name:`${p.name} (Docker)`,transport:'ssh',tags:['docker'],...p.connection(container,port)}};
}
function plan(id,{name}={}){
  const p=PLANS[id];if(!p)throw new Error('This agent has no Docker install. Use the regular install.');
  const n=slug(name||id);if(!n)throw new Error('Give the container a name with letters or numbers.');
  if(p.gateway)return openclawPlan(p,n);
  const container=`opaya-${n}`.slice(0,60),folder=p.dir||'opaya-agents',mount=p.mount||'/root',image=p.image||NODE_IMAGE;
  const exec=`docker exec -e HOME=${q(mount)}${p.mount?` -e HERMES_HOME=${q(mount)}`:''}`;
  const lines=[
    'export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"',
    "command -v docker >/dev/null 2>&1 || { echo 'Docker is not installed on this machine.'; exit 3; }",
    "docker info >/dev/null 2>&1 || { echo 'This user cannot talk to Docker (not in the docker group).'; exit 4; }",
    `dir="$HOME/${folder}/${n}"; mkdir -p "$dir"`,
    `if docker inspect ${q(container)} >/dev/null 2>&1; then echo 'Container ${container} exists; reusing it.'; docker start ${q(container)} >/dev/null; else`,
    `  docker image inspect ${image} >/dev/null 2>&1 || { echo 'Downloading ${image} (the first time can take a few minutes)'; docker pull ${image} || exit 1; }`,
    p.image
      ?`  docker run -d --name ${q(container)} --restart unless-stopped -v "$dir:${mount}" -e HERMES_HOME=${q(mount)} --entrypoint sleep ${image} infinity >/dev/null || exit 1`
      :`  docker run -d --name ${q(container)} --restart unless-stopped -v "$dir:${mount}" -w ${q(mount)}${p.web?` -p 127.0.0.1:${webPort(container)}:${p.web}`:''} ${image} sleep infinity >/dev/null || exit 1`,
    'fi',
    ...(p.npm?[`echo 'Installing ${p.name} in the container'`,`docker exec ${q(container)} npm install -g ${p.npm}@latest || exit 1`]:[]),
    `echo; echo '${p.name} runs in container ${container}. Data: '"$dir"`,
    `echo '${p.signInNote} Opaya adds the agent when you are done here.'; echo`,
    // Interactive sign-in in this terminal; a failed or skipped sign-in does not undo the install.
    `if [ -t 0 ]; then t=-it; else t=-i; fi; ${exec} $t ${q(container)} sh -c ${q(p.signIn)} || echo 'Sign-in did not finish; you can do it later with Run native CLI.'`,
    'true'
  ];
  return {framework:{id,name:p.name},container,folder:`~/${folder}/${n}`,image,command:`sh -c ${q(lines.join('\n'))}`,preview:lines.join('\n'),
    connection:{name:`${p.name} (Docker)`,transport:'ssh',tags:['docker'],...p.connection(container)}};
}
module.exports={PLANS,supported,plan,EXIT,slug,openclawRun,openclawPort,webPort,OPENCLAW_IMAGE};
