"""有限协调器入网窗口的真实串口与CLI检查，只使用软件PTY。"""
import json
import os
import signal
import struct
import subprocess
import time
import unittest

from test_znp import BINARY, CLI, NODE, PtyNcp, RECORDS, ROOT, frame
from test_znp_discovery import COORDINATOR, Protocol as Neighbors, TARGETS


def arguments(duration=60):
    return ("--coordinator-ieee", COORDINATOR, "--duration-seconds", str(duration))


class Protocol(Neighbors):
    def __init__(self, mode="normal", capabilities=0x11, role=0):
        super().__init__(total=0, capabilities=capabilities)
        self.mode, self.role, self.writes = mode, role, []

    def __call__(self, a, b, data):
        if (a, b) == (0x25, 2):
            assert data == bytes(4)
            node = struct.pack("<BBBHBHHHB", self.role, 0x40, 0x80, 0x1234, 82, 82, 0, 82, 0)
            return frame(0x65, 2, b"\x00") + frame(0x45, 0x82, bytes(5) + node)
        if (a, b) == (0x25, 0x36):
            assert len(data) == 5 and data[:3] == bytes([2, 0, 0]) and data[4] == 1 and data[3] <= 120
            self.writes.append(data[3])
            sync = frame(0x65, b, b"\x00")
            asynchronous = frame(0x45, 0xB6, bytes(3))
            if self.mode == "no_response": return None
            if self.mode == "no_async": return sync
            if self.mode == "no_sync": return asynchronous
            if self.mode == "sync_rejected": return frame(0x65, b, b"\x01")
            if self.mode == "device_rejected": return sync + frame(0x45, 0xB6, bytes([0, 0, 0x84]))
            if self.mode == "bad_sync": return frame(0x65, b, bytes(2))
            if self.mode == "bad_async": return sync + frame(0x45, 0xB6, bytes(4))
            if self.mode == "reset": return frame(0x41, 0x80, bytes(6))
            if self.mode == "bad_frame": return sync[:-1] + bytes([sync[-1] ^ 1])
            if self.mode == "flood": return frame(0x45, 0xC0, b"\x09") * 33 + sync + asynchronous
            if self.mode == "early": return asynchronous + sync
            if self.mode == "foreign": return frame(0x45, 0xB6, bytes([0x34, 0x12, 0])) + sync + asynchronous
            if self.mode == "join_device" and data[3]: self.total = 1
            return sync + asynchronous
        response = super().__call__(a, b, data)
        if (a, b) == (0x25, 1) and (self.mode == "identity_before" or self.mode == "identity_after" and self.identities == 2):
            return frame(0x65, 1, b"\x00") + frame(0x45, 0x81, b"\x00" + bytes.fromhex("0102030405060709")[::-1] + bytes(4))
        return response


