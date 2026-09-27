'use strict';
const {HttpAdapter}=require('./http.cjs');
const {AcpAdapter}=require('./acp.cjs');
const {CodexAdapter}=require('./codex.cjs');
const {ClaudeAdapter}=require('./claude.cjs');
const levels=require('../effort.cjs');
function createAdapter(options){
  switch(options.agent.protocol){
    case 'openai':return new HttpAdapter(options);
    case 'acp':return new AcpAdapter(options);
    case 'codex':return new CodexAdapter(options);
    case 'claude':return new ClaudeAdapter(options);
    case 'terminal':return {connect:async()=>({description:'Terminal-only agent. Open its CLI below.'}),run:async()=>{throw new Error('Use Terminal for this agent.');},close(){},efforts:[]};
    default:throw new Error('Unknown adapter.');
  }
}
// The reasoning effort levels an agent takes now, low to high ([] hides the selector): what its connection knows (per
// model or session), else what its protocol usually takes until it connects.
function efforts(agent,adapter){
  if(Array.isArray(adapter?.efforts))return adapter.efforts;
  if(agent.protocol==='claude')return levels.CLAUDE;
  if(agent.protocol==='codex')return levels.CODEX;
  return agent.protocol==='openai'&&!['hermes','openclaw'].includes(agent.provider)?levels.API:[];
}
module.exports={createAdapter,efforts};
