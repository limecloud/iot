//! 签名制品与外部显式信任。验签不授予安装、设备绑定或OTA权限。
use crate::{
    compatibility, ensure, err,
    model::Model,
    validation::{self, bounded_document, issue, Issue},
    Result,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::{DateTime, SecondsFormat, Utc};
use ring::signature::{UnparsedPublicKey, ED25519};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const VERIFIER: &str = "limeiot.model-release/1.0.0";
pub const SIGNING_DOMAIN: &[u8] = b"LimeIoT Model Release v1\n";
pub const MAX_ARTIFACT_BYTES: usize = 12_288;
pub const MAX_TRUST_BYTES: usize = 2_048;
pub const MAX_REQUEST_BYTES: usize = 16_384;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Baseline {
    pub release_id: String,
    pub model_revision: String,
    pub model_version: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Statement {
    pub issuer: String,
    pub publisher_id: String,
    pub namespace: String,
    pub product_id: String,
    pub release_id: String,
    pub source_revision: String,
    pub source_document_digest: String,
    pub visibility: String,
    pub validator: String,
    pub compatibility_checker: String,
    pub model_revision: String,
    pub model: Model,
    pub baseline: Option<Baseline>,
    pub published_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Artifact {
    pub version: u8,
    pub algorithm: String,
    pub signing_key_id: String,
    pub statement: Statement,
    pub signature: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Trust {
    pub version: u8,
    pub issuer: String,
    pub publisher_id: String,
    pub namespace: String,
    pub signing_key_id: String,
    pub public_key: String,
}

#[derive(Debug, Serialize)]
pub struct Verification {
    pub version: u8,
    pub verifier: &'static str,
    pub valid: bool,
    pub artifact_digest: Option<String>,
    pub trust_digest: Option<String>,
    pub release: Option<Artifact>,
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
fn namespace(publisher: &str, value: &str) -> bool {
    hex_id(publisher, "publisher-") && value == format!("p-{}", &publisher[10..40])
}
fn origin(value: &str) -> bool {
    let Ok(url) = url::Url::parse(value) else {
        return false;
    };
    value.len() <= 400
        && url.origin().ascii_serialization() == value
        && url.username().is_empty()
        && url.password().is_none()
        && url.path() == "/"
        && url.query().is_none()
        && url.fragment().is_none()
        && (url.scheme() == "https"
            || url.scheme() == "http"
                && url.host_str().is_some_and(|host| {
                    host.trim_start_matches('[')
                        .trim_end_matches(']')
                        .parse::<std::net::IpAddr>()
                        .is_ok_and(|ip| ip.is_loopback())
                }))
}

// 强制字段齐全及规范模型投影；只允许空白、键序和JCS等价数值表示的差别。
fn document<T: DeserializeOwned + Serialize>(
    raw: &[u8],
    bytes: usize,
    depth: usize,
    nodes: usize,
) -> Option<T> {
    let value = bounded_document(raw, bytes, depth, nodes)?;
    let canonical = serde_jcs::to_vec(&value).ok()?;
    let parsed: T = serde_json::from_slice(&canonical).ok()?;
    (serde_jcs::to_vec(&parsed).ok()? == canonical).then_some(parsed)
}

fn decoded(value: &str, size: usize) -> Option<Vec<u8>> {
    let bytes = STANDARD.decode(value).ok()?;
    (bytes.len() == size && STANDARD.encode(&bytes) == value).then_some(bytes)
}
pub fn signing_key_id(public_key: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(public_key))
}

#[derive(Serialize)]
struct Unsigned<'a> {
    version: u8,
    algorithm: &'a str,
    signing_key_id: &'a str,
    statement: &'a Statement,
}
pub fn signing_message(artifact: &Artifact) -> Result<Vec<u8>> {
    let unsigned = Unsigned {
        version: artifact.version,
        algorithm: &artifact.algorithm,
        signing_key_id: &artifact.signing_key_id,
        statement: &artifact.statement,
    };
    let mut message = SIGNING_DOMAIN.to_vec();
    message.extend(serde_jcs::to_vec(&unsigned).map_err(|_| err("invalid_release_document"))?);
    Ok(message)
}

pub fn verify_trust(raw: &[u8]) -> Result<Trust> {
    let trust: Trust =
        document(raw, MAX_TRUST_BYTES, 2, 16).ok_or_else(|| err("invalid_trust_document"))?;
    ensure(
        trust.version == 1
            && origin(&trust.issuer)
            && namespace(&trust.publisher_id, &trust.namespace),
        "invalid_trust_document",
    )?;
    let public = decoded(&trust.public_key, 32).ok_or_else(|| err("invalid_release_key"))?;
    ensure(
        trust.signing_key_id == signing_key_id(&public),
        "invalid_release_key",
    )?;
    Ok(trust)
}

pub fn verify_artifact(raw: &[u8], trust_raw: &[u8], now: DateTime<Utc>) -> Result<Artifact> {
    let artifact: Artifact = document(raw, MAX_ARTIFACT_BYTES, 18, 2304)
        .ok_or_else(|| err("invalid_release_document"))?;
    let trust = verify_trust(trust_raw)?;
    let current_contract = artifact.statement.validator == validation::VALIDATOR
        && artifact.statement.compatibility_checker == compatibility::CHECKER;
    // 已签名旧制品保持原字节；旧校验器声明不能为新增动作定义背书。
    let legacy_contract = artifact.statement.validator == "limeiot.model/1.0.0"
        && artifact.statement.compatibility_checker == "limeiot.model-compatibility/1.0.0"
        && artifact.statement.model.schema_version == 1
        && artifact
            .statement
            .model
            .services
            .iter()
            .all(|s| s.actions.is_empty());
    ensure(
        artifact.version == 1
            && artifact.algorithm == "Ed25519"
            && trust.version == 1
            && (current_contract || legacy_contract),
        "unsupported_release_contract",
    )?;
    let public = decoded(&trust.public_key, 32).ok_or_else(|| err("invalid_release_key"))?;
    let statement = &artifact.statement;
    ensure(
        statement.issuer == trust.issuer
            && statement.publisher_id == trust.publisher_id
            && statement.namespace == trust.namespace
            && artifact.signing_key_id == trust.signing_key_id,
        "untrusted_release",
    )?;
    let signature =
        decoded(&artifact.signature, 64).ok_or_else(|| err("invalid_release_signature"))?;
    UnparsedPublicKey::new(&ED25519, &public)
        .verify(&signing_message(&artifact)?, &signature)
        .map_err(|_| err("invalid_release_signature"))?;
    ensure(
        statement.visibility == "public"
            && hex_id(&statement.product_id, "product-")
            && hex_id(&statement.release_id, "release-")
            && hex_id(&statement.source_revision, "prodrev-")
            && hex_id(&statement.source_document_digest, "sha256:")
            && hex_id(&statement.model_revision, "sha256:"),
        "invalid_release_identity",
    )?;
    let model_raw =
        serde_jcs::to_vec(&statement.model).map_err(|_| err("invalid_release_model"))?;
    let checked = validation::validate_document(&model_raw);
    ensure(checked.valid, "invalid_release_model")?;
    ensure(
        checked.model_revision.as_ref() == Some(&statement.model_revision),
        "release_model_revision_mismatch",
    )?;
    ensure(
        statement
            .model
            .model_id
            .starts_with(&format!("urn:{}:", statement.namespace)),
        "release_model_namespace_mismatch",
    )?;
    if let Some(baseline) = &statement.baseline {
        ensure(
            hex_id(&baseline.release_id, "release-")
                && hex_id(&baseline.model_revision, "sha256:")
                && baseline.release_id != statement.release_id
                && baseline.model_revision != statement.model_revision
                && validation::version(&baseline.model_version)
                && compatibility::version(&baseline.model_version)
                    < compatibility::version(&statement.model.model_version),
            "invalid_release_baseline",
        )?;
    }
    let published = DateTime::parse_from_rfc3339(&statement.published_at)
        .map_err(|_| err("invalid_release_time"))?
        .with_timezone(&Utc);
    ensure(
        statement.published_at.len() == 20
            && published.timestamp() >= 0
            && published.timestamp_subsec_nanos() == 0
            && published.to_rfc3339_opts(SecondsFormat::Secs, true) == statement.published_at,
        "invalid_release_time",
    )?;
    ensure(
        published.signed_duration_since(now) <= chrono::Duration::seconds(300),
        "release_from_future",
    )?;
    Ok(artifact)
}

fn issue_path(code: &str) -> &'static str {
    match code {
        "invalid_trust_document" => "/trust",
        "invalid_release_key" => "/trust/public_key",
        "invalid_release_signature" => "/artifact/signature",
        "invalid_release_model" => "/artifact/statement/model",
        "release_model_revision_mismatch" => "/artifact/statement/model_revision",
        "release_model_namespace_mismatch" => "/artifact/statement/model/model_id",
        "invalid_release_baseline" => "/artifact/statement/baseline",
        "invalid_release_time" | "release_from_future" => "/artifact/statement/published_at",
        _ => "/artifact",
    }
}

pub fn verify_document(raw: &[u8], now: DateTime<Utc>) -> Verification {
    let mut report = Verification {
        version: 1,
        verifier: VERIFIER,
        valid: false,
        artifact_digest: None,
        trust_digest: None,
        release: None,
        issues: Vec::new(),
    };
    let parsed = bounded_document(raw, MAX_REQUEST_BYTES, 19, 4096);
    let Some(value) = parsed.filter(|value| {
        value.as_object().is_some_and(|v| {
            v.len() == 2
                && v.get("artifact").is_some_and(serde_json::Value::is_object)
                && v.get("trust").is_some_and(serde_json::Value::is_object)
        })
    }) else {
        issue(&mut report.issues, "", "invalid_verification_document");
        return report;
    };
    report.artifact_digest = crate::digest(&value["artifact"]).ok();
    report.trust_digest = crate::digest(&value["trust"]).ok();
    match verify_artifact(
        &serde_jcs::to_vec(&value["artifact"]).unwrap(),
        &serde_jcs::to_vec(&value["trust"]).unwrap(),
        now,
    ) {
        Ok(artifact) => {
            report.valid = true;
            report.release = Some(artifact);
        }
        Err(error) => issue(&mut report.issues, issue_path(&error.code), &error.code),
    }
    report
}
