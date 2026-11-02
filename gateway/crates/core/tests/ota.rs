use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::{DateTime, Utc};
use limeiot_core::{
    digest,
    ota::{self, Manifest, SIGNING_DOMAIN},
};
use ring::signature::Ed25519KeyPair;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    cell::Cell,
    io::{self, Read},
};

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../../contracts/examples/ota-firmware.json"
    ))
    .unwrap()
}
fn now() -> DateTime<Utc> {
    "2026-11-02T00:00:00Z".parse().unwrap()
}
fn image() -> Vec<u8> {
    STANDARD
        .decode(fixture()["image_base64"].as_str().unwrap())
        .unwrap()
}
fn key() -> Ed25519KeyPair {
    Ed25519KeyPair::from_seed_unchecked(&[23; 32]).unwrap()
}
fn resign(request: &mut Value) {
    let mut unsigned = request["manifest"].clone();
    unsigned.as_object_mut().unwrap().remove("signature");
    let mut message = SIGNING_DOMAIN.to_vec();
    message.extend(serde_jcs::to_vec(&unsigned).unwrap());
    request["manifest"]["signature"] = json!(STANDARD.encode(key().sign(&message).as_ref()));
}
fn verify(request: &Value) -> ota::Verification {
    ota::verify_document(
        &serde_json::to_vec(request).unwrap(),
        image().as_slice(),
        now(),
    )
}
fn rejected(request: &Value, code: &str) {
    let report = verify(request);
    assert!(!report.valid, "expected {code}");
    assert_eq!(report.issues[0].code, code);
    assert_eq!(report.request_digest, Some(digest(request).unwrap()));
}

#[test]
fn independent_vector_binds_domain_headers_request_and_actual_image() {
    let f = fixture();
    assert_eq!(f["test_only"], true);
    let report = verify(&f["request"]);
    assert!(report.valid && report.issues.is_empty());
    assert_eq!(
        report.request_digest.as_deref(),
        f["request_digest"].as_str()
    );
    assert_eq!(
        report.image_sha256,
        f["request"]["manifest"]["statement"]["sha256"]
            .as_str()
            .map(String::from)
    );
    assert_eq!(report.image_size_bytes, Some(image().len() as u32));
    let manifest: Manifest = serde_json::from_value(f["request"]["manifest"].clone()).unwrap();
    assert_eq!(
        format!(
            "sha256:{:x}",
            Sha256::digest(ota::signing_message(&manifest).unwrap())
        ),
        f["signing_message_digest"].as_str().unwrap()
    );
}

#[test]
fn every_signed_statement_field_is_bound_and_model_signature_domain_is_rejected() {
    let f = fixture();
    for pointer in [
        "/manifest/statement/artifact_id",
        "/manifest/statement/version",
        "/manifest/statement/target/board",
        "/manifest/statement/issued_at",
        "/manifest/statement/expires_at",
        "/manifest/statement/sha256",
        "/manifest/statement/download/url",
        "/manifest/statement/compatibility/minimum_bootloader_version",
    ] {
        let mut request = f["request"].clone();
        *request.pointer_mut(pointer).unwrap() = json!("tampered");
        rejected(&request, "invalid_ota_signature");
    }
    for pointer in [
        "/manifest/statement/security_epoch",
        "/manifest/statement/size_bytes",
    ] {
        let mut request = f["request"].clone();
        *request.pointer_mut(pointer).unwrap() = json!(99);
        rejected(&request, "invalid_ota_signature");
    }
    let mut request = f["request"].clone();
    let mut unsigned = request["manifest"].clone();
    unsigned.as_object_mut().unwrap().remove("signature");
    let mut message = limeiot_core::release::SIGNING_DOMAIN.to_vec();
    message.extend(serde_jcs::to_vec(&unsigned).unwrap());
    request["manifest"]["signature"] = json!(STANDARD.encode(key().sign(&message).as_ref()));
    rejected(&request, "invalid_ota_signature");
    request = f["request"].clone();
    request["trust"]["purpose"] = json!("model-release");
    rejected(&request, "unsupported_ota_contract");
}

