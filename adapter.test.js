const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const core = require('./alias-core.js');
const url = 'https://example.test/metrics?region=us-east-1&psm=feed&a=x,y#view';

function runtime(states) {
  const counts = {lists:0, idLists:0, titles:0, imports:0, activations:0, minimizedWrites:0, indexWrites:0};
  function tab(t) { return {id:()=>t.id, url:()=>t.url,properties:()=>({id:t.id,url:t.url})}; }
  const windows = states.map(state => {
    let selected = 0, minimized=!!state.minimized, index=state.index||1;
    const win = {id:()=>state.id, mode:()=>state.mode||'normal'};
    win.properties=()=>({id:state.id,mode:state.mode||'normal',minimized,index});
    win.tabs = Object.assign(()=>state.tabs.map(tab), {
      byId:id=>{const t=state.tabs.find(t=>t.id===id);if(!t)throw Error('closed');return tab(t);},
      id:()=>{counts.idLists++;return state.tabs.map(t=>t.id);}, url:()=>state.tabs.map(t=>t.url),
      title:()=>{counts.titles++;throw Error('Activation should not read titles');}
    });
    for(let i=0;i<state.tabs.length;i++)Object.defineProperty(win.tabs,i,{get:()=>tab(state.tabs[i])});
    Object.defineProperty(win,'activeTabIndex',{get:()=>()=>selected+1,set:value=>{
      if(state.reorderOnSelect)state.tabs.reverse();
      selected=value-1;
    }});
    Object.defineProperty(win,'activeTab',{get:()=>tab(state.tabs[selected])});
    Object.defineProperty(win,'minimized',{get:()=>()=>minimized,set:value=>{minimized=value;counts.minimizedWrites++;}});
    Object.defineProperty(win,'index',{get:()=>()=>index,set:value=>{index=value;counts.indexWrites++;}});
    return win;
  });
  const browser={running:()=>true,activate:()=>{counts.activations++;}};
  browser.windows=Object.assign(()=>{counts.lists++;return windows;},{byId:id=>{
    const win=windows.find(w=>w.id()===id);if(!win)throw Error('moved');return win;
  }});
  const ctx=vm.createContext({BookmarkWorkspaces:core,Application:()=>browser,ObjC:{import:()=>{counts.imports++;}}});
  vm.runInContext(fs.readFileSync(__dirname+'/adapter.js','utf8'),ctx);
  ctx.configuration=()=>({profile:'Default'});
  ctx.openURL=(value,config)=>({kind:'opened',url:value,profile:config.profile});
  return {ctx,counts,windows};
}

test('preferred tab focuses directly without scanning windows, titles or loading Foundation',()=>{
  const r=runtime([{id:1,tabs:[{id:10,url:'https://other.test/'}]},{id:2,tabs:[{id:20,url}]}]);
  const out=r.ctx.activate({version:1,url,windowId:'2',tabId:'20'});
  assert.equal(out.kind,'focused');assert.equal(out.tabId,'20');
  assert.equal(r.counts.lists,0);assert.equal(r.counts.titles,0);assert.equal(r.counts.imports,0);
  assert.equal(r.counts.minimizedWrites,0);assert.equal(r.counts.indexWrites,0);
});
test('moved or closed preferred IDs reuse an exact URL from a fresh fallback',()=>{
  for(const staleId of ['20','99']){
    const r=runtime([{id:1,tabs:[{id:10,url:'https://other.test/'}]},{id:2,tabs:[{id:20,url}]}]);
    const out=r.ctx.activate({version:1,url,windowId:'1',tabId:staleId});
    assert.equal(out.kind,'focused');assert.equal(out.windowId,'2');
    assert.equal(r.counts.lists,1);assert.equal(r.counts.titles,0);
  }
});
test('a navigated preferred tab never receives the bookmarked URL',()=>{
  const other=url.replace('us-east-1','eu-west-2');
  const state={id:1,tabs:[{id:10,url:other}]};const r=runtime([state]);
  const out=r.ctx.activate({version:1,url,windowId:'1',tabId:'10'});
  assert.equal(out.kind,'opened');assert.equal(out.url,url);assert.equal(out.profile,'Default');
  assert.equal(state.tabs[0].url,other);assert.equal(r.counts.activations,0);
});
test('bookmark selections without IDs still reuse open exact URLs',()=>{
  const r=runtime([{id:1,tabs:[{id:10,url}]}]);
  assert.equal(r.ctx.activate({version:1,url}).kind,'focused');assert.equal(r.counts.lists,1);
});
test('a reorder during selection fails the ID check and does not report success',()=>{
  const r=runtime([{id:1,reorderOnSelect:true,tabs:[{id:10,url},{id:11,url:'https://other.test/'}]}]);
  assert.throws(()=>r.ctx.activate({version:1,url,windowId:'1',tabId:'10'}),/目标标签发生变化/);
  assert.equal(r.counts.activations,0);
});
test('minimized windows are restored and brought forward only when needed',()=>{
  const r=runtime([{id:1,minimized:true,index:2,tabs:[{id:10,url}]}]);
  assert.equal(r.ctx.activate({version:1,url,windowId:'1',tabId:'10'}).kind,'focused');
  assert.equal(r.counts.minimizedWrites,1);assert.equal(r.counts.indexWrites,1);
});
test('force-new and rejected URL schemes require no tab reads',()=>{
  const r=runtime([{id:1,tabs:[{id:10,url}]}]);
  assert.equal(r.ctx.activate({version:1,url,forceNew:true}).kind,'opened');
  assert.throws(()=>r.ctx.activate({version:1,url:'javascript:alert(1)'}),/不支持的网址格式/);
  assert.equal(r.counts.lists,0);assert.equal(r.counts.activations,0);
});
test('a valid index hint avoids tab enumeration, while a stale hint resolves the correct ID',()=>{
  for(const hint of [1,2,99]){
    const r=runtime([{id:1,tabs:[{id:10,url},{id:11,url:'https://other.test/'}]}]);
    const out=r.ctx.activate({version:1,url,windowId:'1',tabId:'10',tabIndex:hint});
    assert.equal(out.kind,'focused');assert.equal(out.tabId,'10');
    assert.equal(r.counts.idLists,hint===1?0:1);
  }
});
