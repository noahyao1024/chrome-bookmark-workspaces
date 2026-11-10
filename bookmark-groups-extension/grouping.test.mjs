import test from 'node:test';
import assert from 'node:assert/strict';
import {buildIndex, categoryFor, createOrganizer} from './grouping.mjs';
const url='https://example.test/metrics?region=us-east-1&psm=feed';
const tree=[{children:[{id:'1',children:[{title:'Work',children:[{title:'Duty',children:[{title:'alias',url}]}]},{title:'Personal',children:[{url:'https://personal.test/'}]}]}]}];
function fake(tabs) {
  let nextGroup=100;
  const groups=[];const created=[];
  return {groups,created,api:{
    tabs:{get:async id=>{const t=tabs.find(t=>t.id===id);if(!t)throw Error('closed');return {...t};},
      group:async opts=>{const groupId=opts.groupId??nextGroup++;if(opts.groupId===undefined){groups.push({id:groupId,windowId:opts.createProperties.windowId,title:''});created.push(groupId);}for(const id of opts.tabIds)tabs.find(t=>t.id===id).groupId=groupId;return groupId;}},
    tabGroups:{query:async opts=>groups.filter(g=>opts.windowId===undefined||g.windowId===opts.windowId),update:async(id,props)=>Object.assign(groups.find(g=>g.id===id),props)}
  }};
}
test('nested bookmarks inherit the top-level category and preserve exact URLs',()=>{
  const index=buildIndex(tree);assert.equal(categoryFor({url},index),'work');
  assert.equal(categoryFor({url:url.replace('us-east-1','eu-central-1')},index),null);
  assert.equal(categoryFor({pendingUrl:url,url:'chrome://newtab/'},index),'work');
});
test('ambiguous cross-folder bookmarks are left alone',()=>{
  const other=structuredClone(tree);other[0].children[0].children[1].children.push({url});
  assert.equal(categoryFor({url},buildIndex(other)),null);
});
test('simultaneous tabs reuse one Work group, and subsequent requests are idempotent',async()=>{
  const tabs=[1,2,3].map(id=>({id,windowId:1,url,groupId:-1,active:id===1}));const f=fake(tabs);
  f.groups.push({id:77,windowId:1,title:'Work',color:'blue'});
  const manager=createOrganizer(f.api,async()=>buildIndex(tree));
  await Promise.all(tabs.map(t=>manager.organize(t.id)));
  assert.equal(f.created.length,0);assert.equal(f.groups[0].title,'Work');
  assert.equal(new Set(tabs.map(t=>t.groupId)).size,1);
  assert.equal(tabs[0].groupId,77);
  assert.equal((await manager.organize(1)).status,'preserved');
});
test('pinned tabs, manually grouped tabs and incognito tabs are preserved',async()=>{
  const tabs=[{id:1,pinned:true,groupId:-1},{id:2,groupId:7},{id:3,incognito:true,groupId:-1}].map(t=>({...t,url,windowId:1}));
  const f=fake(tabs),manager=createOrganizer(f.api,async()=>buildIndex(tree));
  assert.deepEqual(await Promise.all(tabs.map(t=>manager.organize(t.id))),tabs.map(()=>({status:'preserved'})));
  assert.equal(f.created.length,0);
});
test('groups are reused only in the same window; Personal uses its own group',async()=>{
  const tabs=[{id:1,windowId:1,url},{id:2,windowId:2,url},{id:3,windowId:1,url:'https://personal.test/'}].map(t=>({...t,groupId:-1}));
  const f=fake(tabs),manager=createOrganizer(f.api,async()=>buildIndex(tree));
  f.groups.push({id:81,windowId:1,title:'Work'},{id:82,windowId:2,title:'Work'},{id:83,windowId:1,title:'Personal',color:'green'});
  await Promise.all(tabs.map(t=>manager.organize(t.id)));
  assert.equal(f.groups.length,3);assert.equal(f.groups.filter(g=>g.title==='Work').length,2);
  assert.ok(f.groups.some(g=>g.title==='Personal'&&g.color==='green'));
  assert.equal(f.created.length,0);
});
test('a group in another window is not duplicated or moved',async()=>{
  const tabs=[{id:1,windowId:1,url,groupId:-1}];const f=fake(tabs);
  f.groups.push({id:88,windowId:2,title:'Work'});
  const manager=createOrganizer(f.api,async()=>buildIndex(tree));
  assert.equal((await manager.organize(1)).status,'group-in-other-window');
  assert.equal(tabs[0].groupId,-1);assert.equal(f.created.length,0);
  f.groups.push({id:89,windowId:1,title:'Work'});
  assert.equal((await manager.organize(1)).groupId,89);
});
test('a missing Work group is created once for simultaneous eligible tabs',async()=>{
  const tabs=[1,2,3].map(id=>({id,windowId:1,url,groupId:-1}));const f=fake(tabs);
  const manager=createOrganizer(f.api,async()=>buildIndex(tree));
  await Promise.all(tabs.map(tab=>manager.organize(tab.id)));
  assert.equal(f.created.length,1);assert.equal(f.groups[0].title,'Work');assert.equal(f.groups[0].color,'blue');
  assert.equal(new Set(tabs.map(tab=>tab.groupId)).size,1);
});
test('simultaneous different-window requests create at most one group per category',async()=>{
  const tabs=[1,2].map(id=>({id,windowId:id,url,groupId:-1}));const f=fake(tabs);
  const manager=createOrganizer(f.api,async()=>buildIndex(tree));
  const results=await Promise.all(tabs.map(tab=>manager.organize(tab.id)));
  assert.equal(f.created.length,1);assert.ok(results.some(r=>r.status==='group-in-other-window'));
});
test('configured app navigation inherits folders while unrelated regions and workspaces remain distinct',()=>{
  const entry={id:'entry',url:'https://example.test/team/issues',scope:{origin:'https://example.test',pathPrefix:'/team/',queryKeys:['issue']}};
  const index=buildIndex(tree);
  index.set(entry.url,new Set(['work']));
  assert.equal(categoryFor({url:'https://example.test/team/issues/ONE'},index,[entry]),'work');
  assert.equal(categoryFor({url:'https://example.test/other/issues/ONE'},index,[entry]),null);
  assert.equal(categoryFor({url,pendingUrl:'https://other.test/'},index,[entry]),null);
  index.set('https://mail.google.com/mail/u/0/#inbox',new Set(['personal']));
  assert.equal(categoryFor({url:'https://mail.google.com/mail/u/0/#inbox/message'},index),'personal');
  assert.equal(categoryFor({url:'https://mail.google.com/mail/u/1/#inbox/message'},index),null);
});
test('tabs moved while groups are queried are never moved back automatically',async()=>{
  const tabs=[{id:1,windowId:1,url,groupId:-1}],f=fake(tabs);
  f.api.tabGroups.query=async()=>{tabs[0].windowId=2;return [];};
  assert.equal((await createOrganizer(f.api,async()=>buildIndex(tree)).organize(1)).status,'moved');
  assert.equal(f.created.length,0);
});
test('collapsed groups with extra whitespace or invisible characters are reused without recoloring',async()=>{
  const tabs=[{id:1,windowId:1,url,groupId:-1,active:true}];const f=fake(tabs);
  f.groups.push({id:90,windowId:1,title:' \u200bＷｏｒｋ ',color:'red',collapsed:true});
  const manager=createOrganizer(f.api,async()=>buildIndex(tree));
  assert.equal((await manager.organize(1)).groupId,90);
  assert.equal(f.groups[0].color,'red');assert.equal(f.groups[0].collapsed,false);
  assert.equal(f.created.length,0);
});
