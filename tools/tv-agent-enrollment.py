"""打包旧设备材料或初次本机身份公开配置；不签发、不联网、不回显私钥。"""
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


def checked_broker(broker):
    uri = urlsplit(broker)
    if len(broker) > 512 or any(c in broker for c in "@?#") or any(ord(c) <= 32 for c in broker) or uri.scheme != "ssl" or not uri.hostname or not uri.port or not 1 <= uri.port <= 65535 or uri.path:
        raise ValueError("invalid_broker")


def write_new(value, output, maximum):
    parent = output.parent.stat()
    if parent.st_uid != os.getuid() or parent.st_mode & 0o077:
        raise ValueError("private_output_directory_required")
    encoded = (json.dumps(value, ensure_ascii=True, separators=(",", ":"), sort_keys=True) + "\n").encode()
    if len(encoded) > maximum:
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


def public_setup(ca_file, space_id, device_id, request_id, broker, output, model_profile):
    checked_broker(broker)
    identifier = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}")
    if any(not isinstance(value, str) or not identifier.fullmatch(value) for value in (space_id, device_id, request_id)):
        raise ValueError("invalid_identity")
    fd = os.open(ca_file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size not in range(1, 4097):
            raise ValueError("invalid_ca")
        ca_pem = source.read(4097).decode("ascii")
    if len(ca_pem) > 4096 or not re.fullmatch(r"\s*-----BEGIN CERTIFICATE-----\s+[A-Za-z0-9+/=\s]+-----END CERTIFICATE-----\s*", ca_pem):
        raise ValueError("invalid_ca")
    der = openssl("x509", "-outform", "DER", data=ca_pem.encode("ascii"))
    # 这里只准备公开配置；有效期、CA用途、实际持钥等仍由电视严格核对。
    value = {"schema_version": 1, "request_id": request_id, "space_id": space_id, "device_id": device_id,
             "broker": broker, "model_profile": model_profile, "ca_pem": ca_pem}
    write_new(value, output, 16384)
    return {"status": "ok", "space_id": space_id, "device_id": device_id, "request_id": request_id,
            "ca_fingerprint": "sha256:" + hashlib.sha256(der).hexdigest(), "output": str(output)}


def package(identity_directory, broker, output, model_profile="android-tv-agent"):
    if model_profile not in ("android-tv-agent", "android-tv-remote"):
        raise ValueError("unsupported_model_profile")
    checked_broker(broker)
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
    value = {"schema_version": 2, "model_profile": model_profile, "space_id": identity["space_id"], "device_id": identity["device_id"], "broker": broker, **materials}
    write_new(value, output, 32768)
    def fingerprint(name):
        return "sha256:" + hashlib.sha256(openssl("x509", "-in", identity_directory / name, "-outform", "DER")).hexdigest()
    return {"status": "ok", "space_id": identity["space_id"], "device_id": identity["device_id"], "model_profile": model_profile, "ca_fingerprint": fingerprint("ca.crt"), "certificate_fingerprint": fingerprint("device.crt"), "output": str(output)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--identity-directory", type=Path)
    source.add_argument("--ca-file", type=Path)
    parser.add_argument("--space-id")
    parser.add_argument("--device-id")
    parser.add_argument("--request-id")
    parser.add_argument("--broker", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--model-profile", choices=("android-tv-agent", "android-tv-remote"), default="android-tv-agent")
    args = parser.parse_args()
    try:
        if args.ca_file:
            result = public_setup(args.ca_file, args.space_id, args.device_id, args.request_id, args.broker, args.output, args.model_profile)
        else:
            if any((args.space_id, args.device_id, args.request_id)):
                raise ValueError("public_setup_arguments_required")
            result = package(args.identity_directory, args.broker, args.output, args.model_profile)
        print(json.dumps(result))
    except (ValueError, OSError, subprocess.SubprocessError):
        print(json.dumps({"error": "enrollment_packaging_failed"}))
        raise SystemExit(1)
