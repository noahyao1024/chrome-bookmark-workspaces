import test from 'node:test';
import assert from 'node:assert/strict';
import {createSearchIndex, flattenTree} from './search-index.mjs';
const url='https://example.test/view?a=1#panel';
const tree=[{id:'0',title:'',children:[{id:'1',title:'Bookmarks bar',children:[{id:'2',title:'Work',children:[{id:'3',title:'Dashboard',url}]}]}]}];
function event() {const listeners=[];return {addListener:f=>listeners.push(f),removeListener:()=>{},fire:(...a)=>listeners.forEach(f=>f(...a))};}
test('native bookmarks preserve Work paths, aliases, exact URLs and live IDs',async()=>{
  assert.deepEqual(flattenTree(tree),[{id:'3',title:'Dashboard',url,path:'Work'}]);
  const values=[],api={bookmarks:{getTree:async()=>tree},tabs:{},windows:{getAll:async()=>[
    {id:7,tabs:[{id:10,index:0,url,title:'Live'}]},{id:8,incognito:true,tabs:[{id:11,index:0,url:'https://secret.test'}]}
  ]}};
  const index=createSearchIndex(api,{targets:async()=>[]},{profile:'Default',entries:[]},v=>values.push(v));
  try {
    await index.configure([{url,title:'alias'}]);
    const last=values.at(-1);assert.equal(last.profile,'Default');assert.equal(last.items.length,1);
    assert.deepEqual(JSON.parse(last.items[0].arg),{version:1,url,windowId:'7',tabId:'10',tabIndex:1});
    assert.ok(last.items[0].match.includes('alias'));assert.match(last.items[0].subtitle,/Work/);
  } finally {index.stop();}
});
test('tab and bookmark events rebuild results without a new search invocation',async()=>{
  let title='Old';const updates=event(),changed=event(),values=[];
  const api={bookmarks:{getTree:async()=>tree,onChanged:changed},tabs:{onUpdated:updates},
    windows:{getAll:async()=>[{id:7,tabs:[{id:10,index:0,url,title}]}]}};
  const index=createSearchIndex(api,{targets:async()=>[]},{profile:'Default',entries:[]},v=>values.push(v));
  try {
    await index.configure([]);title='New';updates.fire(10,{title});await index.refresh();
    assert.match(values.at(-1).items[0].match,/new/);
    api.bookmarks.getTree=async()=>[{id:'0',children:[]}];changed.fire();await index.refresh();
    assert.equal(values.at(-1).items[0]._source,'opened');assert.equal(values.at(-1).items[0].title,'New');
  } finally {index.stop();}
});
