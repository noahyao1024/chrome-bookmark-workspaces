"""Profile-scoped Chrome index and activation over a private Unix socket."""
import fcntl
import http.server
import json
import os
import pathlib
import re
import socketserver
import socket
import struct
import sys
import threading
import time
import uuid

SOCKET_DIR = pathlib.Path.home() / 'Library/Caches/BookmarkWorkspaces'
SOCKET_PATH = SOCKET_DIR / 'native.sock'
LOG_DIR = pathlib.Path.home() / 'Library/Logs/BookmarkWorkspaces'
MAX_FRAME = 4 * 1024 * 1024
def configured_profile():
    path = pathlib.Path(__file__).with_name('alias-config.json')
    if not path.exists():
        return 'Default'
    value = json.loads(path.read_text()).get('profile')
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9 _.-]+', value) or value in ('.', '..'):
        raise ValueError('Invalid native-host profile configuration')
    return value


PROFILE = configured_profile()


def send_timing(data):
    """Transient local IPC only: never persist URL/title data in timing logs."""
    path = SOCKET_DIR / 'timing.sock'
    if not path.exists():
        return
    try:
        message = {'type': 'browser_event', 'atNs': str(time.monotonic_ns()), 'data': data}
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(0.01)
            client.connect(str(path))
            client.sendall((json.dumps(message, separators=(',', ':')) + '\n').encode())
    except (OSError, ValueError):
        pass


def read_exact(stream, size):
    chunks = bytearray()
    while len(chunks) < size:
        data = stream.read(size - len(chunks))
        if not data:
            return None
        chunks.extend(data)
    return bytes(chunks)


def read_message(stream):
    header = read_exact(stream, 4)
    if header is None:
        return None
    size = struct.unpack('<I', header)[0]
    if size > MAX_FRAME:
        raise ValueError('oversized native frame')
    body = read_exact(stream, size)
    if body is None:
        return None
    return json.loads(body)


