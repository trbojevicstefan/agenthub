'use strict';
// Shared xterm setup for the docked terminal panel and popped-out terminal windows.
// - Windows: ConPTY mode, so xterm and ConPTY do not both rewrap lines (the cause of duplicated TUI status lines).
// - Unicode 11 widths, so emoji and symbols in agent TUIs take the same cells the program expects.
// - WebGL rendering when available (crisp box drawing, fast output), DOM rendering otherwise.
// - Clipboard: Ctrl+C copies a selection (otherwise it interrupts), Ctrl+V / Ctrl+Shift+V paste, Ctrl+Shift+C copies.
// - Ctrl/Cmd+click opens http(s) links. Ctrl+F searches the scrollback.
(()=>{
  const THEME={background:'#111315',foreground:'#d9dde0',cursor:'#a7f3c6',cursorAccent:'#111315',selectionBackground:'#3c4f4680',
    black:'#1b1f22',red:'#f28b82',green:'#8fd9a8',yellow:'#e6c77a',blue:'#8ab4f8',magenta:'#d7aefb',cyan:'#78d9ec',white:'#d9dde0',
    brightBlack:'#5f6b70',brightRed:'#ffaba3',brightGreen:'#b5f5cf',brightYellow:'#f5dc9b',brightBlue:'#aecbfa',brightMagenta:'#e9c8ff',brightCyan:'#a1e9f5',brightWhite:'#ffffff'};
  const LIGHT={...THEME,background:'#fbfcfa',foreground:'#1d2a23',cursor:'#1f7a45',cursorAccent:'#fbfcfa',selectionBackground:'#b9dcc680',
    black:'#1d2a23',red:'#c0392b',green:'#1f7a45',yellow:'#9a6a10',blue:'#2458b8',magenta:'#8a3fb3',cyan:'#137c8b',white:'#6b7a70',
    brightBlack:'#56695d',brightRed:'#d9534a',brightGreen:'#2b9a5a',brightYellow:'#b58318',brightBlue:'#3a6fd0',brightMagenta:'#a257c9',brightCyan:'#1a93a4',brightWhite:'#1d2a23'};
  const isMac=/Mac/.test(navigator.platform);
  function create(element,{archived=false,windowsBuild=0,light=false,api=window.agenthub,onSearch,onContextMenu}={}){
    const options={cursorBlink:!archived,disableStdin:archived,allowProposedApi:true,
      fontFamily:'"Cascadia Mono", "Cascadia Code", "SF Mono", "SFMono-Regular", Menlo, Consolas, "DejaVu Sans Mono", monospace',
      fontSize:13,lineHeight:1.12,letterSpacing:0,scrollback:10000,smoothScrollDuration:0,minimumContrastRatio:1,
      macOptionIsMeta:true,rightClickSelectsWord:false,drawBoldTextInBrightColors:false,fontWeightBold:'600',theme:light?LIGHT:THEME};
    if(windowsBuild)options.windowsPty={backend:'conpty',buildNumber:windowsBuild};
    const term=new window.Terminal(options);
    const fit=new window.FitAddon.FitAddon();term.loadAddon(fit);
    if(window.Unicode11Addon){term.loadAddon(new window.Unicode11Addon.Unicode11Addon());term.unicode.activeVersion='11';}
    const search=window.SearchAddon?new window.SearchAddon.SearchAddon():null;if(search)term.loadAddon(search);
    if(window.WebLinksAddon&&api?.openLink)term.loadAddon(new window.WebLinksAddon.WebLinksAddon((event,uri)=>{if(event.ctrlKey||event.metaKey)api.openLink({url:uri}).catch(()=>{});}));
    term.open(element);
    // WebGL needs the element in the page. If the GPU context is lost, fall back to DOM rendering.
    if(window.WebglAddon){try{const gl=new window.WebglAddon.WebglAddon();gl.onContextLoss(()=>gl.dispose());term.loadAddon(gl);}catch{}}
    // OSC 52 (programs writing to the clipboard) stays blocked.
    term.parser.registerOscHandler(52,()=>true);
    const copy=()=>{const text=term.getSelection();if(text&&api?.clipboardWrite)api.clipboardWrite({text}).catch(()=>{});return !!text;};
    const paste=()=>{if(archived||!api?.clipboardRead)return;api.clipboardRead().then(text=>{if(text)term.paste(text);}).catch(()=>{});};
    term.attachCustomKeyEventHandler(event=>{
      if(event.type!=='keydown')return true;
      const mod=isMac?event.metaKey:event.ctrlKey,key=event.key.toLowerCase();
      if(mod&&event.shiftKey&&key==='c'){copy();return false;}
      if(mod&&(key==='v')){event.preventDefault();paste();return false;}
      if(mod&&!event.shiftKey&&key==='c'&&(isMac||term.hasSelection())){copy();term.clearSelection();return false;}
      if(mod&&key==='f'&&onSearch){event.preventDefault();onSearch();return false;}
      return true;
    });
    // Native paste (the Edit menu's Ctrl+V / Cmd+V accelerator, which the keydown handler never sees, or the system
    // paste command): handled here once, with the text from the event, so the terminal never ignores or doubles it.
    element.addEventListener('paste',event=>{event.preventDefault();event.stopImmediatePropagation();if(archived)return;
      const text=event.clipboardData?.getData('text/plain');if(text)term.paste(text.slice(0,1024*1024));else paste();},true);
    // Right click: the app's menu when it has one; otherwise, and with Shift, copy the selection or paste when nothing is
    // selected (like Windows Terminal).
    element.addEventListener('contextmenu',event=>{event.preventDefault();event.stopPropagation();if(onContextMenu&&!event.shiftKey){onContextMenu(event);return;}if(!copy())paste();else term.clearSelection();});
    let last='';
    // Fit to the element, then tell the PTY only when the size really changed; extra resizes make TUIs redraw.
    function fitAndReport(report){
      if(!element.offsetWidth||!element.offsetHeight)return false;
      try{fit.fit();}catch{return false;}
      const size=`${term.cols}x${term.rows}`;if(size===last)return false;last=size;report?.(term.cols,term.rows);return true;
    }
    const setLight=value=>{term.options.theme=value?LIGHT:THEME;};
    return {term,fit,search,fitAndReport,copy,paste,setLight,resetSize:()=>{last='';}};
  }
  window.OpayaTerminal={create,THEME,LIGHT};
})();
