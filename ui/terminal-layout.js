/* Shared terminal layout operations. No DOM or session side effects. */
'use strict';
(() => {
  const validId=id=>typeof id==='string'&&/^[\w-]{1,80}$/.test(id);
  const leaves=tree=>!tree?[]:tree.id?[tree.id]:[...leaves(tree.first),...leaves(tree.second)];
  const branch=(axis,ratio,first,second)=>!first?second:!second?first:{axis,ratio,first,second};
  function clean(tree,allowed=null){
    const seen=new Set();let count=0;
    function visit(node,depth){
      if(!node||typeof node!=='object'||depth>60||++count>125)return null;
      if(validId(node.id)){
        if(seen.has(node.id)||allowed&&!allowed.has(node.id))return null;
        seen.add(node.id);return {id:node.id};
      }
      if(!['x','y'].includes(node.axis))return null;
      const ratio=Number.isFinite(node.ratio)?Math.max(.05,Math.min(.95,node.ratio)):.5;
      return branch(node.axis,ratio,visit(node.first,depth+1),visit(node.second,depth+1));
    }
    return visit(tree,0);
  }
  function split(tree,target,id,direction='right'){
    if(!tree)return {id};
    if(tree.id){
      if(tree.id!==target)return tree;
      const axis=['left','right'].includes(direction)?'x':'y',before=['left','above'].includes(direction);
      return branch(axis,.5,before?{id}:tree,before?tree:{id});
    }
    return {...tree,first:split(tree.first,target,id,direction),second:split(tree.second,target,id,direction)};
  }
  function preset(ids,arrange='cols',sizes=[]){
    if(!ids.length)return null;
    if(ids.length===1)return {id:ids[0]};
    const at=arrange==='grid'?Math.ceil(ids.length/2):1;
    const weights=ids.map((_,i)=>Number(sizes[i])>0?Number(sizes[i]):1);
    const ratio=weights.slice(0,at).reduce((a,b)=>a+b,0)/weights.reduce((a,b)=>a+b,0);
    return branch(arrange==='rows'?'y':'x',ratio,preset(ids.slice(0,at),arrange==='grid'?'rows':arrange,weights.slice(0,at)),preset(ids.slice(at),arrange==='grid'?'rows':arrange,weights.slice(at)));
  }
  function reconcile(tree,ids){
    let next=clean(tree,new Set(ids));
    const present=new Set(leaves(next));
    for(const id of ids)if(!present.has(id))next=next?branch('x',.5,next,{id}):{id};
    return next;
  }
  function at(tree,path){for(const part of path){tree=tree?.[part==='0'?'first':'second'];}return tree;}
  function minimum(tree){
    if(!tree||tree.id)return {width:240,height:110};
    const a=minimum(tree.first),b=minimum(tree.second);
    return tree.axis==='x'?{width:a.width+b.width+7,height:Math.max(a.height,b.height)}:{width:Math.max(a.width,b.width),height:a.height+b.height+7};
  }
  function resize(node,ratio,pixels){
    const dimension=node.axis==='x'?'width':'height';
    const low=minimum(node.first)[dimension]/pixels,high=1-minimum(node.second)[dimension]/pixels;
    return low<=high?Math.max(low,Math.min(high,ratio)):node.ratio;
  }
  // Bounds come from the rendered panes, so directional movement follows their visible geometry.
  function neighbor(rects,id,direction){
    const current=rects.find(r=>r.id===id);if(!current)return id;
    const horizontal=['left','right'].includes(direction),sign=['left','above'].includes(direction)?-1:1;
    const center=r=>horizontal?(r.left+r.right)/2:(r.top+r.bottom)/2;
    const cross=r=>horizontal?(r.top+r.bottom)/2:(r.left+r.right)/2;
    return rects.filter(r=>r.id!==id&&(center(r)-center(current))*sign>1)
      .sort((a,b)=>score(a)-score(b))[0]?.id||id;
    function score(r){return Math.abs(center(r)-center(current))+2*Math.abs(cross(r)-cross(current));}
  }
  function workspaces(input){
    if(!Array.isArray(input))return [];
    const seen=new Set(),result=[];
    for(const w of input.slice(0,101)){
      if(!w||typeof w.ctx!=='string'||w.ctx&&!validId(w.ctx)||seen.has(w.ctx))continue;
      seen.add(w.ctx);
      const tree=clean(w.tree),ids=leaves(tree);
      result.push({ctx:w.ctx,tree,active:ids.includes(w.active)?w.active:ids[0]||'',visible:!!w.visible,dock:w.dock==='right'?'right':'bottom'});
    }
    return result;
  }
  const api={leaves,clean,split,preset,reconcile,at,minimum,resize,neighbor,workspaces};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  else window.OpayaTerminalLayout=api;
})();
