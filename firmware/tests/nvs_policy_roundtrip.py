"""使用固定ESP-IDF官方解析器，恢复实际NVS策略块并交给正式C核心预检。"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser()
parser.add_argument("--idf-path", type=Path, required=True)
args = parser.parse_args()
sdk = args.idf_path.resolve()
revision = subprocess.check_output(["git", "-C", str(sdk), "rev-parse", "HEAD"], text=True).strip()
if revision != "fff9895c82d744c7237be8847347bdd1b07c6643":
    raise SystemExit("fixed_esp_idf_revision_required")
parser_relative = "components/nvs_flash/nvs_partition_tool/nvs_parser.py"
parser_bytes = (sdk/parser_relative).read_bytes()
if parser_bytes != subprocess.check_output(["git", "-C", str(sdk), "show", "HEAD:"+parser_relative]):
    raise SystemExit("unmodified_official_nvs_parser_required")
sys.path.insert(0, str(sdk / "components/nvs_flash/nvs_partition_tool"))
from nvs_parser import NVS_Partition


def payload(entry):
    return b"".join(bytes(child.raw) for child in entry.children)[:entry.data["size"]]


def extract(image, ca_path):
    partition = NVS_Partition("fixture", bytearray(image.read_bytes()))
    entries = []
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
                assert all(child.state == "Written" for child in entry.children)
            entries.append(entry)
    namespaces = [entry for entry in entries if entry.metadata["namespace"] == 0 and entry.key == "li-config"]
    assert len(namespaces) == 1
    namespace = namespaces[0].data["value"]
    scoped = [entry for entry in entries if entry.metadata["namespace"] == namespace]
    ca_markers = [entry for entry in scoped if entry.key == "ota_ca_ver"]
    ca_values = [entry for entry in scoped if entry.key == "ota_https_ca"]
    if ca_path:
        assert len(ca_markers) == 1 and ca_markers[0].metadata["type"] == "uint8_t" and ca_markers[0].data["value"] == 1
        assert len(ca_values) == 1 and ca_values[0].metadata["type"] == "string"
        assert payload(ca_values[0]) == Path(ca_path).read_bytes()+b"\0"
    else:
        assert not ca_markers and not ca_values
    markers = [entry for entry in scoped if entry.key == "ota_policy_ver"]
    assert len(markers) == 1 and markers[0].metadata["type"] == "uint8_t" and markers[0].data["value"] == 1
    indexes = [entry for entry in scoped if entry.key == "ota_policy" and entry.metadata["type"] == "blob_index"]
    assert len(indexes) == 1
    index = indexes[0]
    chunks = sorted((entry for entry in scoped if entry.key == "ota_policy" and entry.metadata["type"] == "blob_data"), key=lambda entry: entry.metadata["chunk_index"])
    assert len(chunks) == index.data["chunk_count"]
    assert [entry.metadata["chunk_index"] for entry in chunks] == list(range(index.data["chunk_start"], index.data["chunk_start"]+len(chunks)))
    raw = b"".join(payload(entry) for entry in chunks)
    assert len(raw) == index.data["size"]
    document = json.loads(raw)
    for name, expected in (("ota_public_key", document["public_key"]), ("ota_key_id", document["signing_key_id"])):
        values = [entry for entry in scoped if entry.key == name]
        assert len(values) == 1 and values[0].metadata["type"] == "string"
        assert payload(values[0]) == expected.encode()+b"\0"
    return raw, len(chunks)


vector = json.loads((root / "contracts/examples/ota-firmware.json").read_text())
fixtures = json.loads((root / ".dev/ota-config-provisioning.json").read_text())
results = []
for case in fixtures["cases"]:
    image, expected_path = Path(case["image"]), Path(case["policy"])
    ca_path = case.get("ota_https_ca")
    raw, chunks = extract(image, ca_path)
    assert raw == expected_path.read_bytes()
    directory = image.parent
    recovered = directory / "policy-from-nvs.json"
    recovered.write_bytes(raw)
    recovered.chmod(0o600)
    manifest = directory / "manifest-for-preflight.json"
    local = directory / "local-for-preflight.json"
    manifest.write_text(json.dumps(vector["request"]["manifest"]))
    request = vector["request"]
    seconds = lambda value: int(datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp())
    local.write_text(json.dumps({**request, "now": seconds("2026-11-02T00:00:00Z"),
        "trust_not_before": seconds(request["trust"]["not_before"]), "trust_expires_at": seconds(request["trust"]["expires_at"])}))
    manifest.chmod(0o600)
    local.chmod(0o600)
    output = subprocess.run([str(root/".dev/firmware-host/ota-policy"), str(manifest), str(local), str(recovered)], capture_output=True, text=True, check=True)
    assert not output.stderr
    evidence = json.loads(output.stdout)
    assert evidence["accepted"] and evidence["trust_decoded"] and evidence["issue"] == "ok"
    results.append({"image":str(image), "policy_bytes":len(raw), "blob_chunks":chunks,
        "policy_sha256":hashlib.sha256(raw).hexdigest(), "image_sha256":hashlib.sha256(image.read_bytes()).hexdigest(),
        "official_parser_crc":True, "byte_exact_policy":True, "c_preflight":True, "hardware":False,
        "ota_https_ca":bool(ca_path), "ota_https_ca_sha256":hashlib.sha256(Path(ca_path).read_bytes()).hexdigest() if ca_path else None})
assert len(results) == 5 and any(case["blob_chunks"] > 1 and case["ota_https_ca"] for case in results)
report = {"passed":True, "sdk_revision":revision, "official_parser_sha256":hashlib.sha256(parser_bytes).hexdigest(),
          "cases":results, "hardware":False, "device_boot":False}
(root/".dev/ota-config-nvs-check.json").write_text(json.dumps(report, indent=2)+"\n")
print(json.dumps({"passed":True,"images":len(results),"multipage":True,"c_preflight":True,"hardware":False}))
