"""外部P-256公钥请求的离线签发与原结果恢复，不接收或生成设备私钥。"""
import base64
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import stat

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID
from device_identity import available_device, bound_device, ca_config, openssl, save, revoke, refresh_crl

ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}")
SHA = re.compile(r"sha256:[0-9a-f]{64}")
REQUEST_FIELDS = {"schema_version", "request_id", "space_id", "device_id", "serial", "csr_sha256", "public_key_fingerprint", "ca_fingerprint", "request_sha256"}
ROTATION_FIELDS = {"replaces_serial", "replaces_certificate_sha256", "activation_challenge"}
RECOVERY_FIELDS = {"recovery_reason"}


def fingerprint(raw):
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def canonical(value):
    # 本合同所有字段为ASCII字符串或整数版本号，固定键序JSON即其规范字节。
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()


def no_duplicates(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("csr_journal_invalid")
        result[key] = value
    return result


def path_without_links(path):
    path = Path(os.path.abspath(path.expanduser()))
    for parent in (*reversed(path.parents), path):
        if parent.is_symlink():
            raise ValueError("identity_path_symlink_forbidden")
    return path


def read_file(path, maximum=16384, private=False):
    path = path_without_links(path)
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, "rb") as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid() or info.st_size > maximum:
            raise ValueError("identity_file_invalid")
        if private and info.st_mode & 0o077:
            raise ValueError("identity_file_must_be_private")
        raw = source.read(maximum + 1)
        if len(raw) > maximum:
            raise ValueError("identity_file_invalid")
        return raw


def private_directory(path):
    path = path_without_links(path)
    info = path.stat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError("identity_directory_must_be_private")
    return path


def sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def write_new(path, raw):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "wb") as target:
        target.write(raw)
        target.flush()
        os.fsync(target.fileno())
    sync_directory(path.parent)


def new_directory(path):
    path = path_without_links(path)
    path.mkdir(mode=0o700)
    sync_directory(path.parent)
    return path


def subject_is_device(subject, device):
    attributes = list(subject)
    return (len(subject.rdns) == 1 and len(attributes) == 1
            and attributes[0].oid == NameOID.COMMON_NAME and attributes[0].value == device)


def parse_csr(raw, device):
    if not isinstance(device, str) or not ID.fullmatch(device):
        raise ValueError("invalid_device_id")
    match = re.fullmatch(rb"-----BEGIN CERTIFICATE REQUEST-----\r?\n([A-Za-z0-9+/=\r\n]+)-----END CERTIFICATE REQUEST-----[\r\n]*", raw)
    if not match:
        raise ValueError("single_public_csr_required")
    try:
        der = base64.b64decode(b"".join(match[1].split()), validate=True)
        csr = x509.load_der_x509_csr(der)
        if csr.public_bytes(serialization.Encoding.DER) != der or not csr.is_signature_valid:
            raise ValueError("invalid_csr_proof")
        key = csr.public_key()
        if not isinstance(key, ec.EllipticCurvePublicKey) or not isinstance(key.curve, ec.SECP256R1) or not isinstance(csr.signature_hash_algorithm, hashes.SHA256):
            raise ValueError("csr_p256_sha256_required")
        if not subject_is_device(csr.subject, device):
            raise ValueError("csr_device_id_mismatch")
        if csr.extensions or csr.attributes:
            raise ValueError("csr_attributes_or_extensions_forbidden")
        public = key.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
        return csr.public_bytes(serialization.Encoding.PEM), fingerprint(der), fingerprint(public)
    except ValueError as error:
        if str(error) in {"invalid_csr_proof", "csr_p256_sha256_required", "csr_device_id_mismatch", "csr_attributes_or_extensions_forbidden"}:
            raise
        raise ValueError("invalid_csr") from error
    except Exception as error:
        raise ValueError("invalid_csr") from error


def inspect_csr(path, device):
    _, digest, public = parse_csr(read_file(path), device)
    return {"device_id": device, "csr_sha256": digest, "public_key_fingerprint": public, "algorithm": "P-256/SHA-256"}


@contextmanager
def authority_lock(directory):
    directory = private_directory(directory)
    authority = private_directory(directory / "device-authority")
    descriptor = os.open(path_without_links(authority / ".lock"), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "a") as lock:
        info = os.fstat(lock.fileno())
        if info.st_uid != os.getuid() or info.st_nlink != 1 or not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
            raise ValueError("identity_lock_invalid")
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        read_file(authority / "ca.key", private=True)
        read_file(authority / "index.txt", maximum=4 * 1024 * 1024, private=True)
        read_file(directory / "config/gateway.json", maximum=4 * 1024 * 1024, private=True)
        yield authority


