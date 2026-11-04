use chrono::{DateTime, Duration, Utc};
use limeiot_core::{
    digest,
    engine::{Config, Data},
    model::Model,
    observation::{Policy, Snapshot},
    observation_binding::{parse_change, Change, Offer, Operation, Request},
    protocol::Envelope,
};
use serde_json::{json, Value};

fn at(second: i64) -> DateTime<Utc> {
    "2026-11-04T00:00:00Z".parse::<DateTime<Utc>>().unwrap() + Duration::seconds(second)
}
fn config() -> Config {
    serde_json::from_str(include_str!("../../../../deploy/dev/config.json")).unwrap()
}
fn data() -> Data {
    Data::new(config()).unwrap()
}
fn offer(target: &str) -> Offer {
    let model: Model = serde_json::from_str(include_str!(
        "../../../../contracts/models/environment.json"
    ))
    .unwrap();
    let manifest = json!({"mapping":"fixture-environment-v1","target":target});
    Offer {
        source: serde_json::from_value(
            json!({"adapter_id":format!("source-{target}"),"revision":digest(&manifest).unwrap()}),
        )
        .unwrap(),
        model,
        write_paths: Default::default(),
        manifest,
        observed_at: at(0),
        expires_at: at(60),
    }
}
fn bind(data: &Data, device: &str, key: &str, offer: &Offer) -> Request {
    Request {
        space_id: data.space_id.clone(),
        idempotency_key: key.into(),
        change: Change::Bind {
            device_id: device.into(),
            source: offer.source.clone(),
            expected_binding_revision: data.observation_binding(device).unwrap().revision,
            expected_model_revision: digest(&offer.model).unwrap(),
        },
    }
}
fn revoke(data: &Data, device: &str, key: &str) -> Request {
    Request {
        space_id: data.space_id.clone(),
        idempotency_key: key.into(),
        change: Change::Revoke {
            device_id: device.into(),
            expected_binding_revision: data.observation_binding(device).unwrap().revision,
        },
    }
}
fn attach(data: &mut Data, device: &str, key: &str, offer: &Offer) -> Policy {
    let operation = data
        .apply_observation_change(bind(data, device, key, offer), Some(offer), at(0))
        .unwrap();
    assert_eq!(operation.status, "applied", "{:?}", operation.reason);
    operation.result.unwrap().binding.unwrap().policy
}
fn sample(sequence: u64, second: i64) -> Snapshot {
    serde_json::from_value(json!({"sequence":sequence,"samples":[
        {"path":"environment.temperature","value":2300,"unit":"celsius_x100","observed_at":at(second)},
        {"path":"environment.humidity","value":5000,"unit":"percent_x100","observed_at":at(second)}]})).unwrap()
}
fn switch_offer() -> Offer {
    let mut offer = offer("switch");
    offer.model = serde_json::from_str(include_str!(
        "../../../../contracts/models/on-off-light.json"
    ))
    .unwrap();
    offer.write_paths.insert("light.power".into());
    offer
}
fn switch_sample(sequence: u64, power: bool, second: i64) -> Snapshot {
    serde_json::from_value(json!({"sequence":sequence,"samples":[{"path":"light.power","value":power,"observed_at":at(second)}]})).unwrap()
}
fn switch_command(data: &Data, key: &str) -> limeiot_core::protocol::CommandRequest {
    serde_json::from_value(json!({"space_id":data.space_id,"device_id":"switch","model_revision":data.devices["switch"].model_revision,
        "idempotency_key":key,"expires_at":at(30),"operation":{"type":"property.set","path":"light.power","value":true}})).unwrap()
}

