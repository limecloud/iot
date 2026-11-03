"""NAS制品门禁：架构、运行层来源、完整性与额外文件拒绝；ELF为明确字节夹具。"""
import importlib.util
import json
from pathlib import Path
import struct
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("nas_artifacts", ROOT / "tools/build-nas-artifacts.py")
nas = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(nas)


def elf(target):
    data = bytearray(256)
    data[:7] = b"\x7fELF\x02\x01\x01"
    struct.pack_into("<HH", data, 16, 3, nas.TARGETS[target][2])
    struct.pack_into("<Q", data, 32, 64)
    struct.pack_into("<HH", data, 54, 56, 1)
    interpreter = nas.TARGETS[target][3].encode() + b"\0"
    struct.pack_into("<IIQQQQQQ", data, 64, 3, 4, 128, 0, 0, len(interpreter), len(interpreter), 1)
    data[128:128 + len(interpreter)] = interpreter
    return bytes(data)


class NasArtifactTests(unittest.TestCase):
    def test_linux_architecture_interpreter_and_truncation(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "binary"
            for target in nas.TARGETS:
                path.write_bytes(elf(target))
                nas.check_elf(path, target)
            for data, target, error in [
                (b"\xcf\xfa\xed\xfe" + bytes(252), "linux/arm64", "not_linux_elf64"),
                (elf("linux/amd64"), "linux/arm64", "elf_architecture_mismatch"),
                (elf("linux/arm64").replace(b"/lib/ld-linux", b"/tmp/ld-linux"), "linux/arm64", "elf_interpreter_mismatch"),
                (elf("linux/arm64")[:70], "linux/arm64", "invalid_elf_program_headers"),
            ]:
                path.write_bytes(data)
                with self.assertRaisesRegex(ValueError, error):
                    nas.check_elf(path, target)

    def test_runtime_comes_from_canonical_dockerfile(self):
        source = (ROOT / "deploy/nas/Dockerfile").read_text()
        result = nas.runtime_dockerfile(source)
        self.assertNotIn("cargo build", result)
        self.assertNotIn("--from=", result)
        for line in source.split("FROM debian:bookworm-slim AS runtime\n")[1].splitlines():
            if not line.startswith("COPY --from="):
                self.assertIn(line, result)
        for changed in [source.replace("bookworm-slim AS runtime", "trixie-slim AS runtime"),
                        source + "\nCOPY --from=other /binary /binary\n",
                        source.replace("COPY --from=gateway /source/target/release/limeiot-ota", "COPY --from=gateway /different/limeiot-ota")]:
            with self.assertRaises(ValueError):
                nas.runtime_dockerfile(changed)

    def bundle(self, directory):
        target = "linux/arm64"
        (directory / "bin").mkdir()
        for name in nas.BINARIES:
            binary = directory / "bin" / name
            binary.write_bytes(elf(target))
            binary.chmod(0o755)
        (directory / "home").mkdir()
        (directory / "home/index.html").write_text("<title>NAS fixture</title>")
        (directory / "deploy/nas").mkdir(parents=True)
        source = (ROOT / "deploy/nas/Dockerfile").read_text()
        (directory / "deploy/nas/Dockerfile").write_text(source)
        (directory / "Dockerfile").write_text(nas.runtime_dockerfile(source))
        inputs = {}
        for name in nas.RUNTIME_SOURCES:
            path = directory / name
            path.parent.mkdir(parents=True, exist_ok=True)
            if not path.exists():
                path.write_text("explicit fixture for " + name)
            inputs[name] = nas.digest(path)
        manifest = {"schema": "limeiot.nas-artifacts", "version": 1, "platform": target,
                    "source_files": inputs, "source_digest": nas.canonical_digest(inputs), "files": nas.tree_files(directory)}
        (directory / "build.json").write_text(json.dumps(manifest))
        return manifest

    def test_changed_missing_extra_and_nested_manifest_files_fail(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            original = self.bundle(directory)
            self.assertEqual(nas.verify(directory), original)
            page = directory / "home/index.html"
            content = page.read_text()
            page.write_text("changed")
            with self.assertRaisesRegex(ValueError, "artifact_files_changed"):
                nas.verify(directory)
            page.write_text(content)
            extra = directory / "home/build.json"
            extra.write_text("unexpected nested file")
            with self.assertRaisesRegex(ValueError, "artifact_files_changed"):
                nas.verify(directory)
            extra.unlink()
            page.unlink()
            with self.assertRaisesRegex(ValueError, "artifact_files_changed"):
                nas.verify(directory)

    def test_matching_hash_does_not_bypass_architecture_or_runtime_checks(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            manifest = self.bundle(directory)
            binary = directory / "bin/limeiot-gateway"
            binary.write_bytes(elf("linux/amd64"))
            manifest["files"] = nas.tree_files(directory)
            (directory / "build.json").write_text(json.dumps(manifest))
            with self.assertRaisesRegex(ValueError, "elf_architecture_mismatch"):
                nas.verify(directory)
            binary.write_bytes(elf("linux/arm64"))
            (directory / "Dockerfile").write_text("FROM attacker\n")
            manifest["files"] = nas.tree_files(directory)
            (directory / "build.json").write_text(json.dumps(manifest))
            with self.assertRaisesRegex(ValueError, "runtime_dockerfile_mismatch"):
                nas.verify(directory)
            link = directory / "home/link"
            link.symlink_to(binary)
            with self.assertRaisesRegex(ValueError, "artifact_symlink_not_supported"):
                nas.verify(directory)

    def test_rehashed_runtime_copy_must_still_match_declared_sources(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            manifest = self.bundle(directory)
            (directory / "deploy/nas/entrypoint.py").write_text("changed runtime")
            manifest["files"] = nas.tree_files(directory)
            (directory / "build.json").write_text(json.dumps(manifest))
            with self.assertRaisesRegex(ValueError, "packaged_source_mismatch"):
                nas.verify(directory)


if __name__ == "__main__":
    unittest.main()