class Session:
    def __init__(self, output):
        self.output = output
        self.write_lock = threading.Lock()
        self.lock = threading.Lock()
        self.jobs = {}
        self.ready = False
        self.version = 1
        self.index = None
        self.index_wire = None
        self.alias_signature = None

    def configure_search(self):
        path = pathlib.Path.home() / 'Library/Application Support/BookmarkWorkspaces/search-aliases.json'
        try:
            raw = path.read_bytes()
            signature = hash(raw)
            value = json.loads(raw)
            aliases = value.get('profiles', {}).get(PROFILE, []) if value.get('version') == 1 else []
        except (OSError, ValueError, TypeError):
            signature, aliases = 0, []
        if signature != self.alias_signature:
            self.alias_signature = signature
            self.index = None
            self.index_wire = None
            self.send({'type': 'configure_search', 'profile': PROFILE, 'aliases': aliases})

    def send(self, obj):
        data = json.dumps(obj, separators=(',', ':')).encode('utf-8')
        with self.write_lock:
            self.output.write(struct.pack('<I', len(data)) + data)
            self.output.flush()

    def receive(self, obj):
        if obj.get('type') == 'timing_event':
            if isinstance(obj.get('data'), dict):
                send_timing(obj['data'])
            return
        if obj.get('type') == 'ready':
            self.ready = obj.get('profile', PROFILE) == PROFILE
            self.version = obj.get('version', 1)
            if self.ready and self.version >= 2:
                self.configure_search()
            return
        if obj.get('type') == 'search_index':
            index = obj.get('index', {})
            if self.ready and index.get('profile') == PROFILE and isinstance(index.get('items'), list):
                value = {**index, 'kind': 'index', 'receivedAt': int(time.time()*1000)}
                wire = json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode()
                self.index_wire = wire
                self.index = value
            return
        if obj.get('type') not in ('result', 'progress'):
            return
        with self.lock:
            job = self.jobs.get(obj.get('id'))
            if job:
                if obj['type'] == 'progress':
                    stage = obj.get('stage')
                    if stage in ('received', 'resolve_entry', 'query_tabs', 'validate_tab', 'get_window', 'foreground_window', 'select_tab', 'expand_group', 'choose_window', 'create_tab'):
                        job['progress'][stage] = round((time.perf_counter() - job['started']) * 1000, 2)
                    return
                job['result'] = obj.get('result', {})
                job['done'].set()

    def focus(self, payload, timeout=0.8, expires_at=None, request_type='focus', timing_operation=None):
        if not self.ready:
            return {'kind': 'miss', 'reason': 'not_ready', 'allowFallback': True}
        expires_at = expires_at or int((time.time() + timeout) * 1000)
        remaining = min(timeout, expires_at / 1000 - time.time())
        if remaining <= 0:
            return {'kind': 'failed', 'reason': 'expired_before_dispatch', 'allowFallback': False}
        identifier = uuid.uuid4().hex
        job = {'done': threading.Event(), 'result': None, 'started': time.perf_counter(), 'progress': {}}
        with self.lock:
            self.jobs[identifier] = job
        try:
            self.send({'type': request_type, 'id': identifier, 'payload': payload,
                       'expiresAt': expires_at, 'timingOperation': timing_operation})
            if not job['done'].wait(remaining):
                self.send({'type': 'cancel', 'id': identifier})
                return {'kind': 'failed', 'reason': 'timeout', 'allowFallback': False,
                        'progressMs': dict(job['progress'])}
            result = job['result']
            if not isinstance(result, dict):
                return {'kind': 'failed', 'reason': 'invalid_ack', 'allowFallback': False}
            if result.get('kind') == 'focused':
                has_id = payload.get('tabId') is not None
                expected = str(result.get('tabId')) == str(payload.get('tabId')) if has_id and request_type == 'focus' else (
                    str(result.get('tabId', '')).isdigit() and int(result['tabId']) > 0
                    and result.get('matchType') in ('id', 'resolved-url', 'gmail-mailbox', 'entry-bound', 'entry-selected', 'entry-exact', 'entry-unique'))
                if not expected:
                    return {'kind': 'failed', 'reason': 'invalid_ack', 'allowFallback': False}
            if result.get('kind') == 'opened':
                if request_type != 'activate' or result.get('requestedURL') != payload.get('url') or not str(result.get('tabId', '')).isdigit():
                    return {'kind': 'failed', 'reason': 'invalid_ack', 'allowFallback': False}
            return {**result, 'progressMs': dict(job['progress'])}
        except (BrokenPipeError, OSError):
            return {'kind': 'failed', 'reason': 'disconnected', 'allowFallback': False}
        finally:
            with self.lock:
                self.jobs.pop(identifier, None)

    def disconnect(self):
        self.ready = False
        self.index = None
        self.index_wire = None
        with self.lock:
            for job in self.jobs.values():
                job['result'] = {'kind': 'failed', 'reason': 'disconnected', 'allowFallback': False}
                job['done'].set()


log_lock = threading.Lock()


