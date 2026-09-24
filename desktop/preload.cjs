'use strict';
const {contextBridge,ipcRenderer}=require('electron');
const methods=['snapshot','saveAgent','reorderAgents','removeAgent','saveHost','removeHost','discover','connect','disconnect','clearError','select','newConversation','selectConversation','send','stop','saveDraft','saveView','terminalAttach','terminalOpen','terminalWrite','terminalResize','terminalDetach','terminalClose','pick','openDocs','exportConversation'];
const api={};
methods.push('approvalAnswer','terminalPopout','terminalRename');
methods.push('agentModels','selectModel','gateway','updateAgentDisplay');
methods.push('agentDiagnostics','moveAgent','connectAll','playground','files','installFramework','opayaSaveConfig','opayaTest','opayaForgetKey','opayaSend','opayaStop','opayaClear','windowControl');
for(const method of methods)api[method]=async input=>{
  const result=await ipcRenderer.invoke(`hub:${method}`,input);
  if(!result?.ok)throw new Error(result?.error||'Desktop request failed.');
  return result.data;
};
for(const [name,channel] of [['onTerminalDocked','hub:terminal-docked'],['onWindowState','hub:window-state'],['onApproval','hub:approval'],['onState','hub:state'],['onTerminal','hub:terminal'],['onServiceError','hub:service-error']]){
  api[name]=callback=>{if(typeof callback!=='function')throw new Error('A callback is required.');const listener=(_event,value)=>callback(value);ipcRenderer.on(channel,listener);return()=>ipcRenderer.removeListener(channel,listener);};
}
contextBridge.exposeInMainWorld('agenthub',Object.freeze(api));
