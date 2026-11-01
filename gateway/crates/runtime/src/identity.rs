//! 网关机器密钥独立于所有者登录凭据；原配对码只以密文进入耐久状态。
use base64::{engine::general_purpose::STANDARD, Engine};
use limeiot_core::{
    control::{proof, Pairing},
    ensure, err, Result,
};
use ring::{
    aead, digest,
    rand::{SecureRandom, SystemRandom},
    signature::{Ed25519KeyPair, KeyPair},
};
use serde::Serialize;
use std::{
    fs::{File, OpenOptions},
    io::{Read, Write},
    path::Path,
};

pub struct MachineIdentity {
    key: Ed25519KeyPair,
    encryption: aead::LessSafeKey,
}
#[derive(Serialize)]
pub struct Claim {
    pub code: String,
    pub gateway_id: String,
    pub local_space_id: String,
    pub public_key: String,
    pub signature: String,
}
impl MachineIdentity {
    pub fn load(path: &Path) -> Result<Self> {
        ensure(
            std::fs::symlink_metadata(path)
                .map_err(|_| err("machine_identity_unavailable"))?
                .is_file(),
            "machine_identity_unavailable",
        )?;
        let file = File::open(path).map_err(|_| err("machine_identity_unavailable"))?;
        let metadata = file
            .metadata()
            .map_err(|_| err("machine_identity_unavailable"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            ensure(
                metadata.permissions().mode() & 0o077 == 0,
                "machine_identity_permissions",
            )?;
        }
        #[cfg(not(unix))]
        {
            return Err(err("machine_identity_storage_unsupported"));
        }
        ensure(metadata.len() <= 4096, "machine_identity_invalid")?;
        let mut bytes = Vec::new();
        file.take(4097)
            .read_to_end(&mut bytes)
            .map_err(|_| err("machine_identity_unavailable"))?;
        let key = Ed25519KeyPair::from_pkcs8_maybe_unchecked(&bytes)
            .map_err(|_| err("machine_identity_invalid"))?;
        let mut input = b"limeiot-control-code-encryption-v1:".to_vec();
        input.extend_from_slice(&bytes);
        let hash = digest::digest(&digest::SHA256, &input);
        let encryption = aead::LessSafeKey::new(
            aead::UnboundKey::new(&aead::AES_256_GCM, hash.as_ref())
                .map_err(|_| err("machine_identity_invalid"))?,
        );
        Ok(Self { key, encryption })
    }
    pub fn create(path: &Path) -> Result<Self> {
        let document = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new())
            .map_err(|_| err("random_unavailable"))?;
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        #[cfg(not(unix))]
        {
            return Err(err("machine_identity_storage_unsupported"));
        }
        let mut file = options
            .open(path)
            .map_err(|_| err("machine_identity_output_exists_or_unavailable"))?;
        file.write_all(document.as_ref())
            .and_then(|_| file.sync_all())
            .map_err(|_| err("machine_identity_unavailable"))?;
        Self::load(path)
    }
    pub fn public(&self) -> String {
        STANDARD.encode(self.key.public_key().as_ref())
    }
    pub fn sign_connection(&self, proof: &str) -> String {
        STANDARD.encode(self.key.sign(proof.as_bytes()).as_ref())
    }
    pub fn gateway_id(&self) -> String {
        let hash = digest::digest(&digest::SHA256, self.key.public_key().as_ref());
        format!("gw-{}", hex(hash.as_ref()))
    }
    pub fn code_digest(code: &str) -> String {
        hex(digest::digest(&digest::SHA256, code.as_bytes()).as_ref())
    }
    pub fn seal(&self, id: &str, code: &str) -> Result<String> {
        let mut nonce = [0; 12];
        SystemRandom::new()
            .fill(&mut nonce)
            .map_err(|_| err("random_unavailable"))?;
        let mut buffer = code.as_bytes().to_vec();
        self.encryption
            .seal_in_place_append_tag(
                aead::Nonce::assume_unique_for_key(nonce),
                aead::Aad::from(format!("limeiot-control:{id}")),
                &mut buffer,
            )
            .map_err(|_| err("machine_identity_invalid"))?;
        let mut output = nonce.to_vec();
        output.extend(buffer);
        Ok(STANDARD.encode(output))
    }
    pub fn open(&self, id: &str, sealed: &str) -> Result<String> {
        let mut buffer = STANDARD
            .decode(sealed)
            .map_err(|_| err("control_secret_invalid"))?;
        ensure(buffer.len() >= 28, "control_secret_invalid")?;
        let nonce = aead::Nonce::try_assume_unique_for_key(&buffer[..12])
            .map_err(|_| err("control_secret_invalid"))?;
        let clear = self
            .encryption
            .open_in_place(
                nonce,
                aead::Aad::from(format!("limeiot-control:{id}")),
                &mut buffer[12..],
            )
            .map_err(|_| err("control_secret_invalid"))?;
        String::from_utf8(clear.to_vec()).map_err(|_| err("control_secret_invalid"))
    }
    pub fn claim(&self, origin: &str, pairing: &Pairing, local: &str, code: String) -> Claim {
        let gateway_id = self.gateway_id();
        let public_key = self.public();
        let input = proof(origin, pairing, &gateway_id, local, &public_key);
        let signature = STANDARD.encode(self.key.sign(input.as_bytes()).as_ref());
        Claim {
            code,
            gateway_id,
            local_space_id: local.into(),
            public_key,
            signature,
        }
    }
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|v| format!("{v:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn node_go_proof_vector_matches_rust() {
        let v: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../contracts/examples/control-pairing-proof.json"
        ))
        .unwrap();
        let seed = v["test_seed_hex"].as_str().unwrap();
        let seed: Vec<u8> = (0..seed.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&seed[i..i + 2], 16).unwrap())
            .collect();
        let key = Ed25519KeyPair::from_seed_unchecked(&seed).unwrap();
        let pair: Pairing = serde_json::from_value(v["pairing"].clone()).unwrap();
        let input = proof(
            v["control_origin"].as_str().unwrap(),
            &pair,
            v["claim"]["gateway_id"].as_str().unwrap(),
            v["claim"]["local_space_id"].as_str().unwrap(),
            v["claim"]["public_key"].as_str().unwrap(),
        );
        assert_eq!(input, v["proof"]);
        assert_eq!(
            STANDARD.encode(key.sign(input.as_bytes()).as_ref()),
            v["claim"]["signature"]
        );
    }
    #[test]
    fn private_file_and_aad_are_required() {
        let path = std::env::temp_dir().join(format!("limeiot-identity-{}", limeiot_core::id()));
        let first = MachineIdentity::create(&path).unwrap();
        assert!(MachineIdentity::create(&path).is_err());
        let sealed = first.seal("one", "secret-code").unwrap();
        assert_eq!(first.open("one", &sealed).unwrap(), "secret-code");
        assert!(first.open("two", &sealed).is_err());
        let loaded = MachineIdentity::load(&path).unwrap();
        assert_eq!(first.gateway_id(), loaded.gateway_id());
        assert_eq!(loaded.open("one", &sealed).unwrap(), "secret-code");
        std::fs::remove_file(path).unwrap();
    }
}
