"""在项目内交叉构建Linux NAS制品，校验后用正式Dockerfile的运行层组装本地镜像。"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shlex
import shutil
import struct
import subprocess
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
RUST = "1.93.1"
ZIG = "0.14.1"
ZIG_HASH = "39f3dc5e79c22088ce878edc821dedb4ca5a1cd9f5ef915e9b3cc3053e8faefa"
ZIG_URL = f"https://pkg.hexops.org/zig/zig-aarch64-macos-{ZIG}.tar.xz?source=limeiot"
TARGETS = {
    "linux/arm64": ("aarch64-unknown-linux-gnu", "aarch64-linux-gnu.2.36", 183,
                    "/lib/ld-linux-aarch64.so.1", "56f2cd66ad7167dd6924ff095063ffddfe731812a1909b9200bb0ee21982fc47"),
    "linux/amd64": ("x86_64-unknown-linux-gnu", "x86_64-linux-gnu.2.36", 62,
                    "/lib64/ld-linux-x86-64.so.2", "82c4e41268f1741e4eb68796aeb6ca5042406ae858dd56144155c4ef8d87d8b6"),
}
BINARIES = ("limeiot-gateway", "limeiot-simulator", "limeiot-model-validator", "limeiot-ota")
RUNTIME_SOURCES = {"LICENSE", "deploy/nas/Dockerfile", "deploy/nas/entrypoint.py",
                   "deploy/nas/healthcheck.py", "deploy/nas/device_identity.py",
                   "contracts/models/lamp.json", "contracts/models/button.json"}


def require(condition, code):
    if not condition:
        raise ValueError(code)


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def canonical_digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def run(args, **kwargs):
    print("执行", shlex.join(map(str, args)), flush=True)
    subprocess.run(list(map(str, args)), cwd=ROOT, check=True, **kwargs)


def download(url, destination, expected):
    if destination.exists():
        require(digest(destination) == expected, "cached_toolchain_checksum_mismatch")
        return
    pending = destination.with_name(destination.name + ".download")
    print("下载并校验", url, flush=True)
    with urllib.request.urlopen(url, timeout=60) as response, pending.open("wb") as stream:
        shutil.copyfileobj(response, stream)
    require(digest(pending) == expected, "download_checksum_mismatch")
    pending.replace(destination)


def prepare_toolchain(cache, target):
    require(platform.system() == "Darwin" and platform.machine() == "arm64", "cross_builder_requires_macos_arm64")
    version = subprocess.check_output(["rustc", "--version"], text=True).split()[1]
    require(version == RUST, "rust_version_mismatch")
    cache.mkdir(parents=True, exist_ok=True)
    archive = cache / f"zig-aarch64-macos-{ZIG}.tar.xz"
    # 镜像来自Zig官方community-mirrors清单，固定摘要来自官方发布索引。
    download(ZIG_URL, archive, ZIG_HASH)
    zig = cache / f"zig-aarch64-macos-{ZIG}" / "zig"
    if not zig.is_file():
        with tarfile.open(archive) as source:
            source.extractall(cache, filter="data")
    require(subprocess.check_output([zig, "version"], text=True).strip() == ZIG, "zig_version_mismatch")
    triple, zig_target, _, _, std_hash = TARGETS[target]
    name = f"rust-std-{RUST}-{triple}"
    std = cache / (name + ".tar.xz")
    url = f"https://static.rust-lang.org/dist/2026-02-12/{name}.tar.xz"
    download(url, std, std_hash)
    sysroot = cache / f"rust-{RUST}"
    destination = sysroot / "lib/rustlib" / triple
    if not destination.is_dir():
        unpacked = cache / "rust-package"
        with tarfile.open(std) as source:
            source.extractall(unpacked, filter="data")
        shutil.copytree(unpacked / name / ("rust-std-" + triple) / "lib/rustlib" / triple, destination)
    wrappers = cache / triple
    wrappers.mkdir(exist_ok=True)
    for name, command in [("cc", f"cc -target {zig_target}"), ("ar", "ar")]:
        file = wrappers / name
        file.write_text(f"#!/bin/sh\nexec {shlex.quote(str(zig))} {command} \"$@\"\n")
        file.chmod(0o755)
    environment = os.environ.copy()
    environment.update({
        "CARGO_TARGET_DIR": str(cache / "target"), "CARGO_BUILD_JOBS": "1",
        "CARGO_ENCODED_RUSTFLAGS": "--sysroot\x1f" + str(sysroot),
        "CARGO_TARGET_" + triple.upper().replace("-", "_") + "_LINKER": str(wrappers / "cc"),
        "CC_" + triple.replace("-", "_"): str(wrappers / "cc"),
        "AR_" + triple.replace("-", "_"): str(wrappers / "ar"),
        "ZIG_GLOBAL_CACHE_DIR": str(cache / "zig-cache"),
        "ZIG_LOCAL_CACHE_DIR": str(cache / "zig-local-cache"),
    })
    return environment, {"rust": RUST, "zig": ZIG, "zig_archive_sha256": ZIG_HASH,
                         "rust_std_sha256": std_hash, "rust_target": triple, "c_target": zig_target}


def source_inputs():
    files = {"Cargo.toml", "Cargo.lock", "package.json", "package-lock.json", "LICENSE", "deploy/dev/config.json", "tools/build-nas-artifacts.py"}
    for name in ["gateway", "tools/simulator", "tools/model-validator", "contracts/models", "deploy/nas", "apps/home", "packages/control-ui", "packages/protocol"]:
        for path in (ROOT / name).rglob("*"):
            relative = path.relative_to(ROOT)
            if any(part in {"node_modules", "dist", "target", "build", "__pycache__", ".git"} for part in relative.parts):
                continue
            if path.is_file() and path.suffix != ".md":
                require(not path.is_symlink(), "source_symlink_not_supported")
                files.add(relative.as_posix())
    return {name: digest(ROOT / name) for name in sorted(files)}


def check_elf(path, target):
    data = Path(path).read_bytes()
    _, _, machine, interpreter, _ = TARGETS[target]
    require(len(data) >= 64 and data[:7] == b"\x7fELF\x02\x01\x01", "not_linux_elf64")
    require(struct.unpack_from("<H", data, 16)[0] in (2, 3), "not_elf_executable")
    require(struct.unpack_from("<H", data, 18)[0] == machine, "elf_architecture_mismatch")
    offset = struct.unpack_from("<Q", data, 32)[0]
    size, count = struct.unpack_from("<HH", data, 54)
    require(size >= 56 and 0 < count <= 128 and offset + size * count <= len(data), "invalid_elf_program_headers")
    interpreters = []
    for index in range(count):
        header = offset + index * size
        if struct.unpack_from("<I", data, header)[0] == 3:
            start = struct.unpack_from("<Q", data, header + 8)[0]
            length = struct.unpack_from("<Q", data, header + 32)[0]
            require(1 < length <= 128 and start + length <= len(data), "invalid_elf_interpreter")
            interpreters.append(data[start:start + length])
    require(interpreters == [interpreter.encode() + b"\0"], "elf_interpreter_mismatch")


def runtime_dockerfile(source):
    marker = "FROM debian:bookworm-slim AS runtime\n"
    require(source.count(marker) == 1, "nas_runtime_stage_changed")
    result = marker + source.split(marker)[1]
    for binary in BINARIES:
        original = f"COPY --from=gateway /source/target/release/{binary} /usr/local/bin/{binary}"
        require(result.count(original) == 1, "nas_binary_copy_changed")
        result = result.replace(original, f"COPY bin/{binary} /usr/local/bin/{binary}")
    original = "COPY --from=home /source/apps/home/dist home"
    require(result.count(original) == 1, "nas_home_copy_changed")
    result = result.replace(original, "COPY home home")
    require("--from=" not in result and len(re.findall(r"^FROM ", result, re.MULTILINE)) == 1, "unsupported_runtime_stage")
    return result


def tree_files(directory):
    files = {}
    for path in sorted(directory.rglob("*")):
        require(not path.is_symlink(), "artifact_symlink_not_supported")
        if path.is_file() and path != directory / "build.json":
            files[path.relative_to(directory).as_posix()] = digest(path)
    return files


def verify(directory):
    manifest = json.loads((directory / "build.json").read_text())
    require(manifest.get("schema") == "limeiot.nas-artifacts" and manifest.get("version") == 1, "unsupported_nas_artifacts")
    target = manifest.get("platform")
    require(target in TARGETS, "unsupported_nas_platform")
    require(manifest["source_digest"] == canonical_digest(manifest["source_files"]), "source_manifest_digest_mismatch")
    require(manifest["files"] == tree_files(directory), "artifact_files_changed")
    require(RUNTIME_SOURCES <= manifest["files"].keys(), "runtime_sources_missing")
    for name in manifest["source_files"]:
        if name in RUNTIME_SOURCES or name.startswith("contracts/models/"):
            require(manifest["files"].get(name) == manifest["source_files"][name], "packaged_source_mismatch")
    require(RUNTIME_SOURCES <= manifest["source_files"].keys(), "runtime_source_manifest_missing")
    for binary in BINARIES:
        path = directory / "bin" / binary
        require(path.stat().st_mode & 0o111, "artifact_not_executable")
        check_elf(path, target)
    require((directory / "home/index.html").is_file(), "home_artifacts_missing")
    source = (directory / "deploy/nas/Dockerfile").read_text()
    require((directory / "Dockerfile").read_text() == runtime_dockerfile(source), "runtime_dockerfile_mismatch")
    return manifest


def build(target, output, cache):
    inputs = source_inputs()
    source_digest = canonical_digest(inputs)
    output = output or ROOT / ".dev/nas-artifacts" / (target.replace("/", "-") + "-" + source_digest[:16])
    if output.exists():
        manifest = verify(output)
        require(manifest["platform"] == target and manifest["source_files"] == inputs, "existing_artifact_source_mismatch")
        return output
    environment, toolchain = prepare_toolchain(cache, target)
    triple = TARGETS[target][0]
    run(["cargo", "build", "--locked", "--release", "--workspace", "--target", triple], env=environment)
    for binary in BINARIES:
        check_elf(cache / "target" / triple / "release" / binary, target)
    node = subprocess.check_output(["node", "--version"], text=True).strip()
    require(node.startswith("v24.") and tuple(map(int, node[1:].split("."))) >= (24, 21, 0), "node24_21_required")
    run(["npm", "run", "build:home"])
    require(source_inputs() == inputs, "source_changed_during_build")
    output.mkdir(parents=True)
    (output / "bin").mkdir()
    for binary in BINARIES:
        shutil.copy2(cache / "target" / triple / "release" / binary, output / "bin" / binary)
    shutil.copytree(ROOT / "apps/home/dist", output / "home")
    shutil.copytree(ROOT / "contracts/models", output / "contracts/models")
    (output / "deploy/nas").mkdir(parents=True)
    for name in ["Dockerfile", "entrypoint.py", "healthcheck.py", "device_identity.py"]:
        shutil.copy2(ROOT / "deploy/nas" / name, output / "deploy/nas" / name)
    shutil.copy2(ROOT / "LICENSE", output / "LICENSE")
    (output / "Dockerfile").write_text(runtime_dockerfile((ROOT / "deploy/nas/Dockerfile").read_text()))
    require(source_inputs() == inputs, "source_changed_during_packaging")
    manifest = {"schema": "limeiot.nas-artifacts", "version": 1, "platform": target,
                "source_digest": source_digest, "source_files": inputs, "toolchain": toolchain,
                "node": node, "files": tree_files(output), "hardware": False, "published": False}
    (output / "build.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    verify(output)
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    create = commands.add_parser("build")
    create.add_argument("--platform", required=True, choices=TARGETS)
    create.add_argument("--output", type=Path)
    create.add_argument("--toolchain-cache", type=Path, default=ROOT / ".dev/nas-cross-toolchain")
    for name in ["verify", "image"]:
        command = commands.add_parser(name)
        command.add_argument("--directory", type=Path, required=True)
        if name == "image":
            command.add_argument("--tag", required=True)
    args = parser.parse_args()
    if args.command == "build":
        import fcntl
        cache = args.toolchain_cache.resolve()
        cache.mkdir(parents=True, exist_ok=True)
        with (cache / "build.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            directory = build(args.platform, args.output.resolve() if args.output else None, cache)
    else:
        directory = args.directory.resolve()
    manifest = verify(directory)
    if args.command == "image":
        require(re.fullmatch(r"limeiot/verification:[A-Za-z0-9_.-]+", args.tag), "local_verification_image_required")
        run(["docker", "build", "--platform", manifest["platform"], "--pull=false", "--memory", "96m", "--memory-swap", "96m", "--tag", args.tag,
             "--label", "run.limeiot.source-digest=" + manifest["source_digest"],
             "--file", directory / "Dockerfile", directory], env={**os.environ, "DOCKER_BUILDKIT": "0"})
        require(verify(directory) == manifest, "artifacts_changed_during_image_build")
    print(json.dumps({"verified": True, "directory": str(directory), "platform": manifest["platform"],
                      "source_digest": manifest["source_digest"], "hardware": False, "published": False}), flush=True)


if __name__ == "__main__":
    main()
