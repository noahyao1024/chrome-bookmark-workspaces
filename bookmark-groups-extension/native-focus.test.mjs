import test from 'node:test';
import assert from 'node:assert/strict';
import {focusExisting} from './native-focus.mjs';
import {createEntryReuse} from './entry-reuse.mjs';

const url='https://grafana.example.test/d/UID/panel?orgId=1&var-VRegion=eu-west-2&from=now-1h';
function fake() {
  const calls=[];
  const tab={id:10,windowId:2,url,groupId:-1};
  const win={id:2,type:'normal',focused:true,state:'normal'};
  const api={tabs:{get:async id=>{assert.equal(id,10);calls.push('getTab');return {...tab};},
    update:async(id,p)=>{assert.equal(id,10);calls.push('select');Object.assign(tab,p);return {...tab};}},
    windows:{get:async id=>{assert.equal(id,2);calls.push('getWindow');return {...win};},
      update:async(id,p)=>{calls.push('foreground');Object.assign(win,p);return {...win};}}};
  return {api,calls,tab,win};
}
test('focuses the exact live ID and URL without creating a tab or group',async()=>{
  const f=fake(),r=await focusExisting(f.api,{version:1,tabId:'10',windowId:'999',url});
  assert.equal(r.kind,'focused');assert.equal(r.windowId,'2');assert.equal(r.tabId,'10');
  assert.deepEqual(f.calls,['getTab','getWindow','select']);
});
test('different region URLs, incognito windows and missing tabs decline before selection',async()=>{
  for(const setup of [f=>{f.tab.url=url.replace('eu-west-2','SG');},f=>{f.tab.incognito=true;},f=>{f.win.type='popup';},f=>{f.api.tabs.get=async()=>{throw Error('closed');};}]){
    const f=fake();setup(f);const r=await focusExisting(f.api,{version:1,tabId:10,url});
    assert.equal(r.kind,'miss');assert.equal(r.allowFallback,true);assert.ok(!f.calls.includes('select'));
  }
});
test('force-new stays on the legacy opening path',async()=>{
  const f=fake(),r=await focusExisting(f.api,{version:1,tabId:10,url,forceNew:true});
  assert.equal(r.reason,'force_new');assert.deepEqual(f.calls,[]);
});
test('expired or cancelled requests never select a tab',async()=>{
  for(const control of [{expiresAt:Date.now()-1},{cancelled:()=>true}]){
    const f=fake(),r=await focusExisting(f.api,{version:1,tabId:10,url},control);
    assert.equal(r.kind,'failed');assert.equal(r.allowFallback,false);assert.deepEqual(f.calls,[]);
  }
});
test('deadline expiry while getting window data stops before mutating focus',async()=>{
  const f=fake();let cancelled=false;
  f.api.windows.get=async()=>{cancelled=true;return f.win;};
  const r=await focusExisting(f.api,{version:1,tabId:10,url},{cancelled:()=>cancelled});
  assert.equal(r.kind,'failed');assert.ok(!f.calls.includes('select'));
});
test('navigation after selection is acknowledged without causing a duplicate fallback',async()=>{
  const f=fake();f.api.tabs.update=async()=>({...f.tab,active:true,url:url+'#redirect'});
  const r=await focusExisting(f.api,{version:1,tabId:10,url});
  assert.equal(r.kind,'focused');assert.equal(r.navigationChanged,true);
});
test('minimized windows are restored without altering other window states',async()=>{
  const f=fake();f.win.state='minimized';f.win.focused=false;
  assert.equal((await focusExisting(f.api,{version:1,tabId:10,url})).kind,'focused');
  assert.equal(f.win.state,'normal');assert.equal(f.win.focused,true);
});

