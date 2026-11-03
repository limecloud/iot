use chrono::{DateTime, Duration, Utc};
use limeiot_core::{
    digest,
    engine::{Config, Data},
    protocol::{CommandRequest, Envelope, Rule},
};
use serde_json::{json, Value};

fn time() -> DateTime<Utc> {
    "2026-11-01T09:00:00Z".parse().unwrap()
}
fn config() -> Config {
    serde_json::from_str(include_str!("../../../../deploy/dev/config.json")).unwrap()
}
fn message(data: &Data, device: &str, kind: &str, seq: u64, body: Value) -> Envelope {
    let d = &data.devices[device];
    Envelope {
        v: 1,
        kind: kind.into(),
        message_id: format!("message-{device}-{seq}"),
        device_id: device.into(),
        model_revision: d.model_revision.clone(),
        boot_id: Some(format!("boot-{device}")),
        seq: Some(seq),
        session_id: d.session_id.clone(),
        body,
    }
}
fn ready() -> Data {
    let mut data = Data::new(config()).unwrap();
    for device in ["device-lamp", "device-button"] {
        let hello = message(
            &data,
            device,
            "hello",
            1,
            json!({"challenge":"challenge-1"}),
        );
        data.ingest(hello, time()).unwrap();
        let props = if device == "device-lamp" {
            json!([{"path":"light.power","value":false,"observed_at":time(),"quality":"confirmed","source":"simulator"},{"path":"light.brightness","value":0,"observed_at":time(),"quality":"confirmed","source":"simulator"}])
        } else {
            json!([])
        };
        let state = message(
            &data,
            device,
            "state",
            2,
            json!({"type":"snapshot","revision":1,"properties":props}),
        );
        data.ingest(state, time()).unwrap();
    }
    data
}
fn request(data: &Data) -> CommandRequest {
    serde_json::from_value(json!({"space_id":data.space_id,"device_id":"device-lamp","model_revision":data.devices["device-lamp"].model_revision,"idempotency_key":"request-1","expires_at":time()+Duration::seconds(5),"operation":{"type":"property.set","path":"light.power","value":true}})).unwrap()
}
fn rule() -> Rule {
    serde_json::from_str(include_str!(
        "../../../../contracts/examples/button-light.json"
    ))
    .unwrap()
}
fn event(data: &Data, seq: u64, event_id: &str, historical: bool) -> Envelope {
    message(
        data,
        "device-button",
        "event",
        seq,
        json!({"event_id":event_id,"path":"button.pressed","occurred_at":time(),"historical":historical,"data":{"count":1}}),
    )
}

