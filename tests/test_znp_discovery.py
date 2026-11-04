"""真实Rust串口与CLI的邻居表发现检查，仅使用软件PTY。"""
import json
from pathlib import Path
import signal
import struct
import subprocess
import unittest

from test_znp import BINARY, CLI, NODE, PtyNcp, RECORDS, ROOT, frame

COORDINATOR = "0102030405060708"
TARGETS = [f"112233445566{index:04x}" for index in range(64)]
EXTRA = ("--coordinator-ieee", COORDINATOR)


def entry(index):
    return (bytes.fromhex("a8a7a6a5a4a3a2a1") + bytes.fromhex(TARGETS[index])[::-1]
            + struct.pack("<HBBBB", 0x1234 + index, 0x16, 2, 1, 180 + index))


def page(total, start, entries, source=0):
    payload = struct.pack("<HBBBB", source, 0, total, start, len(entries)) + b"".join(entries)
    return frame(0x65, 0x31, b"\x00") + frame(0x45, 0xB1, payload)


class Protocol:
    def __init__(self, total=4, page_size=2, mutate=None, capabilities=0x11):
        self.total, self.page_size, self.mutate, self.capabilities = total, page_size, mutate, capabilities
        self.identities = 0

    def __call__(self, a, b, data):
        if (a, b) == (0x21, 1):
            assert not data
            return frame(0x61, 1, struct.pack("<H", self.capabilities))
        if (a, b) == (0x21, 2):
            assert not data
            return frame(0x61, 2, bytes([2, 1, 3, 0, 1, 11]))
        if (a, b) == (0x25, 1):
            assert data == bytes(4)
            self.identities += 1
            return frame(0x65, 1, b"\x00") + frame(0x45, 0x81, b"\x00" + bytes.fromhex(COORDINATOR)[::-1] + bytes(4))
        assert (a, b) == (0x25, 0x31) and len(data) == 3 and data[:2] == bytes(2)
        start = data[2]
        entries = [entry(index) for index in range(start, min(self.total, start + self.page_size))]
        return self.mutate(start, entries) if self.mutate else page(self.total, start, entries)


