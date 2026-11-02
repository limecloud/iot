use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::{DateTime, Utc};
use limeiot_core::{
    digest,
    release::{self, verify_artifact, verify_document, Artifact, SIGNING_DOMAIN},
};
use ring::signature::Ed25519KeyPair;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../../contracts/examples/model-release.json"
    ))
    .unwrap()
}
fn now() -> DateTime<Utc> {
    "2026-11-02T00:00:00Z".parse().unwrap()
}
fn bytes(value: &Value) -> Vec<u8> {
    serde_json::to_vec(value).unwrap()
}
fn resign(value: &mut Value) {
    let seed = fixture()["seed_hex"]
        .as_str()
        .unwrap()
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
        .collect::<Vec<_>>();
    let key = Ed25519KeyPair::from_seed_unchecked(&seed).unwrap();
    let mut unsigned = value.clone();
    unsigned.as_object_mut().unwrap().remove("signature");
    let mut message = SIGNING_DOMAIN.to_vec();
    message.extend(serde_jcs::to_vec(&unsigned).unwrap());
    value["signature"] = json!(STANDARD.encode(key.sign(&message).as_ref()));
}
fn rejected(artifact: &Value, trust: &Value, code: &str) {
    let error = verify_artifact(&bytes(artifact), &bytes(trust), now()).unwrap_err();
    assert_eq!(error.code, code);
    let source = json!({"artifact":artifact,"trust":trust});
    let report = verify_document(&bytes(&source), now());
    assert!(!report.valid);
    assert!(report.release.is_none());
    assert_eq!(report.artifact_digest, Some(digest(artifact).unwrap()));
    assert_eq!(report.trust_digest, Some(digest(trust).unwrap()));
    assert_eq!(report.issues[0].code, code);
}

#[test]
fn external_signature_vector_binds_source_projection_and_headers() {
    let f = fixture();
    assert_eq!(f["test_only"], true);
    for field in ["artifact", "upgrade"] {
        let artifact = verify_artifact(&bytes(&f[field]), &bytes(&f["trust"]), now()).unwrap();
        assert_eq!(digest(&artifact).unwrap(), digest(&f[field]).unwrap());
        assert_eq!(
            digest(&artifact.statement.model).unwrap(),
            artifact.statement.model_revision
        );
        let report = verify_document(
            &bytes(&json!({"artifact":f[field],"trust":f["trust"]})),
            now(),
        );
        assert!(report.valid && report.issues.is_empty());
        assert_eq!(report.verifier, release::VERIFIER);
        assert_eq!(
            report.artifact_digest,
            Some(digest(&report.release.unwrap()).unwrap())
        );
    }
    let artifact: Artifact = serde_json::from_value(f["artifact"].clone()).unwrap();
    let message = release::signing_message(&artifact).unwrap();
    assert_eq!(
        format!("sha256:{:x}", Sha256::digest(message)),
        f["signing_message_digest"].as_str().unwrap()
    );
    assert_eq!(
        digest(&f["source_model"]).unwrap(),
        artifact.statement.source_document_digest
    );
    assert_ne!(
        artifact.statement.source_document_digest,
        artifact.statement.model_revision
    );
}

