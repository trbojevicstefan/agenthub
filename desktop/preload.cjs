'use strict';
const {contextBridge,ipcRenderer}=require('electron');
const methods=['snapshot','saveAgent','removeAgent','saveHost','removeHost','discover','connect','disconnect','select','newConversation','selectConversation','send','stop','saveDraft','saveView','terminalAttach','terminalOpen','terminalWrite','terminalResize','terminalClose','pick','openDocs','exportConversation'];
const api={};
for(const method of methods)api[method]=async input=>{
  const result=await ipcRenderer.invoke(`hub:${method}`,input);
  if(!result?.ok)throw new Error(result?.error||'Desktop request failed.');
  return result.data;
};
for(const [name,channel] of [['onState','hub:state'],['onTerminal','hub:terminal'],['onServiceError','hub:service-error']]){
  api[name]=callback=>{if(typeof callback!=='function')throw new Error('A callback is required.');const listener=(_event,value)=>callback(value);ipcRenderer.on(channel,listener);return()=>ipcRenderer.removeListener(channel,listener);};
}
contextBridge.exposeInMainWorld('agenthub',Object.freeze(api));
