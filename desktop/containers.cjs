'use strict';
// Installing an agent on a machine as a Docker container instead of a regular install. Hermes uses its official image;
// the npm CLIs (Claude Code, Codex, Gemini CLI, OpenCode) are installed into a Node.js container. Each container keeps
// its data in a folder in the machine's home (~/opaya-hermes/<name> or ~/opaya-agents/<name>), restarts with the
// machine, and is added to Opaya as a `docker exec` agent. Names are validated; everything interpolated is quoted.
const {quote}=require('./process.cjs');
const q=quote;
const NODE_IMAGE='node:22-bookworm';
const HERMES_IMAGE='nousresearch/hermes-agent';
// signIn: what runs interactively after the install so the user can sign in (they quit it when done).
const PLANS={
  hermes:{name:'Hermes Agent',image:HERMES_IMAGE,dir:'opaya-hermes',mount:'/opt/data',signIn:'hermes setup',signInNote:'Hermes setup asks for your model provider and API key.',
    connection:c=>({provider:'hermes',protocol:'acp',command:'docker',args:['exec','-i',c,'hermes'],hermesHome:'/opt/data',cwd:''})},
  claude:{name:'Claude Code',npm:'@anthropic-ai/claude-code',signIn:'claude',signInNote:'Claude Code opens and asks you to sign in. Type /exit when you are signed in.',
    connection:c=>({provider:'claude',protocol:'claude',command:'docker',args:['exec','-i','-w','/root',c,'claude'],cwd:'/root'})},
  codex:{name:'Codex CLI',npm:'@openai/codex',signIn:"codex login --device-auth || echo 'Sign in later with Run native CLI: codex login --device-auth, or with an API key: printenv OPENAI_API_KEY | codex login --with-api-key'",signInNote:'Codex shows a link and a code: open the link on any device and enter the code to sign in with ChatGPT.',
    connection:c=>({provider:'codex',protocol:'codex',command:'docker',args:['exec','-i','-w','/root',c,'codex'],cwd:'/root'})},
  'gemini-cli':{name:'Gemini CLI',npm:'@google/gemini-cli',signIn:'gemini',signInNote:'Gemini CLI asks how to sign in. Type /quit when you are signed in.',
    connection:c=>({provider:'custom',protocol:'acp',command:'docker',args:['exec','-i','-w','/root',c,'gemini','--acp'],cwd:'/root',avatar:'lib:gemini-cli'})},
  opencode:{name:'OpenCode',npm:'opencode-ai',signIn:'opencode auth login',signInNote:'OpenCode asks for a provider and key.',
    connection:c=>({provider:'custom',protocol:'acp',command:'docker',args:['exec','-i','-w','/root',c,'opencode','acp'],cwd:'/root',avatar:'lib:opencode'})}
};
const supported=id=>Object.hasOwn(PLANS,id);
const slug=value=>String(value||'').toLowerCase().replace(/[^a-z0-9_-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,40);
// Exit codes the job turns into clear messages.
const EXIT={3:'Docker is not installed on this machine. Install Docker first (Install agents > Docker on this machine), then try again.',4:'This SSH user cannot use Docker. On the machine run: sudo usermod -aG docker $USER, log in again, then retry.'};
function plan(id,{name}={}){
  const p=PLANS[id];if(!p)throw new Error('This agent has no Docker install. Use the regular install.');
  const n=slug(name||id);if(!n)throw new Error('Give the container a name with letters or numbers.');
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
      :`  docker run -d --name ${q(container)} --restart unless-stopped -v "$dir:${mount}" -w ${q(mount)} ${image} sleep infinity >/dev/null || exit 1`,
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
module.exports={PLANS,supported,plan,EXIT,slug};
