use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::{DateTime, Duration, Utc};
use limeiot_core::{
    digest,
    engine::{Command, Config, Data},
    execution::{AdapterReceipt, Route},
    model::Model,
    protocol::{CommandRequest, Envelope},
};
use ring::signature::Ed25519KeyPair;
use serde_json::json;
use serde_json::Value;

fn now() -> DateTime<Utc> {
    "2026-11-02T00:00:00Z".parse().unwrap()
}
fn route() -> Route {
    Route {
        adapter_id: "tv-adb".into(),
        revision: format!("sha256:{}", "a".repeat(64)),
    }
}
fn initial() -> Data {
    let model: Model = serde_json::from_slice(include_bytes!(
        "../../../../contracts/models/android-tv-remote.json"
    ))
    .unwrap();
    model.validate().unwrap();
    let config: Config = serde_json::from_value(json!({"space_id":"home","models":[model],
        "devices":[{"device_id":"tv","model_revision":digest(&model).unwrap(),
        "routes":{"remote.press":route(),"apps.launch":route()}}]}))
    .unwrap();
    Data::new(config).unwrap()
}
fn ready() -> Data {
    let mut data = initial();
    data.adapter_seen("tv", &route(), "adapter-session", now())
        .unwrap();
    data
}
fn input(data: &Data, key: &str) -> CommandRequest {
    serde_json::from_value(json!({"space_id":"home","device_id":"tv","model_revision":data.devices["tv"].model_revision,
        "idempotency_key":key,"expires_at":now()+Duration::seconds(5),
        "operation":{"type":"action.invoke","path":"remote.press","value":{"key":"home"}}})).unwrap()
}
fn receipt(command: &Command, status: &str) -> AdapterReceipt {
    AdapterReceipt {
        command_id: command.command_id.clone(),
        route: route(),
        session_id: "adapter-session".into(),
        request_digest: command.request_digest.clone(),
        status: status.into(),
        error: if status == "unknown" {
            Some("execution_unknown".into())
        } else {
            None
        },
        observed_at: now(),
    }
}

#[test]
fn external_binding_is_ready_without_a_native_mqtt_identity_or_fake_properties() {
    let mut data = ready();
    assert!(data.devices["tv"].boot_id.is_none());
    assert!(data.devices["tv"].session_id.is_none());
    assert!(data.devices["tv"].reported.is_empty());
    assert_eq!(data.devices_view(now())[0]["ready"], true);
    let command = data
        .create_command(input(&data, "home"), now(), None)
        .unwrap();
    assert_eq!(command.execution_route, Some(route()));
    assert!(data.prepare_dispatch(now()).is_empty());
    assert_eq!(data.prepare_adapter_dispatch("tv-adb", now()).len(), 1);
    assert!(data.prepare_adapter_dispatch("tv-adb", now()).is_empty());
    let completed = data
        .apply_adapter_result(receipt(&command, "confirmed"), now())
        .unwrap();
    assert_eq!(completed.status, "confirmed");
    assert_eq!(completed.evidence.unwrap()["completion"], "submitted");
    assert!(data.devices["tv"].reported.is_empty());
}

#[test]
fn native_empty_property_snapshot_and_action_remain_supported() {
    let mut data = initial();
    data.devices.get_mut("tv").unwrap().routes.clear();
    let revision = data.devices["tv"].model_revision.clone();
    let mut message: Envelope = serde_json::from_value(json!({"v":1,"kind":"hello","message_id":"hello",
        "device_id":"tv","model_revision":revision,"boot_id":"native-boot","seq":1,"body":{"challenge":"challenge"}})).unwrap();
    data.ingest(message.clone(), now()).unwrap();
    message.kind = "state".into();
    message.seq = Some(2);
    message.message_id = "snapshot".into();
    message.session_id = data.devices["tv"].session_id.clone();
    message.body = json!({"type":"snapshot","revision":1,"properties":[]});
    data.ingest(message, now()).unwrap();
    assert!(data.devices["tv"].reported.is_empty());
    let command = data
        .create_command(input(&data, "native"), now(), None)
        .unwrap();
    assert!(command.execution_route.is_none());
    assert_eq!(data.prepare_dispatch(now()).len(), 1);
    assert!(data.prepare_adapter_dispatch("tv-adb", now()).is_empty());
}