#[test]
fn model_revision_matches_published_fixture_and_rejects_invalid_values() {
    let data = ready();
    let model = &data.models[&data.devices["device-lamp"].model_revision];
    assert_eq!(
        digest(model).unwrap(),
        "sha256:aaf9fc9ba87187643ab777cda43658e09603fc1c0e51dc6ec1acde160d4aecfc"
    );
    for value in [json!(-1), json!(101), json!(true), json!("30"), json!(30.5)] {
        assert!(model.write("light.brightness", &value).is_err());
    }
    assert!(model.write("light.brightness", &json!(30)).is_ok());
}
#[test]
fn same_key_recovers_original_even_after_deadline_and_changed_parameters_conflict() {
    let mut data = ready();
    let input = request(&data);
    let first = data.create_command(input.clone(), time(), None).unwrap();
    let repeated = data
        .create_command(input.clone(), time() + Duration::minutes(1), None)
        .unwrap();
    assert_eq!(first.command_id, repeated.command_id);
    let mut changed = input;
    changed.operation.value = json!(false);
    assert_eq!(
        data.create_command(changed, time(), None).unwrap_err().code,
        "idempotency_conflict"
    );
    assert_eq!(data.commands.len(), 1);
}
#[test]
fn expired_wrong_space_model_and_unsupported_writes_are_rejected() {
    let mut data = ready();
    let valid = request(&data);
    for (key, expected) in [
        ("expired", "command_expired"),
        ("space", "forbidden"),
        ("model", "model_mismatch"),
        ("value", "invalid_value"),
    ] {
        let mut input = valid.clone();
        input.idempotency_key = key.into();
        match key {
            "expired" => input.expires_at = time(),
            "space" => input.space_id = "another-space".into(),
            "model" => input.model_revision = "wrong".into(),
            _ => input.operation.value = json!("true"),
        }
        assert_eq!(
            data.create_command(input, time(), None).unwrap_err().code,
            expected
        );
    }
    assert!(data.commands.is_empty());
}
#[test]
fn dispatch_without_device_evidence_becomes_unknown_and_is_never_resent() {
    let mut data = ready();
    let input = request(&data);
    let command = data.create_command(input, time(), None).unwrap();
    assert_eq!(data.prepare_dispatch(time()).len(), 1);
    assert!(data.prepare_dispatch(time()).is_empty());
    data.prepare_dispatch(time() + Duration::seconds(6));
    assert_eq!(data.commands[&command.command_id].status, "unknown");
    data.recover();
    assert!(data
        .prepare_dispatch(time() + Duration::seconds(7))
        .is_empty());
}
#[test]
fn result_needs_exact_device_session_command_and_value() {
    let mut data = ready();
    let input = request(&data);
    let command = data.create_command(input, time(), None).unwrap();
    data.prepare_dispatch(time());
    let body = json!({"command_id":command.command_id,"status":"confirmed","evidence":{"type":"device_result","observed_at":time(),"reported":{"light.power":true}}});
    let mut bad = message(&data, "device-lamp", "result", 3, body.clone());
    bad.session_id = Some("old-session".into());
    assert_eq!(
        data.ingest(bad, time()).unwrap_err().code,
        "session_mismatch"
    );
    let mut bad = message(&data, "device-lamp", "result", 3, body.clone());
    bad.body["evidence"]["reported"]["light.power"] = json!(false);
    assert_eq!(
        data.ingest(bad, time()).unwrap_err().code,
        "invalid_evidence"
    );
    let result = message(&data, "device-lamp", "result", 3, body);
    data.ingest(result, time()).unwrap();
    assert_eq!(data.commands[&command.command_id].status, "confirmed");
    assert_eq!(
        data.devices["device-lamp"].reported["light.power"].value,
        false
    );
}
#[test]
fn device_unknown_is_never_resent_and_only_later_evidence_can_confirm() {
    let mut data = ready();
    let input = request(&data);
    let command = data.create_command(input, time(), None).unwrap();
    let unknown = json!({"command_id":command.command_id,"status":"unknown","error":"execution_unknown","evidence":{"type":"device_result","observed_at":time(),"reported":{}}});
    let premature = message(&data, "device-lamp", "result", 3, unknown.clone());
    assert_eq!(
        data.ingest(premature, time()).unwrap_err().code,
        "invalid_transition"
    );
    data.prepare_dispatch(time());
    let mut invalid = message(&data, "device-lamp", "result", 3, unknown.clone());
    invalid.body["error"] = json!("driver_failed");
    assert_eq!(
        data.ingest(invalid, time()).unwrap_err().code,
        "invalid_result"
    );
    let uncertain = message(&data, "device-lamp", "result", 3, unknown.clone());
    data.ingest(uncertain, time()).unwrap();
    assert_eq!(data.commands[&command.command_id].status, "unknown");
    assert_eq!(
        data.commands[&command.command_id].error.as_deref(),
        Some("execution_unknown")
    );
    assert!(data.prepare_dispatch(time()).is_empty());
    let confirmed = message(
        &data,
        "device-lamp",
        "result",
        4,
        json!({"command_id":command.command_id,"status":"confirmed","evidence":{"type":"device_result","observed_at":time(),"reported":{"light.power":true}}}),
    );
    data.ingest(confirmed, time()).unwrap();
    assert_eq!(data.commands[&command.command_id].status, "confirmed");
    assert!(data.commands[&command.command_id].error.is_none());
    let downgrade = message(&data, "device-lamp", "result", 5, unknown);
    assert_eq!(
        data.ingest(downgrade, time()).unwrap_err().code,
        "duplicate_conflict"
    );
}
#[test]
fn duplicate_history_and_cooldown_cannot_repeat_automation() {
    let mut data = ready();
    data.deploy(rule()).unwrap();
    let first = event(&data, 3, "event-1", false);
    data.ingest(first.clone(), time()).unwrap();
    data.ingest(first, time()).unwrap();
    let repeated = event(&data, 4, "event-1", false);
    data.ingest(repeated, time()).unwrap();
    let history = event(&data, 5, "history-1", true);
    data.ingest(history, time()).unwrap();
    let cooling = event(&data, 6, "event-2", false);
    data.ingest(cooling, time()).unwrap();
    assert_eq!(data.runs.len(), 1);
    assert_eq!(data.commands.len(), 1);
}
#[test]
fn same_sequence_different_body_and_old_boot_cannot_change_state() {
    let mut data = ready();
    let conflict = message(
        &data,
        "device-lamp",
        "state",
        2,
        json!({"type":"snapshot","revision":99,"properties":[]}),
    );
    assert_eq!(
        data.ingest(conflict, time()).unwrap_err().code,
        "duplicate_conflict"
    );
    let mut hello = message(&data, "device-lamp", "hello", 1, json!({"challenge":"new"}));
    hello.boot_id = Some("new-boot".into());
    data.ingest(hello, time()).unwrap();
    let old = message(&data, "device-lamp", "hello", 3, json!({"challenge":"old"}));
    assert_eq!(data.ingest(old, time()).unwrap_err().code, "old_boot");
}
#[test]
fn unsafe_rules_and_incomplete_snapshots_are_rejected() {
    let mut data = ready();
    let mut unsafe_rule = serde_json::to_value(rule()).unwrap();
    unsafe_rule["conditions"] = json!([{"shell":"anything"}]);
    assert!(serde_json::from_value::<Rule>(unsafe_rule).is_err());
    let incomplete = message(
        &data,
        "device-lamp",
        "state",
        3,
        json!({"type":"snapshot","revision":2,"properties":[]}),
    );
    assert_eq!(
        data.ingest(incomplete, time()).unwrap_err().code,
        "snapshot_incomplete"
    );
    assert!(data.deployments.is_empty());
}
#[test]
fn stale_readback_is_explicit_and_does_not_erase_last_observation() {
    let data = ready();
    let view = data.devices_view(time() + Duration::minutes(2));
    let lamp = view
        .iter()
        .find(|v| v["device_id"] == "device-lamp")
        .unwrap();
    assert_eq!(lamp["reported"]["light.power"]["quality"], "stale");
    assert_eq!(lamp["reported"]["light.power"]["value"], false);
    assert_eq!(lamp["ready"], false);
}

#[test]
fn stopping_rule_requires_current_revision_and_prevents_future_runs() {
    let mut data = ready();
    let deployed = data.deploy(rule()).unwrap();
    assert_eq!(
        data.stop_rule("button-light", "old-revision")
            .unwrap_err()
            .code,
        "revision_conflict"
    );
    assert_eq!(data.deployments.len(), 1);
    data.stop_rule("button-light", &deployed.revision).unwrap();
    let pressed = event(&data, 3, "after-stop", false);
    data.ingest(pressed, time()).unwrap();
    assert!(data.runs.is_empty());
    assert!(data.commands.is_empty());
}
