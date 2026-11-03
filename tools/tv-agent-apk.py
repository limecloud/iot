"""离线核对TV Agent基线与候选APK；不连接设备、不批准或执行安装。"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import stat
import subprocess
import tempfile
import time
import zipfile


PACKAGE = "run.limeai.iot.television"
MAX_APK_BYTES = 256 * 1024 * 1024
ANDROID = "http://schemas.android.com/apk/res/android:"
ABIS = {"armeabi", "armeabi-v7a", "arm64-v8a", "x86", "x86_64", "riscv64"}


class Rejected(ValueError):
    pass


def require(condition, reason):
    if not condition:
        raise Rejected(reason)


def digest(value):
    require(isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value), "invalid_digest")
    return value


def snapshot(source, expected, destination):
    digest(expected)
    fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as original, destination.open("xb") as output:
        info = os.fstat(original.fileno())
        require(stat.S_ISREG(info.st_mode) and 0 < info.st_size <= MAX_APK_BYTES, "invalid_apk_file")
        total = 0
        hashed = hashlib.sha256()
        while block := original.read(1024 * 1024):
            total += len(block)
            require(total <= MAX_APK_BYTES, "apk_too_large")
            hashed.update(block)
            output.write(block)
        require(total == info.st_size and hashed.hexdigest() == expected, "artifact_digest_mismatch")


def run_tool(binary, *arguments):
    # 固定期限及实时输出上限；SDK诊断与APK可控文本不直接回显给调用者。
    output = bytearray()
    deadline = time.monotonic() + 10
    with subprocess.Popen([str(binary), *map(str, arguments)], stdout=subprocess.PIPE, stderr=subprocess.STDOUT) as child, selectors.DefaultSelector() as selector:
        selector.register(child.stdout, selectors.EVENT_READ)
        try:
            while True:
                remaining = deadline - time.monotonic()
                require(remaining > 0 and selector.select(remaining), "android_tool_timeout")
                block = os.read(child.stdout.fileno(), 8192)
                if not block:
                    break
                output.extend(block)
                require(len(output) <= 262144, "android_tool_output_limit")
            code = child.wait(timeout=max(0.001, deadline - time.monotonic()))
        except subprocess.TimeoutExpired as failure:
            raise Rejected("android_tool_timeout") from failure
        finally:
            if child.poll() is None:
                child.kill()
    require(code == 0, "android_tool_rejected_apk")
    return output.decode("utf-8", errors="strict")


def manifest_tree(text):
    roots, stack = [], []
    for line in text.splitlines():
        indent = len(line) - len(line.lstrip())
        body = line.strip()
        if body.startswith("N: "):
            continue
        element = re.fullmatch(r"E: ([A-Za-z0-9_.-]+) \(line=\d+\)", body)
        if element:
            while stack and stack[-1][0] >= indent:
                stack.pop()
            node = {"name": element[1], "attributes": {}, "children": []}
            (stack[-1][1]["children"] if stack else roots).append(node)
            stack.append((indent, node))
            continue
        attribute = re.fullmatch(r"A: (" + re.escape(ANDROID) + r")?([A-Za-z0-9_.-]+)(?:\(0x[0-9a-fA-F]+\))?=(.*)", body)
        require(attribute is not None and stack and indent > stack[-1][0], "unsupported_manifest")
        key = (attribute[1] or "") + attribute[2]
        attributes = stack[-1][1]["attributes"]
        require(key not in attributes, "duplicate_manifest_attribute")
        attributes[key] = attribute[3]
    require(len(roots) == 1 and roots[0]["name"] == "manifest", "invalid_manifest")
    return roots[0]


def number(attributes, key, default=None):
    value = attributes.get(ANDROID + key)
    if value is None:
        return default
    require(re.fullmatch(r"(?:\d+|0x[0-9a-fA-F]+)", value), "unsupported_manifest")
    return int(value, 16 if value.startswith("0x") else 10)


def string(value):
    require(isinstance(value, str) and value.startswith('"'), "unsupported_manifest")
    try:
        decoded, _ = json.JSONDecoder().raw_decode(value)
    except ValueError as failure:
        raise Rejected("unsupported_manifest") from failure
    require(isinstance(decoded, str), "unsupported_manifest")
    return decoded


def metadata(tree):
    attributes = tree["attributes"]
    require(string(attributes.get("package")) == PACKAGE, "package_mismatch")
    require(not any(key in attributes for key in ["split", "coreApp", ANDROID + "isFeatureSplit", ANDROID + "configForSplit", ANDROID + "sharedUserId", ANDROID + "versionCodeMajor", ANDROID + "isSplitRequired", ANDROID + "requiredSplitTypes", ANDROID + "splitTypes"]), "unsupported_apk_layout")
    sdk = [node for node in tree["children"] if node["name"] == "uses-sdk"]
    applications = [node for node in tree["children"] if node["name"] == "application"]
    require(len(sdk) <= 1 and len(applications) == 1, "invalid_manifest")
    sdk = sdk[0]["attributes"] if sdk else {}
    minimum = number(sdk, "minSdkVersion", 1)
    target = number(sdk, "targetSdkVersion", minimum)
    maximum = number(sdk, "maxSdkVersion")
    version = number(attributes, "versionCode")
    require(version is not None and 0 < version <= 2147483647 and 0 < minimum <= target and (maximum is None or maximum >= minimum), "invalid_manifest")
    app = applications[0]["attributes"]
    require(app.get(ANDROID + "isSplitRequired", "false") == "false" and not any(ANDROID + key in app for key in ["requiredSplitTypes", "splitTypes"]), "unsupported_apk_layout")
    require(app.get(ANDROID + "testOnly", "false") == "false", "test_only_apk")
    debug = app.get(ANDROID + "debuggable", "false")
    require(debug in {"true", "false"}, "unsupported_manifest")
    # 首个切片只接受不依赖额外系统库、必需硬件或拆分包的独立Agent APK。
    nodes = list(tree["children"]) + list(applications[0]["children"])
    nodes += [child for node in tree["children"] if node["name"] == "uses-sdk" for child in node["children"]]
    for node in nodes:
        require(node["name"] not in {"uses-split", "uses-library", "uses-static-library", "uses-sdk-library", "uses-native-library", "static-library", "sdk-library", "extension-sdk", "uses-configuration", "compatible-screens", "overlay", "instrumentation"}, "unsupported_apk_requirements")
        if node["name"] == "uses-feature":
            require(node["attributes"].get(ANDROID + "required", "true") == "false", "unsupported_apk_requirements")
    permissions = sorted({string(node["attributes"].get(ANDROID + "name")) for node in tree["children"] if node["name"] in {"uses-permission", "uses-permission-sdk-23"}})
    return {"package_name": PACKAGE, "version_code": version, "min_sdk": minimum, "target_sdk": target, "max_sdk": maximum, "debuggable": debug == "true", "permissions": permissions}


def native_abis(apk):
    with zipfile.ZipFile(apk) as archive:
        entries = archive.infolist()
        require(len(entries) <= 20000 and len({entry.filename for entry in entries}) == len(entries), "invalid_apk_archive")
        require(any(entry.filename == "AndroidManifest.xml" for entry in entries), "invalid_apk_archive")
        abis = set()
        for entry in entries:
            name = entry.filename
            require(not name.startswith("/") and "\\" not in name and all(part not in {".", ".."} for part in name.split("/")), "invalid_apk_archive")
            if not name.startswith("lib/") or entry.is_dir():
                continue
            match = re.fullmatch(r"lib/([^/]+)/[^/]+\.so", name)
            require(match is not None and match[1] in ABIS, "unsupported_native_layout")
            # 此处只核对打包ABI；实际ELF、链接依赖与运行健康仍由系统安装/端上验收。
            abis.add(match[1])
    return sorted(abis)


def inspect(apk, expected, build_tools, api, signer):
    abis = native_abis(apk)
    value = metadata(manifest_tree(run_tool(build_tools / "aapt2", "dump", "xmltree", "--file", "AndroidManifest.xml", apk)))
    require(value["min_sdk"] <= api and (value["max_sdk"] is None or api <= value["max_sdk"]), "api_incompatible")
    verified = run_tool(build_tools / "apksigner", "verify", "--verbose", "--print-certs", "--min-sdk-version", api, "--max-sdk-version", api, apk)
    signers = re.findall(r"^Signer #\d+ certificate SHA-256 digest: ([0-9a-f]{64})$", verified, re.M)
    require(signers == [signer] and re.findall(r"^Number of signers: (\d+)$", verified, re.M) == ["1"], "signer_mismatch")
    with apk.open("rb") as source:
        hashed = hashlib.sha256()
        while block := source.read(1024 * 1024):
            hashed.update(block)
    require(hashed.hexdigest() == expected, "artifact_changed_during_inspection")
    return {**value, "sha256": expected, "signer_sha256": signer, "native_abis": abis, "signature_warning_count": len(re.findall(r"^WARNING:", verified, re.M))}


def preflight(baseline, baseline_sha256, candidate, candidate_sha256, signer_sha256, build_tools, device_api, device_abis, allow_debug=False):
    digest(signer_sha256)
    require(type(device_api) is int and 23 <= device_api <= 36, "unsupported_target_api")
    require(device_abis and len(device_abis) == len(set(device_abis)) and all(abi in ABIS for abi in device_abis), "invalid_target_abis")
    with tempfile.TemporaryDirectory(prefix="limeiot-tv-apk-") as directory:
        copies = [Path(directory) / "baseline.apk", Path(directory) / "candidate.apk"]
        snapshot(baseline, baseline_sha256, copies[0])
        snapshot(candidate, candidate_sha256, copies[1])
        old = inspect(copies[0], baseline_sha256, build_tools, device_api, signer_sha256)
        new = inspect(copies[1], candidate_sha256, build_tools, device_api, signer_sha256)
    require(new["version_code"] > old["version_code"], "version_not_increasing")
    require(not new["debuggable"] or allow_debug, "debug_apk_requires_explicit_opt_in")
    for value in [old, new]:
        require(not value["native_abis"] or set(value["native_abis"]) & set(device_abis), "abi_incompatible")
    return {"schema_version": 1, "status": "offline_checks_passed", "installation_authorized": False,
            "device_state_verified": False, "storage_compatibility_verified": False,
            "target": {"api_level": device_api, "abis": device_abis}, "baseline": old, "candidate": new,
            "added_permissions": sorted(set(new["permissions"]) - set(old["permissions"])),
            "debug_candidate_explicitly_allowed": bool(new["debuggable"] and allow_debug)}


def sign_preflight(report, candidate, candidate_sha256, signer_sha256, output, java_home, keystore, key_alias, store_pass_env, key_pass_env, signature_algorithm):
    """原APK签名身份认证预检结果；Keystore私钥由JDK读取，不导出或打印口令。"""
    require(not output.exists(), "signed_output_exists")
    require(signature_algorithm in {"SHA256withRSA", "SHA256withECDSA"}, "unsupported_signing_algorithm")
    require(report["status"] == "offline_checks_passed", "preflight_required")
    for name in (store_pass_env, key_pass_env):
        require(isinstance(name, str) and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,127}", name) and name in os.environ, "signing_password_unavailable")
    require(isinstance(key_alias, str) and re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", key_alias), "invalid_key_alias")
    certificate = run_tool(java_home / "bin/keytool", "-exportcert", "-rfc", "-keystore", keystore,
                           "-alias", key_alias, "-storepass:env", store_pass_env)
    match = re.fullmatch(r"\s*-----BEGIN CERTIFICATE-----\s+([A-Za-z0-9+/=\s]+)-----END CERTIFICATE-----\s*", certificate)
    require(match is not None, "signing_certificate_unavailable")
    try:
        der = base64.b64decode(re.sub(r"\s", "", match[1]), validate=True)
    except ValueError as failure:
        raise Rejected("signing_certificate_unavailable") from failure
    require(hashlib.sha256(der).hexdigest() == signer_sha256, "signing_certificate_mismatch")
    with tempfile.TemporaryDirectory(prefix="limeiot-tv-preflight-sign-") as directory:
        directory = Path(directory)
        copied = directory / "candidate.apk"
        snapshot(candidate, candidate_sha256, copied)
        statement = {"schema": "limeiot.tv-apk-preflight", "version": 1, "candidate_bytes": copied.stat().st_size, "preflight": report}
        encoded = json.dumps(statement, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
        require(len(encoded) <= 65536, "preflight_report_too_large")
        archive = directory / "preflight.jar"
        with zipfile.ZipFile(archive, "x", compression=zipfile.ZIP_DEFLATED) as bundle:
            bundle.writestr("preflight.json", encoded)
        run_tool(java_home / "bin/jarsigner", "-keystore", keystore, "-storepass:env", store_pass_env,
                 "-keypass:env", key_pass_env, "-digestalg", "SHA-256", "-sigalg", signature_algorithm,
                 "-sigfile", "LIMEIOT", archive, key_alias)
        run_tool(java_home / "bin/jarsigner", "-verify", archive)
        require(archive.stat().st_size <= 1048576, "preflight_bundle_too_large")
        with archive.open("rb") as source, output.open("xb") as destination:
            destination.write(source.read()); destination.flush(); os.fsync(destination.fileno())
    return hashlib.sha256(encoded).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ["baseline", "candidate", "build-tools"]:
        parser.add_argument("--" + name, type=Path, required=True)
    for name in ["baseline-sha256", "candidate-sha256", "signer-sha256"]:
        parser.add_argument("--" + name, required=True)
    parser.add_argument("--device-api", type=int, required=True)
    parser.add_argument("--device-abi", action="append", required=True)
    parser.add_argument("--allow-debug", action="store_true")
    parser.add_argument("--signed-output", type=Path)
    parser.add_argument("--signing-java-home", type=Path)
    parser.add_argument("--keystore", type=Path)
    parser.add_argument("--key-alias")
    parser.add_argument("--store-pass-env")
    parser.add_argument("--key-pass-env")
    parser.add_argument("--signature-algorithm", choices=["SHA256withRSA", "SHA256withECDSA"], default="SHA256withRSA")
    args = vars(parser.parse_args())
    args["device_abis"] = args.pop("device_abi")
    signing = {name: args.pop(name) for name in ("signed_output", "signing_java_home", "keystore", "key_alias", "store_pass_env", "key_pass_env", "signature_algorithm")}
    try:
        value = preflight(**args)
        if signing["signed_output"] is not None:
            require(all(signing[name] is not None for name in ("signing_java_home", "keystore", "key_alias", "store_pass_env", "key_pass_env")), "signing_configuration_required")
            sign_preflight(value, args["candidate"], args["candidate_sha256"], args["signer_sha256"], signing["signed_output"],
                           signing["signing_java_home"], signing["keystore"], signing["key_alias"], signing["store_pass_env"], signing["key_pass_env"], signing["signature_algorithm"])
        else:
            require(all(signing[name] is None for name in ("signing_java_home", "keystore", "key_alias", "store_pass_env", "key_pass_env")), "signed_output_required")
    except (Rejected, OSError, UnicodeError, zipfile.BadZipFile, subprocess.SubprocessError) as failure:
        value = {"schema_version": 1, "status": "rejected", "reason": str(failure) if isinstance(failure, Rejected) else "apk_inspection_failed", "installation_authorized": False}
        print(json.dumps(value, ensure_ascii=False))
        return 1
    print(json.dumps(value, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