def ca_certificate(authority):
    raw = read_file(authority / "ca.crt", private=True)
    try:
        certificate = x509.load_pem_x509_certificate(raw)
        if not certificate.extensions.get_extension_for_class(x509.BasicConstraints).value.ca:
            raise ValueError("device_ca_invalid")
    except (ValueError, x509.ExtensionNotFound, x509.DuplicateExtension) as error:
        raise ValueError("device_ca_invalid") from error
    return raw, certificate, fingerprint(certificate.public_bytes(serialization.Encoding.DER))


def load_request(authority, request_id):
    if not isinstance(request_id, str) or not ID.fullmatch(request_id):
        raise ValueError("invalid_request_id")
    operation = private_directory(authority / "csr-operations" / request_id)
    request = json.loads(read_file(operation / "request.json", private=True), object_pairs_hook=no_duplicates)
    if not isinstance(request, dict) or type(request.get("schema_version")) is not int or request["schema_version"] not in (1, 2, 3):
        raise ValueError("csr_journal_invalid")
    version = request["schema_version"]
    if set(request) != REQUEST_FIELDS | (ROTATION_FIELDS if version >= 2 else set()) | (RECOVERY_FIELDS if version == 3 else set()):
        raise ValueError("csr_journal_invalid")
    if version == 3 and request["recovery_reason"] != "certificate_expired":
        raise ValueError("csr_journal_invalid")
    if request["request_id"] != request_id or any(not isinstance(request[key], str) or not ID.fullmatch(request[key]) for key in ("request_id", "space_id", "device_id")):
        raise ValueError("csr_journal_invalid")
    if not isinstance(request["serial"], str) or not re.fullmatch(r"[0-9A-F]{1,40}", request["serial"]) or int(request["serial"], 16) <= 0:
        raise ValueError("csr_journal_invalid")
    if any(not isinstance(request[key], str) or not SHA.fullmatch(request[key]) for key in ("csr_sha256", "public_key_fingerprint", "ca_fingerprint", "request_sha256")):
        raise ValueError("csr_journal_invalid")
    if version >= 2 and (not isinstance(request["replaces_serial"], str) or not re.fullmatch(r"[0-9A-F]{1,40}", request["replaces_serial"])
            or int(request["replaces_serial"], 16) <= 0 or request["replaces_serial"] == request["serial"]
            or not isinstance(request["replaces_certificate_sha256"], str) or not SHA.fullmatch(request["replaces_certificate_sha256"])
            or not isinstance(request["activation_challenge"], str) or not re.fullmatch(r"[0-9a-f]{64}", request["activation_challenge"])):
        raise ValueError("csr_journal_invalid")
    if request["request_sha256"] != fingerprint(canonical({key: value for key, value in request.items() if key != "request_sha256"})):
        raise ValueError("csr_journal_invalid")
    pem, digest, public = parse_csr(read_file(operation / "request.csr", private=True), request["device_id"])
    if digest != request["csr_sha256"] or public != request["public_key_fingerprint"]:
        raise ValueError("csr_journal_invalid")
    return operation, request, pem