test('Gmail inbox bookmarks resolve an existing mailbox without navigating or creating',async()=>{
  const f=fake();f.tab.url='https://mail.google.com/mail/u/0/#inbox/message-A';
  f.api.tabs.query=async options=>{assert.deepEqual(options,{windowType:'normal'});return [{...f.tab}];};
  const r=await focusExisting(f.api,{version:1,url:'https://mail.google.com/mail/u/0/#inbox'});
  assert.equal(r.kind,'focused');assert.equal(r.tabId,'10');assert.equal(r.matchType,'gmail-mailbox');
  assert.equal(f.tab.url,'https://mail.google.com/mail/u/0/#inbox/message-A');
  assert.equal(r.navigationChanged,false);
});
test('ID-less exact URLs resolve inside the extension profile',async()=>{
  const f=fake();f.api.tabs.query=async()=>[{...f.tab}];
  const r=await focusExisting(f.api,{version:1,url});
  assert.equal(r.kind,'focused');assert.equal(r.matchType,'resolved-url');
});
test('Gmail resolution rejects other accounts, specific messages, query changes and incognito',async()=>{
  const inbox='https://mail.google.com/mail/u/0/#inbox';
  for(const [target,live,incognito] of [
    [inbox,inbox.replace('/u/0/','/u/1/')+'/message-A',false],
    [inbox+'/message-B',inbox+'/message-A',false],
    [inbox,inbox.replace('#','?authuser=other#')+'/message-A',false],
    [inbox,inbox+'/message-A',true]]) {
    const f=fake();f.api.tabs.query=async()=>[{...f.tab,url:live,incognito}];
    const r=await focusExisting(f.api,{version:1,url:target});
    assert.equal(r.kind,'miss');assert.ok(!f.calls.includes('select'));
  }
});
test('navigation during ID-less resolution is checked before selecting',async()=>{
  const f=fake();f.api.tabs.query=async()=>[{...f.tab,url}];f.tab.url='https://example.test/changed';
  const r=await focusExisting(f.api,{version:1,url});
  assert.equal(r.kind,'miss');assert.ok(!f.calls.includes('select'));
});

const entryRule={id:'project-work',url:'https://app.example.test/team/issues',scope:{origin:'https://app.example.test',pathPrefix:'/team/',queryKeys:['issue']}};
const entryPayload={version:1,url:entryRule.url,entryId:entryRule.id,entryURL:entryRule.url};
test('entry focus binds the selected tab, preserves its URL, and follows safe navigation',async()=>{
  const f=fake();f.tab.url='https://app.example.test/team/agents';f.api.tabs.query=async()=>[{...f.tab}];
  const entries=createEntryReuse(f.api,[entryRule]);
  const first=await focusExisting(f.api,entryPayload,{entries});
  assert.equal(first.kind,'focused');assert.equal(first.matchType,'entry-unique');
  f.tab.url='https://app.example.test/team/inbox?issue=ABC';
  const second=await focusExisting(f.api,entryPayload,{entries});
  assert.equal(second.kind,'focused');assert.equal(second.matchType,'entry-bound');
  assert.equal(f.tab.url,'https://app.example.test/team/inbox?issue=ABC');
});
test('ambiguous entry views never select or allow an automatic duplicate open',async()=>{
  const f=fake();f.tab.url='https://app.example.test/team/agents';
  f.api.tabs.query=async()=>[{...f.tab},{...f.tab,id:11,url:'https://app.example.test/team/inbox'}];
  const entries=createEntryReuse(f.api,[entryRule]),r=await focusExisting(f.api,entryPayload,{entries});
  assert.equal(r.reason,'ambiguous_entry');assert.equal(r.allowFallback,false);assert.ok(!f.calls.includes('select'));
});
test('workspace navigation while looking up the window is rechecked before focus',async()=>{
  const f=fake();f.tab.url='https://app.example.test/team/agents';f.api.tabs.query=async()=>[{...f.tab}];
  f.api.windows.get=async()=>{f.tab.url='https://app.example.test/other-team/agents';return {...f.win};};
  const r=await focusExisting(f.api,entryPayload,{entries:createEntryReuse(f.api,[entryRule])});
  assert.equal(r.reason,'entry_scope_changed');assert.ok(!f.calls.includes('select'));
});
test('an entry deadline that expires during resolution does not focus',async()=>{
  const f=fake();f.tab.url='https://app.example.test/team/agents';let cancelled=false;
  f.api.tabs.query=async()=>{cancelled=true;return [{...f.tab}];};
  const r=await focusExisting(f.api,entryPayload,{entries:createEntryReuse(f.api,[entryRule]),cancelled:()=>cancelled});
  assert.equal(r.reason,'expired');assert.ok(!f.calls.includes('select'));
});
