use chrono::{DateTime, Duration, Utc};
use limeiot_core::{
    digest,
    engine::{Binding, Config, Data},
    model::Model,
    protocol::{CommandRequest, Envelope, Rule},
};
use serde_json::{json, Value};

fn at(ms: i64) -> DateTime<Utc> {
    "2026-11-03T00:00:00Z".parse::<DateTime<Utc>>().unwrap() + Duration::milliseconds(ms)
}
fn message(data: &Data, device: &str, kind: &str, body: Value) -> Envelope {
    let binding = &data.devices[device];
    serde_json::from_value(
        json!({"v":1,"message_id":format!("message-{}",binding.last_seq+1),
        "device_id":device,"model_revision":binding.model_revision,"kind":kind,
        "boot_id":format!("boot-{device}"),"session_id":binding.session_id,
        "seq":binding.last_seq+1,"body":body}),
    )
    .unwrap()
}
fn connect(data: &mut Data, now: DateTime<Utc>) {
    for (device, properties) in [
        ("device-button", json!([])),
        (
            "device-lamp",
            json!([
                {"path":"light.power","value":true,"observed_at":now,"quality":"confirmed","source":"fixture"},
                {"path":"light.brightness","value":50,"observed_at":now,"quality":"confirmed","source":"fixture"}
            ]),
        ),
    ] {
        let hello = message(data, device, "hello", json!({"challenge":"fixture"}));
        data.ingest(hello, now).unwrap();
        let state = message(
            data,
            device,
            "state",
            json!({"type":"snapshot","revision":1,"properties":properties}),
        );
        data.ingest(state, now).unwrap();
    }
}
fn ready() -> Data {
    let mut config: Config =
        serde_json::from_str(include_str!("../../../../deploy/dev/config.json")).unwrap();
    let model: Model = serde_json::from_str(include_str!(
        "../../../../contracts/models/environment.json"
    ))
    .unwrap();
    config.devices.push(Binding {
        device_id: "sensor".into(),
        model_revision: digest(&model).unwrap(),
        routes: Default::default(),
    });
    config.models.push(model);
    let mut data = Data::new(config).unwrap();
    connect(&mut data, at(0));
    data.deploy(rule("budget", 1)).unwrap();
    data
}
fn rule(id: &str, steps: usize) -> Rule {
    let mut value: Value = serde_json::from_str(include_str!(
        "../../../../contracts/examples/button-light.json"
    ))
    .unwrap();
    value["id"] = json!(id);
    value["cooldown_ms"] = json!(0);
    value["actions"] = json!(vec![
        json!({"device":"device-lamp","set":{"path":"light.brightness","value":30}});
        steps
    ]);
    serde_json::from_value(value).unwrap()
}
fn trigger(data: &mut Data, id: &str, now: DateTime<Utc>) {
    trigger_at(data, id, now, now);
}
fn trigger_at(data: &mut Data, id: &str, occurred: DateTime<Utc>, now: DateTime<Utc>) {
    for device in data.devices.values_mut() {
        device.last_seen = Some(now);
    }
    let event = message(
        data,
        "device-button",
        "event",
        json!({"event_id":id,
        "path":"button.pressed","occurred_at":occurred,"historical":false,"data":{"count":1}}),
    );
    data.ingest(event, now).unwrap();
}
fn complete(data: &mut Data, now: DateTime<Utc>) {
    while let Some(command) = data.prepare_dispatch(now).first() {
        let result = message(
            data,
            "device-lamp",
            "result",
            json!({"command_id":command.body["command_id"],
            "status":"confirmed","evidence":{"type":"device_result","reported":{"light.brightness":30}}}),
        );
        data.ingest(result, now).unwrap();
    }
}
fn fill(data: &mut Data, count: usize) {
    for index in 0..count {
        trigger(data, &format!("press-{index}"), at(0));
        complete(data, at(0));
    }
    assert_eq!(data.commands.len(), count);
}
fn rejected(data: &Data, id: &str) {
    let run = data.runs.values().find(|run| run.event_id == id).unwrap();
    assert_eq!(run.error.as_deref(), Some("automation_budget_exceeded"));
    assert!(run.command_ids.is_empty());
}

#[test]
fn shared_limit_records_rejection_deduplicates_and_preserves_manual_control() {
    let mut data = ready();
    fill(&mut data, 64);
    trigger(&mut data, "exhausted", at(1));
    rejected(&data, "exhausted");
    trigger_at(&mut data, "exhausted", at(1), at(2));
    assert_eq!(data.runs.len(), 65);
    assert_eq!(data.commands.len(), 64);
    let request: CommandRequest = serde_json::from_value(json!({"space_id":data.space_id,"device_id":"device-lamp",
        "model_revision":data.devices["device-lamp"].model_revision,"idempotency_key":"manual",
        "expires_at":at(5000),"operation":{"type":"property.set","path":"light.brightness","value":30}})).unwrap();
    let manual = data.create_command(request.clone(), at(3), None).unwrap();
    assert_eq!(
        data.create_command(request, at(4), None)
            .unwrap()
            .command_id,
        manual.command_id
    );
    trigger(&mut data, "still-exhausted", at(5));
    rejected(&data, "still-exhausted");
    assert_eq!(data.commands.len(), 65);
}

