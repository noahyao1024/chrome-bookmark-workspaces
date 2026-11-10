import test from 'node:test';
import assert from 'node:assert/strict';
import {createEntryReuse} from './entry-reuse.mjs';
import {activate} from './native-activate.mjs';
import {createSearchIndex} from './search-index.mjs';

const base='https://app.example.test/team/';
const rule={id:'workspace',url:base+'issues',scope:{origin:'https://app.example.test',pathPrefix:'/team/',queryKeys:'*',allowFragment:true}};
const payload={version:1,url:rule.url,entryId:rule.id,entryURL:rule.url};
function fixture(initial=[]) {
  const tabs=initial.map((t,i)=>({id:i+1,windowId:10,groupId:-1,active:false,...t}));
  const calls=[];
  const win={id:10,type:'normal',focused:true,state:'normal'};
  const api={tabs:{query:async()=>tabs.map(t=>({...t})),get:async id=>{
    const tab=tabs.find(t=>t.id===id);if(!tab)throw Error('closed');return {...tab};
  },update:async(id,p)=>{calls.push('focus');const tab=tabs.find(t=>t.id===id);Object.assign(tab,p);return {...tab};},
  create:async p=>{calls.push('create');const tab={id:tabs.length+1,windowId:p.windowId,url:'about:blank',pendingUrl:p.url,active:true,groupId:-1};tabs.push(tab);return {...tab};}},
  windows:{get:async()=>({...win}),getLastFocused:async()=>({...win}),update:async(_,p)=>Object.assign(win,p)}};
  return {tabs,calls,api};
}
test('chat and agent query routes stay inside an explicitly broad workspace scope',async()=>{
  const f=fixture([{url:base+'chat?session=example',lastAccessed:20},{url:base+'agents/one?view=general',lastAccessed:10}]);
  const entries=createEntryReuse(f.api,[rule]);
  assert.equal((await entries.targets()).length,2);
  const selected=await activate(f.api,{...payload,url:f.tabs[0].url,tabId:'1'},{entries});
  assert.equal(selected.kind,'focused');
  for(let i=0;i<3;i++)assert.equal((await activate(f.api,payload,{entries})).tabId,'1');
  assert.equal(f.tabs.length,2);assert.ok(!f.calls.includes('create'));
});
test('a restrictive rule blocks creation when a workspace page already exists with unsupported query keys',async()=>{
  for(const url of [base+'chat?session=example',base+'agents/one?view=general',base+'issues#view']){
    const f=fixture([{url}]),strict={...rule,scope:{...rule.scope,queryKeys:['issue'],allowFragment:false}};
    const result=await activate(f.api,payload,{entries:createEntryReuse(f.api,[strict])});
    assert.equal(result.reason,'entry_scope_constraints');assert.equal(result.allowFallback,false);
    assert.equal(result.candidateCount,1);assert.deepEqual(f.calls,[]);
  }
});
test('a loading entry is reused before commit and after redirect without a second creation',async()=>{
  const f=fixture(),entries=createEntryReuse(f.api,[rule]);
  const first=await activate(f.api,payload,{entries});assert.equal(first.kind,'opened');
  assert.equal(first.lookupReason,'no_matching_entry');
  const hints=await entries.targets();assert.equal(hints[0].url,rule.url);
  for(let i=0;i<3;i++)assert.equal((await activate(f.api,payload,{entries})).kind,'focused');
  f.tabs[0].url=base+'chat?session=example';delete f.tabs[0].pendingUrl;
  assert.equal((await activate(f.api,payload,{entries})).kind,'focused');
  assert.equal(f.calls.filter(c=>c==='create').length,1);
});
test('creation intent prevents duplicates when Chrome has not exposed a pending URL yet',async()=>{
  const f=fixture(),create=f.api.tabs.create;
  f.api.tabs.create=async value=>{await create(value);delete f.tabs[0].pendingUrl;return {...f.tabs[0]};};
  const entries=createEntryReuse(f.api,[rule]);
  assert.equal((await activate(f.api,payload,{entries})).kind,'opened');
  for(let i=0;i<3;i++)assert.equal((await activate(f.api,payload,{entries})).reason,'entry_loading');
  f.tabs[0].url=base+'chat?session=example';
  assert.equal((await activate(f.api,payload,{entries})).kind,'focused');
  assert.equal(f.calls.filter(c=>c==='create').length,1);
});
test('other workspaces and origins do not block opening the requested workspace',async()=>{
  for(const url of ['https://app.example.test/other/chat?session=example','https://other.example.test/team/chat?session=example']){
    const f=fixture([{url}]);const result=await activate(f.api,payload,{entries:createEntryReuse(f.api,[rule])});
    assert.equal(result.kind,'opened');assert.equal(f.tabs.length,2);
  }
});
test('force-new and precise chat links retain their original behavior',async()=>{
  const f=fixture([{url:base+'chat?session=first'}]),entries=createEntryReuse(f.api,[rule]);
  assert.equal((await activate(f.api,{...payload,forceNew:true},{entries})).kind,'opened');
  assert.equal((await activate(f.api,{version:1,url:base+'chat?session=second'},{entries})).kind,'opened');
  assert.equal(f.calls.filter(c=>c==='create').length,2);
});
test('search exposes pending entry targets with their real tab IDs and prefers the recently used duplicate',async()=>{
  const f=fixture([{url:'about:blank',pendingUrl:rule.url,lastAccessed:20},{url:'about:blank',pendingUrl:rule.url,lastAccessed:30}]);
  f.api.windows.getAll=async()=>[{id:10,tabs:f.tabs.map((t,index)=>({...t,index}))}];
  f.api.bookmarks={getTree:async()=>[{id:'0',children:[{id:'1',title:'Bookmarks bar',children:[{id:'2',title:'Work',children:[{id:'3',title:'Workspace',url:rule.url}]}]}]}]};
  const entries=createEntryReuse(f.api,[rule]),values=[];
  const index=createSearchIndex(f.api,entries,{profile:'Default',entries:[rule]},v=>values.push(v));
  try {
    await index.configure([]);const row=values.at(-1).items.find(r=>r.title==='Workspace');
    const selected=JSON.parse(row.arg);assert.equal(selected.tabId,'2');assert.equal(selected.entryId,rule.id);
    assert.equal(row._source,'opened-bookmark');
  } finally {index.stop();}
});
