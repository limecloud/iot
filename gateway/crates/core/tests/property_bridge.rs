use chrono::{DateTime, Duration, Utc};
use limeiot_core::{
    digest,
    engine::{Command, Config, Data},
    execution::AdapterReceipt,
    observation::Snapshot,
    property_bridge::Policy,
    protocol::{CommandRequest, Envelope},
};
use serde_json::{json, Value};

fn at(second: i64) -> DateTime<Utc> {
    "2026-11-04T00:00:00Z".parse::<DateTime<Utc>>().unwrap() + Duration::seconds(second)
}
fn config() -> Config {
    serde_json::from_str(include_str!("../../../../deploy/dev/config.json")).unwrap()
}
fn bridge_policy(config: &Config) -> Policy {
    serde_json::from_value(json!({"observation":{"device_id":"device-lamp",
        "model_revision":config.devices[0].model_revision,
        "source":{"adapter_id":"property-source","revision":format!("sha256:{}","b".repeat(64))}},
        "write_paths":["light.power","light.brightness"]}))
    .unwrap()
}
fn initial() -> (Data, Policy) {
    let config = config();
    let policy = bridge_policy(&config);
    let data = Data::new(config)
        .unwrap()
        .with_property_bridges(std::slice::from_ref(&policy))
        .unwrap()
        .restore_observation_bindings()
        .unwrap();
    (data, policy)
}
fn snapshot(sequence: u64, power: bool, second: i64) -> Snapshot {
    serde_json::from_value(json!({"sequence":sequence,"samples":[
        {"path":"light.power","value":power,"observed_at":at(second)},
        {"path":"light.brightness","value":10,"unit":"percent","observed_at":at(second)}]}))
    .unwrap()
}
fn setup() -> (Data, Policy, String) {
    let (mut data, policy) = initial();
    let token = data.begin_observation(&policy.observation, at(0)).unwrap();
    data.observe(&policy.observation, &token, snapshot(1, false, 1), at(1))
        .unwrap();
    (data, policy, token)
}
fn input(data: &Data, key: &str) -> CommandRequest {
    serde_json::from_value(json!({"space_id":data.space_id,"device_id":"device-lamp",
        "model_revision":data.devices["device-lamp"].model_revision,
        "idempotency_key":key,"expires_at":at(12),
        "operation":{"type":"property.set","path":"light.power","value":true}}))
    .unwrap()
}
fn dispatched(data: &mut Data) -> Command {
    let command = data
        .create_command(input(data, "power-on"), at(2), None)
        .unwrap();
    assert!(data.prepare_dispatch(at(2)).is_empty());
    let dispatched = data.prepare_adapter_dispatch("property-source", at(2));
    assert_eq!(dispatched.len(), 1);
    assert_eq!(dispatched[0].command_id, command.command_id);
    assert!(data
        .prepare_adapter_dispatch("property-source", at(2))
        .is_empty());
    data.recheck_adapter_dispatch(&dispatched[0], at(2))
        .unwrap();
    dispatched[0].clone()
}
fn receipt(command: &Command) -> AdapterReceipt {
    AdapterReceipt {
        command_id: command.command_id.clone(),
        route: command.execution_route.clone().unwrap(),
        session_id: command.envelope.session_id.clone().unwrap(),
        request_digest: command.request_digest.clone(),
        status: "protocol_accepted".into(),
        error: None,
        observed_at: at(3),
    }
}