#[test]
fn managed_bridge_requires_host_write_authority_and_fresh_samples_then_closes_inflight_on_revoke() {
    let mut data = data();
    let mut offer = switch_offer();
    offer.write_paths.clear();
    reject(
        data.apply_observation_change(
            bind(&data, "switch", "readonly", &offer),
            Some(&offer),
            at(0),
        )
        .unwrap(),
        "observation_model_unsupported",
    );
    assert!(!data.devices.contains_key("switch"));
    offer.write_paths.insert("light.power".into());
    offer.write_paths.insert("light.extra".into());
    reject(
        data.apply_observation_change(bind(&data, "switch", "extra", &offer), Some(&offer), at(0))
            .unwrap(),
        "property_bridge_model_unsupported",
    );
    offer.write_paths.remove("light.extra");
    let policy = attach(&mut data, "switch", "create", &offer);
    let input = switch_command(&data, "dispatched");
    assert_eq!(
        data.create_command(input.clone(), at(0), None)
            .unwrap_err()
            .code,
        "device_offline"
    );
    let token = data.begin_observation(&policy, at(0)).unwrap();
    assert_eq!(
        data.create_command(input.clone(), at(0), None)
            .unwrap_err()
            .code,
        "device_offline"
    );
    data.observe(&policy, &token, switch_sample(1, false, 1), at(1))
        .unwrap();
    let command = data.create_command(input.clone(), at(2), None).unwrap();
    assert_eq!(
        data.prepare_adapter_dispatch(&policy.source.adapter_id, at(2))
            .len(),
        1
    );
    let queued = data
        .create_command(switch_command(&data, "queued"), at(2), None)
        .unwrap();
    data.apply_observation_change(revoke(&data, "switch", "revoke"), None, at(3))
        .unwrap();
    assert!(data.devices["switch"].routes.is_empty());
    assert!(!data.devices["switch"].ready);
    assert_eq!(data.commands[&command.command_id].status, "unknown");
    assert_eq!(data.commands[&queued.command_id].status, "rejected");
    assert!(data.begin_observation(&policy, at(3)).is_err());
    assert!(data.ingest(hello(&policy), at(3)).is_err());
    let mut replacement = switch_offer();
    replacement.manifest["target"] = json!("replacement");
    replacement.source.adapter_id = "replacement".into();
    replacement.source.revision = digest(&replacement.manifest).unwrap();
    let next = bind(&data, "switch", "rebind", &replacement);
    assert_eq!(
        data.apply_observation_change(next, Some(&replacement), at(4))
            .unwrap()
            .status,
        "applied"
    );
    assert!(data.devices["switch"].reported.is_empty());
    let policy = data.observation_registry.bindings["switch"].policy.clone();
    let next_token = data.begin_observation(&policy, at(4)).unwrap();
    assert!(data
        .observe(&policy, &token, switch_sample(2, true, 5), at(5))
        .is_err());
    data.observe(&policy, &next_token, switch_sample(1, true, 5), at(5))
        .unwrap();
    assert_eq!(
        data.create_command(input, at(6), None).unwrap().status,
        "unknown"
    );
    assert!(data
        .prepare_adapter_dispatch(&policy.source.adapter_id, at(6))
        .is_empty());
    data.validate_observation_registry().unwrap();
    data.validate_property_bridge_receipts().unwrap();
    let restored = serde_json::from_value::<Data>(saved(&data))
        .unwrap()
        .restore_observation_bindings()
        .unwrap();
    assert!(!restored.devices["switch"].ready);
    assert!(restored.has_property_bridges());
    restored.validate_execution_routes().unwrap();
    let mut altered = saved(&data);
    altered["devices"]["switch"]["routes"] = json!({});
    assert!(serde_json::from_value::<Data>(altered)
        .unwrap()
        .restore_observation_bindings()
        .is_err());
}
fn hello(policy: &Policy) -> Envelope {
    serde_json::from_value(json!({"v":1,"kind":"hello","message_id":"native-takeover",
        "device_id":policy.device_id,"model_revision":policy.model_revision,"boot_id":"native","seq":1,
        "body":{"challenge":"native"}})).unwrap()
}
fn saved(value: &impl serde::Serialize) -> Value {
    serde_json::to_value(value).unwrap()
}
fn reject(operation: Operation, reason: &str) {
    assert_eq!(operation.status, "rejected");
    assert_eq!(operation.reason.as_deref(), Some(reason));
    assert!(operation.result.is_none());
}

