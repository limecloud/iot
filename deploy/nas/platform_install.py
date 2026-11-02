"""完整本地工作台的独立凭据、数据库备份和恢复。"""
import json
import hashlib
import os
from pathlib import Path
import secrets
import shutil
import subprocess


def configure(directory, save):
    private = directory / "platform-secrets"
    private.mkdir(mode=0o700)
    (directory / "mysql").mkdir(mode=0o700)
    for name in ("control-key", "admin-token", "mysql-root-password"):
        save(private / name, secrets.token_hex(32) + "\n")
    passwords = {name: secrets.token_hex(32) for name in ("runtime", "migrator", "readonly")}
    statements = []
    for name, password in passwords.items():
        user = f"limeiot_{name}"
        grants = {"runtime": "SELECT, INSERT, UPDATE, DELETE", "migrator": "SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES", "readonly": "SELECT, SHOW VIEW, TRIGGER"}[name]
        statements.extend([f"CREATE USER '{user}'@'%' IDENTIFIED BY '{password}';", f"GRANT {grants} ON limeiot.* TO '{user}'@'%';"])
        if name != "readonly":
            save(private / f"mysql-{name}.dsn", f"{user}:{password}@tcp(control-mysql:3306)/limeiot?charset=utf8mb4\n")
        if name != "runtime":
            save(private / f"mysql-{name}.cnf", f"[client]\nuser={user}\npassword={password}\nhost=127.0.0.1\nprotocol=tcp\n")
    save(private / "mysql-init.sql", "\n".join(statements) + "\n")
    key = subprocess.run(["openssl", "genpkey", "-algorithm", "ED25519"], check=True, capture_output=True).stdout.decode()
    save(private / "model-release-key.pem", key)
    shutil.copyfile(directory / "authority/ca.crt", directory / "config/control-ca.crt")


def compose(directory, args, **kwargs):
    root = Path(__file__).resolve().parents[2]
    metadata = json.loads((directory / "installation.json").read_text())
    env = {**os.environ, "LIMEIOT_STATE_DIR": str(directory), "LIMEIOT_PUBLIC_ORIGIN": metadata["origin"], "LIMEIOT_HTTPS_PORT": str(metadata["port"]), "LIMEIOT_UID": str(os.getuid()), "LIMEIOT_GID": str(os.getgid())}
    commands = (["docker", "compose"], ["docker-compose"])
    command = next((candidate for candidate in commands if subprocess.run([*candidate, "version"], capture_output=True).returncode == 0), None)
    if command is None:
        raise ValueError("compose_required")
    # 项目名称与服务选择使用实际安装目录，不触碰其他安装实例。
    result = subprocess.run([*command, "--project-name", "limeiot-" + hashlib.sha256(str(directory).encode()).hexdigest()[:12], "--env-file", str(directory / "compose.env"), "-f", str(root / "deploy/nas/compose.yaml"), "-f", str(root / "deploy/nas/compose.platform.yaml"), *args], env=env, stderr=subprocess.PIPE, **kwargs)
    if result.returncode:
        raise ValueError("platform_compose_operation_failed")
    return result


def require_stopped(directory):
    running = compose(directory, ["--profile", "simulation", "ps", "--status", "running", "--services"], stdout=subprocess.PIPE).stdout.decode().splitlines()
    if set(running) & {"gateway", "control", "lamp", "button", "migrate"}:
        raise ValueError("stop_platform_writers_before_backup_or_restore")


def backup_control(directory, output):
    require_stopped(directory)
    private = directory / "platform-secrets"
    shutil.copytree(private, output / "platform-secrets")
    with (output / "control.sql").open("xb") as dump:
        compose(directory, ["exec", "-T", "control-mysql", "mysqldump", "--defaults-extra-file=/private/readonly.cnf", "--single-transaction", "--skip-lock-tables", "--skip-add-locks", "--no-tablespaces", "--set-gtid-purged=OFF", "--column-statistics=0", "--skip-add-drop-table", "limeiot"], stdout=dump)


def restore_control(directory):
    metadata = json.loads((directory / "installation.json").read_text())
    if metadata.get("deployment") != "private" or not (directory / "control.sql").is_file():
        raise ValueError("private_control_backup_required")
    require_stopped(directory)
    result = compose(directory, ["exec", "-T", "control-mysql", "mysql", "--defaults-extra-file=/private/migrator.cnf", "-Nse", "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='limeiot'"], stdout=subprocess.PIPE)
    if result.stdout.strip() != b"0":
        raise ValueError("restore_requires_empty_control_database")
    with (directory / "control.sql").open("rb") as dump:
        compose(directory, ["exec", "-T", "control-mysql", "mysql", "--defaults-extra-file=/private/migrator.cnf", "limeiot"], stdin=dump, stdout=subprocess.DEVNULL)