#[test]
fn read_only_port_and_plain_config_cannot_acquire_property_execution() {
    let config = config();
    let policy = bridge_policy(&config);
    assert_eq!(
        Data::new(config.clone())
            .unwrap()
            .with_observation_sources(std::slice::from_ref(&policy.observation))
            .unwrap_err()
            .code,
        "observation_model_unsupported"
    );
    let mut routed = config.clone();
    routed.devices[0]
        .routes
        .insert("light.power".into(), policy.observation.source.clone());
    assert!(Data::new(routed).is_err());
    for paths in [
        vec![],
        vec!["light.power"],
        vec!["light.power", "light.brightness", "light.other"],
    ] {
        let mut invalid = policy.clone();
        invalid.write_paths = paths.into_iter().map(String::from).collect();
        assert_eq!(
            Data::new(config.clone())
                .unwrap()
                .with_property_bridges(&[invalid])
                .unwrap_err()
                .code,
            "property_bridge_model_unsupported"
        );
    }
    let mut eventful = config;
    eventful.models[0].services[0].events = eventful.models[1].services[0].events.clone();
    eventful.devices[0].model_revision = digest(&eventful.models[0]).unwrap();
    let policy = bridge_policy(&eventful);
    assert_eq!(
        Data::new(eventful)
            .unwrap()
            .with_property_bridges(&[policy])
            .unwrap_err()
            .code,
        "observation_model_unsupported"
    );
}

#[test]
fn bridge_requires_complete_fresh_observation_and_has_no_native_identity() {
    let (mut data, policy) = initial();
    assert_eq!(
        data.adapter_seen(
            "device-lamp",
            &policy.observation.source,
            "fake-session",
            at(0)
        )
        .unwrap_err()
        .code,
        "property_bridge_session_required"
    );
    assert_eq!(
        data.create_command(input(&data, "offline"), at(0), None)
            .unwrap_err()
            .code,
        "device_offline"
    );
    let token = data.begin_observation(&policy.observation, at(0)).unwrap();
    assert_eq!(
        data.create_command(input(&data, "not-sampled"), at(0), None)
            .unwrap_err()
            .code,
        "device_offline"
    );
    data.observe(&policy.observation, &token, snapshot(1, false, 1), at(1))
        .unwrap();
    let command = data
        .create_command(input(&data, "online"), at(2), None)
        .unwrap();
    assert_eq!(command.envelope.session_id.as_deref(), Some(token.as_str()));
    assert_eq!(
        command.execution_route,
        Some(policy.observation.source.clone())
    );
    assert!(data.devices["device-lamp"].boot_id.is_none());
    assert!(data.devices["device-lamp"].session_id.is_none());
    for kind in [
        "hello",
        "state",
        "result",
        "receipt",
        "device_info",
        "ota_result",
    ] {
        let envelope: Envelope =
            serde_json::from_value(json!({"v":1,"kind":kind,"message_id":"native",
            "device_id":"device-lamp","model_revision":policy.observation.model_revision,
            "boot_id":"native","seq":1,"body":{"challenge":"native"}}))
            .unwrap();
        assert_eq!(
            data.ingest(envelope, at(2)).unwrap_err().code,
            "observation_source_mismatch"
        );
    }
    data.mqtt_disconnected();
    assert_eq!(data.commands[&command.command_id].status, "accepted");
    assert_eq!(
        data.prepare_adapter_dispatch("property-source", at(2))
            .len(),
        1
    );
}

#[test]
fn protocol_acceptance_does_not_confirm_or_modify_reported_state() {
    let (mut data, policy, token) = setup();
    let command = dispatched(&mut data);
    let before = data.devices["device-lamp"].reported.clone();
    let accepted = data
        .apply_property_adapter_result(receipt(&command), at(3))
        .unwrap();
    assert_eq!(accepted.status, "dispatched");
    assert_eq!(
        data.recheck_adapter_dispatch(&command, at(3))
            .unwrap_err()
            .code,
        "execution_authorization_rejected"
    );
    assert_eq!(
        accepted.evidence.as_ref().unwrap()["type"],
        "property_adapter_result"
    );
    assert_eq!(
        serde_json::to_value(&data.devices["device-lamp"].reported).unwrap(),
        json!(before)
    );
    data.observe(&policy.observation, &token, snapshot(2, true, 4), at(4))
        .unwrap();
    let confirmed = &data.commands[&command.command_id];
    assert_eq!(confirmed.status, "confirmed");
    assert_eq!(
        confirmed.evidence.as_ref().unwrap()["type"],
        "property_observation_result"
    );
    assert_eq!(
        data.devices["device-lamp"].reported["light.power"].value,
        true
    );
    data.validate_property_bridge_receipts().unwrap();
    data.validate_execution_routes().unwrap();
    assert_eq!(
        data.apply_property_adapter_result(receipt(&command), at(5))
            .unwrap_err()
            .code,
        "invalid_transition"
    );
    assert!(data
        .prepare_adapter_dispatch("property-source", at(5))
        .is_empty());
}