#[test]
fn explicit_trust_scope_and_domain_separation_cannot_be_substituted() {
    let f = fixture();
    let mut trust = f["trust"].clone();
    trust["issuer"] = json!("https://other.example.test");
    rejected(&f["artifact"], &trust, "untrusted_release");
    trust = f["trust"].clone();
    trust["publisher_id"] = json!(format!("publisher-{}", "a".repeat(64)));
    trust["namespace"] = json!(format!("p-{}", "a".repeat(30)));
    rejected(&f["artifact"], &trust, "untrusted_release");
    trust = f["trust"].clone();
    trust["namespace"] = json!("p-forged");
    rejected(&f["artifact"], &trust, "invalid_trust_document");
    trust = f["trust"].clone();
    trust["public_key"] = json!(trust["public_key"].as_str().unwrap().trim_end_matches('='));
    rejected(&f["artifact"], &trust, "invalid_release_key");
    trust = f["trust"].clone();
    trust["signing_key_id"] = json!(format!("sha256:{}", "0".repeat(64)));
    rejected(&f["artifact"], &trust, "invalid_release_key");
    for issuer in [
        "https://control.example.test/",
        "https://control.example.test:443",
        "https://CONTROL.example.test",
        "http://192.168.1.2",
        "https://user@control.example.test",
        "https://control.example.test?x=1",
    ] {
        trust = f["trust"].clone();
        trust["issuer"] = json!(issuer);
        rejected(&f["artifact"], &trust, "invalid_trust_document");
    }
    let mut artifact = f["artifact"].clone();
    artifact["signature"] = json!("bad");
    rejected(&artifact, &f["trust"], "invalid_release_signature");
    let key = Ed25519KeyPair::from_seed_unchecked(&[7_u8; 32]).unwrap();
    let parsed: Artifact = serde_json::from_value(f["artifact"].clone()).unwrap();
    let message = release::signing_message(&parsed).unwrap();
    artifact["signature"] = json!(STANDARD.encode(key.sign(&message).as_ref()));
    rejected(&artifact, &f["trust"], "invalid_release_signature");
    // 即使用已知测试密钥签名，少域分隔符仍不能作为模型发布签名。
    let seed = Vec::from_iter(
        f["seed_hex"]
            .as_str()
            .unwrap()
            .as_bytes()
            .chunks_exact(2)
            .map(|p| u8::from_str_radix(std::str::from_utf8(p).unwrap(), 16).unwrap()),
    );
    let key = Ed25519KeyPair::from_seed_unchecked(&seed).unwrap();
    artifact["signature"] =
        json!(STANDARD.encode(key.sign(&message[SIGNING_DOMAIN.len()..]).as_ref()));
    rejected(&artifact, &f["trust"], "invalid_release_signature");
}

#[test]
fn legacy_validator_attestation_cannot_authorize_schema_two() {
    let f = fixture();
    let mut artifact = f["artifact"].clone();
    artifact["statement"]["model"]["schema_version"] = json!(2);
    resign(&mut artifact);
    rejected(&artifact, &f["trust"], "unsupported_release_contract");
}

#[test]
fn tampering_any_signed_identity_or_model_is_rejected() {
    let f = fixture();
    for pointer in [
        "/statement/product_id",
        "/statement/release_id",
        "/statement/source_revision",
        "/statement/source_document_digest",
        "/statement/model_revision",
        "/statement/model/model_version",
        "/statement/published_at",
    ] {
        let mut value = f["artifact"].clone();
        let field = value.pointer_mut(pointer).unwrap();
        let text = field.as_str().unwrap();
        *field = json!(if let Some(prefix) = text.strip_suffix('0') {
            format!("{prefix}1")
        } else {
            format!("{}0", &text[..text.len() - 1])
        });
        rejected(&value, &f["trust"], "invalid_release_signature");
    }
    let mut value = f["artifact"].clone();
    value["statement"]["model"]["services"][0]["properties"][0]["max_age_ms"] = json!(5);
    rejected(&value, &f["trust"], "invalid_release_signature");
}