#[test]
fn mqtt_disconnect_does_not_invalidate_external_route_and_results_bind_original_attempt() {
    let mut data = ready();
    let command = data
        .create_command(input(&data, "one"), now(), None)
        .unwrap();
    data.mqtt_disconnected();
    assert_eq!(data.commands[&command.command_id].status, "accepted");
    let dispatched = data.prepare_adapter_dispatch("tv-adb", now());
    data.recheck_adapter_dispatch(&dispatched[0], now())
        .unwrap();
    for bad in [
        {
            let mut r = receipt(&command, "confirmed");
            r.session_id = "other-session".into();
            r
        },
        {
            let mut r = receipt(&command, "confirmed");
            r.route.revision = format!("sha256:{}", "b".repeat(64));
            r
        },
        {
            let mut r = receipt(&command, "confirmed");
            r.request_digest = format!("sha256:{}", "b".repeat(64));
            r
        },
    ] {
        assert_eq!(
            data.apply_adapter_result(bad, now()).unwrap_err().code,
            "execution_source_mismatch"
        );
    }
    data.adapter_disconnected("tv-adb");
    assert_eq!(data.commands[&command.command_id].status, "unknown");
    // 迟到证据只能完成旧操作，不恢复新会话或改变路由。
    assert_eq!(
        data.apply_adapter_result(receipt(&command, "confirmed"), now())
            .unwrap()
            .status,
        "confirmed"
    );
    assert!(data.devices["tv"].adapter_sessions.is_empty());
}

#[test]
fn restart_stale_session_and_route_change_do_not_replay_or_switch_transport() {
    let mut data = ready();
    let request = input(&data, "unknown");
    let command = data.create_command(request.clone(), now(), None).unwrap();
    data.prepare_adapter_dispatch("tv-adb", now());
    let bytes = serde_json::to_vec(&data).unwrap();
    assert!(!String::from_utf8(bytes.clone())
        .unwrap()
        .contains("adapter_sessions"));
    let mut recovered: Data = serde_json::from_slice(&bytes).unwrap();
    recovered.recover();
    assert_eq!(recovered.commands[&command.command_id].status, "unknown");
    recovered
        .adapter_seen("tv", &route(), "new-session", now())
        .unwrap();
    assert!(recovered.prepare_dispatch(now()).is_empty());
    assert!(recovered
        .prepare_adapter_dispatch("tv-adb", now())
        .is_empty());
    assert_eq!(
        recovered
            .create_command(request, now(), None)
            .unwrap()
            .command_id,
        command.command_id
    );
    let mut queued = ready();
    let request = input(&queued, "changed");
    let command = queued.create_command(request, now(), None).unwrap();
    queued.devices.get_mut("tv").unwrap().routes.clear();
    assert!(queued.prepare_dispatch(now()).is_empty());
    assert!(queued.prepare_adapter_dispatch("tv-adb", now()).is_empty());
    assert_eq!(queued.commands[&command.command_id].status, "rejected");
}

#[test]
fn disconnected_expired_and_changed_bindings_fail_current_authorization() {
    let mut data = ready();
    let command = data
        .create_command(input(&data, "guard"), now(), None)
        .unwrap();
    let dispatched = data.prepare_adapter_dispatch("tv-adb", now()).remove(0);
    assert!(data
        .recheck_adapter_dispatch(&dispatched, now() + Duration::seconds(6))
        .is_err());
    data.adapter_disconnected("tv-adb");
    assert!(data.recheck_adapter_dispatch(&dispatched, now()).is_err());
    assert_eq!(data.commands[&command.command_id].status, "unknown");
    assert_eq!(
        data.create_command(input(&data, "offline"), now(), None)
            .unwrap_err()
            .code,
        "device_offline"
    );
}