#[test]
fn pre_receipt_or_same_timestamp_reads_do_not_confirm_and_duplicate_ack_keeps_barrier() {
    let (mut data, policy, token) = setup();
    let command = dispatched(&mut data);
    data.observe(&policy.observation, &token, snapshot(2, true, 2), at(2))
        .unwrap();
    assert_eq!(data.commands[&command.command_id].status, "dispatched");
    let first = data
        .apply_property_adapter_result(receipt(&command), at(3))
        .unwrap();
    data.observe(&policy.observation, &token, snapshot(3, true, 3), at(4))
        .unwrap();
    assert_eq!(data.commands[&command.command_id].status, "dispatched");
    let duplicate = data
        .apply_property_adapter_result(receipt(&command), at(4))
        .unwrap();
    assert_eq!(duplicate.evidence, first.evidence);
    data.observe(&policy.observation, &token, snapshot(4, true, 4), at(4))
        .unwrap();
    assert_eq!(data.commands[&command.command_id].status, "confirmed");
}

#[test]
fn differing_state_keeps_fifo_blocked_until_independent_matching_read() {
    let (mut data, policy, token) = setup();
    let first = dispatched(&mut data);
    let mut next = input(&data, "power-off");
    next.operation.value = json!(false);
    let second = data.create_command(next, at(2), None).unwrap();
    data.apply_property_adapter_result(receipt(&first), at(3))
        .unwrap();
    data.observe(&policy.observation, &token, snapshot(2, false, 4), at(4))
        .unwrap();
    assert_eq!(data.commands[&first.command_id].status, "dispatched");
    assert!(data
        .prepare_adapter_dispatch("property-source", at(4))
        .is_empty());
    assert_eq!(data.commands[&second.command_id].status, "accepted");
    data.observe(&policy.observation, &token, snapshot(3, true, 5), at(5))
        .unwrap();
    assert_eq!(
        data.prepare_adapter_dispatch("property-source", at(5))[0].command_id,
        second.command_id
    );
}

#[test]
fn wrong_identity_digest_status_or_receipt_time_is_rejected_without_mutation() {
    let (mut data, _, _) = setup();
    let command = dispatched(&mut data);
    let valid = json!(receipt(&command));
    for (field, value) in [
        ("session_id", json!("old-token")),
        (
            "request_digest",
            json!(format!("sha256:{}", "a".repeat(64))),
        ),
        (
            "route",
            json!({"adapter_id":"other-source","revision":command.execution_route.as_ref().unwrap().revision}),
        ),
        ("status", json!("confirmed")),
        ("status", json!("failed")),
        ("error", json!("device_failed")),
        ("observed_at", json!(at(1))),
        ("observed_at", json!(at(4))),
    ] {
        let mut data = data.clone();
        let before = json!(&data);
        let mut bad = valid.clone();
        bad[field] = value;
        assert!(data
            .apply_property_adapter_result(serde_json::from_value(bad).unwrap(), at(3))
            .is_err());
        assert_eq!(json!(&data), before);
    }
    assert_eq!(
        data.apply_adapter_result(receipt(&command), at(3))
            .unwrap_err()
            .code,
        "unsupported_execution_route"
    );
    data.apply_property_adapter_result(receipt(&command), at(3))
        .unwrap();
    let before = json!(&data);
    let mut changed = receipt(&command);
    changed.observed_at = at(4);
    assert_eq!(
        data.apply_property_adapter_result(changed, at(4))
            .unwrap_err()
            .code,
        "duplicate_conflict"
    );
    assert_eq!(json!(&data), before);
}

