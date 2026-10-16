// Opaya's feedback and error collector: a Cloudflare Worker that receives what Opaya sends (desktop/feedback.cjs) and
// files it as issues in a private GitHub repository, so every report is in one list that can be read, labelled, fixed
// and closed. Feedback becomes one issue each. Errors are grouped by fingerprint: the first one opens an issue
// "[err:<fingerprint>] ...", later ones add a comment with the count, app version and system (and reopen a closed
// issue, labelled "regression"). The GitHub token lives only here, as a Worker secret, never in the app.
//
// Settings (wrangler.toml / secrets): GITHUB_TOKEN (secret, fine-grained: Issues read/write on that repo),
// GITHUB_REPO ("owner/name"), optional KV namespace FINGERPRINTS (fingerprint -> issue number, saves a search).
const MAX_BODY=256*1024,MAX_ITEMS=20,MAX_TEXT=4000;
const KINDS=new Set(['bug','idea','praise','other']);
const clip=(v,n=MAX_TEXT)=>String(v??'').slice(0,n);
const json=(status,data)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});
const fence=t=>'```\n'+clip(t).replace(/```/g,'`​``')+'\n```';
const system=i=>`Opaya ${clip(i.app,40)||'?'} · ${clip(i.os,20)} ${clip(i.arch,20)} ${clip(i.osRelease,40)}`.trim();

export function validItem(i){
  if(!i||typeof i!=='object')return false;
  if(i.type==='feedback')return typeof i.message==='string'&&i.message.trim().length>=3;
  if(i.type==='error')return typeof i.message==='string'&&/^[0-9a-f]{16}$/.test(String(i.fingerprint||''));
  return false;
}
export function feedbackIssue(i){
  const kind=KINDS.has(i.kind)?i.kind:'other',first=clip(i.message,80).split('\n')[0];
  const body=[`**${kind}**${i.where?` in ${clip(i.where,80)}`:''} · ${system(i)}`,'',clip(i.message),'',
    i.contact?`Contact: ${clip(i.contact,200)}`:'No contact given.',
    Array.isArray(i.recentErrors)&&i.recentErrors.length?`\n<details><summary>Recent errors (${i.recentErrors.length})</summary>\n\n${i.recentErrors.slice(0,15).map(e=>`- **${clip(e.source,40)}** ${clip(e.title,200)}${e.count>1?` (×${e.count})`:''}\n${fence(e.message)}`).join('\n')}\n</details>`:'',
    `\n<sub>install ${clip(i.install,36)} · ${clip(i.at,30)}</sub>`].join('\n');
  return {title:`[${kind}] ${first}`,body,labels:['feedback',kind,`app:${clip(i.app,20)||'unknown'}`]};
}
export function errorIssue(i){
  return {title:`[err:${i.fingerprint}] ${clip(i.source,40)}: ${clip(i.title||i.message,90).split('\n')[0]}`,
    body:[`**${clip(i.source,40)}** · ${system(i)} · seen ${Number(i.count)||1}×`,'',`**${clip(i.title,200)}**`,fence(i.message),i.context?`\nContext:\n${fence(clip(i.context,2000))}`:'',
      `\n<sub>fingerprint ${i.fingerprint} · first ${clip(i.at,30)}</sub>`].join('\n'),
    labels:['error',`source:${clip(i.source,30).split(':')[0]}`,`app:${clip(i.app,20)||'unknown'}`]};
}
export function errorComment(i){return `Seen again ${Number(i.count)||1}× · ${system(i)} · ${clip(i.lastAt||i.at,30)}${i.context?`\n\n${fence(clip(i.context,1500))}`:''}\n${fence(clip(i.message,1500))}`;}

function github(env,fetchImpl){
  const base=`https://api.github.com/repos/${env.GITHUB_REPO}`;
  const call=async(url,init={})=>{
    const r=await fetchImpl(url,{...init,headers:{authorization:`Bearer ${env.GITHUB_TOKEN}`,accept:'application/vnd.github+json','user-agent':'opaya-collector','x-github-api-version':'2022-11-28',...(init.body?{'content-type':'application/json'}:{})}});
    if(!r.ok)throw new Error(`GitHub ${r.status}: ${(await r.text()).slice(0,200)}`);return r.status===204?null:r.json();
  };
  return {
    create:issue=>call(`${base}/issues`,{method:'POST',body:JSON.stringify(issue)}),
    comment:(n,body)=>call(`${base}/issues/${n}/comments`,{method:'POST',body:JSON.stringify({body})}),
    reopen:n=>call(`${base}/issues/${n}`,{method:'PATCH',body:JSON.stringify({state:'open'})}).then(()=>call(`${base}/issues/${n}/labels`,{method:'POST',body:JSON.stringify({labels:['regression']})})),
    get:n=>call(`${base}/issues/${n}`),
    find:async fp=>{const q=encodeURIComponent(`repo:${env.GITHUB_REPO} is:issue in:title "[err:${fp}]"`);const r=await call(`https://api.github.com/search/issues?q=${q}&per_page=1`);return r.items?.[0]||null;}
  };
}
export async function handle(request,env,{fetchImpl=fetch}={}){
  const url=new URL(request.url);
  if(request.method==='GET'&&url.pathname==='/')return json(200,{ok:true,service:'opaya-collector'});
  if(request.method!=='POST'||url.pathname!=='/v1/report')return json(404,{error:'not found'});
  if(!env.GITHUB_TOKEN||!/^[\w.-]+\/[\w.-]+$/.test(String(env.GITHUB_REPO||'')))return json(500,{error:'collector not configured'});
  const text=await request.text();if(text.length>MAX_BODY)return json(413,{error:'too large'});
  let data;try{data=JSON.parse(text);}catch{return json(400,{error:'bad json'});}
  const items=(Array.isArray(data?.items)?data.items:[]).slice(0,MAX_ITEMS).filter(validItem);
  if(!items.length)return json(400,{error:'no valid items'});
  const gh=github(env,fetchImpl),done=[];
  for(const i of items){
    if(i.type==='feedback'){const r=await gh.create(feedbackIssue(i));done.push({id:i.id,issue:r.number});continue;}
    let n=env.FINGERPRINTS?Number(await env.FINGERPRINTS.get(i.fingerprint))||0:0,issue=null;
    if(n){try{issue=await gh.get(n);}catch{issue=null;n=0;}}
    if(!issue){issue=await gh.find(i.fingerprint);n=issue?.number||0;}
    if(issue){await gh.comment(n,errorComment(i));if(issue.state==='closed')await gh.reopen(n);}
    else{const r=await gh.create(errorIssue(i));n=r.number;}
    if(env.FINGERPRINTS)await env.FINGERPRINTS.put(i.fingerprint,String(n));
    done.push({id:i.id,issue:n});
  }
  return json(200,{ok:true,done});
}
export default {fetch:(request,env)=>handle(request,env).catch(e=>json(502,{error:String(e?.message||e).slice(0,200)}))};
