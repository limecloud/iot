"""为真实设备CSR生成错误证书夹具；CA私钥只在宿主测试目录内使用。"""
from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

directory = Path(sys.argv[1])
authority = directory / "nas/device-authority"
ca = x509.load_pem_x509_certificate((authority / "ca.crt").read_bytes())
ca_key = serialization.load_pem_private_key((authority / "ca.key").read_bytes(), None)
csr = x509.load_pem_x509_csr((directory / "device/request.csr").read_bytes())
now = datetime.now(timezone.utc)
target = directory / "certificates"
target.mkdir(mode=0o700)

for case in ("valid", "wrong-cn", "extra-subject", "wrong-key", "wrong-ca", "ca-leaf",
             "server-auth", "dual-eku", "missing-eku", "missing-ku", "extra-ku", "missing-constraints",
             "expired", "future", "sha384", "unknown-critical"):
    subject = csr.subject
    if case == "wrong-cn":
        subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "device-button")])
    if case == "extra-subject":
        subject = x509.Name([*subject, x509.NameAttribute(NameOID.ORGANIZATION_NAME, "fixture")])
    public = ec.generate_private_key(ec.SECP256R1()).public_key() if case == "wrong-key" else csr.public_key()
    key = ec.generate_private_key(ec.SECP256R1()) if case == "wrong-ca" else ca_key
    builder = (x509.CertificateBuilder().subject_name(subject).issuer_name(ca.subject).public_key(public)
               .serial_number(x509.random_serial_number())
               .not_valid_before(now + timedelta(days=1) if case == "future" else now - timedelta(days=2))
               .not_valid_after(now - timedelta(days=1) if case == "expired" else now + timedelta(days=30)))
    if case != "missing-constraints":
        builder = builder.add_extension(x509.BasicConstraints(case == "ca-leaf", None), critical=True)
    if case != "missing-ku":
        builder = builder.add_extension(x509.KeyUsage(True, False, case == "extra-ku", False, False, False, False, None, None), critical=True)
    if case != "missing-eku":
        purposes = [ExtendedKeyUsageOID.SERVER_AUTH] if case == "server-auth" else [ExtendedKeyUsageOID.CLIENT_AUTH]
        if case == "dual-eku":
            purposes.append(ExtendedKeyUsageOID.SERVER_AUTH)
        builder = builder.add_extension(x509.ExtendedKeyUsage(purposes), critical=False)
    if case == "unknown-critical":
        builder = builder.add_extension(x509.UnrecognizedExtension(x509.ObjectIdentifier("1.3.6.1.4.1.99999.1"), b"\x05\x00"), critical=True)
    certificate = builder.sign(key, hashes.SHA384() if case == "sha384" else hashes.SHA256())
    (target / (case + ".crt")).write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
