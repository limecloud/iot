use chrono::{DateTime, Duration, Utc};
use limeiot_core::{
    digest,
    engine::{Config, Data},
    model::Model,
    observation::{Policy, Snapshot},
    protocol::{Envelope, Rule},
};
use serde_json::{json, Value};

fn at(second: i64) -> DateTime<Utc> {
    "2026-11-04T00:00:00Z".parse::<DateTime<Utc>>().unwrap() + Duration::seconds(second)
}
fn config() -> Config {
    let mut config: Config =
        serde_json::from_str(include_str!("../../../../deploy/dev/config.json")).unwrap();
    let model: Model = serde_json::from_str(include_str!(
        "../../../../contracts/models/environment.json"
    ))
    .unwrap();
    config.devices.push(
        serde_json::from_value(
            json!({"device_id":"sensor","model_revision":digest(&model).unwrap()}),
        )
        .unwrap(),
    );
    config.models.push(model);
    config
}
fn policy() -> Policy {
    Policy { device_id: "sensor".into(), model_revision: config().devices.last().unwrap().model_revision.clone(),
        source: serde_json::from_value(json!({"adapter_id":"environment-source","revision":format!("sha256:{}","a".repeat(64))})).unwrap() }
}
fn setup() -> (Data, Policy, String) {
    let policy = policy();
    let mut data = Data::new(config())
        .unwrap()
        .with_observation_sources(std::slice::from_ref(&policy))
        .unwrap();
    let token = data.begin_observation(&policy, at(0)).unwrap();
    (data, policy, token)
}
fn snapshot(sequence: u64, temperature: i64, sampled: i64) -> Snapshot {
    serde_json::from_value(json!({"sequence":sequence,"samples":[
        {"path":"environment.temperature","value":temperature,"unit":"celsius_x100","observed_at":at(sampled)},
        {"path":"environment.humidity","value":5000,"unit":"percent_x100","observed_at":at(sampled)}]})).unwrap()
}
fn message(data: &Data, device: &str, kind: &str, body: Value) -> Envelope {
    let device = &data.devices[device];
    serde_json::from_value(
        json!({"v":1,"kind":kind,"message_id":format!("message-{}",device.last_seq+1),
        "device_id":device.device_id,"model_revision":device.model_revision,"boot_id":"native-boot",
        "session_id":device.session_id,"seq":device.last_seq+1,"body":body}),
    )
    .unwrap()
}
fn lamp_ready(data: &mut Data) {
    let hello = message(
        data,
        "device-lamp",
        "hello",
        json!({"challenge":"challenge"}),
    );
    data.ingest(hello, at(0)).unwrap();
    let state = message(
        data,
        "device-lamp",
        "state",
        json!({"type":"snapshot","revision":1,"properties":[
        {"path":"light.power","value":true,"observed_at":at(0),"quality":"confirmed","source":"fixture"},
        {"path":"light.brightness","value":50,"observed_at":at(0),"quality":"confirmed","source":"fixture"}]}),
    );
    data.ingest(state, at(0)).unwrap();
}
fn rule() -> Rule {
    serde_json::from_value(json!({"version":1,"id":"external-warm-light","trigger":{"device":"sensor",
        "property":{"path":"environment.temperature","unit":"celsius_x100","edge":"rising","threshold":2800,"hysteresis":100}},
        "conditions":[],"actions":[{"device":"device-lamp","set":{"path":"light.brightness","value":30}}],"cooldown_ms":0})).unwrap()
}

#[test]
fn source_state_is_visible_without_native_session_or_execution_proof() {
    let (mut data, policy, token) = setup();
    data.observe(&policy, &token, snapshot(1, 2356, 1), at(1))
        .unwrap();
    let view = data
        .devices_view(at(1))
        .into_iter()
        .find(|device| device["device_id"] == "sensor")
        .unwrap();
    assert_eq!(view["ready"], true);
    assert_eq!(
        view["reported"]["environment.temperature"]["quality"],
        "confirmed"
    );
    assert_eq!(view["reported"]["environment.temperature"]["value"], 2356);
    assert_eq!(
        view["reported"]["environment.temperature"]["source"],
        format!(
            "adapter:{}:{}",
            policy.source.adapter_id, policy.source.revision
        )
    );
    assert_eq!(
        view["observation_source"]["revision"],
        policy.source.revision
    );
    assert!(view.get("native_execution").is_none());
    assert!(data.devices["sensor"].boot_id.is_none());
    assert!(data.devices["sensor"].session_id.is_none());
    assert!(data.commands.is_empty());
    assert_eq!(
        data.devices_view(at(17))
            .into_iter()
            .find(|d| d["device_id"] == "sensor")
            .unwrap()["reported"]["environment.temperature"]["quality"],
        "stale"
    );
}

