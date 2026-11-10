import test from 'node:test';
import assert from 'node:assert/strict';
import {createTimingObserver} from './timing-observer.mjs';
function fake() {
  const events=[];
  const api={windows:{get:async()=>({type:'normal',incognito:false})},tabs:{get:async()=>{throw Error('closed');}}};
  const observer=createTimingObserver(api,e=>events.push(e),()=>1000);
  return {api,events,observer};
}
test('new-tab timing follows an exact pending URL and subsequent redirects without changing tabs',async()=>{
  const {observer,events}=fake();
  observer.arm({operation:'request-a',url:'https://example.test/start',expiresAt:15000});
  await observer.created({id:1,windowId:2,url:'about:blank',pendingUrl:'https://example.test/start',active:true});
  await observer.updated({id:1,windowId:2,url:'https://example.test/landing',title:'Loaded',active:true,status:'complete'});
  assert.equal(events[0].url,'https://example.test/start');assert.equal(events[1].url,'https://example.test/landing');
  assert.equal(events[0].active,false);assert.equal(events[0].status,'loading');
  assert.equal(events[1].operation,'request-a');assert.equal(events[1].status,'complete');
});
test('unrelated and incognito tabs never supply a completion signal',async()=>{
  const {observer,events}=fake();observer.arm({operation:'a',url:'https://example.test/start',expiresAt:15000});
  await observer.created({id:1,windowId:2,url:'https://example.test/other',active:true});
  await observer.created({id:2,windowId:2,url:'https://example.test/start',incognito:true});
  assert.deepEqual(events,[]);
});
test('two armed requests for the same URL are marked ambiguous instead of guessed',async()=>{
  const {observer,events}=fake();
  for(const operation of ['a','b'])observer.arm({operation,url:'https://example.test/start',expiresAt:15000});
  await observer.created({id:1,windowId:2,url:'https://example.test/start',active:true});
  assert.deepEqual(events.map(e=>e.event),['opening_ambiguous','opening_ambiguous']);
});
test('popup windows and expired observations are excluded',async()=>{
  const {observer,events,api}=fake();api.windows.get=async()=>({type:'popup'});
  observer.arm({operation:'a',url:'https://example.test/start',expiresAt:15000});
  await observer.created({id:1,windowId:2,url:'https://example.test/start',active:true});
  observer.arm({operation:'expired',url:'https://example.test/expired',expiresAt:999});
  await observer.created({id:2,windowId:2,url:'https://example.test/expired',active:true});
  assert.deepEqual(events,[]);
});
test('direct creation binding survives a late arm and records creation before commit',async()=>{
  const {observer,events}=fake();
  const url='https://example.test/start';
  await observer.track('direct',url,{id:1,windowId:2,url:'about:blank',pendingUrl:url,active:true});
  observer.arm({operation:'direct',url,expiresAt:15000});
  await observer.updated({id:1,windowId:2,url,active:true,status:'loading'});
  assert.equal(events[0].created,true);assert.equal(events[0].committed,false);
  assert.equal(events[1].committed,true);assert.equal(events[1].operation,'direct');
});
