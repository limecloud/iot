use chrono::{DateTime, Duration, Utc};
use limeiot_core::{
    digest,
    engine::{Config, Data},
    execution::{AdapterReceipt, Route},
    execution_binding::{self, Change, Offer, Request},
    model::Model,
    protocol::CommandRequest,
};
use serde_json::json;
fn now() -> DateTime<Utc> {
    "2026-11-02T00:00:00Z".parse().unwrap()
}
fn initial() -> Data {
    let model: Model = serde_json::from_slice(include_bytes!(
        "../../../../contracts/models/android-tv-remote.json"
    ))
    .unwrap();
    Data::new(serde_json::from_value::<Config>(json!({"space_id":"home","models":[model],"devices":[{"device_id":"tv","model_revision":digest(&model).unwrap()}]})).unwrap()).unwrap()
}
fn route() -> Route {
    Route {
        adapter_id: "tv-adb".into(),
        revision: format!("sha256:{}", "a".repeat(64)),
    }
}
fn offer(data: &Data) -> Offer {
    Offer {
        device_id: "tv".into(),
        route: route(),
        model_revision: data.devices["tv"].model_revision.clone(),
        paths: ["remote.press".into(), "apps.launch".into()].into(),
    }
}
fn bind(data: &Data, key: &str) -> Request {
    Request {
        space_id: "home".into(),
        idempotency_key: key.into(),
        change: Change::Bind {
            device_id: "tv".into(),
            route: route(),
            expected_binding_revision: data.execution_binding("tv").unwrap().revision,
            expected_model_revision: data.devices["tv"].model_revision.clone(),
        },
    }
}
fn revoke(data: &Data, key: &str) -> Request {
    Request {
        space_id: "home".into(),
        idempotency_key: key.into(),
        change: Change::Revoke {
            device_id: "tv".into(),
            expected_binding_revision: data.execution_binding("tv").unwrap().revision,
        },
    }
}
fn bound() -> Data {
    let mut data = initial();
    let request = bind(&data, "bind");
    let offer = offer(&data);
    assert_eq!(
        data.apply_execution_change(request, Some(&offer), now())
            .unwrap()
            .status,
        "applied"
    );
    data.adapter_seen("tv", &route(), "adapter-session", now())
        .unwrap();
    data
}
fn command(data: &Data, key: &str) -> CommandRequest {
    serde_json::from_value(json!({"space_id":"home","device_id":"tv","model_revision":data.devices["tv"].model_revision,"idempotency_key":key,"expires_at":now()+Duration::seconds(5),"operation":{"type":"action.invoke","path":"remote.press","value":{"key":"home"}}})).unwrap()
}

#[test]
fn owner_offer_exact_baselines_and_original_key_are_required() {
    let mut data = initial();
    let offer = offer(&data);
    let request = bind(&data, "bind");
    let denied = data
        .apply_execution_change(bind(&data, "no-offer"), None, now())
        .unwrap();
    assert_eq!(
        denied.reason.as_deref(),
        Some("execution_offer_unavailable")
    );
    let result = data
        .apply_execution_change(request.clone(), Some(&offer), now())
        .unwrap();
    assert_eq!(result.status, "applied");
    let view = data.execution_binding("tv").unwrap();
    assert_eq!(view.state, "bound");
    assert_eq!(view.routes.len(), 2);
    assert_eq!(
        data.apply_execution_change(request.clone(), None, now())
            .unwrap()
            .operation_id,
        result.operation_id
    );
    let stale = data
        .apply_execution_change(bind(&initial(), "stale"), Some(&offer), now())
        .unwrap();
    assert_eq!(stale.status, "conflict");
    let revoke = revoke(&data, "revoke");
    assert_eq!(
        data.apply_execution_change(revoke, None, now())
            .unwrap()
            .status,
        "applied"
    );
    assert_eq!(
        data.apply_execution_change(request.clone(), Some(&offer), now())
            .unwrap()
            .operation_id,
        result.operation_id
    );
    assert_eq!(data.execution_binding("tv").unwrap().state, "revoked");
    let mut changed = request;
    changed.change = revoke_change(&data);
    assert_eq!(
        data.apply_execution_change(changed, None, now())
            .unwrap_err()
            .code,
        "idempotency_conflict"
    );
    data.validate_execution_registry().unwrap();
}
fn revoke_change(data: &Data) -> Change {
    revoke(data, "unused").change
}

