import json
import pathlib
import subprocess
import tempfile
import unittest
import urllib.parse
import sqlite3
import os

ROOT = pathlib.Path(__file__).parent


class LauncherTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.index = pathlib.Path(self.temp.name) / 'index.json'
        self.url = 'https://example.test/metrics?region=us-east-1&psm=feed&a=x,y#view'
        self.payload = {'version': 1, 'url': self.url, 'tabId': '20', 'windowId': '10'}
        self.index.write_text(json.dumps({'items': [{
            'title': 'metrics row feed_api / metrics eu ent',
            'match': 'metrics row feed_api metrics eu ent work duty service monitoring ' + self.url.lower(),
            'subtitle': '已打开', 'arg': json.dumps(self.payload), 'valid': True, '_source': 'opened-bookmark',
            'text': {'copy': self.url},
            'mods': {'ctrl': {'arg': self.url}, 'cmd': {'arg': json.dumps({**self.payload, 'forceNew': True})}}
        }]}))

    def tearDown(self):
        self.temp.cleanup()

    def rows(self, query, history=None):
        return json.loads(subprocess.check_output([str(ROOT / 'chrome-launcher'), '--test-index', str(self.index), query] + ([str(history)] if history else [])))['items']

    def history(self, entries):
        path = pathlib.Path(self.temp.name) / 'History'
        with sqlite3.connect(path) as db:
            db.execute('CREATE TABLE urls (url TEXT, title TEXT, last_visit_time INTEGER, hidden INTEGER)')
            db.executemany('INSERT INTO urls VALUES (?,?,?,?)', entries)
        return path

    def test_history_deduplicates_and_preserves_alias_when_historical_title_matches(self):
        history = self.history([(self.url, 'Old Dashboard', 13400000000000000, 0)])
        rows = self.rows('old dashboard', history)
        self.assertEqual(len(rows), 2)
        self.assertEqual(json.loads(rows[0]['arg']), self.payload)
        self.assertIn('metrics eu ent', rows[0]['title'])
        self.assertNotIn('_history', rows[0])

    def test_history_ranks_after_bookmarks_and_keeps_region_urls_distinct(self):
        other = self.url.replace('us-east-1', 'eu-central-1')
        history = self.history([(other, 'metrics', 13400000000000000, 0)])
        rows = self.rows('metrics', history)
        self.assertEqual(json.loads(rows[0]['arg']), self.payload)
        self.assertEqual(json.loads(rows[2]['arg'])['url'], other)
        self.assertTrue(rows[2]['_history'])
        self.assertTrue(rows[2]['subtitle'].startswith('历史 · '))
        self.assertEqual(rows[2]['mods']['ctrl']['arg'], other)
        self.assertTrue(json.loads(rows[2]['mods']['cmd']['arg'])['forceNew'])

        self.assertEqual(rows[1]['variables']['chrome_result_type'], 'search')

    def test_history_searches_chinese_and_literal_wildcards_safely(self):
        history = self.history([('https://history.test/a?x=1,2#p', "监控 100%_test O'Reilly", 13400000000000000, 0),
                                ('https://history.test/b', '监控 100XXtest', 13400000000000000, 0)])
        for query in ["监控 100%_test", "O'Reilly"]:
            rows = self.rows(query, history)
            self.assertEqual(len(rows), 2)
            self.assertEqual(json.loads(rows[1]['arg'])['url'], 'https://history.test/a?x=1,2#p')

    def test_history_omits_hidden_unsafe_and_empty_input_results(self):
        history = self.history([('https://history.test/hidden', 'hidden', 1, 1),
                                ('javascript:alert(1)', 'unsafe', 1, 0),
                                ('https://history.test/visible', 'visible', 1, 0)])
        self.assertEqual(len(self.rows('hidden', history)), 1)
        self.assertEqual(len(self.rows('unsafe', history)), 1)
        self.assertEqual(len(self.rows('', history)), 2)

    def test_history_is_recent_first_and_capped_after_searching_all_rows(self):
        history = self.history([(f'https://history.test/{i}', 'report', i, 0) for i in range(80)])
        rows = self.rows('report', history)
        self.assertEqual(len(rows), 6)
        self.assertEqual(rows[0]['variables']['chrome_result_type'], 'search')
        self.assertEqual(json.loads(rows[1]['arg'])['url'], 'https://history.test/79')
        self.assertEqual(json.loads(rows[-1]['arg'])['url'], 'https://history.test/75')

    def test_history_limit_applies_after_relevance_ranking_and_alias_merge(self):
        history = self.history([(f'https://history.test/{i}', 'report details', i, 0) for i in range(80)] +
                               [('https://history.test/exact', 'report', 35, 0),
                                (self.url, 'report old dashboard', 36, 0)])
        rows = self.rows('report', history)
        self.assertEqual(json.loads(rows[0]['arg']), self.payload)
        self.assertIn('metrics eu ent', rows[0]['title'])
        self.assertEqual(rows[1]['variables']['chrome_result_type'], 'search')
        self.assertEqual(json.loads(rows[2]['arg'])['url'], 'https://history.test/exact')
        self.assertEqual(sum(bool(row.get('_history')) for row in rows), 5)
        self.assertEqual(len(rows), 7)

    def test_missing_history_keeps_bookmarks_and_fallback_available(self):
        rows = self.rows('metrics', pathlib.Path(self.temp.name)/'missing')
        self.assertEqual(json.loads(rows[0]['arg']), self.payload)
        self.assertTrue(any(row.get('valid') is False for row in rows))
        self.assertEqual(urllib.parse.parse_qs(urllib.parse.urlsplit(json.loads(rows[1]['arg'])['url']).query)['q'], ['metrics'])

        self.assertFalse(rows[-1]['valid'])

    def test_snapshot_reads_locked_database_and_wal_without_changing_source(self):
        for wal in [False, True]:
            with self.subTest(wal=wal), tempfile.TemporaryDirectory() as directory:
                source = pathlib.Path(directory)/'source';source.mkdir()
                db = sqlite3.connect(source/'History')
                db.execute('PRAGMA locking_mode=EXCLUSIVE')
                if wal: db.execute('PRAGMA journal_mode=WAL')
                db.execute('CREATE TABLE urls (url TEXT, title TEXT, last_visit_time INTEGER, hidden INTEGER)')
                db.execute('INSERT INTO urls VALUES (?,?,?,?)', ('https://history.test/wal', 'committed', 1, 0));db.commit()
                before = {p.name:p.read_bytes() for p in source.iterdir()}
                target=pathlib.Path(directory)/'snapshot'
                result=json.loads(subprocess.check_output([str(ROOT/'chrome-launcher'),'--test-snapshot',str(source),str(target)]))
                self.assertEqual(pathlib.Path(result['database']),target/'History')
                self.assertEqual(len(self.rows('committed',target/'History')),2)
                self.assertEqual(before,{p.name:p.read_bytes() for p in source.iterdir()})
                self.assertEqual(target.stat().st_mode & 0o777, 0o700)
                db.close()

    def test_empty_input_new_tab_is_first_and_never_reuses(self):
        rows = self.rows('  ')
        self.assertEqual(json.loads(rows[0]['arg']), {'version': 1, 'url': 'chrome://newtab/', 'forceNew': True})
        self.assertEqual(json.loads(rows[1]['arg']), self.payload)

    def test_alias_matches_preserve_live_tab_identity_and_modifiers(self):
        for query in ['eu ent', 'monitoring', 'work duty', 'feed_api']:
            rows = self.rows(query)
            self.assertEqual(json.loads(rows[0]['arg']), self.payload)
            self.assertEqual(rows[0]['mods']['ctrl']['arg'], self.url)
            self.assertTrue(json.loads(rows[0]['mods']['cmd']['arg'])['forceNew'])
            self.assertEqual(urllib.parse.parse_qs(urllib.parse.urlsplit(json.loads(rows[-1]['arg'])['url']).query)['q'], [query])

    def test_grafana_alias_displays_only_the_matching_saved_name(self):
        long_name = 'Complete service monitoring dashboard / Operations'
        short_name = 'monitor overview'
        live_url = 'https://grafana.example.test/v10/d/UID/current-title?orgId=1'
        saved_url = live_url.replace('current-title', 'old-title')
        data = {'bookmarks': [
            {'title': long_name, 'url': live_url, 'path': 'Work / Monitor'},
            {'title': short_name, 'url': saved_url, 'path': 'Work / Monitor'}],
            'tabs': [{'title': 'Website title', 'url': live_url, 'tabId': '20', 'windowId': '10'}]}
        script = "const a=require('./alias-core.js');let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{const d=JSON.parse(s);console.log(JSON.stringify({items:a.items(d.bookmarks,d.tabs,'',true,{indexMode:true})}));});"
        self.index.write_text(subprocess.check_output(['node', '-e', script], input=json.dumps(data), text=True, cwd=ROOT))
        for query, expected in [('monitor overview', short_name), ('MONITOR OVER', short_name),
                                ('complete service', long_name), ('work monitor', long_name), ('', long_name)]:
            row = self.rows(query)[0 if query else 1]
            self.assertEqual(row['title'], expected)
            self.assertEqual(json.loads(row['arg']), {**self.payload, 'url': live_url})
            self.assertEqual(row['text']['copy'], live_url)
            self.assertEqual(row['text']['largetype'], expected + '\n' + live_url)
            self.assertEqual(row['mods']['ctrl']['arg'], live_url)
            self.assertEqual(json.loads(row['mods']['cmd']['arg']), {**self.payload, 'url': live_url, 'forceNew': True})

        # A pre-update cached row may still contain a joined title.
        index = json.loads(self.index.read_text())
        index['items'][0]['title'] = long_name + ' / ' + short_name
        self.index.write_text(json.dumps(index))
        self.assertEqual(self.rows(short_name)[0]['title'], short_name)


    def test_unmatched_text_searches_without_go_prefix(self):
        rows = self.rows('你好 C++ & why?')
        self.assertEqual(len(rows), 1)
        url = json.loads(rows[0]['arg'])['url']
        self.assertEqual(urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)['q'], ['你好 C++ & why?'])

    def test_exact_urls_preserve_query_and_do_not_force_duplicate(self):
        rows = self.rows(self.url)
        self.assertEqual(len(rows), 1)
        self.assertEqual(json.loads(rows[0]['arg']), self.payload)
        self.assertEqual(rows[0]['mods']['ctrl']['arg'], self.url)

    def test_bare_domains_and_local_development_urls(self):
        for query, url in [('example.com/a?x=1#test', 'https://example.com/a?x=1#test'),
                           ('localhost:8080/app', 'http://localhost:8080/app'),
                           ('127.0.0.1:3000', 'http://127.0.0.1:3000'),
                           ('[::1]:3000', 'http://[::1]:3000')]:
            self.assertEqual(json.loads(self.rows(query)[-1]['arg'])['url'], url)

    def test_numbers_and_arithmetic_remain_literal_google_searches(self):
        for query in ['1+2','1.2','1.2+3.4','123','1/2','(1 + 2) * 3','2026-11-10']:
            row=self.rows(query)[0]
            self.assertEqual(row['variables']['chrome_result_type'],'search')
            self.assertEqual(urllib.parse.parse_qs(urllib.parse.urlsplit(json.loads(row['arg'])['url']).query)['q'],[query])
            self.assertEqual(row['title'],query)
        self.assertEqual(json.loads(self.rows('192.168.1.5')[0]['arg'])['url'],'https://192.168.1.5')

    def test_numeric_search_precedes_similar_history_results(self):
        history=self.history([('https://example.test/old','Old 1+2+3 result',13400000000000000,0)])
        rows=self.rows('1+2',history)
        self.assertEqual(rows[0]['variables']['chrome_result_type'],'search')
        self.assertTrue(rows[1]['_history'])
        self.assertEqual(urllib.parse.parse_qs(urllib.parse.urlsplit(json.loads(rows[0]['arg'])['url']).query)['q'],['1+2'])

    def test_archived_bookmarks_follow_current_results_and_keep_history_limit(self):
        self.index.write_text(json.dumps({'items':[
            {'title':'report','match':'report archive 归档','subtitle':'书签 · ↩ 打开 · Personal / Archive',
             '_archived':True,'arg':json.dumps({'version':1,'url':'https://old.test/'}),'valid':True},
            {'title':'report current','match':'report current','subtitle':'书签 · ↩ 打开 · Work',
             '_archived':False,'arg':json.dumps({'version':1,'url':'https://current.test/'}),'valid':True}]}))
        history=self.history([(f'https://history.test/{i}','report',i,0) for i in range(20)])
        rows=self.rows('report',history)
        self.assertEqual(rows[0]['title'],'report current')
        self.assertEqual(rows[1]['title'],'report');self.assertTrue(rows[1]['subtitle'].startswith('归档'))
        self.assertNotIn('_archived',rows[1]);self.assertEqual(sum(bool(r.get('_history')) for r in rows),5)
        self.assertEqual(self.rows('归档')[0]['title'],'report')

    def test_unsafe_scheme_is_not_executed(self):
        row = self.rows('javascript:alert(1)')[-1]
        self.assertTrue(json.loads(row['arg'])['url'].startswith('https://www.google.com/search?'))

    def test_full_width_and_case_insensitive_queries(self):
        self.assertEqual(json.loads(self.rows('ＭＥＴＲＩＣＳ EU ENT')[0]['arg']), self.payload)

    def test_open_dashboard_alias_ranks_with_individual_aliases_and_keeps_current_url(self):
        saved='https://grafana.example.test/d/dashboard-A/overview?orgId=1&var-VRegion=SG'
        current=saved.replace('SG','eu-west-2')
        self.index.write_text(json.dumps({'items':[
            {'title':'another alias / dashboard shortcut','match':'another alias dashboard shortcut',
             '_aliases':['another alias','dashboard shortcut'],'_source':'opened-related','valid':True,
             'arg':json.dumps({'version':1,'url':current,'tabId':'20','windowId':'10'})},
            {'title':'dashboard shortcut','match':'dashboard shortcut','_aliases':['dashboard shortcut'],
             '_source':'bookmark','valid':True,'arg':json.dumps({'version':1,'url':saved})}
        ]}))
        rows=self.rows('dashboard shortcut')
        self.assertEqual(len(rows),3)
        self.assertEqual(rows[0]['icon']['path'],'result-icons/opened.png')
        self.assertEqual(json.loads(rows[0]['arg'])['url'],current)
        self.assertEqual(json.loads(rows[0]['arg'])['tabId'],'20')
        self.assertEqual(json.loads(rows[1]['arg'])['url'],saved)

    def test_typing_with_prime_variables_reuses_the_initial_snapshot(self):
        folder=pathlib.Path(self.temp.name)
        stub=folder/'chrome-alias.js'
        stub.write_text('#!/bin/sh\nprintf x >> snapshot-count\nprintf \'%s\\n\' \'{"items":[]}\'\n')
        stub.chmod(0o700)
        env={k:v for k,v in os.environ.items() if not k.startswith('chrome_alias_')}
        env['alfred_workflow_cache']=str(folder/'cache')
        env['chrome_alias_native_socket']=''
        env['chrome_alias_diagnostics_disabled']='1'
        def launch(query,variables):
            return json.loads(subprocess.check_output([str(ROOT/'chrome-launcher'),query],cwd=folder,env={**env,**variables}))
        prime=launch('',{})
        variables=prime['variables']
        self.assertIn('chrome_alias_session',variables)
        initial=launch('',variables)
        # Alfred may already have queued keystrokes with the prime variables.
        typed=launch('gmail',variables)
        self.assertEqual((folder/'snapshot-count').read_text(),'x')
        self.assertEqual(initial['variables']['chrome_alias_session'],variables['chrome_alias_session'])
        self.assertEqual(typed['variables']['chrome_alias_session'],variables['chrome_alias_session'])

    def test_output_omits_large_internal_match_text_after_filtering(self):
        rows=self.rows('metrics')
        self.assertNotIn('match',rows[0])
        self.assertNotIn('_aliases',rows[0])
        self.assertEqual(json.loads(rows[0]['arg']),self.payload)

    def test_type_order_precedes_relevance_and_keeps_short_titles_and_actions(self):
        sources = [('bookmark', 'report', False), ('opened', 'Page title', False),
                   ('opened-bookmark', 'report details', False), ('opened-related', 'report', False),
                   ('bookmark', 'report', True), ('bookmark', 'report notes', False)]
        items = []
        for i, (source, title, archived) in enumerate(sources):
            url = f'https://example.test/page/{i}'
            payload = {'version': 1, 'url': url}
            if source.startswith('opened'):
                payload.update(tabId=str(i + 1), windowId='10')
            items.append({'title': title, '_aliases': [title], '_source': source, '_archived': archived,
                          'match': title.lower() + ' report work', 'valid': True,
                          'arg': json.dumps(payload), 'text': {'copy': url},
                          'mods': {'ctrl': {'arg': url}, 'cmd': {'arg': json.dumps({**payload, 'forceNew': True})}}})
        items.append({'title': 'unrelated', 'match': 'unrelated', '_source': 'opened', 'valid': True})
        self.index.write_text(json.dumps({'items': items}))
        history = self.history([(f'https://history.test/{i}', 'report', i, 0) for i in range(9)])
        rows = self.rows('report', history)
        self.assertEqual([r['variables']['chrome_result_type'] for r in rows],
                         ['opened-related', 'opened-bookmark', 'opened', 'bookmark', 'bookmark', 'bookmark', 'search'] + ['history'] * 5)
        for row, original in zip(rows[:6], [items[i] for i in [3, 2, 1, 0, 5, 4]]):
            self.assertEqual(row['title'], original['title'])
            self.assertEqual(row['arg'], original['arg'])
            self.assertEqual(row['mods'], original['mods'])
        self.assertEqual([json.loads(row['arg'])['url'] for row in rows[-5:]],
                         [f'https://history.test/{i}' for i in range(8, 3, -1)])

    def test_exact_url_merging_keeps_open_bookmarks_above_search_and_history(self):
        opened = 'https://example.test/report?region=one'
        saved = 'https://example.test/report?region=two'
        data = {'bookmarks': [{'title': 'report current', 'url': opened, 'path': 'Work'},
                              {'title': 'report alias', 'url': opened, 'path': 'Work'},
                              {'title': 'report saved', 'url': saved, 'path': 'Work'}],
                'tabs': [{'title': 'Page title', 'url': opened, 'tabId': '20', 'windowId': '10'}]}
        script = "const a=require('./alias-core.js');let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{const d=JSON.parse(s);console.log(JSON.stringify({items:a.items(d.bookmarks,d.tabs,'',true,{indexMode:true})}));});"
        self.index.write_text(subprocess.check_output(['node', '-e', script], input=json.dumps(data), text=True, cwd=ROOT))
        history = self.history([(opened, 'report old name', 100, 0), (saved, 'report old saved', 99, 0)] +
                               [(f'https://history.test/{i}', 'report', i, 0) for i in range(9)])
        rows = self.rows('report', history)
        self.assertEqual([r['variables']['chrome_result_type'] for r in rows], ['opened-bookmark', 'bookmark', 'search'] + ['history'] * 5)
        urls = [json.loads(r['arg'])['url'] for r in rows]
        self.assertEqual(len(urls), len(set(urls)))
        self.assertEqual(json.loads(rows[0]['arg']), {'version': 1, 'url': opened, 'tabId': '20', 'windowId': '10'})
        self.assertEqual(json.loads(rows[1]['arg'])['url'], saved)
        self.assertEqual(self.rows('report alias', history)[0]['title'], 'report alias')

    def test_address_duplicate_is_removed_before_history_limit_but_entries_stay_distinct(self):
        query = 'report'
        search_url = json.loads(self.rows(query)[0]['arg'])['url']
        self.index.write_text(json.dumps({'items': []}))
        history = self.history([(search_url, 'report', 100, 0)] +
                               [(f'https://history.test/{i}', 'report', i, 0) for i in range(9)])
        rows = self.rows(query, history)
        self.assertEqual(len(rows), 6)
        self.assertEqual(rows[0]['variables']['chrome_result_type'], 'search')
        self.assertEqual(sum(r.get('_history', False) for r in rows), 5)
        self.assertEqual(sum(json.loads(r['arg'])['url'] == search_url for r in rows), 1)

        url = 'https://app.example.test/team/issues'
        payload = {'version': 1, 'url': url, 'entryId': 'workspace', 'entryURL': url, 'tabId': '20', 'windowId': '10'}
        self.index.write_text(json.dumps({'items': [{'title': 'Workspace', 'match': url, 'valid': True,
            '_source': 'opened-related', '_entry': True, 'arg': json.dumps(payload), 'text': {'copy': url}}]}))
        rows = self.rows(url)
        self.assertEqual(len(rows), 2)
        self.assertEqual(json.loads(rows[0]['arg']), payload)
        self.assertNotIn('entryId', json.loads(rows[1]['arg']))

    def test_numeric_and_empty_input_keep_their_first_action(self):
        search_url = json.loads(self.rows('1+2')[0]['arg'])['url']
        self.index.write_text(json.dumps({'items': [
            {'title': '1+2', 'match': '1+2', 'valid': True, '_source': 'opened',
             'arg': json.dumps({'version': 1, 'url': search_url, 'tabId': '20', 'windowId': '10'}), 'text': {'copy': search_url}},
            {'title': '1+2 notes', 'match': '1+2 notes', 'valid': True, '_source': 'bookmark',
             'arg': json.dumps({'version': 1, 'url': 'https://example.test/notes'})}
        ]}))
        rows = self.rows('1+2')
        self.assertEqual([r['variables']['chrome_result_type'] for r in rows], ['search', 'bookmark'])
        self.assertEqual(rows[0]['title'], '1+2')
        new_tab = {'version': 1, 'url': 'chrome://newtab/', 'tabId': '30', 'windowId': '10'}
        self.index.write_text(json.dumps({'items': [{'title': 'New tab', 'match': '', '_source': 'opened', 'valid': True,
            'arg': json.dumps(new_tab), 'text': {'copy': new_tab['url']}}]}))
        rows = self.rows('')
        self.assertEqual(len(rows), 2)
        self.assertTrue(json.loads(rows[0]['arg'])['forceNew'])
        self.assertEqual(json.loads(rows[1]['arg']), new_tab)

    def test_address_stays_available_when_equal_bookmark_is_beyond_display_limit(self):
        url = 'https://example.test/target'
        self.index.write_text(json.dumps({'items': [
            {'title': 'Saved page', 'match': url, 'valid': True, '_source': 'bookmark',
             'arg': json.dumps({'version': 1, 'url': f'https://example.test/{i}'}),
             'text': {'copy': f'https://example.test/{i}'}} for i in range(150)
        ] + [{'title': 'Another page', 'match': url, 'valid': True, '_source': 'bookmark',
              'arg': json.dumps({'version': 1, 'url': url}), 'text': {'copy': url}}]}))
        rows = self.rows(url)
        self.assertEqual(len(rows), 151)
        self.assertEqual(rows[-1]['variables']['chrome_result_type'], 'url')
        self.assertEqual(json.loads(rows[-1]['arg'])['url'], url)

    def test_historical_deep_link_title_keeps_the_exact_action_over_a_shared_entry(self):
        deep='https://app.example.test/team/issues/TASK-75'
        exact={'version':1,'url':deep,'tabId':'20','windowId':'10'}
        entry={**exact,'entryId':'project-work','entryURL':'https://app.example.test/team/issues'}
        self.index.write_text(json.dumps({'items':[
            {'title':'Current issue title','match':'current issue title','valid':True,'_source':'opened',
             'arg':json.dumps(exact),'text':{'copy':deep}},
            {'title':'Project Work','match':'project work','valid':True,'_source':'opened-related','_entry':True,
             'arg':json.dumps(entry),'text':{'copy':deep}}
        ]}))
        history=self.history([(deep,'Old issue title',13400000000000000,0)])
        rows=self.rows('old issue title',history)
        self.assertEqual(json.loads(rows[0]['arg']),exact)
        self.assertNotIn('entryId',json.loads(rows[0]['arg']))


if __name__ == '__main__':
    unittest.main()
