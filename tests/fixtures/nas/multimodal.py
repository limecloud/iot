"""NAS隔离验收夹具：有限模型HTTP和DLNA，不代表模型质量或物理播放。"""
import base64
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import struct
import threading
import urllib.request
import xml.etree.ElementTree as ET


def wav():
    samples = b"".join(struct.pack("<h", (offset % 500) - 250) for offset in range(44, 32044, 2))
    return b"RIFF" + struct.pack("<I", 32036) + b"WAVEfmt " + struct.pack("<IHHIIHH", 16, 1, 1, 8000, 16000, 2, 16) + b"data" + struct.pack("<I", 32000) + samples


AUDIO = wav()
TEXT = {"asr": "这是容器协议夹具的识别结果。", "vision": "这是容器协议夹具的图片观察结果。"}
LOCK = threading.Lock()
STATE = {"calls": [], "effects": [], "pulls": [], "errors": []}
MODES = {kind: "ok" for kind in ("speech", "asr", "vision")}
RELEASE = {kind: threading.Event() for kind in MODES}
URI = ""
HTTP = urllib.request.build_opener(urllib.request.ProxyHandler({}))


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def reply(self, status, value, content_type="application/json"):
        body = value if isinstance(value, bytes) else json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/state":
            with LOCK:
                self.reply(200, STATE)
        elif self.path == "/description.xml":
            self.reply(200, b'<root xmlns="urn:schemas-upnp-org:device-1-0"><device><deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType><UDN>uuid:nas-software-speaker</UDN><serviceList><service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>/av</controlURL></service><service><serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType><controlURL>/render</controlURL></service></serviceList></device></root>', "text/xml")
        else:
            self.reply(404, {})

    def do_POST(self):
        global URI
        try:
            size = int(self.headers.get("Content-Length", "0"))
            assert 0 < size <= 3_000_000, "invalid_fixture_body_size"
            raw = self.rfile.read(size)
            if self.path == "/fixture/mode":
                value = json.loads(raw)
                assert value["kind"] in MODES and value["mode"] in ("ok", "hold")
                with LOCK:
                    MODES[value["kind"]] = value["mode"]
                    RELEASE[value["kind"]].clear()
                self.reply(200, {})
                return
            if self.path in ("/av", "/render"):
                action = self.headers.get("SOAPAction", "").split("#")[-1].strip('"')
                assert action in ("SetVolume", "SetAVTransportURI", "Play", "Stop"), "invalid_soap_action"
                if action == "SetAVTransportURI":
                    URI = next(element.text for element in ET.fromstring(raw).iter() if element.tag.split("}")[-1] == "CurrentURI")
                if action == "Play":
                    request = urllib.request.Request(URI, headers={"Range": "bytes=0-"})
                    with HTTP.open(request, timeout=5) as response:
                        data = response.read(len(AUDIO) + 1)
                        assert response.status == 206 and data == AUDIO, "media_range_bytes_mismatch"
                        with LOCK:
                            STATE["pulls"].append({"status": response.status, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
                with LOCK:
                    STATE["effects"].append(action)
                service = "RenderingControl" if action == "SetVolume" else "AVTransport"
                body = f'<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:{action}Response xmlns:u="urn:schemas-upnp-org:service:{service}:1"/></s:Body></s:Envelope>'
                self.reply(200, body.encode(), "text/xml")
                return
            assert not self.headers.get("Authorization") and not self.headers.get("Cookie"), "device_or_owner_credentials_leaked"
            if self.path == "/v1/audio/speech":
                kind, value = "speech", json.loads(raw)
                assert set(value) == {"model", "input", "voice", "response_format", "speed"}
                assert value["model"] == "fixture/local-model" and value["voice"] == "local"
                assert value["response_format"] == "wav" and value["speed"] == 1
                evidence = {"kind": kind, "digest": hashlib.sha256(value["input"].encode()).hexdigest()}
                output, content_type = AUDIO, "audio/wav"
            elif self.path == "/v1/audio/transcriptions":
                kind = "asr"
                assert raw == AUDIO and self.headers.get("Content-Type") == "audio/wav"
                assert self.headers.get("X-LimeIoT-Model") == "fixture/asr"
                assert self.headers.get("X-LimeIoT-Language") == "auto"
                evidence = {"kind": kind, "bytes": len(raw), "digest": hashlib.sha256(raw).hexdigest()}
                output, content_type = {"text": TEXT[kind]}, "application/json"
            elif self.path == "/api/chat":
                kind, value = "vision", json.loads(raw)
                assert value["model"] == "fixture:vision" and value["stream"] is False and value["keep_alive"] == 0
                assert "tools" not in value and value["options"] == {"num_ctx": 4096, "num_predict": 1024, "temperature": 0}
                assert len(value["messages"]) == 2 and value["messages"][1]["role"] == "user"
                assert len(value["messages"][1]["images"]) == 1
                image = base64.b64decode(value["messages"][1]["images"][0], validate=True)
                assert image.startswith(b"\x89PNG\r\n\x1a\n")
                evidence = {"kind": kind, "bytes": len(image), "digest": hashlib.sha256(image).hexdigest()}
                output = {"model": "fixture:vision", "done": True, "done_reason": "stop", "message": {"role": "assistant", "content": TEXT[kind]}}
                content_type = "application/json"
            else:
                self.reply(404, {})
                return
            with LOCK:
                STATE["calls"].append(evidence)
                mode = MODES[kind]
            if mode == "hold" and not RELEASE[kind].wait(110):
                return
            self.reply(200, output, content_type)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as error:
            with LOCK:
                STATE["errors"].append(str(error))
            self.reply(500, {"error": "fixture_failed"})


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 17883), Handler).serve_forever()
