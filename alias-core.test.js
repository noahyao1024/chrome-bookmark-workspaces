const test = require('node:test');
const assert = require('node:assert/strict');
const api = require('./alias-core.js');
const url = 'https://example.test/metrics?region=us-east-1&psm=feed&a=x,y#view';
const bookmark = {title:'metrics row feed_api',url,path:'Work / Duty / Metrics'};
const tab = {title:'Service Monitoring',url,windowId:'10',tabId:'20'};

test('bookmark alias survives a different page title and coalesces with the open tab',()=>{
  const rows=api.items([bookmark],[tab],'metrics row feed',true);
  assert.equal(rows.length,1);assert.equal(rows[0].title,bookmark.title);
  assert.match(rows[0].subtitle,/已打开/);assert.equal(JSON.parse(rows[0].arg).url,url);
  assert.equal(rows[0].mods.ctrl.arg,url);
});
test('all retained aliases remain searchable with the matching alias displayed',()=>{
  const ent={...bookmark,title:'metrics eu ent'};
  const rows=api.items([bookmark,ent],[tab],'metrics eu ent',true);
  assert.equal(rows.length,1);assert.equal(rows[0].title,ent.title);
  assert.equal(api.items([bookmark,ent],[tab],'',true).length,1);
});
test('regions, queries, fragments and comma-bearing URLs retain their identity',()=>{
  for(const distinct of [url.replace('us-east-1','eu-central-1'),url.replace('psm=feed','psm=ent'),url.replace('#view','#other')]){
    assert.equal(api.decide({version:1,url:distinct},[tab]).kind,'open');
  }
  assert.equal(api.decide(JSON.parse(api.items([bookmark],[tab],'',true)[0].arg),[tab]).kind,'focus');
});
test('activation resolves live IDs instead of stale positions or navigated-away tabs',()=>{
  const payload={version:1,url,windowId:'10',tabId:'20'};
  const moved={...tab,windowId:'99'};
  assert.equal(api.decide(payload,[moved]).tab.windowId,'99');
  assert.equal(api.decide(payload,[{...tab,url:'https://example.test/other'}]).kind,'open');
  const other={...tab,tabId:'21'};
  assert.equal(api.decide(payload,[{...tab,url:'about:blank'},other]).tab.tabId,'21');
});
test('command modifier deliberately opens another copy',()=>{
  const row=api.items([bookmark],[tab],'',true)[0];
  assert.equal(api.decide(JSON.parse(row.mods.cmd.arg),[tab]).kind,'open');
});
test('unopened bookmarks, unbookmarked tabs, and path queries work',()=>{
  assert.match(api.items([bookmark],[],'Work Duty',true)[0].subtitle,/书签/);
  assert.equal(api.items([],[tab],'Service Monitoring',true)[0].title,tab.title);
  assert.equal(api.items([bookmark],[tab],'not found',true).length,0);
});
test('malformed percent escapes and Chinese text do not break search',()=>{
  const b={...bookmark,title:'监控\u200b 面板',url:'https://example.test/%ZZ'};
  assert.equal(api.items([b],[],'监控 面板',true).length,1);
});
test('flatten preserves names and nested folder paths without mutating bookmarks',()=>{
  const doc={roots:{bookmark_bar:{type:'folder',name:'Bookmarks bar',children:[{type:'folder',name:'Work',children:[{type:'url',name:bookmark.title,url,id:'5'}]}]}}};
  const original=JSON.stringify(doc);assert.equal(api.flatten(doc)[0].path,'Work');
  assert.equal(JSON.stringify(doc),original);
});
test('native filtering receives every bookmark, not only the first 150',()=>{
  const many=Array.from({length:650},(_,i)=>({...bookmark,title:'entry '+i,url:'https://example.test/'+i}));
  const rows=api.items(many,[],'',true,{indexMode:true});
  assert.equal(rows.length,650);assert.ok(rows[649].match.includes('entry 649'));
});
test('native filtering retains every alias, folder path, page title and URL',()=>{
  const second={...bookmark,title:'metrics eu ent'};
  const rows=api.items([bookmark,second],[tab],'',true,{indexMode:true});
  assert.equal(rows.length,1);
  assert.equal(rows[0].title,bookmark.title);
  assert.deepEqual(rows[0]._aliases,[bookmark.title,second.title]);
  for(const text of ['metrics eu ent','work / duty / metrics','service monitoring','region=us-east']) assert.ok(rows[0].match.includes(text));
});

