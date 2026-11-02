//! 离线密钥及签名制品准备；不会联网、修改信任或授权安装。
use base64::{engine::general_purpose::STANDARD, Engine};
use limeiot_core::{ota, validation::bounded_document};
use ring::{
    rand::SystemRandom,
    signature::{Ed25519KeyPair, KeyPair},
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::Path,
};
#[path = "ota_esp32c3.rs"]
mod esp32c3;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Recipe {
    schema: String,
    version: u8,
    image_format: String,
    target: ota::Target,
    firmware_version: String,
    compatibility: ota::Compatibility,
    security_epoch: u32,
    download_base_url: String,
    issued_at: String,
    expires_at: String,
}

pub(super) struct Failure {
    pub code: String,
    pub exit: i32,
}
pub(super) type Result<T> = std::result::Result<T, Failure>;
impl Failure {
    pub fn invalid(code: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            exit: 2,
        }
    }
    pub fn io(code: &str) -> Self {
        Self {
            code: code.into(),
            exit: 5,
        }
    }
}
fn read(path: &Path, maximum: usize, private: bool) -> Result<Vec<u8>> {
    let file = super::regular_file(path).map_err(|_| Failure::io("ota_input_io"))?;
    #[cfg(unix)]
    if private {
        use std::os::unix::fs::PermissionsExt;
        if file
            .metadata()
            .map_err(|_| Failure::io("ota_input_io"))?
            .permissions()
            .mode()
            & 0o077
            != 0
        {
            return Err(Failure::invalid("ota_private_key_permissions"));
        }
    }
    #[cfg(not(unix))]
    let _ = private;
    let mut bytes = Vec::new();
    file.take((maximum + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| Failure::io("ota_input_io"))?;
    if bytes.len() > maximum {
        return Err(Failure::invalid("ota_input_too_large"));
    }
    Ok(bytes)
}
fn document<T: DeserializeOwned>(raw: &[u8]) -> Result<T> {
    let value = bounded_document(raw, ota::MAX_REQUEST_BYTES, 16, 2048)
        .ok_or_else(|| Failure::invalid("invalid_ota_release_document"))?;
    serde_json::from_value(value).map_err(|_| Failure::invalid("invalid_ota_release_document"))
}
pub(super) fn directory(path: &Path) -> Result<()> {
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path).map_err(|error| Failure {
        code: if error.kind() == std::io::ErrorKind::AlreadyExists {
            "ota_output_exists"
        } else {
            "ota_output_io"
        }
        .into(),
        exit: if error.kind() == std::io::ErrorKind::AlreadyExists {
            4
        } else {
            5
        },
    })?;
    sync(
        path.parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new(".")),
    )
}
pub(super) fn sync(path: &Path) -> Result<()> {
    #[cfg(unix)]
    File::open(path)
        .and_then(|file| file.sync_all())
        .map_err(|_| Failure::io("ota_output_io"))?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}
pub(super) fn write(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|_| Failure::io("ota_output_io"))?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| Failure::io("ota_output_io"))
}
pub(super) fn json_bytes(value: &impl Serialize) -> Result<Vec<u8>> {
    serde_json::to_vec_pretty(value).map_err(|_| Failure::io("ota_component_unavailable"))
}
pub(super) fn emit(result: Result<serde_json::Value>) -> i32 {
    match result {
        Ok(value) => {
            println!("{value}");
            0
        }
        Err(error) => {
            eprintln!("{}", json!({"error":{"code":error.code}}));
            error.exit
        }
    }
}
fn public(key: &Ed25519KeyPair) -> serde_json::Value {
    json!({"schema":"limeiot.ota-key", "version":1, "purpose":"device-firmware", "algorithm":"Ed25519",
        "signing_key_id":limeiot_core::release::signing_key_id(key.public_key().as_ref()),
        "public_key":STANDARD.encode(key.public_key().as_ref())})
}
pub fn keygen(output: &Path) -> i32 {
    emit((|| {
        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new())
            .map_err(|_| Failure::io("ota_key_generation_failed"))?;
        let key = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref())
            .map_err(|_| Failure::io("ota_key_generation_failed"))?;
        let descriptor = public(&key);
        directory(output)?;
        write(&output.join("private.pk8"), pkcs8.as_ref())?;
        write(&output.join("public.json"), &json_bytes(&descriptor)?)?;
        sync(output)?;
        Ok(descriptor)
    })())
}