#[test]
fn revoke_keeps_original_attempt_unknown_and_never_falls_back_to_mqtt() {
    let mut data = bound();
    let command = data
        .create_command(command(&data, "home"), now(), None)
        .unwrap();
    assert_eq!(data.prepare_adapter_dispatch("tv-adb", now()).len(), 1);
    let result = data
        .apply_execution_change(revoke(&data, "revoke"), None, now())
        .unwrap();
    assert_eq!(result.status, "applied");
    assert_eq!(data.commands[&command.command_id].status, "unknown");
    assert!(data.prepare_dispatch(now()).is_empty());
    assert!(data.prepare_adapter_dispatch("tv-adb", now()).is_empty());
    let device = data.devices.get_mut("tv").unwrap();
    device.ready = true;
    device.last_seen = Some(now());
    device.session_id = Some("native-session".into());
    assert_eq!(data.devices_view(now())[0]["ready"], false);
    assert_eq!(
        data.create_command(command_input(&data, "after-revoke"), now(), None)
            .unwrap_err()
            .code,
        "execution_binding_revoked"
    );
    assert!(data.recheck_adapter_dispatch(&command, now()).is_err());
    let late = data
        .apply_adapter_result(
            AdapterReceipt {
                command_id: command.command_id.clone(),
                route: route(),
                session_id: "adapter-session".into(),
                request_digest: command.request_digest,
                status: "confirmed".into(),
                error: None,
                observed_at: now(),
            },
            now(),
        )
        .unwrap();
    assert_eq!(late.status, "confirmed");
    assert!(data.execution_blocked("tv"));
}
fn command_input(data: &Data, key: &str) -> CommandRequest {
    command(data, key)
}

#[test]
fn route_switch_requires_draining_but_revocation_is_always_available() {
    let mut data = bound();
    let queued = data
        .create_command(command(&data, "queued"), now(), None)
        .unwrap();
    let offer = offer(&data);
    let request = bind(&data, "rebind");
    data.prepare_adapter_dispatch("tv-adb", now());
    let before = digest(&(
        &data.devices,
        &data.commands,
        &data.execution_registry.bindings,
    ))
    .unwrap();
    let result = data
        .apply_execution_change(request, Some(&offer), now())
        .unwrap();
    assert_eq!(result.reason.as_deref(), Some("execution_in_flight"));
    assert_eq!(
        digest(&(
            &data.devices,
            &data.commands,
            &data.execution_registry.bindings
        ))
        .unwrap(),
        before
    );
    data.apply_execution_change(revoke(&data, "revoke"), None, now())
        .unwrap();
    assert_eq!(data.commands[&queued.command_id].status, "unknown");
    let request = bind(&data, "explicit-new-binding");
    assert_eq!(
        data.apply_execution_change(request, Some(&offer), now())
            .unwrap()
            .status,
        "applied"
    );
    assert!(data.devices["tv"].adapter_sessions.is_empty());
    data.adapter_seen("tv", &route(), "new-session", now())
        .unwrap();
    assert!(data.prepare_adapter_dispatch("tv-adb", now()).is_empty());
}

#[test]
fn queued_commands_are_rejected_and_binding_revision_prevents_aba() {
    let mut data = bound();
    let stale = bind(&data, "stale-after-cycle");
    let command = data
        .create_command(command(&data, "queued"), now(), None)
        .unwrap();
    let offer = offer(&data);
    data.apply_execution_change(revoke(&data, "revoke"), None, now())
        .unwrap();
    assert_eq!(data.commands[&command.command_id].status, "rejected");
    let fresh = bind(&data, "new-bind");
    data.apply_execution_change(fresh, Some(&offer), now())
        .unwrap();
    assert_eq!(
        data.apply_execution_change(stale, Some(&offer), now())
            .unwrap()
            .status,
        "conflict"
    );
    let bytes = serde_json::to_vec(&data).unwrap();
    let mut recovered: Data = serde_json::from_slice(&bytes).unwrap();
    recovered.validate_execution_registry().unwrap();
    recovered.recover();
    assert_eq!(
        recovered.execution_binding("tv").unwrap().revision,
        data.execution_binding("tv").unwrap().revision
    );
    assert!(recovered.devices["tv"].adapter_sessions.is_empty());
    assert!(recovered
        .prepare_adapter_dispatch("tv-adb", now())
        .is_empty());
}