#[test]
fn rolling_window_releases_exact_boundary_without_replaying_rejected_events() {
    let mut data = ready();
    fill(&mut data, 64);
    trigger(&mut data, "early", at(59999));
    rejected(&data, "early");
    trigger(&mut data, "boundary", at(60000));
    assert_eq!(data.commands.len(), 65);
    trigger_at(&mut data, "early", at(59999), at(60001));
    assert_eq!(data.commands.len(), 65);
    assert_eq!(data.runs.len(), 66);
}

#[test]
fn insufficient_budget_rejects_the_whole_rule_and_other_rule_can_use_remaining_slot() {
    let mut data = ready();
    fill(&mut data, 63);
    data.deploy(rule("budget", 2)).unwrap();
    let small = data.deploy(rule("single", 1)).unwrap();
    trigger(&mut data, "two-rules", at(1));
    assert_eq!(data.commands.len(), 64);
    let runs: Vec<_> = data
        .runs
        .values()
        .filter(|r| r.event_id == "two-rules")
        .collect();
    assert_eq!(runs.len(), 2);
    assert!(runs
        .iter()
        .any(|r| r.command_ids.is_empty()
            && r.error.as_deref() == Some("automation_budget_exceeded")));
    assert!(runs.iter().any(|r| r.rule_revision == small.revision
        && r.command_ids.len() == 1
        && r.error.is_none()));
}

#[test]
fn restart_status_changes_redeploy_and_clock_rollback_do_not_reset_budget() {
    let mut data = ready();
    fill(&mut data, 64);
    for (index, command) in data.commands.values_mut().enumerate() {
        command.status = ["failed", "expired", "unknown", "rejected"][index % 4].into();
    }
    let mut data: Data = serde_json::from_value(serde_json::to_value(data).unwrap()).unwrap();
    data.recover();
    connect(&mut data, at(-1000));
    let revision = data.deployments["budget"].revision.clone();
    data.stop_rule("budget", &revision).unwrap();
    data.deploy(rule("renamed", 1)).unwrap();
    trigger(&mut data, "backward-clock", at(-1000));
    rejected(&data, "backward-clock");
    trigger(&mut data, "after-restart", at(1));
    rejected(&data, "after-restart");
    assert_eq!(data.commands.len(), 64);
}

#[test]
fn property_edges_share_budget_and_rejected_edge_does_not_wait_for_next_window() {
    let mut data = ready();
    fill(&mut data, 64);
    let rule: Rule = serde_json::from_value(json!({"version":1,"id":"threshold",
        "trigger":{"device":"sensor","property":{"path":"environment.temperature","unit":"celsius_x100",
            "edge":"rising","threshold":2800,"hysteresis":100}},"conditions":[],
        "actions":[{"device":"device-lamp","set":{"path":"light.brightness","value":30}}],"cooldown_ms":0})).unwrap();
    data.deploy(rule).unwrap();
    let hello = message(&data, "sensor", "hello", json!({"challenge":"sensor"}));
    data.ingest(hello, at(0)).unwrap();
    for (ms, value) in [
        (1000, 2700),
        (2000, 2900),
        (60000, 2900),
        (61000, 2700),
        (62000, 2900),
    ] {
        data.devices.get_mut("device-lamp").unwrap().last_seen = Some(at(ms));
        let state = message(
            &data,
            "sensor",
            "state",
            json!({"type":"snapshot","revision":data.devices["sensor"].state_revision+1,
            "properties":[{"path":"environment.temperature","value":value,"observed_at":at(ms),"quality":"confirmed","source":"fixture"},
                {"path":"environment.humidity","value":5000,"observed_at":at(ms),"quality":"confirmed","source":"fixture"}]}),
        );
        data.ingest(state, at(ms)).unwrap();
        assert_eq!(data.commands.len(), if ms == 62000 { 65 } else { 64 });
    }
    let runs: Vec<_> = data
        .runs
        .values()
        .filter(|r| r.property_trigger.is_some())
        .collect();
    assert_eq!(runs.len(), 2);
    assert_eq!(
        runs.iter()
            .filter(|r| r.error.as_deref() == Some("automation_budget_exceeded"))
            .count(),
        1
    );
}

#[test]
fn invalid_original_issue_time_stops_automation_without_using_a_new_slot() {
    let mut data = ready();
    fill(&mut data, 1);
    data.commands.values_mut().next().unwrap().envelope.body["issued_at"] = Value::Null;
    trigger(&mut data, "corrupt-time", at(1));
    let run = data
        .runs
        .values()
        .find(|r| r.event_id == "corrupt-time")
        .unwrap();
    assert_eq!(run.error.as_deref(), Some("storage_corrupt"));
    assert!(run.command_ids.is_empty());
    assert_eq!(data.commands.len(), 1);
}

#[test]
fn simulation_and_deployment_do_not_consume_execution_budget() {
    let mut data = ready();
    let candidate = rule("preview", 16);
    for _ in 0..5 {
        let result = data.simulate_rule(&candidate, &json!({"device_id":"device-button","path":"button.pressed","historical":false,"data":{"count":1}}), at(0)).unwrap();
        assert_eq!(result["executed"], false);
        assert_eq!(result["proposed_actions"].as_array().unwrap().len(), 16);
    }
    assert!(data.runs.is_empty() && data.commands.is_empty());
    fill(&mut data, 64);
    data.deploy(candidate.clone()).unwrap();
    assert!(data.simulate_rule(&candidate, &json!({"device_id":"device-button","path":"button.pressed","historical":false,"data":{"count":1}}), at(1)).is_ok());
    assert_eq!(data.commands.len(), 64);
}
