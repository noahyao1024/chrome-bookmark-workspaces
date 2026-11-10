const test = require('node:test');
const assert = require('node:assert/strict');
const aliases = require('./alias-core.js');
const bookmark = (title, url, path = 'Work / Duty') => ({title, url, path});

test('archived bookmarks rank after current bookmarks but remain searchable in English and Chinese', () => {
  const books = [bookmark('report', 'https://old.test/', 'Personal / Archive / Baidu'),
    bookmark('report live', 'https://current.test/')];
  const rows = aliases.items(books, [], 'report', true, {indexMode: true});
  assert.equal(JSON.parse(rows[0].arg).url, 'https://current.test/');
  assert.equal(rows[1]._archived, true);
  for (const query of ['archive', '归档']) {
    const archived = aliases.items(books, [], query, true);
    assert.equal(archived.length, 1);assert.equal(archived[0].title, 'report');
  }
});
test('open archive pages and URLs also bookmarked in active folders are not demoted', () => {
  const url = 'https://example.test/';
  const old = bookmark('saved', url, 'Personal / Archive / Old');
  const open = aliases.items([old], [{url, title: 'Page', tabId: '5', windowId: '1'}], '', true)[0];
  assert.equal(open._archived, false);assert.equal(JSON.parse(open.arg).tabId, '5');
  assert.equal(aliases.items([old], [{url, title: 'Page', tabId: '5', windowId: '1'}], '归档', true).length, 1);
  const mixed = aliases.items([old, bookmark('current', url)], [], '', true)[0];
  assert.equal(mixed._archived, false);
});
test('same-name traffic configurations show region, direction and cluster without changing actions', () => {
  const urls = ['https://example.test/config?zone=us-west-2&mode=Egress&service_cluster=default',
    'https://example.test/config?zone=us-east-1&mode=Ingress&service_cluster=8611'];
  const rows = aliases.items(urls.map(url => bookmark('traffic ttp rec', url)), [], '', true);
  assert.match(rows[0].subtitle, /us-west-2.*出站.*集群 default/);
  assert.match(rows[1].subtitle, /us-east-1.*入站.*集群 8611/);
  const selected = aliases.items(urls.map(url => bookmark('traffic ttp rec', url)), [], 'traffic 出站', true);
  assert.equal(selected.length, 1);assert.equal(JSON.parse(selected[0].arg).url, urls[0]);
  for (let i = 0; i < rows.length; i++) {
    assert.equal(rows[i].title, 'traffic ttp rec');assert.equal(JSON.parse(rows[i].arg).url, urls[i]);
    assert.equal(rows[i].mods.ctrl.arg, urls[i]);assert.equal(JSON.parse(rows[i].mods.cmd.arg).forceNew, true);
  }
});
test('repo home and commit list have clear labels, while unrelated names keep concise subtitles', () => {
  const rows = aliases.items([bookmark('git common', 'https://code.test/team/repo'),
    bookmark('git common', 'https://code.test/team/repo/commits/master'),
    bookmark('unique', 'https://code.test/other')], [], '', true);
  assert.match(rows[0].subtitle, /仓库首页/);assert.match(rows[1].subtitle, /提交记录/);
  assert.equal(rows[2].subtitle, '书签 · ↩ 打开 · Work / Duty');
});
test('unknown duplicate configurations remain distinguishable without exposing secret parameters', () => {
  const rows = aliases.items([bookmark('config', 'https://example.test/?token=SECRET_ONE'),
    bookmark('config', 'https://example.test/?token=SECRET_TWO')], [], '', true);
  assert.notEqual(rows[0].subtitle, rows[1].subtitle);
  for (const row of rows) assert.doesNotMatch(row.subtitle, /SECRET|token=/);
});
test('empty names and preserved same-URL aliases do not fail collision detection', () => {
  const rows = aliases.items([bookmark('', 'https://empty.test/'),
    bookmark('metrics eu ent', 'https://same.test/'), bookmark('metrics eu feed_api', 'https://same.test/')], [], '', true, {indexMode: true});
  assert.equal(rows.length, 2);assert.deepEqual(rows[1]._aliases, ['metrics eu ent', 'metrics eu feed_api']);
  assert.doesNotMatch(rows[1].subtitle, /保存视图/);
});
