"""使用官方构建工具生成并验证真实签名APK；不读取或操作Android设备。"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import warnings
import zipfile


ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("tv_agent_apk", ROOT / "tools/tv-agent-apk.py")
APK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(APK)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


class ApkPreflightTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        sdk = Path(os.environ.get("ANDROID_HOME", ROOT / ".dev/android-toolchain/sdk"))
        cls.tools = Path(os.environ.get("LIMEIOT_ANDROID_BUILD_TOOLS", sdk / "build-tools/36.0.0"))
        cls.platform = Path(os.environ.get("LIMEIOT_ANDROID_PLATFORM_JAR", sdk / "platforms/android-36/android.jar"))
        for binary in [cls.tools / "aapt2", cls.tools / "apksigner", cls.platform]:
            if not binary.is_file():
                raise RuntimeError("Android构建工具缺失：" + str(binary))
        cls.directory = Path(tempfile.mkdtemp(prefix="tv-apk-preflight-", dir=ROOT / ".dev"))
        cls.fixtures, cls.commands = {}, []
        for name in ["first", "other"]:
            cls.execute("openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", "/CN=Isolated APK " + name,
                        "-keyout", cls.directory / (name + ".key"), "-out", cls.directory / (name + ".crt"))
            cls.execute("openssl", "pkcs8", "-topk8", "-nocrypt", "-in", cls.directory / (name + ".key"), "-outform", "DER", "-out", cls.directory / (name + ".pk8"))
        certificate = cls.execute("openssl", "x509", "-in", cls.directory / "first.crt", "-outform", "DER")
        cls.signer = hashlib.sha256(certificate).hexdigest()
        cls.baseline = cls.fixture("baseline", version=3)
        cls.candidate = cls.fixture("candidate", version=4)

    @classmethod
    def execute(cls, binary, *arguments):
        return subprocess.run([str(binary), *map(str, arguments)], check=True, capture_output=True, timeout=10).stdout

    @classmethod
    def fixture(cls, name, version=4, package=APK.PACKAGE, minimum=23, maximum=None, debug=False, test_only=False,
                signer="first", abis=(), root_attributes="", requirements="", application_requirements="", application_attributes="", sdk_requirements="", v1=True, permissions=""):
        if name in cls.fixtures:
            return cls.fixtures[name]
        manifest = cls.directory / (name + ".xml")
        maximum = "" if maximum is None else f' android:maxSdkVersion="{maximum}"'
        manifest.write_text(f'''<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="{package}" android:versionCode="{version}" {root_attributes}>
<uses-sdk android:minSdkVersion="{minimum}" android:targetSdkVersion="36"{maximum}>{sdk_requirements}</uses-sdk>{requirements}{permissions}
<application android:debuggable="{str(debug).lower()}" android:testOnly="{str(test_only).lower()}" {application_attributes}>{application_requirements}</application></manifest>''')
        unsigned = cls.directory / (name + "-unsigned.apk")
        cls.execute(cls.tools / "aapt2", "link", "-I", cls.platform, "--manifest", manifest, "-o", unsigned)
        with zipfile.ZipFile(unsigned, "a") as archive:
            archive.writestr("assets/payload.txt", b"original-signed-payload")
            for abi in abis:
                # 仅用于打包ABI门槛，不冒称可加载或运行的ELF库。
                archive.writestr("lib/" + abi + "/libfixture.so", b"packaged-abi-fixture")
        output = cls.directory / (name + ".apk")
        cls.execute(cls.tools / "apksigner", "sign", "--key", cls.directory / (signer + ".pk8"), "--cert", cls.directory / (signer + ".crt"),
                    "--v1-signing-enabled", str(v1).lower(), "--v2-signing-enabled", "true", "--v3-signing-enabled", "false", "--v4-signing-enabled", "false",
                    "--min-sdk-version", "23", "--out", output, unsigned)
        cls.fixtures[name] = output
        return output

    def check(self, candidate=None, **changes):
        candidate = candidate or self.candidate
        arguments = {"baseline": self.baseline, "baseline_sha256": sha(self.baseline), "candidate": candidate, "candidate_sha256": sha(candidate),
                     "signer_sha256": self.signer, "build_tools": self.tools, "device_api": 23, "device_abis": ["armeabi-v7a", "armeabi"]}
        arguments.update(changes)
        original = APK.run_tool
        def observed(binary, *args):
            self.commands.append({"test": self.id(), "tool": binary.name, "arguments": [str(x) for x in args[:-1]]})
            return original(binary, *args)
        with patch.object(APK, "run_tool", side_effect=observed):
            return APK.preflight(**arguments)

    def rejected(self, reason, candidate=None, **changes):
        with self.assertRaisesRegex(APK.Rejected, "^" + reason + "$"):
            self.check(candidate, **changes)

    def test_signed_upgrade_and_permission_delta_do_not_authorize_installation(self):
        candidate = self.fixture("permission", permissions='<uses-permission android:name="android.permission.INTERNET"/>')
        before = [sha(self.baseline), sha(candidate)]
        value = self.check(candidate)
        self.assertEqual(value["status"], "offline_checks_passed")
        self.assertEqual(value["baseline"]["version_code"], 3)
        self.assertEqual(value["candidate"]["version_code"], 4)
        self.assertEqual(value["candidate"]["min_sdk"], 23)
        self.assertEqual(value["added_permissions"], ["android.permission.INTERNET"])
        self.assertFalse(value["installation_authorized"])
        self.assertFalse(value["device_state_verified"])
        self.assertFalse(value["storage_compatibility_verified"])
        self.assertEqual(before, [sha(self.baseline), sha(candidate)])
        self.assertEqual({command["tool"] for command in self.commands}, {"aapt2", "apksigner"})

    def test_signer_pin_and_continuity(self):
        self.rejected("signer_mismatch", signer_sha256="0" * 64)
        self.rejected("signer_mismatch", self.fixture("other-signer", signer="other"))

    def signing_configuration(self):
        java_home = Path(os.environ.get("JAVA_HOME", ROOT / ".dev/android-toolchain/jvm/jdk-21.0.13+9/Contents/Home"))
        store = self.directory / "preflight-signer.p12"
        if not store.exists():
            self.execute("openssl", "pkcs12", "-export", "-in", self.directory / "first.crt", "-inkey", self.directory / "first.key",
                         "-name", "release", "-out", store, "-passout", "env:LIMEIOT_APK_TEST_PASSWORD")
        return java_home, store

    def test_signed_preflight_authenticates_sdk_report_with_original_apk_identity(self):
        report = self.check()
        with patch.dict(os.environ, {"LIMEIOT_APK_TEST_PASSWORD": "isolated-preflight-tests"}):
            java_home, store = self.signing_configuration()
            output = self.directory / "signed-preflight.jar"
            digest = APK.sign_preflight(report, self.candidate, sha(self.candidate), self.signer, output, java_home, store, "release",
                                        "LIMEIOT_APK_TEST_PASSWORD", "LIMEIOT_APK_TEST_PASSWORD", "SHA256withRSA")
            self.execute(java_home / "bin/jarsigner", "-verify", output)
        with zipfile.ZipFile(output) as archive:
            self.assertEqual(set(archive.namelist()) - {"META-INF/"}, {"META-INF/MANIFEST.MF", "META-INF/LIMEIOT.SF", "META-INF/LIMEIOT.RSA", "preflight.json"})
            encoded = archive.read("preflight.json")
            statement = json.loads(encoded)
        self.assertEqual(hashlib.sha256(encoded).hexdigest(), digest)
        self.assertEqual(statement["candidate_bytes"], self.candidate.stat().st_size)
        self.assertEqual(statement["preflight"], report)
        self.assertFalse(statement["preflight"]["installation_authorized"])
        (self.directory / "signed-preflight-result.json").write_text(json.dumps({"bundle": str(output), "candidate": str(self.candidate), "signer": "sha256:" + self.signer}))

    def test_preflight_signing_refuses_wrong_identity_changed_candidate_and_output_overwrite(self):
        report = self.check()
        with patch.dict(os.environ, {"LIMEIOT_APK_TEST_PASSWORD": "isolated-preflight-tests"}):
            java_home, store = self.signing_configuration()
            def sign(output, expected_signer=self.signer, expected_candidate=None):
                return APK.sign_preflight(report, self.candidate, expected_candidate or sha(self.candidate), expected_signer, output, java_home, store, "release",
                                          "LIMEIOT_APK_TEST_PASSWORD", "LIMEIOT_APK_TEST_PASSWORD", "SHA256withRSA")
            absent = self.directory / "refused-signed.jar"
            with self.assertRaisesRegex(APK.Rejected, "^signing_certificate_mismatch$"):
                sign(absent, expected_signer="0" * 64)
            self.assertFalse(absent.exists())
            with self.assertRaisesRegex(APK.Rejected, "^artifact_digest_mismatch$"):
                sign(absent, expected_candidate="0" * 64)
            self.assertFalse(absent.exists())
            retained = self.directory / "retained.jar"; retained.write_bytes(b"retained-original")
            with self.assertRaisesRegex(APK.Rejected, "^signed_output_exists$"):
                sign(retained)
            self.assertEqual(retained.read_bytes(), b"retained-original")

    def test_pinned_snapshot_rejects_changed_bytes_before_running_tools(self):
        called = len(self.commands)
        self.rejected("artifact_digest_mismatch", candidate_sha256="0" * 64)
        self.assertEqual(len(self.commands), called)
        edited = self.directory / "unprotected-meta.apk"
        edited.write_bytes(self.candidate.read_bytes())
        with zipfile.ZipFile(edited, "a") as archive:
            archive.writestr("META-INF/extra-policy", "not protected by v1")
        self.rejected("artifact_digest_mismatch", edited, candidate_sha256=sha(self.candidate))
        self.assertEqual(len(self.commands), called)

    def test_tampered_signed_payload_is_rejected_even_with_matching_file_digest(self):
        tampered = self.directory / "tampered.apk"
        with zipfile.ZipFile(self.candidate) as source, zipfile.ZipFile(tampered, "w") as output:
            for entry in source.infolist():
                output.writestr(entry, b"tampered" if entry.filename == "assets/payload.txt" else source.read(entry))
        self.rejected("android_tool_rejected_apk", tampered)

    def test_unsigned_and_v2_only_apks_fail_on_api23(self):
        self.rejected("android_tool_rejected_apk", self.directory / "candidate-unsigned.apk")
        self.rejected("android_tool_rejected_apk", self.fixture("v2-only", v1=False))

    def test_wrong_package_and_non_increasing_versions(self):
        self.rejected("package_mismatch", self.fixture("wrong-package", package="example.other"))
        self.rejected("version_not_increasing", self.baseline)
        self.rejected("version_not_increasing", self.fixture("downgrade", version=2))

    def test_minimum_and_maximum_api_are_checked(self):
        self.rejected("api_incompatible", self.fixture("api24", minimum=24))
        self.rejected("api_incompatible", self.fixture("api25-max", maximum=25), device_api=26)
        self.rejected("unsupported_target_api", device_api=37)

    def test_declared_native_abi_and_abi_independent_packages(self):
        arm = self.fixture("arm", abis=["armeabi-v7a"])
        self.assertEqual(self.check(arm)["candidate"]["native_abis"], ["armeabi-v7a"])
        self.rejected("abi_incompatible", self.fixture("arm64", abis=["arm64-v8a"]))
        self.assertEqual(self.check()["candidate"]["native_abis"], [])
        self.rejected("invalid_target_abis", device_abis=["armeabi", "armeabi"])

    def test_debug_opt_in_does_not_override_test_only_rejection(self):
        debug = self.fixture("debug", debug=True)
        self.rejected("debug_apk_requires_explicit_opt_in", debug)
        self.assertTrue(self.check(debug, allow_debug=True)["debug_candidate_explicitly_allowed"])
        self.rejected("test_only_apk", self.fixture("test-only", test_only=True), allow_debug=True)

    def test_split_shared_identity_and_extra_requirements_are_not_assumed_supported(self):
        for name, attributes in [("split", 'split="feature"'), ("shared", 'android:sharedUserId="example.shared"'), ("major", 'android:versionCodeMajor="1"')]:
            self.rejected("unsupported_apk_layout", self.fixture(name, root_attributes=attributes))
        self.rejected("unsupported_apk_requirements", self.fixture("camera", requirements='<uses-feature android:name="android.hardware.camera"/>'))
        self.rejected("unsupported_apk_requirements", self.fixture("shared-library", application_requirements='<uses-library android:name="example.required"/>'))
        self.rejected("unsupported_apk_layout", self.fixture("required-split", application_attributes='android:isSplitRequired="true"'))
        self.rejected("unsupported_apk_layout", self.fixture("required-split-type", application_attributes='android:requiredSplitTypes="base__abi"'))
        self.rejected("unsupported_apk_requirements", self.fixture("sdk-extension", sdk_requirements='<extension-sdk android:sdkVersion="30" android:minExtensionVersion="5"/>'))

    def test_duplicate_archive_entries_and_symlinks_are_rejected(self):
        duplicate = self.directory / "duplicate.apk"
        duplicate.write_bytes(self.candidate.read_bytes())
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)
            with zipfile.ZipFile(duplicate, "a") as archive:
                archive.writestr("assets/payload.txt", "duplicate")
        self.rejected("invalid_apk_archive", duplicate)
        linked = self.directory / "linked.apk"
        linked.symlink_to(self.candidate)
        with self.assertRaises(OSError):
            self.check(linked)

    def test_cli_reports_rejection_and_never_exposes_sdk_diagnostics(self):
        arguments = [sys.executable, str(ROOT / "tools/tv-agent-apk.py"), "--build-tools", str(self.tools), "--baseline", str(self.baseline), "--baseline-sha256", sha(self.baseline),
                     "--candidate", str(self.candidate), "--candidate-sha256", sha(self.candidate), "--signer-sha256", self.signer, "--device-api", "23", "--device-abi", "armeabi-v7a"]
        passed = subprocess.run(arguments, capture_output=True, text=True, timeout=20)
        self.assertEqual(passed.returncode, 0, passed.stderr)
        self.assertEqual(json.loads(passed.stdout)["status"], "offline_checks_passed")
        arguments[arguments.index("--candidate-sha256") + 1] = "0" * 64
        rejected = subprocess.run(arguments, capture_output=True, text=True, timeout=20)
        self.assertEqual(rejected.returncode, 1)
        self.assertEqual(json.loads(rejected.stdout), {"schema_version": 1, "status": "rejected", "reason": "artifact_digest_mismatch", "installation_authorized": False})
        self.assertEqual(rejected.stderr, "")

    def test_android_tool_output_and_execution_are_bounded(self):
        with self.assertRaisesRegex(APK.Rejected, "^android_tool_output_limit$"):
            APK.run_tool(Path(sys.executable), "-c", "import os; os.write(1, b'x' * 262145)")
        with self.assertRaisesRegex(APK.Rejected, "^android_tool_timeout$"):
            APK.run_tool(Path(sys.executable), "-c", "import time; time.sleep(30)")


if __name__ == "__main__":
    program = unittest.main(verbosity=2, exit=False)
    directory = getattr(ApkPreflightTest, "directory", None)
    if directory:
        report = {"passed": program.result.wasSuccessful(), "tests": program.result.testsRun, "failures": len(program.result.failures), "errors": len(program.result.errors),
                  "hardware": False, "installation_authorized": False, "apk_installation": False, "full_goal_completed": False,
                  "fixtures": {name: sha(apk) for name, apk in ApkPreflightTest.fixtures.items()}, "tool_invocations": ApkPreflightTest.commands,
                  "inputs": {"tools/tv-agent-apk.py": sha(ROOT / "tools/tv-agent-apk.py"), "tests/test_tv_agent_apk.py": sha(Path(__file__)),
                             "aapt2": sha(ApkPreflightTest.tools / "aapt2"), "apksigner": sha(ApkPreflightTest.tools / "apksigner"),
                             "apksigner.jar": sha(ApkPreflightTest.tools / "lib/apksigner.jar"), "android.jar": sha(ApkPreflightTest.platform)}}
        (directory / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
        print(json.dumps({"report": str(directory / "report.json"), "passed": report["passed"]}))
    raise SystemExit(not program.result.wasSuccessful())
