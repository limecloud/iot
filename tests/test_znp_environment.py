"""以真实CLI和Unix伪终端验证固定ZCL读取，不访问硬件。"""
import itertools
import json
import struct
import time
import unittest

from test_znp import ADDRESS, IEEE, ROOT, RECORDS, PtyNcp, frame, standard_response

COORDINATOR = bytes.fromhex("0807060504030201")
TARGET_ARGS = ("--coordinator-ieee", "0102030405060708", "--ieee", "1122334455667788", "--endpoint", "1")


def zdo(command, data):
    return frame(0x65, command, b"\x00") + frame(0x45, command | 0x80, data)


def descriptor(address, endpoint, profile, device, inputs, outputs):
    body = struct.pack("<BHHBB", endpoint, profile, device, 0, len(inputs))
    body += b"".join(struct.pack("<H", value) for value in inputs)
    body += bytes([len(outputs)]) + b"".join(struct.pack("<H", value) for value in outputs)
    return struct.pack("<HBH", address, 0, address) + bytes([len(body)]) + body


def incoming(cluster, zcl, address=ADDRESS, source=1, destination=240):
    # TI固定修订mt_af.c：17字节头、ZCL正文、MAC源短地址及radius。
    body = struct.pack("<HHH", 0, cluster, address) + bytes([source, destination, 0, 200, 1])
    body += struct.pack("<I", 1234) + bytes([0, len(zcl)]) + zcl + struct.pack("<HB", address, 30)
    assert len(body) == 20 + len(zcl)
    return frame(0x44, 0x81, body)


class EnvironmentProtocol:
    def __init__(self, order=(0, 1, 2), registered=False, temperature=2356, humidity=4567):
        self.order = order
        self.registered = registered
        self.temperature = temperature
        self.humidity = humidity
        self.profile = 0x0104
        self.clusters = [0, 0x0402, 0x0405]
        self.conflict = False
        self.lookup_count = 0
        self.coordinator_count = 0
        self.af_count = 0
        self.change_device = False
        self.change_coordinator = False
        self.af_override = None
        self.foreign = False

    def __call__(self, a, b, data):
        if (a, b) == (0x21, 1):
            assert not data
            return frame(0x61, 1, b"\x15\x00")
        if (a, b) == (0x25, 0):
            assert data == IEEE + b"\x00\x00"
            self.lookup_count += 1
            address = ADDRESS + int(self.change_device and self.lookup_count > 1)
            return zdo(b, b"\x00" + IEEE + struct.pack("<HBB", address, 0, 0))
        if (a, b) == (0x25, 1) and data[:2] == b"\x00\x00":
            assert data == bytes(4)
            self.coordinator_count += 1
            ieee = bytes.fromhex("1817161514131211") if self.change_coordinator and self.coordinator_count > 1 else COORDINATOR
            return zdo(b, b"\x00" + ieee + bytes(4))
        if (a, b) == (0x25, 5):
            address, query = struct.unpack("<HH", data)
            assert address == query and address in (0, ADDRESS)
            endpoints = ([240] if self.registered else []) if address == 0 else [1]
            return zdo(b, struct.pack("<HBHB", address, 0, address, len(endpoints)) + bytes(endpoints))
        if (a, b) == (0x25, 4):
            address, query, endpoint = struct.unpack("<HHB", data)
            assert query == address
            if address == 0:
                assert self.registered and endpoint == 240
                return zdo(b, descriptor(0, 240, 0x0104, 6 if self.conflict else 5, [], [0, 0x0402, 0x0405]))
            assert address == ADDRESS and endpoint == 1
            return zdo(b, descriptor(ADDRESS, 1, self.profile, 0x0302, self.clusters, []))
        if (a, b) == (0x24, 0):
            assert not self.registered
            assert data == bytes.fromhex("f00401050000000003000002040504")
            self.registered = True
            return frame(0x64, 0, b"\x00")
        if (a, b) == (0x24, 1):
            address, destination, source, cluster, transaction, options, radius, length = struct.unpack("<HBBHBBBB", data[:10])
            expected_cluster = (0, 0x0402, 0x0405)[self.af_count % 3]
            assert (address, destination, source, cluster, transaction, options, radius) == (ADDRESS, 1, 240, expected_cluster, self.af_count, 0x10, 30)
            assert length == len(data) - 10
            ids = [1, 3, 4, 5] if cluster == 0 else [0]
            assert data[10:] == bytes([0x10, transaction, 0]) + b"".join(struct.pack("<H", value) for value in ids)
            self.af_count += 1
            zcl = bytes([0x18, transaction, 1])
            if cluster == 0:
                zcl += bytes.fromhex("01000020020300002001")
                for attribute, value in ((4, b"LimeIoT"), (5, b"Environment-1")):
                    zcl += struct.pack("<HBBB", attribute, 0, 0x42, len(value)) + value
            elif cluster == 0x0402:
                zcl += struct.pack("<HBBh", 0, 0, 0x29, self.temperature)
            else:
                zcl += struct.pack("<HBBH", 0, 0, 0x21, self.humidity)
            accepted = frame(0x64, 1, b"\x00")
            delivered = frame(0x44, 0x80, bytes([0, 240, transaction]))
            received = incoming(cluster, zcl)
            if self.af_override:
                return self.af_override(cluster, transaction, zcl, (accepted, delivered, received))
            foreign = b""
            if self.foreign:
                foreign = incoming(cluster, zcl, address=ADDRESS + 1)
                foreign += incoming(cluster, zcl, source=2) + incoming(cluster, zcl, destination=239)
                foreign += incoming(cluster ^ 1, zcl) + incoming(cluster, bytes([0x18, transaction + 1]) + zcl[2:])
                foreign += frame(0x44, 0x80, bytes([0, 239, transaction]))
            responses = (accepted, delivered, received)
            return foreign + b"".join(responses[index] for index in self.order)
        return standard_response(a, b, data)


