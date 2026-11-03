use chrono::{DateTime, Duration, Utc};
use limeiot_core::{
    engine::{Config, Data},
    protocol::{Envelope, Rule},
};
use serde_json::{json, Value};

fn at(seconds: i64) -> DateTime<Utc> {
    "2026-11-03T00:00:00Z".parse::<DateTime<Utc>>().unwrap() + Duration::seconds(seconds)
}
fn message(data: &Data, device: &str, kind: &str, body: Value) -> Envelope {
    let binding = &data.devices[device];
    serde_json::from_value(json!({"v":1,"kind":kind,"message_id":format!("message-{}",binding.last_seq+1),
        "device_id":device,"model_revision":binding.model_revision,"boot_id":format!("boot-{device}"),
        "session_id":binding.session_id,"seq":binding.last_seq+1,"body":body})).unwrap()
}
fn state(data: &mut Data, power: bool, brightness: i64, now: DateTime<Utc>) {
    let input = message(
        data,
        "device-lamp",
        "state",
        json!({"type":"snapshot","revision":data.devices["device-lamp"].state_revision+1,"properties":[
        {"path":"light.power","value":power,"observed_at":now,"quality":"confirmed","source":"fixture"},
        {"path":"light.brightness","value":brightness,"observed_at":now,"quality":"confirmed","source":"fixture"}]}),
    );
    data.ingest(input, now).unwrap();
}
fn connect(data: &mut Data) {
    for device in ["device-lamp", "device-button"] {
        let hello = message(data, device, "hello", json!({"challenge":"fixture"}));
        data.ingest(hello, at(0)).unwrap();
    }
    let input = message(
        data,
        "device-button",
        "state",
        json!({"type":"snapshot","revision":1,"properties":[]}),
    );
    data.ingest(input, at(0)).unwrap();
    state(data, false, 40, at(0));
}
fn ready() -> Data {
    let config: Config =
        serde_json::from_str(include_str!("../../../../deploy/dev/config.json")).unwrap();
    let mut data = Data::new(config).unwrap();
    connect(&mut data);
    data
}
fn rule(conditions: Value) -> Rule {
    let mut value: Value = serde_json::from_str(include_str!(
        "../../../../contracts/examples/button-light.json"
    ))
    .unwrap();
    value["conditions"] = conditions;
    value["cooldown_ms"] = json!(10000);
    serde_json::from_value(value).unwrap()
}
fn compare(operator: &str, value: Value) -> Value {
    json!({"device":"device-lamp","property":"light.brightness","operator":operator,"value":value,"unit":"percent"})
}
fn power(value: bool) -> Value {
    json!({"device":"device-lamp","property":"light.power","operator":"eq","value":value})
}
fn press(data: &mut Data, id: &str, now: DateTime<Utc>) {
    let input = message(
        data,
        "device-button",
        "event",
        json!({"event_id":id,"path":"button.pressed","occurred_at":now,"historical":false,"data":{"count":1}}),
    );
    data.ingest(input, now).unwrap();
}