class JoinWindowPtyChecks(unittest.TestCase):
    def execute(self, protocol=None, duration=60, cli=False, fragments=False, timeout_ms=3000):
        with PtyNcp(protocol or Protocol(), fragments=fragments) as ncp:
            result = ncp.execute("permit-join", extra=arguments(duration), cli=cli, timeout_ms=timeout_ms)
            return result, ncp.requests

    def failure(self, protocol, code, cli=False, timeout_ms=1000, status=None):
        result, requests = self.execute(protocol, cli=cli, timeout_ms=timeout_ms)
        self.assertEqual((result.returncode, result.stdout), (5, ""), result)
        error = json.loads(result.stderr)["error"]
        self.assertEqual(error["code"], code)
        self.assertEqual((error["outcome"], error["retry_allowed"]), ("unknown", False))
        if status is not None: self.assertEqual(error["status"], status)
        self.assertLessEqual(sum((a, b) == (0x25, 0x36) for a, b, _ in requests), 1)
        return requests

    def test_fragmented_open_through_cli_checks_identity_role_and_exact_single_unicast(self):
        result, requests = self.execute(cli=True, fragments=True)
        self.assertEqual((result.returncode, result.stderr), (0, ""))
        value = json.loads(result.stdout)
        self.assertTrue(value["network_write_requested"]); self.assertFalse(value["device_binding_created"])
        self.assertEqual(value["result"]["status"], "protocol_accepted")
        self.assertEqual((value["result"]["scope"], value["result"]["duration_seconds"]), ("coordinator", 60))
        self.assertEqual([(a, b) for a, b, _ in requests], [(0x21, 1), (0x21, 2), (0x25, 1), (0x25, 2), (0x25, 0x36), (0x25, 1)])
        self.assertEqual(requests[4][2], bytes([2, 0, 0, 60, 1]))

    def test_close_and_finite_bounds_work_in_binary_and_cli(self):
        for duration in [0, 1, 120]:
            for cli in [False, True]:
                with self.subTest(duration=duration, cli=cli):
                    result, requests = self.execute(duration=duration, cli=cli)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(json.loads(result.stdout)["result"]["duration_seconds"], duration)
                    self.assertEqual([data[3] for a, b, data in requests if b == 0x36], [duration])

    def test_simulated_joined_neighbor_is_discovered_without_automatic_platform_binding(self):
        protocol = Protocol("join_device")
        with PtyNcp(protocol) as ncp:
            first = ncp.execute("neighbors", cli=True, extra=arguments()[:2])
            self.assertEqual(json.loads(first.stdout)["result"]["items"], [])
            opened = ncp.execute("permit-join", cli=True, extra=arguments())
            self.assertEqual(opened.returncode, 0, opened.stderr)
            found = ncp.execute("neighbors", cli=True, extra=arguments()[:2])
            self.assertEqual([item["ieee_address"] for item in json.loads(found.stdout)["result"]["items"]], TARGETS[:1])
            self.assertFalse(json.loads(found.stdout)["device_binding_created"])
            self.assertEqual(protocol.writes, [60])

    def test_async_before_sync_and_foreign_sources(self):
        for mode in ["early", "foreign"]:
            with self.subTest(mode=mode):
                result, _ = self.execute(Protocol(mode), cli=True)
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_wrong_identity_before_write_has_no_network_mutation(self):
        requests = self.failure(Protocol("identity_before"), "znp_identity_changed", cli=True)
        self.assertFalse(any(b == 0x36 for _, b, _ in requests))

    def test_wrong_identity_after_write_is_unknown_without_retry(self):
        requests = self.failure(Protocol("identity_after"), "znp_identity_changed", cli=True)
        self.assertEqual(sum(b == 0x36 for _, b, _ in requests), 1)

    def test_missing_capability_and_non_coordinator_roles_never_permit_join(self):
        for protocol, code in [(Protocol(capabilities=1), "znp_capability_missing"), (Protocol(role=1), "znp_coordinator_required"), (Protocol(role=2), "znp_coordinator_required")]:
            with self.subTest(code=code):
                requests = self.failure(protocol, code)
                self.assertFalse(any(b == 0x36 for _, b, _ in requests))

    def test_request_and_device_rejection_preserve_numeric_status(self):
        self.failure(Protocol("sync_rejected"), "znp_request_rejected", cli=True, status=1)
        self.failure(Protocol("device_rejected"), "znp_device_rejected", cli=True, status=0x84)

    def test_malformed_responses_reset_and_noise_fail_without_partial_stdout(self):
        for mode, code in [("bad_sync", "znp_invalid_response"), ("bad_async", "znp_invalid_response"), ("reset", "znp_reset"), ("bad_frame", "znp_invalid_frame"), ("flood", "znp_limit_exceeded")]:
            with self.subTest(mode=mode): self.failure(Protocol(mode), code, cli=True)

    def test_missing_either_response_times_out_once_without_implicit_close(self):
        for mode in ["no_response", "no_async", "no_sync"]:
            with self.subTest(mode=mode):
                requests = self.failure(Protocol(mode), "znp_timeout", cli=True, timeout_ms=100)
                self.assertEqual([data[3] for a, b, data in requests if b == 0x36], [60])

    def test_cancel_binary_or_cli_after_write_closes_tty_and_never_resends(self):
        for cli in [False, True]:
            with self.subTest(cli=cli), PtyNcp(Protocol("no_response")) as ncp:
                args = ([NODE, str(CLI), "zigbee"] if cli else [str(BINARY)]) + ["permit-join", "--serial", ncp.path, "--timeout-ms", "30000", *arguments()]
                process = subprocess.Popen(args, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                try:
                    deadline = time.monotonic() + 3
                    while time.monotonic() < deadline and not any(b == 0x36 for _, b, _ in ncp.requests): time.sleep(0.01)
                    self.assertTrue(any(b == 0x36 for _, b, _ in ncp.requests))
                    process.send_signal(signal.SIGTERM); stdout, stderr = process.communicate(timeout=3)
                    self.assertEqual((process.returncode, stdout), (5, ""))
                    error = json.loads(stderr)["error"]
                    self.assertEqual(error["code"], "znp_cancelled"); self.assertEqual((error["outcome"], error["retry_allowed"]), ("unknown", False))
                    self.assertEqual([data[3] for a, b, data in ncp.requests if b == 0x36], [60])
                    RECORDS.append({"command":"permit-join","cli":cli,"exit_code":process.returncode,"requests":[[a,b,data.hex()] for a,b,data in ncp.requests],"stdout":None,"stderr":json.loads(stderr)})
                finally:
                    if process.poll() is None: process.kill(); process.communicate(timeout=3)

    def test_invalid_options_are_rejected_before_opening_serial(self):
        extras = [(), arguments()[:2], arguments()[2:], (*arguments(), "--duration-seconds", "30"), (*arguments(), "--endpoint", "1"), (*arguments(), "--address", "0x0000"), (*arguments(), "--broadcast", "true")]
        extras += [arguments(value) for value in [121, 254, 255, -1, "1.5", "", "60\n"]]
        extras += [("--coordinator-ieee", value, "--duration-seconds", "60") for value in ["0"*16, "f"*16, COORDINATOR+"\n", "01020304050607AA"]]
        for cli in [False, True]:
            for extra in extras:
                with self.subTest(cli=cli, extra=extra), PtyNcp() as ncp:
                    result = ncp.execute("permit-join", cli=cli, extra=extra)
                    self.assertEqual((result.returncode, result.stdout), (2, ""), result)
                    self.assertEqual(json.loads(result.stderr), {"error":{"code":"invalid_znp_input"}})
                    self.assertEqual(ncp.requests, [])


if __name__ == "__main__":
    result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(JoinWindowPtyChecks))
    report = ROOT / os.environ.get("LIMEIOT_ZNP_JOIN_REPORT", ".dev/zigbee-commissioning/pty-results.json"); report.parent.mkdir(parents=True, exist_ok=True)
    report.write_text(json.dumps({"passed":result.wasSuccessful(),"tests":result.testsRun,"failures":len(result.failures),"errors":len(result.errors),"hardware":False,"serial_surface":"unix_pty","records":RECORDS},indent=2)+"\n")
    raise SystemExit(0 if result.wasSuccessful() else 1)