#[test]
fn independent_trust_scope_key_revocation_and_canonical_encoding_are_required() {
    let f = fixture();
    for (pointer, value, error) in [
        (
            "/trust/product_ids",
            json!(["another-product"]),
            "untrusted_ota_product",
        ),
        ("/trust/public_key", json!("invalid"), "invalid_ota_key"),
        (
            "/trust/signing_key_id",
            json!(format!("sha256:{}", "0".repeat(64))),
            "untrusted_ota_key",
        ),
        (
            "/manifest/signing_key_id",
            json!(format!("sha256:{}", "0".repeat(64))),
            "untrusted_ota_key",
        ),
        (
            "/manifest/signature",
            json!("invalid"),
            "invalid_ota_signature",
        ),
        (
            "/trust/revoked_artifact_ids",
            json!([f["request"]["manifest"]["statement"]["artifact_id"]]),
            "ota_artifact_revoked",
        ),
        (
            "/trust/product_ids",
            json!(["desk-node-lamp", "desk-node-lamp"]),
            "invalid_ota_trust",
        ),
        (
            "/trust/download_origins",
            json!(["https://firmware.example.test/"]),
            "invalid_ota_trust",
        ),
        (
            "/trust/download_origins",
            json!(["http://firmware.example.test"]),
            "invalid_ota_trust",
        ),
    ] {
        let mut request = f["request"].clone();
        *request.pointer_mut(pointer).unwrap() = value;
        rejected(&request, error);
    }
    let mut request = f["request"].clone();
    request["trust"]["public_key"] = json!(request["trust"]["public_key"]
        .as_str()
        .unwrap()
        .trim_end_matches('='));
    rejected(&request, "invalid_ota_key");
}

#[test]
fn exact_hardware_and_explicit_version_model_and_bootloader_conditions_are_required() {
    let f = fixture();
    for field in [
        "product_id",
        "architecture",
        "chip",
        "board",
        "hardware_revision",
    ] {
        let mut request = f["request"].clone();
        request["device"][field] = json!("other");
        rejected(&request, "ota_target_mismatch");
    }
    for (field, value) in [
        ("firmware_version", json!("0.0.1")),
        ("bootloader_version", json!("0.0.9")),
        (
            "model_revision",
            json!(format!("sha256:{}", "0".repeat(64))),
        ),
    ] {
        let mut request = f["request"].clone();
        request["device"][field] = value;
        rejected(&request, "ota_device_incompatible");
    }
    for value in [json!(2), json!(0)] {
        let mut request = f["request"].clone();
        request["device"]["protocol_version"] = value;
        rejected(&request, "invalid_ota_device");
    }
    let mut request = f["request"].clone();
    request["manifest"]["statement"]["compatibility"]["from_versions"] = json!(["0.1.0", "0.2.0"]);
    resign(&mut request);
    rejected(&request, "invalid_ota_compatibility");
    request = f["request"].clone();
    request["manifest"]["statement"]["version"] = json!("0.1.0");
    resign(&mut request);
    rejected(&request, "invalid_ota_compatibility");
}

#[test]
fn security_floor_partition_power_and_busy_state_do_not_follow_signature_success() {
    let f = fixture();
    for (pointer, value, error) in [
        (
            "/device/security_epoch",
            json!(2),
            "ota_downgrade_forbidden",
        ),
        (
            "/trust/minimum_security_epoch",
            json!(2),
            "ota_downgrade_forbidden",
        ),
        (
            "/device/ota_capacity_bytes",
            json!(image().len() - 1),
            "ota_partition_too_small",
        ),
        ("/device/safe_to_update", json!(false), "ota_device_busy"),
        ("/device/pending_update", json!(true), "ota_device_busy"),
        ("/device/battery_percent", json!(101), "invalid_ota_device"),
    ] {
        let mut request = f["request"].clone();
        *request.pointer_mut(pointer).unwrap() = value;
        rejected(&request, error);
    }
    let mut request = f["request"].clone();
    request["device"]["external_power"] = json!(false);
    rejected(&request, "ota_insufficient_power");
    request["device"]["battery_percent"] = json!(29);
    rejected(&request, "ota_insufficient_power");
    request["device"]["battery_percent"] = json!(30);
    assert!(verify(&request).valid);
    request["device"]["ota_capacity_bytes"] = json!(image().len());
    assert!(verify(&request).valid);
}

#[test]
fn trusted_clock_and_expiry_boundaries_are_exact_and_bounded_by_trust() {
    let f = fixture();
    let raw = serde_json::to_vec(&f["request"]).unwrap();
    for (at, valid) in [
        ("2026-10-31T23:59:59Z", false),
        ("2026-11-01T00:00:00Z", true),
        ("2098-12-31T23:59:59Z", true),
        ("2099-01-01T00:00:00Z", false),
    ] {
        let report = ota::verify_document(&raw, image().as_slice(), at.parse().unwrap());
        assert_eq!(report.valid, valid);
        if !valid {
            assert_eq!(report.issues[0].code, "ota_outside_validity");
        }
    }
    let mut request = f["request"].clone();
    request["trust"]["expires_at"] = json!("2027-01-01T00:00:00Z");
    rejected(&request, "invalid_ota_validity");
    for value in [
        "2026-11-01T00:00:00+00:00",
        "2026-11-01T00:00:00.000Z",
        "bad",
    ] {
        request = f["request"].clone();
        request["manifest"]["statement"]["issued_at"] = json!(value);
        resign(&mut request);
        rejected(&request, "invalid_ota_time");
    }
}

