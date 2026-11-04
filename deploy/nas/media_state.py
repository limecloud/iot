"""媒体快照的有界字节备份；完整领域校验仍由网关恢复执行。"""
import base64
import hashlib
import ipaddress
import json
import os
import stat
from urllib.parse import urlsplit

SNAPSHOT = "data/gateway.sqlite.media.json"
MAX_BYTES = 48 * 1024 * 1024


def media_origin(value):
    try:
        url = urlsplit(value)
        address = ipaddress.IPv4Address(url.hostname)
        local = any(address in ipaddress.IPv4Network(network) for network in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.0/8"))
        if not local or url.scheme != "http" or not url.port or not 1024 <= url.port <= 65535 or value != f"http://{address}:{url.port}":
            raise ValueError()
        return url.port
    except (ValueError, TypeError, AttributeError):
        raise ValueError("invalid_media_origin") from None


def _pairs(items):
    result = {}
    for key, value in items:
        if key in result:
            raise ValueError()
        result[key] = value
    return result


def read_snapshot(path, space_id):
    try:
        handle = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return None
    except OSError:
        raise ValueError("invalid_media_snapshot") from None
    try:
        with os.fdopen(handle, "rb") as source:
            metadata = os.fstat(source.fileno())
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > MAX_BYTES or metadata.st_mode & 0o077:
                raise ValueError()
            raw = source.read(MAX_BYTES + 1)
        if len(raw) > MAX_BYTES:
            raise ValueError()
        def reject(_value):
            raise ValueError()
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=_pairs, parse_constant=reject, parse_float=reject)
        if not isinstance(value, dict) or type(value.get("schema_version")) is not int or value["space_id"] != space_id:
            raise ValueError()
        fields = {"schema_version", "space_id", "saved_at", "objects", "grants", "operations"}
        if value["schema_version"] == 1:
            if set(value) != fields:
                raise ValueError()
        elif value["schema_version"] == 2:
            if set(value) != fields | {"speech"} or not isinstance(value["speech"], dict) or not 1 <= len(value["speech"]) <= 256:
                raise ValueError()
        elif value["schema_version"] == 3:
            expected = fields | {"transcriptions"} | ({"speech"} if "speech" in value else set())
            if set(value) != expected or not isinstance(value["transcriptions"], dict) or not 1 <= len(value["transcriptions"]) <= 256 or "speech" in value and (not isinstance(value["speech"], dict) or not 1 <= len(value["speech"]) <= 256):
                raise ValueError()
        elif value["schema_version"] == 4:
            expected = fields | {"visions"} | ({"speech"} if "speech" in value else set()) | ({"transcriptions"} if "transcriptions" in value else set())
            if set(value) != expected or not isinstance(value["visions"], dict) or not 1 <= len(value["visions"]) <= 128:
                raise ValueError()
            for name in ("speech", "transcriptions"):
                if name in value and (not isinstance(value[name], dict) or not 1 <= len(value[name]) <= 256):
                    raise ValueError()
        elif value["schema_version"] == 5:
            optional = {name for name in ("speech", "transcriptions", "visions") if name in value}
            if set(value) != fields | {"texts"} | optional or not isinstance(value["texts"], dict) or not 1 <= len(value["texts"]) <= 128:
                raise ValueError()
            for name, limit in (("speech", 256), ("transcriptions", 256), ("visions", 128)):
                if name in value and (not isinstance(value[name], dict) or not 1 <= len(value[name]) <= limit):
                    raise ValueError()
        else:
            raise ValueError()
        for name, limit in (("objects", 256), ("grants", 512), ("operations", 1024)):
            if not isinstance(value[name], dict) or len(value[name]) > limit:
                raise ValueError()
        pending, nodes = [(value, 0)], 0
        while pending:
            item, depth = pending.pop()
            nodes += 1
            if nodes > 100000 or depth > 12:
                raise ValueError()
            if isinstance(item, dict):
                pending.extend((child, depth + 1) for child in item.values())
            elif isinstance(item, list):
                pending.extend((child, depth + 1) for child in item)
        total = 0
        for media_id, item in value["objects"].items():
            if not isinstance(item, dict) or set(item) != {"metadata", "content_base64", "deleted_at"} or item["metadata"]["media_id"] != media_id or item["metadata"]["space_id"] != space_id:
                raise ValueError()
            content = item["content_base64"]
            if content is not None:
                if not isinstance(content, str) or len(content) > 5592408:
                    raise ValueError()
                decoded = base64.b64decode(content, validate=True)
                if not 46 <= len(decoded) <= 4 * 1024 * 1024 or base64.b64encode(decoded).decode() != content or item["deleted_at"] is not None or item["metadata"]["byte_length"] != len(decoded) or item["metadata"]["content_digest"] != "sha256:" + hashlib.sha256(decoded).hexdigest():
                    raise ValueError()
                total += len(decoded)
        if total > 32 * 1024 * 1024:
            raise ValueError()
        return raw
    except (ValueError, KeyError, TypeError, OSError, RecursionError):
        raise ValueError("invalid_media_snapshot") from None


def backup_snapshot(directory, output, space_id):
    # 网关只原子替换快照。已打开的普通文件保持同一份完整字节，不读取锁或临时文件。
    raw = read_snapshot(directory / SNAPSHOT, space_id)
    if raw is not None:
        with os.fdopen(os.open(output / SNAPSHOT, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), "wb") as target:
            target.write(raw)
            target.flush()
            os.fsync(target.fileno())
    return {"schema_version": 1, "path": SNAPSHOT, "included": raw is not None}


def verify_backup(source, manifest, space_id):
    policy = manifest.get("media_snapshot")
    present = SNAPSHOT in manifest["files"]
    if policy is None and not present:
        return
    if not isinstance(policy, dict) or set(policy) != {"schema_version", "path", "included"} or type(policy["schema_version"]) is not int or policy["schema_version"] != 1 or policy["path"] != SNAPSHOT or type(policy["included"]) is not bool or policy["included"] != present:
        raise ValueError("incomplete_media_backup")
    if present and read_snapshot(source / SNAPSHOT, space_id) is None:
        raise ValueError("incomplete_media_backup")
