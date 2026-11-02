"""将已签发的单设备材料打包到新私有文件；不签发、不联网、不回显私钥。"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
from urllib.parse import urlsplit


def read_private(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size > 16384:
            raise ValueError("private_material_required")
        return source.read(16385).decode("ascii")


def unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate_json_key")
        result[key] = value
    return result


def openssl(*args, data=None):
    return subprocess.run(["openssl", *map(str, args)], input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True, timeout=10).stdout


def package(identity_directory, broker, output, model_profile="android-tv-agent"):
    if model_profile not in ("android-tv-agent", "android-tv-remote"):
        raise ValueError("unsupported_model_profile")
    uri = urlsplit(broker)
    if len(broker) > 512 or any(c in broker for c in "@?#") or any(ord(c) <= 32 for c in broker) or uri.scheme != "ssl" or not uri.hostname or not uri.port or not 1 <= uri.port <= 65535 or uri.path:
        raise ValueError("invalid_broker")
    identifier = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}")
    identity = json.loads(read_private(identity_directory / "identity.json"), object_pairs_hook=unique)
    if set(identity) != {"schema_version", "space_id", "device_id", "serial"} or type(identity["schema_version"]) is not int or identity["schema_version"] != 1:
        raise ValueError("invalid_identity")
    if any(not isinstance(identity[name], str) or not identifier.fullmatch(identity[name]) for name in ("space_id", "device_id")):
        raise ValueError("invalid_identity")
    materials = {field: read_private(identity_directory / name) for field, name in (
        ("ca_pem", "ca.crt"), ("certificate_pem", "device.crt"), ("private_key_pem", "private.key"))}
    if any(len(text) > 4096 for text in materials.values()) or not re.fullmatch(r"\s*-----BEGIN PRIVATE KEY-----[A-Za-z0-9+/=\s]+-----END PRIVATE KEY-----\s*", materials["private_key_pem"]):
        raise ValueError("invalid_credentials")
    openssl("verify", "-purpose", "sslclient", "-CAfile", identity_directory / "ca.crt", identity_directory / "device.crt")
    subject = openssl("x509", "-in", identity_directory / "device.crt", "-noout", "-subject", "-nameopt", "RFC2253").decode().strip()
    if subject != "subject=CN=" + identity["device_id"] and subject != "subject= CN=" + identity["device_id"]:
        raise ValueError("identity_mismatch")
    public = openssl("x509", "-in", identity_directory / "device.crt", "-pubkey", "-noout")
    if openssl("pkey", "-pubin", "-outform", "DER", data=public) != openssl("pkey", "-in", identity_directory / "private.key", "-pubout", "-outform", "DER"):
        raise ValueError("identity_mismatch")
    parent = output.parent.stat()
    if parent.st_uid != os.getuid() or parent.st_mode & 0o077:
        raise ValueError("private_output_directory_required")
    value = {"schema_version": 2, "model_profile": model_profile, "space_id": identity["space_id"], "device_id": identity["device_id"], "broker": broker, **materials}
    encoded = (json.dumps(value, ensure_ascii=True, separators=(",", ":"), sort_keys=True) + "\n").encode()
    if len(encoded) > 32768:
        raise ValueError("material_too_large")
    fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "wb") as dest:
        dest.write(encoded)
        dest.flush()
        os.fsync(dest.fileno())
    parent_fd = os.open(output.parent, os.O_RDONLY)
    try:
        os.fsync(parent_fd)
    finally:
        os.close(parent_fd)
    def fingerprint(name):
        return "sha256:" + hashlib.sha256(openssl("x509", "-in", identity_directory / name, "-outform", "DER")).hexdigest()
    return {"status": "ok", "space_id": identity["space_id"], "device_id": identity["device_id"], "model_profile": model_profile, "ca_fingerprint": fingerprint("ca.crt"), "certificate_fingerprint": fingerprint("device.crt"), "output": str(output)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--identity-directory", type=Path, required=True)
    parser.add_argument("--broker", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--model-profile", choices=("android-tv-agent", "android-tv-remote"), default="android-tv-agent")
    args = parser.parse_args()
    try:
        print(json.dumps(package(args.identity_directory, args.broker, args.output, args.model_profile)))
    except (ValueError, OSError, subprocess.SubprocessError):
        print(json.dumps({"error": "enrollment_packaging_failed"}))
        raise SystemExit(1)
