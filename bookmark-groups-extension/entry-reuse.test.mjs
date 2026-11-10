import test from 'node:test';
import assert from 'node:assert/strict';
import {createEntryReuse, withinScope} from './entry-reuse.mjs';

const rule={id:'work',url:'https://example.test/team-a/issues',scope:{origin:'https://example.test',pathPrefix:'/team-a/',queryKeys:['issue']}};
const payload={version:1,url:rule.url,entryId:rule.id,entryURL:rule.url};
function fake(urls) {
  const tabs=new Map(urls.map((url,i)=>[i+1,{id:i+1,windowId:9,url,incognito:false}]));
  const state={};let queries=0;
  const api={tabs:{query:async q=>{assert.deepEqual(q,{windowType:'normal'});queries++;return [...tabs.values()].map(t=>({...t}));},
    get:async id=>{if(!tabs.has(id))throw Error('closed');return {...tabs.get(id)};}},
    windows:{get:async()=>({id:9,type:'normal',incognito:false})},
    storage:{session:{get:async key=>({[key]:structuredClone(state[key])}),set:async value=>Object.assign(state,structuredClone(value))}}};
  return {api,tabs,state,queries:()=>queries};
}
test('scope checks preserve origin, port, workspace, query and encoded-path boundaries',()=>{
  assert.ok(withinScope(rule,'https://example.test/team-a/inbox?issue=abc'));
  for(const url of ['https://example.test/team-b/issues','https://example.test/team-a-other/issues',
    'http://example.test/team-a/issues','https://example.test:8443/team-a/issues',
    'https://example.test.evil.test/team-a/issues','https://user@example.test/team-a/issues',
    'https://example.test/team-a/issues?account=other','https://example.test/team-a/issues#other',
    'https://example.test/team-a/%2e%2e/team-b/issues','https://example.test/team-a/x%2f..%2fteam-b']) {
    assert.equal(withinScope(rule,url),false,url);
  }
});
test('only configured entry actions can request workspace reuse',async()=>{
  const f=fake(['https://example.test/team-a/agents']),entries=createEntryReuse(f.api,[rule]);
  assert.equal(await entries.resolve({version:1,url:rule.url}),null);
  assert.equal(await entries.resolve({version:1,url:'https://example.test/team-a/issues/ABC-1'}),null);
  assert.equal((await entries.resolve({...payload,entryId:'unknown'})).reason,'invalid_entry');
  assert.equal((await entries.resolve({...payload,entryURL:rule.url+'/ABC-1'})).reason,'invalid_entry');
});
test('a unique scoped tab can be reused; multiple unbound views require selection',async()=>{
  const f=fake(['https://example.test/team-a/agents']),entries=createEntryReuse(f.api,[rule]);
  const first=await entries.resolve(payload);assert.equal(first.matchType,'entry-unique');assert.equal(first.tab.id,1);
  f.tabs.set(2,{id:2,windowId:9,url:'https://example.test/team-a/inbox'});
  const ambiguous=await entries.resolve(payload);
  assert.equal(ambiguous.reason,'ambiguous_entry');assert.equal(ambiguous.allowFallback,false);
});
test('an exact entry URL is a definite match even with other workspace tabs',async()=>{
  const f=fake(['https://example.test/team-a/agents',rule.url]),entries=createEntryReuse(f.api,[rule]);
  assert.equal((await entries.resolve(payload)).tab.id,2);
});
test('explicit selection binds a live tab and follows its in-scope navigation without a scan',async()=>{
  const f=fake(['https://example.test/team-a/agents','https://example.test/team-a/inbox']),entries=createEntryReuse(f.api,[rule]);
  const selected=await entries.resolve({...payload,url:f.tabs.get(2).url,tabId:'2'});
  assert.equal(selected.matchType,'entry-selected');await entries.remember(selected.rule,selected.tab);
  f.tabs.get(2).url='https://example.test/team-a/issues/ABC-1';
  const bound=await entries.resolve(payload);
  assert.equal(bound.tab.id,2);assert.equal(bound.matchType,'entry-bound');assert.equal(f.queries(),0);
  const restarted=createEntryReuse(f.api,[rule]);
  assert.equal((await restarted.resolve(payload)).tab.id,2);
});
test('leaving the scope releases the binding even if that tab later returns',async()=>{
  const f=fake(['https://example.test/team-a/agents','https://example.test/team-a/inbox']),entries=createEntryReuse(f.api,[rule]);
  await entries.remember(rule,f.tabs.get(1));
  f.tabs.get(1).url='https://example.test/team-b/agents';await entries.observeTab(f.tabs.get(1));
  f.tabs.get(1).url='https://example.test/team-a/agents';await entries.observeTab(f.tabs.get(1));
  assert.equal((await entries.resolve(payload)).reason,'ambiguous_entry');
});
test('pending navigation to another workspace cannot reuse an old in-scope URL',async()=>{
  const f=fake(['https://example.test/team-a/agents']),entries=createEntryReuse(f.api,[rule]);
  await entries.remember(rule,f.tabs.get(1));f.tabs.get(1).pendingUrl='https://example.test/team-b/agents';
  assert.equal((await entries.resolve(payload)).reason,'no_matching_entry');
});
test('closed tabs, incognito and changed policy scopes cannot retain bindings',async()=>{
  const f=fake(['https://example.test/team-a/agents']),entries=createEntryReuse(f.api,[rule]);
  await entries.remember(rule,f.tabs.get(1));f.tabs.get(1).incognito=true;
  assert.equal((await entries.resolve(payload)).reason,'no_matching_entry');
  f.tabs.get(1).incognito=false;await entries.remember(rule,f.tabs.get(1));
  const edited={...rule,scope:{...rule.scope,queryKeys:[]}};
  const restarted=createEntryReuse(f.api,[edited]);assert.equal((await restarted.targets())[0].bound,false);
  await entries.forgetTab(1);f.tabs.delete(1);
  assert.equal((await entries.resolve(payload)).reason,'no_matching_entry');
});
test('observed source URL binds the opening tab without overwriting an existing binding',async()=>{
  const f=fake([rule.url,rule.url]),entries=createEntryReuse(f.api,[rule]);
  await entries.observeTab(f.tabs.get(1),true);await entries.observeTab(f.tabs.get(2),true);
  assert.equal((await entries.resolve(payload)).tab.id,1);
});
test('creation with the exact pending entry URL can bind the first in-scope landing',async()=>{
  const f=fake(['about:blank']),entries=createEntryReuse(f.api,[rule]);
  f.tabs.get(1).pendingUrl=rule.url;await entries.observeTab(f.tabs.get(1),true);
  delete f.tabs.get(1).pendingUrl;f.tabs.get(1).url='https://example.test/team-a/agents';
  await entries.observeTab(f.tabs.get(1));assert.equal((await entries.resolve(payload)).matchType,'entry-bound');
});
test('candidate hints expose only scoped live tabs and mark the selected binding',async()=>{
  const f=fake(['https://example.test/team-a/agents','https://example.test/team-b/agents','https://example.test/team-a/inbox']),entries=createEntryReuse(f.api,[rule]);
  await entries.remember(rule,f.tabs.get(3));
  const targets=await entries.targets();assert.deepEqual(targets.map(t=>t.tabId),['1','3']);
  assert.deepEqual(targets.map(t=>t.bound),[false,true]);assert.equal(targets[0].entryURL,rule.url);
});
test('query and fragment reuse is opt-in and still respects origin and path boundaries',()=>{
  const broad={id:'app',url:'https://app.example.test/app/?view=home',scope:{origin:'https://app.example.test',pathPrefix:'/app/',queryKeys:'*',allowFragment:true}};
  assert.ok(withinScope(broad,'https://app.example.test/app/?view=other&runId=latest#/audit?plan_id=one'));
  for(const value of ['http://app.example.test/app/','https://app.example.test:8443/app/',
    'https://app.example.test.evil.test/app/','https://app.example.test/other/',
    'https://user@app.example.test/app/','https://app.example.test/app/x%2f..%2fother'])assert.equal(withinScope(broad,value),false,value);
  const strict={...broad,scope:{...broad.scope,queryKeys:['view'],allowFragment:false}};
  assert.equal(withinScope(strict,'https://app.example.test/app/?runId=latest'),false);
  assert.equal(withinScope(strict,'https://app.example.test/app/?view=home#/audit'),false);
});
test('a broad app binding follows query and fragment navigation but never another origin',async()=>{
  const broad={id:'app',url:'https://app.example.test/?view=home',scope:{origin:'https://app.example.test',pathPrefix:'/',queryKeys:'*',allowFragment:true}};
  const f=fake([broad.url]),entries=createEntryReuse(f.api,[broad]);
  const request={version:1,url:broad.url,entryURL:broad.url,entryId:broad.id};
  await entries.remember(broad,f.tabs.get(1));
  f.tabs.get(1).url='https://app.example.test/?view=other#/audit?id=two';
  assert.equal((await entries.resolve(request)).matchType,'entry-bound');
  f.tabs.get(1).pendingUrl='https://other.example.test/';
  assert.equal((await entries.resolve(request)).reason,'no_matching_entry');
});