#[test]
fn binding_creates_a_read_only_device_but_only_a_fresh_sample_makes_it_ready() {
    let mut data = data();
    let offer = offer("alpha");
    let policy = attach(&mut data, "sensor", "create", &offer);
    assert!(!data.devices["sensor"].ready);
    assert!(data.devices["sensor"].reported.is_empty());
    assert_eq!(
        data.ingest(hello(&policy), at(0)).unwrap_err().code,
        "observation_source_mismatch"
    );
    assert_eq!(
        data.observe(&policy, "unstarted", sample(1, 1), at(1))
            .unwrap_err()
            .code,
        "observation_session_closed"
    );
    let token = data.begin_observation(&policy, at(0)).unwrap();
    data.observe(&policy, &token, sample(1, 1), at(1)).unwrap();
    assert!(data.devices["sensor"].ready);
    assert!(data.devices["sensor"].session_id.is_none());
    assert!(data.commands.is_empty());
    data.validate_observation_registry().unwrap();
}

#[test]
fn original_decisions_survive_offer_expiry_and_cannot_be_replaced_by_new_arguments() {
    let mut data = data();
    let offer = offer("alpha");
    let request = bind(&data, "sensor", "create", &offer);
    let original = data
        .apply_observation_change(request.clone(), Some(&offer), at(0))
        .unwrap();
    let before = saved(&data);
    assert_eq!(
        saved(
            &data
                .apply_observation_change(request.clone(), None, at(100))
                .unwrap()
        ),
        saved(&original)
    );
    assert_eq!(saved(&data), before);
    let mut changed = request;
    changed.change = revoke(&data, "sensor", "unused").change;
    assert_eq!(
        data.apply_observation_change(changed, None, at(100))
            .unwrap_err()
            .code,
        "idempotency_conflict"
    );
    assert_eq!(saved(&data), before);
    let missing = bind(&data, "second", "unavailable", &offer);
    reject(
        data.apply_observation_change(missing.clone(), None, at(0))
            .unwrap(),
        "observation_offer_unavailable",
    );
    reject(
        data.apply_observation_change(missing, Some(&offer), at(0))
            .unwrap(),
        "observation_offer_unavailable",
    );
    data.validate_observation_registry().unwrap();
}

#[test]
fn stale_revisions_are_durable_conflicts_without_changing_the_binding() {
    let mut data = data();
    let offer = offer("alpha");
    let request = bind(&data, "sensor", "stale", &offer);
    attach(&mut data, "sensor", "create", &offer);
    let before = saved(&data.observation_binding("sensor").unwrap());
    let conflict = data
        .apply_observation_change(request.clone(), Some(&offer), at(1))
        .unwrap();
    assert_eq!(conflict.status, "conflict");
    assert_eq!(conflict.reason.as_deref(), Some("revision_conflict"));
    assert_eq!(
        saved(
            &data
                .apply_observation_change(request, None, at(100))
                .unwrap()
        ),
        saved(&conflict)
    );
    assert_eq!(saved(&data.observation_binding("sensor").unwrap()), before);
    data.validate_observation_registry().unwrap();
}

#[test]
fn expired_future_mismatched_and_invalid_offers_do_not_create_devices_or_models() {
    for mode in [
        "expired",
        "future",
        "long-lived",
        "source",
        "manifest",
        "model",
        "writable",
    ] {
        let mut data = data();
        let mut offer = offer("alpha");
        if mode == "writable" {
            offer.model.services[0].properties[0]
                .access
                .push("write".into());
        }
        let request = bind(&data, "sensor", "create", &offer);
        let reason = match mode {
            "expired" => {
                offer.expires_at = at(0);
                "observation_offer_expired"
            }
            "future" => {
                offer.observed_at = at(1);
                "observation_offer_expired"
            }
            "long-lived" => {
                offer.expires_at = at(61);
                "observation_offer_expired"
            }
            "source" => {
                offer.source.adapter_id = "other-source".into();
                "observation_offer_mismatch"
            }
            "manifest" => {
                offer.manifest["target"] = json!("other");
                "invalid_observation_manifest"
            }
            "model" => {
                offer.model.model_version = "1.0.1".into();
                "observation_offer_mismatch"
            }
            "writable" => "observation_model_unsupported",
            _ => unreachable!(),
        };
        let models = saved(&data.models);
        reject(
            data.apply_observation_change(request, Some(&offer), at(0))
                .unwrap(),
            reason,
        );
        assert!(!data.devices.contains_key("sensor"), "{mode}");
        assert_eq!(saved(&data.models), models, "{mode}");
        data.validate_observation_registry().unwrap();
    }
}