test('an open Grafana dashboard inherits bookmark aliases after variable changes without merging URLs',()=>{
  const saved='https://grafana.example.test/d/dashboard-A/overview?orgId=1&var-VRegion=Singapore-Central&from=now-1h';
  const current=saved.replace('Singapore-Central','eu-west-2').replace('now-1h','now-30m');
  const b={title:'dashboard shortcut',url:saved,path:'Work / Duty / Monitor'};
  const t={...tab,title:'Service overview - Grafana',url:current};
  const rows=api.items([b],[t],'dashboard shortcut',true,{indexMode:true});
  assert.equal(rows.length,2);
  assert.equal(rows[0].title,b.title);assert.equal(rows[0]._source,'opened-related');
  assert.match(rows[0].subtitle,/已打开.*eu-west-2/);
  assert.equal(JSON.parse(rows[0].arg).url,current);
  assert.equal(JSON.parse(rows[0].arg).tabId,t.tabId);
  assert.equal(rows[0].mods.ctrl.arg,current);
  assert.equal(api.decide(JSON.parse(rows[0].arg),[t]).kind,'focus');
  assert.equal(JSON.parse(rows[1].arg).url,saved);
  assert.match(rows[1].subtitle,/书签.*Singapore-Central/);
  assert.equal(api.decide(JSON.parse(rows[1].arg),[t]).kind,'open');
});

test('Grafana discovery preserves dashboard UID, host, scheme and organization boundaries',()=>{
  const saved='https://grafana.example.test/d/dashboard-A/overview?orgId=1&var-VRegion=SG';
  const b={title:'dashboard shortcut',url:saved,path:'Work / Duty / Monitor'};
  for(const other of [saved.replace('dashboard-A','dashboard-B'),saved.replace('dashboard-A','dashboard-a'),
                      saved.replace('grafana.example.test','grafana-other.example.test'),saved.replace('https:','http:'),saved.replace('orgId=1','orgId=2')]){
    const rows=api.items([b],[{...tab,url:other}],'dashboard shortcut',true,{indexMode:true});
    assert.equal(rows.length,1);assert.equal(rows[0]._source,'bookmark');
  }
});

test('other services never inherit bookmark aliases by ignoring query parameters',()=>{
  const rows=api.items([bookmark],[{...tab,url:url.replace('us-east-1','eu-west-2')}],'metrics row feed',true,{indexMode:true});
  assert.equal(rows.length,1);assert.equal(rows[0]._source,'bookmark');
});

test('Gmail inbox reuse requires profile proof and never merges account or message links',()=>{
  const inbox='https://mail.google.com/mail/u/0/#inbox';
  const message={...tab,url:inbox+'/message-A'};
  const payload={version:1,url:inbox};
  assert.equal(api.decide(payload,[message]).kind,'open');
  assert.equal(api.decide(payload,[message],{allowMailboxReuse:true}).tab.tabId,message.tabId);
  for(const other of [inbox.replace('/u/0/','/u/1/'),inbox+'/message-B',
                     inbox.replace('#','?authuser=other#'),inbox.replace('mail.google.com','mail.google.com.evil.test')]) {
    assert.equal(api.decide({version:1,url:other},[message],{allowMailboxReuse:true}).kind,'open');
  }
  assert.equal(api.decide({...payload,forceNew:true},[message],{allowMailboxReuse:true}).kind,'open');
  const exact={...tab,url:inbox,tabId:'30'};
  assert.equal(api.decide(payload,[message,exact],{allowMailboxReuse:true}).tab.tabId,'30');
});

