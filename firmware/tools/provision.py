"""验证离线配置与设备证书，生成开发样机专用的 NVS 镜像。不会连接或烧录设备。"""
import argparse
import csv
import importlib.metadata
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from ota_policy import configuration_json, encode_policy, signing_key


def run(*arguments):
    return subprocess.run(list(map(str, arguments)), check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout


def text(value, minimum, maximum):
    if not isinstance(value, str) or not minimum <= len(value.encode()) <= maximum or any(c in value for c in ("\x00", "\n", "\r")):
        raise ValueError("invalid_configuration_string")
    return value


def identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", value):
        raise ValueError("invalid_device_or_space_id")
    return value


def prepare(configuration, output):
    if importlib.metadata.version("esp-idf-nvs-partition-gen") != "0.3.0":
        raise ValueError("nvs_generator_0_3_0_required")
    if configuration.stat().st_mode & 0o077:
        raise ValueError("configuration_must_be_owner_only")
    data = configuration_json(configuration.read_text())
    device, space = identifier(data["device_id"]), identifier(data["space_id"])
    hardware = text(data["hardware_rev"], 1, 64)
    ssid, password = text(data["wifi"]["ssid"], 1, 32), text(data["wifi"]["password"], 8, 64)
    if len(password.encode()) == 64 and not re.fullmatch(r"[0-9a-fA-F]{64}", password):
        raise ValueError("invalid_wifi_password")
    host = text(data["broker"]["host"], 1, 253)
    # 共用 NAS 的主机名校验，Broker 地址只能为主机/IP，不能是 URL 或 Topic。
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "deploy/nas"))
    from device_identity import host_san
    host_san(host)
    port = data["broker"]["port"]
    if type(port) is not int or not 1 <= port <= 65535:
        raise ValueError("invalid_broker_port")
    ota_values = {}
    if "ota_signing_key" in data:
        ota_values = signing_key(data["ota_signing_key"])
    ota_policy = None
    if "ota_policy" in data:
        ota_policy, policy_key = encode_policy(data["ota_policy"])
        if ota_values and ota_values != policy_key:
            raise ValueError("ota_policy_key_mismatch")
        ota_values = policy_key
    ota_ca = None
    if "ota_transport" in data:
        transport = data["ota_transport"]
        if not isinstance(transport, dict) or set(transport) != {"ca"} or ota_policy is None:
            raise ValueError("invalid_ota_transport")
        ca_path = (configuration.parent / text(transport["ca"], 1, 4096)).resolve()
        ota_ca = ca_path.read_text()
        # 独立显式提供传输信任；不能隐式借用MQTT身份CA或接受叶证书/私钥。
        certificates = re.findall(r"-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----", ota_ca)
        if not certificates or "".join(ota_ca.split()) != "".join("".join(certificates).split()) or len(ota_ca.encode()) > 3999:
            raise ValueError("invalid_ota_https_ca")
        for certificate in certificates:
            parsed = subprocess.run(["openssl", "x509", "-noout", "-ext", "basicConstraints", "-checkend", "0"], input=certificate.encode(), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            if parsed.returncode or b"CA:TRUE" not in parsed.stdout:
                raise ValueError("invalid_ota_https_ca")
    paths, contents = {}, {}
    for name in ("ca", "certificate", "private_key"):
        filename = text(data["identity"][name], 1, 4096)
        path = (configuration.parent / filename).resolve()
        if name == "private_key" and path.stat().st_mode & 0o077:
            raise ValueError("private_key_must_be_owner_only")
        content = path.read_text()
        # NVS 字符串不能跨页，单项连终止符不超过 4000 字节。
        if not content or len(content.encode()) > 3999 or "\x00" in content:
            raise ValueError("identity_pem_exceeds_nvs_string_limit")
        paths[name], contents[name] = path, content
    run("openssl", "verify", "-purpose", "sslclient", "-CAfile", paths["ca"], paths["certificate"])
    subject = run("openssl", "x509", "-in", paths["certificate"], "-noout", "-subject", "-nameopt", "RFC2253").decode().strip()
    if not re.fullmatch(r"subject=\s*CN=" + re.escape(device), subject):
        raise ValueError("certificate_device_id_mismatch")
    public_certificate = run("openssl", "x509", "-in", paths["certificate"], "-noout", "-pubkey")
    public_key = run("openssl", "pkey", "-in", paths["private_key"], "-passin", "pass:", "-pubout")
    if public_certificate != public_key:
        raise ValueError("certificate_private_key_mismatch")
    # 确认明确的 clientAuth EKU，不接受未限制用途或用于 Web 的证书。
    usage = run("openssl", "x509", "-in", paths["certificate"], "-noout", "-ext", "extendedKeyUsage").decode()
    if "TLS Web Client Authentication" not in usage or "TLS Web Server Authentication" in usage:
        raise ValueError("client_auth_certificate_required")
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    values = {"ssid": ssid, "wifi_password": password, "space_id": space, "device_id": device, "broker_host": host, "hardware_rev": hardware}
    values.update(ota_values)
    if ota_policy is not None:
        policy_file = output / "ota-policy.json"
        policy_file.write_bytes(ota_policy)
        policy_file.chmod(0o600)
    if ota_ca is not None:
        ca_file = output / "ota-https-ca.pem"
        ca_file.write_text(ota_ca)
        ca_file.chmod(0o600)
    for name, content in contents.items():
        target = output / f"{name}.pem"
        target.write_text(content)
        target.chmod(0o600)
    source = output / "configuration.csv"
    with source.open("w", newline="") as stream:
        writer = csv.writer(stream)
        writer.writerow(["key", "type", "encoding", "value"])
        writer.writerow(["li-config", "namespace", "", ""])
        for name, value in values.items():
            writer.writerow([name, "data", "string", value])
        writer.writerow(["broker_port", "data", "u16", port])
        if ota_policy is not None:
            writer.writerow(["ota_policy_ver", "data", "u8", 1])
            writer.writerow(["ota_policy", "file", "binary", str(policy_file)])
        if ota_ca is not None:
            writer.writerow(["ota_ca_ver", "data", "u8", 1])
            writer.writerow(["ota_https_ca", "file", "string", str(ca_file)])
        for name in contents:
            writer.writerow([name, "file", "string", str(output / f"{name}.pem")])
    source.chmod(0o600)
    target = output / "nvs.bin"
    try:
        run(sys.executable, "-m", "esp_idf_nvs_partition_gen", "generate", source, target, "0x6000")
    finally:
        if target.exists():
            target.chmod(0o600)
    if target.stat().st_size != 0x6000:
        raise ValueError("invalid_nvs_image_size")
    return {"device_id": device, "space_id": space, "image": str(target), "partition": "nvs", "offset": "0x9000", "size": 0x6000, "encrypted": False, "ota_signing_key_configured": bool(ota_values), "ota_policy_configured": ota_policy is not None, "ota_https_trust_configured": ota_ca is not None}


if __name__ == "__main__":
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        result = prepare(args.config.expanduser().resolve(), args.output.expanduser().resolve())
        print(json.dumps({"status": "ok", **result}))
    except (ValueError, KeyError, OSError, subprocess.CalledProcessError, importlib.metadata.PackageNotFoundError) as error:
        code = str(error) if type(error) is ValueError else "provisioning_validation_or_generation_failed"
        print(json.dumps({"error": code}))
        raise SystemExit(1)