def log_record(obj):
    try:
        with log_lock:
            LOG_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
            path = LOG_DIR / 'bridge.jsonl'
            if path.exists() and path.stat().st_size > 1024 * 1024:
                os.replace(path, LOG_DIR / 'bridge.jsonl.1')
            fd = os.open(str(path), os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
            try:
                os.write(fd, (json.dumps(obj, separators=(',', ':')) + '\n').encode())
            finally:
                os.close(fd)
    except OSError:
        pass


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def respond(self, code, obj):
        data = json.dumps(obj, separators=(',', ':')).encode()
        self.respond_bytes(code, data)

    def respond_bytes(self, code, data):
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self):
        if self.path == '/groups':
            result = self.server.session.focus({}, request_type='groups_state')
            self.respond(200 if result.get('kind') == 'groups_state' else 503, result)
            return
        if self.path == '/index':
            session = self.server.session
            if session.ready and session.version >= 2:
                session.configure_search()
            index = session.index if session.ready else None
            if index and time.time()*1000 - index.get('receivedAt', 0) > 45000:
                index = None
            if index and session.index_wire:
                self.respond_bytes(200, session.index_wire)
            else:
                self.respond(503, {'kind': 'miss'})
            return
        if self.path == '/entries':
            result = self.server.session.focus({}, timeout=0.3, request_type='entries')
            self.respond(200 if result.get('kind') == 'entries' else 503, result)
            return
        self.respond(200 if self.path == '/health' else 404,
                     {'ready': self.server.session.ready, 'version': self.server.session.version,
                      'profile': PROFILE, 'indexReady': self.server.session.index is not None} if self.path == '/health' else {})

    def do_POST(self):
        if self.path == '/groups/organize':
            try:
                size = int(self.headers.get('Content-Length', '0'))
                if not 0 < size <= 1024:
                    raise ValueError('size')
                payload = json.loads(self.rfile.read(size))
                if not isinstance(payload, dict) or type(payload.get('windowId')) is not int or payload['windowId'] <= 0:
                    raise ValueError('window')
                result = self.server.session.focus(payload, request_type='organize_groups')
                self.respond(200 if result.get('kind') == 'groups_organized' else 504, result)
            except (ValueError, TypeError):
                self.respond(400, {'kind': 'invalid'})
            return
        if self.path == '/timing/arm':
            try:
                size = int(self.headers.get('Content-Length', '0'))
                if not 0 < size <= 16384:
                    raise ValueError('size')
                payload = json.loads(self.rfile.read(size))
                if not isinstance(payload, dict):
                    raise ValueError('payload')
                result = self.server.session.focus(payload, timeout=0.08, request_type='timing_arm')
                self.respond(200 if result.get('kind') == 'timing_armed' else 503, result)
            except (ValueError, TypeError):
                self.respond(400, {'kind': 'invalid'})
            return
        if self.path not in ('/focus', '/activate'):
            self.respond(404, {})
            return
        started = time.perf_counter()
        trace = self.headers.get('X-Chrome-Trace', '')
        if not re.fullmatch(r'[A-Za-z0-9_-]{0,128}', trace):
            trace = ''
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= 65536:
                raise ValueError('size')
            payload = json.loads(self.rfile.read(size))
            if not isinstance(payload, dict) or type(payload.get('version')) is not int or payload['version'] != 1:
                raise ValueError('version')
            expires_at = int(self.headers.get('X-Chrome-Expires', '0')) or None
            request_type = 'activate' if self.path == '/activate' else 'focus'
            operation = self.headers.get('X-Chrome-Timing-Operation', '')
            if not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', operation):
                operation = None
            if request_type == 'activate' and (self.server.session.version < 2 or self.headers.get('X-Chrome-Profile') != PROFILE):
                result = {'kind': 'miss', 'reason': 'unsupported_profile_or_version', 'allowFallback': True}
            else:
                result = self.server.session.focus(payload, expires_at=expires_at, request_type=request_type, timing_operation=operation)
        except (ValueError, TypeError, json.JSONDecodeError):
            result = {'kind': 'miss', 'reason': 'invalid_request', 'allowFallback': True}
        kind = result.get('kind')
        code = 200 if kind in ('focused', 'opened') else (422 if result.get('reason') == 'ambiguous_entry' else (409 if result.get('allowFallback') else 504))
        log_record({'timeMs': int(time.time() * 1000), 'trace': trace, 'result': kind,
                    'reason': result.get('reason'), 'durationMs': round((time.perf_counter() - started) * 1000, 2),
                    'phases': result.get('phases', {}), 'navigationChanged': result.get('navigationChanged', False),
                    'matchType': result.get('matchType'), 'progressMs': result.get('progressMs', {})})
        self.respond(code, result)


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


def main():
    os.umask(0o077)
    SOCKET_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    lock = open(str(SOCKET_DIR / 'native.lock'), 'a')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return
    SOCKET_PATH.unlink(missing_ok=True)
    session = Session(sys.stdout.buffer)
    server = Server(str(SOCKET_PATH), Handler)
    server.session = session
    os.chmod(str(SOCKET_PATH), 0o600)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        while True:
            message = read_message(sys.stdin.buffer)
            if message is None:
                break
            if isinstance(message, dict):
                session.receive(message)
    finally:
        session.disconnect()
        server.shutdown()
        server.server_close()
        SOCKET_PATH.unlink(missing_ok=True)
        lock.close()


if __name__ == '__main__':
    main()