fn recipe(path: &Path) -> Result<Recipe> {
    let recipe: Recipe = document(&read(path, ota::MAX_REQUEST_BYTES, false)?)?;
    if recipe.schema != "limeiot.ota-release"
        || recipe.version != 1
        || recipe.image_format != "esp32c3"
        || recipe.target.chip != "esp32c3"
        || recipe.target.architecture != "riscv32"
        || !recipe.download_base_url.ends_with('/')
        || recipe.download_base_url.len() > 938
    {
        return Err(Failure::invalid("invalid_ota_release_document"));
    }
    Ok(recipe)
}
fn draft(recipe: &Recipe, image: &[u8], signing_key_id: &str) -> Result<ota::Manifest> {
    let image_sha256 = format!("sha256:{:x}", Sha256::digest(image));
    let identity = json!({"schema":"limeiot.ota-artifact-identity", "version":1, "signing_key_id":signing_key_id, "recipe":recipe,
        "size_bytes":image.len(), "sha256":image_sha256});
    let digest = limeiot_core::digest(&identity)
        .map_err(|_| Failure::invalid("invalid_ota_release_document"))?;
    let artifact_id = format!("artifact-{}", &digest[7..]);
    Ok(ota::Manifest {
        schema: "limeiot.ota-manifest".into(),
        version: 1,
        algorithm: "Ed25519".into(),
        signing_key_id: signing_key_id.into(),
        signature: String::new(),
        statement: ota::Statement {
            artifact_id: artifact_id.clone(),
            kind: "device-firmware".into(),
            target: recipe.target.clone(),
            version: recipe.firmware_version.clone(),
            compatibility: recipe.compatibility.clone(),
            size_bytes: image.len() as u32,
            sha256: image_sha256,
            security_epoch: recipe.security_epoch,
            download: ota::Download {
                url: format!("{}{artifact_id}/firmware.bin", recipe.download_base_url),
                redirects: false,
            },
            issued_at: recipe.issued_at.clone(),
            expires_at: recipe.expires_at.clone(),
        },
    })
}
fn receipt(recipe: &Recipe, manifest: &ota::Manifest, project: &str) -> Result<serde_json::Value> {
    let recipe_digest = limeiot_core::digest(recipe)
        .map_err(|_| Failure::invalid("invalid_ota_release_document"))?;
    let manifest_digest =
        limeiot_core::digest(manifest).map_err(|_| Failure::invalid("invalid_ota_manifest"))?;
    Ok(
        json!({"version":1, "signer":"limeiot.ota-sign/1.0.0", "status":"ready", "artifact_id":manifest.statement.artifact_id,
        "image_format":"esp32c3", "project_name":project,
        "recipe_digest":recipe_digest, "manifest_digest":manifest_digest, "signing_key_id":manifest.signing_key_id,
        "image_size_bytes":manifest.statement.size_bytes, "image_sha256":manifest.statement.sha256}),
    )
}