#[test]
fn native_and_static_devices_cannot_be_taken_over_and_active_sources_are_exclusive() {
    let mut data = data();
    let offer = offer("alpha");
    let request = bind(&data, "device-lamp", "native", &offer);
    reject(
        data.apply_observation_change(request, Some(&offer), at(0))
            .unwrap(),
        "observation_device_in_use",
    );
    let policy = attach(&mut data, "sensor", "create", &offer);
    let request = bind(&data, "second", "duplicate", &offer);
    reject(
        data.apply_observation_change(request, Some(&offer), at(0))
            .unwrap(),
        "observation_source_in_use",
    );
    data.apply_observation_change(revoke(&data, "sensor", "revoke"), None, at(1))
        .unwrap();
    attach(&mut data, "second", "reuse-revoked", &offer);
    let request = bind(&data, "sensor", "reclaim", &offer);
    reject(
        data.apply_observation_change(request, Some(&offer), at(0))
            .unwrap(),
        "observation_source_in_use",
    );
    assert_eq!(
        data.begin_observation(&policy, at(2)).unwrap_err().code,
        "observation_source_revoked"
    );
    data.validate_observation_registry().unwrap();
    let mut restored: Data = serde_json::from_value(saved(&data)).unwrap();
    restored = restored.restore_observation_bindings().unwrap();
    assert_eq!(
        restored.ingest(hello(&policy), at(2)).unwrap_err().code,
        "observation_source_mismatch"
    );

    let mut config = config();
    config.models.push(offer.model.clone());
    config.devices.push(
        serde_json::from_value(
            json!({"device_id":"static","model_revision":policy.model_revision}),
        )
        .unwrap(),
    );
    let mut static_policy = policy;
    static_policy.device_id = "static".into();
    let mut data = Data::new(config)
        .unwrap()
        .with_observation_sources(&[static_policy])
        .unwrap();
    for (device, key, reason) in [
        ("static", "static-device", "observation_device_in_use"),
        ("new", "static-source", "observation_source_in_use"),
    ] {
        let request = bind(&data, device, key, &offer);
        reject(
            data.apply_observation_change(request, Some(&offer), at(0))
                .unwrap(),
            reason,
        );
    }
}

