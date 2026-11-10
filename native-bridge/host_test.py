import io
import json
import pathlib
import struct
import sys
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from host import Session, Handler, read_message, MAX_FRAME


class Chunked(io.BytesIO):
    def read(self, size=-1):
        return super().read(min(size, 2))


class HostTests(unittest.TestCase):
    def test_partial_native_frames_and_unicode(self):
        body=json.dumps({'text':'测试'}).encode()
        self.assertEqual(read_message(Chunked(struct.pack('<I',len(body))+body)),{'text':'测试'})

    def test_eof_and_oversized_frames(self):
        self.assertIsNone(read_message(io.BytesIO(b'')))
        with self.assertRaises(ValueError):read_message(io.BytesIO(struct.pack('<I',MAX_FRAME+1)))

    def test_ready_and_acknowledgement(self):
        session=Session(io.BytesIO());session.receive({'type':'ready'})
        sent=[]
        def send(obj):
            sent.append(obj)
            if obj['type']=='focus':session.receive({'type':'result','id':obj['id'],'result':{'kind':'focused','tabId':'10'}})
        session.send=send
        self.assertEqual(session.focus({'tabId':'10'})['kind'],'focused')
        self.assertEqual(session.jobs,{})

    def test_timeouts_cancel_and_never_allow_uncertain_retries(self):
        session=Session(io.BytesIO());session.ready=True;sent=[];session.send=sent.append
        result=session.focus({'tabId':'10'},timeout=.01)
        self.assertFalse(result['allowFallback']);self.assertEqual(sent[-1]['type'],'cancel');self.assertEqual(session.jobs,{})

    def test_requests_delayed_beyond_client_deadline_never_dispatch(self):
        session=Session(io.BytesIO());session.ready=True;sent=[];session.send=sent.append
        result=session.focus({'tabId':'10'},expires_at=1)
        self.assertEqual(result['reason'],'expired_before_dispatch');self.assertEqual(sent,[])

    def test_wrong_tab_acknowledgement_is_rejected(self):
        session=Session(io.BytesIO());session.ready=True
        session.send=lambda obj:session.receive({'type':'result','id':obj['id'],'result':{'kind':'focused','tabId':'99'}})
        self.assertEqual(session.focus({'tabId':'10'})['reason'],'invalid_ack')

    def test_disconnected_request_wakes_waiter_without_automatic_retry(self):
        session=Session(io.BytesIO());session.ready=True
        session.send=lambda obj:session.disconnect()
        self.assertFalse(session.focus({'tabId':'10'})['allowFallback'])

    def test_idless_resolution_requires_an_explicit_verified_match_ack(self):
        for match in ['resolved-url','gmail-mailbox','entry-bound','entry-exact','entry-unique',None]:
            session=Session(io.BytesIO());session.ready=True
            session.send=lambda obj:session.receive({'type':'result','id':obj['id'],'result':{'kind':'focused','tabId':'10','matchType':match}})
            result=session.focus({'version':1,'url':'https://mail.google.com/mail/u/0/#inbox'})
            self.assertEqual(result['kind'],'focused' if match else 'failed')

    def test_timeout_preserves_the_last_browser_phase(self):
        session=Session(io.BytesIO());session.ready=True
        def send(obj):
            if obj['type']=='focus':
                session.receive({'type':'progress','id':obj['id'],'stage':'received'})
                session.receive({'type':'progress','id':obj['id'],'stage':'select_tab'})
        session.send=send
        result=session.focus({'tabId':'10'},timeout=.01)
        self.assertEqual(result['reason'],'timeout')
        self.assertEqual(list(result['progressMs']),['received','select_tab'])
        self.assertFalse(result['allowFallback'])

    def test_entry_candidate_request_uses_the_read_only_message_type(self):
        session=Session(io.BytesIO());session.ready=True;sent=[]
        def send(obj):
            sent.append(obj)
            session.receive({'type':'result','id':obj['id'],'result':{'kind':'entries','targets':[]}})
        session.send=send
        self.assertEqual(session.focus({},request_type='entries')['kind'],'entries')
        self.assertEqual(sent[0]['type'],'entries')

    def test_ambiguous_entry_uses_a_nonfallback_status(self):
        handler=object.__new__(Handler)
        body=json.dumps({'version':1,'url':'https://example.test/team/issues'}).encode()
        handler.path='/focus';handler.headers={'Content-Length':str(len(body))};handler.rfile=io.BytesIO(body)
        result={'kind':'failed','reason':'ambiguous_entry','allowFallback':False}
        handler.server=SimpleNamespace(session=SimpleNamespace(focus=lambda *a,**kw:result))
        replies=[];handler.respond=lambda code,value:replies.append((code,value))
        with patch('host.log_record'):handler.do_POST()
        self.assertEqual(replies,[(422,result)])

    def test_index_is_profile_scoped_and_cleared_on_disconnect(self):
        session=Session(io.BytesIO());session.ready=True
        session.receive({'type':'search_index','index':{'profile':'Work','items':[]}})
        self.assertIsNone(session.index)
        session.receive({'type':'search_index','index':{'profile':'Default','items':[]}})
        self.assertEqual(session.index['kind'],'index')
        session.disconnect();self.assertIsNone(session.index)

    def test_group_status_is_read_only_and_organizing_requires_a_valid_window(self):
        handler=object.__new__(Handler);calls=[];replies=[]
        def request(payload,**kw):
            calls.append((payload,kw));return {'kind':'groups_state','groups':[],'tabs':[]}
        handler.server=SimpleNamespace(session=SimpleNamespace(focus=request))
        handler.respond=lambda code,value:replies.append((code,value))
        handler.path='/groups';handler.do_GET()
        self.assertEqual(calls[0][1]['request_type'],'groups_state')
        self.assertEqual(replies[0][0],200)
        handler.path='/groups/organize';body=b'{"windowId":-1}'
        handler.headers={'Content-Length':str(len(body))};handler.rfile=io.BytesIO(body)
        handler.do_POST();self.assertEqual(replies[-1][0],400);self.assertEqual(len(calls),1)

    def test_created_ack_must_confirm_requested_url_and_an_id(self):
        for response,valid in [({'kind':'opened','requestedURL':'https://example.test/a','tabId':'10'},True),
                               ({'kind':'opened','requestedURL':'https://example.test/b','tabId':'10'},False),
                               ({'kind':'opened','requestedURL':'https://example.test/a'},False)]:
            session=Session(io.BytesIO());session.ready=True
            session.send=lambda obj:session.receive({'type':'result','id':obj['id'],'result':response})
            result=session.focus({'version':1,'url':'https://example.test/a'},request_type='activate')
            self.assertEqual(result['kind']=='opened',valid)


if __name__=='__main__':unittest.main()