#[test]
fn signed_url_is_https_canonical_exact_origin_and_has_no_redirect_or_credentials() {
    let f = fixture();
    for value in [
        "http://firmware.example.test/firmware.bin",
        "https://user:secret@firmware.example.test/image",
        "https://firmware.example.test/image?key=secret",
        "https://firmware.example.test/image#part",
        "https://FIRMWARE.example.test/image",
        "https://firmware.example.test:443/image",
    ] {
        let mut request = f["request"].clone();
        request["manifest"]["statement"]["download"]["url"] = json!(value);
        resign(&mut request);
        rejected(&request, "invalid_ota_download");
    }
    for value in [
        "https://other.example.test/image",
        "https://firmware.example.test/",
    ] {
        let mut request = f["request"].clone();
        request["manifest"]["statement"]["download"]["url"] = json!(value);
        resign(&mut request);
        rejected(&request, "untrusted_ota_download");
    }
    let mut request = f["request"].clone();
    request["manifest"]["statement"]["download"]["redirects"] = json!(true);
    resign(&mut request);
    rejected(&request, "untrusted_ota_download");
}

struct Unreadable;
impl Read for Unreadable {
    fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
        Err(io::Error::other("fixture"))
    }
}
struct Counter<'a>(&'a Cell<usize>);
impl Read for Counter<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        self.0.set(self.0.get() + buffer.len());
        buffer.fill(0);
        Ok(buffer.len())
    }
}

#[test]
fn image_is_streamed_with_exact_size_digest_io_and_read_budget() {
    let request = fixture()["request"].clone();
    let raw = serde_json::to_vec(&request).unwrap();
    let image = image();
    for bytes in [
        &image[..image.len() - 1],
        &[image.as_slice(), b"extra"].concat()[..],
    ] {
        let report = ota::verify_document(&raw, bytes, now());
        assert!(!report.valid);
        assert_eq!(report.issues[0].code, "ota_image_size_mismatch");
        assert_eq!(report.image_sha256, None);
    }
    let bad_image = vec![0; image.len()];
    let report = ota::verify_document(&raw, bad_image.as_slice(), now());
    assert!(!report.valid);
    assert_eq!(report.issues[0].code, "ota_image_digest_mismatch");
    assert_eq!(report.image_size_bytes, Some(image.len() as u32));
    let report = ota::verify_document(&raw, Unreadable, now());
    assert_eq!(report.issues[0].code, "ota_image_io");
    let count = Cell::new(0);
    let report = ota::verify_document(&raw, Counter(&count), now());
    assert_eq!(report.issues[0].code, "ota_image_size_mismatch");
    assert_eq!(count.get(), image.len() + 1);
    let mut bad = request;
    bad["manifest"]["signature"] = json!("invalid");
    count.set(0);
    let report = ota::verify_document(&serde_json::to_vec(&bad).unwrap(), Counter(&count), now());
    assert_eq!(report.issues[0].code, "invalid_ota_signature");
    assert_eq!(count.get(), 0);
}

#[test]
fn malformed_ambiguous_oversized_and_incomplete_json_never_reads_the_image() {
    for raw in [
        b"{}".to_vec(),
        b"{\"manifest\":{},\"manifest\":{}}".to_vec(),
        br#"{"x":"\ud800"}"#.to_vec(),
        vec![b' '; ota::MAX_REQUEST_BYTES + 1],
    ] {
        let count = Cell::new(0);
        let report = ota::verify_document(&raw, Counter(&count), now());
        assert!(!report.valid);
        assert_eq!(report.issues[0].code, "invalid_ota_document");
        assert_eq!(count.get(), 0);
    }
    let mut request = fixture()["request"].clone();
    request["device"]
        .as_object_mut()
        .unwrap()
        .remove("battery_percent");
    rejected(&request, "invalid_ota_document");
    request = fixture()["request"].clone();
    request["manifest"]["public_key"] = fixture()["request"]["trust"]["public_key"].clone();
    rejected(&request, "invalid_ota_document");
    for value in [json!(0), json!(ota::MAX_IMAGE_BYTES + 1)] {
        request = fixture()["request"].clone();
        request["manifest"]["statement"]["size_bytes"] = value;
        resign(&mut request);
        rejected(&request, "invalid_ota_manifest");
    }
}
