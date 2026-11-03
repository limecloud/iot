"""生成运行期宿主测试身份；私钥仅写入隔离测试目录。"""
from datetime import datetime, timedelta, timezone
from pathlib import Path
import os
import sys
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

directory, kind = Path(sys.argv[1]), sys.argv[2]
if kind not in ("valid", "short-leaf", "short-ca"):
    raise ValueError("unknown fixture kind")
os.umask(0o077)
now = datetime.now(timezone.utc).replace(microsecond=0)
ca_key, key = ec.generate_private_key(ec.SECP256R1()), ec.generate_private_key(ec.SECP256R1())
name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Dispatch test CA")])
ca = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(ca_key.public_key())
      .serial_number(1).not_valid_before(now - timedelta(days=1))
      .not_valid_after(now + (timedelta(seconds=4) if kind == "short-ca" else timedelta(days=1)))
      .add_extension(x509.BasicConstraints(True, None), True)
      .add_extension(x509.KeyUsage(False, False, False, False, False, True, True, None, None), True)
      .sign(ca_key, hashes.SHA256()))
leaf = (x509.CertificateBuilder()
        .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "device-lamp")]))
        .issuer_name(name).public_key(key.public_key()).serial_number(2)
        .not_valid_before(now - timedelta(days=1))
        .not_valid_after(now + (timedelta(seconds=4) if kind == "short-leaf" else timedelta(days=1)))
        .add_extension(x509.BasicConstraints(False, None), True)
        .add_extension(x509.KeyUsage(True, False, False, False, False, False, False, None, None), True)
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.CLIENT_AUTH]), False)
        .sign(ca_key, hashes.SHA256()))
(directory / "key.pem").write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
(directory / "leaf.pem").write_bytes(leaf.public_bytes(serialization.Encoding.PEM))
(directory / "ca.pem").write_bytes(ca.public_bytes(serialization.Encoding.PEM))
