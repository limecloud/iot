"""固定ESP-IDF 6.1 HMAC派生适配；只处理离线文件，不读写设备或eFuse。"""
import hashlib
import hmac
import os
from pathlib import Path
import stat
import struct


def read_key(filename):
    filename = Path(filename).expanduser().absolute()
    if filename.resolve() != filename:
        raise ValueError("hmac_key_symlink_rejected")
    handle = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        metadata = os.fstat(handle)
        if (not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1
                or metadata.st_uid != os.getuid() or metadata.st_mode & 0o077 or metadata.st_size != 32):
            raise ValueError("private_32_byte_hmac_key_required")
        value = os.read(handle, 33)
        if len(value) != 32 or value == b"\0" * 32 or value == b"\xff" * 32:
            raise ValueError("invalid_hmac_key")
        return value
    finally:
        os.close(handle)


def xts_keys(key):
    # 对应固定SDK nvs_sec_provider的EKEY_SEED/TKEY_SEED（C3小端32位各重复8次）。
    return b"".join(hmac.digest(key, struct.pack("<I", seed) * 8, "sha256")
                    for seed in (0xAEBE5A5A, 0xCEDEA5A5))


def binding_image(key, key_id, device, space):
    device_bytes, space_bytes = device.encode("ascii"), space.encode("ascii")
    header = struct.pack("<8sBBBB64s64s32s4x", b"LI-NVS1\0", 1, key_id,
                         len(device_bytes), len(space_bytes), device_bytes, space_bytes, os.urandom(32))
    authenticated = header + hmac.digest(key, header, "sha256")
    return authenticated + b"\xff" * (4096 - len(authenticated))


def private_write(filename, value):
    with os.fdopen(os.open(filename, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as target:
        target.write(value)
        target.flush()
        os.fsync(target.fileno())


def fingerprint(key):
    return "sha256:" + hashlib.sha256(key).hexdigest()
