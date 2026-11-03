#!/usr/bin/env python3
"""NAS 安装状态与一致性备份。凭据只写本地文件，不回显。"""
import argparse
import base64
import fcntl
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import secrets
import shutil
import sqlite3
import subprocess
from urllib.parse import urlsplit
from device_identity import initialize as initialize_device_identity, ca_config
from media_state import backup_snapshot, verify_backup as verify_media_backup, media_origin

ROOT = Path(__file__).resolve().parents[2]


def fresh(directory):
    if directory.exists() and any(directory.iterdir()):
        raise ValueError("destination_must_be_empty")
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)


def save(path, content):
    path.write_text(content)
    path.chmod(0o600)


def init(directory, origin, mode="gateway", with_environment=False, audio_origin=None):
    if os.getuid() == 0:
        raise ValueError("initialize_as_non_root_owner")
    url = urlsplit(origin)
    if url.scheme != "https" or not url.hostname or url.path or url.query or url.fragment or url.username or url.password or origin != f"https://{url.netloc}":
        raise ValueError("exact_https_origin_required")
    host = url.hostname
    if audio_origin is not None and media_origin(audio_origin) in (url.port or 443, 8883):
        raise ValueError("media_port_conflict")
    try:
        ipaddress.ip_address(host)
        san = f"IP:{host}"
    except ValueError:
        if any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-" for c in host):
            raise ValueError("invalid_hostname")
        san = f"DNS:{host}"
    fresh(directory)
    for name in ("data", "config", "secrets", "tls", "authority", "firmware"):
        (directory / name).mkdir(mode=0o700)
    passwords = {}
    devices = ("device-lamp", "device-button", "device-environment") if with_environment else ("device-lamp", "device-button")
    for user in ("gateway", *devices):
        password = secrets.token_hex(32)
        passwords[user] = password
        save(directory / "secrets" / f"{user}-password", password + "\n")
    save(directory / "secrets/owner-token", secrets.token_hex(32) + "\n")
    identity = subprocess.run(["openssl", "genpkey", "-algorithm", "ED25519", "-outform", "DER"], check=True, capture_output=True).stdout
    with os.fdopen(os.open(directory / "secrets/gateway-identity.pk8", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as target:
        target.write(identity)
    lines = []
    for user, password in passwords.items():
        salt = secrets.token_bytes(12)
        hashed = hashlib.pbkdf2_hmac("sha512", password.encode(), salt, 210000, 64)
        lines.append(f"{user}:$7$210000${base64.b64encode(salt).decode()}${base64.b64encode(hashed).decode()}")
    save(directory / "secrets/mqtt-passwords", "\n".join(lines) + "\n")
    shutil.copyfile(ROOT / "deploy/dev/config.json", directory / "config/gateway.json")
    if with_environment:
        config = json.loads((directory / "config/gateway.json").read_text())
        model = json.loads((ROOT / "contracts/models/environment.json").read_text())
        # 正式环境模型只含ASCII和安全整数，此子集与RFC8785字节一致；运行时仍完整验证模型。
        revision = "sha256:" + hashlib.sha256(json.dumps(model, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
        config["models"].append(model)
        config["devices"].append({"device_id": "device-environment", "model_revision": revision})
        save(directory / "config/gateway.json", json.dumps(config, indent=2) + "\n")
    acl = ["user gateway", "topic read limeiot/v1/space-demo/+/up/+", "topic write limeiot/v1/space-demo/+/down/+"]
    for device in devices:
        acl.extend([f"user {device}", f"topic read limeiot/v1/space-demo/{device}/down/+", f"topic write limeiot/v1/space-demo/{device}/up/+"])
    save(directory / "config/mqtt-acl", "\n".join(acl) + "\n")
    authority, tls = directory / "authority", directory / "tls"
    openssl = lambda *args: subprocess.run(["openssl", *map(str, args)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    openssl("req", "-x509", "-newkey", "rsa:3072", "-nodes", "-days", "3650", "-subj", "/CN=LimeIoT Local CA", "-keyout", authority / "ca.key", "-out", authority / "ca.crt", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign")
    openssl("req", "-newkey", "rsa:3072", "-nodes", "-subj", "/CN=LimeIoT Home", "-keyout", tls / "server.key", "-out", authority / "server.csr")
    save(authority / "server.ext", f"subjectAltName={san}\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n")
    openssl("x509", "-req", "-in", authority / "server.csr", "-CA", authority / "ca.crt", "-CAkey", authority / "ca.key", "-CAcreateserial", "-days", "365", "-extfile", authority / "server.ext", "-out", tls / "server.crt")
    (authority / "ca.key").chmod(0o600)
    (tls / "server.key").chmod(0o600)
    initialize_device_identity(directory, host)
    if mode == "private":
        from platform_install import configure
        configure(directory, save)
    metadata = {"schema_version": 1, "device_identity_version": 1, "origin": origin, "port": url.port or 443, "mode": "simulation", "deployment": mode, "uid": os.getuid(), "gid": os.getgid()}
    if audio_origin is not None:
        metadata["media_origin"] = audio_origin
        save(directory / "config/audio.json", json.dumps({"schema_version": 1, "bindings": []}, indent=2) + "\n")
    save(directory / "installation.json", json.dumps(metadata, indent=2) + "\n")
    environment(directory, metadata)


def environment(directory, metadata):
    values = {"COMPOSE_PROJECT_NAME": "limeiot-" + hashlib.sha256(str(directory).encode()).hexdigest()[:12], "LIMEIOT_STATE_DIR": str(directory), "LIMEIOT_PUBLIC_ORIGIN": metadata["origin"], "LIMEIOT_HTTPS_PORT": metadata["port"], "LIMEIOT_UID": os.getuid(), "LIMEIOT_GID": os.getgid()}
    if values["LIMEIOT_UID"] == 0:
        raise ValueError("initialize_as_non_root_owner")
    if metadata.get("media_origin") is not None:
        port = media_origin(metadata["media_origin"])
        if port in (metadata["port"], 8883):
            raise ValueError("media_port_conflict")
        values.update({"LIMEIOT_MEDIA_ORIGIN": metadata["media_origin"], "LIMEIOT_MEDIA_PORT": port, "LIMEIOT_MEDIA_BIND_HOST": urlsplit(metadata["media_origin"]).hostname})
    save(directory / "compose.env", "\n".join(f"{key}={json.dumps(str(value))}" for key, value in values.items()) + "\n")


def configure_media(directory, origin):
    metadata = json.loads((directory / "installation.json").read_text())
    if media_origin(origin) in (metadata["port"], 8883):
        raise ValueError("media_port_conflict")
    metadata["media_origin"] = origin
    audio = directory / "config/audio.json"
    if not audio.exists():
        save(audio, json.dumps({"schema_version": 1, "bindings": []}, indent=2) + "\n")
    save(directory / "installation.json", json.dumps(metadata, indent=2) + "\n")
    environment(directory, metadata)


def backup(directory, output):
    if not (directory / "data/gateway.sqlite").is_file():
        raise ValueError("gateway_database_missing")
    if output.is_relative_to(directory):
        raise ValueError("backup_must_be_outside_installation")
    fresh(output)
    metadata = json.loads((directory / "installation.json").read_text())
    if metadata.get("deployment") == "private":
        from platform_install import backup_control
        backup_control(directory, output)
    (output / "data").mkdir(mode=0o700)
    with sqlite3.connect(f"file:{directory / 'data/gateway.sqlite'}?mode=ro", uri=True) as source:
        with sqlite3.connect(output / "data/gateway.sqlite") as target:
            source.backup(target)
    space_id = json.loads((directory / "config/gateway.json").read_text())["space_id"]
    media_policy = backup_snapshot(directory, output, space_id)
    # 设备模拟器各自保存的虚拟硬件状态不作为网关恢复事实。
    # 签发数据库、已签证书和 CRL 必须来自同一个管理状态。
    with (directory / "device-authority/.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        for name in ("config", "secrets", "tls", "authority", "device-authority", "broker-tls"):
            shutil.copytree(directory / name, output / name)
    shutil.copyfile(directory / "installation.json", output / "installation.json")
    if (directory / "firmware").is_dir():
        shutil.copytree(directory / "firmware", output / "firmware")
    manifest = {}
    for path in output.rglob("*"):
        if path.is_file():
            path.chmod(0o600)
            manifest[str(path.relative_to(output))] = hashlib.sha256(path.read_bytes()).hexdigest()
    save(output / "backup.json", json.dumps({"schema_version": 1, "files": manifest, "media_snapshot": media_policy}, indent=2) + "\n")


def restore(source, directory):
    manifest = json.loads((source / "backup.json").read_text())
    if manifest.get("schema_version") != 1:
        raise ValueError("unsupported_backup")
    required = {"data/gateway.sqlite", "config/gateway.json", "config/mqtt-acl", "secrets/owner-token", "secrets/mqtt-passwords", "secrets/gateway-password", "tls/server.crt", "tls/server.key", "installation.json"}
    required.update({"device-authority/ca.key", "device-authority/ca.crt", "device-authority/index.txt", "device-authority/serial", "device-authority/crlnumber", "broker-tls/ca.crt", "broker-tls/server.crt", "broker-tls/server.key", "broker-tls/revoked.crl"})
    if not required.issubset(manifest.get("files", {})):
        raise ValueError("incomplete_backup")
    for name, expected in manifest["files"].items():
        relative = Path(name)
        path = (source / relative).resolve()
        if relative.is_absolute() or ".." in relative.parts or not path.is_relative_to(source.resolve()) or any(part.is_symlink() for part in [source / relative, *(source / relative).parents] if part.is_relative_to(source)) or hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            raise ValueError("invalid_backup")
    metadata = json.loads((source / "installation.json").read_text())
    if metadata.get("media_origin") is not None:
        if media_origin(metadata["media_origin"]) in (metadata["port"], 8883):
            raise ValueError("media_port_conflict")
    verify_media_backup(source, manifest, json.loads((source / "config/gateway.json").read_text())["space_id"])
    if metadata.get("deployment") == "private":
        platform_required = {"control.sql", "platform-secrets/control-key", "platform-secrets/admin-token", "platform-secrets/model-release-key.pem", "platform-secrets/mysql-root-password", "platform-secrets/mysql-init.sql", "platform-secrets/mysql-runtime.dsn", "platform-secrets/mysql-migrator.dsn", "platform-secrets/mysql-readonly.cnf", "platform-secrets/mysql-migrator.cnf", "config/control-ca.crt", "secrets/gateway-identity.pk8"}
        if not platform_required.issubset(manifest["files"]):
            raise ValueError("incomplete_platform_backup")
    with sqlite3.connect(f"file:{source / 'data/gateway.sqlite'}?mode=ro", uri=True) as db:
        if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise ValueError("invalid_database")
        snapshot = db.execute("SELECT body FROM snapshot WHERE id=1").fetchone()
        if snapshot and json.loads(snapshot[0]).get("control_links") and "secrets/gateway-identity.pk8" not in manifest["files"]:
            raise ValueError("machine_identity_backup_missing")
    fresh(directory)
    for name in manifest["files"]:
        target = directory / name
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        shutil.copyfile(source / name, target)
        target.chmod(0o600)
    metadata = json.loads((directory / "installation.json").read_text())
    (directory / "firmware").mkdir(mode=0o700, exist_ok=True)
    if metadata.get("deployment") == "private":
        (directory / "mysql").mkdir(mode=0o700)
    save(directory / "device-authority/openssl.cnf", ca_config(directory / "device-authority"))
    environment(directory, metadata)


if __name__ == "__main__":
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("init", "backup", "restore", "restore-control", "media-config"))
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--origin")
    parser.add_argument("--media-origin", help="局域网音箱可达的精确HTTP IPv4 origin及1024以上端口")
    parser.add_argument("--mode", choices=("gateway", "private"), default="gateway")
    parser.add_argument("--with-environment", action="store_true", help="新安装增加SHT30环境节点及独立身份；不修改现有安装")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--backup", type=Path)
    args = parser.parse_args()
    directory = args.directory.expanduser().resolve()
    if args.with_environment and args.action != "init":
        parser.error("--with-environment只用于init新安装")
    if args.media_origin is not None and args.action not in ("init", "media-config"):
        parser.error("--media-origin只用于init或media-config")
    if args.action == "init":
        if not args.origin:
            parser.error("--origin required")
        init(directory, args.origin, args.mode, args.with_environment, args.media_origin)
    elif args.action == "media-config":
        if not args.media_origin:
            parser.error("--media-origin required")
        configure_media(directory, args.media_origin)
    elif args.action == "backup":
        if not args.output:
            parser.error("--output required")
        backup(directory, args.output.expanduser().resolve())
    elif args.action == "restore":
        if not args.backup:
            parser.error("--backup required")
        restore(args.backup.expanduser().resolve(), directory)
    else:
        from platform_install import restore_control
        restore_control(directory)
    print(json.dumps({"status": "ok", "action": args.action, "directory": str(directory)}))