#[test]
fn all_numeric_operators_and_boolean_equality_have_no_implicit_conversion() {
    let data = ready();
    for (operator, value, expected) in [
        ("eq", 40, true),
        ("ne", 40, false),
        ("lt", 40, false),
        ("lte", 40, true),
        ("gt", 39, true),
        ("gte", 41, false),
    ] {
        let rule = rule(json!([compare(operator, json!(value))]));
        data.validate_rule(&rule).unwrap();
        assert_eq!(
            data.evaluate_conditions(&rule.conditions, at(0))
                .unwrap()
                .matched,
            expected,
            "{operator}"
        );
    }
    for c in [
        compare("gt", json!("30")),
        compare("eq", Value::Null),
        json!({"device":"device-lamp","property":"light.power","operator":"gt","value":true}),
        json!({"device":"device-button","property":"button.pressed","operator":"eq","value":true}),
    ] {
        assert!(data.validate_rule(&rule(json!([c]))).is_err());
    }
    assert!(
        data.evaluate_conditions(&rule(json!([power(false)])).conditions, at(0))
            .unwrap()
            .matched
    );
}
#[test]
fn text_comparisons_use_exact_values_and_only_equality_operators() {
    let mut config: Config =
        serde_json::from_str(include_str!("../../../../deploy/dev/config.json")).unwrap();
    config.models[0].services[0].properties[0].schema =
        serde_json::from_value(json!({"type":"string","maxLength":16})).unwrap();
    config.devices[0].model_revision = limeiot_core::digest(&config.models[0]).unwrap();
    let mut data = Data::new(config).unwrap();
    let hello = message(&data, "device-lamp", "hello", json!({"challenge":"text"}));
    data.ingest(hello, at(0)).unwrap();
    let input = message(
        &data,
        "device-lamp",
        "state",
        json!({"type":"snapshot","revision":1,"properties":[
        {"path":"light.power","value":"night","observed_at":at(0),"quality":"confirmed","source":"fixture"},
        {"path":"light.brightness","value":40,"observed_at":at(0),"quality":"confirmed","source":"fixture"}]}),
    );
    data.ingest(input, at(0)).unwrap();
    for (operator, value, expected) in [
        ("eq", "night", true),
        ("ne", "night", false),
        ("eq", "Night", false),
        ("ne", "day", true),
    ] {
        let mut candidate = rule(
            json!([{"device":"device-lamp","property":"light.power","operator":operator,"value":value}]),
        );
        candidate.actions = serde_json::from_value(
            json!([{"device":"device-lamp","set":{"path":"light.brightness","value":30}}]),
        )
        .unwrap();
        data.validate_rule(&candidate).unwrap();
        assert_eq!(
            data.evaluate_conditions(&candidate.conditions, at(0))
                .unwrap()
                .matched,
            expected
        );
    }
    assert!(data.validate_rule(&rule(json!([{"device":"device-lamp","property":"light.power","operator":"lt","value":"night"}]))).is_err());
}

