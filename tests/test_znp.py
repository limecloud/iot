"""以Unix伪终端运行真实Rust串口适配器和CLI，不访问任何设备。"""
import errno
import json
import os
from pathlib import Path
import pty
import select
import signal
import struct
import subprocess
import termios
import threading
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
BINARY = Path(os.environ.get("LIMEIOT_ZNP_TOOL", ROOT / "target/debug/limeiot-znp"))
NODE = os.environ.get("LIMEIOT_NODE", "node")
CLI = ROOT / "packages/cli/src/main.mjs"
RECORDS = []
ADDRESS = 0x1234
IEEE = bytes.fromhex("8877665544332211")


def frame(cmd0, cmd1, data=b""):
    body = bytes([len(data), cmd0, cmd1]) + data
    checksum = 0
    for byte in body:
        checksum ^= byte
    return b"\xfe" + body + bytes([checksum])


def response_header(address=ADDRESS, status=0):
    return struct.pack("<HBH", address, status, address)


def standard_response(cmd0, cmd1, data):
    if (cmd0, cmd1) == (0x21, 1):
        assert data == b""
        return frame(0x61, 1, b"\x11\x00")
    if (cmd0, cmd1) == (0x21, 2):
        assert data == b""
        return frame(0x61, 2, bytes([2, 1, 3, 0, 1, 11, 22, 33, 44, 55]))
    assert cmd0 == 0x25
    if cmd1 == 1:
        assert data == struct.pack("<HBB", ADDRESS, 0, 0)
        result = b"\x00" + IEEE + struct.pack("<HBB", ADDRESS, 0, 0)
    else:
        assert data[:4] == struct.pack("<HH", ADDRESS, ADDRESS)
        if cmd1 == 2:
            assert len(data) == 4
            result = response_header() + struct.pack("<BBBHBHHHB", 2, 0x40, 0x80, 0x1234, 82, 82, 0, 82, 0)
        elif cmd1 == 5:
            assert len(data) == 4
            result = response_header() + bytes([2, 1, 2])
        else:
            assert cmd1 == 4 and len(data) == 5 and data[4] in (1, 2)
            descriptor = struct.pack("<BHHBBHHBH", data[4], 0x0104, 0x0402, 1, 2, 0x0000, 0x0402, 1, 0x0019)
            result = response_header() + bytes([len(descriptor)]) + descriptor
    return frame(0x65, cmd1, b"\x00") + frame(0x45, cmd1 | 0x80, result)


class PtyNcp:
    def __init__(self, handler=standard_response, fragments=False):
        self.master, self.slave = pty.openpty()
        self.path = os.ttyname(self.slave)
        self.original = termios.tcgetattr(self.slave)
        self.handler = handler
        self.fragments = fragments
        self.requests = []
        self.errors = []
        self.stop = threading.Event()
        self.received = threading.Event()
        self.worker = threading.Thread(target=self.run, daemon=True)

    def __enter__(self):
        self.worker.start()
        return self

    def __exit__(self, *_):
        self.stop.set()
        self.worker.join(2)
        assert not self.worker.is_alive(), "软件NCP线程未关闭"
        restored = termios.tcgetattr(self.slave) == self.original
        os.close(self.master)
        os.close(self.slave)
        assert restored, "串口关闭未恢复termios"
        if self.errors:
            raise self.errors[0]

    def run(self):
        pending = bytearray()
        try:
            while not self.stop.is_set():
                if not select.select([self.master], [], [], 0.025)[0]:
                    continue
                chunk = os.read(self.master, 4096)
                if not chunk:
                    break
                pending.extend(chunk)
                while len(pending) >= 2 and len(pending) >= pending[1] + 5:
                    assert pending[0] == 0xFE
                    packet = bytes(pending[:pending[1] + 5])
                    del pending[:len(packet)]
                    check = 0
                    for byte in packet[1:]:
                        check ^= byte
                    assert check == 0 and packet[1] <= 250
                    command = (packet[2], packet[3], packet[4:-1])
                    self.requests.append(command)
                    self.received.set()
                    response = self.handler(*command)
                    if response:
                        for part in ([bytes([b]) for b in response] if self.fragments else [response]):
                            os.write(self.master, part)
                            if self.fragments:
                                time.sleep(0.001)
        except OSError as error:
            if error.errno not in (errno.EIO, errno.EBADF):
                self.errors.append(error)
        except BaseException as error:
            self.errors.append(error)

    def execute(self, command="interview", timeout_ms=3000, cli=False, extra=()):
        args = ([NODE, str(CLI), "zigbee"] if cli else [str(BINARY)])
        args += [command, "--serial", self.path, "--timeout-ms", str(timeout_ms)]
        if command == "interview":
            args += ["--address", "0x1234"]
        args += list(extra)
        started = time.monotonic()
        result = subprocess.run(args, cwd=ROOT, text=True, capture_output=True, timeout=timeout_ms / 1000 + 5)
        RECORDS.append({"command": command, "cli": cli, "exit_code": result.returncode,
                        "elapsed_ms": round((time.monotonic() - started) * 1000),
                        "requests": [[a, b, data.hex()] for a, b, data in self.requests],
                        "stdout": json.loads(result.stdout) if result.stdout else None,
                        "stderr": json.loads(result.stderr) if result.stderr else None})
        return result


