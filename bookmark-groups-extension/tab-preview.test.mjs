import test from 'node:test';
import assert from 'node:assert/strict';
import {recentTabs,focusPreview} from './tab-preview.mjs';

function fixture() {
  const win={id:10,focused:true,type:'normal',incognito:false};
  const tabs=[{id:1,windowId:10,index:0,active:true,url:'https://example.test/one',lastAccessed:300},
    {id:2,windowId:10,index:1,active:false,url:'https://example.test/two',lastAccessed:100,groupId:8},
    {id:3,windowId:10,index:2,active:false,url:'https://example.test/three',lastAccessed:200}];
  const calls=[];
  const api={windows:{getLastFocused:async()=>({...win}),get:async()=>({...win})},
    tabs:{query:async q=>tabs.filter(t=>t.windowId===q.windowId && (!q.active || t.active)).map(t=>({...t})),
      get:async id=>{const t=tabs.find(t=>t.id===id);if(!t)throw Error('closed');return {...t};},
      update:async(id,p)=>{calls.push({id,p});const t=tabs.find(t=>t.id===id);return {...t,...p};}},
    tabGroups:{get:async()=>({id:8,collapsed:true}),update:async(id,p)=>{calls.push({group:id,p});}}};
  return {api,win,tabs,calls};
}
const payload={version:1,tabId:2,windowId:10,originTabId:1,url:'https://example.test/two'};
test('preview snapshot lists active then MRU without activating any page',async()=>{
  const f=fixture(),r=await recentTabs(f.api);
  assert.equal(r.kind,'recent_tabs');assert.deepEqual(r.tabs.map(t=>t.id),[1,3,2]);assert.deepEqual(f.calls,[]);
});
test('preview only reads the focused normal profile window and excludes private tabs',async()=>{
  for(const mutation of [w=>{w.focused=false;},w=>{w.incognito=true;},w=>{w.type='popup';}]) {
    const f=fixture();mutation(f.win);assert.equal((await recentTabs(f.api)).kind,'miss');
  }
  const f=fixture();f.tabs[1].incognito=true;assert.deepEqual((await recentTabs(f.api)).tabs.map(t=>t.id),[1,3]);
});
test('preview uses pending URLs and stops when focus changes during a snapshot',async()=>{
  const f=fixture();f.tabs[1].pendingUrl='https://example.test/loading';
  const row=(await recentTabs(f.api)).tabs.find(t=>t.id===2);assert.equal(row.url,f.tabs[1].pendingUrl);assert.equal(row.loading,true);
  f.api.windows.get=async()=>({...f.win,focused:false});assert.equal((await recentTabs(f.api)).kind,'miss');
});
test('release selects only the requested existing tab and expands its group',async()=>{
  const f=fixture(),r=await focusPreview(f.api,payload);
  assert.equal(r.kind,'focused');assert.equal(r.tabId,'2');assert.equal(r.matchType,'preview');
  assert.deepEqual(f.calls,[{id:2,p:{active:true}},{group:8,p:{collapsed:false}}]);
});
test('closing, moving, navigating or changing the origin tab cancels without opening',async()=>{
  for(const change of [f=>f.tabs.splice(1,1),f=>{f.tabs[1].windowId=11;},f=>{f.tabs[1].url+='?other';},
    f=>{f.tabs[1].incognito=true;},f=>{f.tabs[0].active=false;f.tabs[2].active=true;},f=>{f.win.focused=false;}]) {
    const f=fixture();change(f);const r=await focusPreview(f.api,payload);assert.equal(r.kind,'failed');assert.equal(r.allowFallback,false);assert.deepEqual(f.calls,[]);
  }
});
test('expiry and invalid or force-new requests never mutate the browser',async()=>{
  for(const value of [{...payload,forceNew:true},{...payload,windowId:-1},{...payload,tabId:'2'},{...payload,entryId:'workspace'}]) {
    const f=fixture();assert.equal((await focusPreview(f.api,value)).kind,'failed');assert.deepEqual(f.calls,[]);
  }
  const f=fixture();assert.equal((await focusPreview(f.api,payload,{expiresAt:Date.now()-1})).reason,'expired');assert.deepEqual(f.calls,[]);
});
