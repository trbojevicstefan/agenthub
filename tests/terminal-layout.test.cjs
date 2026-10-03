'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const layout=require('../ui/terminal-layout.js');
test('directional splits change only the selected leaf and collapse removed branches',()=>{
  let tree=layout.preset(['a','b']);const left=tree.first;
  tree=layout.split(tree,'b','c','below');assert.equal(tree.first,left);
  assert.deepEqual(tree.second,{axis:'y',ratio:.5,first:{id:'b'},second:{id:'c'}});
  tree=layout.split(tree,'c','d','left');assert.deepEqual(layout.leaves(tree),['a','b','d','c']);
  assert.equal(tree.second.second.axis,'x');
  tree=layout.clean(tree,new Set(['a','c']));assert.deepEqual(tree,layout.preset(['a','c']));
  assert.deepEqual(layout.split({id:'a'},'a','b','above'),{axis:'y',ratio:.5,first:{id:'b'},second:{id:'a'}});
});
test('legacy presets preserve ordering and weights; reconciling does not duplicate sessions',()=>{
  const tree=layout.preset(['a','b'],'cols',[3,1]);assert.equal(tree.ratio,.75);
  assert.deepEqual(layout.leaves(layout.reconcile(tree,['a','b','c'])),['a','b','c']);
  assert.deepEqual(layout.reconcile(tree,['a','b']),tree);
  const grid=layout.preset(['a','b','c','d'],'grid');assert.equal(grid.axis,'x');assert.equal(grid.first.axis,'y');
  assert.deepEqual(layout.leaves(grid),['a','b','c','d']);
});
test('saved layouts reject duplicate, malformed and stale leaves and bound nesting',()=>{
  const cyclic={axis:'x',ratio:10,second:{id:'b'}};cyclic.first=cyclic;
  assert.deepEqual(layout.leaves(layout.clean(cyclic)),['b']);
  assert.deepEqual(layout.clean({axis:'x',first:{id:'a'},second:{id:'a'}}),{id:'a'});
  assert.equal(layout.clean({id:'bad id'}),null);
  assert.deepEqual(layout.workspaces([{ctx:'a',tree:layout.preset(['t1','t2']),active:'stale',dock:'bad',visible:1},{ctx:'a'},null,{ctx:'bad ctx'}]),[{ctx:'a',tree:layout.preset(['t1','t2']),active:'t1',visible:true,dock:'bottom'}]);
});
test('resize respects the minimum dimensions of nested panes',()=>{
  const tree=layout.split(layout.preset(['a','b']),'b','c','below');
  assert.deepEqual(layout.minimum(tree),{width:487,height:227});
  assert.equal(layout.resize(tree,.01,1000),.24);assert.equal(layout.resize(tree,.99,1000),.76);
  assert.equal(layout.resize(tree,.9,400),.5,'an undersized workspace must scroll, not shrink panes');
});
test('directional focus follows geometry rather than session creation order',()=>{
  const rects=[{id:'a',left:0,right:400,top:0,bottom:600},{id:'b',left:407,right:800,top:0,bottom:296},{id:'c',left:407,right:800,top:303,bottom:600}];
  assert.equal(layout.neighbor(rects,'b','below'),'c');assert.equal(layout.neighbor(rects,'c','left'),'a');
  assert.equal(layout.neighbor(rects,'b','above'),'b');assert(['b','c'].includes(layout.neighbor(rects,'a','right')));
});
