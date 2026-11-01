"""本地服务进程装配。任何必要进程退出均关闭整组，交给容器重启。"""
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time
from device_identity import broker_config


def run():
    children = []
    stopping = False

    def shutdown(_signum=None, _frame=None):
        nonlocal stopping
        stopping = True
        for child in reversed(children):
            if child.poll() is None:
                child.send_signal(signal.SIGINT)

    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, shutdown)
    mode = sys.argv[1] if len(sys.argv) > 1 else "gateway"
    try:
        if mode == "gateway":
            # 网关/模拟器明文连接只在回环；局域网设备必须通过独立 CA 的 mTLS。
            Path("/tmp/mosquitto.conf").write_text(broker_config())
            children.append(subprocess.Popen(["mosquitto", "-c", "/tmp/mosquitto.conf"]))
            deadline = time.monotonic() + 10
            while True:
                if children[0].poll() is not None or stopping:
                    raise RuntimeError("broker_start_failed")
                try:
                    with socket.create_connection(("127.0.0.1", 18884), timeout=0.2):
                        break
                except OSError:
                    if time.monotonic() > deadline:
                        raise RuntimeError("broker_start_timeout")
                    time.sleep(0.1)
            os.environ["LIMEIOT_MQTT_PASSWORD"] = Path(os.environ["LIMEIOT_MQTT_PASSWORD_FILE"]).read_text().strip()
            children.append(subprocess.Popen(["limeiot-gateway"]))
        elif mode == "simulator":
            device = sys.argv[2]
            if device not in ("device-lamp", "device-button"):
                raise RuntimeError("unsupported_simulator")
            kind = "lamp" if device == "device-lamp" else "button"
            os.environ["LIMEIOT_MQTT_PASSWORD"] = Path(f"/secrets/{device}-password").read_text().strip()
            children.append(subprocess.Popen(["limeiot-simulator", device, f"/opt/limeiot/models/{kind}.json", f"/data/{kind}.json"]))
        else:
            raise RuntimeError("unsupported_mode")
        while not stopping and all(child.poll() is None for child in children):
            time.sleep(0.2)
        return 0 if stopping else 1
    finally:
        shutdown()
        deadline = time.monotonic() + 8
        for child in children:
            try:
                child.wait(timeout=max(0.1, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()


if __name__ == "__main__":
    try:
        sys.exit(run())
    except Exception:
        # 异常可能包含文件内容，不向日志回显凭据。
        print(json.dumps({"error": "local_stack_failed"}), file=sys.stderr)
        sys.exit(1)