def certificate_result(authority, device, serial, expected_public=None, expected_digest=None):
    _, ca, _ = ca_certificate(authority)
    entries = [line.split("\t") for line in read_file(authority / "index.txt", maximum=4 * 1024 * 1024, private=True).decode().splitlines()]
    if any(len(row) != 6 for row in entries):
        raise ValueError("identity_database_invalid")
    matches = [row for row in entries if row[3] == serial]
    if not matches:
        return "unknown", None
    if len(matches) != 1 or matches[0][-1] != "/CN=" + device or matches[0][0] not in ("V", "R", "E"):
        raise ValueError("csr_issuer_record_mismatch")
    path = authority / "issued" / (serial + ".pem")
    if not path.exists():
        return "unknown", None
    raw = read_file(path, private=True)
    try:
        certificate = x509.load_pem_x509_certificate(raw)
        certificate.verify_directly_issued_by(ca)
        public = certificate.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
        constraints = certificate.extensions.get_extension_for_class(x509.BasicConstraints).value
        usage = certificate.extensions.get_extension_for_class(x509.KeyUsage).value
        extended = certificate.extensions.get_extension_for_class(x509.ExtendedKeyUsage).value
        key = certificate.public_key()
        if (certificate.serial_number != int(serial, 16) or not subject_is_device(certificate.subject, device)
                or expected_public is not None and fingerprint(public) != expected_public
                or expected_digest is not None and fingerprint(certificate.public_bytes(serialization.Encoding.DER)) != expected_digest
                or not isinstance(key, ec.EllipticCurvePublicKey) or not isinstance(key.curve, ec.SECP256R1)
                or not isinstance(certificate.signature_hash_algorithm, hashes.SHA256) or constraints.ca or not usage.digital_signature
                or usage.content_commitment or usage.key_encipherment or usage.data_encipherment or usage.key_agreement
                or usage.key_cert_sign or usage.crl_sign or set(extended) != {ExtendedKeyUsageOID.CLIENT_AUTH}):
            raise ValueError("csr_issued_certificate_mismatch")
    except Exception as error:
        raise ValueError("csr_issued_certificate_mismatch") from error
    now = datetime.now(timezone.utc)
    decision = "revoked" if matches[0][0] == "R" else "expired" if matches[0][0] == "E" or now >= min(certificate.not_valid_after_utc, ca.not_valid_after_utc) else "issued"
    if now < max(certificate.not_valid_before_utc, ca.not_valid_before_utc):
        raise ValueError("csr_issued_certificate_not_yet_valid")
    return decision, certificate


def verify_activation(request, certificate, proof):
    if not isinstance(proof, str) or not re.fullmatch(r"[0-9a-f]{16,144}", proof) or len(proof) % 2:
        raise ValueError("rotation_activation_proof_invalid")
    digest = fingerprint(certificate.public_bytes(serialization.Encoding.DER))
    message = "\n".join(("limeiot.device-rotation-activate/v1", request["space_id"], request["device_id"], request["request_id"], digest, request["activation_challenge"]))
    try:
        certificate.public_key().verify(bytes.fromhex(proof), message.encode("ascii"), ec.ECDSA(hashes.SHA256()))
    except Exception as error:
        raise ValueError("rotation_activation_proof_invalid") from error


def original_result(directory, authority, request):
    config = bound_device(directory, request["device_id"])
    if config["space_id"] != request["space_id"]:
        raise ValueError("csr_space_binding_changed")
    ca_raw, _, ca_digest = ca_certificate(authority)
    if ca_digest != request["ca_fingerprint"]:
        raise ValueError("csr_ca_binding_changed")
    decision, certificate = certificate_result(authority, request["device_id"], request["serial"], request["public_key_fingerprint"])
    result = {**request, "decision": decision, "hardware": False, "physical_claim": False}
    if request["schema_version"] >= 2:
        previous, _ = certificate_result(authority, request["device_id"], request["replaces_serial"], expected_digest=request["replaces_certificate_sha256"])
        if previous == "unknown":
            raise ValueError("rotation_previous_certificate_unknown")
        activation = authority / "csr-operations" / request["request_id"] / "activation.json"
        confirmed = activation.exists()
        if confirmed:
            record = json.loads(read_file(activation, private=True), object_pairs_hook=no_duplicates)
            if not isinstance(record, dict) or set(record) != {"request_sha256", "proof"} or record["request_sha256"] != request["request_sha256"] or certificate is None:
                raise ValueError("rotation_activation_journal_invalid")
            verify_activation(request, certificate, record["proof"])
        crl = x509.load_pem_x509_crl(read_file(directory / "broker-tls/revoked.crl", private=True))
        _, ca, _ = ca_certificate(authority)
        now = datetime.now(timezone.utc)
        crl_updated = (crl.is_signature_valid(ca.public_key()) and crl.last_update_utc <= now
                       and crl.next_update_utc is not None and now < crl.next_update_utc
                       and crl.get_revoked_certificate_by_serial_number(int(request["replaces_serial"], 16)) is not None)
        result.update(previous_decision=previous, activation_confirmed=confirmed, crl_updated=crl_updated,
                      rotation_completed=confirmed and previous == "revoked" and crl_updated)
    if certificate is None:
        return result, None, ca_raw
    result.update(decision=decision, certificate_sha256=fingerprint(certificate.public_bytes(serialization.Encoding.DER)),
                  not_before=certificate.not_valid_before_utc.isoformat(), not_after=certificate.not_valid_after_utc.isoformat())
    return result, certificate.public_bytes(serialization.Encoding.PEM), ca_raw