#[test]
fn execution_bind_and_compose_cannot_claim_active_observation_sources() {
    use limeiot_core::{execution::Route, execution_binding as execution};

    for static_source in [false, true] {
        for compose in [false, true] {
            let observation_offer = offer("alpha");
            let tv_model: Model = serde_json::from_str(include_str!(
                "../../../../contracts/models/android-tv-remote.json"
            ))
            .unwrap();
            let mut initial_config = config();
            let tv_revision = digest(&tv_model).unwrap();
            initial_config.models.push(tv_model);
            initial_config.devices.push(
                serde_json::from_value(json!({"device_id":"tv","model_revision":tv_revision}))
                    .unwrap(),
            );
            let mut data = Data::new(initial_config.clone()).unwrap();
            let policy = attach(&mut data, "sensor", "observation-bind", &observation_offer);
            if static_source {
                initial_config.models.push(observation_offer.model.clone());
                initial_config.devices.push(
                    serde_json::from_value(
                        json!({"device_id":"sensor","model_revision":policy.model_revision}),
                    )
                    .unwrap(),
                );
                data = Data::new(initial_config)
                    .unwrap()
                    .with_observation_sources(&[policy])
                    .unwrap();
            }
            if compose {
                for (kind, body, seq) in [
                    (
                        "hello",
                        json!({"challenge":"native","execution_paths":["apps.launch"]}),
                        1,
                    ),
                    (
                        "state",
                        json!({"type":"snapshot","revision":1,"properties":[]}),
                        2,
                    ),
                ] {
                    let envelope = serde_json::from_value(json!({"v":1,"kind":kind,
                        "message_id":format!("tv-{seq}"),"device_id":"tv","model_revision":tv_revision,
                        "boot_id":"native","session_id":data.devices["tv"].session_id,
                        "seq":seq,"body":body})).unwrap();
                    data.ingest(envelope, at(0)).unwrap();
                }
            }
            let route = Route {
                adapter_id: observation_offer.source.adapter_id.clone(),
                revision: format!("sha256:{}", "a".repeat(64)),
            };
            let execution_offer = execution::Offer {
                device_id: "tv".into(),
                route: route.clone(),
                model_revision: tv_revision.clone(),
                paths: ["remote.press".into(), "apps.launch".into()].into(),
            };
            let expected_binding_revision = data.execution_binding("tv").unwrap().revision;
            let change = if compose {
                execution::Change::Compose {
                    device_id: "tv".into(),
                    route,
                    native_paths: ["apps.launch".into()].into(),
                    expected_native_session: data.devices["tv"].session_id.clone().unwrap(),
                    expected_binding_revision,
                    expected_model_revision: tv_revision,
                }
            } else {
                execution::Change::Bind {
                    device_id: "tv".into(),
                    route,
                    expected_binding_revision,
                    expected_model_revision: tv_revision,
                }
            };
            let mut request = execution::Request {
                space_id: data.space_id.clone(),
                idempotency_key: "execution-conflict".into(),
                change,
            };
            let rejected = data
                .apply_execution_change(request.clone(), Some(&execution_offer), at(1))
                .unwrap();
            assert_eq!(rejected.status, "rejected");
            assert_eq!(rejected.reason.as_deref(), Some("execution_adapter_in_use"));
            assert!(data.devices["tv"].routes.is_empty());
            data.validate_execution_registry().unwrap();
            if static_source {
                continue;
            }
            data.apply_observation_change(revoke(&data, "sensor", "release-source"), None, at(2))
                .unwrap();
            assert_eq!(
                saved(
                    &data
                        .apply_execution_change(request.clone(), Some(&execution_offer), at(3))
                        .unwrap()
                ),
                saved(&rejected),
            );
            request.idempotency_key = "execution-after-revoke".into();
            assert_eq!(
                data.apply_execution_change(request, Some(&execution_offer), at(3))
                    .unwrap()
                    .status,
                "applied",
            );
            let restored: Data = serde_json::from_value(saved(&data)).unwrap();
            let restored = restored.restore_observation_bindings().unwrap();
            restored.validate_execution_registry().unwrap();
            assert!(!restored.devices["tv"].routes.is_empty());
        }
    }
}

#[test]
fn revoke_and_explicit_rebind_invalidate_previous_tokens_without_reactivating_native_mqtt() {
    let mut data = data();
    let offer = offer("alpha");
    let policy = attach(&mut data, "sensor", "create", &offer);
    let token = data.begin_observation(&policy, at(0)).unwrap();
    data.observe(&policy, &token, sample(1, 1), at(1)).unwrap();
    let first_generation = data
        .observation_binding("sensor")
        .unwrap()
        .binding
        .unwrap()
        .generation;
    data.apply_observation_change(revoke(&data, "sensor", "revoke"), None, at(2))
        .unwrap();
    assert!(!data.devices["sensor"].ready);
    assert_eq!(
        data.observe(&policy, &token, sample(2, 3), at(3))
            .unwrap_err()
            .code,
        "observation_source_revoked"
    );
    assert_eq!(
        data.ingest(hello(&policy), at(3)).unwrap_err().code,
        "observation_source_mismatch"
    );
    attach(&mut data, "sensor", "rebind", &offer);
    assert!(data.devices["sensor"].reported.is_empty());
    assert_ne!(
        data.observation_binding("sensor")
            .unwrap()
            .binding
            .unwrap()
            .generation,
        first_generation
    );
    let current = data.begin_observation(&policy, at(3)).unwrap();
    assert_eq!(
        data.end_observation(&policy, &token).unwrap_err().code,
        "observation_session_mismatch"
    );
    data.observe(&policy, &current, sample(1, 4), at(4))
        .unwrap();
    data.validate_observation_registry().unwrap();
}

