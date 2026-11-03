"""本地有限TTS提供方；模型与设备网关分离，正文只经内存和匿名管道传递。"""
import argparse
import hashlib
import http.server
import ipaddress
import json
from pathlib import Path
import re
import signal
import socket
import struct
import sys
import threading

MAX_BODY = 8192
MAX_AUDIO = 4 * 1024 * 1024
WORKER_SECONDS = 80
REQUIRED = {"model.onnx", "lexicon.txt", "tokens.txt"}
FSTS = {"phone.fst", "date.fst", "number.fst"}


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from local_process import ChildExit, ProviderError, run_process


class AudioLimit(ProviderError):
    pass


def strict_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("duplicate_field")
            result[key] = value
        return result
    def constant(_):
        raise ValueError("non_finite_number")
    if len(raw) > MAX_BODY:
        raise ValueError("body_too_large")
    return json.loads(raw.decode("utf-8"), object_pairs_hook=pairs, parse_constant=constant)


def load_config(config_path, model_directory, expected_revision=None):
    with Path(config_path).open("rb") as source:
        raw = source.read(MAX_BODY + 1)
    revision = "sha256:" + hashlib.sha256(raw).hexdigest()
    if expected_revision is not None and expected_revision != revision:
        raise ValueError("configuration_changed")
    value = strict_json(raw)
    if not isinstance(value, dict) or set(value) != {"schema_version", "model_id", "voices", "files", "rule_fsts", "threads"}:
        raise ValueError("invalid_configuration")
    if type(value["schema_version"]) is not int or value["schema_version"] != 1 or not isinstance(value["model_id"], str) or not re.fullmatch(r"[A-Za-z0-9_:./-]{1,128}", value["model_id"]):
        raise ValueError("invalid_configuration")
    voices, files, rules = value["voices"], value["files"], value["rule_fsts"]
    if not isinstance(voices, dict) or not 1 <= len(voices) <= 32 or any(not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", key) or type(sid) is not int or not 0 <= sid <= 1023 for key, sid in voices.items()):
        raise ValueError("invalid_voices")
    if not isinstance(rules, list) or len(rules) > 3 or any(not isinstance(name, str) or name not in FSTS for name in rules) or len(set(rules)) != len(rules):
        raise ValueError("invalid_rules")
    if not isinstance(files, dict) or set(files) != REQUIRED | set(rules) or any(not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest) for digest in files.values()):
        raise ValueError("invalid_files")
    if type(value["threads"]) is not int or not 1 <= value["threads"] <= 4:
        raise ValueError("invalid_threads")
    directory = Path(model_directory).resolve(strict=True)
    if not directory.is_dir():
        raise ValueError("invalid_model_directory")
    total = 0
    for name, expected in files.items():
        path = directory / name
        if path.is_symlink() or not path.is_file() or not 0 < path.stat().st_size <= (64 if name == "model.onnx" else 8) * 1024 * 1024:
            raise ValueError("invalid_model_file")
        total += path.stat().st_size
        digest = hashlib.sha256()
        with path.open("rb") as source:
            for chunk in iter(lambda: source.read(65536), b""):
                digest.update(chunk)
        if digest.hexdigest() != expected:
            raise ValueError("model_digest_mismatch")
    if total > 96 * 1024 * 1024:
        raise ValueError("model_too_large")
    return value, directory, revision


def validate_input(raw, config):
    value = strict_json(raw)
    if not isinstance(value, dict) or set(value) != {"model", "input", "voice", "response_format", "speed"}:
        raise ValueError("invalid_request")
    text = value["input"]
    if not isinstance(text, str) or not text.strip() or len(text) > 1000 or any(0xD800 <= ord(c) <= 0xDFFF or ord(c) < 32 and c not in "\n\t" or 0x7F <= ord(c) <= 0x9F for c in text) or len(text.encode("utf-8")) > 4096:
        raise ValueError("invalid_text")
    if value["model"] != config["model_id"] or not isinstance(value["voice"], str) or value["voice"] not in config["voices"] or value["response_format"] != "wav" or type(value["speed"]) not in (int, float) or value["speed"] != 1:
        raise ValueError("unsupported_request")
    return value


def validate_wav(data):
    if not 46 <= len(data) <= MAX_AUDIO or data[:4] != b"RIFF" or data[8:16] != b"WAVEfmt " or data[36:40] != b"data":
        raise ProviderError("invalid_audio")
    length, fmt_size, encoding, channels, rate, byte_rate, align, bits, size = struct.unpack_from("<I4x4xIHHIIHH4xI", data, 4)
    if length != len(data) - 8 or fmt_size != 16 or encoding != 1 or channels != 1 or not 8000 <= rate <= 48000 or byte_rate != rate * 2 or align != 2 or bits != 16 or size != len(data) - 44 or size % 2 or size > rate * 2 * 60:
        raise ProviderError("invalid_audio")
    return data


