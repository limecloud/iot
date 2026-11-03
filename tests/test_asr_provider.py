"""ASR无模型边界检查；计算显式使用夹具，真实引擎由独立入口验收。"""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import http.client
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import wave

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("asr_provider", ROOT / "providers/sherpa-asr/server.py")
asr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(asr)


def wav(rate=8000, channels=1, frames=800):
    output = io.BytesIO()
    with wave.open(output, "wb") as value:
        value.setnchannels(channels)
        value.setsampwidth(2)
        value.setframerate(rate)
        value.writeframes(b"\x01\x00" * frames * channels)
    return output.getvalue()


class ProviderTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="limeiot-asr-")
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.config = {"schema_version": 1, "model_id": "fixture-whisper", "engine": "whisper-tiny-int8", "threads": 2, "files": {}}
        for name in asr.FILES["whisper-tiny-int8"]:
            data = ("fixture-" + name).encode()
            (self.directory / name).write_bytes(data)
            self.config["files"][name] = hashlib.sha256(data).hexdigest()
        self.path = self.directory / "provider.json"
        self.path.write_text(json.dumps(self.config))

    def test_model_and_configuration_drift_rejected_before_execution(self):
        value, _, revision = asr.load_config(self.path, self.directory)
        self.assertEqual(value, self.config)
        self.path.write_text(json.dumps(self.config) + " ")
        with self.assertRaisesRegex(ValueError, "configuration_changed"):
            asr.load_config(self.path, self.directory, revision)
        model = self.directory / "tiny-encoder.int8.onnx"
        model.write_bytes(b"changed")
        with self.assertRaisesRegex(ValueError, "model_digest_mismatch"):
            asr.load_config(self.path, self.directory)
        for changes in ({"threads": True}, {"threads": 5}, {"engine": "other"}, {"files": {**self.config["files"], "../escape": "a" * 64}}, {"extra": True}):
            self.path.write_text(json.dumps({**self.config, **changes}))
            with self.assertRaises(ValueError):
                asr.load_config(self.path, self.directory)
        with self.assertRaises(ValueError):
            asr.strict_json(b'{"threads":1,"threads":2}')

    def test_audio_and_text_boundaries_include_stereo_and_no_truncation(self):
        for rate, channels in [(8000, 1), (16000, 2), (48000, 2)]:
            self.assertEqual(asr.validate_wav(wav(rate, channels))[:2], (rate, channels))
        for data in [b"bad", wav() + b"extra", wav(frames=0), wav(rate=7999), wav(channels=3), wav(frames=8000 * 60 + 1), b"x" * (asr.MAX_AUDIO + 1)]:
            with self.assertRaises(ValueError):
                asr.validate_wav(data)
        self.assertEqual(asr.validate_output(b'{"text":""}'), {"text": ""})
        self.assertEqual(asr.validate_output(json.dumps({"text": "识别结果"}).encode()), {"text": "识别结果"})
        for value in [{"text": "x" * 2049}, {"text": "\x00"}, {"text": "\ud800"}, {"text": 1}, {"text": "ok", "command": "turn_on"}]:
            with self.assertRaises(ValueError):
                asr.validate_output(json.dumps(value).encode())
        for raw in [b'{"text":"a","text":"b"}', b" " * (asr.MAX_OUTPUT + 1)]:
            with self.assertRaises(ValueError):
                asr.validate_output(raw)

    def test_each_engine_requires_its_own_complete_file_set(self):
        for engine, names in asr.FILES.items():
            directory = self.directory / engine
            directory.mkdir()
            files = {}
            for name in names:
                data = (engine + name).encode()
                (directory / name).write_bytes(data)
                files[name] = hashlib.sha256(data).hexdigest()
            config = {**self.config, "engine": engine, "files": files}
            path = directory / "provider.json"
            path.write_text(json.dumps(config))
            self.assertEqual(asr.load_config(path, directory)[0], config)
            config["engine"] = "paraformer-small-int8" if engine == "whisper-tiny-int8" else "whisper-tiny-int8"
            path.write_text(json.dumps(config))
            with self.assertRaisesRegex(ValueError, "invalid_files"):
                asr.load_config(path, directory)

    def test_shared_process_large_input_output_limit_deadline_and_shutdown(self):
        command = [sys.executable, "-I", "-c"]
        payload = wav(rate=16000, channels=2, frames=16000 * 60)
        result = asr.run_process(command + ["import sys; data=sys.stdin.buffer.read(); sys.stdout.write(str(len(data)))"], payload, max_output=32)
        self.assertEqual(int(result), len(payload))
        with self.assertRaisesRegex(asr.ProviderError, "provider_output_limit"):
            asr.run_process(command + ["import sys; sys.stdout.buffer.write(b'x'*32769)"], b"", max_output=32768)
        pid_file = self.directory / "pid"
        code = "import os,sys,time; from pathlib import Path; Path(sys.argv[1]).write_text(str(os.getpid())); time.sleep(10)"
        with self.assertRaisesRegex(asr.ProviderError, "provider_timeout"):
            asr.run_process(command + [code, str(pid_file)], b"", max_output=32, timeout=.5)
        with self.assertRaises(ProcessLookupError):
            os.kill(int(pid_file.read_text()), 0)
        stopping = threading.Event()
        def stop_active():
            time.sleep(.2)
            stopping.set()
        thread = threading.Thread(target=stop_active)
        thread.start()
        with self.assertRaisesRegex(asr.ProviderError, "provider_stopping"):
            asr.run_process(command + ["import time; time.sleep(10)"], b"", max_output=32, stopping=stopping)
        thread.join()

    def test_http_framing_headers_concurrency_and_no_browser_entry(self):
        provider = asr.Provider(self.path, self.directory)
        server = asr.Server(("127.0.0.1", 0), provider, [])
        port = server.server_address[1]
        server.allowed_hosts = {f"127.0.0.1:{port}"}
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(thread.join)
        self.addCleanup(server.shutdown)
        def request(extra=(), data=None, method="POST", path="/v1/audio/transcriptions"):
            data = wav() if data is None else data
            connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
            try:
                connection.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
                for key, value in [("Host", f"127.0.0.1:{port}"), ("Content-Type", "audio/wav"), ("Content-Length", str(len(data))), ("X-Limeiot-Model", "fixture-whisper"), ("X-Limeiot-Language", "zh"), *extra]:
                    connection.putheader(key, value)
                connection.endheaders(data)
                response = connection.getresponse()
                return response.status, response.read()
            finally:
                connection.close()
        started, release = threading.Event(), threading.Event()
        def transcribe(payload, language):
            self.assertEqual(payload, wav())
            self.assertEqual(language, "zh")
            started.set()
            if not release.wait(4):
                raise AssertionError("fixture_timeout")
            return b'{"text":"fixture"}'
        with patch.object(provider, "transcribe", side_effect=transcribe) as compute:
            for headers, status in [([("Origin", "https://browser.example")], 403), ([("Host", "other.example")], 403), ([("Content-Length", str(len(wav())))], 400), ([("Transfer-Encoding", "chunked")], 400), ([("Content-Encoding", "gzip")], 400), ([("X-Limeiot-Model", "other")], 422), ([("X-Limeiot-Language", "en")], 422)]:
                self.assertEqual(request(headers)[0], status)
            self.assertEqual(request(data=b"x" * 46)[0], 422)
            self.assertEqual(compute.call_count, 0)
            with ThreadPoolExecutor(max_workers=1) as pool:
                pending = pool.submit(request)
                try:
                    self.assertTrue(started.wait(2))
                    self.assertEqual(request()[0], 429)
                    status, raw = request(method="GET", path="/healthz")
                    self.assertEqual(status, 200)
                    self.assertTrue(json.loads(raw)["busy"])
                finally:
                    release.set()
                self.assertEqual(pending.result(), (200, b'{"text":"fixture"}'))
            self.assertEqual(compute.call_count, 1)

    def test_service_shutdown_during_startup_reaps_probe_child(self):
        pid_file = self.directory / "probe-pid"
        code = '''import importlib.util,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location("provider",sys.argv[1])
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
pid_file=sys.argv[4]
def probe(self,*args,**kwargs):
    code="import os,sys,time; from pathlib import Path; Path(sys.argv[1]).write_text(str(os.getpid())); time.sleep(10)"
    return module.run_process([sys.executable,"-I","-c",code,pid_file],b"",max_output=32,stopping=self.stopping)
module.Provider.execute=probe
sys.argv=[sys.argv[1],"--config",sys.argv[2],"--model-directory",sys.argv[3]]
module.main()
'''
        child = subprocess.Popen([sys.executable, "-I", "-c", code, str(ROOT / "providers/sherpa-asr/server.py"), str(self.path), str(self.directory), str(pid_file)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            deadline = time.monotonic() + 3
            while not pid_file.exists() and child.poll() is None and time.monotonic() < deadline:
                time.sleep(.02)
            self.assertTrue(pid_file.exists(), "startup probe must actually be running")
            child.send_signal(signal.SIGTERM)
            self.assertEqual(child.wait(timeout=3), 70)
            with self.assertRaises(ProcessLookupError):
                os.kill(int(pid_file.read_text()), 0)
        finally:
            if child.poll() is None:
                child.kill()
            child.wait()


if __name__ == "__main__":
    unittest.main(verbosity=2)
