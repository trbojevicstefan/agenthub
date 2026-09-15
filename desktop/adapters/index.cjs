'use strict';
const {HttpAdapter}=require('./http.cjs');
const {AcpAdapter}=require('./acp.cjs');
const {CodexAdapter}=require('./codex.cjs');
const {ClaudeAdapter}=require('./claude.cjs');
function createAdapter(options){
  switch(options.agent.protocol){
    case 'openai':return new HttpAdapter(options);
    case 'acp':return new AcpAdapter(options);
    case 'codex':return new CodexAdapter(options);
    case 'claude':return new ClaudeAdapter(options);
    case 'terminal':return {connect:async()=>({description:'Terminal-only agent. Open its CLI below.'}),run:async()=>{throw new Error('Use Terminal for this agent.');},close(){}};
    default:throw new Error('Unknown adapter.');
  }
}
module.exports={createAdapter};