#[test]
fn a_managed_device_keeps_its_exact_model_even_after_revocation() {
    use limeiot_core::{model_bundles::Catalog, model_registry};
    let mut data = data();
    let offer = offer("alpha");
    let policy = attach(&mut data, "sensor", "create", &offer);
    let mut later = self::offer("beta");
    later.model.model_version = "1.0.1".into();
    let request = bind(&data, "sensor", "model-change", &later);
    reject(
        data.apply_observation_change(request, Some(&later), at(0))
            .unwrap(),
        "observation_model_locked",
    );
    data.apply_observation_change(revoke(&data, "sensor", "revoke"), None, at(1))
        .unwrap();
    let catalog = Catalog::new([later.model]).unwrap();
    let bundle_id = catalog.list()[0].bundle_id.clone();
    data = data.with_model_bundles(catalog);
    let result = data
        .apply_model_change(
            model_registry::Request {
                space_id: data.space_id.clone(),
                idempotency_key: "model-api".into(),
                change: model_registry::Change::BindBundle {
                    device_id: "sensor".into(),
                    bundle_id,
                    expected_model_revision: Some(policy.model_revision.clone()),
                    expected_binding_revision: None,
                },
            },
            at(2),
        )
        .unwrap();
    assert_eq!(result.status, "rejected");
    assert_eq!(result.reason.as_deref(), Some("observation_model_locked"));
    assert_eq!(data.devices["sensor"].model_revision, policy.model_revision);
}

#[test]
fn tombstones_count_toward_capacity_and_do_not_disappear_to_make_room() {
    let mut data = data();
    for index in 0..16 {
        attach(
            &mut data,
            &format!("sensor-{index}"),
            &format!("bind-{index}"),
            &offer(&format!("target-{index}")),
        );
    }
    data.apply_observation_change(revoke(&data, "sensor-0", "revoke"), None, at(1))
        .unwrap();
    let offer = offer("overflow");
    let request = bind(&data, "overflow", "overflow", &offer);
    reject(
        data.apply_observation_change(request, Some(&offer), at(0))
            .unwrap(),
        "capacity_exceeded",
    );
    assert_eq!(data.observation_registry.bindings.len(), 16);
    assert!(!data.observation_registry.bindings["sensor-0"].active);
    data.validate_observation_registry().unwrap();
}

#[test]
fn decision_chain_rejects_missing_reordered_and_altered_records() {
    let mut data = data();
    let offer = offer("alpha");
    attach(&mut data, "sensor", "create", &offer);
    data.apply_observation_change(revoke(&data, "sensor", "revoke"), None, at(1))
        .unwrap();
    attach(&mut data, "sensor", "rebind", &offer);
    let original = saved(&data);
    let operation = |value: &mut Value, key: &str, field: &str, change: Value| {
        value["observation_registry"]["operations"][key][field] = change;
    };
    for mode in [
        "missing",
        "sequence",
        "digest",
        "generation",
        "view-device",
        "binding-device",
        "time",
        "active",
        "native-session",
        "status",
    ] {
        let mut value = original.clone();
        match mode {
            "missing" => {
                value["observation_registry"]["operations"]
                    .as_object_mut()
                    .unwrap()
                    .remove("revoke");
            }
            "sequence" => operation(&mut value, "rebind", "sequence", json!(2)),
            "digest" => operation(
                &mut value,
                "create",
                "request_digest",
                json!(format!("sha256:{}", "0".repeat(64))),
            ),
            "generation" => {
                value["observation_registry"]["bindings"]["sensor"]["generation"] = json!("old")
            }
            "view-device" => {
                value["observation_registry"]["operations"]["create"]["result"]["device_id"] =
                    json!("other")
            }
            "binding-device" => {
                value["observation_registry"]["bindings"]["sensor"]["policy"]["device_id"] =
                    json!("other")
            }
            "time" => operation(&mut value, "create", "created_at", json!(at(5))),
            "active" => {
                value["observation_registry"]["bindings"]["sensor"]["active"] = json!(false)
            }
            "native-session" => value["devices"]["sensor"]["session_id"] = json!("native"),
            "status" => operation(&mut value, "create", "status", json!("rejected")),
            _ => unreachable!(),
        }
        let restored: Data = serde_json::from_value(value).unwrap();
        assert!(restored.restore_observation_bindings().is_err(), "{mode}");
    }
    let restored: Data = serde_json::from_value(original).unwrap();
    restored.restore_observation_bindings().unwrap();
}

