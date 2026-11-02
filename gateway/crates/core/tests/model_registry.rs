use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::{DateTime, Duration, Utc};
use limeiot_core::{
    digest,
    engine::{Config, Data},
    model_registry::{parse_change, Change, Operation, Request, Resource},
    protocol::{CommandRequest, Envelope, Rule},
    release::{self, SIGNING_DOMAIN},
};
use ring::signature::Ed25519KeyPair;
use serde_json::{json, Value};

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../../contracts/examples/model-release.json"
    ))
    .unwrap()
}
fn now() -> DateTime<Utc> {
    "2026-11-02T00:00:00Z".parse().unwrap()
}
fn initial_data() -> Data {
    let config: Config =
        serde_json::from_str(include_str!("../../../../deploy/dev/config.json")).unwrap();
    Data::new(config).unwrap()
}
fn change(data: &mut Data, key: &str, change: Change) -> Operation {
    data.apply_model_change(
        Request {
            space_id: data.space_id.clone(),
            idempotency_key: key.into(),
            change,
        },
        now(),
    )
    .unwrap()
}
fn trust(data: &mut Data) -> limeiot_core::model_registry::PublisherTrust {
    let f = fixture();
    let result = change(
        data,
        "trust",
        Change::TrustAdd {
            trust: f["trust"].clone(),
            expected_signing_key_id: f["trust"]["signing_key_id"].as_str().unwrap().into(),
        },
    );
    assert_eq!(result.status, "applied");
    let Resource::Trust(trust) = result.result.unwrap() else {
        panic!()
    };
    trust
}
fn install(
    data: &mut Data,
    trusted: &str,
    key: &str,
    artifact: Value,
    baseline: Option<String>,
) -> Operation {
    change(
        data,
        key,
        Change::Install {
            trust_id: trusted.into(),
            artifact,
            expected_release_id: baseline,
        },
    )
}
fn installation(operation: &Operation) -> limeiot_core::model_registry::Installation {
    assert_eq!(operation.status, "applied", "{:?}", operation.reason);
    let Some(Resource::Installation(value)) = &operation.result else {
        panic!()
    };
    value.as_ref().clone()
}
fn bind(data: &mut Data, device: &str, installation: &str, key: &str) -> Operation {
    let expected_model_revision = data.devices.get(device).map(|v| v.model_revision.clone());
    let expected_binding_revision = data
        .model_registry
        .bindings
        .get(device)
        .map(|v| v.revision.clone());
    change(
        data,
        key,
        Change::Bind {
            device_id: device.into(),
            installation_id: installation.into(),
            expected_model_revision,
            expected_binding_revision,
        },
    )
}
fn resign(value: &mut Value) {
    let seed = fixture()["seed_hex"]
        .as_str()
        .unwrap()
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
        .collect::<Vec<_>>();
    let pair = Ed25519KeyPair::from_seed_unchecked(&seed).unwrap();
    value["statement"]["model_revision"] = json!(digest(&value["statement"]["model"]).unwrap());
    value["statement"]["source_document_digest"] = value["statement"]["model_revision"].clone();
    let mut unsigned = value.clone();
    unsigned.as_object_mut().unwrap().remove("signature");
    let mut message = SIGNING_DOMAIN.to_vec();
    message.extend(serde_jcs::to_vec(&unsigned).unwrap());
    value["signature"] = json!(STANDARD.encode(pair.sign(&message).as_ref()));
}
fn hello(data: &mut Data, device: &str, boot: &str) -> Envelope {
    let revision = data.devices[device].model_revision.clone();
    let message: Envelope = serde_json::from_value(json!({"v":1,"kind":"hello","message_id":format!("hello-{boot}"),"device_id":device,"model_revision":revision,"boot_id":boot,"seq":1,"body":{"challenge":"challenge"}})).unwrap();
    data.ingest(message, now()).unwrap().unwrap()
}
fn ready(data: &mut Data, device: &str, boot: &str) {
    let welcome = hello(data, device, boot);
    let message: Envelope = serde_json::from_value(json!({"v":1,"kind":"state","message_id":format!("state-{boot}"),"device_id":device,"model_revision":welcome.model_revision,"boot_id":boot,"session_id":welcome.session_id,"seq":2,
        "body":{"type":"snapshot","revision":1,"properties":[{"path":"light.power","value":false,"observed_at":now(),"quality":"confirmed","source":"simulator"},{"path":"light.brightness","value":50,"observed_at":now(),"quality":"confirmed","source":"simulator"}]}})).unwrap();
    data.ingest(message, now()).unwrap();
}
fn command(data: &mut Data, key: &str) -> limeiot_core::engine::Command {
    let request: CommandRequest = serde_json::from_value(json!({"space_id":data.space_id,"idempotency_key":key,"device_id":"device-lamp","model_revision":data.devices["device-lamp"].model_revision,
        "expires_at":now()+Duration::seconds(10),"operation":{"type":"property.set","path":"light.power","value":true}})).unwrap();
    data.create_command(request, now(), None).unwrap()
}

