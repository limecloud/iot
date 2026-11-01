"""只在项目 .dev 内构建官方 Mosquitto，不安装全局软件。"""
from pathlib import Path
import hashlib
import os
import subprocess
import tarfile
import urllib.request

root = Path(__file__).resolve().parent.parent
tools = root / ".dev/tools"
tools.mkdir(parents=True, exist_ok=True)
archive = tools / "mosquitto-2.0.22.tar.gz"
if not archive.exists():
    urllib.request.urlretrieve("https://mosquitto.org/files/source/mosquitto-2.0.22.tar.gz", archive)
expected = "2f752589ef7db40260b633fbdb536e9a04b446a315138d64a7ff3c14e2de6b68"
if hashlib.sha256(archive.read_bytes()).hexdigest() != expected:
    raise SystemExit("Mosquitto source digest mismatch")
with tarfile.open(archive) as source:
    source.extractall(tools, filter="data")
options = ["-DWITH_TLS=ON", "-DWITH_CJSON=OFF", "-DWITH_APPS=OFF", "-DWITH_PLUGINS=OFF", "-DWITH_CLIENTS=OFF", "-DDOCUMENTATION=OFF"]
openssl = os.environ.get("OPENSSL_ROOT_DIR")
if not openssl and Path("/opt/homebrew/opt/openssl@3").exists():
    openssl = "/opt/homebrew/opt/openssl@3"
if openssl:
    options.append(f"-DOPENSSL_ROOT_DIR={openssl}")
subprocess.run(["cmake", "-S", str(tools / "mosquitto-2.0.22"), "-B", str(tools / "mosquitto-build"), *options], check=True)
subprocess.run(["cmake", "--build", str(tools / "mosquitto-build"), "--target", "mosquitto", "-j", "4"], check=True)
print("Broker ready:", tools / "mosquitto-build/src/mosquitto")