class EnvironmentChecks(unittest.TestCase):
    def execute(self, protocol, cli=True, timeout_ms=2500, extra=()):
        with PtyNcp(protocol) as ncp:
            result = ncp.execute("read-environment", cli=cli, timeout_ms=timeout_ms, extra=TARGET_ARGS + extra)
            requests = list(ncp.requests)
        return result, requests

    def failure(self, protocol, code, timeout_ms=2500):
        result, requests = self.execute(protocol, timeout_ms=timeout_ms)
        self.assertEqual(result.returncode, 5, result)
        self.assertEqual(result.stdout, "")
        self.assertEqual(json.loads(result.stderr)["error"]["code"], code)
        self.assertFalse(any((a, b) in ((0x24, 4), (0x21, 0), (0x25, 0x36)) for a, b, _ in requests))
        return json.loads(result.stderr)["error"]

    def test_reading_all_six_response_orders(self):
        for order in itertools.permutations(range(3)):
            with self.subTest(order=order):
                protocol = EnvironmentProtocol(order=order)
                before = int(time.time() * 1000)
                result, requests = self.execute(protocol)
                after = int(time.time() * 1000)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stderr, "")
                report = json.loads(result.stdout)
                value = report["result"]
                self.assertFalse(report["device_binding_created"])
                self.assertEqual(value["coordinator_ieee"], "0102030405060708")
                self.assertEqual(value["ieee_address"], "1122334455667788")
                self.assertEqual(value["network_address"], ADDRESS)
                self.assertEqual(value["endpoint"], 1)
                self.assertEqual(value["manufacturer_code"], 0x1234)
                self.assertEqual(value["signature"], {"manufacturer": "LimeIoT", "model": "Environment-1", "application_version": 2, "hardware_version": 1})
                for key, expected in (("temperature_celsius_x100", 2356), ("humidity_percent_x100", 4567)):
                    self.assertEqual(value[key]["value"], expected)
                    self.assertTrue(before <= value[key]["received_at_unix_ms"] <= report["observed_at_unix_ms"] <= after)
                self.assertEqual(protocol.af_count, 3)
                self.assertEqual(protocol.lookup_count, 2)
                self.assertEqual(protocol.coordinator_count, 2)
                self.assertEqual(len(requests), 19)

    def test_existing_matching_endpoint_is_reused_without_registration(self):
        result, requests = self.execute(EnvironmentProtocol(registered=True), cli=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(any((a, b) == (0x24, 0) for a, b, _ in requests))

    def test_existing_conflicting_endpoint_is_never_deleted_or_replaced(self):
        protocol = EnvironmentProtocol(registered=True)
        protocol.conflict = True
        self.failure(protocol, "znp_endpoint_conflict")
        self.assertEqual(protocol.af_count, 0)

    def test_foreign_address_endpoint_cluster_sequence_and_confirm_are_not_adopted(self):
        protocol = EnvironmentProtocol()
        protocol.foreign = True
        result, _ = self.execute(protocol)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["result"]["temperature_celsius_x100"]["value"], 2356)

    def test_wrong_profile_or_missing_cluster_has_zero_af(self):
        for profile, clusters in ((0xc05e, [0, 0x0402, 0x0405]), (0x0104, [0, 0x0402])):
            protocol = EnvironmentProtocol()
            protocol.profile, protocol.clusters = profile, clusters
            self.failure(protocol, "znp_profile_unsupported")
            self.assertEqual(protocol.af_count, 0)

    def test_missing_af_capability_is_rejected_before_zdo(self):
        result, requests = self.execute(standard_response)
        self.assertEqual(result.returncode, 5, result)
        self.assertEqual(json.loads(result.stderr)["error"]["code"], "znp_capability_missing")
        self.assertEqual(len(requests), 2)

    def test_ncp_rejection_and_aps_failure_preserve_status(self):
        for code, command, payload in (("znp_request_rejected", 1, b"\xcd"), ("znp_delivery_failed", 0x80, b"\xb7\xf0\x00")):
            protocol = EnvironmentProtocol()
            protocol.af_override = lambda _c, _t, _z, _r: frame(0x64 if command == 1 else 0x44, command, payload)
            error = self.failure(protocol, code)
            self.assertEqual(error["status"], payload[0])
            self.assertEqual(protocol.af_count, 1)

    def test_zcl_default_response_and_attribute_rejection(self):
        for suffix in (bytes([0x0b, 0, 0x81]), bytes([1, 1, 0, 0x86])):
            protocol = EnvironmentProtocol()
            protocol.af_override = lambda c, t, _z, r: r[0] + r[1] + incoming(c, bytes([0x18, t]) + suffix)
            error = self.failure(protocol, "znp_zcl_rejected")
            self.assertEqual(error["status"], suffix[-1])

    def test_temperature_type_missing_duplicate_extra_and_truncated_attributes(self):
        bad_records = (bytes.fromhex("00000021cd08"), b"", bytes.fromhex("00000029cd0800000029cd08"), bytes.fromhex("01000029cd08"), bytes.fromhex("00000029cd"))
        for record in bad_records:
            protocol = EnvironmentProtocol()
            protocol.af_override = lambda c, t, _z, r: b"".join(r) if c != 0x0402 else r[0] + r[1] + incoming(c, bytes([0x18, t, 1]) + record)
            self.failure(protocol, "znp_invalid_response")

    def test_basic_strings_reject_controls_invalid_utf8_and_oversize(self):
        for text in (b"\x00", b"\xff", b" ", b"x" * 33):
            protocol = EnvironmentProtocol()
            protocol.af_override = lambda c, t, z, r: r[0] + r[1] + incoming(c, z[:13] + struct.pack("<HBBB", 4, 0, 0x42, len(text)) + text + struct.pack("<HBBB", 5, 0, 0x42, 1) + b"M")
            self.failure(protocol, "znp_invalid_response")

    def test_invalid_measurement_values_are_not_clamped_or_partially_returned(self):
        for temperature, humidity in ((-32768, 5000), (-4501, 5000), (13001, 5000), (1000, 10001), (1000, 65535)):
            self.failure(EnvironmentProtocol(temperature=temperature, humidity=humidity), "znp_invalid_response")

    def test_measurement_boundaries_are_preserved(self):
        for temperature, humidity in ((-4500, 0), (13000, 10000)):
            result, _ = self.execute(EnvironmentProtocol(temperature=temperature, humidity=humidity))
            self.assertEqual(result.returncode, 0, result.stderr)
            value = json.loads(result.stdout)["result"]
            self.assertEqual(value["temperature_celsius_x100"]["value"], temperature)
            self.assertEqual(value["humidity_percent_x100"]["value"], humidity)

    def test_duplicate_confirm_and_legacy_truncated_incoming_are_rejected(self):
        for expected, mutate in (("znp_unexpected_response", lambda r: r[0] + r[1] + r[1] + r[2]), ("znp_invalid_response", lambda r: r[0] + r[1] + frame(0x44, 0x81, bytes(17)))):
            protocol = EnvironmentProtocol()
            protocol.af_override = lambda _c, _t, _z, r: mutate(r)
            self.failure(protocol, expected)

    def test_missing_delivery_or_response_expires_without_retry(self):
        for indexes in ((0, 2), (0, 1), (1, 2)):
            protocol = EnvironmentProtocol()
            protocol.af_override = lambda _c, _t, _z, r: b"".join(r[i] for i in indexes)
            self.failure(protocol, "znp_timeout", timeout_ms=300)
            self.assertEqual(protocol.af_count, 1)

    def test_short_address_change_after_reading_discards_all_measurements(self):
        protocol = EnvironmentProtocol()
        protocol.change_device = True
        self.failure(protocol, "znp_identity_changed")
        self.assertEqual(protocol.af_count, 3)

    def test_coordinator_change_discards_all_measurements(self):
        protocol = EnvironmentProtocol()
        protocol.change_coordinator = True
        self.failure(protocol, "znp_identity_changed")
        self.assertEqual(protocol.af_count, 3)

    def test_target_flags_are_checked_before_open_in_cli_and_binary(self):
        for cli in (False, True):
            for flags in ((), ("--coordinator-ieee", "0000000000000000", "--ieee", "1122334455667788", "--endpoint", "1"), TARGET_ARGS + ("--endpoint", "2"), TARGET_ARGS[:-1] + ("241",), TARGET_ARGS[:-1] + ("+1",)):
                with PtyNcp() as ncp:
                    result = ncp.execute("read-environment", cli=cli, extra=flags)
                    self.assertEqual(result.returncode, 2, result)
                    self.assertEqual(ncp.requests, [])
            with PtyNcp() as ncp:
                result = ncp.execute("probe", cli=cli, extra=TARGET_ARGS)
                self.assertEqual(result.returncode, 2, result)
                self.assertEqual(ncp.requests, [])


if __name__ == "__main__":
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(EnvironmentChecks)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    archive = ROOT / ".dev/znp-environment-20261104"
    archive.mkdir(parents=True, exist_ok=True)
    (archive / "pty-results.json").write_text(json.dumps({
        "passed": result.wasSuccessful(), "tests": result.testsRun,
        "failures": len(result.failures), "errors": len(result.errors),
        "hardware": False, "serial_surface": "unix_pty", "records": RECORDS,
    }, indent=2) + "\n")
    raise SystemExit(0 if result.wasSuccessful() else 1)