#[test]
fn restoration_rechecks_static_source_and_execution_route_ownership() {
    let mut data = data();
    let offer = offer("alpha");
    let policy = attach(&mut data, "sensor", "create", &offer);
    let original = saved(&data);
    let mut value = original.clone();
    value["devices"]["device-lamp"]["routes"] = json!({"light.set_power":offer.source});
    let restored: Data = serde_json::from_value(value).unwrap();
    assert_eq!(
        restored.restore_observation_bindings().unwrap_err().code,
        "observation_source_conflict"
    );
    let mut restored: Data = serde_json::from_value(original).unwrap();
    let mut device = restored.devices["sensor"].clone();
    device.device_id = "static".into();
    restored.devices.insert("static".into(), device);
    let mut static_policy = policy;
    static_policy.device_id = "static".into();
    let restored = restored.with_observation_sources(&[static_policy]).unwrap();
    assert_eq!(
        restored.restore_observation_bindings().unwrap_err().code,
        "observation_source_conflict"
    );
}

#[test]
fn change_parser_rejects_client_manifests_extra_fields_and_oversized_input() {
    let data = data();
    let offer = offer("alpha");
    let change = saved(&bind(&data, "sensor", "create", &offer).change);
    parse_change(&serde_json::to_vec(&change).unwrap()).unwrap();
    for (field, value) in [
        ("manifest", offer.manifest),
        ("serial", json!("/dev/ttyUSB0")),
        ("device_id", json!("../sensor")),
        ("expected_model_revision", json!("latest")),
    ] {
        let mut invalid = change.clone();
        invalid[field] = value;
        assert!(
            parse_change(&serde_json::to_vec(&invalid).unwrap()).is_err(),
            "{field}"
        );
    }
    assert!(parse_change(&vec![b' '; 4097]).is_err());
    assert!(
        parse_change(br#"{"type":"sources.revoke","device_id":"sensor","device_id":"other"}"#)
            .is_err()
    );
}

#[test]
fn operation_capacity_rejects_further_changes_without_forgetting_original_decisions() {
    let mut data = data();
    let offer = offer("alpha");
    let first = bind(&data, "sensor", "missing-0", &offer);
    for index in 0..256 {
        let request = bind(&data, "sensor", &format!("missing-{index}"), &offer);
        reject(
            data.apply_observation_change(request, None, at(0)).unwrap(),
            "observation_offer_unavailable",
        );
    }
    let before = saved(&data);
    let overflow = bind(&data, "sensor", "overflow", &offer);
    assert_eq!(
        data.apply_observation_change(overflow, Some(&offer), at(0))
            .unwrap_err()
            .code,
        "observation_operation_capacity"
    );
    reject(
        data.apply_observation_change(first, Some(&offer), at(0))
            .unwrap(),
        "observation_offer_unavailable",
    );
    assert_eq!(saved(&data), before);
    data.validate_observation_registry().unwrap();
}

#[test]
fn rebinding_does_not_replay_an_edge_armed_by_the_previous_source_session() {
    use limeiot_core::protocol::Rule;
    let mut data = data();
    let offer = offer("alpha");
    let policy = attach(&mut data, "sensor", "create", &offer);
    let rule: Rule = serde_json::from_value(json!({"version":1,"id":"temperature-edge",
        "trigger":{"device":"sensor","property":{"path":"environment.temperature","unit":"celsius_x100",
        "edge":"rising","threshold":2800,"hysteresis":100}},"conditions":[],
        "actions":[{"device":"device-lamp","set":{"path":"light.brightness","value":30}}],"cooldown_ms":0})).unwrap();
    data.deploy(rule).unwrap();
    let token = data.begin_observation(&policy, at(0)).unwrap();
    data.observe(&policy, &token, sample(1, 1), at(1)).unwrap();
    attach(&mut data, "sensor", "rebind", &offer);
    let token = data.begin_observation(&policy, at(2)).unwrap();
    let mut hot = sample(1, 3);
    hot.samples[0].value = json!(2900);
    data.observe(&policy, &token, hot, at(3)).unwrap();
    assert!(data.runs.is_empty());
    assert!(data.commands.is_empty());
    data.observe(&policy, &token, sample(2, 4), at(4)).unwrap();
    let mut hot = sample(3, 5);
    hot.samples[0].value = json!(2900);
    data.observe(&policy, &token, hot, at(5)).unwrap();
    assert_eq!(data.runs.len(), 1);
    // 灯尚未建立在线会话，真实边沿被记录，但不能越过原执行权限产生命令。
    assert!(data.commands.is_empty());
}
