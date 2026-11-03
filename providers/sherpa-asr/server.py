"""本地有限ASR提供方；只识别完整PCM录音，不持有网关或设备权限。"""
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

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from local_process import ProviderError, run_process

MAX_AUDIO = 4 * 1024 * 1024
MAX_OUTPUT = 32768
MAX_CONFIG = 8192
FILES = {
    "whisper-tiny-int8": {"tiny-encoder.int8.onnx", "tiny-decoder.int8.onnx", "tiny-tokens.txt"},
    "paraformer-small-int8": {"model.int8.onnx", "tokens.txt"},
}
LANGUAGES = {"auto", "zh", "en"}


def strict_json(raw, maximum=MAX_CONFIG):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("duplicate_field")
            result[key] = value
        return result
    def constant(_):
        raise ValueError("non_finite_number")
    if len(raw) > maximum:
        raise ValueError("body_too_large")
    return json.loads(raw.decode("utf-8"), object_pairs_hook=pairs, parse_constant=constant)


def load_config(config_path, model_directory, expected_revision=None):
    with Path(config_path).open("rb") as source:
        raw = source.read(MAX_CONFIG + 1)
    revision = "sha256:" + hashlib.sha256(raw).hexdigest()
    if expected_revision is not None and expected_revision != revision:
        raise ValueError("configuration_changed")
    value = strict_json(raw)
    if not isinstance(value, dict) or set(value) != {"schema_version", "model_id", "engine", "files", "threads"}:
        raise ValueError("invalid_configuration")
    if type(value["schema_version"]) is not int or value["schema_version"] != 1 or not isinstance(value["engine"], str) or value["engine"] not in FILES or not isinstance(value["model_id"], str) or not re.fullmatch(r"[A-Za-z0-9_:./-]{1,128}", value["model_id"]):
        raise ValueError("invalid_configuration")
    files = value["files"]
    if not isinstance(files, dict) or set(files) != FILES[value["engine"]] or any(not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest) for digest in files.values()):
        raise ValueError("invalid_files")
    if type(value["threads"]) is not int or not 1 <= value["threads"] <= 4:
        raise ValueError("invalid_threads")
    directory = Path(model_directory).resolve(strict=True)
    if not directory.is_dir():
        raise ValueError("invalid_model_directory")
    total = 0
    for name, expected in files.items():
        path = directory / name
        if path.is_symlink() or not path.is_file() or not 0 < path.stat().st_size <= (128 if name.endswith(".onnx") else 8) * 1024 * 1024:
            raise ValueError("invalid_model_file")
        total += path.stat().st_size
        if total > 128 * 1024 * 1024:
            raise ValueError("model_too_large")
        with path.open("rb") as source:
            actual = hashlib.file_digest(source, "sha256").hexdigest()
        if actual != expected:
            raise ValueError("model_digest_mismatch")
    return value, directory, revision


def validate_wav(data):
    if not 46 <= len(data) <= MAX_AUDIO or data[:4] != b"RIFF" or data[8:12] != b"WAVE" or struct.unpack_from("<I", data, 4)[0] != len(data) - 8:
        raise ValueError("invalid_audio")
    position, audio, pcm = 12, None, None
    while position < len(data):
        if len(data) - position < 8:
            raise ValueError("invalid_audio")
        kind, size = struct.unpack_from("<4sI", data, position)
        start, end = position + 8, position + 8 + size
        if end > len(data):
            raise ValueError("invalid_audio")
        if kind == b"fmt " and audio is None and pcm is None and size == 16:
            encoding, channels, rate, byte_rate, align, bits = struct.unpack_from("<HHIIHH", data, start)
            if encoding != 1 or channels not in (1, 2) or not 8000 <= rate <= 48000 or byte_rate != rate * channels * 2 or align != channels * 2 or bits != 16:
                raise ValueError("invalid_audio")
            audio = (rate, channels)
        elif kind == b"data" and audio is not None and pcm is None and size > 0:
            pcm = data[start:end]
        else:
            raise ValueError("invalid_audio")
        position = end + size % 2
        if position > len(data):
            raise ValueError("invalid_audio")
    if audio is None or pcm is None or len(pcm) % (audio[1] * 2) or len(pcm) // (audio[1] * 2) > audio[0] * 60:
        raise ValueError("invalid_audio")
    return audio[0], audio[1], pcm