#[test]
fn authentic_signatures_do_not_override_model_and_release_rules() {
    let f = fixture();
    for (pointer, replacement, code) in [
        ("/version", json!(2), "unsupported_release_contract"),
        ("/algorithm", json!("HS256"), "unsupported_release_contract"),
        (
            "/statement/validator",
            json!("limeiot.model/future"),
            "unsupported_release_contract",
        ),
        (
            "/statement/visibility",
            json!("private"),
            "invalid_release_identity",
        ),
        (
            "/statement/source_revision",
            json!("unsafe"),
            "invalid_release_identity",
        ),
        (
            "/statement/model_revision",
            json!(format!("sha256:{}", "0".repeat(64))),
            "release_model_revision_mismatch",
        ),
        (
            "/statement/model/services/0/properties/0/max_age_ms",
            json!(0),
            "invalid_release_model",
        ),
        (
            "/statement/published_at",
            json!("2027-01-01T00:00:00Z"),
            "release_from_future",
        ),
        (
            "/statement/published_at",
            json!("2026-01-01T00:00:00+00:00"),
            "invalid_release_time",
        ),
        (
            "/statement/published_at",
            json!("2016-12-31T23:59:60Z"),
            "invalid_release_time",
        ),
        (
            "/statement/baseline",
            json!({"release_id":f["artifact"]["statement"]["release_id"],"model_revision":format!("sha256:{}","0".repeat(64)),"model_version":"0.0.1"}),
            "invalid_release_baseline",
        ),
    ] {
        let mut value = f["artifact"].clone();
        *value.pointer_mut(pointer).unwrap() = replacement;
        resign(&mut value);
        rejected(&value, &f["trust"], code);
    }
    let mut value = f["artifact"].clone();
    value["statement"]["model"]["model_id"] = json!("urn:limeiot:model:impersonation:1");
    value["statement"]["model_revision"] = json!(digest(&value["statement"]["model"]).unwrap());
    resign(&mut value);
    rejected(&value, &f["trust"], "release_model_namespace_mismatch");
    for change in ["missing_baseline", "non_normalized_model", "extra_header"] {
        let mut value = f["artifact"].clone();
        match change {
            "missing_baseline" => {
                value["statement"]
                    .as_object_mut()
                    .unwrap()
                    .remove("baseline");
            }
            "non_normalized_model" => {
                value["statement"]["model"]["services"][0]["properties"][0]["schema"]
                    ["properties"] = json!({});
            }
            _ => {
                value["public_key"] = f["trust"]["public_key"].clone();
            }
        }
        resign(&mut value);
        rejected(&value, &f["trust"], "invalid_release_document");
    }
    for version in ["1.0.0", "4294967296.0.0", "01.0.0"] {
        let mut value = f["upgrade"].clone();
        value["statement"]["baseline"]["model_version"] = json!(version);
        if version == "1.0.0" {
            value["statement"]["baseline"]["model_revision"] =
                value["statement"]["model_revision"].clone();
        }
        resign(&mut value);
        rejected(&value, &f["trust"], "invalid_release_baseline");
    }
}

#[test]
fn future_time_budget_is_exact_and_loopback_issuers_are_scoped() {
    let f = fixture();
    let mut artifact = f["artifact"].clone();
    artifact["statement"]["published_at"] = json!("2026-11-02T00:05:00Z");
    resign(&mut artifact);
    verify_artifact(&bytes(&artifact), &bytes(&f["trust"]), now()).unwrap();
    artifact["statement"]["published_at"] = json!("2026-11-02T00:05:01Z");
    resign(&mut artifact);
    rejected(&artifact, &f["trust"], "release_from_future");
    let fractional: DateTime<Utc> = "2026-11-02T00:00:00.500Z".parse().unwrap();
    assert_eq!(
        verify_artifact(&bytes(&artifact), &bytes(&f["trust"]), fractional)
            .unwrap_err()
            .code,
        "release_from_future"
    );
    for issuer in ["http://127.0.0.1:17890", "http://[::1]:17890"] {
        let mut trust = f["trust"].clone();
        trust["issuer"] = json!(issuer);
        artifact = f["artifact"].clone();
        artifact["statement"]["issuer"] = json!(issuer);
        resign(&mut artifact);
        verify_artifact(&bytes(&artifact), &bytes(&trust), now()).unwrap();
    }
}

#[test]
fn malformed_json_and_capacity_fail_without_trusting_embedded_keys() {
    for raw in [
        b"{}".to_vec(),
        br#"{"artifact":{},"trust":{},"extra":true}"#.to_vec(),
        br#"{"artifact":{},"trust":{},"trust":{}}"#.to_vec(),
        br#"{"artifact":{"a":1,"a":2},"trust":{}}"#.to_vec(),
        br#"{"artifact":{"a":"\ud800"},"trust":{}}"#.to_vec(),
        vec![b' '; release::MAX_REQUEST_BYTES + 1],
    ] {
        let report = verify_document(&raw, now());
        assert!(!report.valid);
        assert!(report.artifact_digest.is_none() && report.trust_digest.is_none());
        assert_eq!(report.issues[0].code, "invalid_verification_document");
    }
    let f = fixture();
    let mut artifact = f["artifact"].clone();
    artifact["signature"] = json!("x".repeat(release::MAX_ARTIFACT_BYTES));
    rejected(&artifact, &f["trust"], "invalid_release_document");
}
