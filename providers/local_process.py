"""本地模型共用的有界匿名管道；不继承调用者环境或保存模型输入。"""
import os
import selectors
import subprocess
import time


class ProviderError(Exception):
    pass


class ChildExit(ProviderError):
    def __init__(self, returncode):
        super().__init__("provider_failed")
        self.returncode = returncode


def run_process(command, payload, *, max_output, timeout=80, stopping=None):
    if stopping and stopping.is_set():
        raise ProviderError("provider_stopping")
    child = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                             env={"PYTHONNOUSERSITE": "1", "PYTHONUNBUFFERED": "1", "OMP_NUM_THREADS": "2", "OPENBLAS_NUM_THREADS": "1"})
    output = bytearray()
    deadline, offset = time.monotonic() + timeout, 0
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(child.stdout, selectors.EVENT_READ, "output")
            if payload:
                selector.register(child.stdin, selectors.EVENT_WRITE, "input")
            else:
                child.stdin.close()
            while selector.get_map():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise ProviderError("provider_timeout")
                if stopping and stopping.is_set():
                    raise ProviderError("provider_stopping")
                for key, _ in selector.select(min(remaining, .1)):
                    if key.data == "input":
                        try:
                            offset += os.write(key.fd, payload[offset:offset + 4096])
                        except BrokenPipeError:
                            offset = len(payload)
                        if offset == len(payload):
                            selector.unregister(child.stdin)
                            child.stdin.close()
                    else:
                        chunk = os.read(key.fd, 65536)
                        if not chunk:
                            selector.unregister(child.stdout)
                        elif len(output) + len(chunk) > max_output:
                            raise ProviderError("provider_output_limit")
                        else:
                            output.extend(chunk)
        code = child.wait(timeout=max(.001, deadline - time.monotonic()))
        if code != 0:
            raise ChildExit(code)
        return bytes(output)
    except subprocess.TimeoutExpired:
        raise ProviderError("provider_timeout") from None
    finally:
        if child.poll() is None:
            child.kill()
        child.wait()
        child.stdout.close()
        if not child.stdin.closed:
            child.stdin.close()
