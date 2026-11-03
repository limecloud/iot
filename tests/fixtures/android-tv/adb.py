#!/usr/bin/python3
"""隔离 ADB 假进程；记录类型化调用与模拟副作用，不访问网络或电视。"""
import json
import os
import sqlite3
import sys
import time

with open("scenario.json") as source:
    scenario = json.load(source)
args = sys.argv[1:]
with open("calls.jsonl", "a") as log:
    log.write(json.dumps({"args": args, "env": {key: os.environ.get(key) for key in [
        "ANDROID_USER_HOME", "ADB_VENDOR_KEYS", "ADB_SERVER_SOCKET", "LIMEIOT_TOKEN"]}}) + "\n")
assert args[:6] == ["-H", "127.0.0.1", "-P", "5049", "-s", "192.168.31.94:5555"]
args = args[6:]
if args == ["shell", "getprop ro.build.fingerprint && getprop ro.serialno"]:
    if scenario.get("probe_failure"):
        sys.exit(1)
    time.sleep(scenario.get("probe_delay_ms", 0) / 1000)
    if scenario.get("probe_fault") == "stderr":
        sys.stderr.write("private-device-diagnostic")
    if scenario.get("probe_fault") == "invalid_utf8":
        sys.stdout.buffer.write(bytes([255]))
    elif scenario.get("raw_identity") is not None:
        sys.stdout.write(scenario["raw_identity"])
    else:
        print(scenario.get("fingerprint", "Xiaomi/xmen/xmen:6.0.1/MHC19J/2061:user/release-keys"))
        print(scenario.get("device_serial", "sample-tv-001"))
elif args == ["shell", "pm", "list", "packages", "-e"]:
    time.sleep(scenario.get("packages_delay_ms", 0) / 1000)
    if scenario.get("raw_packages") is not None:
        sys.stdout.write(scenario["raw_packages"])
    else:
        for package in scenario.get("packages", ["android", "com.example.player", "com.android.settings"]):
            print("package:" + package)
elif args[:3] in (["shell", "input", "keyevent"], ["shell", "am", "start"]):
    if scenario.get("database"):
        with sqlite3.connect("file:" + scenario["database"] + "?mode=ro", uri=True) as connection:
            version, raw = connection.execute("SELECT version,body FROM snapshot WHERE id=1").fetchone()
        snapshot = json.loads(raw)
        commands = [command for command in snapshot["commands"].values()
                    if command["status"] == "dispatched" and command.get("execution_route")]
        assert len(commands) == 1
        with open("durable.jsonl", "a") as log:
            log.write(json.dumps({"version": version, "command": commands[0],
                                  "binding": snapshot.get("execution_registry", {}).get(
                                      "bindings", {}).get(commands[0]["request"]["device_id"])}) + "\n")
    with open("effects.jsonl", "a") as log:
        log.write(json.dumps(args) + "\n")
    with open("child.pid", "w") as pid:
        pid.write(str(os.getpid()))
    fault = scenario.get("fault")
    if fault == "timeout":
        time.sleep(10)
    elif fault == "output_limit":
        sys.stdout.write("x" * 300000)
    elif fault == "stderr_limit":
        sys.stderr.write("x" * 10000)
    elif fault == "stderr":
        sys.stderr.write("private-device-diagnostic")
    elif fault == "exit":
        sys.exit(1)
    elif fault == "am_error":
        print("Error: Activity class does not exist.")
    elif fault == "invalid_utf8":
        sys.stdout.buffer.write(bytes([255]))
    elif args[:3] == ["shell", "am", "start"]:
        print("Starting: Intent { act=android.intent.action.MAIN }\nStatus: ok\nComplete")
else:
    raise RuntimeError("unexpected adb command")