#[test]
fn model_rebinding_cannot_add_unimplemented_properties_to_a_static_adapter() {
    use limeiot_core::model_registry::{Change, Request};
    let mut data = ready();
    let fixture: serde_json::Value = serde_json::from_slice(include_bytes!(
        "../../../../contracts/examples/model-release.json"
    ))
    .unwrap();
    let trusted = data
        .apply_model_change(
            Request {
                space_id: "home".into(),
                idempotency_key: "trust".into(),
                change: Change::TrustAdd {
                    trust: fixture["trust"].clone(),
                    expected_signing_key_id: fixture["trust"]["signing_key_id"]
                        .as_str()
                        .unwrap()
                        .into(),
                },
            },
            now(),
        )
        .unwrap();
    let limeiot_core::model_registry::Resource::Trust(trust) = trusted.result.unwrap() else {
        panic!("trust")
    };
    let installed = data
        .apply_model_change(
            Request {
                space_id: "home".into(),
                idempotency_key: "install".into(),
                change: Change::Install {
                    trust_id: trust.trust_id,
                    artifact: fixture["artifact"].clone(),
                    expected_release_id: None,
                },
            },
            now(),
        )
        .unwrap();
    let limeiot_core::model_registry::Resource::Installation(installation) =
        installed.result.unwrap()
    else {
        panic!("installation")
    };
    let revision = data.devices["tv"].model_revision.clone();
    let result = data
        .apply_model_change(
            Request {
                space_id: "home".into(),
                idempotency_key: "bind-incompatible".into(),
                change: Change::Bind {
                    device_id: "tv".into(),
                    installation_id: installation.installation_id,
                    expected_model_revision: Some(revision.clone()),
                    expected_binding_revision: None,
                },
            },
            now(),
        )
        .unwrap();
    assert_eq!(result.status, "rejected");
    assert_eq!(result.reason.as_deref(), Some("bound_routes_incompatible"));
    assert_eq!(data.devices["tv"].model_revision, revision);
    assert!(data.devices["tv"].reported.is_empty());
    assert!(data.devices["tv"].adapter_ready(&route(), now()));
}

fn incompatible_execution_models() -> Vec<Model> {
    let base = initial().models.values().next().unwrap().clone();
    let mut models = Vec::new();
    for output in [
        json!({"type":"string","maxLength":64}),
        json!({"type":"object","properties":{"status":{"type":"boolean"}},"required":["status"],"additionalProperties":false}),
        json!({"type":"object","properties":{"status":{"type":"boolean"}},"additionalProperties":false}),
        json!({"type":"object"}),
    ] {
        let mut model = base.clone();
        model.services[0].actions[0].output = serde_json::from_value(output).unwrap();
        models.push(model);
    }
    let mut observed = base;
    observed.services[0].actions[0].completion = "observed".into();
    models.push(observed);
    for model in &models {
        model.validate().unwrap();
    }
    models
}

#[test]
fn unsupported_execution_outputs_are_rejected_on_initial_binding_and_recovery() {
    for model in incompatible_execution_models() {
        let revision = digest(&model).unwrap();
        let config: Config = serde_json::from_value(json!({"space_id":"home","models":[model],
            "devices":[{"device_id":"tv","model_revision":revision,
            "routes":{"remote.press":route(),"apps.launch":route()}}]}))
        .unwrap();
        assert!(
            matches!(Data::new(config),Err(error) if error.code=="unsupported_execution_route")
        );

        // 模拟旧程序已保存的同路径模型；恢复不能信任已有路由字段。
        let mut data = initial();
        data.models.insert(revision.clone(), model);
        data.devices.get_mut("tv").unwrap().model_revision = revision;
        let recovered: Data = serde_json::from_slice(&serde_json::to_vec(&data).unwrap()).unwrap();
        assert_eq!(
            recovered.validate_execution_routes().unwrap_err().code,
            "unsupported_execution_route"
        );
    }
}

fn install_execution_model(data: &mut Data, mut model: Model) -> String {
    use limeiot_core::{
        model_registry::{Change, Request, Resource},
        release,
    };
    let fixture: Value = serde_json::from_slice(include_bytes!(
        "../../../../contracts/examples/model-release.json"
    ))
    .unwrap();
    model.model_id = fixture["artifact"]["statement"]["model"]["model_id"]
        .as_str()
        .unwrap()
        .into();
    let mut artifact = fixture["artifact"].clone();
    artifact["statement"]["model"] = serde_json::to_value(model).unwrap();
    artifact["statement"]["model_revision"] =
        json!(digest(&artifact["statement"]["model"]).unwrap());
    artifact["statement"]["source_document_digest"] =
        artifact["statement"]["model_revision"].clone();
    artifact["statement"]["validator"] = json!(limeiot_core::validation::VALIDATOR);
    artifact["statement"]["compatibility_checker"] = json!(limeiot_core::compatibility::CHECKER);
    let seed = fixture["seed_hex"]
        .as_str()
        .unwrap()
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
        .collect::<Vec<_>>();
    let pair = Ed25519KeyPair::from_seed_unchecked(&seed).unwrap();
    let message =
        release::signing_message(&serde_json::from_value(artifact.clone()).unwrap()).unwrap();
    artifact["signature"] = json!(STANDARD.encode(pair.sign(&message).as_ref()));
    let trusted = data
        .apply_model_change(
            Request {
                space_id: "home".into(),
                idempotency_key: "trust".into(),
                change: Change::TrustAdd {
                    trust: fixture["trust"].clone(),
                    expected_signing_key_id: fixture["trust"]["signing_key_id"]
                        .as_str()
                        .unwrap()
                        .into(),
                },
            },
            now(),
        )
        .unwrap();
    let Resource::Trust(trust) = trusted.result.unwrap() else {
        panic!("trust")
    };
    let installed = data
        .apply_model_change(
            Request {
                space_id: "home".into(),
                idempotency_key: "install".into(),
                change: Change::Install {
                    trust_id: trust.trust_id,
                    artifact,
                    expected_release_id: None,
                },
            },
            now(),
        )
        .unwrap();
    assert_eq!(installed.status, "applied", "{:?}", installed.reason);
    let Resource::Installation(installation) = installed.result.unwrap() else {
        panic!("installation")
    };
    installation.installation_id
}

