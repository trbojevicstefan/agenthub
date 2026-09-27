'use strict';
// Shared xterm setup for the docked terminal panel and popped-out terminal windows.
// - Windows: ConPTY mode, so xterm and ConPTY do not both rewrap lines (the cause of duplicated TUI status lines).
// - Unicode 11 widths, so emoji and symbols in agent TUIs take the same cells the program expects.
// - WebGL rendering when available (crisp box drawing, fast output), DOM rendering otherwise and after a lost GPU context.
// - Clipboard: Ctrl+C copies a selection (otherwise it interrupts), Ctrl+V / Ctrl+Shift+V paste, Ctrl+Shift+C copies.
// - Ctrl/Cmd+click opens http(s) links. Ctrl+F searches the scrollback. Ctrl/Cmd + = / - / 0 zooms the text.
// - Programs that use the mouse (Claude Code, Codex, htop) get the clicks; Shift+drag (Option+drag on a Mac) selects.
// - Dropping files types their paths, quoted.
// - AltGr (Ctrl+Alt on Windows) and Option on a Mac type what the keyboard layout gives them (@ \ [ ] { } | ~).
// - An ended session keeps its output; Enter asks the app to start it again (onRestart).
(()=>{
  const THEME={background:'#111315',foreground:'#d9dde0',cursor:'#a7f3c6',cursorAccent:'#111315',selectionBackground:'#3c4f4680',
    black:'#1b1f22',red:'#f28b82',green:'#8fd9a8',yellow:'#e6c77a',blue:'#8ab4f8',magenta:'#d7aefb',cyan:'#78d9ec',white:'#d9dde0',
    brightBlack:'#5f6b70',brightRed:'#ffaba3',brightGreen:'#b5f5cf',brightYellow:'#f5dc9b',brightBlue:'#aecbfa',brightMagenta:'#e9c8ff',brightCyan:'#a1e9f5',brightWhite:'#ffffff'};
  const LIGHT={...THEME,background:'#fbfcfa',foreground:'#1d2a23',cursor:'#1f7a45',cursorAccent:'#fbfcfa',selectionBackground:'#b9dcc680',
    black:'#1d2a23',red:'#c0392b',green:'#1f7a45',yellow:'#9a6a10',blue:'#2458b8',magenta:'#8a3fb3',cyan:'#137c8b',white:'#6b7a70',
    brightBlack:'#56695d',brightRed:'#d9534a',brightGreen:'#2b9a5a',brightYellow:'#b58318',brightBlue:'#3a6fd0',brightMagenta:'#a257c9',brightCyan:'#1a93a4',brightWhite:'#1d2a23'};
  const isMac=/Mac/.test(navigator.platform),isWindows=/Win/.test(navigator.platform);
  // Text size: the app keeps it with the saved view and passes it in (fontSize), so every terminal and window agree.
  const FONT=13,fontOf=n=>Number.isInteger(n)&&n>=8&&n<=28?n:FONT;
  const quotePath=p=>/^[\w@%+=:,./\\-]+$/.test(p)?p:isWindows?`"${p}"`:`'${p.replace(/'/g,`'\\''`)}'`;
  // Chromium keeps at most 16 WebGL contexts per window and drops the oldest past that; terminals stay well below it.
  const WEBGL_MAX=12,webglTerms=new Set();
  // Input goes to the session service in pieces it accepts (65536 characters at most per write), in order, never
  // splitting a character in two. A large paste used to be refused whole.
  function chunks(data,size=16384){const out=[];for(let i=0;i<data.length;){let end=Math.min(data.length,i+size);const c=data.charCodeAt(end-1);if(end<data.length&&c>=0xd800&&c<=0xdbff)end--;out.push(data.slice(i,end));i=end;}return out;}
  // The gray line under an ended session (exitCode undefined: saved output from before Opaya restarted): it takes no
  // typing, and Enter gets a prompt back (onRestart). Install and diagnostic terminals come back as a plain shell.
  function endedNote({remote=false,agentId=''}={},exitCode){
    const how=String(agentId).startsWith('svc_')?'Press Enter for a new shell here.':remote?'Press Enter to connect again.':'Press Enter to start it again.';
    return `\r\n\x1b[90m[${exitCode===undefined?'Saved output from an ended session':exitCode==='detached'?'Session detached':`Session ended: ${exitCode}`}. ${how}]\x1b[0m\r\n`;
  }
  function create(element,{archived=false,windowsBuild=0,light=false,api=window.agenthub,onSearch,onContextMenu,onZoom,onRestart,fontSize=FONT}={}){
    const options={cursorBlink:!archived,disableStdin:archived,allowProposedApi:true,
      fontFamily:'"Cascadia Mono", "Cascadia Code", "SF Mono", "SFMono-Regular", Menlo, Consolas, "DejaVu Sans Mono", monospace',
      fontSize:fontOf(fontSize),lineHeight:1.12,letterSpacing:0,scrollback:10000,smoothScrollDuration:0,minimumContrastRatio:1,
      macOptionIsMeta:true,macOptionClickForcesSelection:true,rightClickSelectsWord:false,drawBoldTextInBrightColors:false,fontWeightBold:'600',theme:light?LIGHT:THEME};
    if(windowsBuild)options.windowsPty={backend:'conpty',buildNumber:windowsBuild};
    const term=new window.Terminal(options);
    const fit=new window.FitAddon.FitAddon();term.loadAddon(fit);
    if(window.Unicode11Addon){term.loadAddon(new window.Unicode11Addon.Unicode11Addon());term.unicode.activeVersion='11';}
    const search=window.SearchAddon?new window.SearchAddon.SearchAddon():null;if(search)term.loadAddon(search);
    if(window.WebLinksAddon&&api?.openLink)term.loadAddon(new window.WebLinksAddon.WebLinksAddon((event,uri)=>{if(event.ctrlKey||event.metaKey)api.openLink({url:uri}).catch(()=>{});}));
    term.open(element);
    // The rows rarely fill the element exactly; the space below the last row takes the theme's background.
    const paint=()=>{element.style.backgroundColor=term.options.theme.background;};paint();
    // WebGL needs the element in the page. Its GPU context can be lost: sleep/wake or a GPU process restart loses every one,
    // and Chromium drops the oldest when a window holds too many. xterm would wait for the context to come back, but a
    // restored context draws no text (the glyphs it had cached are gone), so output stopped showing and typing seemed to do
    // nothing. On a loss the terminal draws with the DOM at once, then gets a fresh WebGL renderer a little later.
    let gl=null,glContext=null,glTimer=0,glLost=0,disposed=false;
    function webgl(){
      clearTimeout(glTimer);if(gl||disposed||!window.WebglAddon||glLost>3||webglTerms.size>=WEBGL_MAX)return;
      try{gl=new window.WebglAddon.WebglAddon();term.loadAddon(gl);webglTerms.add(term);glContext=[...element.querySelectorAll('.xterm-screen canvas:not(.xterm-link-layer)')].map(c=>c.getContext('webgl2')).find(Boolean)||null;}
      catch{try{gl?.dispose();}catch{}gl=null;if(glLost)glTimer=setTimeout(webgl,10000);}
    }
    // Capture phase: this runs before xterm's own listener on the canvas, which would keep waiting for a restore.
    element.addEventListener('webglcontextlost',()=>{if(!gl)return;const old=gl;gl=glContext=null;webglTerms.delete(term);glLost++;try{old.dispose();}catch{}glTimer=setTimeout(webgl,glLost===1?1500:10000);},true);
    webgl();
    // OSC 52 (programs writing to the clipboard) stays blocked.
    term.parser.registerOscHandler(52,()=>true);
    // The last selection, kept for a short while: programs that redraw (spinners, status lines) can clear the selection
    // between the right click and choosing Copy.
    let kept={text:'',at:0};term.onSelectionChange(()=>{const text=term.getSelection();if(text)kept={text,at:Date.now()};});
    const selection=()=>term.getSelection()||(Date.now()-kept.at<15000?kept.text:'');
    const copy=(text=selection())=>{if(text&&api?.clipboardWrite)api.clipboardWrite({text}).catch(()=>{});return !!text;};
    const paste=()=>{if(term.options.disableStdin||!api?.clipboardRead)return;api.clipboardRead().then(text=>{if(text)term.paste(text.slice(0,1024*1024));}).catch(()=>{});};
    term.attachCustomKeyEventHandler(event=>{
      if(event.type!=='keydown')return true;
      // AltGr is Ctrl+Alt on Windows: it types characters on many layouts (@ \ { }), never a shortcut.
      const mod=(isMac?event.metaKey:event.ctrlKey)&&!event.altKey,key=event.key.toLowerCase();
      // An ended session takes no typing (its output stays selectable); Enter asks the app to start it again.
      if(onRestart&&term.options.disableStdin&&event.key==='Enter'&&!mod&&!event.altKey&&!event.shiftKey&&!event.isComposing){event.preventDefault();onRestart();return false;}
      if(mod&&event.shiftKey&&key==='c'){copy();return false;}
      if(mod&&(key==='v')){event.preventDefault();paste();return false;}
      if(mod&&!event.shiftKey&&key==='c'&&(isMac||term.hasSelection())){copy();term.clearSelection();return false;}
      if(mod&&key==='f'&&onSearch){event.preventDefault();onSearch();return false;}
      if(mod&&['=','+','-','0'].includes(event.key)){event.preventDefault();zoom(event.key==='0'?0:event.key==='-'?-1:1);return false;}
      // macOS: Option is Meta for terminal programs (Option+Enter, Option+B/F), but layouts that type @ [ ] { } | \ ~ with
      // Option (German, Serbian, French...) sent Esc+letter instead. An ASCII character other than the key's own is text.
      if(isMac&&event.altKey&&!event.ctrlKey&&!event.metaKey&&/^[\x21-\x7e]$/.test(event.key)&&key!==(/^(?:Key|Digit)(.)$/.exec(event.code)?.[1]||'').toLowerCase()){event.preventDefault();term.input(event.key);return false;}
      return true;
    });
    // Native paste (the Edit menu's Ctrl+V / Cmd+V accelerator, which the keydown handler never sees, or the system
    // paste command): handled here once, with the text from the event, so the terminal never ignores or doubles it.
    element.addEventListener('paste',event=>{event.preventDefault();event.stopImmediatePropagation();if(term.options.disableStdin)return;
      const text=event.clipboardData?.getData('text/plain');if(text)term.paste(text.slice(0,1024*1024));else paste();},true);
    // A click beside the rows (the element's padding, the strip under the last row) still means "type here".
    element.addEventListener('mousedown',event=>{if(event.button===0&&!event.target.closest('.xterm')){event.preventDefault();term.focus();}});
    // Dropped files: their paths, quoted for the shell.
    element.addEventListener('dragover',event=>{if(event.dataTransfer?.types?.includes('Files')){event.preventDefault();event.dataTransfer.dropEffect='copy';}});
    element.addEventListener('drop',event=>{const files=[...(event.dataTransfer?.files||[])];if(!files.length)return;event.preventDefault();event.stopPropagation();if(term.options.disableStdin)return;
      const paths=files.map(f=>{try{return api?.pathForFile?.(f)||'';}catch{return '';}}).filter(Boolean);if(paths.length){term.paste(paths.map(quotePath).join(' ')+' ');term.focus();}});
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
    const setLight=value=>{term.options.theme=value?LIGHT:THEME;paint();};
    // Text size, shared by every terminal: 0 resets.
    function zoom(step){const size=step?Math.max(8,Math.min(28,term.options.fontSize+step)):FONT;setFont(size);onZoom?.(size);}
    function setFont(size){if(term.options.fontSize===size)return;term.options.fontSize=size;last='';}
    // Typing on or off: off for an ended session and for the docked copy of a popped-out one.
    const setLive=live=>{term.options.disableStdin=!live;term.options.cursorBlink=live;};
    // Closing: the WebGL context is released now, not whenever garbage collection gets to it.
    function dispose(){disposed=true;clearTimeout(glTimer);webglTerms.delete(term);const context=glContext;gl=glContext=null;term.dispose();try{context?.getExtension('WEBGL_lose_context')?.loseContext();}catch{}}
    return {term,fit,search,fitAndReport,copy,paste,selection,setLight,setFont,setLive,dispose,webgl:()=>!!gl,resetSize:()=>{last='';}};
  }
  window.OpayaTerminal={create,chunks,endedNote,THEME,LIGHT};
})();
