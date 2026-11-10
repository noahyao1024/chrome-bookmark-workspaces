import test from 'node:test';
import assert from 'node:assert/strict';
import {activate} from './native-activate.mjs';
import {createEntryReuse} from './entry-reuse.mjs';

const url='https://example.test/view?region=EU#panel';
function fixture() {
  const tabs=[],calls=[];
  const win={id:2,type:'normal',focused:true,state:'normal'};
  const api={tabs:{query:async()=>tabs.map(t=>({...t})),get:async id=>{
    const t=tabs.find(t=>t.id===id);if(!t)throw Error('missing');return {...t};
  },update:async(id,p)=>{calls.push('select');const t=tabs.find(t=>t.id===id);Object.assign(t,p);return {...t};},
  create:async p=>{calls.push('create');const t={id:tabs.length+10,windowId:p.windowId,index:tabs.length,
    url:'about:blank',pendingUrl:p.url,active:true,groupId:-1};tabs.push(t);return {...t};}},
  windows:{get:async()=>({...win}),getLastFocused:async()=>({...win}),update:async(_,p)=>{calls.push('foreground');Object.assign(win,p);return {...win};}}};
  return {tabs,calls,win,api};
}
test('opens directly in the normal profile window, then reuses the still-loading exact tab',async()=>{
  const f=fixture(),payload={version:1,url};
  const first=await activate(f.api,payload);
  assert.equal(first.kind,'opened');assert.equal(first.requestedURL,url);assert.equal(first.committed,false);
  const second=await activate(f.api,payload);
  assert.equal(second.kind,'focused');assert.equal(second.targetURL,url);
  assert.equal(f.tabs.length,1);assert.deepEqual(f.calls,['create','select']);
});
test('explicit force-new creates another tab even when the URL already exists',async()=>{
  const f=fixture();for(let n=0;n<2;n++)assert.equal((await activate(f.api,{version:1,url,forceNew:true})).kind,'opened');
  assert.equal(f.tabs.length,2);
});
test('region, query, fragment and account differences do not reuse the wrong pending tab',async()=>{
  for(const other of [url.replace('EU','US'),url+'x','https://mail.google.com/mail/u/1/#inbox']) {
    const f=fixture();await activate(f.api,{version:1,url:other});
    assert.equal((await activate(f.api,{version:1,url})).kind,'opened');assert.equal(f.tabs.length,2);
  }
});
test('stale IDs resolve the exact current target rather than opening a duplicate',async()=>{
  const f=fixture();await activate(f.api,{version:1,url});
  const r=await activate(f.api,{version:1,url,tabId:'999',windowId:'999'});
  assert.equal(r.kind,'focused');assert.equal(f.tabs.length,1);
});
test('expiry, incognito and API uncertainty cannot create or retry a second tab',async()=>{
  for(const setup of [f=>{f.win.incognito=true;},f=>{f.api.windows.getLastFocused=async()=>{f.expired=true;return f.win;};}]) {
    const f=fixture();setup(f);
    const r=await activate(f.api,{version:1,url},{cancelled:()=>f.expired});
    assert.equal(r.allowFallback,false);assert.equal(f.tabs.length,0);
  }
  const f=fixture();f.api.tabs.create=async()=>{f.calls.push('create');throw Error('lost ack');};
  const r=await activate(f.api,{version:1,url});
  assert.equal(r.allowFallback,false);assert.deepEqual(f.calls,['create']);
});
test('a missing normal window is a definite nonmutating fallback',async()=>{
  const f=fixture();f.api.windows.getLastFocused=async()=>{throw Error('none');};
  const r=await activate(f.api,{version:1,url});
  assert.equal(r.reason,'no_normal_window');assert.equal(r.allowFallback,true);assert.deepEqual(f.calls,[]);
});
test('ambiguous app entries and changed workspace hints never silently create a tab',async()=>{
  const f=fixture(),rule={id:'team',url:'https://example.test/team/issues',scope:{origin:'https://example.test',pathPrefix:'/team/',queryKeys:[]}};
  f.tabs.push({id:10,windowId:2,url:'https://example.test/team/agents'}, {id:11,windowId:2,url:'https://example.test/team/inbox'});
  const entries=createEntryReuse(f.api,[rule]);
  assert.equal((await activate(f.api,{version:1,url:rule.url,entryId:'team',entryURL:rule.url},{entries})).reason,'ambiguous_entry');
  f.tabs[0].url='https://example.test/other/issues';
  const r=await activate(f.api,{version:1,url:rule.url,entryId:'team',entryURL:rule.url,tabId:'10'},{entries});
  assert.equal(r.allowFallback,false);assert.deepEqual(f.calls,[]);
});
