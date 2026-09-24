'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const free=require('../desktop/free-model.cjs');
// A fake Ollama: /api/tags lists models, /api/show reports capabilities, /api/pull streams progress lines.
function ollama({models=[],caps={}}={}){
  const calls=[];
  const fetchImpl=async(url,init={})=>{calls.push(url);const body=init.body?JSON.parse(init.body):{};
    if(url.endsWith('/api/tags'))return {ok:true,json:async()=>({models:models.map(name=>({name}))})};
    if(url.endsWith('/api/show'))return {ok:true,json:async()=>({capabilities:caps[body.model]||['completion']})};
    if(url.endsWith('/api/pull')){const lines=[{status:'pulling manifest'},{status:'pulling abc123',digest:'sha256:a',total:1000,completed:400},{status:'pulling abc123',digest:'sha256:a',total:1000,completed:1000},{status:'verifying sha256 digest'},{status:'success'}];
      models.push(body.model);const enc=new TextEncoder();return {ok:true,body:(async function*(){for(const l of lines)yield enc.encode(JSON.stringify(l)+'\n');})()};}
    throw new Error('unexpected '+url);};
  return {fetchImpl,calls,models};
}
const agent=()=>{const a={config:null,configured:()=>!!a.config,saveConfig:async c=>{a.config=c;return c;}};return a;};
test('setting up a free model downloads it with progress and connects the Opaya Agent, with nothing to type',async()=>{
  const o=ollama({models:['llama3.2:3b']}),a=agent(),events=[];
  const r=await free.setupFree({opaya:a,model:'qwen3:4b',fetchImpl:o.fetchImpl,progress:e=>events.push(e)});
  assert.equal(r.model,'qwen3:4b');assert.deepEqual(a.config,{preset:'ollama',baseUrl:'http://127.0.0.1:11434/v1',model:'qwen3:4b'});
  assert.deepEqual([...new Set(events.filter(e=>e.state==='done').map(e=>e.step))],['ollama','download','connect']);
  const bytes=events.filter(e=>e.step==='download'&&Number.isFinite(e.bytes));assert.deepEqual(bytes.at(-1),{step:'download',bytes:1000,total:1000});
  // Already downloaded: no second pull.
  const before=o.calls.filter(u=>u.endsWith('/api/pull')).length;await free.setupFree({opaya:agent(),model:'qwen3:4b',fetchImpl:o.fetchImpl});
  assert.equal(o.calls.filter(u=>u.endsWith('/api/pull')).length,before);
  await assert.rejects(()=>free.setupFree({opaya:agent(),model:'not-a-model',fetchImpl:o.fetchImpl}),/free models/);
});
test('a fresh install connects to an Ollama model that can use tools, and only then',async()=>{
  const o=ollama({models:['mistral:7b','my-tool-model:latest'],caps:{'my-tool-model:latest':['completion','tools']}}),a=agent();
  assert.equal(await free.autoConnect({opaya:a,fetchImpl:o.fetchImpl}),'my-tool-model:latest');assert.equal(a.config.model,'my-tool-model:latest');
  assert.equal(await free.autoConnect({opaya:a,fetchImpl:o.fetchImpl}),null,'an already configured agent is left alone');
  assert.equal(await free.autoConnect({opaya:agent(),fetchImpl:ollama({models:['mistral:7b']}).fetchImpl}),null,'no model with tools, no change');
  assert.equal(await free.autoConnect({opaya:agent(),fetchImpl:async()=>{throw new Error('ECONNREFUSED');}}),null,'no Ollama, no change');
});
test('the free presets are listed with a recommendation',()=>{
  assert(free.FREE_MODELS.length>=3);assert(free.FREE_MODELS.some(m=>m.id===free.recommended()));
  const {PRESETS}=require('../desktop/opaya-agent.cjs');for(const id of ['ollama-cloud','cerebras','openrouter','groq','google'])assert(PRESETS[id].free&&PRESETS[id].signup,id);
});
