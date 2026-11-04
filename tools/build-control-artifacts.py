"""交叉构建私有控制面制品，核对源码和Linux架构后组装本地验证镜像。"""
import argparse
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("nas_artifacts", ROOT / "tools/build-nas-artifacts.py")
nas = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(nas)
GO = "1.26.10"
GO_BINARIES = ("limeiot-control", "limeiot-migrate")
VALIDATOR = "limeiot-model-validator"
RUNTIME_SOURCES = {"LICENSE", "deploy/control/Dockerfile"}


def source_inputs():
    files = {"Cargo.toml", "Cargo.lock", "package.json", "package-lock.json", "LICENSE",
             "tools/build-control-artifacts.py", "tools/build-nas-artifacts.py", "deploy/control/Dockerfile", "deploy/dev/config.json"}
    for workspace in json.loads((ROOT / "package.json").read_text())["workspaces"]:
        files.add(workspace + "/package.json")
    for name in ["server", "gateway", "tools/simulator", "tools/model-validator", "contracts",
                 "apps/console", "apps/admin", "packages/control-ui", "packages/protocol"]:
        for path in (ROOT / name).rglob("*"):
            relative = path.relative_to(ROOT)
            if any(part in {"node_modules", "dist", "target", "build", "__pycache__", ".git", ".dev"} for part in relative.parts):
                continue
            if path.is_file() and path.suffix != ".md":
                nas.require(not path.is_symlink(), "source_symlink_not_supported")
                files.add(relative.as_posix())
    return {name: nas.digest(ROOT / name) for name in sorted(files)}


def runtime_dockerfile(source):
    nas.require(source.count(f"FROM golang:{GO}-bookworm AS api\n") == 1, "control_go_toolchain_changed")
    nas.require(source.count(f"FROM rust:{nas.RUST}-bookworm AS validator\n") == 1, "control_rust_toolchain_changed")
    marker = "FROM debian:bookworm-slim AS runtime\n"
    nas.require(source.count(marker) == 1, "control_runtime_stage_changed")
    result = marker + source.split(marker)[1]
    copies = {
        "COPY --from=api /output/ /usr/local/bin/": "COPY bin/limeiot-control bin/limeiot-migrate /usr/local/bin/",
        "COPY --from=validator /source/target/release/limeiot-model-validator /usr/local/bin/limeiot-model-validator":
            "COPY bin/limeiot-model-validator /usr/local/bin/limeiot-model-validator",
        "COPY --from=web /source/apps/console/dist web/console": "COPY web/console web/console",
        "COPY --from=web /source/apps/admin/dist web/admin": "COPY web/admin web/admin",
    }
    for original, replacement in copies.items():
        nas.require(result.count(original) == 1, "control_runtime_copy_changed")
        result = result.replace(original, replacement)
    nas.require("--from=" not in result and len(re.findall(r"^FROM ", result, re.MULTILINE)) == 1, "unsupported_runtime_stage")
    return result


def verify(directory):
    manifest = json.loads((directory / "build.json").read_text())
    nas.require(manifest.get("schema") == "limeiot.control-artifacts" and manifest.get("version") == 1, "unsupported_control_artifacts")
    target = manifest.get("platform")
    nas.require(target in nas.TARGETS, "unsupported_control_platform")
    nas.require(manifest["source_digest"] == nas.canonical_digest(manifest["source_files"]), "source_manifest_digest_mismatch")
    nas.require(manifest["files"] == nas.tree_files(directory), "artifact_files_changed")
    nas.require(RUNTIME_SOURCES <= manifest["files"].keys() and RUNTIME_SOURCES <= manifest["source_files"].keys(), "runtime_sources_missing")
    for name in RUNTIME_SOURCES:
        nas.require(manifest["files"][name] == manifest["source_files"][name], "packaged_source_mismatch")
    for binary in (*GO_BINARIES, VALIDATOR):
        path = directory / "bin" / binary
        nas.require(path.stat().st_mode & 0o111, "artifact_not_executable")
        nas.check_elf(path, target, static=binary in GO_BINARIES)
    for app in ["console", "admin"]:
        nas.require((directory / "web" / app / "index.html").is_file(), "control_web_artifacts_missing")
    nas.require((directory / "Dockerfile").read_text() == runtime_dockerfile((directory / "deploy/control/Dockerfile").read_text()), "runtime_dockerfile_mismatch")
    return manifest