def validate_output(raw):
    value = strict_json(raw, MAX_OUTPUT)
    if not isinstance(value, dict) or set(value) != {"text"}:
        raise ValueError("invalid_output")
    text = value["text"]
    if not isinstance(text, str) or len(text) > 2048 or any(0xD800 <= ord(c) <= 0xDFFF or ord(c) < 32 and c not in "\n\t" or 0x7F <= ord(c) <= 0x9F for c in text) or len(text.encode("utf-8")) > 8192:
        raise ValueError("invalid_output")
    return value


def worker(config_path, model_directory, revision, language, probe):
    import numpy as np
    import sherpa_onnx
    config, directory, _ = load_config(config_path, model_directory, revision)
    if config["engine"] == "whisper-tiny-int8":
        recognizer = sherpa_onnx.OfflineRecognizer.from_whisper(
            encoder=str(directory / "tiny-encoder.int8.onnx"), decoder=str(directory / "tiny-decoder.int8.onnx"),
            tokens=str(directory / "tiny-tokens.txt"), language="" if language == "auto" else language,
            task="transcribe", num_threads=config["threads"], provider="cpu", debug=False, tail_paddings=300)
    else:
        recognizer = sherpa_onnx.OfflineRecognizer.from_paraformer(
            paraformer=str(directory / "model.int8.onnx"), tokens=str(directory / "tokens.txt"),
            num_threads=config["threads"], provider="cpu", debug=False)
    if probe:
        sys.stdout.buffer.write(b'{"loaded":true}')
        return
    rate, channels, pcm = validate_wav(sys.stdin.buffer.read(MAX_AUDIO + 1))
    samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32).reshape(-1, channels).mean(axis=1) / 32768
    # sherpa在accept_waveform内将8–48kHz输入重采样为模型采样率；网关不运行解码器。
    # Whisper引擎对单段约30秒后会静默截断；25秒分段确保全部输入被处理。
    pieces = []
    for start in range(0, len(samples), rate * 25):
        stream = recognizer.create_stream()
        stream.accept_waveform(rate, samples[start:start + rate * 25])
        recognizer.decode_stream(stream)
        if stream.result.text:
            pieces.append(stream.result.text)
    raw = json.dumps({"text": "\n".join(pieces)}, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    validate_output(raw)
    sys.stdout.buffer.write(raw)


class Provider:
    def __init__(self, config_path, model_directory):
        self.config_path = str(Path(config_path).resolve(strict=True))
        self.config, self.directory, self.revision = load_config(self.config_path, model_directory)
        self.slot = threading.Lock()
        self.stopping = threading.Event()

    def execute(self, payload, language="auto", probe=False):
        if language not in LANGUAGES:
            raise ValueError("invalid_language")
        command = [sys.executable, "-I", str(Path(__file__).resolve()), "--worker", "--config", self.config_path,
                   "--model-directory", str(self.directory), "--revision", self.revision, "--language", language]
        if probe:
            command.append("--probe")
        return run_process(command, payload, max_output=MAX_OUTPUT, stopping=self.stopping)

    def transcribe(self, payload, language):
        raw = self.execute(payload, language)
        validate_output(raw)
        return raw


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
        pass


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "LimeIoT-Transcription"
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

    def reply(self, status, value):
        body = value if isinstance(value, bytes) else json.dumps(value, separators=(",", ":")).encode()
        self.send_response(status)
        for key, content in [("Content-Type", "application/json"), ("Content-Length", str(len(body))), ("Cache-Control", "no-store"), ("X-Content-Type-Options", "nosniff"), ("Connection", "close")]:
            self.send_header(key, content)
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
        if self.path != "/v1/audio/transcriptions":
            return self.reply(404, {"error": {"code": "not_found"}})
        lengths = self.headers.get_all("Content-Length", [])
        if "Transfer-Encoding" in self.headers or "Expect" in self.headers or self.headers.get_all("Content-Encoding", []) not in ([], ["identity"]) or self.headers.get_all("Content-Type", []) != ["audio/wav"] or len(lengths) != 1 or not re.fullmatch(r"[0-9]{1,8}", lengths[0]):
            return self.reply(400, {"error": {"code": "invalid_body"}})
        length = int(lengths[0])
        if not 46 <= length <= MAX_AUDIO:
            return self.reply(413, {"error": {"code": "body_too_large"}})
        models, languages = self.headers.get_all("X-Limeiot-Model", []), self.headers.get_all("X-Limeiot-Language", [])
        if models != [provider.config["model_id"]] or len(languages) != 1 or languages[0] not in LANGUAGES:
            return self.reply(422, {"error": {"code": "unsupported_request"}})
        try:
            payload = self.rfile.read(length)
            if len(payload) != length:
                raise ValueError("invalid_audio")
            validate_wav(payload)
        except ValueError:
            return self.reply(422, {"error": {"code": "invalid_audio"}})
        except OSError:
            return self.reply(408, {"error": {"code": "body_timeout"}})
        self.body_deadline.cancel()
        if provider.stopping.is_set():
            return self.reply(503, {"error": {"code": "provider_stopping"}})
        if not provider.slot.acquire(blocking=False):
            return self.reply(429, {"error": {"code": "provider_busy"}})
        try:
            self.reply(200, provider.transcribe(payload, languages[0]))
        except ProviderError as error:
            self.reply(504 if str(error) == "provider_timeout" else 502, {"error": {"code": str(error)}})
        except Exception:
            self.reply(502, {"error": {"code": "provider_failed"}})
        finally:
            provider.slot.release()


def main():
    parser = argparse.ArgumentParser(description="LimeIoT local sherpa transcription provider")
    parser.add_argument("--config", required=True)
    parser.add_argument("--model-directory", required=True)
    parser.add_argument("--listen", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--allowed-host", action="append")
    parser.add_argument("--worker", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--probe", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--revision", help=argparse.SUPPRESS)
    parser.add_argument("--language", choices=sorted(LANGUAGES), default="auto", help=argparse.SUPPRESS)
    args = parser.parse_args()
    try:
        if args.worker:
            if not args.revision:
                raise ValueError("missing_revision")
            worker(args.config, args.model_directory, args.revision, args.language, args.probe)
            return
        listen = ipaddress.IPv4Address(args.listen)
        if not (listen.is_loopback or listen in ipaddress.ip_network("10.0.0.0/8") or listen in ipaddress.ip_network("172.16.0.0/12") or listen in ipaddress.ip_network("192.168.0.0/16") or listen.is_unspecified) or not 1024 <= args.port <= 65535:
            raise ValueError("invalid_listener")
        allowed = args.allowed_host or ([f"{listen}:{args.port}"] if listen.is_loopback else [])
        if not allowed or any(not re.fullmatch(r"[A-Za-z0-9.-]{1,253}:[0-9]{2,5}", host) for host in allowed):
            raise ValueError("invalid_hosts")
        provider = Provider(args.config, args.model_directory)
        server = None
        def shutdown(*_):
            provider.stopping.set()
            if server is not None:
                threading.Thread(target=server.shutdown, daemon=True).start()
        signal.signal(signal.SIGTERM, shutdown)
        signal.signal(signal.SIGINT, shutdown)
        if strict_json(provider.execute(b"", probe=True)) != {"loaded": True}:
            raise ValueError("invalid_model_probe")
        if provider.stopping.is_set():
            raise ValueError("provider_stopping")
        with Server((str(listen), args.port), provider, allowed) as server:
            if provider.stopping.is_set():
                return
            print(json.dumps({"listening": f"{listen}:{args.port}", "model": provider.config["model_id"], "revision": provider.revision}), flush=True)
            server.serve_forever(poll_interval=.1)
    except Exception:
        if not args.worker:
            print("transcription_provider_startup_failed", file=sys.stderr)
        raise SystemExit(70) from None


if __name__ == "__main__":
    main()
