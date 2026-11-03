"""用固定版本官方派生/解密工具及原版NVS解析器核对实际加密配置。"""
import argparse
from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace

root = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser()
parser.add_argument("--idf-path", type=Path, required=True)
parser.add_argument("--configuration", type=Path, required=True)
parser.add_argument("--key", type=Path, required=True)
parser.add_argument("--image", type=Path, required=True)
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()
sdk = args.idf_path.resolve()
assert subprocess.check_output(["git", "-C", str(sdk), "rev-parse", "HEAD"], text=True).strip() == "fff9895c82d744c7237be8847347bdd1b07c6643"
relative = "components/nvs_flash/nvs_partition_tool/nvs_parser.py"
assert (sdk / relative).read_bytes() == subprocess.check_output(["git", "-C", str(sdk), "show", "HEAD:" + relative])
sys.path.insert(0, str(sdk / "components/nvs_flash/nvs_partition_tool"))
sys.path.insert(0, str(root / "firmware/tools"))
from nvs_parser import NVS_Partition
from nvs_hmac import read_key, xts_keys
from esp_idf_nvs_partition_gen import nvs_partition_gen as official

args.output.mkdir(mode=0o700)
keyfile = args.output / "official-keys.bin"
decrypted = args.output / "recovered.bin"
with redirect_stdout(io.StringIO()):
    official.generate_key(SimpleNamespace(keyfile=str(keyfile), outdir=str(args.output),
        key_protect_hmac=True, kp_hmac_keygen=False, kp_hmac_inputkey=str(args.key)))
    assert keyfile.read_bytes()[:64] == xts_keys(read_key(args.key))
    official.decrypt(SimpleNamespace(input=str(args.image), key=str(keyfile), output=str(decrypted), outdir=str(args.output)))
keyfile.chmod(0o600)
decrypted.chmod(0o600)
partition = NVS_Partition("verified", bytearray(decrypted.read_bytes()))
values, entries = {}, []
for page in partition.pages:
    if page.is_empty:
        continue
    assert page.header["crc"]["original"] == page.header["crc"]["computed"]
    for entry in page.entries:
        if entry.state != "Written":
            continue
        crc = entry.metadata["crc"]
        assert crc["original"] == crc["computed"]
        if entry.metadata["type"] in ("string", "blob_data", "blob"):
            assert crc["data_original"] == crc["data_computed"]
        entries.append(entry)
namespace = next(entry.data["value"] for entry in entries if entry.metadata["namespace"] == 0 and entry.key == "li-config")
for entry in entries:
    if entry.metadata["namespace"] != namespace:
        continue
    if entry.metadata["type"] == "string":
        payload = b"".join(bytes(child.raw) for child in entry.children)[:entry.data["size"]]
        assert payload.endswith(b"\0")
        values[entry.key] = payload[:-1].decode()
    elif entry.metadata["type"] in ("uint8_t", "uint16_t"):
        values[entry.key] = entry.data["value"]
configuration = json.loads(args.configuration.read_text())
assert values["device_id"] == configuration["device_id"] and values["space_id"] == configuration["space_id"]
assert values["ssid"] == configuration["wifi"]["ssid"] and values["wifi_password"] == configuration["wifi"]["password"]
assert values["broker_host"] == configuration["broker"]["host"] and values["broker_port"] == configuration["broker"]["port"]
assert values["hardware_rev"] == configuration["hardware_rev"]
assert values["storage_ver"] == 1 and values["storage_key_id"] == 0
identity = configuration["identity"]
device_local = identity.get("mode") == "device-local"
if device_local:
    assert values["identity_mode"] == 2 and values["identity_ver"] == 1
    assert "certificate" not in values and "private_key" not in values
for name, filename in identity.items():
    if name == "mode":
        continue
    assert values[name] == (args.configuration.parent / filename).read_text()
print(json.dumps({"passed": True, "official_hmac_derivation": True, "official_decryption": True,
    "official_parser_crc": True, "identity_wifi_broker_roundtrip": True, "device_local_identity": device_local, "hardware": False}))
