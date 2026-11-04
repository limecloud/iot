"""检查容器提供方夹具保持旧场景约束，并拒绝陪伴历史和语言错配。"""
import importlib.util
import io
import json
from pathlib import Path
import threading
import unittest
import urllib.error
import urllib.request
import wave

ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("multimodal_fixture", ROOT / "tests/fixtures/nas/multimodal.py")
fixture = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(fixture)


class CompanionFixtureTests(unittest.TestCase):
    def setUp(self):
        fixture.STATE = {"calls": [], "effects": [], "pulls": [], "errors": []}
        fixture.SCENARIO = "bounded_tasks"
        self.server = fixture.ThreadingHTTPServer(("127.0.0.1", 0), fixture.Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.http = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        stream = io.BytesIO()
        with wave.open(stream, "wb") as output:
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(16000)
            output.writeframes(bytes(3200))
        self.recording = stream.getvalue()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def post(self, path, value, headers=None):
        raw = value if isinstance(value, bytes) else json.dumps(value, ensure_ascii=False).encode()
        request = urllib.request.Request(f"http://127.0.0.1:{self.server.server_port}" + path, data=raw,
                                         headers=headers or {"Content-Type": "application/json"})
        try:
            with self.http.open(request, timeout=3) as response:
                data = response.read()
                return response.status, json.loads(data) if response.headers["Content-Type"] == "application/json" else data
        except urllib.error.HTTPError as error:
            with error:
                return error.code, json.loads(error.read())

    def scenario(self, name):
        self.assertEqual(self.post("/fixture/scenario", {"scenario": name})[0], 200)

    def asr(self, language, recording=None):
        return self.post("/v1/audio/transcriptions", recording or self.recording, {
            "Content-Type": "audio/wav", "X-LimeIoT-Model": "fixture/asr", "X-LimeIoT-Language": language})

    def text(self, messages):
        return self.post("/api/chat", {"model": "fixture:text", "stream": False, "keep_alive": 0,
            "options": {"num_ctx": 4096, "num_predict": 1024, "temperature": 0}, "messages": messages})

    def speech(self, text):
        return self.post("/v1/audio/speech", {"model": "fixture/local-model", "input": text,
            "voice": "local", "response_format": "wav", "speed": 1})

    def companion_messages(self, turn):
        messages = [{"role": "system", "content": "no tools, device access"},
                    {"role": "system", "content": fixture.COMPANION["instructions"]},
                    {"role": "user", "content": fixture.COMPANION["asr"][0]}]
        if turn:
            messages += [{"role": "assistant", "content": fixture.COMPANION["text"][0]},
                         {"role": "user", "content": fixture.COMPANION["asr"][1]}]
        return messages

    def test_companion_two_distinct_turns_require_exact_history(self):
        self.scenario("companion")
        for turn in range(2):
            self.assertEqual(self.asr("zh"), (200, {"text": fixture.COMPANION["asr"][turn]}))
            status, value = self.text(self.companion_messages(turn))
            self.assertEqual(status, 200)
            self.assertEqual(value["message"]["content"], fixture.COMPANION["text"][turn])
            self.assertEqual(self.speech(value["message"]["content"]), (200, fixture.AUDIO))
        self.assertEqual([item["kind"] for item in fixture.STATE["calls"]], ["asr", "text", "speech"] * 2)
        self.assertEqual([item["message_count"] for item in fixture.STATE["calls"] if item["kind"] == "text"], [1, 3])
        self.assertEqual(fixture.STATE["errors"], [])

    def test_companion_rejects_missing_history_and_wrong_language(self):
        self.scenario("companion")
        self.assertEqual(self.asr("auto")[0], 500)
        self.assertEqual(fixture.STATE["calls"], [])
        self.assertEqual(self.asr("zh")[0], 200)
        self.assertEqual(self.text(self.companion_messages(0))[0], 200)
        self.assertEqual(self.speech(fixture.COMPANION["text"][0])[0], 200)
        self.assertEqual(self.asr("zh")[0], 200)
        self.assertEqual(self.text(self.companion_messages(0))[0], 500)
        self.assertIn("companion_exact_history_mismatch", fixture.STATE["errors"])
        self.assertEqual(len(fixture.STATE["calls"]), 4)
        self.assertEqual(self.post("/fixture/scenario", {"scenario": "recorded_voice_turn"})[0], 500)
        self.assertEqual(fixture.SCENARIO, "companion")

    def test_original_recorded_voice_turn_still_requires_auto_and_original_role(self):
        self.scenario("recorded_voice_turn")
        self.assertEqual(self.asr("zh")[0], 500)
        self.assertEqual(self.asr("auto"), (200, {"text": fixture.TEXT["asr"]}))
        messages = [{"role": "system", "content": "fixture guard"},
                    {"role": "system", "content": "请根据用户的语音内容，用简短、清晰的中文回答。回答不超过300字，不调用工具。"},
                    {"role": "user", "content": fixture.TEXT["asr"]}]
        self.assertEqual(self.text(messages)[0], 200)
        self.assertEqual(self.speech(fixture.TEXT["text"])[0], 200)
        self.assertEqual(self.text(self.companion_messages(0))[0], 500)

    def test_original_bounded_tasks_keep_fixed_audio_and_seven_messages(self):
        self.assertEqual(self.asr("auto", fixture.AUDIO)[0], 200)
        self.assertEqual(self.asr("auto", self.recording)[0], 500)
        messages = [{"role": "system", "content": "fixture guard"}] + [
            {"role": "user" if index % 2 == 0 else "assistant", "content": str(index)} for index in range(7)]
        self.assertEqual(self.text(messages)[0], 200)
        self.assertEqual(self.text(messages[:-1])[0], 500)


if __name__ == "__main__":
    unittest.main()
