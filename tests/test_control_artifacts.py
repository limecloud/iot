"""控制面制品门禁：静态Go、动态Rust、正式运行层及源码/制品完整性。"""
import importlib.util
import json
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch

from test_nas_artifacts import elf

ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("control_artifacts", ROOT / "tools/build-control-artifacts.py")
control = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(control)
nas = control.nas


def static_elf(target):
    data = bytearray(elf(target))
    struct.pack_into("<I", data, 64, 1)
    return bytes(data)


class ControlArtifactTests(unittest.TestCase):
    def test_static_go_rejects_dynamic_or_wrong_architecture(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "binary"
            for target in nas.TARGETS:
                path.write_bytes(static_elf(target))
                nas.check_elf(path, target, static=True)
                with self.assertRaisesRegex(ValueError, "elf_interpreter_mismatch"):
                    nas.check_elf(path, target)
                path.write_bytes(elf(target))
                with self.assertRaisesRegex(ValueError, "elf_interpreter_mismatch"):
                    nas.check_elf(path, target, static=True)
            path.write_bytes(static_elf("linux/amd64"))
            with self.assertRaisesRegex(ValueError, "elf_architecture_mismatch"):
                nas.check_elf(path, "linux/arm64", static=True)

    def test_build_inputs_cover_embedded_migrations_contracts_and_both_apps(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            fixtures = {name: "fixture" for name in ["Cargo.toml", "Cargo.lock", "LICENSE", "package-lock.json",
                        "tools/build-control-artifacts.py", "tools/build-nas-artifacts.py", "deploy/control/Dockerfile", "deploy/dev/config.json",
                        "server/go.mod", "server/go.sum", "server/internal/storage/migrations/001.sql",
                        "contracts/tools/catalog.json", "packages/protocol/companion.mjs", "packages/control-ui/src/workspace/App.tsx",
                        "apps/console/src/App.tsx", "apps/admin/src/App.tsx", "packages/cli/package.json"]}
            fixtures["package.json"] = json.dumps({"workspaces": ["packages/cli"]})
            for name, value in fixtures.items():
                path = directory / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(value)
            with patch.object(control, "ROOT", directory):
                original = control.source_inputs()
                self.assertTrue(fixtures.keys() <= original.keys())
                for name in ["server/internal/storage/migrations/001.sql", "packages/protocol/companion.mjs", "apps/admin/src/App.tsx"]:
                    path = directory / name
                    path.write_text(fixtures[name] + " changed")
                    self.assertNotEqual(control.source_inputs(), original)
                    path.write_text(fixtures[name])

    def test_runtime_source_and_toolchain_changes_fail_closed(self):
        source = (ROOT / "deploy/control/Dockerfile").read_text()
        result = control.runtime_dockerfile(source)
        self.assertNotIn("--from=", result)
        for line in source.split("FROM debian:bookworm-slim AS runtime\n")[1].splitlines():
            if not line.startswith("COPY --from="):
                self.assertIn(line, result)
        for changed in [source.replace("golang:1.26.10", "golang:latest"),
                        source.replace("rust:1.93.1", "rust:latest"),
                        source.replace("/output/ /usr/local/bin/", "/different/ /usr/local/bin/"),
                        source.replace("bookworm-slim AS runtime", "trixie-slim AS runtime"),
                        source + "\nCOPY --from=unknown /binary /binary\n"]:
            with self.assertRaises(ValueError):
                control.runtime_dockerfile(changed)

    def bundle(self, directory):
        (directory / "bin").mkdir()
        for binary in (*control.GO_BINARIES, control.VALIDATOR):
            path = directory / "bin" / binary
            path.write_bytes(static_elf("linux/arm64") if binary in control.GO_BINARIES else elf("linux/arm64"))
            path.chmod(0o755)
        for app in ["console", "admin"]:
            path = directory / "web" / app / "index.html"
            path.parent.mkdir(parents=True)
            path.write_text("explicit fixture")
        (directory / "deploy/control").mkdir(parents=True)
        source = (ROOT / "deploy/control/Dockerfile").read_text()
        (directory / "deploy/control/Dockerfile").write_text(source)
        (directory / "Dockerfile").write_text(control.runtime_dockerfile(source))
        (directory / "LICENSE").write_text("explicit fixture")
        inputs = {name: nas.digest(directory / name) for name in control.RUNTIME_SOURCES}
        manifest = {"schema": "limeiot.control-artifacts", "version": 1, "platform": "linux/arm64",
                    "source_files": inputs, "source_digest": nas.canonical_digest(inputs), "files": nas.tree_files(directory)}
        (directory / "build.json").write_text(json.dumps(manifest))
        return manifest

    def test_tampered_extra_missing_and_symlink_artifacts_fail(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            original = self.bundle(directory)
            self.assertEqual(control.verify(directory), original)
            page = directory / "web/console/index.html"
            page.write_text("tampered")
            with self.assertRaisesRegex(ValueError, "artifact_files_changed"):
                control.verify(directory)
            page.write_text("explicit fixture")
            extra = directory / "web/admin/build.json"
            extra.write_text("unexpected")
            with self.assertRaisesRegex(ValueError, "artifact_files_changed"):
                control.verify(directory)
            extra.unlink()
            page.unlink()
            with self.assertRaisesRegex(ValueError, "artifact_files_changed"):
                control.verify(directory)
            page.symlink_to(directory / "LICENSE")
            with self.assertRaisesRegex(ValueError, "artifact_symlink_not_supported"):
                control.verify(directory)

    def test_rehash_does_not_bypass_elf_runtime_or_packaged_source_checks(self):
        for name, data, error in [("bin/limeiot-control", elf("linux/arm64"), "elf_interpreter_mismatch"),
                                  ("bin/limeiot-model-validator", elf("linux/amd64"), "elf_architecture_mismatch"),
                                  ("Dockerfile", b"FROM untrusted\n", "runtime_dockerfile_mismatch"),
                                  ("LICENSE", b"changed", "packaged_source_mismatch")]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                directory = Path(temporary)
                manifest = self.bundle(directory)
                (directory / name).write_bytes(data)
                manifest["files"] = nas.tree_files(directory)
                (directory / "build.json").write_text(json.dumps(manifest))
                with self.assertRaisesRegex(ValueError, error):
                    control.verify(directory)

    def test_cached_runtime_cannot_reuse_nas_dependency_prefix(self):
        source = control.runtime_dockerfile((ROOT / "deploy/control/Dockerfile").read_text())
        marker = "COPY bin/limeiot-control bin/limeiot-migrate /usr/local/bin/"
        prefix = source.split(marker)[0]
        identity = "sha256:" + "a" * 64
        base = {"Id": identity, "Os": "linux", "Architecture": "arm64", "Config": {
            "WorkingDir": "/opt/limeiot", "Labels": {"run.limeiot.runtime-prefix-digest": nas.hashlib.sha256(prefix.encode()).hexdigest()}}}
        self.assertTrue(nas.cached_runtime_dockerfile(source, "linux/arm64", base, marker=marker).startswith(f"FROM {identity}"))
        nas_prefix = nas.runtime_dockerfile((ROOT / "deploy/nas/Dockerfile").read_text()).split("COPY bin/limeiot-gateway")[0]
        base["Config"]["Labels"]["run.limeiot.runtime-prefix-digest"] = nas.hashlib.sha256(nas_prefix.encode()).hexdigest()
        with self.assertRaisesRegex(ValueError, "runtime_base_prefix_mismatch"):
            nas.cached_runtime_dockerfile(source, "linux/arm64", base, marker=marker)


if __name__ == "__main__":
    unittest.main()
