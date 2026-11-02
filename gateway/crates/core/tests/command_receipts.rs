use chrono::{DateTime, Duration, Utc};
use limeiot_core::{
    command_receipts::{command_sequence, MAX_COMMAND_SEQUENCE},
    digest,
    engine::{Config, Data},
    protocol::{CommandRequest, Envelope},
};
use serde_json::{json, Value};

fn now() -> DateTime<Utc> {
    "2026-11-02T00:00:00Z".parse().unwrap()
}
fn message(data: &Data, kind: &str, body: Value) -> Envelope {
    serde_json::from_value(json!({"v":1,"kind":kind,"message_id":limeiot_core::id(),
        "device_id":"tv","model_revision":data.devices["tv"].model_revision,
        "boot_id":data.devices["tv"].boot_id.clone().unwrap_or("boot-tv".into()),
        "session_id":data.devices["tv"].session_id,"seq":data.devices["tv"].last_seq+1,"body":body})).unwrap()
}
fn ready(ledger: bool) -> Data {
    let model: Value = serde_json::from_slice(include_bytes!(
        "../../../../contracts/models/android-tv-agent.json"
    ))
    .unwrap();
    let mut data = Data::new(
        serde_json::from_value::<Config>(json!({"space_id":"home",
        "devices":[{"device_id":"tv","model_revision":digest(&model).unwrap()}],"models":[model]}))
        .unwrap(),
    )
    .unwrap();
    let mut hello = message(&data, "hello", json!({"challenge":"challenge"}));
    if ledger {
        hello.body["receipt_ledger"] = json!(1);
    }
    let welcome = data.ingest(hello, now()).unwrap().unwrap();
    assert_eq!(welcome.body.get("receipt_ledger").is_some(), ledger);
    if ledger {
        assert_eq!(welcome.body["command_sequence"], 0);
    }
    let state = message(
        &data,
        "state",
        json!({"type":"snapshot","revision":1,"properties":[]}),
    );
    data.ingest(state, now()).unwrap();
    data
}
fn dispatch(data: &mut Data) -> Envelope {
    let request: CommandRequest = serde_json::from_value(json!({"space_id":"home","device_id":"tv",
        "model_revision":data.devices["tv"].model_revision,"idempotency_key":limeiot_core::id(),
        "expires_at":now()+Duration::seconds(20),"operation":{"type":"action.invoke","path":"apps.launch","value":{"application_id":"com.example.player"}}})).unwrap();
    let command = data.create_command(request, now(), None).unwrap();
    assert_eq!(
        command_sequence(&command.command_id),
        Some(command.sequence)
    );
    assert_eq!(command.envelope.message_id, command.command_id);
    data.prepare_dispatch(now()).pop().unwrap()
}
fn result(command: &Envelope, status: &str) -> Value {
    if status == "confirmed" {
        json!({"command_id":command.body["command_id"],"status":"confirmed","evidence":{
            "type":"action_result","path":"apps.launch","input_digest":digest(&command.body["operation"]["value"]).unwrap(),
            "completion":"submitted","output":{},"observed_at":now()}})
    } else {
        json!({"command_id":command.body["command_id"],"status":status,"error":"execution_unknown","evidence":{"type":"device_result"}})
    }
}

#[test]
fn sequence_ids_are_canonical_bounded_and_stable_after_recovery() {
    let mut data = ready(true);
    let command = dispatch(&mut data);
    assert_eq!(
        command_sequence(command.body["command_id"].as_str().unwrap()),
        Some(1)
    );
    for value in [
        "c1-0-00000000-0000-4000-8000-000000000001",
        "c1-01-00000000-0000-4000-8000-000000000001",
        "c1-9007199254740992-00000000-0000-4000-8000-000000000001",
        "legacy",
        "c1-1-0",
    ] {
        assert_eq!(command_sequence(value), None);
    }
    data.recover();
    assert!(!data.devices["tv"].receipt_ledger);
    let hello = message(
        &data,
        "hello",
        json!({"challenge":"next","receipt_ledger":1}),
    );
    let welcome = data.ingest(hello, now()).unwrap().unwrap();
    assert_eq!(welcome.body["command_sequence"], 1);
    data.commands.values_mut().next().unwrap().sequence = MAX_COMMAND_SEQUENCE;
    let hello = message(
        &data,
        "hello",
        json!({"challenge":"last","receipt_ledger":1}),
    );
    assert_eq!(
        data.ingest(hello, now()).unwrap().unwrap().body["command_sequence"],
        MAX_COMMAND_SEQUENCE
    );
}

