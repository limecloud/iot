"""仅供隔离容器验收：原样转发到真实Ollama，可扣住完整响应，不生成模型回答。"""
import hashlib
import http.client
import ipaddress
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

upstream_origin = urlsplit(os.environ.get("LIMEIOT_TEST_TEXT_UPSTREAM", "http://text:11434"))
upstream_allowed = upstream_origin.hostname in ("text", "host.docker.internal", "host.lima.internal")
if not upstream_allowed:
    try:
        address = ipaddress.ip_address(upstream_origin.hostname)
        upstream_allowed = address.version == 4 and address.is_private and not address.is_loopback
    except ValueError:
        pass
assert upstream_origin.scheme == "http" and upstream_allowed
assert not upstream_origin.username and not upstream_origin.password and upstream_origin.path in ("", "/")
assert not upstream_origin.query and not upstream_origin.fragment and upstream_origin.port

lock = threading.Lock()
records = []


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        if self.path != "/_test/state":
            self.send_error(404)
            return
        with lock:
            body = json.dumps({"calls": records}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path != "/api/chat" or self.headers.get("Authorization"):
            self.send_error(400)
            return
        size = int(self.headers.get("Content-Length", "0"))
        if not 0 < size <= 65536:
            self.send_error(413)
            return
        body = self.rfile.read(size)
        mode = json.loads(Path("/control/mode.json").read_text())["mode"]
        entry = {"request_sha256": hashlib.sha256(body).hexdigest(), "computed": False, "held": False}
        with lock:
            records.append(entry)
        upstream = http.client.HTTPConnection(upstream_origin.hostname, upstream_origin.port, timeout=85)
        try:
            upstream.request("POST", "/api/chat", body, {"Content-Type": "application/json", "Accept-Encoding": "identity"})
            response = upstream.getresponse()
            output = response.read(65537)
            if len(output) > 65536:
                raise ValueError("upstream_too_large")
            with lock:
                entry.update(computed=True, status=response.status, response_sha256=hashlib.sha256(output).hexdigest())
                if mode == "hold":
                    entry["held"] = True
            if mode == "hold":
                deadline = time.monotonic() + 90
                while time.monotonic() < deadline and json.loads(Path("/control/mode.json").read_text())["mode"] == "hold":
                    time.sleep(0.1)
            self.send_response(response.status)
            self.send_header("Content-Type", response.getheader("Content-Type", "application/json"))
            self.send_header("Content-Length", str(len(output)))
            self.end_headers()
            self.wfile.write(output)
        except (OSError, ValueError, http.client.HTTPException):
            # 只表达真实连接失败；网关自行裁定unknown，不伪造提供方JSON。
            self.send_response(502)
            self.send_header("Content-Length", "0")
            self.end_headers()
        finally:
            upstream.close()


ThreadingHTTPServer(("0.0.0.0", 8000), Handler).serve_forever()
