import ctypes
import json
import pathlib
import socket
import subprocess
import tempfile
import threading
import time
import unittest

ROOT=pathlib.Path(__file__).parent

class WireTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.build=tempfile.TemporaryDirectory(prefix='chrome-timing-wire-')
        library=pathlib.Path(cls.build.name)/'client.dylib'
        subprocess.run(['clang','-O2','-dynamiclib',str(ROOT/'client.c'),'-o',str(library)],check=True)
        cls.lib=ctypes.CDLL(str(library))
        cls.lib.chrome_timing_exchange.argtypes=[ctypes.c_char_p,ctypes.c_char_p,ctypes.c_void_p,ctypes.c_int,ctypes.c_int]
        cls.lib.chrome_timing_exchange.restype=ctypes.c_int
    @classmethod
    def tearDownClass(cls):cls.build.cleanup()
    def exchange(self,path,message,timeout=12):
        buffer=ctypes.create_string_buffer(4096);start=time.monotonic()
        count=self.lib.chrome_timing_exchange(str(path).encode(),message,buffer,4096,timeout)
        return buffer.raw[:count],time.monotonic()-start
    def server(self,delay=0):
        path=pathlib.Path(self.build.name)/('s-'+str(time.monotonic_ns()))
        server=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);server.bind(str(path));server.listen(1)
        received=[]
        def serve():
            with server:
                client,_=server.accept()
                with client:
                    data=b''
                    while True:
                        chunk=client.recv(4096)
                        if not chunk:break
                        data+=chunk
                    received.append(json.loads(data))
                    if delay:time.sleep(delay)
                    try:
                        for byte in b'{"op":"verified"}\n':client.sendall(bytes([byte]))
                    except BrokenPipeError:pass
        thread=threading.Thread(target=serve);thread.start()
        return path,received,thread
    def test_partial_reply_and_unicode_payload_are_preserved(self):
        path,received,thread=self.server()
        payload={'type':'search_begin','data':{'query':'测试 "percent%"'}}
        reply,_=self.exchange(path,(json.dumps(payload)+'\n').encode())
        thread.join(1)
        self.assertEqual(json.loads(reply),{'op':'verified'});self.assertEqual(received,[payload])
    def test_unresponsive_collector_has_a_bounded_deadline(self):
        path,_,thread=self.server(.1)
        reply,elapsed=self.exchange(path,b'{}\n')
        self.assertEqual(reply,b'');self.assertLess(elapsed,.08)
        thread.join(1)
    def test_missing_collector_and_oversized_messages_are_nonfatal(self):
        path=pathlib.Path(self.build.name)/'missing'
        for message in [b'{}\n',b'x'*60001]:
            reply,elapsed=self.exchange(path,message)
            self.assertEqual(reply,b'');self.assertLess(elapsed,.08)

if __name__=='__main__':unittest.main()