#[test]
fn units_are_explicit_and_condition_shapes_are_strict() {
    let data = ready();
    for c in [
        json!({"device":"device-lamp","property":"light.brightness","operator":"eq","value":40}),
        json!({"device":"device-lamp","property":"light.brightness","operator":"eq","value":40,"unit":"celsius"}),
        json!({"device":"device-lamp","property":"light.power","operator":"eq","value":false,"unit":"boolean"}),
    ] {
        assert_eq!(
            data.validate_rule(&rule(json!([c]))).unwrap_err().code,
            "invalid_condition"
        );
    }
    for c in [
        json!({"shell":"reboot"}),
        json!({"all":[],"any":[]}),
        json!({"all":null}),
        json!({"device":"device-lamp","property":"light.power","operator":"eq","value":false,"unit":null}),
        json!({"device":"device-lamp","property":"light.power","operator":"eq"}),
        json!({"device":"device-lamp","property":"light.power","operator":"eq","value":false,"shell":"reboot"}),
    ] {
        let mut raw = serde_json::to_value(rule(json!([]))).unwrap();
        raw["conditions"] = json!([c]);
        assert!(serde_json::from_value::<Rule>(raw).is_err());
    }
}
#[test]
fn nested_all_any_are_bounded_and_unknown_never_becomes_true_by_inequality() {
    let mut data = ready();
    let rule = rule(json!([{"all":[compare("gte",json!(40)),{"any":[power(true),power(false)]}]}]));
    data.validate_rule(&rule).unwrap();
    let evaluation = data.evaluate_conditions(&rule.conditions, at(0)).unwrap();
    assert!(evaluation.matched);
    assert_eq!(evaluation.results[0].children.len(), 2);
    data.devices
        .get_mut("device-lamp")
        .unwrap()
        .reported
        .get_mut("light.power")
        .unwrap()
        .quality = "unknown".into();
    assert!(
        !data
            .evaluate_conditions(&rule.conditions, at(0))
            .unwrap()
            .matched
    );
    let mut ne = power(true);
    ne["operator"] = json!("ne");
    assert!(!data.evaluate_conditions(&serde_json::from_value::<Rule>(json!({"version":1,"id":"ne","trigger":{"device":"device-button","event":"button.pressed"},"conditions":[ne],"actions":[{"device":"device-lamp","set":{"path":"light.power","value":true}}],"cooldown_ms":0})).unwrap().conditions,at(0)).unwrap().matched);
}
#[test]
fn depth_node_and_group_limits_apply_to_validation_and_direct_evaluation() {
    let data = ready();
    let mut condition = power(false);
    for _ in 0..3 {
        condition = json!({"all":[condition]});
    }
    data.validate_rule(&rule(json!([condition.clone()])))
        .unwrap();
    for conditions in [
        json!([{"all":[condition]}]),
        json!([{"all":[]}]),
        json!([{"any":[]}]),
        json!(vec![power(false); 17]),
        json!(vec![json!({"any":[power(false),power(false)]}); 16]),
    ] {
        let rule = rule(conditions);
        assert_eq!(
            data.validate_rule(&rule).unwrap_err().code,
            "invalid_condition"
        );
        assert!(data.evaluate_conditions(&rule.conditions, at(0)).is_err());
    }
}
#[test]
fn offline_unknown_stale_missing_and_future_observations_fail_closed() {
    for reason in [
        "device_offline",
        "unconfirmed_observation",
        "stale_observation",
        "missing_observation",
        "future_observation",
    ] {
        let mut data = ready();
        let rule = rule(json!([compare("ne", json!(30))]));
        let device = data.devices.get_mut("device-lamp").unwrap();
        match reason {
            "device_offline" => device.ready = false,
            "unconfirmed_observation" => {
                device.reported.get_mut("light.brightness").unwrap().quality = "estimated".into()
            }
            "stale_observation" => {
                device
                    .reported
                    .get_mut("light.brightness")
                    .unwrap()
                    .observed_at = at(-100)
            }
            "missing_observation" => {
                device.reported.remove("light.brightness");
            }
            _ => {
                device
                    .reported
                    .get_mut("light.brightness")
                    .unwrap()
                    .observed_at = at(1)
            }
        }
        let evaluation = data.evaluate_conditions(&rule.conditions, at(0)).unwrap();
        assert!(!evaluation.matched);
        assert_eq!(evaluation.results[0].reason.as_deref(), Some(reason));
    }
}
#[test]
fn unmet_conditions_record_evidence_without_consuming_cooldown_or_budget() {
    let mut data = ready();
    let rule = rule(json!([power(true)]));
    data.deploy(rule.clone()).unwrap();
    press(&mut data, "not-met", at(0));
    assert!(data.commands.is_empty());
    assert_eq!(data.deployments[&rule.id].last_run, None);
    let run = data.runs.values().next().unwrap();
    assert_eq!(run.error.as_deref(), Some("rule_conditions_not_met"));
    let original = run.condition_evaluation.clone().unwrap();
    assert_eq!(
        original.results[0].observation.as_ref().unwrap().value,
        false
    );
    state(&mut data, true, 40, at(1));
    press(&mut data, "met", at(1));
    assert_eq!(data.commands.len(), 1);
    assert_eq!(data.deployments[&rule.id].last_run, Some(at(1)));
    press(&mut data, "cooling", at(2));
    assert_eq!(data.runs.len(), 2);
    assert_eq!(
        serde_json::to_value(
            &data
                .runs
                .values()
                .find(|r| r.event_id == "not-met")
                .unwrap()
                .condition_evaluation
        )
        .unwrap(),
        serde_json::to_value(Some(original)).unwrap()
    );
    data.validate_saved_conditions().unwrap();
}
#[test]
fn ai_event_drafts_do_not_implicitly_gain_condition_generation() {
    let mut data = ready();
    let request=serde_json::from_value(json!({"space_id":data.space_id,"idempotency_key":"condition-draft","prompt":"按下按钮开灯","expires_at":at(60)})).unwrap();
    let draft = data.create_draft(request, "fixture-local", at(0)).unwrap();
    let mut candidate = rule(json!([power(false)]));
    candidate.id = format!("ai-{}", draft.draft_id);
    assert!(data.validate_rule(&candidate).is_ok());
    let result = data
        .finish_draft(&draft.draft_id, Ok(candidate), None, at(0))
        .unwrap();
    assert_eq!(result.error.as_deref(), Some("invalid_model_output"));
    assert!(result.rule.is_none() && data.deployments.is_empty() && data.commands.is_empty());
}