class NeighborPtyChecks(unittest.TestCase):
    def execute(self, protocol=None, cli=False, fragments=False, timeout_ms=3000):
        with PtyNcp(protocol or Protocol(), fragments=fragments) as ncp:
            result = ncp.execute("neighbors", cli=cli, extra=EXTRA, timeout_ms=timeout_ms)
            return result, ncp.requests

    def failure(self, protocol, code, timeout_ms=1000, status=None):
        result, requests = self.execute(protocol, timeout_ms=timeout_ms)
        self.assertEqual(result.returncode, 5, result)
        self.assertEqual(result.stdout, "")
        detail = json.loads(result.stderr)["error"]
        self.assertEqual(detail["code"], code)
        if status is not None:
            self.assertEqual(detail["status"], status)
        return requests

    def test_fragmented_multipage_discovery_through_cli(self):
        result, requests = self.execute(cli=True, fragments=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, "")
        value = json.loads(result.stdout)
        self.assertFalse(value["device_binding_created"])
        self.assertEqual(value["operation"], "neighbors")
        table = value["result"]
        self.assertEqual(table["coordinator_ieee"], COORDINATOR)
        self.assertEqual(table["scope"], "coordinator_neighbors")
        self.assertEqual((table["table_entries"], table["page_count"]), (4, 2))
        self.assertEqual([item["ieee_address"] for item in table["items"]], TARGETS[:4])
        self.assertEqual(table["items"][0], {"extended_pan_id": "a1a2a3a4a5a6a7a8", "ieee_address": TARGETS[0],
                         "network_address": 0x1234, "device_type": 2, "rx_on_when_idle": 1, "relationship": 1,
                         "flags": 0x16, "permit_joining": 2, "depth": 1, "link_quality": 180})
        self.assertEqual([(a, b) for a, b, _ in requests], [(0x21, 1), (0x21, 2), (0x25, 1), (0x25, 0x31), (0x25, 0x31), (0x25, 1)])
        self.assertEqual([data.hex() for a, b, data in requests if (a, b) == (0x25, 0x31)], ["000000", "000002"])

    def test_empty_table_still_rechecks_coordinator(self):
        result, requests = self.execute(Protocol(total=0), cli=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        table = json.loads(result.stdout)["result"]
        self.assertEqual((table["items"], table["table_entries"], table["page_count"]), ([], 0, 1))
        self.assertEqual(sum((a, b) == (0x25, 1) for a, b, _ in requests), 2)

    def test_actual_64_entry_capacity_is_not_truncated(self):
        result, requests = self.execute(Protocol(total=64, page_size=11), cli=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        table = json.loads(result.stdout)["result"]
        self.assertEqual((len(table["items"]), table["page_count"]), (64, 6))
        self.assertEqual(table["items"][-1]["ieee_address"], TARGETS[63])
        self.assertEqual(sum(b == 0x31 for _, b, _ in requests), 6)

    def test_async_before_sync(self):
        def mutate(start, entries):
            response = page(4, start, entries)
            return response[6:] + response[:6]
        result, _ = self.execute(Protocol(mutate=mutate))
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_foreign_source_and_wrong_page_are_not_adopted(self):
        def mutate(start, entries):
            foreign = page(4, start, entries, source=0x1234)[6:]
            stale = page(4, 99, entries)[6:]
            return foreign + stale + page(4, start, entries)
        result, _ = self.execute(Protocol(mutate=mutate), cli=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(json.loads(result.stdout)["result"]["items"]), 4)

    def test_unknown_flag_values_are_preserved_without_inventing_capabilities(self):
        def mutate(start, entries):
            changed = bytearray(entries[0]); changed[18:20] = bytes([0xFF, 0xFF])
            return page(1, start, [bytes(changed)])
        result, _ = self.execute(Protocol(total=1, mutate=mutate), cli=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        item = json.loads(result.stdout)["result"]["items"][0]
        self.assertEqual([item[k] for k in ("flags", "device_type", "rx_on_when_idle", "relationship", "permit_joining")], [255, 3, 3, 7, 255])

    def test_table_total_change_discards_all_partial_results(self):
        self.failure(Protocol(mutate=lambda start, entries: page(4 if start == 0 else 5, start, entries)), "znp_neighbor_table_changed")

    def test_zero_progress_and_length_count_mismatch_fail(self):
        for mutate in [lambda *_: page(4, 0, []),
                       lambda start, entries: frame(0x65, 0x31, b"\x00") + frame(0x45, 0xB1, struct.pack("<HBBBB", 0, 0, 4, start, 2) + entries[0]),
                       lambda start, entries: page(1, start, entries)]:
            with self.subTest(mutate=mutate):
                self.failure(Protocol(mutate=mutate), "znp_invalid_response", timeout_ms=300)

    def test_capacity_overflow_is_explicit_without_partial_stdout(self):
        self.failure(Protocol(mutate=lambda start, entries: page(65, start, entries)), "znp_limit_exceeded")

    def test_duplicate_short_or_ieee_addresses_across_pages_fail(self):
        for offset, length in [(8, 8), (16, 2)]:
            def mutate(start, entries):
                if start:
                    changed = bytearray(entries[0]); changed[offset:offset + length] = entry(0)[offset:offset + length]; entries[0] = bytes(changed)
                return page(4, start, entries)
            with self.subTest(offset=offset):
                self.failure(Protocol(mutate=mutate), "znp_neighbor_table_changed")

    def test_invalid_neighbor_addresses_fail(self):
        for offset, data in [(8, bytes(8)), (8, bytes([255]) * 8), (16, bytes(2)), (16, bytes.fromhex("f8ff"))]:
            def mutate(start, entries):
                changed = bytearray(entries[0]); changed[offset:offset + len(data)] = data
                return page(1, 0, [bytes(changed)])
            with self.subTest(offset=offset, data=data.hex()):
                self.failure(Protocol(total=1, mutate=mutate), "znp_invalid_response")

    def test_wrong_coordinator_before_and_after_table_fails(self):
        for changed_read in [1, 2]:
            protocol = Protocol()
            def handler(a, b, data):
                response = protocol(a, b, data)
                if (a, b) == (0x25, 1) and protocol.identities == changed_read:
                    return frame(0x65, 1, b"\x00") + frame(0x45, 0x81, b"\x00" + bytes.fromhex("0902030405060708")[::-1] + bytes(4))
                return response
            with self.subTest(changed_read=changed_read):
                requests = self.failure(handler, "znp_identity_changed")
                self.assertEqual(sum(b == 0x31 for _, b, _ in requests), 0 if changed_read == 1 else 2)

    def test_missing_capability_does_not_read_network(self):
        requests = self.failure(Protocol(capabilities=1), "znp_capability_missing")
        self.assertEqual(len(requests), 2)

    def test_request_and_device_rejection_keep_numeric_status(self):
        self.failure(Protocol(mutate=lambda *_: frame(0x65, 0x31, b"\x01")), "znp_request_rejected", status=1)
        self.failure(Protocol(mutate=lambda *_: frame(0x65, 0x31, b"\x00") + frame(0x45, 0xB1, b"\x00\x00\x84")), "znp_device_rejected", status=0x84)

    def test_missing_page_response_times_out_without_retry(self):
        requests = self.failure(Protocol(mutate=lambda *_: frame(0x65, 0x31, b"\x00")), "znp_timeout", timeout_ms=100)
        self.assertEqual(sum(b == 0x31 for _, b, _ in requests), 1)

    def test_notification_budget_is_shared_by_all_pages(self):
        def mutate(start, entries):
            return frame(0x45, 0xC0, b"\x09") * 17 + page(4, start, entries)
        self.failure(Protocol(mutate=mutate), "znp_limit_exceeded")

    def test_cancelled_page_restores_serial_and_has_no_partial_stdout(self):
        protocol = Protocol(mutate=lambda *_: None)
        with PtyNcp(protocol) as ncp:
            process = subprocess.Popen([str(BINARY), "neighbors", "--serial", ncp.path, "--timeout-ms", "30000", *EXTRA], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                import time
                end = time.monotonic() + 3
                while time.monotonic() < end and not any(b == 0x31 for _, b, _ in ncp.requests):
                    time.sleep(0.01)
                self.assertTrue(any(b == 0x31 for _, b, _ in ncp.requests))
                process.send_signal(signal.SIGTERM)
                stdout, stderr = process.communicate(timeout=3)
                self.assertEqual((process.returncode, stdout), (5, ""))
                self.assertEqual(json.loads(stderr)["error"]["code"], "znp_cancelled")
            finally:
                if process.poll() is None:
                    process.kill(); process.communicate(timeout=3)

    def test_invalid_input_is_rejected_before_opening_serial(self):
        for cli in [False, True]:
            for extra in [(), ("--coordinator-ieee", "0" * 16), (*EXTRA, "--endpoint", "1"), (*EXTRA, "--address", "0x1234"), (*EXTRA, "--coordinator-ieee", COORDINATOR)]:
                with self.subTest(cli=cli, extra=extra), PtyNcp() as ncp:
                    result = ncp.execute("neighbors", cli=cli, extra=extra)
                    self.assertEqual(result.returncode, 2, result.stderr)
                    self.assertEqual(json.loads(result.stderr)["error"]["code"], "invalid_znp_input")
                    self.assertEqual(ncp.requests, [])


if __name__ == "__main__":
    result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(NeighborPtyChecks))
    archive = ROOT / ".dev/znp-discovery-20261104"; archive.mkdir(parents=True, exist_ok=True)
    (archive / "pty-results.json").write_text(json.dumps({"passed": result.wasSuccessful(), "tests": result.testsRun,
        "failures": len(result.failures), "errors": len(result.errors), "hardware": False, "serial_surface": "unix_pty", "records": RECORDS}, indent=2) + "\n")
    raise SystemExit(0 if result.wasSuccessful() else 1)
