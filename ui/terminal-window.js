'use strict';
(async()=>{
  const api=window.agenthub,id=decodeURIComponent(location.hash.slice(1)),status=document.querySelector('#status');
  const fail=e=>{status.textContent=e.message;};
  try{
    const pending=[];let ready=false,seq=0,exited=false;
    const term=new window.Terminal({cursorBlink:true,fontFamily:'Consolas, monospace',fontSize:13,theme:{background:'#111315',foreground:'#d9dde0'}}),fit=new window.FitAddon.FitAddon();
    const event=e=>{if(e.id!==id)return;if(!ready){pending.push(e);return;}if(e.seq<=seq)return;seq=e.seq;if(e.type==='data')term.write(e.data);if(e.type==='exit'){exited=true;term.options.disableStdin=true;status.textContent='Session ended';}};
    api.onTerminal(event);const item=await api.terminalAttach({id});seq=item.seq;exited=item.exited;
    api.onTerminal(e=>{if(e.id===id&&e.type==='renamed'){document.querySelector('#title').textContent=e.title;document.title=e.title;}});
    document.querySelector('#title').textContent=item.title;document.title=item.title;term.loadAddon(fit);term.open(document.querySelector('#terminal'));term.parser.registerOscHandler(52,()=>true);term.options.disableStdin=exited;
    term.onData(data=>{if(!exited)api.terminalWrite({id,data}).catch(fail);});
    const resize=()=>{fit.fit();if(!exited)api.terminalResize({id,cols:term.cols,rows:term.rows}).catch(fail);};
    term.write(item.buffer||'',()=>{ready=true;pending.forEach(event);resize();term.focus();});
    let timer;new ResizeObserver(()=>{clearTimeout(timer);timer=setTimeout(resize,80);}).observe(document.querySelector('#terminal'));
    document.querySelector('#dock').onclick=()=>window.close();
    document.querySelector('#end').onclick=async()=>{try{await api.terminalClose({id});window.close();}catch(e){fail(e);}};
  }catch(e){fail(e);}
})();
