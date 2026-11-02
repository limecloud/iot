//! 固件制品离线校验。成功只证明给定快照和镜像，不授予设备安装权限。
use crate::{
    compatibility, ensure, err,
    validation::{self, bounded_document, issue, Issue},
    Result,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::{DateTime, SecondsFormat, Utc};
use ring::signature::{UnparsedPublicKey, ED25519};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, io::Read};

pub const VERIFIER: &str = "limeiot.ota/1.0.0";
pub const SIGNING_DOMAIN: &[u8] = b"LimeIoT Device Firmware v1\n";
pub const MAX_REQUEST_BYTES: usize = 32_768;
pub const MAX_IMAGE_BYTES: u32 = 33_554_432;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Target {
    pub product_id: String,
    pub architecture: String,
    pub chip: String,
    pub board: String,
    pub hardware_revisions: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Compatibility {
    pub protocol_version: u8,
    pub model_revisions: Vec<String>,
    pub minimum_bootloader_version: String,
    pub from_versions: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Download {
    pub url: String,
    pub redirects: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Statement {
    pub artifact_id: String,
    pub kind: String,
    pub target: Target,
    pub version: String,
    pub compatibility: Compatibility,
    pub size_bytes: u32,
    pub sha256: String,
    pub security_epoch: u32,
    pub download: Download,
    pub issued_at: String,
    pub expires_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub schema: String,
    pub version: u8,
    pub algorithm: String,
    pub signing_key_id: String,
    pub statement: Statement,
    pub signature: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Trust {
    pub schema: String,
    pub version: u8,
    pub purpose: String,
    pub signing_key_id: String,
    pub public_key: String,
    pub product_ids: Vec<String>,
    pub download_origins: Vec<String>,
    pub minimum_security_epoch: u32,
    pub minimum_battery_percent: u8,
    pub revoked_artifact_ids: Vec<String>,
    pub not_before: String,
    pub expires_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Device {
    pub device_id: String,
    pub product_id: String,
    pub architecture: String,
    pub chip: String,
    pub board: String,
    pub hardware_revision: String,
    pub firmware_version: String,
    pub bootloader_version: String,
    pub protocol_version: u8,
    pub model_revision: String,
    pub security_epoch: u32,
    pub ota_capacity_bytes: u32,
    pub external_power: bool,
    pub battery_percent: Option<u8>,
    pub safe_to_update: bool,
    pub pending_update: bool,
}

pub fn check_device(device: &Device) -> Result<()> {
    ensure(
        [
            &device.device_id,
            &device.product_id,
            &device.architecture,
            &device.chip,
            &device.board,
            &device.hardware_revision,
        ]
        .into_iter()
        .all(|v| token(v))
            && validation::version(&device.firmware_version)
            && validation::version(&device.bootloader_version)
            && hex_id(&device.model_revision, "sha256:")
            && device.protocol_version == 1
            && device.battery_percent.is_none_or(|v| v <= 100)
            && device.ota_capacity_bytes > 0
            && device.ota_capacity_bytes <= MAX_IMAGE_BYTES,
        "invalid_ota_device",
    )
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub manifest: Manifest,
    pub trust: Trust,
    pub device: Device,
}

#[derive(Debug, Serialize)]
pub struct Verification {
    pub version: u8,
    pub verifier: &'static str,
    pub valid: bool,
    pub request_digest: Option<String>,
    pub image_size_bytes: Option<u32>,
    pub image_sha256: Option<String>,
    pub issues: Vec<Issue>,
}

fn hex_id(value: &str, prefix: &str) -> bool {
    value.strip_prefix(prefix).is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}
fn token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
}
fn list(values: &[String], max: usize, check: impl Fn(&str) -> bool) -> bool {
    !values.is_empty()
        && values.len() <= max
        && values.iter().all(|value| check(value))
        && values.iter().collect::<BTreeSet<_>>().len() == values.len()
}
fn timestamp(value: &str) -> Result<DateTime<Utc>> {
    let parsed = DateTime::parse_from_rfc3339(value)
        .map_err(|_| err("invalid_ota_time"))?
        .with_timezone(&Utc);
    ensure(
        value.len() == 20
            && parsed.timestamp() >= 0
            && parsed.timestamp_subsec_nanos() == 0
            && parsed.to_rfc3339_opts(SecondsFormat::Secs, true) == value,
        "invalid_ota_time",
    )?;
    Ok(parsed)
}
fn https_url(value: &str) -> Option<url::Url> {
    let parsed = url::Url::parse(value).ok()?;
    (value.len() <= 1024
        && parsed.as_str() == value
        && parsed.scheme() == "https"
        && parsed.host_str().is_some()
        && parsed.username().is_empty()
        && parsed.password().is_none()
        && parsed.query().is_none()
        && parsed.fragment().is_none())
    .then_some(parsed)
}
fn origin(value: &str) -> bool {
    https_url(&format!("{value}/")).is_some_and(|url| url.origin().ascii_serialization() == value)
}
fn decoded(value: &str, size: usize) -> Option<Vec<u8>> {
    let bytes = STANDARD.decode(value).ok()?;
    (bytes.len() == size && STANDARD.encode(&bytes) == value).then_some(bytes)
}

#[derive(Serialize)]
struct Unsigned<'a> {
    schema: &'a str,
    version: u8,
    algorithm: &'a str,
    signing_key_id: &'a str,
    statement: &'a Statement,
}

pub fn signing_message(manifest: &Manifest) -> Result<Vec<u8>> {
    let mut message = SIGNING_DOMAIN.to_vec();
    message.extend(
        serde_jcs::to_vec(&Unsigned {
            schema: &manifest.schema,
            version: manifest.version,
            algorithm: &manifest.algorithm,
            signing_key_id: &manifest.signing_key_id,
            statement: &manifest.statement,
        })
        .map_err(|_| err("invalid_ota_manifest"))?,
    );
    Ok(message)
}

fn trust_key(trust: &Trust) -> Result<Vec<u8>> {
    ensure(
        list(&trust.product_ids, 16, token)
            && list(&trust.download_origins, 8, origin)
            && trust.minimum_battery_percent <= 100
            && trust.revoked_artifact_ids.len() <= 128
            && trust
                .revoked_artifact_ids
                .iter()
                .all(|id| hex_id(id, "artifact-"))
            && trust
                .revoked_artifact_ids
                .iter()
                .collect::<BTreeSet<_>>()
                .len()
                == trust.revoked_artifact_ids.len(),
        "invalid_ota_trust",
    )?;
    let public = decoded(&trust.public_key, 32).ok_or_else(|| err("invalid_ota_key"))?;
    ensure(
        trust.signing_key_id == crate::release::signing_key_id(&public),
        "untrusted_ota_key",
    )?;
    Ok(public)
}

pub fn check_trust(trust: &Trust, now: DateTime<Utc>) -> Result<()> {
    ensure(
        trust.schema == "limeiot.ota-trust"
            && trust.version == 1
            && trust.purpose == "device-firmware",
        "unsupported_ota_contract",
    )?;
    trust_key(trust)?;
    let start = timestamp(&trust.not_before)?;
    let end = timestamp(&trust.expires_at)?;
    ensure(start < end, "invalid_ota_validity")?;
    ensure(now >= start && now < end, "ota_trust_outside_validity")
}

/// 校验签名制品及独立信任，不要求发布者伪造设备运行快照。
pub fn check_manifest(manifest: &Manifest, trust: &Trust, now: DateTime<Utc>) -> Result<()> {
    let statement = &manifest.statement;
    ensure(
        manifest.schema == "limeiot.ota-manifest"
            && manifest.version == 1
            && manifest.algorithm == "Ed25519"
            && statement.kind == "device-firmware"
            && trust.schema == "limeiot.ota-trust"
            && trust.version == 1
            && trust.purpose == "device-firmware",
        "unsupported_ota_contract",
    )?;
    let public = trust_key(trust)?;
    ensure(
        manifest.signing_key_id == trust.signing_key_id,
        "untrusted_ota_key",
    )?;
    let signature = decoded(&manifest.signature, 64).ok_or_else(|| err("invalid_ota_signature"))?;
    UnparsedPublicKey::new(&ED25519, public)
        .verify(&signing_message(manifest)?, &signature)
        .map_err(|_| err("invalid_ota_signature"))?;

    let trust_start = timestamp(&trust.not_before)?;
    let trust_end = timestamp(&trust.expires_at)?;
    let issued = timestamp(&statement.issued_at)?;
    let expires = timestamp(&statement.expires_at)?;
    ensure(
        trust_start <= issued && issued < expires && expires <= trust_end,
        "invalid_ota_validity",
    )?;
    ensure(now >= issued && now < expires, "ota_outside_validity")?;
    ensure(
        hex_id(&statement.artifact_id, "artifact-")
            && hex_id(&statement.sha256, "sha256:")
            && statement.size_bytes > 0
            && statement.size_bytes <= MAX_IMAGE_BYTES
            && validation::version(&statement.version),
        "invalid_ota_manifest",
    )?;
    ensure(
        !trust.revoked_artifact_ids.contains(&statement.artifact_id),
        "ota_artifact_revoked",
    )?;
    let target = &statement.target;
    ensure(
        [
            &target.product_id,
            &target.architecture,
            &target.chip,
            &target.board,
        ]
        .into_iter()
        .all(|v| token(v))
            && list(&target.hardware_revisions, 16, token),
        "invalid_ota_target",
    )?;
    ensure(
        trust.product_ids.contains(&target.product_id),
        "untrusted_ota_product",
    )?;
    let compatible = &statement.compatibility;
    ensure(
        compatible.protocol_version == 1
            && list(&compatible.model_revisions, 16, |v| hex_id(v, "sha256:"))
            && validation::version(&compatible.minimum_bootloader_version)
            && list(&compatible.from_versions, 16, validation::version)
            && compatible
                .from_versions
                .iter()
                .all(|v| compatibility::version(v) < compatibility::version(&statement.version)),
        "invalid_ota_compatibility",
    )?;
    let download = https_url(&statement.download.url).ok_or_else(|| err("invalid_ota_download"))?;
    ensure(
        !statement.download.redirects
            && download.path() != "/"
            && trust
                .download_origins
                .contains(&download.origin().ascii_serialization()),
        "untrusted_ota_download",
    )?;
    ensure(
        statement.security_epoch >= trust.minimum_security_epoch,
        "ota_downgrade_forbidden",
    )?;
    Ok(())
}

pub fn check_request(request: &Request, now: DateTime<Utc>) -> Result<()> {
    check_manifest(&request.manifest, &request.trust, now)?;
    let device = &request.device;
    let statement = &request.manifest.statement;
    let target = &statement.target;
    let compatible = &statement.compatibility;
    let trust = &request.trust;
    check_device(device)?;
    ensure(
        target.product_id == device.product_id
            && target.architecture == device.architecture
            && target.chip == device.chip
            && target.board == device.board
            && target
                .hardware_revisions
                .contains(&device.hardware_revision),
        "ota_target_mismatch",
    )?;
    ensure(
        compatible.protocol_version == device.protocol_version
            && compatible.model_revisions.contains(&device.model_revision)
            && compatible.from_versions.contains(&device.firmware_version)
            && compatibility::version(&device.bootloader_version)
                >= compatibility::version(&compatible.minimum_bootloader_version),
        "ota_device_incompatible",
    )?;
    ensure(
        statement.security_epoch >= device.security_epoch
            && compatibility::version(&statement.version)
                > compatibility::version(&device.firmware_version),
        "ota_downgrade_forbidden",
    )?;
    ensure(
        statement.size_bytes <= device.ota_capacity_bytes,
        "ota_partition_too_small",
    )?;
    ensure(
        device.external_power
            || device
                .battery_percent
                .is_some_and(|v| v >= trust.minimum_battery_percent),
        "ota_insufficient_power",
    )?;
    ensure(
        device.safe_to_update && !device.pending_update,
        "ota_device_busy",
    )?;
    Ok(())
}

fn read_image(reader: impl Read, expected_size: u32) -> Result<(u32, String)> {
    let mut reader = reader.take(u64::from(expected_size) + 1);
    let mut hash = Sha256::new();
    let mut size = 0_u32;
    let mut buffer = [0_u8; 16_384];
    loop {
        let length = reader.read(&mut buffer).map_err(|_| err("ota_image_io"))?;
        if length == 0 {
            break;
        }
        size += length as u32;
        hash.update(&buffer[..length]);
    }
    ensure(size == expected_size, "ota_image_size_mismatch")?;
    Ok((size, format!("sha256:{:x}", hash.finalize())))
}

fn request_value(raw: &[u8]) -> Result<serde_json::Value> {
    bounded_document(raw, MAX_REQUEST_BYTES, 8, 2048).ok_or_else(|| err("invalid_ota_document"))
}

fn typed_request(value: &serde_json::Value) -> Result<Request> {
    let canonical = serde_jcs::to_vec(value).map_err(|_| err("invalid_ota_document"))?;
    let request: Request =
        serde_json::from_slice(&canonical).map_err(|_| err("invalid_ota_document"))?;
    ensure(
        serde_jcs::to_vec(&request).ok().as_ref() == Some(&canonical),
        "invalid_ota_document",
    )?;
    Ok(request)
}

pub fn parse_document(raw: &[u8]) -> Result<Request> {
    typed_request(&request_value(raw)?)
}

pub fn verify_document(raw: &[u8], image: impl Read, now: DateTime<Utc>) -> Verification {
    let mut report = Verification {
        version: 1,
        verifier: VERIFIER,
        valid: false,
        request_digest: None,
        image_size_bytes: None,
        image_sha256: None,
        issues: Vec::new(),
    };
    let result = (|| {
        let value = request_value(raw)?;
        report.request_digest = Some(crate::digest(&value)?);
        let request = typed_request(&value)?;
        check_request(&request, now)?;
        let (size, hash) = read_image(image, request.manifest.statement.size_bytes)?;
        report.image_size_bytes = Some(size);
        report.image_sha256 = Some(hash.clone());
        ensure(
            hash == request.manifest.statement.sha256,
            "ota_image_digest_mismatch",
        )
    })();
    match result {
        Ok(()) => report.valid = true,
        Err(error) => issue(&mut report.issues, "", &error.code),
    }
    report
}
