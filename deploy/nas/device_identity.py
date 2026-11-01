"""离线设备证书签发。设备 CA 私钥只供管理命令使用，不挂载进运行容器。"""
import argparse
import fcntl
import ipaddress
import json
import os
from pathlib import Path
import re
import subprocess


def openssl(*args):
    return subprocess.run(["openssl", *map(str, args)], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout


def save(path, content):
    path.write_text(content)
    path.chmod(0o600)


def host_san(host):
    try:
        ipaddress.ip_address(host)
        return f"IP:{host}"
    except ValueError:
        if not host or len(host) > 253 or any(not re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?", label) for label in host.split(".")):
            raise ValueError("invalid_broker_hostname")
        return f"DNS:{host}"


def ca_config(authority):
    # OpenSSL 配置中的路径使用双引号；不接受能插入配置语法的字符。
    location = str(authority.resolve())
    if any(c in location for c in ('"', "\n", "\r", "$", "\\")):
        raise ValueError("unsupported_authority_path")
    return f"""[ca]
default_ca = local
[local]
dir = "{location}"
database = $dir/index.txt
new_certs_dir = $dir/issued
certificate = $dir/ca.crt
private_key = $dir/ca.key
serial = $dir/serial
crlnumber = $dir/crlnumber
default_md = sha256
default_days = 90
default_crl_days = 30
policy = identity
unique_subject = no
copy_extensions = none
[identity]
commonName = supplied
[client]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = clientAuth
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
"""


def initialize(directory, host):
    authority, runtime = directory / "device-authority", directory / "broker-tls"
    authority.mkdir(mode=0o700)
    runtime.mkdir(mode=0o700)
    (authority / "issued").mkdir(mode=0o700)
    save(authority / "openssl.cnf", ca_config(authority))
    save(authority / "index.txt", "")
    save(authority / "serial", "1000\n")
    save(authority / "crlnumber", "1000\n")
    openssl("req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-days", "3650", "-subj", "/CN=LimeIoT Device CA", "-keyout", authority / "ca.key", "-out", authority / "ca.crt", "-addext", "basicConstraints=critical,CA:TRUE,pathlen:0", "-addext", "keyUsage=critical,keyCertSign,cRLSign")
    openssl("req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-subj", "/CN=LimeIoT Device Broker", "-keyout", runtime / "server.key", "-out", authority / "server.csr")
    save(authority / "server.ext", f"[server]\nsubjectAltName={host_san(host)}\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\n")
    openssl("ca", "-batch", "-config", authority / "openssl.cnf", "-extfile", authority / "server.ext", "-extensions", "server", "-days", "365", "-notext", "-in", authority / "server.csr", "-out", runtime / "server.crt")
    save(runtime / "ca.crt", (authority / "ca.crt").read_text())
    refresh_crl(directory)
    for path in (*authority.rglob("*"), *runtime.rglob("*")):
        if path.is_file():
            path.chmod(0o600)


def refresh_crl(directory):
    authority = directory / "device-authority"
    # 恢复到新目录后，重新生成包含绝对路径的配置。
    save(authority / "openssl.cnf", ca_config(authority))
    temporary = directory / "broker-tls/revoked.crl.next"
    openssl("ca", "-gencrl", "-config", authority / "openssl.cnf", "-out", temporary)
    temporary.chmod(0o600)
    temporary.replace(directory / "broker-tls/revoked.crl")


def issue(directory, device, output):
    config = json.loads((directory / "config/gateway.json").read_text())
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", device) or device not in {item["device_id"] for item in config["devices"]}:
        raise ValueError("device_not_bound_to_gateway")
    authority = directory / "device-authority"
    entries = [line.split("\t") for line in (authority / "index.txt").read_text().splitlines()]
    if any(row[0] == "V" and row[-1] == f"/CN={device}" for row in entries):
        raise ValueError("active_certificate_exists_revoke_before_reissue")
    # 仅创建新目录；失败时保留供操作者检查，不覆盖或删除已有私钥。
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    save(authority / "openssl.cnf", ca_config(authority))
    openssl("req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-subj", f"/CN={device}", "-keyout", output / "private.key", "-out", output / "request.csr")
    openssl("ca", "-batch", "-config", authority / "openssl.cnf", "-extensions", "client", "-notext", "-in", output / "request.csr", "-out", output / "device.crt")
    save(output / "ca.crt", (authority / "ca.crt").read_text())
    serial = openssl("x509", "-in", output / "device.crt", "-noout", "-serial").decode().strip().split("=", 1)[1]
    save(output / "identity.json", json.dumps({"schema_version": 1, "device_id": device, "space_id": config["space_id"], "serial": serial}, indent=2) + "\n")
    for path in (*output.iterdir(), *authority.rglob("*")):
        if path.is_file():
            path.chmod(0o600)
    return {"serial": serial, "output": str(output)}


def revoke(directory, serial):
    if not re.fullmatch(r"[0-9A-Fa-f]{1,40}", serial):
        raise ValueError("invalid_serial")
    authority = directory / "device-authority"
    certificate = authority / "issued" / f"{serial.upper()}.pem"
    # 不允许通过这个设备入口吊销 Broker 服务证书。
    usage = openssl("x509", "-in", certificate, "-noout", "-ext", "extendedKeyUsage").decode()
    if "TLS Web Client Authentication" not in usage or "TLS Web Server Authentication" in usage:
        raise ValueError("not_a_device_certificate")
    save(authority / "openssl.cnf", ca_config(authority))
    openssl("ca", "-batch", "-config", authority / "openssl.cnf", "-revoke", certificate)
    refresh_crl(directory)
    return {"serial": serial.upper(), "broker_restart_required": True}


def broker_config(config="/config", secrets="/secrets", tls="/broker-tls", plain_port=18884, tls_port=8883, tls_host="0.0.0.0"):
    return f"""per_listener_settings true
persistence false
max_packet_size 17000
max_queued_messages 100
listener {plain_port} 127.0.0.1
allow_anonymous false
password_file {secrets}/mqtt-passwords
acl_file {config}/mqtt-acl
listener {tls_port} {tls_host}
allow_anonymous false
require_certificate true
use_identity_as_username true
use_username_as_clientid true
tls_version tlsv1.2
cafile {tls}/ca.crt
certfile {tls}/server.crt
keyfile {tls}/server.key
crlfile {tls}/revoked.crl
acl_file {config}/mqtt-acl
"""


if __name__ == "__main__":
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("issue", "revoke", "refresh-crl"))
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--device-id")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--serial")
    args = parser.parse_args()
    directory = args.directory.expanduser().resolve()
    try:
        with (directory / "device-authority/.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            if args.action == "issue":
                if not args.device_id or not args.output:
                    parser.error("--device-id and --output required")
                result = issue(directory, args.device_id, args.output.expanduser().resolve())
            elif args.action == "revoke":
                if not args.serial:
                    parser.error("--serial required")
                result = revoke(directory, args.serial)
            else:
                refresh_crl(directory)
                result = {"broker_restart_required": True}
        print(json.dumps({"status": "ok", "action": args.action, **result}))
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        # OpenSSL 的 stderr 可能含私有路径或配置，保持结构化错误且不输出密钥。
        code = str(error) if isinstance(error, ValueError) else "identity_operation_failed"
        print(json.dumps({"error": code}))
        raise SystemExit(1)
