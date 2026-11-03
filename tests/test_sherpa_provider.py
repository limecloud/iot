"""只读模型配置、有界子进程及真实HTTP边界；合成核心在本文件使用明确夹具。"""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import http.client
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import wave

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("speech_provider", ROOT / "providers/sherpa-tts/server.py")
speech = importlib.util.module_from_spec(spec)
spec.loader.exec_module(speech)


def wav():
    output = io.BytesIO()
    with wave.open(output, "wb") as value:
        value.setnchannels(1); value.setsampwidth(2); value.setframerate(8000); value.writeframes(b"\x01\x00" * 800)
    return output.getvalue()


class ProviderTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="limeiot-sherpa-")
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.config = {"schema_version": 1, "model_id": "fixture-vits", "voices": {"local": 0}, "threads": 2, "rule_fsts": [], "files": {}}
        for name in speech.REQUIRED:
            data = ("fixture-" + name).encode(); (self.directory / name).write_bytes(data)
            self.config["files"][name] = hashlib.sha256(data).hexdigest()
        self.path = self.directory / "provider.json"
        self.path.write_text(json.dumps(self.config))

    def test_configuration_pins_files_and_rejects_drift_paths_and_duplicates(self):
        config, _, revision = speech.load_config(self.path, self.directory)
        self.assertEqual(config, self.config)
        self.path.write_text(json.dumps(self.config) + " ")
        with self.assertRaisesRegex(ValueError, "configuration_changed"):
            speech.load_config(self.path, self.directory, revision)
        (self.directory / "model.onnx").write_bytes(b"changed")
        with self.assertRaisesRegex(ValueError, "model_digest_mismatch"):
            speech.load_config(self.path, self.directory)
        self.config["files"]["../outside"] = "a" * 64
        self.path.write_text(json.dumps(self.config))
        with self.assertRaisesRegex(ValueError, "invalid_files"):
            speech.load_config(self.path, self.directory)
        with self.assertRaises(ValueError):
            speech.strict_json(b'{"voice":"a","voice":"b"}')

    def test_input_and_wav_reject_ambiguous_or_unbounded_content(self):
        value = {"model": "fixture-vits", "input": "你好", "voice": "local", "response_format": "wav", "speed": 1}
        self.assertEqual(speech.validate_input(json.dumps(value).encode(), self.config), value)
        cases = [{**value, "input": " "}, {**value, "input": "x" * 1001}, {**value, "input": "\ud800"}, {**value, "input": "\x00"}, {**value, "voice": "missing"}, {**value, "speed": True}, {**value, "model": "other"}, {**value, "extra": True}]
        for invalid in cases:
            with self.subTest(invalid=repr(invalid)[:80]), self.assertRaises(ValueError):
                speech.validate_input(json.dumps(invalid).encode(), self.config)
        self.assertEqual(speech.validate_wav(wav()), wav())
        for invalid in (b"bad", wav() + b"extra", wav()[:44], b"x" * (speech.MAX_AUDIO + 1)):
            with self.assertRaises(speech.ProviderError):
                speech.validate_wav(invalid)

    def test_child_bounds_timeout_stop_and_reaps_original_process(self):
        command = [sys.executable, "-I", "-c"]
        data = b"x" * 8192
        self.assertEqual(speech.run_child(command + ["import sys; sys.stderr.write('private'); sys.stdout.buffer.write(sys.stdin.buffer.read())"], data), data)
        with self.assertRaisesRegex(speech.ProviderError, "provider_output_limit"):
            speech.run_child(command + ["import sys; sys.stdout.buffer.write(b'x' * 8388608)"], b"")
        pid_file = self.directory / "pid"
        code = "import os,time; from pathlib import Path; Path(__import__('sys').argv[1]).write_text(str(os.getpid())); time.sleep(10)"
        start = time.monotonic()
        with self.assertRaisesRegex(speech.ProviderError, "provider_timeout"):
            speech.run_child(command + [code, str(pid_file)], b"", timeout=.5)
        self.assertLess(time.monotonic() - start, 3)
        with self.assertRaises(ProcessLookupError):
            os.kill(int(pid_file.read_text()), 0)
        stop = threading.Event(); stop.set()
        with self.assertRaisesRegex(speech.ProviderError, "provider_stopping"):
            speech.run_child(command + ["raise RuntimeError()"], b"", stopping=stop)
        with self.assertRaises(speech.AudioLimit):
            speech.run_child(command + ["raise SystemExit(23)"], b"")

    def test_http_rejects_browser_origin_unknown_host_bad_framing_and_concurrent_compute(self):
        provider = speech.Provider(self.path, self.directory)
        server = speech.Server(("127.0.0.1", 0), provider, [])
        port = server.server_address[1]; server.allowed_hosts = {f"127.0.0.1:{port}"}
        thread = threading.Thread(target=server.serve_forever); thread.start()
        self.addCleanup(server.server_close); self.addCleanup(thread.join); self.addCleanup(server.shutdown)
        body = json.dumps({"model": "fixture-vits", "input": "private sample", "voice": "local", "response_format": "wav", "speed": 1}).encode()
        def request(extra=(), content=body, method="POST", path="/v1/audio/speech"):
            connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
            try:
                connection.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
                connection.putheader("Host", f"127.0.0.1:{port}")
                connection.putheader("Content-Type", "application/json")
                connection.putheader("Content-Length", str(len(content)))
                for key, value in extra:
                    connection.putheader(key, value)
                connection.endheaders(content)
                response = connection.getresponse()
                return response.status, response.read()
            finally:
                connection.close()
        started, release = threading.Event(), threading.Event()
        def synthesize(_):
            started.set()
            if not release.wait(4):
                raise AssertionError("fixture timeout")
            return wav()
        with patch.object(provider, "synthesize", side_effect=synthesize) as compute:
            self.assertEqual(request([("Origin", "http://localhost")])[0], 403)
            self.assertEqual(request([("Host", "evil.example")])[0], 403)
            self.assertEqual(request([("Content-Length", str(len(body)))])[0], 400)
            self.assertEqual(request([("Transfer-Encoding", "chunked")])[0], 400)
            self.assertEqual(request(content=b"x" * 8193)[0], 413)
            self.assertEqual(request(content=b'{"input":"bad"}')[0], 422)
            self.assertEqual(compute.call_count, 0)
            with ThreadPoolExecutor(max_workers=1) as pool:
                first = pool.submit(request)
                try:
                    self.assertTrue(started.wait(2))
                    self.assertEqual(request()[0], 429)
                    status, health = request(method="GET", path="/healthz")
                    self.assertEqual(status, 200); self.assertTrue(json.loads(health)["busy"])
                finally:
                    release.set()
                self.assertEqual(first.result(), (200, wav()))
            self.assertEqual(compute.call_count, 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
