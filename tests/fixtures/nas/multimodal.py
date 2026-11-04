"""NAS隔离验收夹具：有限模型HTTP和DLNA，不代表模型质量或物理播放。"""
import base64
import hashlib
import io
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import struct
import threading
import urllib.request
import wave
import xml.etree.ElementTree as ET


def wav():
    samples = b"".join(struct.pack("<h", (offset % 500) - 250) for offset in range(44, 32044, 2))
    return b"RIFF" + struct.pack("<I", 32036) + b"WAVEfmt " + struct.pack("<IHHIIHH", 16, 1, 1, 8000, 16000, 2, 16) + b"data" + struct.pack("<I", 32000) + samples


AUDIO = wav()
TEXT = {"asr": "这是容器协议夹具的识别结果。", "vision": "这是容器协议夹具的图片观察结果。", "text": "这是容器协议夹具的文字回答。"}
COMPANION = {
    "instructions": "你是本地搭建伙伴，用简短中文回答，不调用工具。",
    "asr": ["我想搭一个会说话的积木小狗。", "怎样让小狗的底座更稳？"],
    "text": ["先搭一个稳固底座，再安装灯和扬声器。", "可以加宽底座，让两侧积木交错连接。"],
}
LOCK = threading.Lock()
STATE = {"calls": [], "effects": [], "pulls": [], "errors": []}
MODES = {kind: "ok" for kind in ("speech", "asr", "vision", "text")}
RELEASE = {kind: threading.Event() for kind in MODES}
URI = ""
SCENARIO = "bounded_tasks"
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
        global URI, SCENARIO
        try:
            size = int(self.headers.get("Content-Length", "0"))
            assert 0 < size <= 3_000_000, "invalid_fixture_body_size"
            raw = self.rfile.read(size)
            if self.path == "/fixture/scenario":
                value = json.loads(raw)
                assert value in ({"scenario": "recorded_voice_turn"}, {"scenario": "companion"})
                with LOCK:
                    assert not STATE["calls"]
                    SCENARIO = value["scenario"]
                self.reply(200, {})
                return
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
                if SCENARIO == "recorded_voice_turn":
                    assert value["input"] == TEXT["text"]
                elif SCENARIO == "companion":
                    with LOCK:
                        turn = sum(item["kind"] == "speech" for item in STATE["calls"])
                    assert turn < 2 and value["input"] == COMPANION["text"][turn]
                evidence = {"kind": kind, "digest": hashlib.sha256(value["input"].encode()).hexdigest()}
                output, content_type = AUDIO, "audio/wav"
            elif self.path == "/v1/audio/transcriptions":
                kind = "asr"
                assert self.headers.get("Content-Type") == "audio/wav"
                if SCENARIO in ("recorded_voice_turn", "companion"):
                    with wave.open(io.BytesIO(raw), "rb") as recording:
                        frames = recording.getnframes()
                        assert recording.getnchannels() == 1 and recording.getsampwidth() == 2
                        assert recording.getframerate() == 16000 and 0 < frames <= 960000
                        assert len(recording.readframes(frames)) == frames * 2
                else:
                    assert raw == AUDIO
                assert self.headers.get("X-LimeIoT-Model") == "fixture/asr"
                assert self.headers.get("X-LimeIoT-Language") == ("zh" if SCENARIO == "companion" else "auto")
                evidence = {"kind": kind, "bytes": len(raw), "digest": hashlib.sha256(raw).hexdigest()}
                output, content_type = {"text": TEXT[kind]}, "application/json"
                if SCENARIO == "companion":
                    with LOCK:
                        turn = sum(item["kind"] == "asr" for item in STATE["calls"])
                    assert turn < 2
                    output = {"text": COMPANION["asr"][turn]}
            elif self.path == "/api/chat":
                value = json.loads(raw)
                assert value["model"] in ("fixture:vision", "fixture:text") and value["stream"] is False and value["keep_alive"] == 0
                assert "tools" not in value and value["options"] == {"num_ctx": 4096, "num_predict": 1024, "temperature": 0}
                kind = "vision" if value["model"] == "fixture:vision" else "text"
                if kind == "vision":
                    assert len(value["messages"]) == 2 and value["messages"][1]["role"] == "user"
                    assert len(value["messages"][1]["images"]) == 1
                    image = base64.b64decode(value["messages"][1]["images"][0], validate=True)
                    assert image.startswith(b"\x89PNG\r\n\x1a\n")
                    evidence = {"kind": kind, "bytes": len(image), "digest": hashlib.sha256(image).hexdigest()}
                else:
                    assert value["messages"][0]["role"] == "system"
                    if SCENARIO == "recorded_voice_turn":
                        instructions = "请根据用户的语音内容，用简短、清晰的中文回答。回答不超过300字，不调用工具。"
                        assert value["messages"][1] == {"role": "system", "content": instructions}
                        messages = value["messages"][2:]
                        assert messages == [{"role": "user", "content": TEXT["asr"]}]
                    elif SCENARIO == "companion":
                        with LOCK:
                            turn = sum(item["kind"] == "text" for item in STATE["calls"])
                        assert turn < 2 and "no tools, device access" in value["messages"][0]["content"]
                        instructions = COMPANION["instructions"]
                        assert value["messages"][1] == {"role": "system", "content": instructions}
                        messages = value["messages"][2:]
                        expected = [{"role": "user", "content": COMPANION["asr"][0]}]
                        if turn == 1:
                            expected += [{"role": "assistant", "content": COMPANION["text"][0]}, {"role": "user", "content": COMPANION["asr"][1]}]
                        assert messages == expected, "companion_exact_history_mismatch"
                    else:
                        instructions = ""
                        messages = value["messages"][1:]
                        assert len(messages) == 7
                        assert all(set(message) == {"role", "content"} and message["role"] == ("user" if index % 2 == 0 else "assistant") for index, message in enumerate(messages))
                    context = json.dumps({"instructions": instructions, "messages": messages}, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
                    evidence = {"kind": kind, "message_count": len(messages), "context_digest": "sha256:" + hashlib.sha256(context).hexdigest()}
                output = {"model": value["model"], "done": True, "done_reason": "stop", "message": {"role": "assistant", "content": TEXT[kind]}}
                if kind == "text" and SCENARIO == "companion":
                    output["message"]["content"] = COMPANION["text"][turn]
                if kind == "text":
                    output.update({"prompt_eval_count": 25, "eval_count": 8})
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