def export_material(output, authority, pem, certificate, ca, result):
    output = path_without_links(output)
    if output.is_relative_to(authority):
        raise ValueError("csr_output_must_be_outside_authority")
    new_directory(output)
    for name, raw in (("request.csr", pem), ("device.crt", certificate), ("ca.crt", ca)):
        write_new(output / name, raw)
    write_new(output / "enrollment.json", json.dumps(result, ensure_ascii=False, indent=2).encode() + b"\n")
    return {**result, "output": str(output)}


def rotation_predecessor(directory, authority, device, serial, digest, new_public, recovery=False):
    if not isinstance(serial, str) or not re.fullmatch(r"[0-9A-F]{1,40}", serial) or int(serial, 16) <= 0 or not isinstance(digest, str) or not SHA.fullmatch(digest):
        raise ValueError("rotation_previous_certificate_confirmation_required")
    config = bound_device(directory, device)
    decision, certificate = certificate_result(authority, device, serial, expected_digest=digest)
    if decision != ("expired" if recovery else "issued"):
        raise ValueError("recovery_previous_certificate_not_expired" if recovery else "rotation_previous_certificate_not_active")
    if recovery and datetime.now(timezone.utc) < certificate.not_valid_after_utc:
        raise ValueError("recovery_previous_certificate_not_expired")
    public = certificate.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    if fingerprint(public) == new_public:
        raise ValueError("rotation_new_key_required")
    entries = [row.split("\t") for row in read_file(authority / "index.txt", maximum=4 * 1024 * 1024, private=True).decode().splitlines()]
    # 过期恢复不能从多张未撤销历史证书中任选一张，先由管理者消除歧义。
    if [row[3] for row in entries if row[0] in (("V", "E") if recovery else ("V",)) and row[-1] == "/CN="+device] != [serial]:
        raise ValueError("rotation_other_active_certificate_exists")
    journal = authority / "csr-operations"
    if journal.exists():
        private_directory(journal)
        for operation in journal.iterdir():
            _, original, _ = load_request(authority, operation.name)
            if original["device_id"] != device:
                continue
            result, _, _ = original_result(directory, authority, original)
            if result["decision"] == "unknown" or original["schema_version"] >= 2 and result["decision"] != "revoked" and not result["rotation_completed"]:
                raise ValueError("pending_csr_enrollment_query_original")
    return config


def sign_csr(directory, device, csr_path, expected_public, request_id, output, replacement=None, recovery=False):
    if not isinstance(request_id, str) or not ID.fullmatch(request_id):
        raise ValueError("invalid_request_id")
    if not isinstance(expected_public, str) or not SHA.fullmatch(expected_public):
        raise ValueError("explicit_public_key_fingerprint_required")
    if recovery and replacement is None:
        raise ValueError("rotation_previous_certificate_confirmation_required")
    pem, digest, public = parse_csr(read_file(csr_path), device)
    if public != expected_public:
        raise ValueError("csr_public_key_fingerprint_mismatch")
    with authority_lock(directory) as authority:
        operations = authority / "csr-operations"
        if operations.exists():
            private_directory(operations)
        if (operations / request_id).exists():
            raise ValueError("csr_request_exists_query_original")
        config = available_device(directory, device) if replacement is None else rotation_predecessor(directory, authority, device, *replacement, public, recovery=recovery)
        if not isinstance(config["space_id"], str) or not ID.fullmatch(config["space_id"]):
            raise ValueError("invalid_space_id")
        _, ca, ca_digest = ca_certificate(authority)
        now = datetime.now(timezone.utc)
        if not ca.not_valid_before_utc <= now < ca.not_valid_after_utc:
            raise ValueError("device_ca_expired_or_not_yet_valid")
        serial = read_file(authority / "serial", private=True).decode().strip()
        if not re.fullmatch(r"[0-9A-F]{1,40}", serial) or int(serial, 16) <= 0:
            raise ValueError("invalid_next_certificate_serial")
        output = path_without_links(output)
        if output.exists() or output.is_relative_to(authority):
            raise ValueError("csr_output_must_be_new_and_outside_authority")
        if not operations.exists():
            new_directory(operations)
        operation = new_directory(operations / request_id)
        request = {"schema_version": 1, "request_id": request_id, "space_id": config["space_id"], "device_id": device,
                   "serial": serial, "csr_sha256": digest, "public_key_fingerprint": public, "ca_fingerprint": ca_digest}
        if replacement is not None:
            request.update(schema_version=2, replaces_serial=replacement[0], replaces_certificate_sha256=replacement[1], activation_challenge=secrets.token_hex(32))
        if recovery:
            request.update(schema_version=3, recovery_reason="certificate_expired")
        request["request_sha256"] = fingerprint(canonical(request))
        write_new(operation / "request.csr", pem)
        write_new(operation / "request.json", canonical(request) + b"\n")
        # 意图已耐久保存。之后任何失败保留原操作；不可用新请求绕过未知签发。
        save(authority / "openssl.cnf", ca_config(authority))
        openssl("ca", "-batch", "-config", authority / "openssl.cnf", "-extensions", "client", "-notext", "-in", operation / "request.csr", "-out", operation / "signed.pem")
        # OpenSSL没有为调用者承诺fsync，成功后显式同步签发数据库及本次证书。
        for path in (authority / "index.txt", authority / "serial", authority / "issued" / (serial + ".pem")):
            descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
        sync_directory(authority / "issued")
        sync_directory(authority)
        result, certificate, ca_raw = original_result(directory, authority, request)
        if result["decision"] != "issued":
            raise ValueError("csr_issuance_unknown_query_original")
        return export_material(output, authority, pem, certificate, ca_raw, result)