#[test]
fn wrong_device_route_model_or_capability_offer_cannot_bind() {
    for variant in 0..4 {
        let mut data = initial();
        let request = bind(&data, "bad");
        let mut offer = offer(&data);
        match variant {
            0 => offer.device_id = "other".into(),
            1 => offer.route.adapter_id = "other".into(),
            2 => offer.model_revision = format!("sha256:{}", "b".repeat(64)),
            _ => {
                offer.paths.remove("apps.launch");
            }
        }
        let result = data
            .apply_execution_change(request, Some(&offer), now())
            .unwrap();
        assert_eq!(result.status, "rejected");
        assert!(data.devices["tv"].routes.is_empty());
        assert!(data.execution_registry.bindings.is_empty());
    }
}

#[test]
fn strict_changes_and_history_corruption_are_rejected() {
    assert!(execution_binding::parse_change(br#"{"type":"bindings.revoke","device_id":"tv","device_id":"other","expected_binding_revision":"r"}"#).is_err());
    let data = initial();
    let raw = serde_json::to_vec(&bind(&data, "key").change).unwrap();
    assert!(execution_binding::parse_change(&raw).is_ok());
    let mut value: serde_json::Value = serde_json::from_slice(&raw).unwrap();
    value["shell"] = json!("input keyevent 3");
    assert!(execution_binding::parse_change(&serde_json::to_vec(&value).unwrap()).is_err());
    let mut data = bound();
    data.execution_registry
        .operations
        .get_mut("bind")
        .unwrap()
        .request_digest = "sha256:bad".into();
    assert!(data.validate_execution_registry().is_err());
}

#[test]
fn malformed_revisions_are_rejected_before_recording_a_decision() {
    let data = initial();
    let valid = serde_json::to_value(bind(&data, "key").change).unwrap();
    for field in [
        "expected_binding_revision",
        "expected_model_revision",
        "revision",
    ] {
        for value in [
            "sha256:bad".into(),
            format!("sha256:{}\n", "a".repeat(64)),
            format!("sha256:{}", "A".repeat(64)),
            format!("sha256:{}", "é".repeat(32)),
        ] {
            let mut malformed = valid.clone();
            if field == "revision" {
                malformed["route"][field] = json!(value);
            } else {
                malformed[field] = json!(value);
            }
            assert_eq!(
                execution_binding::parse_change(&serde_json::to_vec(&malformed).unwrap())
                    .unwrap_err()
                    .code,
                "invalid_execution_change"
            );
            let mut copy = data.clone();
            let mut request = bind(&copy, "key");
            request.change = serde_json::from_value(malformed).unwrap();
            let before = digest(&copy).unwrap();
            assert_eq!(
                copy.apply_execution_change(request, Some(&offer(&data)), now())
                    .unwrap_err()
                    .code,
                "invalid_execution_change"
            );
            assert_eq!(digest(&copy).unwrap(), before);
        }
    }
    let mut revoke = serde_json::to_value(revoke(&bound(), "revoke").change).unwrap();
    revoke["expected_binding_revision"] = json!("bad");
    assert!(execution_binding::parse_change(&serde_json::to_vec(&revoke).unwrap()).is_err());
}

#[test]
fn recovery_rejects_incomplete_routes_and_forged_original_results() {
    let data = bound();
    for variant in 0..14 {
        let mut saved = serde_json::to_value(&data).unwrap();
        match variant {
            0 => {
                saved["devices"]["tv"]["routes"]
                    .as_object_mut()
                    .unwrap()
                    .remove("apps.launch");
            }
            1 => {
                saved["execution_registry"]["operations"]["bind"]["result"]["device_id"] =
                    json!("other")
            }
            2 => {
                saved["execution_registry"]["operations"]["bind"]["result"]["state"] =
                    json!("native")
            }
            3 => {
                saved["execution_registry"]["operations"]["bind"]["result"]["routes"]
                    ["apps.launch"]["adapter_id"] = json!("other")
            }
            4 => {
                saved["execution_registry"]["operations"]["bind"]["result"]["routes"]
                    .as_object_mut()
                    .unwrap()
                    .remove("apps.launch");
            }
            5 => {
                saved["execution_registry"]["operations"]["bind"]["result"]["model_revision"] =
                    json!(route().revision)
            }
            6 => {
                saved["execution_registry"]["operations"]["bind"]["operation_id"] =
                    json!("executionop-")
            }
            7 => {
                saved["execution_registry"]["operations"]["bind"]["result"]["revision"] =
                    json!("bad")
            }
            8 => {
                saved["execution_registry"]["operations"]["bind"]["result"]["revision"] = saved
                    ["execution_registry"]["operations"]["bind"]["request"]["change"]
                    ["expected_binding_revision"]
                    .clone()
            }
            9 => {
                saved["execution_registry"]["bindings"]
                    .as_object_mut()
                    .unwrap()
                    .remove("tv");
            }
            10 => {
                let revision = saved["devices"]["tv"]["model_revision"]
                    .as_str()
                    .unwrap()
                    .to_owned();
                saved["models"][revision]["services"][0]["events"] = json!([{"id":"added","semantic_id":"urn:limeiot:event:added:1","schema":{"type":"boolean"}}]);
            }
            11 => {
                let operation = &mut saved["execution_registry"]["operations"]["bind"];
                operation["status"] = json!("conflict");
                operation["result"] = json!(null);
                operation["reason"] = json!("execution_offer_unavailable");
            }
            12 => {
                let operation = &mut saved["execution_registry"]["operations"]["bind"];
                operation["status"] = json!("rejected");
                operation["result"] = json!(null);
                operation["reason"] = json!("revision_conflict");
            }
            _ => {
                let revision = saved["devices"]["tv"]["model_revision"]
                    .as_str()
                    .unwrap()
                    .to_owned();
                saved["models"][revision]["services"][0]["actions"][0]["completion"] =
                    json!("observed");
            }
        }
        let recovered: Data = serde_json::from_value(saved).unwrap();
        assert!(
            recovered.validate_execution_registry().is_err(),
            "variant {variant}"
        );
    }
    let mut revoked = data;
    revoked
        .apply_execution_change(revoke(&revoked, "revoke"), None, now())
        .unwrap();
    revoked.validate_execution_registry().unwrap();
    let mut corrupt = revoked.clone();
    corrupt
        .execution_registry
        .operations
        .get_mut("revoke")
        .unwrap()
        .result
        .as_mut()
        .unwrap()
        .state = "bound".into();
    assert!(corrupt.validate_execution_registry().is_err());
    let bytes = serde_json::to_vec(&revoked).unwrap();
    let mut restored: Data = serde_json::from_slice(&bytes).unwrap();
    restored.validate_execution_registry().unwrap();
    restored.recover();
    let old = restored
        .execution_operation("bind")
        .unwrap()
        .request
        .clone();
    assert_eq!(
        restored
            .apply_execution_change(old, None, now())
            .unwrap()
            .status,
        "applied"
    );
    assert!(restored.execution_blocked("tv"));
}

#[test]
fn approved_and_uncertain_ota_occupancy_blocks_rebinding_but_not_revocation() {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use limeiot_core::{ota, ota_tasks, protocol::Envelope};
    use ring::signature::Ed25519KeyPair;
    fn ota_change(data: &mut Data, key: &str, value: serde_json::Value) -> ota_tasks::Operation {
        data.apply_ota_change(
            ota_tasks::Request {
                space_id: "home".into(),
                idempotency_key: key.into(),
                change: ota_tasks::parse_change(&serde_json::to_vec(&value).unwrap()).unwrap(),
            },
            now(),
        )
        .unwrap()
    }
    for phase in 0..3 {
        let mut data = bound();
        let revision = data.devices["tv"].model_revision.clone();
        let hello: Envelope = serde_json::from_value(json!({"v":1,"kind":"hello","message_id":"hello","device_id":"tv",
            "model_revision":revision,"boot_id":"fixture-boot","seq":1,"body":{"challenge":"fixture-challenge"}})).unwrap();
        data.ingest(hello, now()).unwrap();
        let session = data.devices["tv"].session_id.clone().unwrap();
        data.ingest(
            serde_json::from_value(
                json!({"v":1,"kind":"state","message_id":"state","device_id":"tv",
            "model_revision":revision,"boot_id":"fixture-boot","session_id":session,"seq":2,
            "body":{"type":"snapshot","revision":1,"properties":[]}}),
            )
            .unwrap(),
            now(),
        )
        .unwrap();
        let mut fixture: serde_json::Value = serde_json::from_slice(include_bytes!(
            "../../../../contracts/examples/ota-firmware.json"
        ))
        .unwrap();
        fixture["request"]["device"]["device_id"] = json!("tv");
        fixture["request"]["device"]["model_revision"] = json!(revision);
        data.ingest(
            serde_json::from_value(
                json!({"v":1,"kind":"device_info","message_id":"info","device_id":"tv",
            "model_revision":revision,"boot_id":"fixture-boot","session_id":session,"seq":3,
            "body":fixture["request"]["device"]}),
            )
            .unwrap(),
            now(),
        )
        .unwrap();
        let trust = fixture["request"]["trust"].clone();
        let trusted = ota_change(
            &mut data,
            "ota-trust",
            json!({"type":"trust.add","expected_signing_key_id":trust["signing_key_id"],"trust":trust}),
        );
        let trust_id = trusted.resource.unwrap().id;
        fixture["request"]["manifest"]["statement"]["compatibility"]["model_revisions"] =
            json!([revision]);
        let mut manifest: ota::Manifest =
            serde_json::from_value(fixture["request"]["manifest"].clone()).unwrap();
        manifest.signature = STANDARD.encode(
            Ed25519KeyPair::from_seed_unchecked(&[23; 32])
                .unwrap()
                .sign(&ota::signing_message(&manifest).unwrap())
                .as_ref(),
        );
        let planned = ota_change(
            &mut data,
            "ota-plan",
            json!({"type":"tasks.plan","device_id":"tv","trust_id":trust_id,"manifest":manifest,
            "expires_at":now()+Duration::minutes(10)}),
        );
        assert_eq!(planned.status, "applied", "{:?}", planned.reason);
        let task_id = planned.resource.unwrap().id;
        let task_revision = data.ota_registry.tasks[&task_id].revision.clone();
        assert_eq!(
            ota_change(
                &mut data,
                "ota-approve",
                json!({"type":"tasks.approve","task_id":task_id,"expected_revision":task_revision})
            )
            .status,
            "applied"
        );
        if phase > 0 {
            let task_revision = data.ota_registry.tasks[&task_id].revision.clone();
            assert_eq!(ota_change(&mut data, "ota-execute", json!({"type":"tasks.execute","task_id":task_id,"expected_revision":task_revision})).status, "applied");
            assert_eq!(data.prepare_ota_dispatch(now()).len(), 1);
        }
        if phase == 2 {
            data.recover();
        }
        let at = if phase == 2 {
            now() + Duration::hours(1)
        } else {
            now()
        };
        assert!(data.ota_reserves_device("tv", at));
        let before = digest(&(
            &data.devices,
            &data.execution_registry.bindings,
            &data.ota_registry.tasks,
        ))
        .unwrap();
        let rejected = data
            .apply_execution_change(bind(&data, "blocked-bind"), Some(&offer(&data)), at)
            .unwrap();
        assert_eq!(rejected.reason.as_deref(), Some("ota_task_conflict"));
        assert_eq!(
            digest(&(
                &data.devices,
                &data.execution_registry.bindings,
                &data.ota_registry.tasks
            ))
            .unwrap(),
            before
        );
        let task_status = data.ota_registry.tasks[&task_id].status;
        assert_eq!(
            data.apply_execution_change(revoke(&data, "revoke"), None, at)
                .unwrap()
                .status,
            "applied"
        );
        assert!(data.execution_blocked("tv"));
        assert!(data.ota_reserves_device("tv", at));
        assert_eq!(data.ota_registry.tasks[&task_id].status, task_status);
        data.validate_execution_registry().unwrap();
    }
}