#[test]
fn signed_model_rebinding_rejects_unsupported_results_before_dispatch_without_changing_binding() {
    use limeiot_core::model_registry::{Change, Request};
    for model in incompatible_execution_models() {
        let mut data = ready();
        let command = data
            .create_command(input(&data, "queued"), now(), None)
            .unwrap();
        let installation_id = install_execution_model(&mut data, model);
        let before =
            digest(&(&data.devices, &data.commands, &data.model_registry.bindings)).unwrap();
        let result = data
            .apply_model_change(
                Request {
                    space_id: "home".into(),
                    idempotency_key: "bind-output".into(),
                    change: Change::Bind {
                        device_id: "tv".into(),
                        installation_id,
                        expected_model_revision: Some(data.devices["tv"].model_revision.clone()),
                        expected_binding_revision: None,
                    },
                },
                now(),
            )
            .unwrap();
        assert_eq!(result.status, "rejected");
        assert_eq!(result.reason.as_deref(), Some("bound_routes_incompatible"));
        assert_eq!(
            digest(&(&data.devices, &data.commands, &data.model_registry.bindings)).unwrap(),
            before
        );
        assert!(data.devices["tv"].adapter_ready(&route(), now()));
        assert!(data.prepare_dispatch(now()).is_empty());
        assert_eq!(data.commands[&command.command_id].status, "accepted");
        let dispatched = data.prepare_adapter_dispatch("tv-adb", now());
        assert_eq!(dispatched.len(), 1);
        assert_eq!(dispatched[0].command_id, command.command_id);
        data.recheck_adapter_dispatch(&dispatched[0], now())
            .unwrap();
        assert_eq!(
            data.apply_adapter_result(receipt(&command, "confirmed"), now())
                .unwrap()
                .status,
            "confirmed"
        );
    }
}

#[test]
fn signed_model_cannot_expand_adapter_inputs_or_change_action_meaning() {
    use limeiot_core::model_registry::{Change, Request};
    for variant in 0..7 {
        let mut data = ready();
        let mut model = data.models[&data.devices["tv"].model_revision].clone();
        match variant {
            0 => model.services[0].actions[0]
                .input
                .properties
                .get_mut("key")
                .unwrap()
                .values
                .as_mut()
                .unwrap()
                .push(json!("power")),
            1 => {
                model.services[0].actions[0].input.properties.insert(
                    "repeat".into(),
                    serde_json::from_value(json!({"type":"boolean"})).unwrap(),
                );
            }
            2 => model.services[0].actions[0].input.required.clear(),
            3 => model.services[0].actions[0].semantic_id = "urn:limeiot:action:other:1".into(),
            4 => model.services[0].actions[0].risk = "high".into(),
            5 => model.services[0].actions[0].idempotent = true,
            _ => model.services[0].semantic_id = "urn:limeiot:service:other:1".into(),
        }
        model.validate().unwrap();
        let installation_id = install_execution_model(&mut data, model);
        let before =
            digest(&(&data.devices, &data.commands, &data.model_registry.bindings)).unwrap();
        let result = data
            .apply_model_change(
                Request {
                    space_id: "home".into(),
                    idempotency_key: "bind-input".into(),
                    change: Change::Bind {
                        device_id: "tv".into(),
                        installation_id,
                        expected_model_revision: Some(data.devices["tv"].model_revision.clone()),
                        expected_binding_revision: None,
                    },
                },
                now(),
            )
            .unwrap();
        assert_eq!(
            result.reason.as_deref(),
            Some("bound_routes_incompatible"),
            "variant {variant}"
        );
        assert_eq!(
            digest(&(&data.devices, &data.commands, &data.model_registry.bindings)).unwrap(),
            before
        );
    }
}