def resolve_csr(directory, request_id, output=None):
    with authority_lock(directory) as authority:
        _, request, pem = load_request(authority, request_id)
        result, certificate, ca = original_result(directory, authority, request)
        if output is None:
            return result
        if result["decision"] != "issued":
            raise ValueError("csr_original_certificate_not_active")
        return export_material(output, authority, pem, certificate, ca, result)


def complete_rotation(directory, request_id, proof):
    with authority_lock(directory) as authority:
        operation, request, _ = load_request(authority, request_id)
        if request["schema_version"] not in (2, 3):
            raise ValueError("rotation_request_required")
        result, certificate, _ = original_result(directory, authority, request)
        if result["decision"] != "issued":
            raise ValueError("rotation_candidate_not_active")
        verify_activation(request, x509.load_pem_x509_certificate(certificate), proof)
        if not result["activation_confirmed"]:
            write_new(operation / "activation.json", canonical({"request_sha256": request["request_sha256"], "proof": proof})+b"\n")
        if result["previous_decision"] != "revoked":
            revoke(directory, request["replaces_serial"])
        else:
            refresh_crl(directory)
        for name in ("index.txt", "issued/"+request["replaces_serial"]+".pem"):
            with (authority / name).open("rb") as file:
                os.fsync(file.fileno())
        with (directory / "broker-tls/revoked.crl").open("rb") as file:
            os.fsync(file.fileno())
        sync_directory(authority); sync_directory(directory / "broker-tls")
        result, _, _ = original_result(directory, authority, request)
        return {**result, "broker_restart_required": True}


def execute(args):
    if args.serial is not None:
        raise ValueError("csr_action_does_not_accept_serial")
    directory = path_without_links(args.directory)
    if args.action == "complete-rotation":
        if args.device_id or args.csr is not None or args.output is not None or args.public_key_fingerprint or args.previous_serial or args.previous_certificate_fingerprint:
            raise ValueError("complete_rotation_requires_original_request_and_activation_proof")
        return complete_rotation(directory, args.request_id, args.activation_proof)
    if args.activation_proof:
        raise ValueError("activation_proof_only_for_complete_rotation")
    if args.action not in ("rotate-csr", "recover-csr") and (args.previous_serial or args.previous_certificate_fingerprint):
        raise ValueError("rotation_previous_fields_forbidden")
    if args.action == "inspect-csr":
        if not args.device_id or args.csr is None or args.output is not None or args.request_id or args.public_key_fingerprint:
            raise ValueError("inspect_csr_requires_device_and_public_csr_only")
        private_directory(directory)
        read_file(directory / "config/gateway.json", maximum=4 * 1024 * 1024, private=True)
        bound_device(directory, args.device_id)
        return inspect_csr(args.csr, args.device_id)
    if args.action in ("sign-csr", "rotate-csr", "recover-csr"):
        if not args.device_id or args.csr is None or args.output is None:
            raise ValueError("sign_csr_arguments_required")
        replacement = (args.previous_serial, args.previous_certificate_fingerprint) if args.action in ("rotate-csr", "recover-csr") else None
        return sign_csr(directory, args.device_id, args.csr, args.public_key_fingerprint, args.request_id, args.output, replacement, recovery=args.action == "recover-csr")
    if args.csr is not None or args.device_id or args.public_key_fingerprint:
        raise ValueError("resolve_csr_requires_original_request_id")
    return resolve_csr(directory, args.request_id, args.output)