test('entry aliases require profile-scoped hints that agree with live IDs and full URLs',()=>{
  const b={title:'Project Work',url:'https://app.example.test/team/issues',path:'Work / My Work'};
  const t={...tab,title:'Agents | Workspace',url:'https://app.example.test/team/agents'};
  const policy={id:'project-work',url:b.url},hint={entryId:policy.id,entryURL:b.url,url:t.url,tabId:t.tabId,windowId:t.windowId,bound:true};
  const options={indexMode:true,entryPolicies:[policy],entryTargets:[hint]};
  const rows=api.items([b],[t],'project work',true,options);
  assert.equal(rows.length,2);assert.equal(rows[0]._source,'opened-related');
  const payload=JSON.parse(rows[0].arg);assert.equal(payload.tabId,t.tabId);assert.equal(payload.entryURL,b.url);
  assert.equal(payload.url,t.url);assert.equal(rows[0].mods.ctrl.arg,t.url);
  assert.equal(JSON.parse(rows[0].mods.cmd.arg).forceNew,true);
  for(const invalid of [{...hint,windowId:'other-profile-window'},{...hint,tabId:'unknown'},{...hint,url:t.url+'/changed'}]) {
    const result=api.items([b],[t],'project work',true,{...options,entryTargets:[invalid]});
    assert.equal(result.length,1);assert.equal(result[0]._source,'bookmark');
  }
});
test('specific issue bookmarks remain exact even when an app-entry alias shares the current page',()=>{
  const root={title:'Project Work',url:'https://app.example.test/team/issues',path:'Work'};
  const deep={title:'my precise issue',url:root.url+'/TASK-75',path:'Work'};
  const t={...tab,title:'TASK-75',url:deep.url};
  const options={indexMode:true,entryPolicies:[{id:'project-work',url:root.url}],entryTargets:[{entryId:'project-work',entryURL:root.url,url:t.url,tabId:t.tabId,windowId:t.windowId}]};
  const precise=api.items([root,deep],[t],'my precise issue',true,options);
  assert.equal(precise.length,1);assert.equal(JSON.parse(precise[0].arg).entryId,undefined);
  const entry=api.items([root,deep],[t],'project work',true,options)[0];
  assert.equal(JSON.parse(entry.arg).entryId,'project-work');
});

test('a removed duplicate name can find the retained bookmark without renaming it or duplicating results',()=>{
  const saved={title:'docs reference',url:'https://example.test/wiki/core',path:'Work / Department',id:'324'};
  const original=JSON.stringify(saved);
  const augmented=api.addSearchAliases([saved],[{title:'docs overview',url:saved.url}]);
  assert.equal(JSON.stringify(saved),original);
  const current={...tab,url:saved.url};
  for(const query of ['docs overview','docs reference']) {
    const rows=api.items(augmented,[current],query,true);
    assert.equal(rows.length,1);assert.equal(JSON.parse(rows[0].arg).tabId,current.tabId);
    assert.equal(rows[0].mods.ctrl.arg,saved.url);
  }
  assert.ok(api.items(augmented,[],'',true,{indexMode:true})[0]._aliases.includes('docs overview'));
});
test('search aliases never revive removed URLs, cross URL boundaries, or repeat existing names',()=>{
  const saved={title:'docs reference',url:'https://example.test/wiki/core',path:'Work'};
  const result=api.addSearchAliases([saved],[{title:'DOCS REFERENCE',url:saved.url},
    {title:'docs overview',url:saved.url+'?account=other'},
    {title:'deleted document',url:'https://example.test/deleted'},
    {title:'',url:saved.url},null]);
  assert.deepEqual(result,[saved]);
  assert.deepEqual(api.addSearchAliases([], [{title:'docs overview',url:saved.url}]),[]);
});