#[test]
fn signed_model_with_narrower_input_binds_and_rejects_removed_keys() {
    use limeiot_core::model_registry::{Change, Request};
    let mut data = ready();
    let view = data.execution_binding("tv").unwrap();
    let offer = limeiot_core::execution_binding::Offer {
        device_id: "tv".into(),
        route: route(),
        model_revision: view.model_revision.clone(),
        paths: view.routes.keys().cloned().collect(),
    };
    let original = data
        .apply_execution_change(
            limeiot_core::execution_binding::Request {
                space_id: "home".into(),
                idempotency_key: "execution-bind".into(),
                change: limeiot_core::execution_binding::Change::Bind {
                    device_id: "tv".into(),
                    route: route(),
                    expected_binding_revision: view.revision,
                    expected_model_revision: view.model_revision,
                },
            },
            Some(&offer),
            now(),
        )
        .unwrap();
    let mut model = data.models[&data.devices["tv"].model_revision].clone();
    model.services[0].actions[0]
        .input
        .properties
        .get_mut("key")
        .unwrap()
        .values = Some(vec![json!("home")]);
    let installation_id = install_execution_model(&mut data, model);
    let result = data
        .apply_model_change(
            Request {
                space_id: "home".into(),
                idempotency_key: "bind-subset".into(),
                change: Change::Bind {
                    device_id: "tv".into(),
                    installation_id,
                    expected_model_revision: Some(data.devices["tv"].model_revision.clone()),
                    expected_binding_revision: None,
                },
            },
            now(),
        )
        .unwrap();
    assert_eq!(result.status, "applied", "{:?}", result.reason);
    data.validate_execution_registry().unwrap();
    let mut restored: Data = serde_json::from_value(serde_json::to_value(&data).unwrap()).unwrap();
    restored.validate_execution_registry().unwrap();
    let current = restored.devices["tv"].model_revision.clone();
    restored.recover();
    assert_eq!(
        restored
            .apply_execution_change(original.request, None, now())
            .unwrap()
            .status,
        "applied"
    );
    assert_eq!(restored.devices["tv"].model_revision, current);
    data.adapter_seen("tv", &route(), "new-adapter-session", now())
        .unwrap();
    let mut removed = input(&data, "removed-key");
    removed.operation.value = json!({"key":"back"});
    assert_eq!(
        data.create_command(removed, now(), None).unwrap_err().code,
        "invalid_value"
    );
    let accepted = data
        .create_command(input(&data, "allowed-key"), now(), None)
        .unwrap();
    assert_eq!(
        data.prepare_adapter_dispatch("tv-adb", now())[0].command_id,
        accepted.command_id
    );
}

#[test]
fn signed_model_with_supported_result_can_bind_and_complete_after_fresh_probe() {
    use limeiot_core::model_registry::{Change, Request};
    let mut data = ready();
    let model = data.models.values().next().unwrap().clone();
    let installation_id = install_execution_model(&mut data, model);
    let result = data
        .apply_model_change(
            Request {
                space_id: "home".into(),
                idempotency_key: "bind-supported".into(),
                change: Change::Bind {
                    device_id: "tv".into(),
                    installation_id,
                    expected_model_revision: Some(data.devices["tv"].model_revision.clone()),
                    expected_binding_revision: None,
                },
            },
            now(),
        )
        .unwrap();
    assert_eq!(result.status, "applied", "{:?}", result.reason);
    assert!(!data.devices["tv"].adapter_ready(&route(), now()));
    data.adapter_seen("tv", &route(), "adapter-session", now())
        .unwrap();
    let command = data
        .create_command(input(&data, "supported"), now(), None)
        .unwrap();
    let dispatched = data.prepare_adapter_dispatch("tv-adb", now());
    assert_eq!(dispatched.len(), 1);
    data.recheck_adapter_dispatch(&dispatched[0], now())
        .unwrap();
    assert_eq!(
        data.apply_adapter_result(receipt(&command, "confirmed"), now())
            .unwrap()
            .status,
        "confirmed"
    );
}