class ZnpPtyChecks(unittest.TestCase):
    def failure(self, handler, code, timeout_ms=1000, max_requests=None):
        with PtyNcp(handler) as ncp:
            result = ncp.execute(timeout_ms=timeout_ms)
            self.assertEqual(result.returncode, 5, result)
            self.assertEqual(result.stdout, "")
            self.assertEqual(json.loads(result.stderr)["error"]["code"], code)
            if max_requests is not None:
                self.assertEqual(len(ncp.requests), max_requests)

    def test_fragmented_full_interview_through_cli(self):
        with PtyNcp(fragments=True) as ncp:
            result = ncp.execute(cli=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stderr, "")
            value = json.loads(result.stdout)
            self.assertFalse(value["device_binding_created"])
            interview = value["result"]
            self.assertEqual(interview["ieee_address"], "1122334455667788")
            self.assertEqual(interview["ncp"]["version_extension"], [11, 22, 33, 44, 55])
            self.assertEqual(interview["node"]["manufacturer_code"], 0x1234)
            self.assertEqual([ep["endpoint"] for ep in interview["endpoints"]], [1, 2])
            self.assertEqual(interview["endpoints"][0]["input_clusters"], [0, 0x0402])
            self.assertEqual([b for _, b, _ in ncp.requests], [1, 2, 1, 2, 5, 4, 4, 1])

    def test_probe_has_no_zdo_requests(self):
        with PtyNcp() as ncp:
            result = ncp.execute("probe", cli=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual([(a, b) for a, b, _ in ncp.requests], [(0x21, 1), (0x21, 2)])

    def test_unsolicited_and_foreign_target_responses_are_bounded_and_not_adopted(self):
        def handler(a, b, data):
            output = standard_response(a, b, data)
            if (a, b) == (0x25, 5):
                output = frame(0x45, 0x85, response_header(0x2345) + bytes([1, 99])) + output
            return frame(0x45, 0xc0, b"\x09") + output
        with PtyNcp(handler) as ncp:
            result = ncp.execute()
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(len(json.loads(result.stdout)["result"]["endpoints"]), 2)

    def test_async_before_sync_is_matched_to_same_request(self):
        def handler(a, b, data):
            output = standard_response(a, b, data)
            return output[6:] + output[:6] if a == 0x25 else output
        with PtyNcp(handler) as ncp:
            result = ncp.execute()
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_bad_fcs_fails_without_retry(self):
        self.failure(lambda *_: b"\xfe\x02\x61\x01\x11\x00\x00", "znp_invalid_frame", max_requests=1)

    def test_oversized_frame_rejected_before_body(self):
        self.failure(lambda *_: b"\xfe\xfb", "znp_invalid_frame", max_requests=1)

    def test_reset_indication_closes_session(self):
        self.failure(lambda *_: frame(0x41, 0x80, b"\x01\x02\x01\x03\x00\x01"), "znp_reset", max_requests=1)

    def test_wrong_sync_response_is_not_skipped(self):
        self.failure(lambda *_: frame(0x61, 2, b""), "znp_unexpected_response", max_requests=1)

    def test_notification_flood_exhausts_budget(self):
        self.failure(lambda *_: frame(0x45, 0xc0, b"\x09") * 33, "znp_limit_exceeded", max_requests=1)

    def test_noise_flood_exhausts_budget(self):
        self.failure(lambda *_: bytes(65), "znp_limit_exceeded", max_requests=1)

    def test_missing_zdo_capability_rejects_before_device_request(self):
        def handler(a, b, data):
            return frame(0x61, 1, b"\x01\x00") if b == 1 else standard_response(a, b, data)
        self.failure(handler, "znp_capability_missing", max_requests=2)

    def test_ncp_request_rejection_retains_numeric_status(self):
        def handler(a, b, data):
            return frame(0x65, b, b"\xcd") if a == 0x25 else standard_response(a, b, data)
        self.failure(handler, "znp_request_rejected", max_requests=3)
        self.assertEqual(RECORDS[-1]["stderr"]["error"]["status"], 0xCD)

    def test_device_rejection_retains_numeric_status(self):
        def handler(a, b, data):
            if (a, b) == (0x25, 2):
                return frame(0x65, b, b"\x00") + frame(0x45, 0x82, response_header(status=0x82))
            return standard_response(a, b, data)
        self.failure(handler, "znp_device_rejected", max_requests=4)
        self.assertEqual(RECORDS[-1]["stderr"]["error"]["status"], 0x82)

    def test_duplicate_active_endpoints_rejected(self):
        def handler(a, b, data):
            if (a, b) == (0x25, 5):
                return frame(0x65, b, b"\x00") + frame(0x45, 0x85, response_header() + bytes([2, 1, 1]))
            return standard_response(a, b, data)
        self.failure(handler, "znp_invalid_response", max_requests=5)

    def test_endpoint_limit_is_not_silently_truncated(self):
        def handler(a, b, data):
            if (a, b) == (0x25, 5):
                return frame(0x65, b, b"\x00") + frame(0x45, 0x85, response_header() + bytes([17]) + bytes(range(1, 18)))
            return standard_response(a, b, data)
        self.failure(handler, "znp_limit_exceeded", max_requests=5)

    def test_truncated_simple_descriptor_not_returned(self):
        def handler(a, b, data):
            if (a, b) == (0x25, 4):
                return frame(0x65, b, b"\x00") + frame(0x45, 0x84, response_header() + bytes([8, data[4]]))
            return standard_response(a, b, data)
        self.failure(handler, "znp_invalid_response", max_requests=6)

    def test_cluster_limit_is_not_silently_truncated(self):
        def handler(a, b, data):
            if (a, b) == (0x25, 4):
                descriptor = struct.pack("<BHHBB", data[4], 0x0104, 0x0402, 1, 33)
                descriptor += b"".join(struct.pack("<H", cluster) for cluster in range(33)) + b"\x00"
                return frame(0x65, b, b"\x00") + frame(0x45, 0x84, response_header() + bytes([len(descriptor)]) + descriptor)
            return standard_response(a, b, data)
        self.failure(handler, "znp_limit_exceeded", max_requests=6)

    def test_short_address_reassigned_during_interview_rejects_all_evidence(self):
        count = 0
        def handler(a, b, data):
            nonlocal count
            if (a, b) == (0x25, 1):
                count += 1
                if count == 2:
                    return frame(0x65, b, b"\x00") + frame(0x45, 0x81, b"\x00" + bytes.fromhex("9988776655443322") + struct.pack("<HBB", ADDRESS, 0, 0))
            return standard_response(a, b, data)
        self.failure(handler, "znp_identity_changed", max_requests=8)

    def test_absolute_timeout_does_not_retry(self):
        self.failure(lambda *_: None, "znp_timeout", timeout_ms=100, max_requests=1)

    def test_interrupt_and_termination_cancel_and_restore_serial(self):
        for received_signal in (signal.SIGINT, signal.SIGTERM):
            with PtyNcp(lambda *_: None) as ncp:
                process = subprocess.Popen([str(BINARY), "probe", "--serial", ncp.path, "--timeout-ms", "30000"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                try:
                    self.assertTrue(ncp.received.wait(3), "组件未发送首个请求")
                    competing = subprocess.run([str(BINARY), "probe", "--serial", ncp.path], capture_output=True, text=True, timeout=3)
                    self.assertEqual(competing.returncode, 5)
                    self.assertEqual(json.loads(competing.stderr)["error"]["code"], "serial_io_failed")
                    process.send_signal(received_signal)
                    stdout, stderr = process.communicate(timeout=3)
                    self.assertEqual(process.returncode, 5)
                    self.assertEqual(stdout, "")
                    self.assertEqual(json.loads(stderr)["error"]["code"], "znp_cancelled")
                    self.assertEqual(len(ncp.requests), 1)
                finally:
                    if process.poll() is None:
                        process.kill()
                        process.communicate(timeout=3)

    def test_all_reads_share_one_deadline(self):
        def handler(a, b, data):
            time.sleep(0.35)
            return standard_response(a, b, data)
        self.failure(handler, "znp_timeout", timeout_ms=500, max_requests=2)

    def test_cli_and_binary_reject_duplicate_and_broadcast_input_before_open(self):
        for cli in (False, True):
            for extra in (("--address", "0xffff"), ("--serial", "/dev/unused"), ("--timeout-ms", "99")):
                with PtyNcp() as ncp:
                    result = ncp.execute(cli=cli, extra=extra)
                    self.assertEqual(result.returncode, 2, result)
                    self.assertEqual(json.loads(result.stderr)["error"]["code"], "invalid_znp_input")
                    self.assertEqual(ncp.requests, [])

    def test_non_tty_file_is_never_modified(self):
        import tempfile
        with tempfile.NamedTemporaryFile() as regular:
            regular.write(b"preserve-original-file")
            regular.flush()
            result = subprocess.run([str(BINARY), "probe", "--serial", regular.name], text=True, capture_output=True, timeout=3)
            self.assertEqual(result.returncode, 5)
            self.assertEqual(Path(regular.name).read_bytes(), b"preserve-original-file")


if __name__ == "__main__":
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(ZnpPtyChecks)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    archive = ROOT / ".dev/znp-verification-20261103"
    archive.mkdir(parents=True, exist_ok=True)
    (archive / "pty-results.json").write_text(json.dumps({
        "passed": result.wasSuccessful(), "tests": result.testsRun,
        "failures": len(result.failures), "errors": len(result.errors),
        "hardware": False, "serial_surface": "unix_pty", "records": RECORDS,
    }, indent=2) + "\n")
    raise SystemExit(0 if result.wasSuccessful() else 1)
