import http.server
import json
import os
from pathlib import Path
import socketserver
import socket
import sqlite3
import subprocess
import tempfile
import threading
import unittest

ROOT = Path(__file__).parent


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


class Tests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='chrome-native-', dir='/tmp')
        self.root = Path(self.temp.name)
        (self.root/'alias-config.json').write_text('{"profile":"Default"}')
        stub = self.root/'chrome-alias.js'
        stub.write_text('#!/usr/bin/python3\nimport json,sys\nfrom pathlib import Path\n'
                        'with Path("adapter-calls").open("a") as f:f.write(sys.argv[1]+"\\n")\n'
                        'print(json.dumps({"kind":"opened","items":[]}))\n')
        stub.chmod(0o700)
        self.index = {'kind':'index','profile':'Default','items':[{'title':'Saved alias',
            'match':'saved alias','valid':True,'arg':json.dumps({'version':1,'url':'https://example.test/a'}),
            '_source':'bookmark','text':{'copy':'https://example.test/a'}}]}
        self.code = 200
        self.action = {'kind':'opened','tabId':'10','requestedURL':'https://example.test/a'}
        self.requests = []
        self.drop_response = False
        owner = self
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def answer(self):
                body = self.rfile.read(int(self.headers.get('Content-Length','0')))
                owner.requests.append((self.path,dict(self.headers),json.loads(body) if body else None))
                if owner.drop_response:return
                value = owner.index if self.path == '/index' else owner.action
                data = json.dumps(value).encode()
                self.send_response(owner.code);self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
            do_GET = answer
            do_POST = answer
        self.server=Server(str(self.root/'native.sock'),Handler)
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
        self.env={**os.environ,'chrome_alias_native_socket':str(self.root/'native.sock'),
                  'chrome_alias_diagnostics_disabled':'1','alfred_workflow_cache':str(self.root/'cache')}
        for key in ['chrome_alias_session','chrome_alias_primed']:self.env.pop(key,None)

    def tearDown(self):
        self.server.shutdown();self.server.server_close();self.temp.cleanup()

    def run_launcher(self,*args):
        return subprocess.run([str(ROOT/'chrome-launcher'),*args],cwd=self.root,env=self.env,capture_output=True,text=True,timeout=3)

    def test_new_invocations_read_live_index_without_prime_or_jxa(self):
        first=json.loads(self.run_launcher('').stdout)
        self.assertNotIn('rerun',first)
        self.assertEqual(first['items'][1]['title'],'Saved alias')
        self.index['items'][0]['title']='Renamed alias'
        second=json.loads(self.run_launcher('').stdout)
        self.assertEqual(second['items'][1]['title'],'Renamed alias')
        self.assertFalse((self.root/'adapter-calls').exists())

    def test_native_open_preserves_full_url_profile_and_force_new(self):
        payload={'version':1,'url':'https://example.test/a?a=1#x','forceNew':True}
        self.action.update(requestedURL=payload['url'])
        result=self.run_launcher('--activate',json.dumps(payload))
        self.assertEqual(result.returncode,0)
        self.assertEqual(self.requests[0][0],'/activate')
        self.assertEqual(self.requests[0][1]['X-Chrome-Profile'],'Default')
        self.assertEqual(self.requests[0][2],payload)
        self.assertFalse((self.root/'adapter-calls').exists())

    def test_definite_miss_falls_back_but_timeout_never_creates_again(self):
        payload=json.dumps({'version':1,'url':'https://example.test/a'})
        self.code=409;self.action={'kind':'miss','reason':'not_ready','allowFallback':True}
        self.assertEqual(self.run_launcher('--activate',payload).returncode,0)
        self.assertEqual((self.root/'adapter-calls').read_text(),'activate\n')
        (self.root/'adapter-calls').unlink()
        self.code=504;self.action={'kind':'failed','reason':'timeout','allowFallback':False}
        self.assertNotEqual(self.run_launcher('--activate',payload).returncode,0)
        self.assertEqual((self.root/'adapter-calls').read_text(),'notify\n')

    def test_other_profile_index_is_not_used(self):
        self.index['profile']='Work'
        result=json.loads(self.run_launcher('').stdout)
        self.assertIn('rerun',result)
        self.assertEqual(len(result['items']),1)

    def test_native_index_keeps_history_search_and_ten_result_limit(self):
        first=json.loads(self.run_launcher('').stdout)
        session=first['variables']['chrome_alias_session']
        directory=self.root/'cache'/'search-sessions'/(session+'.history');directory.mkdir()
        with sqlite3.connect(directory/'History') as db:
            db.execute('CREATE TABLE urls (url TEXT,title TEXT,last_visit_time INTEGER,hidden INTEGER)')
            db.executemany('INSERT INTO urls VALUES (?,?,?,?)',[(f'https://history.test/{i}','History needle',i,0) for i in range(20)])
        (directory/'.snapshot-ready').touch()
        self.env['chrome_alias_session']=session
        result=json.loads(self.run_launcher('needle').stdout)
        self.assertEqual(sum(bool(row.get('_history')) for row in result['items']),10)
        self.assertFalse(any(row.get('valid') is False for row in result['items']))

    def test_unsafe_action_never_reaches_browser_or_fallback(self):
        result=self.run_launcher('--activate',json.dumps({'version':1,'url':'javascript:alert(1)'}))
        self.assertNotEqual(result.returncode,0);self.assertEqual(self.requests,[])
        self.assertFalse((self.root/'adapter-calls').exists())

    def test_lost_ack_never_retries_but_connection_refusal_is_safe_to_fallback(self):
        payload=json.dumps({'version':1,'url':'https://example.test/a'})
        self.drop_response=True
        self.assertNotEqual(self.run_launcher('--activate',payload).returncode,0)
        self.assertEqual((self.root/'adapter-calls').read_text(),'notify\n')
        (self.root/'adapter-calls').unlink()
        dead=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);dead.bind(str(self.root/'dead.sock'));dead.close()
        self.env['chrome_alias_native_socket']=str(self.root/'dead.sock')
        self.assertEqual(self.run_launcher('--activate',payload).returncode,0)
        self.assertEqual((self.root/'adapter-calls').read_text(),'activate\n')


if __name__=='__main__':unittest.main()
