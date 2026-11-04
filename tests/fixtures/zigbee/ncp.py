"""供真实网关软件旅程使用的可控Unix伪终端NCP。"""
import json
from pathlib import Path
import struct
import sys
import termios
import tty

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from test_znp import PtyNcp, frame
from test_znp_environment import COORDINATOR, descriptor, incoming, zdo


class RuntimeProtocol:
    def __init__(self, on_off=False):
        self.on_off = on_off
        self.switch_ieee = "1122334455667789"
        self.power = False
        self.switch_mode = "normal"
        self.switch_commands = []
        self.on_off_registered = False
        self.controls = {
            "1122334455667788": {"temperature": 2700, "mode": "normal"},
            "1122334455667789": {"temperature": 2600, "mode": "normal"},
        }
        self.addresses = {0x1234 + index: ieee for index, ieee in enumerate(self.controls)}
        self.registered = False
        self.samples = {ieee: 0 for ieee in self.controls}
        self.host_checks = 0
        self.session_samples = []
        self.next_af = 0
        self.timeout_requests = 0
        self.discovery_mode = "normal"
        self.lookup_count = 0
        self.neighbor_requests = 0
        self.af_requests = 0
        self.history = []
        self.join_mode = "normal"
        self.join_requests = []

    def __call__(self, a, b, data):
        if (a, b) == (0x21, 1):
            assert not data
            return frame(0x61, 1, b"\x15\x00")
        if (a, b) == (0x21, 2):
            assert not data
            return frame(0x61, 2, bytes([2, 1, 3, 0, 1, 11, 22, 33, 44, 55]))
        if (a, b) == (0x25, 0):
            assert len(data) == 10 and data[8:] == bytes(2)
            ieee = data[:8][::-1].hex()
            address = next(address for address, value in self.addresses.items() if value == ieee)
            if self.discovery_mode == "moved_device":
                self.lookup_count += 1
                if self.lookup_count == 2:
                    address += 2
            return zdo(b, b"\x00" + data[:8] + struct.pack("<HBB", address, 0, 0))
        if (a, b) == (0x25, 0x31):
            assert data == bytes(3)
            self.neighbor_requests += 1
            self.history.append("neighbors")
            if self.discovery_mode == "timeout":
                self.timeout_requests += 1
                return None
            entries = b"".join(bytes.fromhex("0102030405060708")[::-1] + bytes.fromhex(ieee)[::-1]
                               + struct.pack("<HBBBB", address, 0x12, 0, 1, 200)
                               for address, ieee in self.addresses.items())
            return zdo(b, bytes([0, 0, 0, len(self.addresses), 0, len(self.addresses)]) + entries)
        if (a, b) == (0x25, 0x36):
            assert len(data) == 5 and data[:3] == bytes([2, 0, 0]) and data[4] == 1 and data[3] <= 120
            self.join_requests.append(data[3])
            self.history.append("permit_join")
            if self.join_mode == "timeout":
                return None
            if self.join_mode == "bad_frame":
                return bytes.fromhex("fe0165360000")
            return frame(0x65, 0x36, b"\x00") + frame(0x45, 0xb6, bytes([0, 0, 0x84 if self.join_mode == "reject" else 0]))
        if a == 0x25:
            address, query = struct.unpack("<HH", data[:4])
            assert address in (0, *self.addresses)
            if b == 1:
                assert len(data) == 4 and data[2:] == bytes(2)
                ieee = COORDINATOR if address == 0 else bytes.fromhex(self.addresses[address])[::-1]
                if address == 0 and self.discovery_mode == "wrong_coordinator":
                    ieee = bytes.fromhex("0102030405060709")[::-1]
                return zdo(b, b"\x00" + ieee + struct.pack("<HBB", address, 0, 0))
            assert query == address
            if b == 2:
                assert len(data) == 4
                self.history.append("coordinator" if address == 0 else "interview")
                if address != 0 and self.controls[self.addresses[address]]["mode"] == "interview_timeout":
                    self.timeout_requests += 1
                    return None
                node = struct.pack("<BBBHBHHHB", 0 if address == 0 else 2, 0x40, 0x80, 0x1234, 82, 82, 0, 82, 0)
                return zdo(b, struct.pack("<HBH", address, 0, address) + node)
            if b == 5:
                assert len(data) == 4
                endpoints = (([240] if self.registered else []) + ([239] if self.on_off_registered else [])) if address == 0 else [1]
                return zdo(b, struct.pack("<HBHB", address, 0, address, len(endpoints)) + bytes(endpoints))
            assert b == 4 and len(data) == 5
            if address == 0:
                if self.on_off and data[4] == 239:
                    assert self.on_off_registered
                    self.host_checks += 1
                    self.session_samples.append(0)
                    return zdo(b, descriptor(0, 239, 0x0104, 5, [], [0, 6]))
                assert self.registered and data[4] == 240
                self.host_checks += 1
                self.session_samples.append(0)
                if not self.on_off:
                    self.next_af = 0
                return zdo(b, descriptor(0, 240, 0x0104, 5, [], [0, 0x0402, 0x0405]))
            assert data[4] == 1
            if self.on_off and self.addresses[address] == self.switch_ieee:
                return zdo(b, descriptor(address, 1, 0x0104, 0x0100, [0, 6], []))
            return zdo(b, descriptor(address, 1, 0x0104, 0x0302, [0, 0x0402, 0x0405], []))
        if (a, b) == (0x24, 0):
            if self.on_off and data[0] == 239:
                assert not self.on_off_registered and data == bytes.fromhex("ef040105000000000200000600")
                self.on_off_registered = True
                return frame(0x64, 0, b"\x00")
            assert not self.registered and data == bytes.fromhex("f00401050000000003000002040504")
            self.registered = True
            return frame(0x64, 0, b"\x00")
        if (a, b) == (0x24, 1):
            self.af_requests += 1
            address, destination, source, cluster, transaction, options, radius, length = struct.unpack("<HBBHBBBB", data[:10])
            switch = self.on_off and self.addresses.get(address) == self.switch_ieee
            assert address in self.addresses and (destination, source, options, radius) == (1, 239 if switch else 240, 0x10, 30)
            assert cluster in ((0, 6) if switch else (0, 0x0402, 0x0405)) and length == len(data) - 10
            if self.on_off and transaction == 0:
                self.next_af = 0
            assert transaction == self.next_af and self.next_af < 256
            self.next_af += 1
            if switch and data[10] == 1:
                assert cluster == 6 and data[10:] == bytes([1, transaction, data[12]]) and data[12] in (0, 1)
                self.switch_commands.append(data[12] == 1)
                if self.switch_mode != "hold":
                    self.power = data[12] == 1
                if self.switch_mode == "drop_ack":
                    return None
                zcl = bytes([0x18, transaction, 0x0b, data[12], 0])
                return frame(0x64, 1, b"\x00") + frame(0x44, 0x80, bytes([0, source, transaction])) + incoming(cluster, zcl, address=address, destination=source)
            ids = [1, 3, 4, 5] if cluster == 0 else [0]
            assert data[10:] == bytes([0x10, transaction, 0]) + b"".join(struct.pack("<H", value) for value in ids)
            ieee = self.addresses[address]
            control = self.controls[ieee]
            if control["mode"] == "timeout":
                self.timeout_requests += 1
                return None
            if control["mode"] == "reset":
                self.registered = False
                return frame(0x41, 0x80, bytes(6))
            if control["mode"] == "invalid_frame":
                response = frame(0x64, 1, b"\x00")
                return response[:-1] + bytes([response[-1] ^ 1])
            zcl = bytes([0x18, transaction, 1])
            if cluster == 0:
                zcl += bytes.fromhex("01000020020300002001")
                manufacturer = b"OtherIo" if control["mode"] == "wrong_signature" or (switch and self.switch_mode == "wrong_signature") else b"LimeIoT"
                for attribute, text in ((4, manufacturer), (5, b"Switch-1" if switch else b"Environment-1")):
                    zcl += struct.pack("<HBBB", attribute, 0, 0x42, len(text)) + text
            elif cluster == 6:
                zcl += struct.pack("<HBBB", 0, 0, 0x10, int(self.power))
                self.samples[ieee] += 1
            elif cluster == 0x0402:
                zcl += struct.pack("<HBBh", 0, 0, 0x29, control["temperature"])
            else:
                zcl += struct.pack("<HBBH", 0, 0, 0x21, 4567)
                self.samples[ieee] += 1
                self.session_samples[-1] += 1
                self.history.append("sample")
            return frame(0x64, 1, b"\x00") + frame(0x44, 0x80, bytes([0, source, transaction])) + incoming(cluster, zcl, address=address, destination=source)
        raise AssertionError((a, b, data.hex()))