#[test]
fn expiry_and_explicit_unknown_never_become_confirmed_by_later_state() {
    for explicit in [false, true] {
        let (mut data, policy, token) = setup();
        let command = dispatched(&mut data);
        data.apply_property_adapter_result(receipt(&command), at(3))
            .unwrap();
        if explicit {
            let mut unknown = receipt(&command);
            unknown.status = "unknown".into();
            unknown.error = Some("execution_unknown".into());
            data.apply_property_adapter_result(unknown, at(4)).unwrap();
        }
        data.observe(&policy.observation, &token, snapshot(2, true, 12), at(12))
            .unwrap();
        assert_eq!(data.commands[&command.command_id].status, "unknown");
        assert!(data
            .prepare_adapter_dispatch("property-source", at(12))
            .is_empty());
        assert_eq!(
            data.apply_property_adapter_result(receipt(&command), at(12))
                .unwrap_err()
                .code,
            "invalid_transition"
        );
        data.validate_property_bridge_receipts().unwrap();
    }
}

#[test]
fn source_replacement_invalidates_inflight_and_queue_and_does_not_replay_original_key() {
    let (mut data, policy, token) = setup();
    let first = dispatched(&mut data);
    let request = input(&data, "power-on");
    let second = data
        .create_command(input(&data, "second"), at(2), None)
        .unwrap();
    data.apply_property_adapter_result(receipt(&first), at(3))
        .unwrap();
    let replacement = data.begin_observation(&policy.observation, at(4)).unwrap();
    assert_ne!(replacement, token);
    assert_eq!(data.commands[&first.command_id].status, "unknown");
    assert_eq!(data.commands[&second.command_id].status, "rejected");
    assert_eq!(
        data.observe(&policy.observation, &token, snapshot(2, true, 5), at(5))
            .unwrap_err()
            .code,
        "observation_session_mismatch"
    );
    assert_eq!(
        data.end_observation(&policy.observation, &token)
            .unwrap_err()
            .code,
        "observation_session_mismatch"
    );
    data.observe(
        &policy.observation,
        &replacement,
        snapshot(1, true, 5),
        at(5),
    )
    .unwrap();
    assert_eq!(
        data.create_command(request, at(5), None)
            .unwrap()
            .command_id,
        first.command_id
    );
    assert_eq!(data.commands[&first.command_id].status, "unknown");
    assert!(data
        .prepare_adapter_dispatch("property-source", at(5))
        .is_empty());
    data.end_observation(&policy.observation, &replacement)
        .unwrap();
    assert_eq!(
        data.create_command(input(&data, "closed"), at(5), None)
            .unwrap_err()
            .code,
        "device_offline"
    );
}

#[test]
fn recovery_keeps_history_stale_and_new_session_cannot_complete_old_command() {
    let (mut data, policy, _) = setup();
    let command = dispatched(&mut data);
    data.apply_property_adapter_result(receipt(&command), at(3))
        .unwrap();
    let serialized = json!(&data);
    assert!(serialized["devices"]["device-lamp"]
        .get("property_bridge_policy")
        .is_none());
    let restored: Data = serde_json::from_value(serialized).unwrap();
    assert!(restored.validate_execution_routes().is_err());
    restored
        .validate_persisted_property_bridges(std::slice::from_ref(&policy))
        .unwrap();
    let mut restored = restored
        .with_property_bridges(std::slice::from_ref(&policy))
        .unwrap()
        .restore_observation_bindings()
        .unwrap();
    restored.validate_execution_routes().unwrap();
    restored.validate_property_bridge_receipts().unwrap();
    restored.recover();
    assert_eq!(restored.commands[&command.command_id].status, "unknown");
    let view = restored.devices_view(at(4));
    let lamp = view
        .iter()
        .find(|view| view["device_id"] == "device-lamp")
        .unwrap();
    assert_eq!(lamp["ready"], false);
    assert_eq!(lamp["reported"]["light.power"]["quality"], "stale");
    let token = restored
        .begin_observation(&policy.observation, at(4))
        .unwrap();
    restored
        .observe(&policy.observation, &token, snapshot(1, true, 5), at(5))
        .unwrap();
    assert_eq!(restored.commands[&command.command_id].status, "unknown");
    assert!(restored
        .prepare_adapter_dispatch("property-source", at(5))
        .is_empty());
}