#[test]
fn simulation_uses_current_snapshot_and_is_side_effect_free() {
    let mut data = ready();
    let candidate = rule(json!([power(true)]));
    let input = json!({"device_id":"device-button","path":"button.pressed","historical":false,"data":{"count":1}});
    let before = serde_json::to_value(&data).unwrap();
    let result = data.simulate_rule(&candidate, &input, at(0)).unwrap();
    assert_eq!(result["matched"], false);
    assert_eq!(result["trigger_matched"], true);
    assert_eq!(
        result["condition_evaluation"]["results"][0]["observation"]["value"],
        false
    );
    assert_eq!(serde_json::to_value(&data).unwrap(), before);
    state(&mut data, true, 40, at(1));
    let result = data.simulate_rule(&candidate, &input, at(1)).unwrap();
    assert_eq!(result["matched"], true);
    assert_eq!(result["executed"], false);
    let invalid_trigger = json!({"device_id":"another-device","path":"button.pressed","historical":false,"data":{"count":1}});
    let result = data
        .simulate_rule(&candidate, &invalid_trigger, at(1))
        .unwrap();
    assert_eq!(result["trigger_matched"], false);
    assert_eq!(result["condition_evaluation"]["matched"], true);
    assert_eq!(result["matched"], false);
    assert_eq!(result["proposed_actions"], json!([]));
    assert!(data.runs.is_empty() && data.commands.is_empty());
}
#[test]
fn heartbeat_gap_rebuilds_baseline_and_new_edge_uses_current_condition() {
    let mut data = ready();
    let mut candidate = rule(json!([power(false)]));
    candidate.trigger=serde_json::from_value(json!({"device":"device-lamp","property":{"path":"light.brightness","unit":"percent","edge":"rising","threshold":50,"hysteresis":5}})).unwrap();
    candidate.actions = serde_json::from_value(
        json!([{"device":"device-lamp","set":{"path":"light.power","value":true}}]),
    )
    .unwrap();
    data.deploy(candidate).unwrap();
    state(&mut data, false, 40, at(0));
    state(&mut data, false, 60, at(31));
    assert!(data.runs.is_empty());
    state(&mut data, false, 40, at(32));
    state(&mut data, false, 60, at(33));
    let run = data.runs.values().next().unwrap();
    assert!(run.condition_evaluation.as_ref().unwrap().matched);
    assert!(run.error.is_none());
    assert_eq!(run.command_ids.len(), 1);
}

#[test]
fn recovery_needs_new_session_observations_and_preserves_original_evidence() {
    let mut data = ready();
    data.deploy(rule(json!([power(false)]))).unwrap();
    press(&mut data, "original", at(0));
    let evidence = serde_json::to_value(&data.runs).unwrap();
    let mut restored: Data = serde_json::from_value(serde_json::to_value(data).unwrap()).unwrap();
    restored.recover();
    let conditions = restored
        .deployments
        .values()
        .next()
        .unwrap()
        .rule
        .conditions
        .clone();
    assert!(
        !restored
            .evaluate_conditions(&conditions, at(1))
            .unwrap()
            .matched
    );
    assert_eq!(serde_json::to_value(&restored.runs).unwrap(), evidence);
    restored.validate_saved_conditions().unwrap();
    let run = restored.runs.values_mut().next().unwrap();
    run.condition_evaluation.as_mut().unwrap().results[0]
        .observation
        .as_mut()
        .unwrap()
        .value = json!(true);
    assert!(restored.validate_saved_conditions().is_err());
}