#[test]
fn final_result_ack_binds_exact_original_command_and_result() {
    let mut data = ready(true);
    let command = dispatch(&mut data);
    let body = result(&command, "confirmed");
    let report = message(&data, "result", body.clone());
    let ack = data.ingest(report, now()).unwrap().unwrap();
    assert_eq!(ack.kind, "receipt");
    assert_eq!(ack.body["command_digest"], digest(&command).unwrap());
    assert_eq!(ack.body["result_digest"], digest(&body).unwrap());
    assert_eq!(
        data.commands[command.body["command_id"].as_str().unwrap()].status,
        "confirmed"
    );
    assert!(data.prepare_dispatch(now()).is_empty());
}

#[test]
fn unknown_and_legacy_devices_do_not_receive_retirement_ack() {
    for (ledger, status) in [(true, "unknown"), (false, "confirmed")] {
        let mut data = ready(ledger);
        let command = dispatch(&mut data);
        let report = message(&data, "result", result(&command, status));
        assert!(data.ingest(report, now()).unwrap().is_none());
    }
}

#[test]
fn lost_ack_and_gateway_restart_reconcile_original_result_in_new_session() {
    let mut data = ready(true);
    let command = dispatch(&mut data);
    let body = result(&command, "confirmed");
    // 网关未收到原结果，重启只保留unknown，不补发安装或动作。
    data.recover();
    let hello = message(
        &data,
        "hello",
        json!({"challenge":"new","receipt_ledger":1}),
    );
    data.ingest(hello, now()).unwrap();
    let report = message(&data, "receipt", json!({"command":command,"result":body}));
    let ack = data.ingest(report, now()).unwrap().unwrap();
    assert_eq!(ack.body["result_digest"], digest(&body).unwrap());
    assert!(data.prepare_dispatch(now()).is_empty());
    // 丢确认后重查仍仅返回原账本确认。
    let again = message(&data, "receipt", json!({"command":command,"result":body}));
    assert_eq!(data.ingest(again, now()).unwrap().unwrap().body, ack.body);
}

#[test]
fn receipt_reconciliation_rejects_changed_command_and_malformed_reports() {
    let mut data = ready(true);
    let command = dispatch(&mut data);
    let body = result(&command, "confirmed");
    for invalid in [
        json!({"unknown":0,"other":0}),
        json!({"command":command,"result":body,"extra":true}),
        {
            let mut changed = command.clone();
            changed.body["operation"]["value"]["application_id"] = json!("other");
            json!({"command":changed,"result":body})
        },
    ] {
        let report = message(&data, "receipt", invalid);
        assert!(data.ingest(report, now()).is_err());
        assert_eq!(
            data.commands[command.body["command_id"].as_str().unwrap()].status,
            "dispatched"
        );
    }
}

#[test]
fn gateway_restart_with_device_still_connected_restores_receipt_mode_by_original_query() {
    let mut data = ready(true);
    let command = dispatch(&mut data);
    let body = result(&command, "confirmed");
    data.recover();
    assert!(!data.devices["tv"].receipt_ledger);
    let report = message(&data, "receipt", json!({"command":command,"result":body}));
    let ack = data.ingest(report, now()).unwrap().unwrap();
    assert_eq!(ack.body["result_digest"], digest(&body).unwrap());
    assert!(data.devices["tv"].receipt_ledger);
    assert!(data.prepare_dispatch(now()).is_empty());
    let mut damaged = data.clone();
    damaged.commands.values_mut().next().unwrap().sequence += 1;
    assert_eq!(
        damaged.validate_command_receipts().unwrap_err().code,
        "storage_corrupt"
    );
    data.validate_command_receipts().unwrap();
    let mut duplicate = data.commands.values().next().unwrap().clone();
    let duplicate_id = format!("c1-{}-{}", duplicate.sequence, limeiot_core::id());
    duplicate.command_id = duplicate_id.clone();
    duplicate.envelope.message_id = duplicate_id.clone();
    duplicate.envelope.body["command_id"] = json!(duplicate_id);
    data.commands.insert(duplicate_id, duplicate);
    assert_eq!(
        data.validate_command_receipts().unwrap_err().code,
        "storage_corrupt"
    );
}