#[test]
fn explicit_fingerprint_and_local_trust_are_required_and_original_decisions_are_immutable() {
    let mut data = initial_data();
    let f = fixture();
    let result = change(
        &mut data,
        "wrong-fingerprint",
        Change::TrustAdd {
            trust: f["trust"].clone(),
            expected_signing_key_id: "sha256:wrong".into(),
        },
    );
    assert_eq!(result.status, "rejected");
    assert_eq!(
        result.reason.as_deref(),
        Some("signing_key_confirmation_mismatch")
    );
    assert!(data.model_registry.trusts.is_empty());
    let without = install(
        &mut data,
        "unapproved",
        "no-trust",
        f["artifact"].clone(),
        None,
    );
    assert_eq!(without.reason.as_deref(), Some("model_trust_not_found"));
    let trusted = trust(&mut data);
    assert_eq!(data.model_registry.trusts.len(), 1);
    assert_eq!(
        data.apply_model_change(result.request.clone(), now())
            .unwrap()
            .operation_id,
        result.operation_id
    );
    let mut changed = result.request;
    changed.change = Change::TrustAdd {
        trust: f["trust"].clone(),
        expected_signing_key_id: trusted.trust.signing_key_id,
    };
    assert_eq!(
        data.apply_model_change(changed, now()).unwrap_err().code,
        "idempotency_conflict"
    );
    let mut forbidden = without.request;
    forbidden.space_id = "other-space".into();
    assert_eq!(
        data.apply_model_change(forbidden, now()).unwrap_err().code,
        "forbidden"
    );
}

