import test from 'node:test';
import assert from 'node:assert/strict';
import {activate} from './native-activate.mjs';
import {focusExisting} from './native-focus.mjs';
import {categoryFor, buildIndex} from './grouping.mjs';

const saved='https://grafana.example.test/v10/d/UID/old-title?orgId=1&from=now-1h&to=now';
const current=saved.replace('old-title','new-title');
const payload={version:1,url:saved};
function fake() {
  const tabs=[{id:10,windowId:2,url:current,groupId:-1,lastAccessed:100},
    {id:11,windowId:2,url:current,groupId:-1,lastAccessed:200}];
  const calls=[];
  const get=id=>{const tab=tabs.find(t=>t.id===id);if(!tab)throw Error('missing');return {...tab};};
  const win={id:2,type:'normal',focused:true,state:'normal'};
  const api={tabs:{query:async()=>tabs.map(t=>({...t})),get:async id=>get(id),
    update:async(id,update)=>{calls.push(update);assert.deepEqual(update,{active:true});return {...get(id),...update};},
    create:async opts=>{const tab={id:100,...opts};tabs.push(tab);return tab;}},
    windows:{get:async()=>win,getLastFocused:async()=>win}};
  return {api,tabs,calls};
}

test('repeated bookmark activation focuses the recent equivalent tab and never creates or navigates',async()=>{
  const f=fake(),before=JSON.stringify(f.tabs);
  for(let i=0;i<4;i++) {
    const result=await activate(f.api,payload);
    assert.equal(result.kind,'focused');assert.equal(result.tabId,'11');
    assert.equal(result.matchType,'grafana-dashboard');assert.equal(result.navigationChanged,false);
  }
  assert.equal(f.calls.length,4);assert.equal(JSON.stringify(f.tabs),before);
});

test('a hinted tab survives slug redirects while stale hints resolve to an equivalent existing tab',async()=>{
  for(const id of [10,999]) {
    const f=fake(),result=await activate(f.api,{...payload,tabId:id,windowId:2});
    assert.equal(result.kind,'focused');assert.equal(result.tabId,id===10?'10':'11');
    assert.equal(result.matchType,'grafana-dashboard');assert.equal(f.tabs.length,2);
  }
});

test('pending URLs prevent duplicate opening while stale committed dashboard URLs do not match',async()=>{
  const f=fake();f.tabs.splice(1);f.tabs[0].pendingUrl=current;f.tabs[0].url='about:blank';
  assert.equal((await activate(f.api,payload)).kind,'focused');assert.equal(f.tabs.length,1);
  f.tabs[0].url=current;f.tabs[0].pendingUrl=current.replace('orgId=1','orgId=2');
  assert.equal((await focusExisting(f.api,payload)).reason,'no_matching_tab');
});

test('view changes during lookup and incognito tabs are rejected before selecting',async()=>{
  for(const change of [t=>{t.url=current.replace('now-1h','now-2h');},t=>{t.incognito=true;}]) {
    const f=fake();f.api.tabs.query=async()=>{const result=f.tabs.map(t=>({...t}));f.tabs.forEach(change);return result;};
    const result=await focusExisting(f.api,payload);
    assert.equal(result.kind,'miss');assert.equal(f.calls.length,0);
  }
});

test('explicit force-new still creates the exact saved URL',async()=>{
  const f=fake(),result=await activate(f.api,{...payload,forceNew:true});
  assert.equal(result.kind,'opened');assert.equal(f.tabs.length,3);
  assert.equal(f.tabs[2].url,saved);assert.equal(f.calls.length,0);
});

function folders(personal=[]) {
  return [{children:[{children:[{title:'Work',children:[{url:saved}]},
    {title:'Personal',children:personal}]}]}];
}
test('a redirected dashboard inherits its folder only for the same view',()=>{
  const index=buildIndex(folders());
  assert.equal(categoryFor({url:current},index),'work');
  assert.equal(categoryFor({url:'about:blank',pendingUrl:current},index),'work');
  for(const url of [current.replace('now-1h','now-2h'),current.replace('orgId=1','orgId=2'),current+'&var-region=eu']) {
    assert.equal(categoryFor({url},index),null);
  }
});
test('equivalent bookmarks in Work and Personal remain ambiguous even for an exact match',()=>{
  const index=buildIndex(folders([{url:current}]));
  assert.equal(categoryFor({url:current},index),null);
  assert.equal(categoryFor({url:saved},index),null);
});