#[test]
fn configured_source_blocks_all_native_mqtt_and_wrong_source_tokens() {
    let (mut data, policy, token) = setup();
    for kind in [
        "hello",
        "state",
        "result",
        "availability",
        "device_info",
        "ota_result",
    ] {
        let input = message(&data, "sensor", kind, json!({"challenge":"native"}));
        assert_eq!(
            data.ingest(input, at(1)).unwrap_err().code,
            "observation_source_mismatch"
        );
    }
    let mut other = policy.clone();
    other.source.adapter_id = "other-source".into();
    assert_eq!(
        data.observe(&other, &token, snapshot(1, 2300, 1), at(1))
            .unwrap_err()
            .code,
        "observation_source_mismatch"
    );
    assert_eq!(
        data.observe(&policy, "old-session", snapshot(1, 2300, 1), at(1))
            .unwrap_err()
            .code,
        "observation_session_mismatch"
    );
    data.observe(&policy, &token, snapshot(1, 2300, 1), at(1))
        .unwrap();
}

#[test]
fn malformed_units_values_time_and_incomplete_snapshots_publish_nothing() {
    let (data, policy, token) = setup();
    let valid = serde_json::to_value(snapshot(1, 2300, 1)).unwrap();
    let mut cases = vec![];
    for (field, value) in [
        ("value", json!("2300")),
        ("value", json!(13001)),
        ("unit", json!("kelvin_x100")),
        ("observed_at", json!(at(2))),
        ("observed_at", json!(at(-1))),
    ] {
        let mut invalid = valid.clone();
        invalid["samples"][0][field] = value;
        cases.push(invalid);
    }
    cases.push(json!({"sequence":1,"samples":[]}));
    cases.push(json!({"sequence":1,"samples":[valid["samples"][0],valid["samples"][0]]}));
    cases.push(json!({"sequence":2,"samples":valid["samples"]}));
    for invalid in cases {
        let mut candidate = data.clone();
        let before = serde_json::to_value(&candidate).unwrap();
        assert!(candidate
            .observe(
                &policy,
                &token,
                serde_json::from_value(invalid).unwrap(),
                at(1)
            )
            .is_err());
        assert_eq!(serde_json::to_value(&candidate).unwrap(), before);
        candidate
            .observe(&policy, &token, snapshot(1, 2300, 1), at(1))
            .unwrap();
    }
    let mut data = data;
    assert_eq!(
        data.observe(&policy, &token, snapshot(1, 2300, 1), at(17))
            .unwrap_err()
            .code,
        "observation_time_invalid"
    );
}

#[test]
fn source_sequence_and_each_property_timestamp_advance_without_replay() {
    let (mut data, policy, token) = setup();
    data.observe(&policy, &token, snapshot(1, 2700, 1), at(1))
        .unwrap();
    for invalid in [
        snapshot(1, 2900, 2),
        snapshot(3, 2900, 2),
        snapshot(2, 2900, 1),
    ] {
        assert_eq!(
            data.observe(&policy, &token, invalid, at(2))
                .unwrap_err()
                .code,
            "observation_out_of_order"
        );
    }
    data.observe(&policy, &token, snapshot(2, 2900, 2), at(2))
        .unwrap();
    assert_eq!(data.devices["sensor"].state_revision, 2);
}

#[test]
fn source_thresholds_use_the_existing_command_ledger_and_original_evidence() {
    let (mut data, policy, token) = setup();
    lamp_ready(&mut data);
    data.deploy(rule()).unwrap();
    data.observe(&policy, &token, snapshot(1, 2700, 1), at(1))
        .unwrap();
    data.observe(&policy, &token, snapshot(2, 2801, 2), at(2))
        .unwrap();
    assert_eq!(data.runs.len(), 1);
    assert_eq!(data.commands.len(), 1);
    let run = data.runs.values().next().unwrap();
    let evidence = run.property_trigger.as_ref().unwrap();
    assert_eq!(evidence.previous.value, 2700);
    assert_eq!(evidence.current.value, 2801);
    let expected =
        digest(&json!({"source":policy.source,"source_session":token,"sample":evidence})).unwrap();
    assert_eq!(run.event_id, format!("state-{}", &expected[7..]));
    let command = data.commands.values().next().unwrap();
    assert_eq!(command.request.device_id, "device-lamp");
    assert_eq!(command.request.operation.value, 30);
    assert_eq!(command.run_id.as_deref(), Some(run.run_id.as_str()));
    data.validate_rule_graph().unwrap();
}