#[test]
fn per_property_freshness_is_required_even_when_source_heartbeat_is_recent() {
    let mut config = config();
    config.models[0].services[0].properties[0].max_age_ms = 1000;
    config.devices[0].model_revision = digest(&config.models[0]).unwrap();
    let policy = bridge_policy(&config);
    let mut data = Data::new(config)
        .unwrap()
        .with_property_bridges(std::slice::from_ref(&policy))
        .unwrap();
    let token = data.begin_observation(&policy.observation, at(0)).unwrap();
    data.observe(&policy.observation, &token, snapshot(1, false, 1), at(1))
        .unwrap();
    assert_eq!(
        data.create_command(input(&data, "stale-property"), at(3), None)
            .unwrap_err()
            .code,
        "device_offline"
    );
}

#[test]
fn malformed_observation_cannot_confirm_or_publish_partial_state() {
    let (mut data, policy, token) = setup();
    let command = dispatched(&mut data);
    data.apply_property_adapter_result(receipt(&command), at(3))
        .unwrap();
    let valid = json!(snapshot(2, true, 4));
    let mut cases: Vec<Value> = vec![json!({"sequence":2,"samples":[]})];
    for (field, value) in [
        ("value", json!(1)),
        ("unit", json!("percent")),
        ("observed_at", json!(at(5))),
    ] {
        let mut invalid = valid.clone();
        invalid["samples"][0][field] = value;
        cases.push(invalid);
    }
    let mut repeated = valid;
    repeated["sequence"] = json!(1);
    cases.push(repeated);
    for invalid in cases {
        let mut data = data.clone();
        let before = json!(&data);
        assert!(data
            .observe(
                &policy.observation,
                &token,
                serde_json::from_value(invalid).unwrap(),
                at(4)
            )
            .is_err());
        assert_eq!(json!(&data), before);
    }
}

#[test]
fn duplicate_devices_adapters_and_unapproved_routes_are_rejected() {
    let config = config();
    let policy = bridge_policy(&config);
    assert!(Data::new(config.clone())
        .unwrap()
        .with_property_bridges(&[policy.clone(), policy.clone()])
        .is_err());
    let (mut data, _) = initial();
    data.devices.get_mut("device-lamp").unwrap().routes.clear();
    assert_eq!(
        data.validate_persisted_property_bridges(&[policy])
            .unwrap_err()
            .code,
        "storage_corrupt"
    );
    let mut config = config;
    let mut second = config.devices[0].clone();
    second.device_id = "second-lamp".into();
    config.devices.push(second);
    let first = bridge_policy(&config);
    let mut second = first.clone();
    second.observation.device_id = "second-lamp".into();
    assert!(Data::new(config)
        .unwrap()
        .with_property_bridges(&[first, second])
        .is_err());
}

