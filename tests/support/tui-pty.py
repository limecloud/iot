"""使用真实伪终端驱动CLI；只记录交互内容，不记录进程环境。"""
import codecs
import errno
import json
import os
import pty
import select
import subprocess
import sys
import time

node, cli, steps_file, transcript_file = sys.argv[1:]
with open(steps_file, encoding="utf-8") as source:
    steps = json.load(source)
master, slave = pty.openpty()
process = subprocess.Popen(
    [node, cli, "tui", "--space-id", "space-demo", "--state-dir", os.environ["LIMEIOT_TEST_TASK_DIR"]],
    stdin=slave, stdout=slave, stderr=slave,
)
os.close(slave)
decoder = codecs.getincrementaldecoder("utf-8")()
pending = ""
transcript = ""
try:
    for step in steps:
        deadline = time.monotonic() + 12
        while step["expect"] not in pending:
            if time.monotonic() > deadline:
                raise RuntimeError("terminal_prompt_timeout: " + step["expect"] + "\n" + pending[-1600:])
            if not select.select([master], [], [], 0.2)[0]:
                continue
            try:
                chunk = os.read(master, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    chunk = b""
                else:
                    raise
            if not chunk:
                raise RuntimeError("terminal_closed: " + pending[-1600:])
            decoded = decoder.decode(chunk)
            pending += decoded
            transcript += decoded
        pending = pending.split(step["expect"], 1)[1]
        if "send" in step:
            os.write(master, (step["send"] + "\n").encode("utf-8"))
    deadline = time.monotonic() + 12
    while process.poll() is None:
        if time.monotonic() > deadline:
            raise RuntimeError("terminal_exit_timeout: " + transcript[-1600:])
        if select.select([master], [], [], 0.2)[0]:
            try:
                chunk = os.read(master, 65536)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                chunk = b""
            transcript += decoder.decode(chunk)
    if process.returncode != 0:
        raise RuntimeError("terminal_exit_failed")
    print(json.dumps({"passed": True, "pty": True, "steps": len(steps)}))
finally:
    if process.poll() is None:
        process.terminate()
        process.wait(timeout=5)
    os.close(master)
    with open(transcript_file, "w", encoding="utf-8") as output:
        output.write(transcript)
