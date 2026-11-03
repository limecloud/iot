use super::*;
use chrono::{DateTime, Utc};
use limeiot_core::protocol::{Envelope, Rule};

fn now() -> DateTime<Utc> {
    "2026-11-03T00:00:00Z".parse().unwrap()
}
fn config() -> Config {
    serde_json::from_str(include_str!("../../../../deploy/dev/config.json")).unwrap()
}
fn report(store: &mut Store, device: &str, kind: &str, body: Value) -> Result<()> {
    let binding = &store.data.devices[device];
    let input:Envelope=serde_json::from_value(json!({"v":1,"kind":kind,"message_id":format!("message-{}",binding.last_seq+1),
        "device_id":device,"model_revision":binding.model_revision,"boot_id":format!("boot-{device}"),"session_id":binding.session_id,
        "seq":binding.last_seq+1,"body":body})).unwrap();
    store
        .update("device.message", |data| data.ingest(input, now()))
        .map(|_| ())
}
fn state(store: &mut Store, power: bool) {
    report(store,"device-lamp","state",json!({"type":"snapshot","revision":store.data.devices["device-lamp"].state_revision+1,"properties":[
        {"path":"light.power","value":power,"observed_at":now(),"quality":"confirmed","source":"fixture"},
        {"path":"light.brightness","value":40,"observed_at":now(),"quality":"confirmed","source":"fixture"}]})).unwrap();
}
fn event(store: &mut Store, id: &str) -> Result<()> {
    report(
        store,
        "device-button",
        "event",
        json!({"event_id":id,"path":"button.pressed","occurred_at":now(),"historical":false,"data":{"count":1}}),
    )
}
fn setup() -> (Store, std::path::PathBuf) {
    let path =
        std::env::temp_dir().join(format!("limeiot-conditions-{}.sqlite", limeiot_core::id()));
    let mut store = Store::open(path.to_str().unwrap(), config()).unwrap();
    for device in ["device-lamp", "device-button"] {
        report(&mut store, device, "hello", json!({"challenge":"fixture"})).unwrap();
    }
    report(
        &mut store,
        "device-button",
        "state",
        json!({"type":"snapshot","revision":1,"properties":[]}),
    )
    .unwrap();
    state(&mut store, false);
    let mut rule: Rule = serde_json::from_str(include_str!(
        "../../../../contracts/examples/button-light.json"
    ))
    .unwrap();
    rule.conditions = serde_json::from_value(
        json!([{"device":"device-lamp","property":"light.power","operator":"eq","value":true}]),
    )
    .unwrap();
    store
        .update("rule.deployed", |data| data.deploy(rule))
        .unwrap();
    (store, path)
}

#[test]
fn condition_evidence_and_command_admission_are_atomic_and_survive_v10_recovery() {
    let (mut store, path) = setup();
    for (id, matched) in [("unmet", false), ("met", true)] {
        if matched {
            state(&mut store, true);
        }
        let before = serde_json::to_value(&store.data).unwrap();
        let events = store.events(0).unwrap().len();
        store
            .connection
            .execute_batch("PRAGMA query_only=ON")
            .unwrap();
        assert_eq!(
            event(&mut store, id).unwrap_err().code,
            "storage_unavailable"
        );
        assert_eq!(serde_json::to_value(&store.data).unwrap(), before);
        assert_eq!(store.events(0).unwrap().len(), events);
        store
            .connection
            .execute_batch("PRAGMA query_only=OFF")
            .unwrap();
        event(&mut store, id).unwrap();
        let run = store.data.runs.values().find(|r| r.event_id == id).unwrap();
        assert_eq!(run.condition_evaluation.as_ref().unwrap().matched, matched);
        assert_eq!(run.command_ids.len(), usize::from(matched));
    }
    let evidence = serde_json::to_value(&store.data.runs).unwrap();
    let commands = store.data.commands.keys().cloned().collect::<Vec<_>>();
    assert_eq!(commands.len(), 1);
    drop(store);
    let mut store = Store::open(path.to_str().unwrap(), config()).unwrap();
    assert_eq!(serde_json::to_value(&store.data.runs).unwrap(), evidence);
    assert_eq!(
        store.data.commands.keys().cloned().collect::<Vec<_>>(),
        commands
    );
    assert!(store.data.prepare_dispatch(now()).is_empty());
    let conditions = store
        .data
        .deployments
        .values()
        .next()
        .unwrap()
        .rule
        .conditions
        .clone();
    assert!(
        !store
            .data
            .evaluate_conditions(&conditions, now())
            .unwrap()
            .matched
    );
    assert_eq!(
        store
            .connection
            .query_row("SELECT version FROM snapshot", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        10
    );
}

#[test]
fn old_versions_cannot_hide_conditions_and_invalid_evidence_is_not_rewritten() {
    let (mut store, _) = setup();
    event(&mut store, "unmet").unwrap();
    let original = serde_json::to_value(&store.data).unwrap();
    let mut evaluation_only = original.clone();
    evaluation_only["deployments"] = json!({});
    let mut bad_evaluation = original.clone();
    let run = bad_evaluation["runs"]
        .as_object_mut()
        .unwrap()
        .values_mut()
        .next()
        .unwrap();
    run["condition_evaluation"]["matched"] = json!(true);
    let mut missing_result = original.clone();
    let run = missing_result["runs"]
        .as_object_mut()
        .unwrap()
        .values_mut()
        .next()
        .unwrap();
    run["condition_evaluation"]["results"] = json!([]);
    for (version, body) in [
        (9, original),
        (9, evaluation_only),
        (10, bad_evaluation),
        (10, missing_result),
    ] {
        let path = std::env::temp_dir().join(format!(
            "limeiot-condition-corrupt-{}.sqlite",
            limeiot_core::id()
        ));
        let store = Store::open(path.to_str().unwrap(), config()).unwrap();
        let raw = body.to_string();
        store
            .connection
            .execute(
                "UPDATE snapshot SET version=?1,body=?2",
                params![version, raw],
            )
            .unwrap();
        let events = store.events(0).unwrap().len();
        drop(store);
        assert!(
            matches!(Store::open(path.to_str().unwrap(),config()),Err(e) if e.code=="storage_corrupt")
        );
        let disk = Connection::open(path).unwrap();
        assert_eq!(
            disk.query_row("SELECT version,body FROM snapshot", [], |r| Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?
            )))
            .unwrap(),
            (version, raw)
        );
        assert_eq!(
            disk.query_row("SELECT COUNT(*) FROM events", [], |r| r.get::<_, usize>(0))
                .unwrap(),
            events
        );
    }
    let path = std::env::temp_dir().join(format!(
        "limeiot-condition-v9-{}.sqlite",
        limeiot_core::id()
    ));
    let store = Store::open(path.to_str().unwrap(), config()).unwrap();
    store
        .connection
        .execute("UPDATE snapshot SET version=9", [])
        .unwrap();
    drop(store);
    let store = Store::open(path.to_str().unwrap(), config()).unwrap();
    assert_eq!(
        store
            .connection
            .query_row("SELECT version FROM snapshot", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        10
    );
}
