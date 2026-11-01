"""获取宿主固件检查需要的固定 cJSON 源码，只写项目 .dev。"""
from pathlib import Path
import argparse
import hashlib
import subprocess
import sys
import urllib.request

project = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser()
parser.add_argument("--provisioning", action="store_true", help="在项目虚拟环境安装离线 NVS 工具")
args = parser.parse_args()
root = project / ".dev/firmware-tools/cjson-1.7.19"
root.mkdir(parents=True, exist_ok=True)
expected = {
    "cJSON.c": "298581a04a36c0165da4b0aade235c23088cb2faa58651d720ea2f3706ed0b0d",
    "cJSON.h": "25b0145150d500498e4d209cec69c18c42cf818bffcc54690be3b895a2a16dee",
    "LICENSE": "a36dda207c36db5818729c54e7ad4e8b0c6fba847491ba64f372c1a2037b6d5c",
}
for name, digest in expected.items():
    target = root / name
    if target.exists():
        data = target.read_bytes()
    else:
        with urllib.request.urlopen(f"https://raw.githubusercontent.com/DaveGamble/cJSON/v1.7.19/{name}", timeout=30) as response:
            data = response.read()
    if hashlib.sha256(data).hexdigest() != digest:
        raise SystemExit(f"cJSON source digest mismatch: {name}")
    if not target.exists():
        target.write_bytes(data)
print("firmware host dependency: cJSON 1.7.19 verified (MIT)")
if args.provisioning:
    environment = project / ".dev/firmware-tools/venv"
    if not (environment / "bin/python").exists():
        subprocess.run([sys.executable, "-m", "venv", str(environment)], check=True)
    subprocess.run([str(environment / "bin/python"), "-m", "pip", "install", "-r", str(project / "firmware/tools/requirements.txt")], check=True)
