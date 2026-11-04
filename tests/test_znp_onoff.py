"""真实Rust/CLI与软件PTY的固定On/Off旅程，不连接硬件。"""
import itertools
import json
import signal
import struct
import subprocess
import time
import unittest

from test_znp import ADDRESS, BINARY, CLI, IEEE, NODE, ROOT, RECORDS, PtyNcp, frame
from test_znp_environment import TARGET_ARGS, EnvironmentProtocol, descriptor, incoming, zdo

SIGNATURE = {"manufacturer": "LimeIoT", "model": "Switch-1", "application_version": 2, "hardware_version": 1}
SET_ARGS = ("--power", "on", "--manufacturer-code", "0x1234", "--signature-json", json.dumps(SIGNATURE))


class OnOffProtocol(EnvironmentProtocol):
    def __init__(self, order=(0, 1, 2), registered=False):
        super().__init__(order=order, registered=registered)
        self.clusters = [0, 6]
        self.power = False
        self.commands = []
        self.after_command_identity = None

    def __call__(self, a, b, data):
        if self.commands and self.after_command_identity == "device" and (a, b) == (0x25, 0):
            return zdo(0, b"\x00" + IEEE + struct.pack("<HBB", ADDRESS + 1, 0, 0))
        if self.commands and self.after_command_identity == "coordinator" and (a, b) == (0x25, 1) and data[:2] == b"\x00\x00":
            return zdo(1, b"\x00" + bytes.fromhex("1817161514131211") + bytes(4))
        if (a, b) == (0x25, 5) and data == bytes(4):
            endpoints = [239] if self.registered else []
            return zdo(5, bytes(5) + bytes([len(endpoints)]) + bytes(endpoints))
        if (a, b) == (0x25, 4) and data[:2] == b"\x00\x00":
            assert self.registered and data == bytes(4) + b"\xef"
            return zdo(4, descriptor(0, 239, 0x0104, 6 if self.conflict else 5, [], [0, 6]))
        if (a, b) == (0x24, 0):
            assert not self.registered and data == bytes.fromhex("ef040105000000000200000600")
            self.registered = True
            return frame(0x64, 0, b"\x00")
        if (a, b) != (0x24, 1):
            return super().__call__(a, b, data)
        address, destination, source, cluster, transaction, options, radius, length = struct.unpack("<HBBHBBBB", data[:10])
        assert (address, destination, source, transaction, options, radius) == (ADDRESS, 1, 239, self.af_count, 0x10, 30)
        assert cluster == (0 if self.af_count == 0 else 6) and length == len(data) - 10
        self.af_count += 1
        if data[10] == 0x01:
            assert cluster == 6 and data[10:] == bytes([1, transaction, data[12]]) and data[12] in (0, 1)
            self.commands.append(data[12] == 1)
            zcl = bytes([0x18, transaction, 0x0b, data[12], 0])
            # 协议受理与外部实际状态独立，夹具刻意不改变power。
        else:
            ids = [1, 3, 4, 5] if cluster == 0 else [0]
            assert data[10:] == bytes([0x10, transaction, 0]) + b"".join(struct.pack("<H", value) for value in ids)
            zcl = bytes([0x18, transaction, 1])
            if cluster == 0:
                zcl += bytes.fromhex("01000020020300002001")
                for attribute, value in ((4, b"LimeIoT"), (5, b"Switch-1")):
                    zcl += struct.pack("<HBBB", attribute, 0, 0x42, len(value)) + value
            else:
                zcl += struct.pack("<HBBB", 0, 0, 0x10, int(self.power))
        responses = (frame(0x64, 1, b"\x00"), frame(0x44, 0x80, bytes([0, 239, transaction])), incoming(cluster, zcl, destination=239))
        if self.af_override:
            return self.af_override(cluster, transaction, zcl, responses)
        foreign = b""
        if self.foreign:
            foreign = incoming(cluster, zcl, address=ADDRESS + 1, destination=239)
            foreign += incoming(cluster, zcl, source=2, destination=239) + incoming(cluster, zcl)
            foreign += incoming(cluster ^ 1, zcl, destination=239)
            foreign += incoming(cluster, zcl[:1] + bytes([transaction + 1]) + zcl[2:], destination=239)
            foreign += frame(0x44, 0x80, bytes([0, 240, transaction]))
        return foreign + b"".join(responses[index] for index in self.order)


