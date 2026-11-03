"""使用已加载的固定 ESP-IDF 构建开发样机，不安装工具或烧录设备。"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import struct
import subprocess
import sys

project = Path(__file__).resolve().parent.parent
product = project / "firmware/products/desk-node"
revision = "fff9895c82d744c7237be8847347bdd1b07c6643"
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--role", choices=("all", "lamp", "button", "environment"), default="all")
parser.add_argument("--firmware-version", default="0.4.0", help="写入原生应用描述的 major.minor.patch")
parser.add_argument("--security-epoch", type=int, default=0, help="C3 原生安全代次，0–16")
parser.add_argument("--native-anti-rollback", action="store_true", help="显式构建启用原生 eFuse 防降级的镜像；本命令不烧录")
parser.add_argument("--storage", choices=("development", "hmac"), default="development", help="明文开发配置或预置HMAC密钥的加密NVS")
parser.add_argument("--hmac-key-id", type=int, choices=range(6), help="加密NVS明确使用的预置HMAC_UP eFuse块编号；不会写入设备")
parser.add_argument("--identity-maintenance", action="store_true", help="独立HMAC开发维护镜像，USB明确继续前不启动MQTT")
args = parser.parse_args()
if (not re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", args.firmware_version)
        or len(args.firmware_version) > 31
        or any(int(part) > 4294967295 for part in args.firmware_version.split("."))):
    parser.error("固件版本必须为长度不超过31字节、各段不超过uint32的 major.minor.patch")
if not 0 <= args.security_epoch <= 16:
    parser.error("ESP32-C3 安全代次必须为0–16")
if args.security_epoch and not args.native_anti_rollback:
    parser.error("非零安全代次要求显式 --native-anti-rollback；默认开发配置不启用 eFuse 防降级")
if (args.storage == "hmac") != (args.hmac_key_id is not None):
    parser.error("--storage hmac 必须显式提供 --hmac-key-id；开发档位不得指定硬件密钥块")
if args.identity_maintenance and args.storage != "hmac":
    parser.error("--identity-maintenance只用于显式HMAC档位")

sdk = os.environ.get("IDF_PATH")
if not sdk or not (Path(sdk) / "tools/idf.py").is_file():
    raise SystemExit("请先加载 ESP-IDF v6.1 的 export.sh；工具安装到项目 .dev。")
actual = subprocess.run(
    ["git", "-C", sdk, "rev-parse", "HEAD"], capture_output=True, text=True, check=True
).stdout.strip()
if actual != revision:
    raise SystemExit(f"ESP-IDF 修订不匹配：需要 {revision}，当前 {actual}")
subprocess.run(
    [sys.executable, str(project / "firmware/tools/generate-bindings.py"), "--check"],
    cwd=project, check=True,
)
environment = os.environ.copy()
environment.setdefault("IDF_COMPONENT_CACHE_PATH", str(project / ".dev/esp-component-cache"))

for role in ("lamp", "button", "environment") if args.role == "all" else (args.role,):
    profile = "native" if args.native_anti_rollback else "development"
    if args.storage == "hmac":
        profile += f"-hmac-k{args.hmac_key_id}"
    if args.identity_maintenance:
        profile += "-identity-maintenance"
    output = project / ".dev/firmware-build" / f"v{args.firmware_version}-e{args.security_epoch}-{profile}" / role
    output.mkdir(parents=True, exist_ok=True)
    overrides = output / "limeiot.defaults"
    overrides.write_text("\n".join([
        "CONFIG_APP_PROJECT_VER_FROM_CONFIG=n", "CONFIG_APP_EXCLUDE_PROJECT_VER_VAR=n",
        "CONFIG_APP_EXCLUDE_PROJECT_NAME_VAR=n", "CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE=y",
        "CONFIG_BOOTLOADER_APP_ANTI_ROLLBACK=" + ("y" if args.native_anti_rollback else "n"),
        f"CONFIG_BOOTLOADER_APP_SECURE_VERSION={args.security_epoch}",
        "CONFIG_BOOTLOADER_APP_SEC_VER_SIZE_EFUSE_FIELD=16",
        "CONFIG_BOOTLOADER_EFUSE_SECURE_VERSION_EMULATE=n",
        "CONFIG_EFUSE_VIRTUAL=n", "",
        "CONFIG_LIMEIOT_NVS_HMAC_PROTECTED=" + ("y" if args.storage == "hmac" else "n"),
        "CONFIG_LIMEIOT_DEVELOPMENT_IDENTITY_MAINTENANCE=" + ("y" if args.identity_maintenance else "n"),
        "CONFIG_NVS_ENCRYPTION=" + ("y" if args.storage == "hmac" else "n"),
        "CONFIG_PARTITION_TABLE_CUSTOM_FILENAME=\"" + ("partitions.hmac.csv" if args.storage == "hmac" else "partitions.csv") + "\"",
        *( ["CONFIG_NVS_SEC_KEY_PROTECT_USING_HMAC=y", f"CONFIG_NVS_SEC_HMAC_EFUSE_KEY_ID={args.hmac_key_id}"] if args.storage == "hmac" else [] ), "",
    ]))
    defaults = [product / "sdkconfig.defaults"]
    if role != "lamp":
        defaults.append(product / f"sdkconfig.{role}")
    defaults.append(overrides)
    command = [
        sys.executable, str(Path(sdk) / "tools/idf.py"),
        "-C", str(product), "-B", str(output), "-DIDF_TARGET=esp32c3",
        f"-DSDKCONFIG={output / 'sdkconfig'}",
        f"-DLIMEIOT_FIRMWARE_VERSION={args.firmware_version}",
        "-DSDKCONFIG_DEFAULTS=" + ";".join(map(str, defaults)),
    ]
    result = subprocess.run([*command, "reconfigure"], cwd=project, env=environment)
    if result.returncode:
        raise SystemExit(result.returncode)
    config = (output / "sdkconfig").read_text()
    if f"CONFIG_LIMEIOT_ROLE_{role.upper()}=y" not in config:
        raise SystemExit(f"构建角色不匹配：{role}，请检查 {output / 'sdkconfig'}")
    values = dict(re.findall(r"^(CONFIG_[A-Z0-9_]+)=(.*)$", config, re.MULTILINE))
    expected = {"CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE": "y", "CONFIG_MBEDTLS_HAVE_TIME_DATE": "y"}
    expected["CONFIG_PARTITION_TABLE_CUSTOM_FILENAME"] = '"partitions.hmac.csv"' if args.storage == "hmac" else '"partitions.csv"'
    if args.storage == "hmac":
        expected.update(CONFIG_LIMEIOT_NVS_HMAC_PROTECTED="y", CONFIG_NVS_ENCRYPTION="y",
                        CONFIG_NVS_SEC_KEY_PROTECT_USING_HMAC="y", CONFIG_NVS_SEC_HMAC_EFUSE_KEY_ID=str(args.hmac_key_id),
                        CONFIG_LIMEIOT_DEVICE_LOCAL_IDENTITY="y", CONFIG_MBEDTLS_X509_CSR_WRITE_C="y")
    if args.native_anti_rollback:
        expected.update(CONFIG_BOOTLOADER_APP_ANTI_ROLLBACK="y",
                        CONFIG_BOOTLOADER_APP_SECURE_VERSION=str(args.security_epoch),
                        CONFIG_BOOTLOADER_APP_SEC_VER_SIZE_EFUSE_FIELD="16")
    forbidden = ["CONFIG_APP_PROJECT_VER_FROM_CONFIG", "CONFIG_APP_EXCLUDE_PROJECT_VER_VAR",
                 "CONFIG_APP_EXCLUDE_PROJECT_NAME_VAR", "CONFIG_EFUSE_VIRTUAL",
                 "CONFIG_BOOTLOADER_EFUSE_SECURE_VERSION_EMULATE"]
    if args.identity_maintenance:
        expected["CONFIG_LIMEIOT_DEVELOPMENT_IDENTITY_MAINTENANCE"] = "y"
    else:
        forbidden.append("CONFIG_LIMEIOT_DEVELOPMENT_IDENTITY_MAINTENANCE")
    if not args.native_anti_rollback:
        forbidden.append("CONFIG_BOOTLOADER_APP_ANTI_ROLLBACK")
    if args.storage == "development":
        forbidden.extend(["CONFIG_LIMEIOT_NVS_HMAC_PROTECTED", "CONFIG_NVS_ENCRYPTION"])
    if any(values.get(key) != value for key, value in expected.items()) or any(values.get(key) == "y" for key in forbidden):
        raise SystemExit(f"构建配置与请求不符，不继续编译：{output / 'sdkconfig'}")
    subprocess.run([*command, "build"], cwd=project, env=environment, check=True)
    image = output / "limeiot_desk_node.bin"
    raw = image.read_bytes()
    if (len(raw) < 288 or raw[0] != 0xe9 or raw[12:14] != b"\x05\x00"
            or struct.unpack_from("<I", raw, 32)[0] != 0xabcd5432
            or struct.unpack_from("<I", raw, 36)[0] != args.security_epoch
            or raw[48:80].split(b"\x00", 1)[0] != args.firmware_version.encode()):
        raise SystemExit("实际应用镜像元数据不匹配，不生成构建记录")
    info = {"schema": "limeiot.firmware-build", "version": 1, "role": role,
            "firmware_version": args.firmware_version, "security_epoch": args.security_epoch,
            "native_anti_rollback": args.native_anti_rollback, "sdk_revision": revision,
            "storage": args.storage, "hmac_key_id": args.hmac_key_id,
            "identity_maintenance": args.identity_maintenance,
            "image_size_bytes": len(raw), "image_sha256": "sha256:" + hashlib.sha256(raw).hexdigest(),
            "hardware": False}
    (output / "build-info.json").write_text(json.dumps(info, indent=2) + "\n")
    print(f"{role}: {image}（构建与元数据检查通过，未烧录）", flush=True)