pub(super) struct ValidatedBundle {
    pub manifest: ota::Manifest,
    pub receipt: serde_json::Value,
    pub files: Vec<(&'static str, Vec<u8>)>,
    trust: ota::Trust,
}
impl ValidatedBundle {
    pub fn recheck(&self) -> Result<()> {
        ota::check_manifest(&self.manifest, &self.trust, chrono::Utc::now())
            .map_err(|error| Failure::invalid(error.code))
    }
}
pub(super) fn validate_bundle(
    bundle: &Path,
    trust_path: &Path,
    base_url: &str,
) -> Result<ValidatedBundle> {
    let metadata = fs::symlink_metadata(bundle).map_err(|_| Failure::io("ota_input_io"))?;
    if !metadata.is_dir() {
        return Err(Failure::invalid("invalid_ota_bundle"));
    }
    let mut names = fs::read_dir(bundle)
        .map_err(|_| Failure::io("ota_input_io"))?
        .map(|entry| entry.map(|entry| entry.file_name()))
        .collect::<std::io::Result<Vec<_>>>()
        .map_err(|_| Failure::io("ota_input_io"))?;
    names.sort();
    if names
        != [
            "firmware.bin",
            "manifest.json",
            "receipt.json",
            "release.json",
        ]
        .map(std::ffi::OsString::from)
    {
        return Err(Failure::invalid("invalid_ota_bundle"));
    }
    let recipe = recipe(&bundle.join("release.json"))?;
    if recipe.download_base_url != base_url {
        return Err(Failure::invalid("ota_repository_url_mismatch"));
    }
    let trust: ota::Trust = document(&read(trust_path, ota::MAX_REQUEST_BYTES, false)?)?;
    let manifest_bytes = read(&bundle.join("manifest.json"), 16_384, false)?;
    let manifest: ota::Manifest = document(&manifest_bytes)?;
    ota::check_manifest(&manifest, &trust, chrono::Utc::now())
        .map_err(|error| Failure::invalid(error.code))?;
    let image = read(
        &bundle.join("firmware.bin"),
        ota::MAX_IMAGE_BYTES as usize,
        false,
    )?;
    let project = esp32c3::inspect(&image, &recipe.firmware_version, recipe.security_epoch)
        .map_err(Failure::invalid)?;
    let expected = draft(&recipe, &image, &trust.signing_key_id)?;
    if json!(manifest.statement) != json!(expected.statement) {
        return Err(Failure::invalid("ota_bundle_content_mismatch"));
    }
    let actual: serde_json::Value = document(&read(&bundle.join("receipt.json"), 16_384, false)?)?;
    let receipt = receipt(&recipe, &manifest, &project)?;
    if actual != receipt {
        return Err(Failure::invalid("ota_bundle_receipt_mismatch"));
    }
    Ok(ValidatedBundle {
        files: vec![
            ("release.json", json_bytes(&recipe)?),
            ("firmware.bin", image),
            ("manifest.json", manifest_bytes),
            ("receipt.json", json_bytes(&receipt)?),
        ],
        manifest,
        receipt,
        trust,
    })
}
pub fn sign(
    input: &Path,
    trust_path: &Path,
    key_path: &Path,
    image_path: &Path,
    output: &Path,
) -> i32 {
    emit((|| {
        let recipe = recipe(input)?;
        let trust: ota::Trust = document(&read(trust_path, ota::MAX_REQUEST_BYTES, false)?)?;
        let now = chrono::Utc::now();
        ota::check_trust(&trust, now).map_err(|error| Failure::invalid(error.code))?;
        let key = Ed25519KeyPair::from_pkcs8(&read(key_path, 4096, true)?)
            .map_err(|_| Failure::invalid("invalid_ota_private_key"))?;
        let descriptor = public(&key);
        if descriptor["signing_key_id"] != trust.signing_key_id
            || descriptor["public_key"] != trust.public_key
        {
            return Err(Failure::invalid("untrusted_ota_key"));
        }
        let image = read(image_path, ota::MAX_IMAGE_BYTES as usize, false)?;
        if image.is_empty() {
            return Err(Failure::invalid("invalid_ota_image_size"));
        }
        let project = esp32c3::inspect(&image, &recipe.firmware_version, recipe.security_epoch)
            .map_err(Failure::invalid)?;
        let mut manifest = draft(&recipe, &image, &trust.signing_key_id)?;
        let message =
            ota::signing_message(&manifest).map_err(|error| Failure::invalid(error.code))?;
        manifest.signature = STANDARD.encode(key.sign(&message).as_ref());
        ota::check_manifest(&manifest, &trust, now)
            .map_err(|error| Failure::invalid(error.code))?;
        let manifest_bytes = json_bytes(&manifest)?;
        if manifest_bytes.len() > 16_384 {
            return Err(Failure::invalid("ota_manifest_too_large"));
        }
        let receipt = receipt(&recipe, &manifest, &project)?;
        // 输出为全新私有目录；私钥/信任不复制。最后才提交ready回执，失败不清理或自动续签。
        directory(output)?;
        write(&output.join("release.json"), &json_bytes(&recipe)?)?;
        write(&output.join("firmware.bin"), &image)?;
        write(&output.join("manifest.json"), &manifest_bytes)?;
        sync(output)?;
        write(&output.join("receipt.json"), &json_bytes(&receipt)?)?;
        sync(output)?;
        Ok(receipt)
    })())
}
