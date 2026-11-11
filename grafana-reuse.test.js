const test = require('node:test');
const assert = require('node:assert/strict');
const aliases = require('./alias-core.js');

const saved = 'https://grafana.example.test/v10/d/AbC_123/old-title?orgId=1&from=now-1h&to=now-1m&from=now-1h&to=now-1m&var-region=us+east&var-service=feed';
const live = 'https://grafana.example.test/v10/d/AbC_123/new-title?var-service=feed&to=now-1m&orgId=1&var-region=us%20east&from=now-1h';
const tab = {tabId:'10',windowId:'20',url:live,title:'Dashboard'};
const bookmark = {title:'monitor overview',url:saved,path:'Work / Monitor'};
const decide = (url, tabs=[tab], extra={}) => aliases.decide({version:1,url,...extra},tabs,{allowGrafanaReuse:true});

test('Grafana v10 slug redirects reuse the same view only with profile proof', () => {
  assert.equal(aliases.decide({version:1,url:saved},[tab]).kind,'open');
  assert.equal(decide(saved).kind,'focus');
  assert.equal(decide(saved).matchType,'grafana-dashboard');
  assert.equal(aliases.grafanaKey(saved),aliases.grafanaKey(live));
  assert.equal(decide(saved.replace('/v10/d/','/d/'),[{...tab,url:live.replace('/v10/d/','/d/')}]).kind,'focus');
});

test('Grafana reuse preserves every dashboard and view boundary', () => {
  for (const other of [
    live.replace('AbC_123','AbC_124'),live.replace('AbC_123','abc_123'),
    live.replace('/v10/d/','/d/'),live.replace('/v10/d/','/v11/d/'),live.replace('/d/','/D/'),
    live.replace('grafana.example','grafana-other.example'),live.replace('.test/','.test:8443/'),live.replace('https:','http:'),
    live.replace('orgId=1','orgId=2'),live.replace('orgId=1&',''),live+'&orgId=2',
    live.replace('now-1h','now-2h'),live.replace('now-1m','now'),live+'&from=now-2h',
    live.replace('us%20east','eu'),live.replace('service=feed','service=other'),live+'&var-region=us+east',
    live+'&refresh=5s',live+'&viewPanel=2',live+'#other',live.replace('/new-title?','/new-title/settings?')
  ]) assert.equal(decide(saved,[{...tab,url:other}]).kind,'open',other);
});

test('query equivalence keeps repeated variable order, multiplicity and literal plus signs', () => {
  const base='https://grafana.example.test/d/UID/name?orgId=1';
  const key=aliases.grafanaKey;
  assert.equal(key(base+'&var-x=A&var-y=one&var-x=B'),key(base+'&var-y=one&var-x=A&var-x=B'));
  assert.notEqual(key(base+'&var-x=A&var-x=B'),key(base+'&var-x=B&var-x=A'));
  assert.notEqual(key(base+'&var-x=A'),key(base+'&var-x=A&var-x=A'));
  assert.notEqual(key(base+'&var-x=a%2Bb'),key(base+'&var-x=a+b'));
  assert.notEqual(key(base+'&var-x='),key(base));
  assert.notEqual(key(base+'#one'),key(base+'#two'));
  assert.equal(key(base+'&orgId=2'),null);
  assert.equal(key(base+'&var-x=%ZZ'),null);
});

test('unrecognized hosts, credentials and extra path segments never gain relaxed matching', () => {
  for (const value of [saved.replace('grafana.example.test','app.example.test'),
    saved.replace('grafana.example.test','grafana.example.test@other.test'),
    saved.replace('/old-title?','/old-title/settings?')]) {
    assert.equal(aliases.grafanaKey(value),null);
    assert.equal(decide(value,[{...tab,url:value.replace('old-title','new-title')}]).kind,'open');
  }
});

test('exact URLs win and force-new and copy retain the complete original bookmark URL', () => {
  const exact={...tab,tabId:'11',url:saved};
  assert.equal(decide(saved,[tab,exact]).tab.tabId,'11');
  assert.deepEqual(decide(saved,[tab],{forceNew:true}),{kind:'open',url:saved});
  const rows=aliases.items([bookmark],[tab],'monitor overview',true);
  assert.equal(rows.length,2);
  assert.equal(rows[0]._source,'opened-related');
  assert.equal(JSON.parse(rows[0].arg).tabId,'10');
  const stored=rows.find(row=>row._source==='bookmark');
  assert.equal(JSON.parse(stored.arg).url,saved);
  assert.equal(stored.mods.ctrl.arg,saved);
  assert.equal(JSON.parse(stored.mods.cmd.arg).url,saved);
  assert.equal(decide(saved,[tab],JSON.parse(stored.mods.cmd.arg)).kind,'open');
});

test('v10 aliases discover other views without permitting different-view bookmark reuse', () => {
  const changed={...tab,url:live.replace('now-1h','now-2h')};
  const rows=aliases.items([bookmark],[changed],'monitor overview',true);
  assert.equal(rows.length,2);
  assert.equal(JSON.parse(rows[0].arg).url,changed.url);
  assert.equal(decide(saved,[changed]).kind,'open');
  for (const url of [live.replace('/v10/d/','/d/'),live.replace('orgId=1','orgId=2'),live+'&orgId=2']) {
    assert.equal(aliases.items([bookmark],[{...tab,url}],'monitor overview',true).length,1);
  }
});