#[test]
fn a_single_device_can_own_read_only_and_writable_properties_without_splitting_its_model() {
    let mut config = config();
    config.models[0].services[0].properties[1]
        .access
        .retain(|access| access != "write");
    config.devices[0].model_revision = digest(&config.models[0]).unwrap();
    let mut policy = bridge_policy(&config);
    policy.write_paths.remove("light.brightness");
    let mut data = Data::new(config)
        .unwrap()
        .with_property_bridges(std::slice::from_ref(&policy))
        .unwrap();
    let token = data.begin_observation(&policy.observation, at(0)).unwrap();
    data.observe(&policy.observation, &token, snapshot(1, false, 1), at(1))
        .unwrap();
    assert_eq!(data.devices.len(), 2);
    assert_eq!(data.devices["device-lamp"].routes.len(), 1);
    assert_eq!(data.devices["device-lamp"].reported.len(), 2);
    let command = dispatched(&mut data);
    data.apply_property_adapter_result(receipt(&command), at(3))
        .unwrap();
    data.observe(&policy.observation, &token, snapshot(2, true, 4), at(4))
        .unwrap();
    assert_eq!(data.commands[&command.command_id].status, "confirmed");
}

#[test]
fn action_binding_operations_cannot_revoke_or_replace_host_owned_property_routes() {
    use limeiot_core::execution_binding::{Change, Request};
    let (mut data, policy, _) = setup();
    let routes = data.devices["device-lamp"].routes.clone();
    for (key, change) in [
        (
            "revoke",
            Change::Revoke {
                device_id: "device-lamp".into(),
                expected_binding_revision: data.execution_binding("device-lamp").unwrap().revision,
            },
        ),
        (
            "replace",
            Change::Bind {
                device_id: "device-lamp".into(),
                route: policy.observation.source.clone(),
                expected_binding_revision: data.execution_binding("device-lamp").unwrap().revision,
                expected_model_revision: policy.observation.model_revision.clone(),
            },
        ),
    ] {
        let operation = data
            .apply_execution_change(
                Request {
                    space_id: data.space_id.clone(),
                    idempotency_key: key.into(),
                    change,
                },
                None,
                at(2),
            )
            .unwrap();
        assert_eq!(operation.status, "rejected");
        assert_eq!(
            operation.reason.as_deref(),
            Some("property_bridge_binding_locked")
        );
        assert_eq!(data.devices["device-lamp"].routes, routes);
    }
    data.validate_execution_registry().unwrap();
    data.create_command(input(&data, "still-available"), at(2), None)
        .unwrap();
}

#[test]
fn model_binding_cannot_silently_change_property_bridge_authority() {
    use limeiot_core::{
        model_bundles::Catalog,
        model_registry::{Change, Request},
    };
    let (data, policy, _) = setup();
    let catalog = Catalog::new([data.models[&policy.observation.model_revision].clone()]).unwrap();
    let bundle = catalog.list()[0].clone();
    let mut data = data.with_model_bundles(catalog);
    let operation = data
        .apply_model_change(
            Request {
                space_id: data.space_id.clone(),
                idempotency_key: "rebind-model".into(),
                change: Change::BindBundle {
                    device_id: "device-lamp".into(),
                    bundle_id: bundle.bundle_id,
                    expected_model_revision: Some(policy.observation.model_revision.clone()),
                    expected_binding_revision: None,
                },
            },
            at(2),
        )
        .unwrap();
    assert_eq!(operation.status, "rejected");
    assert_eq!(
        operation.reason.as_deref(),
        Some("property_bridge_model_locked")
    );
    assert!(data.model_registry.bindings.is_empty());
    data.create_command(input(&data, "unchanged"), at(2), None)
        .unwrap();
}