class OnOffChecks(unittest.TestCase):
    def execute(self, protocol, write=False, cli=False, timeout_ms=2000, flags=None, fragments=False):
        with PtyNcp(protocol, fragments=fragments) as ncp:
            args = TARGET_ARGS + (SET_ARGS if write else ()) if flags is None else flags
            result = ncp.execute("set-onoff" if write else "read-onoff", cli=cli, timeout_ms=timeout_ms, extra=args)
            requests = list(ncp.requests)
        return result, requests

    def failure(self, protocol, code, write=True, **options):
        result, requests = self.execute(protocol, write=write, **options)
        self.assertEqual(result.returncode, 5, result)
        self.assertEqual(result.stdout, "")
        error = json.loads(result.stderr)["error"]
        self.assertEqual(error["code"], code)
        if write:
            self.assertEqual(error["outcome"], "unknown")
            self.assertFalse(error["retry_allowed"])
        self.assertFalse(any((a, b) in ((0x25, 0x36), (0x24, 4), (0x21, 0)) for a, b, _ in requests))
        return error

    def test_read_and_explicit_on_off_all_six_receipt_orders(self):
        for cli, write, power, order in itertools.product((False, True), (False, True), (False, True), itertools.permutations(range(3))):
            with self.subTest(cli=cli, write=write, power=power, order=order):
                protocol = OnOffProtocol(order); protocol.power = power
                flags = TARGET_ARGS + (("--power", "on" if power else "off") + SET_ARGS[2:] if write else ())
                before = int(time.time() * 1000)
                result, _ = self.execute(protocol, write=write, cli=cli, flags=flags)
                after = int(time.time() * 1000)
                self.assertEqual(result.returncode, 0, result.stderr)
                report = json.loads(result.stdout); value = report["result"]
                self.assertEqual(value["signature"], SIGNATURE)
                if write:
                    self.assertEqual(value["status"], "protocol_accepted"); self.assertFalse(value["device_state_confirmed"])
                    self.assertEqual(value["power_requested"], power); self.assertNotIn("power", value)
                    self.assertEqual(protocol.commands, [power]); self.assertTrue(report["device_write_requested"])
                    observed = value["accepted_at_unix_ms"]
                else:
                    self.assertEqual(value["power"]["value"], power); self.assertEqual(protocol.commands, [])
                    observed = value["power"]["received_at_unix_ms"]
                self.assertTrue(before <= observed <= report["observed_at_unix_ms"] <= after)

    def test_fragmented_transport_and_existing_host_are_supported(self):
        protocol = OnOffProtocol(registered=True)
        result, requests = self.execute(protocol, write=True, cli=True, fragments=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(any((a, b) == (0x24, 0) for a, b, _ in requests))
        self.assertEqual(protocol.commands, [True]); self.assertFalse(protocol.power)

    def test_host_conflict_never_overwrites_endpoint_or_sends_switch(self):
        protocol = OnOffProtocol(registered=True); protocol.conflict = True
        self.failure(protocol, "znp_endpoint_conflict")
        self.assertEqual(protocol.commands, []); self.assertEqual(protocol.af_count, 0)

    def test_profile_or_cluster_mismatch_zero_switch(self):
        for profile, clusters in ((0xc05e, [0, 6]), (0x0104, [0])):
            protocol = OnOffProtocol(); protocol.profile, protocol.clusters = profile, clusters
            self.failure(protocol, "znp_profile_unsupported"); self.assertEqual(protocol.af_count, 0)

    def test_every_signature_field_and_manufacturer_code_are_checked_before_switch(self):
        for key, value in (("manufacturer", "Other"), ("model", "Other"), ("application_version", 3), ("hardware_version", 2), ("manufacturer_code", 0x1235)):
            expected = dict(SIGNATURE)
            code = value if key == "manufacturer_code" else 0x1234
            if key != "manufacturer_code": expected[key] = value
            flags = TARGET_ARGS + ("--power", "on", "--manufacturer-code", f"0x{code:04x}", "--signature-json", json.dumps(expected))
            protocol = OnOffProtocol(); self.failure(protocol, "znp_signature_mismatch", flags=flags, cli=True)
            self.assertEqual(protocol.commands, [])

    def test_identity_change_before_switch_zero_write(self):
        for key in ("change_device", "change_coordinator"):
            protocol = OnOffProtocol(); setattr(protocol, key, True)
            self.failure(protocol, "znp_identity_changed"); self.assertEqual(protocol.commands, [])

    def test_identity_change_after_one_switch_remains_unknown(self):
        for key in ("device", "coordinator"):
            protocol = OnOffProtocol(); protocol.after_command_identity = key
            self.failure(protocol, "znp_identity_changed", cli=True); self.assertEqual(protocol.commands, [True])

    def test_foreign_address_endpoint_cluster_id_and_confirm_are_not_adopted(self):
        protocol = OnOffProtocol(); protocol.foreign = True
        result, _ = self.execute(protocol, write=True, cli=True)
        self.assertEqual(result.returncode, 0, result.stderr); self.assertEqual(protocol.commands, [True])

    def test_boolean_type_invalid_values_and_extra_attributes_are_rejected(self):
        for body in (bytes.fromhex("0000002001"), bytes.fromhex("0000001002"), bytes.fromhex("00000010ff"), bytes.fromhex("00000010000100001001"), b"", bytes.fromhex("00000010")):
            protocol = OnOffProtocol()
            protocol.af_override = lambda c, t, _z, r: b"".join(r) if c == 0 else r[0] + r[1] + incoming(c, bytes([0x18, t, 1]) + body, destination=239)
            self.failure(protocol, "znp_invalid_response", write=False)
            self.assertEqual(protocol.commands, [])

    def test_default_response_wrong_command_direction_type_and_length_are_rejected(self):
        for payload in (bytes([0x18, 0, 0x0b, 0, 0]), bytes([0x10, 0, 0x0b, 1, 0]), bytes([0x19, 0, 0x0b, 1, 0]), bytes([0x18, 0, 0x0b, 1]), bytes([0x18, 0, 0x0b, 1, 0, 0])):
            protocol = OnOffProtocol()
            protocol.af_override = lambda c, t, _z, r: b"".join(r) if c == 0 else r[0] + r[1] + incoming(c, payload[:1] + bytes([t]) + payload[2:], destination=239)
            self.failure(protocol, "znp_invalid_response"); self.assertEqual(protocol.commands, [True])

    def test_zcl_rejection_preserves_status_and_does_not_retry(self):
        protocol = OnOffProtocol()
        protocol.af_override = lambda c, t, z, r: b"".join(r) if c == 0 else r[0] + r[1] + incoming(c, z[:-1] + b"\x81", destination=239)
        self.assertEqual(self.failure(protocol, "znp_zcl_rejected", cli=True)["status"], 0x81)
        self.assertEqual(protocol.commands, [True])

    def test_missing_each_receipt_timeout_has_one_switch_and_no_retry(self):
        for indexes in ((0, 1), (0, 2), (1, 2)):
            protocol = OnOffProtocol()
            protocol.af_override = lambda c, _t, _z, r: b"".join(r) if c == 0 else b"".join(r[i] for i in indexes)
            self.failure(protocol, "znp_timeout", timeout_ms=300, cli=True); self.assertEqual(protocol.commands, [True])

    def test_mt_rejection_and_aps_failure_are_not_success(self):
        for code, response in (("znp_request_rejected", frame(0x64, 1, b"\xcd")), ("znp_delivery_failed", frame(0x44, 0x80, b"\xb7\xef\x01"))):
            protocol = OnOffProtocol()
            protocol.af_override = lambda c, _t, _z, r: b"".join(r) if c == 0 else response
            self.failure(protocol, code); self.assertEqual(protocol.commands, [True])

    def test_invalid_flags_are_rejected_before_open_in_binary_and_cli(self):
        cases = [TARGET_ARGS, TARGET_ARGS + SET_ARGS + ("--power", "off"), TARGET_ARGS + ("--power", "toggle") + SET_ARGS[2:],
                 TARGET_ARGS + SET_ARGS[:-1] + ('{"manufacturer":"A","manufacturer":"B"}',),
                 TARGET_ARGS + SET_ARGS[:-1] + (json.dumps({**SIGNATURE, "model": "x" * 33}),),
                 TARGET_ARGS + SET_ARGS[:-1] + (json.dumps({**SIGNATURE, "hardware_version": 1.5}),)]
        for cli, flags in itertools.product((False, True), cases):
            with PtyNcp() as ncp:
                result = ncp.execute("set-onoff", cli=cli, extra=flags)
                self.assertEqual(result.returncode, 2, result); self.assertEqual(ncp.requests, [])
        for cli in (False, True):
            with PtyNcp() as ncp:
                result = ncp.execute("read-onoff", cli=cli, extra=TARGET_ARGS + SET_ARGS)
                self.assertEqual(result.returncode, 2, result); self.assertEqual(ncp.requests, [])

    def test_sigterm_after_switch_cancels_without_replay_and_restores_pty(self):
        for cli in (False, True):
            protocol = OnOffProtocol()
            protocol.af_override = lambda c, _t, _z, r: b"".join(r) if c == 0 else b""
            with PtyNcp(protocol) as ncp:
                args = ([NODE, str(CLI), "zigbee"] if cli else [str(BINARY)])
                args += ["set-onoff", "--serial", ncp.path, "--timeout-ms", "10000", *TARGET_ARGS, *SET_ARGS]
                child = subprocess.Popen(args, cwd=ROOT, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                try:
                    deadline = time.monotonic() + 3
                    while not protocol.commands and time.monotonic() < deadline: time.sleep(0.01)
                    self.assertEqual(protocol.commands, [True]); child.send_signal(signal.SIGTERM)
                    stdout, stderr = child.communicate(timeout=3)
                    self.assertEqual(child.returncode, 5); self.assertEqual(stdout, "")
                    error = json.loads(stderr)["error"]
                    self.assertEqual(error["code"], "znp_cancelled"); self.assertEqual(error["outcome"], "unknown"); self.assertFalse(error["retry_allowed"])
                    self.assertEqual(protocol.commands, [True])
                finally:
                    if child.poll() is None: child.kill(); child.communicate()


if __name__ == "__main__":
    result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(OnOffChecks))
    archive = ROOT / ".dev/znp-onoff-20261104"; archive.mkdir(exist_ok=True)
    (archive / "pty-results.json").write_text(json.dumps({"passed": result.wasSuccessful(), "tests": result.testsRun,
        "failures": len(result.failures), "errors": len(result.errors), "hardware": False, "records": RECORDS}, indent=2) + "\n")
    raise SystemExit(0 if result.wasSuccessful() else 1)
