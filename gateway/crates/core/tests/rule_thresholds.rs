use chrono::{DateTime, Duration, Utc};
use limeiot_core::{
    digest,
    engine::{Config, Data},
    model::Model,
    protocol::{Envelope, Rule, Trigger},
};
use serde_json::{json, Value};

fn at(seconds: i64) -> DateTime<Utc> {
    "2026-11-03T00:00:00Z".parse::<DateTime<Utc>>().unwrap() + Duration::seconds(seconds)
}
fn rule() -> Rule {
    serde_json::from_value(json!({"version":1,"id":"warm-light",
        "trigger":{"device":"sensor","property":{"path":"environment.temperature","unit":"celsius_x100",
            "edge":"rising","threshold":2800,"hysteresis":100}},
        "conditions":[],"actions":[{"device":"lamp","set":{"path":"light.brightness","value":30}}],"cooldown_ms":0})).unwrap()
}
fn envelope(data: &Data, device: &str, kind: &str, body: Value) -> Envelope {
    let binding = &data.devices[device];
    serde_json::from_value(
        json!({"v":1,"message_id":format!("message-{}",binding.last_seq+1),
        "device_id":device,"model_revision":binding.model_revision,"kind":kind,
        "boot_id":binding.boot_id.clone().unwrap_or_else(|| format!("boot-{device}")),
        "session_id":binding.session_id,"seq":binding.last_seq+1,"body":body}),
    )
    .unwrap()
}
fn ready() -> Data {
    let lamp: Model =
        serde_json::from_str(include_str!("../../../../contracts/models/lamp.json")).unwrap();
    let environment: Model = serde_json::from_str(include_str!(
        "../../../../contracts/models/environment.json"
    ))
    .unwrap();
    let config: Config =
        serde_json::from_value(json!({"space_id":"home","models":[lamp,environment],
        "devices":[{"device_id":"lamp","model_revision":digest(&lamp).unwrap()},
            {"device_id":"sensor","model_revision":digest(&environment).unwrap()}]}))
        .unwrap();
    let mut data = Data::new(config).unwrap();
    for device in ["lamp", "sensor"] {
        let message = envelope(&data, device, "hello", json!({"challenge":"challenge"}));
        data.ingest(message, at(0)).unwrap();
    }
    let lamp_state = envelope(
        &data,
        "lamp",
        "state",
        json!({"type":"snapshot","revision":1,"properties":[
        {"path":"light.power","value":true,"observed_at":at(0),"quality":"confirmed","source":"fixture"},
        {"path":"light.brightness","value":50,"observed_at":at(0),"quality":"confirmed","source":"fixture"}]}),
    );
    data.ingest(lamp_state, at(0)).unwrap();
    data
}
fn observation(value: i64, sampled: i64, quality: &str) -> Value {
    json!({"value":value,"observed_at":at(sampled),"quality":quality,"source":"fixture.sht3x"})
}
fn sample(data: &mut Data, value: i64, now: i64, sampled: i64, quality: &str) -> Envelope {
    // 夹具保持目标灯的心跳；是否ready仍由各测试控制。
    data.devices.get_mut("lamp").unwrap().last_seen = Some(at(now));
    let mut temp = observation(value, sampled, quality);
    temp["path"] = json!("environment.temperature");
    let mut humidity = observation(5000, sampled, "confirmed");
    humidity["path"] = json!("environment.humidity");
    let message = envelope(
        data,
        "sensor",
        "state",
        json!({"type":"snapshot",
        "revision":data.devices["sensor"].state_revision+1,"properties":[temp,humidity]}),
    );
    data.ingest(message.clone(), at(now)).unwrap();
    message
}
#[test]
fn trigger_shape_is_exclusive_and_legacy_rule_digest_is_unchanged() {
    let old: Value = serde_json::from_str(include_str!(
        "../../../../contracts/examples/button-light.json"
    ))
    .unwrap();
    let parsed: Rule = serde_json::from_value(old.clone()).unwrap();
    assert_eq!(digest(&parsed).unwrap(), digest(&old).unwrap());
    let property = serde_json::to_value(rule()).unwrap()["trigger"].clone();
    for input in [
        json!({"device":"sensor"}),
        json!({"device":"sensor","property":null}),
        json!({"device":"sensor","event":"button.pressed","property":property["property"]}),
        json!({"device":"sensor","event":null,"property":property["property"]}),
        json!({"device":"sensor","property":property["property"],"shell":"reboot"}),
    ] {
        assert!(
            serde_json::from_value::<Trigger>(input.clone()).is_err(),
            "{input}"
        );
    }
}
#[test]
fn thresholds_require_numeric_read_notify_units_and_reachable_hysteresis() {
    let data = ready();
    assert!(data.validate_rule(&rule()).is_ok());
    for (key, value) in [
        ("unit", json!("celsius")),
        ("threshold", json!(14000)),
        ("threshold", json!("2800")),
        ("hysteresis", json!(-1)),
        ("hysteresis", json!(0.5)),
        ("hysteresis", json!(100000)),
        ("edge", json!("above")),
    ] {
        let mut candidate = serde_json::to_value(rule()).unwrap();
        candidate["trigger"]["property"][key] = value;
        if let Ok(candidate) = serde_json::from_value::<Rule>(candidate) {
            assert!(data.validate_rule(&candidate).is_err(), "{key}");
        }
    }
    let mut model = data.models[&data.devices["sensor"].model_revision].clone();
    model.services[0].properties[0].unit = Some("kelvin_x100".into());
    assert!(rule().trigger.validate_model(&model).is_err());
    model.services[0].properties[0].unit = Some("celsius_x100".into());
    model.services[0].properties[0].access = vec!["read".into()];
    assert!(rule().trigger.validate_model(&model).is_err());
}
#[test]
fn rising_edge_has_baseline_strict_crossing_hysteresis_and_sample_evidence() {
    let mut data = ready();
    data.deploy(rule()).unwrap();
    for (second, value, expected) in [
        (1, 2900, 0),
        (2, 2700, 0),
        (3, 2800, 0),
        (4, 2801, 1),
        (5, 2850, 1),
        (6, 2750, 1),
        (7, 2900, 1),
        (8, 2699, 1),
        (9, 2801, 2),
    ] {
        sample(&mut data, value, second, second, "confirmed");
        assert_eq!(data.runs.len(), expected, "second {second}");
    }
    assert_eq!(data.commands.len(), 2);
    for run in data.runs.values() {
        let evidence = run.property_trigger.as_ref().unwrap();
        assert_eq!(evidence.device_id, "sensor");
        assert!(evidence.current.observed_at > evidence.previous.observed_at);
        assert_eq!(evidence.current.value, 2801);
        assert!(run.event_id.starts_with("state-"));
    }
}
#[test]
fn falling_edge_and_zero_hysteresis_use_opposite_inclusive_rearm_boundary() {
    let mut data = ready();
    let mut input = serde_json::to_value(rule()).unwrap();
    input["trigger"]["property"]["edge"] = json!("falling");
    input["trigger"]["property"]["hysteresis"] = json!(0);
    data.deploy(serde_json::from_value(input).unwrap()).unwrap();
    for (second, value, expected) in [
        (1, 2700, 0),
        (2, 2800, 0),
        (3, 2799, 1),
        (4, 2700, 1),
        (5, 2800, 1),
        (6, 2799, 2),
    ] {
        sample(&mut data, value, second, second, "confirmed");
        assert_eq!(data.runs.len(), expected);
    }
}
#[test]
fn duplicate_cached_and_out_of_order_samples_do_not_create_edges() {
    let mut data = ready();
    data.deploy(rule()).unwrap();
    let original = sample(&mut data, 2700, 1, 1, "confirmed");
    data.ingest(original, at(2)).unwrap();
    sample(&mut data, 2900, 2, 1, "confirmed");
    sample(&mut data, 2900, 3, 0, "confirmed");
    assert!(data.runs.is_empty());
    sample(&mut data, 2900, 4, 4, "confirmed");
    assert_eq!(data.runs.len(), 1);
}
#[test]
fn stale_unknown_future_and_sampling_gaps_require_a_new_baseline() {
    for (quality, second, sampled) in [
        ("unknown", 2, 2),
        ("estimated", 2, 2),
        ("confirmed", 20, 1),
        ("confirmed", 2, 3),
        ("confirmed", 20, 20),
        ("confirmed", 20, 15),
    ] {
        let mut data = ready();
        data.deploy(rule()).unwrap();
        sample(&mut data, 2700, 1, 1, "confirmed");
        sample(&mut data, 2900, second, sampled, quality);
        let next = second + 2;
        sample(&mut data, 2900, next, next, "confirmed");
        assert!(data.runs.is_empty(), "{quality} {second} {sampled}");
        sample(&mut data, 2700, next + 1, next + 1, "confirmed");
        sample(&mut data, 2900, next + 2, next + 2, "confirmed");
        assert_eq!(data.runs.len(), 1);
    }
}
#[test]
fn cooldown_consumes_edges_and_recovery_keeps_original_commands_without_replay() {
    let mut data = ready();
    let mut input = rule();
    input.cooldown_ms = 10000;
    data.deploy(input).unwrap();
    for (s, v) in [(1, 2700), (2, 2900), (3, 2700), (4, 2900), (13, 2900)] {
        sample(&mut data, v, s, s, "confirmed");
        if s == 2 {
            data.prepare_dispatch(at(2));
        }
    }
    assert_eq!(data.runs.len(), 1);
    data.prepare_dispatch(at(13));
    let original = data.commands.keys().next().unwrap().clone();
    let encoded = serde_json::to_string(&data).unwrap();
    assert!(!encoded.contains("threshold_cursors"));
    let mut restored: Data = serde_json::from_str(&encoded).unwrap();
    restored.recover();
    assert_eq!(restored.commands[&original].status, "unknown");
    let hello = envelope(
        &restored,
        "sensor",
        "hello",
        json!({"challenge":"new-challenge"}),
    );
    restored.ingest(hello, at(14)).unwrap();
    sample(&mut restored, 2900, 15, 15, "confirmed");
    assert_eq!(restored.runs.len(), 1);
    sample(&mut restored, 2700, 16, 16, "confirmed");
    sample(&mut restored, 2900, 17, 17, "confirmed");
    assert_eq!(restored.runs.len(), 2);
    assert_eq!(restored.commands[&original].status, "unknown");
}
#[test]
fn simulation_checks_two_fresh_samples_and_has_no_side_effects() {
    let data = ready();
    let before = serde_json::to_value(&data).unwrap();
    let input = json!({"device_id":"sensor","path":"environment.temperature","historical":false,
        "previous":observation(2700,1,"confirmed"),"current":observation(2900,2,"confirmed")});
    let result = data.simulate_rule(&rule(), &input, at(2)).unwrap();
    assert_eq!(result["matched"], true);
    assert_eq!(result["executed"], false);
    for field in ["historical", "previous", "current"] {
        let mut bad = input.clone();
        if field == "historical" {
            bad[field] = json!(true);
        } else {
            bad[field]["quality"] = json!("unknown");
        }
        assert_eq!(
            data.simulate_rule(&rule(), &bad, at(2)).unwrap()["matched"],
            false
        );
    }
    assert_eq!(
        data.simulate_rule(&rule(), &input, at(30)).unwrap()["matched"],
        false
    );
    assert_eq!(serde_json::to_value(data).unwrap(), before);
}
