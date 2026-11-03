use chrono::{DateTime, Duration, Utc};
use limeiot_core::{
    digest,
    engine::{Config, Data},
    execution::{AdapterReceipt, Route},
    execution_binding::{self, Change, Offer, Request},
    model::Model,
    protocol::{CommandRequest, Envelope},
};
use serde_json::{json, Value};

fn now() -> DateTime<Utc> {
    "2026-11-02T00:00:00Z".parse().unwrap()
}
fn initial() -> Data {
    let model: Model = serde_json::from_slice(include_bytes!(
        "../../../../contracts/models/android-tv-remote.json"
    ))
    .unwrap();
    Data::new(
        serde_json::from_value::<Config>(json!({"space_id":"home","models":[model],
        "devices":[{"device_id":"tv","model_revision":digest(&model).unwrap()}]}))
        .unwrap(),
    )
    .unwrap()
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
fn message(data: &Data, kind: &str, body: Value) -> Envelope {
    let device = &data.devices["tv"];
    serde_json::from_value(json!({"v":1,"kind":kind,"message_id":format!("message-{}",device.last_seq+1),
        "device_id":"tv","model_revision":device.model_revision,"boot_id":device.boot_id.as_deref().unwrap_or("boot-first"),
        "session_id":device.session_id,"seq":device.last_seq+1,"body":body})).unwrap()
}
fn hello(data: &mut Data, paths: Value) {
    let envelope = message(
        data,
        "hello",
        json!({"challenge":"challenge","execution_paths":paths}),
    );
    data.ingest(envelope, now()).unwrap();
    heartbeat(data);
}
fn heartbeat(data: &mut Data) {
    let snapshot = message(
        data,
        "state",
        json!({"type":"snapshot","revision":data.devices["tv"].state_revision+1,"properties":[]}),
    );
    data.ingest(snapshot, now()).unwrap();
}
fn compose(data: &Data, key: &str) -> Request {
    Request {
        space_id: "home".into(),
        idempotency_key: key.into(),
        change: Change::Compose {
            device_id: "tv".into(),
            route: route(),
            native_paths: ["apps.launch".into()].into(),
            expected_native_session: data.devices["tv"]
                .session_id
                .clone()
                .unwrap_or("missing-session".into()),
            expected_binding_revision: data.execution_binding("tv").unwrap().revision,
            expected_model_revision: data.devices["tv"].model_revision.clone(),
        },
    }
}
fn composed() -> Data {
    let mut data = initial();
    hello(&mut data, json!(["apps.launch"]));
    let result = data
        .apply_execution_change(compose(&data, "compose"), Some(&offer(&data)), now())
        .unwrap();
    assert_eq!(result.status, "applied");
    heartbeat(&mut data);
    data.adapter_seen("tv", &route(), "adb-session", now())
        .unwrap();
    data
}

#[test]
fn native_projection_does_not_reuse_adapter_ready_or_restore_session_proof() {
    let mut data = composed();
    let view = &data.devices_view(now())[0];
    assert_eq!(view["native_execution"]["ready"], true);
    assert_eq!(view["native_execution"]["paths"], json!(["apps.launch"]));
    let later = now() + Duration::seconds(16);
    data.adapter_seen("tv", &route(), "fresh-adb", later)
        .unwrap();
    let view = &data.devices_view(later)[0];
    assert_eq!(view["ready"], true);
    assert_eq!(view["native_execution"]["ready"], false);
    let snapshot = serde_json::to_value(&data).unwrap();
    assert!(snapshot["devices"]["tv"].get("native_execution").is_none());
    let reopened: Data = serde_json::from_value(snapshot).unwrap();
    assert!(reopened.devices_view(later)[0]
        .get("native_execution")
        .is_none());
}
fn command(data: &Data, key: &str, path: &str) -> CommandRequest {
    serde_json::from_value(json!({"space_id":"home","device_id":"tv","model_revision":data.devices["tv"].model_revision,
        "idempotency_key":key,"expires_at":now()+Duration::seconds(10),"operation":{"type":"action.invoke","path":path,
        "value":if path=="apps.launch" {json!({"application_id":"com.example.player"})} else {json!({"key":"home"})}}})).unwrap()
}
fn native_result(data: &mut Data, command: &limeiot_core::engine::Command) {
    let envelope = message(
        data,
        "result",
        json!({"command_id":command.command_id,"status":"confirmed","evidence":{
        "type":"action_result","path":command.request.operation.path,"input_digest":digest(&command.request.operation.value).unwrap(),
        "output":{},"completion":"submitted","observed_at":now()}}),
    );
    data.ingest(envelope, now()).unwrap();
}

#[test]
fn current_native_session_and_declared_selected_paths_are_required_before_composition() {
    let mut data = initial();
    let rejected = data
        .apply_execution_change(compose(&data, "no-proof"), Some(&offer(&data)), now())
        .unwrap();
    assert_eq!(
        rejected.reason.as_deref(),
        Some("execution_native_proof_required")
    );
    hello(&mut data, json!(["apps.launch"]));
    let mut stale = compose(&data, "stale-session");
    if let Change::Compose {
        expected_native_session,
        ..
    } = &mut stale.change
    {
        *expected_native_session = "previous-session".into();
    }
    assert_eq!(
        data.apply_execution_change(stale, Some(&offer(&data)), now())
            .unwrap()
            .reason
            .as_deref(),
        Some("execution_native_proof_required")
    );
    let mut wrong = compose(&data, "wrong-native");
    if let Change::Compose { native_paths, .. } = &mut wrong.change {
        *native_paths = ["remote.press".into()].into();
    }
    assert_eq!(
        data.apply_execution_change(wrong, Some(&offer(&data)), now())
            .unwrap()
            .reason
            .as_deref(),
        Some("execution_native_proof_required")
    );
    let mut expired = compose(&data, "expired-proof");
    if let Change::Compose {
        expected_binding_revision,
        ..
    } = &mut expired.change
    {
        *expected_binding_revision = data.execution_binding("tv").unwrap().revision;
    }
    assert_eq!(
        data.apply_execution_change(expired, Some(&offer(&data)), now() + Duration::seconds(15))
            .unwrap()
            .reason
            .as_deref(),
        Some("execution_native_proof_required")
    );
    assert!(data.devices["tv"].routes.is_empty());
    hello(&mut data, json!(["apps.launch", "remote.press"]));
    let selected = data
        .apply_execution_change(
            compose(&data, "selected-subset"),
            Some(&offer(&data)),
            now(),
        )
        .unwrap();
    assert_eq!(selected.status, "applied");
    assert!(
        data.devices["tv"].routes.contains_key("remote.press"),
        "unselected native capability does not take over the adapter route"
    );
    data.validate_execution_registry().unwrap();
}

#[test]
fn native_and_adapter_dispatch_preserve_one_device_fifo_and_source() {
    let mut data = composed();
    let view = data.execution_binding("tv").unwrap();
    assert_eq!(view.state, "composed");
    assert_eq!(view.routes.len(), 1);
    assert!(view.routes.contains_key("remote.press"));
    let remote = data
        .create_command(command(&data, "remote-first", "remote.press"), now(), None)
        .unwrap();
    let native = data
        .create_command(command(&data, "native-second", "apps.launch"), now(), None)
        .unwrap();
    assert!(
        data.prepare_dispatch(now()).is_empty(),
        "native path cannot pass an earlier adapter command"
    );
    let commands = data.prepare_adapter_dispatch("tv-adb", now());
    assert_eq!(commands.len(), 1);
    assert_eq!(commands[0].command_id, remote.command_id);
    assert!(data.prepare_dispatch(now()).is_empty());
    data.apply_adapter_result(
        AdapterReceipt {
            command_id: remote.command_id.clone(),
            route: route(),
            session_id: "adb-session".into(),
            request_digest: remote.request_digest.clone(),
            status: "confirmed".into(),
            error: None,
            observed_at: now(),
        },
        now(),
    )
    .unwrap();
    let commands = data.prepare_dispatch(now());
    assert_eq!(commands.len(), 1);
    assert_eq!(commands[0].message_id, native.command_id);
    assert!(data.prepare_adapter_dispatch("tv-adb", now()).is_empty());
    assert!(data.recheck_adapter_dispatch(&native, now()).is_err());
    native_result(&mut data, &native);
    assert_eq!(data.commands[&native.command_id].status, "confirmed");
    assert!(data.prepare_dispatch(now()).is_empty());
    assert!(data.prepare_adapter_dispatch("tv-adb", now()).is_empty());
    data.validate_execution_registry().unwrap();
}

#[test]
fn missing_path_never_falls_back_and_revocation_blocks_both_transports() {
    let mut data = composed();
    data.adapter_disconnected("tv-adb");
    assert_eq!(
        data.devices_view(now())[0]["action_availability"],
        json!({"apps.launch":true,"remote.press":false})
    );
    assert_eq!(
        data.create_command(
            command(&data, "offline-remote", "remote.press"),
            now(),
            None
        )
        .unwrap_err()
        .code,
        "device_offline"
    );
    let native = data
        .create_command(command(&data, "native", "apps.launch"), now(), None)
        .unwrap();
    assert_eq!(data.prepare_dispatch(now()).len(), 1);
    let request = Request {
        space_id: "home".into(),
        idempotency_key: "revoke".into(),
        change: Change::Revoke {
            device_id: "tv".into(),
            expected_binding_revision: data.execution_binding("tv").unwrap().revision,
        },
    };
    data.apply_execution_change(request, None, now()).unwrap();
    assert_eq!(data.commands[&native.command_id].status, "unknown");
    heartbeat(&mut data);
    for path in ["apps.launch", "remote.press"] {
        assert_eq!(
            data.create_command(
                command(&data, path.split('.').next().unwrap(), path),
                now(),
                None
            )
            .unwrap_err()
            .code,
            "execution_binding_revoked"
        );
    }
    native_result(&mut data, &native);
    assert_eq!(
        data.commands[&native.command_id].status, "confirmed",
        "late proof only updates the original attempt"
    );
    assert_eq!(data.execution_binding("tv").unwrap().state, "revoked");
}

#[test]
fn recovery_keeps_plan_but_requires_new_native_proof_and_rejects_corruption() {
    let data = composed();
    let saved = serde_json::to_value(&data).unwrap();
    let mut reopened: Data = serde_json::from_value(saved.clone()).unwrap();
    reopened.recover();
    assert!(reopened.devices["tv"].native_actions.is_none());
    reopened.devices.get_mut("tv").unwrap().ready = true;
    reopened.devices.get_mut("tv").unwrap().last_seen = Some(now());
    assert_eq!(
        reopened
            .create_command(
                command(&reopened, "without-proof", "apps.launch"),
                now(),
                None
            )
            .unwrap_err()
            .code,
        "execution_capability_unavailable"
    );
    let original_session = reopened.devices["tv"].session_id.clone();
    let mut invalid = message(&reopened, "hello", json!({"challenge":"challenge"}));
    invalid.boot_id = Some("new-boot".into());
    assert_eq!(
        reopened.ingest(invalid, now()).unwrap_err().code,
        "execution_capabilities_mismatch"
    );
    assert_eq!(reopened.devices["tv"].session_id, original_session);
    hello(&mut reopened, json!(["apps.launch"]));
    assert!(reopened
        .create_command(
            command(&reopened, "after-proof", "apps.launch"),
            now(),
            None
        )
        .is_ok());
    for (path, value) in [
        ("bindings", json!(["remote.press"])),
        ("operations", json!(["remote.press"])),
    ] {
        let mut broken = saved.clone();
        if path == "bindings" {
            broken["execution_registry"][path]["tv"]["native_paths"] = value;
        } else {
            broken["execution_registry"][path]["compose"]["result"]["native_paths"] = value;
        }
        let broken: Data = serde_json::from_value(broken).unwrap();
        assert!(broken.validate_execution_registry().is_err());
    }
}

#[test]
fn old_decisions_do_not_revive_plan_and_in_flight_native_blocks_rebind() {
    let mut data = composed();
    let original = data.execution_operation("compose").unwrap().request.clone();
    data.create_command(command(&data, "native", "apps.launch"), now(), None)
        .unwrap();
    data.prepare_dispatch(now());
    assert_eq!(
        data.apply_execution_change(compose(&data, "in-flight"), Some(&offer(&data)), now())
            .unwrap()
            .reason
            .as_deref(),
        Some("execution_in_flight")
    );
    let revoke = Request {
        space_id: "home".into(),
        idempotency_key: "revoke".into(),
        change: Change::Revoke {
            device_id: "tv".into(),
            expected_binding_revision: data.execution_binding("tv").unwrap().revision,
        },
    };
    data.apply_execution_change(revoke, None, now()).unwrap();
    let before = digest(&data).unwrap();
    assert_eq!(
        data.apply_execution_change(original, None, now())
            .unwrap()
            .status,
        "applied"
    );
    assert_eq!(digest(&data).unwrap(), before);
    assert_eq!(data.execution_binding("tv").unwrap().state, "revoked");
}

#[test]
fn duplicate_or_unknown_native_capabilities_and_invalid_partitions_are_rejected() {
    let mut data = initial();
    for paths in [
        json!([]),
        json!(["apps.launch", "apps.launch"]),
        json!(["other.launch"]),
        json!([null]),
    ] {
        let envelope = message(
            &data,
            "hello",
            json!({"challenge":"challenge","execution_paths":paths}),
        );
        assert_eq!(
            data.ingest(envelope, now()).unwrap_err().code,
            "invalid_execution_capabilities"
        );
    }
    hello(&mut data, json!(["apps.launch"]));
    let mut all = compose(&data, "all-native");
    if let Change::Compose { native_paths, .. } = &mut all.change {
        *native_paths = ["apps.launch".into(), "remote.press".into()].into();
    }
    assert_eq!(
        data.apply_execution_change(all, Some(&offer(&data)), now())
            .unwrap()
            .reason
            .as_deref(),
        Some("execution_model_incompatible")
    );
    let value = serde_json::to_value(compose(&data, "parse").change).unwrap();
    assert!(execution_binding::parse_change(&serde_json::to_vec(&value).unwrap()).is_ok());
    let mut duplicate = value.clone();
    duplicate["native_paths"] = json!(["apps.launch", "apps.launch"]);
    assert!(execution_binding::parse_change(&serde_json::to_vec(&duplicate).unwrap()).is_err());
    let mut no_session = value;
    no_session
        .as_object_mut()
        .unwrap()
        .remove("expected_native_session");
    assert!(execution_binding::parse_change(&serde_json::to_vec(&no_session).unwrap()).is_err());
}