def serve(protocol):
    ncp = PtyNcp(protocol)
    # 软件无线端在宿主关闭后仍可能发送最后一帧，空闲PTY也保持raw，避免终端回显自吞。
    # 独立串口用例仍保留原canonical基线；此处只设运行时夹具自身的初始终端状态。
    tty.setraw(ncp.slave)
    ncp.original = termios.tcgetattr(ncp.slave)
    with ncp:
        print(json.dumps({"type": "ready", "serial": ncp.path}), flush=True)
        try:
            for line in sys.stdin:
                control = json.loads(line)
                if control.get("type") == "inspect":
                    print(json.dumps({"type": "stats", "id": control["id"], "samples": protocol.samples,
                                      "host_checks": protocol.host_checks, "session_samples": protocol.session_samples,
                                      "timeout_requests": protocol.timeout_requests,
                                      "neighbor_requests": protocol.neighbor_requests,
                                      "af_requests": protocol.af_requests,
                                      "join_requests": protocol.join_requests,
                                      "switch_commands": protocol.switch_commands, "power": protocol.power,
                                      "history": protocol.history,
                                      "errors": [str(error) for error in ncp.errors],
                                      "termios_restored": termios.tcgetattr(ncp.slave) == ncp.original}), flush=True)
                    continue
                if control.get("type") == "switch":
                    assert protocol.on_off and control["mode"] in ("normal", "hold", "drop_ack", "wrong_signature")
                    protocol.switch_mode = control["mode"]
                    if "power" in control:
                        assert isinstance(control["power"], bool)
                        protocol.power = control["power"]
                    print(json.dumps({"type": "ack", "id": control["id"]}), flush=True)
                    continue
                if control.get("type") == "join":
                    assert control["mode"] in ("normal", "timeout", "reject", "bad_frame")
                    protocol.join_mode = control["mode"]
                    print(json.dumps({"type": "ack", "id": control["id"]}), flush=True)
                    continue
                if control.get("type") == "restore-fixture-tty":
                    # SIGKILL无法运行RAII；仅由崩溃测试在确认进程退出后显式恢复自己的PTY。
                    termios.tcsetattr(ncp.slave, termios.TCSANOW, ncp.original)
                    termios.tcflush(ncp.slave, termios.TCIFLUSH)
                    print(json.dumps({"type": "ack", "id": control["id"]}), flush=True)
                    continue
                if control.get("type") == "discovery":
                    assert control["mode"] in ("normal", "timeout", "wrong_coordinator", "moved_device")
                    protocol.discovery_mode = control["mode"]
                    protocol.lookup_count = 0
                    print(json.dumps({"type": "ack", "id": control["id"]}), flush=True)
                    continue
                assert -4500 <= control["temperature"] <= 13000
                assert control["mode"] in ("normal", "timeout", "interview_timeout", "wrong_signature", "reset", "invalid_frame")
                ieee = control.get("device", "1122334455667788")
                assert ieee in protocol.controls
                protocol.controls[ieee] = {"temperature": control["temperature"], "mode": control["mode"]}
                print(json.dumps({"type": "ack", "id": control["id"]}), flush=True)
        except KeyboardInterrupt:
            pass
        Path(sys.argv[1]).write_text(json.dumps({"hardware": False, "requests": [[a, b, data.hex()] for a, b, data in ncp.requests]}, indent=2) + "\n")


if __name__ == '__main__':
    serve(RuntimeProtocol())