def build(target, output, cache, jobs, rust_artifacts=None):
    inputs = source_inputs()
    source_digest = nas.canonical_digest(inputs)
    output = output or ROOT / ".dev/control-artifacts" / (target.replace("/", "-") + "-" + source_digest[:16])
    if output.exists():
        manifest = verify(output)
        nas.require(manifest["platform"] == target and manifest["source_files"] == inputs, "existing_artifact_source_mismatch")
        return output
    source = (ROOT / "deploy/control/Dockerfile").read_text()
    dockerfile = runtime_dockerfile(source)
    go_env = {**os.environ, "GOTOOLCHAIN": "go" + GO, "GOOS": "linux", "GOARCH": target.split("/")[1], "CGO_ENABLED": "0"}
    version = subprocess.check_output(["go", "env", "GOVERSION"], cwd=ROOT / "server", env=go_env, text=True).strip()
    nas.require(version == "go" + GO, "go_version_mismatch")
    node = subprocess.check_output(["node", "--version"], text=True).strip()
    nas.require(node.startswith("v24.") and tuple(map(int, node[1:].split("."))) >= (24, 21, 0), "node24_21_required")
    triple = nas.TARGETS[target][0]
    reused = nas.reused_rust(rust_artifacts, target, inputs) if rust_artifacts else None
    if reused:
        toolchain = reused["toolchain"]
        validator = rust_artifacts / "bin" / VALIDATOR
    else:
        environment, toolchain = nas.prepare_toolchain(cache, target, jobs)
        nas.run(["cargo", "build", "--locked", "--release", "-p", VALIDATOR, "--target", triple], env=environment)
        validator = cache / "target" / triple / "release" / VALIDATOR
    nas.check_elf(validator, target)
    temporary = ROOT / ".dev"
    temporary.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="control-build-", dir=temporary) as staging:
        for binary, command in zip(GO_BINARIES, ["api", "migrate"]):
            destination = Path(staging) / binary
            args = ["go", "build", "-p", str(jobs), "-mod=readonly", "-buildvcs=false", "-tags=nomsgpack", "-trimpath", "-o", str(destination), "./cmd/" + command]
            print("执行", " ".join(args), flush=True)
            subprocess.run(args, cwd=ROOT / "server", env=go_env, check=True)
            nas.check_elf(destination, target, static=True)
        nas.run(["npm", "run", "build:control"])
        nas.require(source_inputs() == inputs, "source_changed_during_build")
        output.mkdir(parents=True)
        (output / "bin").mkdir()
        for binary in GO_BINARIES:
            shutil.copy2(Path(staging) / binary, output / "bin" / binary)
        shutil.copy2(validator, output / "bin" / VALIDATOR)
    for app in ["console", "admin"]:
        shutil.copytree(ROOT / "apps" / app / "dist", output / "web" / app)
    (output / "deploy/control").mkdir(parents=True)
    shutil.copy2(ROOT / "deploy/control/Dockerfile", output / "deploy/control/Dockerfile")
    shutil.copy2(ROOT / "LICENSE", output / "LICENSE")
    (output / "Dockerfile").write_text(dockerfile)
    nas.require(source_inputs() == inputs, "source_changed_during_packaging")
    manifest = {"schema": "limeiot.control-artifacts", "version": 1, "platform": target,
                "source_digest": source_digest, "source_files": inputs, "toolchain": {**toolchain, "go": version},
                "node": node, "build_jobs": jobs, "files": nas.tree_files(output), "hardware": False, "published": False}
    if reused:
        nas.require(nas.verify(rust_artifacts) == reused and nas.reused_rust(rust_artifacts, target, inputs) == reused, "reused_rust_changed_during_build")
        manifest["rust_reuse"] = {"source_digest": reused["source_digest"], "binary_files": {VALIDATOR: nas.digest(output / "bin" / VALIDATOR)}}
    (output / "build.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    verify(output)
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    create = commands.add_parser("build")
    create.add_argument("--platform", required=True, choices=nas.TARGETS)
    create.add_argument("--output", type=Path)
    create.add_argument("--toolchain-cache", type=Path, default=ROOT / ".dev/nas-cross-toolchain")
    create.add_argument("--jobs", type=int, choices=(1, 2), default=1)
    create.add_argument("--rust-artifacts", type=Path, help="复用已验证同平台NAS中的validator，必须通过Rust源码和include依赖校验")
    for name in ["verify", "image"]:
        command = commands.add_parser(name)
        command.add_argument("--directory", type=Path, required=True)
        if name == "image":
            command.add_argument("--tag", required=True)
            command.add_argument("--runtime-base", help="已核验的同平台本地运行依赖镜像，仅接受limeiot/verification标签")
    args = parser.parse_args()
    if args.command == "build":
        cache = args.toolchain_cache.resolve()
        cache.mkdir(parents=True, exist_ok=True)
        with (cache / "build.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            directory = build(args.platform, args.output.resolve() if args.output else None, cache, args.jobs, args.rust_artifacts.resolve() if args.rust_artifacts else None)
    else:
        directory = args.directory.resolve()
    manifest = verify(directory)
    if args.command == "image":
        nas.require(re.fullmatch(r"limeiot/verification:[A-Za-z0-9_.-]+", args.tag), "local_verification_image_required")
        source = (directory / "Dockerfile").read_text()
        base = None
        if args.runtime_base:
            nas.require(re.fullmatch(r"limeiot/verification:[A-Za-z0-9_.-]+", args.runtime_base), "local_runtime_base_required")
            inspected = json.loads(subprocess.check_output(["docker", "image", "inspect", args.runtime_base], text=True))
            nas.require(isinstance(inspected, list) and len(inspected) == 1, "runtime_base_inspection_invalid")
            base = inspected[0]
            source = nas.cached_runtime_dockerfile(source, manifest["platform"], base, marker="COPY bin/limeiot-control bin/limeiot-migrate /usr/local/bin/")
        temporary = ROOT / ".dev"
        temporary.mkdir(exist_ok=True)
        with tempfile.NamedTemporaryFile(mode="w", suffix=".Dockerfile", dir=temporary) as dockerfile:
            dockerfile.write(source)
            dockerfile.flush()
            labels = ["--label", "run.limeiot.runtime-base-id=" + base["Id"]] if base else []
            nas.run(["docker", "build", "--platform", manifest["platform"], "--pull=false", "--memory", "96m", "--memory-swap", "96m", "--tag", args.tag,
                     "--label", "run.limeiot.source-digest=" + manifest["source_digest"], *labels,
                     "--file", dockerfile.name, directory], env={**os.environ, "DOCKER_BUILDKIT": "0"})
        nas.require(verify(directory) == manifest, "artifacts_changed_during_image_build")
    print(json.dumps({"verified": True, "directory": str(directory), "platform": manifest["platform"],
                      "source_digest": manifest["source_digest"], "hardware": False, "published": False}), flush=True)


if __name__ == "__main__":
    main()
