import test from 'node:test';
import assert from 'node:assert/strict';
import {createRecentSwitcher} from './recent-tabs.mjs';

function fake(tabs) {
  let clock=1000;
  const updates=[];
  const api={tabs:{
    query:async({windowId})=>tabs.filter(t=>t.windowId===windowId).map(t=>({...t})),
    get:async id=>{const t=tabs.find(t=>t.id===id);if(!t)throw Error('closed');return {...t};},
    update:async(id,properties)=>{
      const t=tabs.find(t=>t.id===id);if(!t)throw Error('closed');
      for(const other of tabs)if(other.windowId===t.windowId)other.active=false;
      Object.assign(t,properties,{lastAccessed:++clock});updates.push(id);return {...t};
    }
  }};
  return {api,updates};
}
const initial=()=>[{id:1,windowId:10,index:0,active:true,lastAccessed:300},
  {id:2,windowId:10,index:1,active:false,lastAccessed:200},
  {id:3,windowId:10,index:2,active:false,lastAccessed:100}];

test('repeated commands alternate the two recent tabs instead of walking tab positions',async()=>{
  const tabs=initial(),f=fake(tabs),switcher=createRecentSwitcher(f.api);
  switcher.noteActivated({tabId:3,windowId:10});switcher.noteActivated({tabId:1,windowId:10});
  for(let i=0;i<4;i++)await switcher.switchPrevious(10);
  assert.deepEqual(f.updates,[3,1,3,1]);
});
test('Chrome lastAccessed restores recent order after a service worker restart',async()=>{
  const tabs=initial(),f=fake(tabs);
  assert.equal((await createRecentSwitcher(f.api).switchPrevious(10)).tabId,2);
  assert.equal((await createRecentSwitcher(f.api).switchPrevious(10)).tabId,1);
});
test('rapid commands are serialized and keep the two-tab toggle order',async()=>{
  const f=fake(initial()),switcher=createRecentSwitcher(f.api);
  await Promise.all(Array.from({length:4},()=>switcher.switchPrevious(10)));
  assert.deepEqual(f.updates,[2,1,2,1]);
});
test('closed previous tabs fall back to the next surviving recent tab',async()=>{
  const tabs=initial(),f=fake(tabs),switcher=createRecentSwitcher(f.api);
  switcher.noteActivated({tabId:2,windowId:10});switcher.noteActivated({tabId:1,windowId:10});
  tabs.splice(1,1);switcher.forgetTab(2,10);
  assert.equal((await switcher.switchPrevious(10)).tabId,3);
});
test('other windows and incognito tabs are excluded; one tab is a no-op',async()=>{
  const tabs=[{id:1,windowId:10,active:true,lastAccessed:1},
    {id:2,windowId:11,active:true,lastAccessed:999},
    {id:3,windowId:10,active:false,incognito:true,lastAccessed:998}];
  const f=fake(tabs),switcher=createRecentSwitcher(f.api);
  assert.equal((await switcher.switchPrevious(10)).status,'no-other');assert.deepEqual(f.updates,[]);
});
test('a candidate closed between query and get is skipped without opening a new tab',async()=>{
  const tabs=initial(),f=fake(tabs),get=f.api.tabs.get;
  f.api.tabs.get=async id=>{if(id===2){tabs.splice(tabs.findIndex(t=>t.id===2),1);throw Error('closed');}return get(id);};
  assert.equal((await createRecentSwitcher(f.api).switchPrevious(10)).tabId,3);
});
test('activating a tab in a collapsed group expands it without creating groups',async()=>{
  const tabs=initial();tabs[1].groupId=7;const f=fake(tabs),group={id:7,collapsed:true,color:'red'};
  f.api.tabGroups={get:async()=>({...group}),update:async(id,props)=>{assert.equal(id,7);Object.assign(group,props);}};
  await createRecentSwitcher(f.api).switchPrevious(10);assert.equal(group.collapsed,false);assert.equal(group.color,'red');
});
