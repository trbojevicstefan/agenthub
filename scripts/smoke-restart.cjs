'use strict';
const {spawnSync}=require('node:child_process');
const path=require('node:path');
const binary=process.env.AGENTHUB_TEST_EXE||require('electron');
for(const phase of ['write','read']){
  const args=process.env.AGENTHUB_TEST_EXE?['--smoke-test']:['.','--smoke-test'];
  const result=spawnSync(binary,args,{stdio:'inherit',timeout:90000,env:{...process.env,AGENTHUB_SMOKE_OUTPUT:process.env.AGENTHUB_SMOKE_OUTPUT||path.resolve('artifacts/native-smoke'),AGENTHUB_SMOKE_PHASE:phase}});
  if(result.error)throw result.error;if(result.status!==0)process.exit(result.status||1);
}
console.log('Native UI restart, live PTY continuity, draft and conversation identity verified.');
