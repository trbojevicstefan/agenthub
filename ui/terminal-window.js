'use strict';
(async()=>{
  const api=window.agenthub,id=decodeURIComponent(location.hash.slice(1)),status=document.querySelector('#status');
  // The status line: the session's state and errors; paste notes (muted) for a while, then the state again.
  const show=(text,muted=false)=>{status.textContent=text;status.style.color=muted?'var(--muted)':'';},fail=e=>show(e.message);
  try{
    const pending=[];let ready=false,seq=0,exited=false,restarting=false,noteTimer=0;
    const note=(text,error)=>{show(text,!error);clearTimeout(noteTimer);noteTimer=setTimeout(()=>{if(status.textContent===text)show(exited?'Session ended':'');},error?8500:4500);};
    const item=await api.terminalAttach({id});seq=item.seq;exited=item.exited;
    const fontSize=Number((await api.snapshot().catch(()=>null))?.view?.terminalFont)||13;
    // Enter in an ended session starts it again here; a remote one reattaches to its tmux session.
    const restart=()=>{if(!exited||restarting)return;restarting=true;show('');
      api.terminalRestart({id,cols:term.cols,rows:term.rows}).then(r=>{if(r.id!==id)show('This session already runs in another Opaya tab.');else if(exited&&r.seq>seq)live();}).catch(fail).finally(()=>{restarting=false;});};
    const core=window.OpayaTerminal.create(document.querySelector('#terminal'),{id,archived:exited,windowsBuild:item.windowsBuild||0,fontSize,onZoom:()=>core.fitAndReport(report),onRestart:restart,onNotice:note}),{term}=core;
    const live=()=>{exited=false;core.setLive(true);show('');};
    const event=e=>{if(e.id!==id)return;if(!ready){pending.push(e);return;}if(e.seq!==undefined){if(e.seq<=seq)return;seq=e.seq;}
      if(e.type==='data')term.write(e.data);
      if(e.type==='exit'){exited=true;core.setLive(false);term.write(window.OpayaTerminal.endedNote(item,e.exitCode));show('Session ended');}
      if(e.type==='restarted')live();};
    api.onTerminal(event);
    api.onTerminal(e=>{if(e.id===id&&e.type==='renamed'){document.querySelector('#title').textContent=e.title;document.title=e.title;}});
    document.querySelector('#title').textContent=item.title;document.title=item.title;if(exited)show('Session ended');
    // Typing goes to the session in pieces the service accepts (a large paste used to be refused whole), in order.
    term.onData(data=>{if(exited)return;for(const part of window.OpayaTerminal.chunks(data))api.terminalWrite({id,data:part}).catch(fail);});
    const report=(cols,rows)=>{if(!exited)api.terminalResize({id,cols,rows}).catch(fail);};
    term.write((item.buffer||'')+(exited?window.OpayaTerminal.endedNote(item):''),()=>{ready=true;pending.forEach(event);core.fitAndReport(report);term.focus();});
    let timer;new ResizeObserver(()=>{clearTimeout(timer);timer=setTimeout(()=>core.fitAndReport(report),60);}).observe(document.querySelector('#terminal'));
    // A click on the title bar, outside its buttons, keeps the keyboard in the terminal.
    document.querySelector('header').addEventListener('mousedown',e=>{if(e.button===0&&!e.target.closest('button')){e.preventDefault();term.focus();}});
    document.querySelector('#dock').onclick=()=>window.close();
    document.querySelector('#end').onclick=async()=>{try{await api.terminalClose({id});window.close();}catch(e){fail(e);}};
  }catch(e){fail(e);}
})();
