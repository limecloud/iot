"""离线固件信任配置验证；只消费用户独立提供的本地材料。"""
import base64
from datetime import datetime, timezone
import hashlib
import ipaddress
import json
import re
from urllib.parse import urlsplit


def signing_key(value):
    if not isinstance(value, dict) or set(value) != {"public_key", "signing_key_id"}:
        raise ValueError("invalid_ota_signing_key")
    try:
        public = base64.b64decode(value["public_key"], validate=True)
    except (ValueError, TypeError):
        raise ValueError("invalid_ota_signing_key") from None
    if len(public) != 32 or base64.b64encode(public).decode() != value["public_key"] or value["signing_key_id"] != "sha256:" + hashlib.sha256(public).hexdigest():
        raise ValueError("ota_signing_key_fingerprint_mismatch")
    return {"ota_public_key": value["public_key"], "ota_key_id": value["signing_key_id"]}


def origin(value):
    if not isinstance(value, str) or not value.startswith("https://") or len(value) > 1023:
        return False
    try:
        parts = urlsplit(value)
        host, port = parts.hostname, parts.port
        if not host or parts.path or parts.query or parts.fragment or parts.username is not None or parts.password is not None:
            return False
        if ":" in host:
            if "%" in host:
                return False
            canonical_host = "[" + ipaddress.IPv6Address(host).compressed + "]"
        else:
            if len(host) > 253 or not re.fullmatch(r"[a-z0-9_.-]+", host):
                return False
            last = host.rstrip(".").rsplit(".", 1)[-1]
            if not last:
                return False
            if last.isdecimal() or last.startswith("0x"):
                canonical_host = str(ipaddress.IPv4Address(host))
            else:
                canonical_host = host
        rendered = "https://" + canonical_host + (f":{port}" if port is not None and port != 443 else "")
        return rendered == value
    except ValueError:
        return False


def timestamp(value):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z", value):
        raise ValueError("invalid_ota_policy")
    parsed = datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    if parsed.year < 1970:
        raise ValueError("invalid_ota_policy")
    return parsed


def array(value, minimum, maximum, check):
    return isinstance(value, list) and minimum <= len(value) <= maximum and all(check(item) for item in value) and len(set(value)) == len(value)


def encode_policy(value):
    fields = {"schema", "version", "purpose", "signing_key_id", "public_key", "product_ids", "download_origins",
              "minimum_security_epoch", "minimum_battery_percent", "revoked_artifact_ids", "not_before", "expires_at"}
    try:
        if not isinstance(value, dict) or set(value) != fields or value["schema"] != "limeiot.ota-trust" or value["purpose"] != "device-firmware" or type(value["version"]) is not int or value["version"] != 1:
            raise ValueError("invalid_ota_policy")
        key = signing_key({name: value[name] for name in ("public_key", "signing_key_id")})
        token = lambda item: isinstance(item, str) and re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", item) is not None
        artifact = lambda item: isinstance(item, str) and re.fullmatch(r"artifact-[a-f0-9]{64}", item) is not None
        if not array(value["product_ids"], 1, 16, token) or not array(value["download_origins"], 1, 8, origin) or not array(value["revoked_artifact_ids"], 0, 128, artifact):
            raise ValueError("invalid_ota_policy")
        if type(value["minimum_security_epoch"]) is not int or not 0 <= value["minimum_security_epoch"] <= 4294967295 or type(value["minimum_battery_percent"]) is not int or not 0 <= value["minimum_battery_percent"] <= 100:
            raise ValueError("invalid_ota_policy")
        if timestamp(value["not_before"]) >= timestamp(value["expires_at"]):
            raise ValueError("invalid_ota_policy")
        raw = json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":")).encode("ascii")
        if len(raw) > 16384:
            raise ValueError("invalid_ota_policy")
        return raw, key
    except (ValueError, TypeError, KeyError):
        raise ValueError("invalid_ota_policy") from None


def configuration_json(raw):
    def pairs(items):
        result = {}
        for name, value in items:
            if name in result:
                raise ValueError("duplicate_configuration_key")
            result[name] = value
        return result

    def constant(_value):
        raise ValueError("invalid_configuration_json")

    try:
        value = json.loads(raw, object_pairs_hook=pairs, parse_constant=constant)
    except json.JSONDecodeError:
        raise ValueError("invalid_configuration_json") from None
    if not isinstance(value, dict):
        raise ValueError("invalid_configuration_json")
    return value