def run_child(command, payload, timeout=WORKER_SECONDS, stopping=None):
    try:
        return run_process(command, payload, max_output=MAX_AUDIO, timeout=timeout, stopping=stopping)
    except ChildExit as error:
        if error.returncode == 23:
            raise AudioLimit("audio_limit") from None
        raise ProviderError("provider_failed") from None


def worker(config_path, model_directory, revision, probe):
    import io
    import wave
    import numpy as np
    import sherpa_onnx
    config, directory, _ = load_config(config_path, model_directory, revision)
    tts_config = sherpa_onnx.OfflineTtsConfig(model=sherpa_onnx.OfflineTtsModelConfig(
        vits=sherpa_onnx.OfflineTtsVitsModelConfig(model=str(directory / "model.onnx"), lexicon=str(directory / "lexicon.txt"), tokens=str(directory / "tokens.txt")),
        provider="cpu", debug=False, num_threads=config["threads"]),
        rule_fsts=",".join(str(directory / name) for name in config["rule_fsts"]), max_num_sentences=1)
    if not tts_config.validate():
        raise ValueError("invalid_model")
    tts = sherpa_onnx.OfflineTts(tts_config)
    if not 8000 <= tts.sample_rate <= 48000 or any(sid >= tts.num_speakers for sid in config["voices"].values()):
        raise ValueError("unsupported_model")
    if probe:
        sys.stdout.buffer.write(json.dumps({"sample_rate": tts.sample_rate, "speakers": tts.num_speakers}).encode())
        return
    value = validate_input(sys.stdin.buffer.read(MAX_BODY + 1), config)
    frames, exceeded = 0, False
    max_frames = min(tts.sample_rate * 60, (MAX_AUDIO - 44) // 2)
    def progress(samples, _):
        nonlocal frames, exceeded
        frames += len(samples)
        exceeded = frames > max_frames
        return 0 if exceeded else 1
    audio = tts.generate(value["input"], sid=config["voices"][value["voice"]], speed=1.0, callback=progress)
    samples = np.asarray(audio.samples, dtype=np.float32)
    if exceeded or samples.size > max_frames:
        raise AudioLimit("audio_limit")
    if samples.ndim != 1 or not samples.size or not np.isfinite(samples).all():
        raise ValueError("invalid_audio")
    pcm = np.round(np.clip(samples, -1, 1) * 32767).astype("<i2")
    output = io.BytesIO()
    with wave.open(output, "wb") as wav:
        wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(audio.sample_rate); wav.writeframes(pcm.tobytes())
    sys.stdout.buffer.write(validate_wav(output.getvalue()))


class Provider:
    def __init__(self, config_path, model_directory):
        self.config_path = str(Path(config_path).resolve(strict=True))
        self.config, self.directory, self.revision = load_config(self.config_path, model_directory)
        self.slot = threading.Lock()
        self.stopping = threading.Event()

    def execute(self, payload, probe=False):
        command = [sys.executable, "-I", str(Path(__file__).resolve()), "--worker", "--config", self.config_path,
                   "--model-directory", str(self.directory), "--revision", self.revision]
        if probe:
            command.append("--probe")
        return run_child(command, payload, stopping=self.stopping)

    def synthesize(self, payload):
        return validate_wav(self.execute(payload))


class Server(http.server.ThreadingHTTPServer):
    request_queue_size = 8
    daemon_threads = False

    def __init__(self, address, provider, allowed_hosts):
        self.provider, self.allowed_hosts = provider, set(allowed_hosts)
        self.connections = threading.BoundedSemaphore(4)
        super().__init__(address, Handler)

    def process_request(self, request, address):
        if not self.connections.acquire(blocking=False):
            try:
                request.settimeout(1)
                request.sendall(b"HTTP/1.0 503 Busy\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            except OSError:
                pass
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, address)
        except BaseException:
            self.connections.release()
            raise

    def process_request_thread(self, request, address):
        try:
            super().process_request_thread(request, address)
        finally:
            self.connections.release()

    def handle_error(self, *_):
        # 不记录请求正文、路径或原生引擎异常。
        pass


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "LimeIoT-Speech"
    sys_version = ""

    def setup(self):
        self.request.settimeout(5)
        super().setup()
        def close_slow_request():
            try:
                self.request.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        self.body_deadline = threading.Timer(5, close_slow_request)
        self.body_deadline.daemon = True
        self.body_deadline.start()

    def finish(self):
        self.body_deadline.cancel()
        super().finish()

    def log_message(self, *_):
        pass

    def reply(self, status, value, content_type="application/json"):
        body = value if isinstance(value, bytes) else json.dumps(value, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        try:
            self.wfile.write(body)
        except OSError:
            pass

    def origin_allowed(self):
        return len(self.headers.get_all("Host", [])) == 1 and self.headers["Host"] in self.server.allowed_hosts and "Origin" not in self.headers

    def do_GET(self):
        if not self.origin_allowed():
            self.reply(403, {"error": {"code": "origin_denied"}})
        elif self.path != "/healthz":
            self.reply(404, {"error": {"code": "not_found"}})
        else:
            provider = self.server.provider
            self.reply(503 if provider.stopping.is_set() else 200, {"ready": not provider.stopping.is_set(), "busy": provider.slot.locked(), "model": provider.config["model_id"], "revision": provider.revision})

    def do_POST(self):
        provider = self.server.provider
        if not self.origin_allowed():
            return self.reply(403, {"error": {"code": "origin_denied"}})
        if self.path != "/v1/audio/speech":
            return self.reply(404, {"error": {"code": "not_found"}})
        lengths = self.headers.get_all("Content-Length", [])
        if "Transfer-Encoding" in self.headers or "Expect" in self.headers or self.headers.get("Content-Encoding", "identity") != "identity" or self.headers.get_all("Content-Type", []) != ["application/json"] or len(lengths) != 1 or not re.fullmatch(r"[0-9]{1,5}", lengths[0]):
            return self.reply(400, {"error": {"code": "invalid_body"}})
        length = int(lengths[0])
        if not 1 <= length <= MAX_BODY:
            return self.reply(413, {"error": {"code": "body_too_large"}})
        try:
            payload = self.rfile.read(length)
            if len(payload) != length:
                raise ValueError()
            validate_input(payload, provider.config)
        except (ValueError, RecursionError, UnicodeError):
            return self.reply(422, {"error": {"code": "invalid_request"}})
        except OSError:
            return self.reply(408, {"error": {"code": "body_timeout"}})
        self.body_deadline.cancel()
        if provider.stopping.is_set():
            return self.reply(503, {"error": {"code": "provider_stopping"}})
        if not provider.slot.acquire(blocking=False):
            return self.reply(429, {"error": {"code": "provider_busy"}})
        try:
            self.reply(200, provider.synthesize(payload), "audio/wav")
        except AudioLimit:
            self.reply(422, {"error": {"code": "audio_limit"}})
        except ProviderError as error:
            self.reply(504 if str(error) == "provider_timeout" else 502, {"error": {"code": str(error)}})
        except Exception:
            self.reply(502, {"error": {"code": "provider_failed"}})
        finally:
            provider.slot.release()


def main():
    parser = argparse.ArgumentParser(description="LimeIoT local sherpa VITS speech provider")
    parser.add_argument("--config", required=True)
    parser.add_argument("--model-directory", required=True)
    parser.add_argument("--listen", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--allowed-host", action="append")
    parser.add_argument("--worker", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--probe", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--revision", help=argparse.SUPPRESS)
    args = parser.parse_args()
    try:
        if args.worker:
            if not args.revision:
                raise ValueError("missing_revision")
            worker(args.config, args.model_directory, args.revision, args.probe)
            return
        listen = ipaddress.IPv4Address(args.listen)
        if not (listen.is_loopback or listen.is_private or listen.is_unspecified) or not 1024 <= args.port <= 65535:
            raise ValueError("invalid_listener")
        allowed = args.allowed_host or ([f"{listen}:{args.port}"] if listen.is_loopback else [])
        if not allowed or any(not re.fullmatch(r"[A-Za-z0-9.-]{1,253}:[0-9]{2,5}", host) for host in allowed):
            raise ValueError("invalid_hosts")
        provider = Provider(args.config, args.model_directory)
        strict_json(provider.execute(b"", probe=True))
        with Server((str(listen), args.port), provider, allowed) as server:
            def shutdown(*_):
                provider.stopping.set()
                threading.Thread(target=server.shutdown, daemon=True).start()
            signal.signal(signal.SIGTERM, shutdown)
            signal.signal(signal.SIGINT, shutdown)
            print(json.dumps({"listening": f"{listen}:{args.port}", "model": provider.config["model_id"], "revision": provider.revision}), flush=True)
            server.serve_forever(poll_interval=.1)
    except AudioLimit:
        raise SystemExit(23) from None
    except Exception:
        if not args.worker:
            print("speech_provider_startup_failed", file=sys.stderr)
        raise SystemExit(70) from None


if __name__ == "__main__":
    main()