#[test]
fn close_new_session_and_restart_clear_edge_baselines_and_old_tokens() {
    let (mut data, policy, token) = setup();
    lamp_ready(&mut data);
    data.deploy(rule()).unwrap();
    data.observe(&policy, &token, snapshot(1, 2700, 1), at(1))
        .unwrap();
    data.end_observation(&policy, &token).unwrap();
    assert_eq!(
        data.devices_view(at(2))
            .into_iter()
            .find(|d| d["device_id"] == "sensor")
            .unwrap()["ready"],
        false
    );
    let next = data.begin_observation(&policy, at(2)).unwrap();
    assert_eq!(
        data.end_observation(&policy, &token).unwrap_err().code,
        "observation_session_mismatch"
    );
    data.observe(&policy, &next, snapshot(1, 2900, 2), at(2))
        .unwrap();
    assert!(data.runs.is_empty());
    let persisted = serde_json::to_value(&data).unwrap();
    assert!(persisted["devices"]["sensor"]
        .get("observation_session")
        .is_none());
    assert!(persisted["devices"]["sensor"]
        .get("observation_policy")
        .is_none());
    let mut recovered: Data = serde_json::from_value(persisted).unwrap();
    recovered = recovered
        .with_observation_sources(std::slice::from_ref(&policy))
        .unwrap();
    recovered.recover();
    assert_eq!(
        recovered
            .observe(&policy, &next, snapshot(2, 2700, 3), at(3))
            .unwrap_err()
            .code,
        "observation_session_closed"
    );
    let next = recovered.begin_observation(&policy, at(3)).unwrap();
    recovered
        .observe(&policy, &next, snapshot(1, 2900, 3), at(3))
        .unwrap();
    assert!(recovered.runs.is_empty());
}

#[test]
fn external_observation_survives_broker_disconnect_and_conditions_require_live_source() {
    let (mut data, policy, token) = setup();
    lamp_ready(&mut data);
    data.observe(&policy, &token, snapshot(1, 2900, 1), at(1))
        .unwrap();
    let conditions: Vec<limeiot_core::rule_conditions::Condition> = serde_json::from_value(json!([{"device":"sensor","property":"environment.temperature","unit":"celsius_x100","operator":"gt","value":2800}])).unwrap();
    assert!(
        data.evaluate_conditions(&conditions, at(1))
            .unwrap()
            .matched
    );
    data.mqtt_disconnected();
    let view = data.devices_view(at(1));
    assert_eq!(
        view.iter().find(|d| d["device_id"] == "sensor").unwrap()["ready"],
        true
    );
    assert_eq!(
        view.iter()
            .find(|d| d["device_id"] == "device-lamp")
            .unwrap()["ready"],
        false
    );
    assert!(
        data.evaluate_conditions(&conditions, at(1))
            .unwrap()
            .matched
    );
    data.end_observation(&policy, &token).unwrap();
    assert!(
        !data
            .evaluate_conditions(&conditions, at(2))
            .unwrap()
            .matched
    );
}

#[test]
fn sources_require_exact_readonly_model_and_unique_host_identifiers() {
    let config = config();
    let policy = policy();
    assert!(Data::new(config.clone())
        .unwrap()
        .with_observation_sources(&[policy.clone(), policy.clone()])
        .is_err());
    let mut wrong = policy.clone();
    wrong.model_revision = config.devices[0].model_revision.clone();
    assert!(Data::new(config.clone())
        .unwrap()
        .with_observation_sources(&[wrong])
        .is_err());
    let (mut data, policy, token) = setup();
    data.models
        .get_mut(&policy.model_revision)
        .unwrap()
        .services[0]
        .properties[0]
        .unit = Some("kelvin_x100".into());
    assert_eq!(
        data.observe(&policy, &token, snapshot(1, 2300, 1), at(1))
            .unwrap_err()
            .code,
        "observation_model_unsupported"
    );
    let mut config = config;
    config.models.last_mut().unwrap().services[0].properties[0]
        .access
        .push("write".into());
    let revision = digest(config.models.last().unwrap()).unwrap();
    config.devices.last_mut().unwrap().model_revision = revision.clone();
    let mut policy = policy;
    policy.model_revision = revision;
    assert_eq!(
        Data::new(config)
            .unwrap()
            .with_observation_sources(&[policy])
            .unwrap_err()
            .code,
        "observation_model_unsupported"
    );
}

#[test]
fn configured_source_cannot_be_rebound_to_a_later_model_without_changing_host_policy() {
    use limeiot_core::{
        model_bundles::Catalog,
        model_registry::{Change, Request},
    };
    let (mut data, policy, token) = setup();
    let mut later = data.models[&policy.model_revision].clone();
    later.model_version = "1.0.1".into();
    let catalog = Catalog::new([later]).unwrap();
    let bundle = catalog.list()[0].clone();
    data = data.with_model_bundles(catalog);
    let result = data
        .apply_model_change(
            Request {
                space_id: data.space_id.clone(),
                idempotency_key: "change-observation-model".into(),
                change: Change::BindBundle {
                    device_id: policy.device_id.clone(),
                    bundle_id: bundle.bundle_id,
                    expected_model_revision: Some(policy.model_revision.clone()),
                    expected_binding_revision: None,
                },
            },
            at(1),
        )
        .unwrap();
    assert_eq!(result.status, "rejected");
    assert_eq!(result.reason.as_deref(), Some("observation_model_locked"));
    assert_eq!(data.devices["sensor"].model_revision, policy.model_revision);
    data.observe(&policy, &token, snapshot(1, 2300, 1), at(1))
        .unwrap();
}
