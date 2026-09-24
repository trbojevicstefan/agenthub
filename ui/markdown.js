'use strict';
// Rich agent messages: a small, safe Markdown renderer. Text is escaped first; only http(s) links and images become
// elements, and links open in Opaya's browser pane. Supports headings, lists (nested, numbered, task), tables, quotes,
// rules, fenced code with Copy (and Preview for HTML/SVG), bold, italic, strike, inline code and bare URLs.
(()=>{
  const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const safeUrl=u=>{try{const x=new URL(u);return ['http:','https:','mailto:'].includes(x.protocol)?x.toString():'';}catch{return '';}};
  // Inline markup on raw text. Code spans and URLs are cut out first so nothing inside them is reformatted.
  function inline(raw){
    const slots=[];const keep=html=>`\u0000${slots.push(html)-1}\u0000`;
    let t=String(raw);
    t=t.replace(/`([^`\n]+)`/g,(_,c)=>keep(`<code>${esc(c)}</code>`));
    t=t.replace(/!\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,(m,alt,url)=>{const u=safeUrl(url);return u&&!u.startsWith('mailto:')?keep(`<a href="#" class="md-image" data-action="open-link" data-url="${esc(u)}" title="${esc(alt||u)}"><img src="${esc(u)}" alt="${esc(alt)}" loading="lazy" referrerpolicy="no-referrer"></a>`):keep(esc(m));});
    t=t.replace(/\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,(m,label,url)=>{const u=safeUrl(url);return u?keep(`<a href="#" data-action="open-link" data-url="${esc(u)}" title="${esc(u)}">${inlineText(label)}</a>`):keep(esc(m));});
    t=t.replace(/\bhttps?:\/\/[^\s<>()"'`*]+[^\s<>()"'`*.,;:!?]/g,url=>{const u=safeUrl(url);return u?keep(`<a href="#" data-action="open-link" data-url="${esc(u)}">${esc(url)}</a>`):url;});
    return restore(inlineText(t),slots);
  }
  function inlineText(t){
    return esc(t).replace(/\u0000/g,'\u0000')
      .replace(/\*\*([^*\n]+)\*\*/g,'<strong>$1</strong>').replace(/__([^_\n]+)__/g,'<strong>$1</strong>')
      .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g,'$1<em>$2</em>').replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g,'$1<em>$2</em>')
      .replace(/~~([^~\n]+)~~/g,'<del>$1</del>');
  }
  const restore=(html,slots)=>html.replace(/\u0000(\d+)\u0000/g,(_,i)=>slots[Number(i)]??'');
  function codeBlock(lang,code){
    const l=String(lang||'').trim().split(/\s+/)[0].slice(0,24),preview=/^(html|svg|xml)$/i.test(l);
    return `<div class="code-block"><div class="code-head"><span>${esc(l||'code')}</span><span class="code-actions">${preview?'<button type="button" class="text-button" data-action="md-preview">Preview</button>':''}<button type="button" class="text-button" data-action="md-copy">Copy</button></span></div><pre><code>${esc(code.replace(/\n$/,''))}</code></pre></div>`;
  }
  const isTableSep=l=>/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
  const cells=l=>l.trim().replace(/^\||\|$/g,'').split(/(?<!\\)\|/).map(c=>c.trim().replace(/\\\|/g,'|'));
  function list(lines,start){
    // Collect consecutive list items (and their indented continuation lines) into nested lists.
    const items=[];let i=start;
    const re=/^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
    while(i<lines.length){
      const m=re.exec(lines[i]);
      if(m){items.push({indent:m[1].replace(/\t/g,'  ').length,ordered:/\d/.test(m[2]),start:parseInt(m[2],10)||1,text:m[3]});i++;continue;}
      if(lines[i].trim()&&/^\s{2,}/.test(lines[i])&&items.length){items[items.length-1].text+='\n'+lines[i].trim();i++;continue;}
      break;
    }
    const build=(from,indent)=>{
      let html='',k=from;const ordered=items[from].ordered;
      html+=ordered?`<ol${items[from].start>1?` start="${items[from].start}"`:''}>`:'<ul>';
      while(k<items.length&&items[k].indent>=indent){
        if(items[k].indent>indent){const [sub,next]=build(k,items[k].indent);html=html.replace(/<\/li>$/,sub+'</li>');k=next;continue;}
        const task=/^\[( |x|X)\]\s+(.*)$/s.exec(items[k].text);
        html+=task?`<li class="task"><span class="task-box ${task[1]===' '?'':'done'}" aria-hidden="true"></span>${inline(task[2]).replace(/\n/g,'<br>')}</li>`:`<li>${inline(items[k].text).replace(/\n/g,'<br>')}</li>`;k++;
      }
      return [html+(ordered?'</ol>':'</ul>'),k];
    };
    return [build(0,items[0].indent)[0],i];
  }
  function render(text){
    const lines=String(text||'').replace(/\r\n?/g,'\n').split('\n');let out='',i=0,para=[];
    const flush=()=>{if(para.length){out+=`<p>${inline(para.join('\n')).replace(/\n/g,'<br>')}</p>`;para=[];}};
    while(i<lines.length){
      const line=lines[i];
      const fence=/^\s*(```+|~~~+)\s*([^`]*)$/.exec(line);
      if(fence){flush();const close=fence[1];const body=[];i++;while(i<lines.length&&!lines[i].trim().startsWith(close))body.push(lines[i++]);i++;out+=codeBlock(fence[2],body.join('\n')+'\n');continue;}
      if(!line.trim()){flush();i++;continue;}
      const h=/^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if(h){flush();const n=Math.min(6,h[1].length+1);out+=`<h${n}>${inline(h[2])}</h${n}>`;i++;continue;}
      if(/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)){flush();out+='<hr>';i++;continue;}
      if(/^\s*>/.test(line)){flush();const q=[];while(i<lines.length&&/^\s*>/.test(lines[i]))q.push(lines[i++].replace(/^\s*>\s?/,''));out+=`<blockquote>${render(q.join('\n'))}</blockquote>`;continue;}
      if(line.includes('|')&&i+1<lines.length&&isTableSep(lines[i+1])){
        flush();const head=cells(line),align=cells(lines[i+1]).map(c=>c.startsWith(':')&&c.endsWith(':')?'center':c.endsWith(':')?'right':'');i+=2;const rows=[];
        while(i<lines.length&&lines[i].includes('|')&&lines[i].trim())rows.push(cells(lines[i++]));
        const cell=(tag,c,k)=>`<${tag}${align[k]?` style="text-align:${align[k]}"`:''}>${inline(c)}</${tag}>`;
        out+=`<div class="md-table"><table><thead><tr>${head.map((c,k)=>cell('th',c,k)).join('')}</tr></thead><tbody>${rows.map(r=>`<tr>${head.map((_,k)=>cell('td',r[k]||'',k)).join('')}</tr>`).join('')}</tbody></table></div>`;continue;
      }
      if(/^\s*([-*+]|\d{1,9}[.)])\s+/.test(line)){flush();const [html,next]=list(lines,i);out+=html;i=next;continue;}
      para.push(line);i++;
    }
    flush();return out;
  }
  window.OpayaMarkdown={render,escape:esc,safeUrl};
})();