#[test]
fn strict_input_requires_explicit_null_and_rejects_duplicate_fields() {
    let source = json!({"type":"models.install","trust_id":"trust","artifact":{},"expected_release_id":null});
    parse_change(&serde_json::to_vec(&source).unwrap()).unwrap();
    let mut missing = source.clone();
    missing
        .as_object_mut()
        .unwrap()
        .remove("expected_release_id");
    assert!(parse_change(&serde_json::to_vec(&missing).unwrap()).is_err());
    assert!(parse_change(
        br#"{"type":"trust.revoke","trust_id":"a","trust_id":"b","expected_revision":"r"}"#
    )
    .is_err());
    assert!(parse_change(br#"{"type":"devices.bind","device_id":"new","installation_id":"i","expected_model_revision":null}"#).is_err());
    assert!(parse_change(br#"{"type":"devices.bind","device_id":"new","installation_id":"i","expected_model_revision":null,"expected_binding_revision":null,"extra":true}"#).is_err());
}

#[test]
fn installation_verifies_signature_and_preserves_devices_until_explicit_binding() {
    let mut data = initial_data();
    let trusted = trust(&mut data);
    let before = digest(&data.devices).unwrap();
    let f = fixture();
    let mut tampered = f["artifact"].clone();
    tampered["statement"]["model"]["model_version"] = json!("9.0.0");
    let invalid = install(&mut data, &trusted.trust_id, "tampered", tampered, None);
    assert_eq!(invalid.reason.as_deref(), Some("invalid_release_signature"));
    assert!(data.model_registry.installations.is_empty());
    let installed = installation(&install(
        &mut data,
        &trusted.trust_id,
        "install",
        f["artifact"].clone(),
        None,
    ));
    assert_eq!(digest(&data.devices).unwrap(), before);
    assert_eq!(
        data.model_registry.heads[&installed.artifact.statement.model.model_id],
        installed.installation_id
    );
    assert_eq!(
        data.models[&installed.artifact.statement.model_revision].model_id,
        installed.artifact.statement.model.model_id
    );
    let stale = install(
        &mut data,
        &trusted.trust_id,
        "stale-install",
        f["upgrade"].clone(),
        None,
    );
    assert_eq!(stale.status, "conflict");
    assert_eq!(data.model_registry.installations.len(), 1);
    data.validate_model_registry(now()).unwrap();
}

#[test]
fn local_upgrade_compares_the_installed_head_and_never_rolls_back_from_old_operations() {
    let mut data = initial_data();
    let trusted = trust(&mut data);
    let f = fixture();
    let first = install(
        &mut data,
        &trusted.trust_id,
        "install",
        f["artifact"].clone(),
        None,
    );
    let old = installation(&first);
    assert_eq!(
        bind(&mut data, "device-lamp", &old.installation_id, "bind").status,
        "applied"
    );
    let upgraded = installation(&install(
        &mut data,
        &trusted.trust_id,
        "upgrade",
        f["upgrade"].clone(),
        Some(old.artifact.statement.release_id.clone()),
    ));
    assert_eq!(
        data.devices["device-lamp"].model_revision,
        old.artifact.statement.model_revision
    );
    let old_result = data.apply_model_change(first.request, now()).unwrap();
    assert_eq!(old_result.operation_id, first.operation_id);
    assert_eq!(
        data.model_registry.heads[&old.artifact.statement.model.model_id],
        upgraded.installation_id
    );
    let downgrade = install(
        &mut data,
        &trusted.trust_id,
        "downgrade",
        f["artifact"].clone(),
        Some(upgraded.artifact.statement.release_id.clone()),
    );
    assert_eq!(downgrade.reason.as_deref(), Some("model_downgrade"));
    let mut candidate = f["upgrade"].clone();
    candidate["statement"]["release_id"] = json!(format!("release-{}", "8".repeat(64)));
    candidate["statement"]["model"]["model_version"] = json!("2.0.0");
    candidate["statement"]["model"]["services"][0]["properties"][1]["schema"]["maximum"] =
        json!(200);
    resign(&mut candidate);
    release::verify_artifact(
        &serde_json::to_vec(&candidate).unwrap(),
        &serde_json::to_vec(&f["trust"]).unwrap(),
        now(),
    )
    .unwrap();
    let incompatible = install(
        &mut data,
        &trusted.trust_id,
        "incompatible",
        candidate.clone(),
        Some(upgraded.artifact.statement.release_id.clone()),
    );
    assert_eq!(
        incompatible.reason.as_deref(),
        Some("incompatible_installed_model")
    );
    candidate["statement"]["model"]["services"][0]["properties"][1]["schema"]["maximum"] =
        json!(100);
    resign(&mut candidate);
    let skipped = installation(&install(
        &mut data,
        &trusted.trust_id,
        "skipped-version",
        candidate,
        Some(upgraded.artifact.statement.release_id.clone()),
    ));
    assert_eq!(skipped.artifact.statement.model.model_version, "2.0.0");
}

#[test]
fn binding_retires_old_sessions_and_revocation_blocks_control_without_falsifying_results() {
    let mut data = initial_data();
    let report_info = |data: &mut Data| {
        let vector: Value = serde_json::from_str(include_str!(
            "../../../../contracts/examples/ota-firmware.json"
        ))
        .unwrap();
        let device = &data.devices["device-lamp"];
        let mut body = vector["request"]["device"].clone();
        body["model_revision"] = json!(device.model_revision);
        let packet: Envelope = serde_json::from_value(json!({"v":1,"kind":"device_info","message_id":"info-model","device_id":"device-lamp","model_revision":device.model_revision,"boot_id":device.boot_id,"session_id":device.session_id,"seq":3,"body":body})).unwrap();
        data.ingest(packet, now()).unwrap();
        assert!(data.current_device_info("device-lamp", now()).is_ok());
    };
    ready(&mut data, "device-lamp", "old-boot");
    report_info(&mut data);
    let sent = command(&mut data, "sent");
    assert_eq!(data.prepare_dispatch(now()).len(), 1);
    let accepted = command(&mut data, "accepted");
    let trusted = trust(&mut data);
    let f = fixture();
    let installed = installation(&install(
        &mut data,
        &trusted.trust_id,
        "install",
        f["artifact"].clone(),
        None,
    ));
    let binding = bind(&mut data, "device-lamp", &installed.installation_id, "bind");
    assert_eq!(binding.status, "applied");
    let device = &data.devices["device-lamp"];
    assert!(!device.ready && device.session_id.is_none() && device.reported.is_empty());
    assert!(device.device_info.is_none());
    assert!(device.retired_boots.contains("old-boot"));
    assert_eq!(data.commands[&sent.command_id].status, "unknown");
    assert_eq!(data.commands[&accepted.command_id].status, "rejected");
    let old: Envelope = serde_json::from_value(json!({"v":1,"kind":"hello","message_id":"old","device_id":"device-lamp","model_revision":device.model_revision,"boot_id":"old-boot","seq":3,"body":{"challenge":"old-challenge"}})).unwrap();
    assert_eq!(data.ingest(old, now()).unwrap_err().code, "old_boot");
    ready(&mut data, "device-lamp", "new-boot");
    report_info(&mut data);
    assert!(data.devices["device-lamp"].ready);
    let pending = command(&mut data, "before-revoke");
    let revoked = change(
        &mut data,
        "revoke",
        Change::TrustRevoke {
            trust_id: trusted.trust_id.clone(),
            expected_revision: trusted.revision,
        },
    );
    assert_eq!(revoked.status, "applied");
    assert!(!data.devices["device-lamp"].ready);
    assert!(data.devices["device-lamp"].device_info.is_none());
    assert_eq!(
        data.current_device_info("device-lamp", now())
            .unwrap_err()
            .code,
        "model_trust_revoked"
    );
    assert_eq!(data.commands[&pending.command_id].status, "rejected");
    assert_eq!(
        data.check_model_authority("device-lamp").unwrap_err().code,
        "model_trust_revoked"
    );
    assert!(data.check_model_authority("device-button").is_ok());
    let old_trust = data.model_operation("trust").unwrap().clone();
    data.apply_model_change(old_trust.request, now()).unwrap();
    assert!(!data.model_registry.trusts[&trusted.trust_id].active);
    let readd = change(
        &mut data,
        "readd",
        Change::TrustAdd {
            trust: f["trust"].clone(),
            expected_signing_key_id: trusted.trust.signing_key_id,
        },
    );
    assert_eq!(readd.reason.as_deref(), Some("model_trust_revoked"));
    let repeated = data.apply_model_change(binding.request, now()).unwrap();
    assert_eq!(repeated.operation_id, binding.operation_id);
    assert!(!data.devices["device-lamp"].ready);
    data.validate_model_registry(now()).unwrap();
}

#[test]
fn new_devices_are_explicit_and_existing_rules_cannot_be_silently_broken() {
    let mut data = initial_data();
    let trusted = trust(&mut data);
    let installed = installation(&install(
        &mut data,
        &trusted.trust_id,
        "install",
        fixture()["artifact"].clone(),
        None,
    ));
    let rule: Rule = serde_json::from_str(include_str!(
        "../../../../contracts/examples/button-light.json"
    ))
    .unwrap();
    data.deploy(rule).unwrap();
    let before = digest(&data.devices).unwrap();
    let rejected = bind(
        &mut data,
        "device-button",
        &installed.installation_id,
        "break-rule",
    );
    assert_eq!(rejected.reason.as_deref(), Some("bound_rules_incompatible"));
    assert_eq!(digest(&data.devices).unwrap(), before);
    assert_eq!(
        bind(
            &mut data,
            "new-lamp",
            &installed.installation_id,
            "new-device"
        )
        .status,
        "applied"
    );
    assert!(!data.devices["new-lamp"].ready);
    let original = data.model_operation("new-device").unwrap().request.clone();
    let mut stale = original;
    stale.idempotency_key = "stale-binding".into();
    assert_eq!(
        data.apply_model_change(stale, now()).unwrap().status,
        "conflict"
    );
}

#[test]
fn snapshots_preserve_registry_history_and_old_snapshots_default_to_empty() {
    let mut data = initial_data();
    let trusted = trust(&mut data);
    let installed = installation(&install(
        &mut data,
        &trusted.trust_id,
        "install",
        fixture()["artifact"].clone(),
        None,
    ));
    bind(&mut data, "device-lamp", &installed.installation_id, "bind");
    let mut restored: Data = serde_json::from_value(serde_json::to_value(&data).unwrap()).unwrap();
    restored.validate_model_registry(now()).unwrap();
    restored.recover();
    assert_eq!(
        restored.devices["device-lamp"].model_revision,
        installed.artifact.statement.model_revision
    );
    assert_eq!(
        restored.model_operation("bind").unwrap().operation_id,
        data.model_operation("bind").unwrap().operation_id
    );
    restored
        .model_registry
        .bindings
        .get_mut("device-lamp")
        .unwrap()
        .model_revision = "sha256:wrong".into();
    assert_eq!(
        restored.validate_model_registry(now()).unwrap_err().code,
        "storage_corrupt"
    );
    let mut old = serde_json::to_value(initial_data()).unwrap();
    old.as_object_mut().unwrap().remove("model_registry");
    let restored: Data = serde_json::from_value(old).unwrap();
    restored.validate_model_registry(now()).unwrap();
    assert!(restored.model_registry.installations.is_empty());
}