#[test]
fn threshold_automation_targets_the_same_property_bridge_and_confirms_by_readback() {
    use limeiot_core::{model::Model, observation::Policy as SourcePolicy, protocol::Rule};
    let mut config = config();
    let model: Model = serde_json::from_str(include_str!(
        "../../../../contracts/models/environment.json"
    ))
    .unwrap();
    let source: SourcePolicy = serde_json::from_value(
        json!({"device_id":"sensor","model_revision":digest(&model).unwrap(),
        "source":{"adapter_id":"sensor-source","revision":format!("sha256:{}", "a".repeat(64))}}),
    )
    .unwrap();
    config.devices.push(
        serde_json::from_value(
            json!({"device_id":"sensor","model_revision":source.model_revision}),
        )
        .unwrap(),
    );
    config.models.push(model);
    let policy = bridge_policy(&config);
    let mut data = Data::new(config)
        .unwrap()
        .with_observation_sources(std::slice::from_ref(&source))
        .unwrap()
        .with_property_bridges(std::slice::from_ref(&policy))
        .unwrap()
        .restore_observation_bindings()
        .unwrap();
    let token = data.begin_observation(&policy.observation, at(0)).unwrap();
    data.observe(&policy.observation, &token, snapshot(1, false, 1), at(1))
        .unwrap();
    let sensor_token = data.begin_observation(&source, at(0)).unwrap();
    let rule: Rule = serde_json::from_value(json!({"version":1,"id":"warm-power","trigger":{"device":"sensor",
        "property":{"path":"environment.temperature","unit":"celsius_x100","edge":"rising","threshold":2800,"hysteresis":100}},
        "conditions":[],"actions":[{"device":"device-lamp","set":{"path":"light.power","value":true}}],"cooldown_ms":0})).unwrap();
    data.deploy(rule).unwrap();
    for (sequence, temperature, second) in [(1, 2700, 1), (2, 2801, 2)] {
        let snapshot: Snapshot = serde_json::from_value(json!({"sequence":sequence,"samples":[
            {"path":"environment.temperature","value":temperature,"unit":"celsius_x100","observed_at":at(second)},
            {"path":"environment.humidity","value":5000,"unit":"percent_x100","observed_at":at(second)}]})).unwrap();
        data.observe(&source, &sensor_token, snapshot, at(second))
            .unwrap();
    }
    assert_eq!(data.runs.len(), 1);
    assert_eq!(data.commands.len(), 1);
    assert!(data.prepare_dispatch(at(2)).is_empty());
    let commands = data.prepare_adapter_dispatch("property-source", at(2));
    assert_eq!(commands.len(), 1);
    let command = &commands[0];
    assert!(command.run_id.is_some());
    data.apply_property_adapter_result(receipt(command), at(3))
        .unwrap();
    assert_eq!(data.commands[&command.command_id].status, "dispatched");
    data.observe(&policy.observation, &token, snapshot(2, true, 4), at(4))
        .unwrap();
    assert_eq!(data.commands[&command.command_id].status, "confirmed");
    assert_eq!(
        data.runs.values().next().unwrap().command_ids,
        vec![command.command_id.clone()]
    );
}

#[test]
fn remote_projection_preserves_existing_receipt_contract_and_hides_local_source_details() {
    use limeiot_core::property_bridge::remote_evidence;
    let (mut data, policy, token) = setup();
    let command = dispatched(&mut data);
    assert_eq!(remote_evidence(&command).unwrap(), None);
    let accepted = data
        .apply_property_adapter_result(receipt(&command), at(3))
        .unwrap();
    assert_eq!(remote_evidence(&accepted).unwrap(), None);
    data.observe(&policy.observation, &token, snapshot(2, true, 4), at(4))
        .unwrap();
    let confirmed = data.commands[&command.command_id].clone();
    assert_eq!(
        remote_evidence(&confirmed).unwrap(),
        Some(json!({"type":"device_result","reported":{"light.power":true}}))
    );
    let raw = serde_json::to_string(&remote_evidence(&confirmed).unwrap()).unwrap();
    assert!(!raw.contains(&token));
    assert!(!raw.contains("property-source"));
    let mut invalid = confirmed.clone();
    invalid.evidence.as_mut().unwrap()["value"] = json!(false);
    assert_eq!(
        remote_evidence(&invalid).unwrap_err().code,
        "invalid_evidence"
    );
    let mut native = confirmed;
    native.execution_route = None;
    native.evidence = Some(json!({"type":"device_result","reported":{"light.power":true}}));
    assert_eq!(remote_evidence(&native).unwrap(), native.evidence);
}
