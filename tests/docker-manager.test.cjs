'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const path=require('node:path');const {spawnSync}=require('node:child_process');
const {temp}=require('./helpers.cjs');const discovery=require('../desktop/discovery.cjs');const docker=require('../desktop/docker-manager.cjs');
const skip=process.platform==='win32'?'uses a POSIX fake docker':false;
const PS=['c1\topenclaw-openclaw-gateway-1\tghcr.io/openclaw/openclaw:latest\t0.0.0.0:18789->18789/tcp, [::]:18789->18789/tcp\t"docker-entrypoint.s…"',
  'c2\topaya-claw\tghcr.io/openclaw/openclaw:latest\t127.0.0.1:18801->18789/tcp\t"node dist/index.js gateway run"',
  'c3\tclawgw\tghcr.io/openclaw/openclaw\t18789/tcp\t"node dist/index.js gateway"',
  'c4\tpg\tpostgres:16\t5432/tcp\t"postgres"'].join('\n');
// A fake docker: `ps` prints the lines above (or JSON with -a), everything else is logged.
async function fakeDocker(dir){
  await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,'ps.txt'),PS+'\n');
  const json=[{ID:'c2',Names:'opaya-claw',Image:'ghcr.io/openclaw/openclaw:latest',State:'running',Status:'Up 2 hours',Ports:'127.0.0.1:18801->18789/tcp',RunningFor:'3 days ago'},{ID:'c4',Names:'pg',Image:'postgres:16',State:'exited',Status:'Exited (0) 1 hour ago',Ports:'',RunningFor:'5 days ago'}].map(x=>JSON.stringify(x)).join('\n');
  await fs.writeFile(path.join(dir,'psa.txt'),json+'\n');await fs.writeFile(path.join(dir,'images.txt'),JSON.stringify({ID:'abc',Repository:'postgres',Tag:'16',Size:'400MB',CreatedSince:'2 weeks ago'})+'\n');
  await fs.writeFile(path.join(dir,'docker'),`#!/bin/sh\necho "$*" >> "${path.join(dir,'calls.log')}"\ncase "$1" in\n version) echo 27.3.1;;\n ps) if [ "$2" = "-a" ]; then cat "${path.join(dir,'psa.txt')}"; else cat "${path.join(dir,'ps.txt')}"; fi;;\n images) cat "${path.join(dir,'images.txt')}";;\n logs) echo "gateway up"; echo "warn: slow" >&2;;\nesac\nexit 0\n`,{mode:0o755});
}
test('discovery finds OpenClaw gateways running in Docker and skips other containers',()=>{
  const warnings=[],found=discovery.dockerOpenclawFrom(PS,warnings);
  assert.deepEqual(found.map(a=>[a.name,a.endpoint,a.args.join(' '),a.transport,a.model]),[
    ['OpenClaw Docker / openclaw-openclaw-gateway-1','http://127.0.0.1:18789/v1','exec -i openclaw-openclaw-gateway-1 openclaw','http','openclaw'],
    ['OpenClaw Docker / opaya-claw','http://127.0.0.1:18801/v1','exec -i opaya-claw openclaw','http','openclaw']]);
  assert.equal(warnings.length,1);assert.match(warnings[0],/clawgw.*not published/);
});
test('remote discovery lists OpenClaw Docker gateways next to Hermes',{skip},async t=>{
  const dir=await temp(t),bin=path.join(dir,'bin');await fakeDocker(bin);
  const r=spawnSync('python3',[path.join(__dirname,'../scripts/probe.py')],{env:{HOME:dir,PATH:`${bin}:/usr/bin:/bin`},encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);const out=JSON.parse(r.stdout);
  const claws=out.agents.filter(a=>a.provider==='openclaw');
  assert.deepEqual(claws.map(a=>[a.endpoint,a.args.join(' ')]),[['http://127.0.0.1:18789/v1','exec -i openclaw-openclaw-gateway-1 openclaw'],['http://127.0.0.1:18801/v1','exec -i opaya-claw openclaw']]);
  assert.ok(out.warnings.some(w=>/clawgw/.test(w)));
});
test('the Docker manager lists containers and images and runs only validated actions',{skip},async t=>{
  const dir=await temp(t),bin=path.join(dir,'bin');await fakeDocker(bin);const old=process.env.PATH;process.env.PATH=`${bin}:${old}`;
  try{
    const r=await docker.list(null);
    assert.equal(r.running,true);assert.equal(r.version,'27.3.1');
    assert.deepEqual(r.containers.map(c=>[c.name,c.state]),[['opaya-claw','running'],['pg','exited']]);
    assert.equal(r.images[0].repository,'postgres');
    await docker.act(null,{container:'pg',action:'start'});await docker.act(null,{container:'pg',action:'remove'});await docker.act(null,{container:'postgres:16',action:'remove-image'});
    const calls=await fs.readFile(path.join(bin,'calls.log'),'utf8');
    assert.match(calls,/^start pg$/m);assert.match(calls,/^rm -f pg$/m);assert.match(calls,/^rmi postgres:16$/m);
    assert.match(await docker.logs(null,'pg',50),/gateway up[\s\S]*warn: slow|warn: slow[\s\S]*gateway up/);await assert.rejects(()=>docker.logs(null,'$(x)'),/Invalid/);
    await assert.rejects(docker.act(null,{container:'pg; rm -rf /',action:'stop'}),/Invalid/);
    await assert.rejects(docker.act(null,{container:'pg',action:'kill'}),/Unknown/);
  }finally{process.env.PATH=old;}
  assert.equal(docker.terminalCommand({container:'pg',kind:'logs'}),'docker logs --tail 200 -f pg');
  assert.equal(docker.terminalCommand({container:'pg',kind:'shell'}),'docker exec -it pg sh');
  assert.throws(()=>docker.terminalCommand({container:'$(x)',kind:'shell'}),/Invalid/);
  assert.equal(docker.explain(new Error('Cannot connect to the Docker daemon at unix:///var/run/docker.sock')).running,false);
});
