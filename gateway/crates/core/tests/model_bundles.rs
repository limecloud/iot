use chrono::{DateTime, Duration, Utc};
use limeiot_core::{
    digest,
    engine::{Config, Data},
    model_bundles::{Catalog, ModelBundle},
    model_registry::{parse_change, Change, DeviceBinding, Request},
    protocol::{CommandRequest, Envelope},
};
use serde_json::{json, Value};

fn now() -> DateTime<Utc> {
    "2026-11-02T00:00:00Z".parse().unwrap()
}
fn catalog() -> Catalog {
    Catalog::new([
        serde_json::from_slice(include_bytes!(
            "../../../../contracts/models/android-tv-agent.json"
        ))
        .unwrap(),
        serde_json::from_slice(include_bytes!(
            "../../../../contracts/models/android-tv-remote.json"
        ))
        .unwrap(),
    ])
    .unwrap()
}
fn bundle(remote: bool) -> ModelBundle {
    catalog().list()[usize::from(remote)].clone()
}
fn initial() -> Data {
    let bundle = bundle(false);
    Data::new(
        serde_json::from_value::<Config>(json!({"space_id":"home", "models":[bundle.model],
        "devices":[{"device_id":"tv","model_revision":bundle.model_revision}]}))
        .unwrap(),
    )
    .unwrap()
    .with_model_bundles(catalog())
}
fn message(data: &Data, kind: &str, body: Value) -> Envelope {
    serde_json::from_value(json!({"v":1,"kind":kind,"message_id":limeiot_core::id(),"device_id":"tv",
        "model_revision":data.devices["tv"].model_revision,"boot_id":data.devices["tv"].boot_id.as_deref().unwrap_or("tv-boot"),
        "session_id":data.devices["tv"].session_id,"seq":data.devices["tv"].last_seq+1,"body":body})).unwrap()
}
fn ready(data: &mut Data) {
    data.ingest(
        message(
            data,
            "hello",
            json!({"challenge":"c","receipt_ledger":1,"execution_paths":["apps.launch"]}),
        ),
        now(),
    )
    .unwrap();
    data.ingest(
        message(
            data,
            "state",
            json!({"type":"snapshot","revision":1,"properties":[]}),
        ),
        now(),
    )
    .unwrap();
}
fn request(data: &Data, key: &str, target: &ModelBundle) -> Request {
    Request {
        space_id: "home".into(),
        idempotency_key: key.into(),
        change: Change::BindBundle {
            device_id: "tv".into(),
            bundle_id: target.bundle_id.clone(),
            expected_model_revision: Some(data.devices["tv"].model_revision.clone()),
            expected_binding_revision: data
                .model_registry
                .bindings
                .get("tv")
                .map(|b| b.revision().to_owned()),
        },
    }
}
fn command(
    data: &mut Data,
    key: &str,
    path: &str,
) -> limeiot_core::Result<limeiot_core::engine::Command> {
    let request: CommandRequest=serde_json::from_value(json!({"space_id":"home","device_id":"tv","idempotency_key":key,
        "model_revision":data.devices["tv"].model_revision,"expires_at":now()+Duration::seconds(20),
        "operation":{"type":"action.invoke","path":path,"value":if path=="apps.launch" {json!({"application_id":"com.example.player"})} else {json!({"key":"home"})}}})).unwrap();
    data.create_command(request, now(), None)
}

#[test]
fn catalog_is_exact_and_never_accepts_caller_supplied_model_content() {
    let all = catalog();
    assert_eq!(all.list().len(), 2);
    for bundle in all.list() {
        assert_eq!(digest(&bundle.model).unwrap(), bundle.model_revision);
        assert_eq!(
            bundle.bundle_id,
            format!("bundle-{}", &bundle.model_revision[7..])
        );
    }
    assert_eq!(
        bundle(true).model_revision,
        "sha256:a591ed3813a996a6c8bb37e9ecdef2c335efd044c629b2a4b4f896fd93aa562a"
    );
    let source = serde_json::to_value(request(&initial(), "bind", &bundle(true)).change).unwrap();
    parse_change(&serde_json::to_vec(&source).unwrap()).unwrap();
    for field in ["model", "expected_binding_revision"] {
        let mut bad = source.clone();
        if field == "model" {
            bad[field] = json!({});
        } else {
            bad.as_object_mut().unwrap().remove(field);
        }
        assert!(parse_change(&serde_json::to_vec(&bad).unwrap()).is_err());
    }
}

#[test]
fn host_can_supply_other_models_but_duplicate_or_invalid_content_is_rejected() {
    let mut model = bundle(false).model;
    model.model_id = "urn:limeiot:model:custom-endpoint:1".into();
    let catalog = Catalog::new([model.clone()]).unwrap();
    assert_eq!(catalog.list()[0].model.model_id, model.model_id);
    assert_eq!(
        Catalog::new([model.clone(), model.clone()])
            .unwrap_err()
            .code,
        "duplicate_model_bundle"
    );
    model.model_version = "broken".into();
    assert!(Catalog::new([model]).is_err());
}

#[test]
fn snapshot_cannot_supply_trusted_bundles_and_missing_host_bundle_blocks_restore() {
    let mut data = initial();
    let change = request(&data, "bind", &bundle(true));
    data.apply_model_change(change.clone(), now()).unwrap();
    let mut saved = serde_json::to_value(&data).unwrap();
    assert!(saved.get("model_bundles").is_none());
    saved["model_bundles"] = json!({"bundles":catalog().list()});
    let restored: Data = serde_json::from_value(saved).unwrap();
    assert!(restored.model_bundles().list().is_empty());
    assert!(restored.validate_model_registry(now()).is_err());
    assert!(restored.check_model_authority("tv").is_err());
    let restored = restored.with_model_bundles(catalog());
    restored.validate_model_registry(now()).unwrap();
    restored.check_model_authority("tv").unwrap();
    let removed = restored
        .clone()
        .with_model_bundles(Catalog::new([bundle(false).model]).unwrap());
    assert!(removed.validate_model_registry(now()).is_err());
    assert!(removed.check_model_authority("tv").is_err());

    let mut unconfigured = Data::new(
        serde_json::from_value::<Config>(json!({
            "space_id":"home","models":[bundle(false).model],
            "devices":[{"device_id":"tv","model_revision":bundle(false).model_revision}]
        }))
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        unconfigured
            .apply_model_change(change, now())
            .unwrap()
            .reason
            .as_deref(),
        Some("model_bundle_not_found")
    );
}

#[test]
fn existing_device_switch_keeps_original_commands_and_requires_new_native_proof() {
    let mut data = initial();
    ready(&mut data);
    let dispatched = command(&mut data, "original", "apps.launch").unwrap();
    data.prepare_dispatch(now());
    let original = data.commands[&dispatched.command_id].envelope.clone();
    let queued = command(&mut data, "queued", "apps.launch").unwrap();
    let old_model = data.devices["tv"].model_revision.clone();
    let old_boot = data.devices["tv"].boot_id.clone().unwrap();
    let change = request(&data, "switch", &bundle(true));
    let operation = data.apply_model_change(change.clone(), now()).unwrap();
    assert_eq!(operation.status, "applied");
    let device = &data.devices["tv"];
    assert_eq!(device.model_revision, bundle(true).model_revision);
    assert!(!device.ready);
    assert!(device.session_id.is_none());
    assert!(device.native_actions.is_none());
    assert!(!device.receipt_ledger);
    assert!(device.retired_boots.contains(&old_boot));
    assert!(data.models.contains_key(&old_model));
    assert_eq!(data.commands[&dispatched.command_id].status, "unknown");
    assert_eq!(
        serde_json::to_value(&data.commands[&dispatched.command_id].envelope).unwrap(),
        serde_json::to_value(&original).unwrap()
    );
    assert_eq!(data.commands[&queued.command_id].status, "rejected");
    assert!(data.prepare_dispatch(now()).is_empty());
    assert_eq!(
        data.apply_model_change(change, now()).unwrap().operation_id,
        operation.operation_id
    );
    let mut hello = message(
        &data,
        "hello",
        json!({"challenge":"new","receipt_ledger":1,"execution_paths":["apps.launch"]}),
    );
    hello.boot_id = Some("new-boot".into());
    let welcome = data.ingest(hello, now()).unwrap().unwrap();
    assert_eq!(welcome.body["command_sequence"], 2);
    data.ingest(
        message(
            &data,
            "state",
            json!({"type":"snapshot","revision":1,"properties":[]}),
        ),
        now(),
    )
    .unwrap();
    let view = data
        .devices_view(now())
        .into_iter()
        .find(|v| v["device_id"] == "tv")
        .unwrap();
    assert_eq!(view["action_availability"]["apps.launch"], true);
    assert_eq!(view["action_availability"]["remote.press"], false);
    assert_eq!(
        command(&mut data, "press", "remote.press")
            .unwrap_err()
            .code,
        "execution_capability_unavailable"
    );
    assert!(data.prepare_dispatch(now()).is_empty());
    data.validate_model_registry(now()).unwrap();
}

#[test]
fn stale_baselines_unknown_bundle_and_wrong_space_do_not_change_device_or_model_catalog() {
    let mut data = initial();
    let original = digest(&data.devices).unwrap();
    let models = digest(&data.models).unwrap();
    let mut stale = request(&data, "stale", &bundle(true));
    if let Change::BindBundle {
        expected_model_revision,
        ..
    } = &mut stale.change
    {
        *expected_model_revision = None;
    }
    assert_eq!(
        data.apply_model_change(stale, now()).unwrap().status,
        "conflict"
    );
    let mut unknown = request(&data, "unknown", &bundle(true));
    if let Change::BindBundle { bundle_id, .. } = &mut unknown.change {
        *bundle_id = format!("bundle-{}", "0".repeat(64));
    }
    assert_eq!(
        data.apply_model_change(unknown, now())
            .unwrap()
            .reason
            .as_deref(),
        Some("model_bundle_not_found")
    );
    let mut foreign = request(&data, "foreign", &bundle(true));
    foreign.space_id = "elsewhere".into();
    assert_eq!(
        data.apply_model_change(foreign, now()).unwrap_err().code,
        "forbidden"
    );
    assert_eq!(digest(&data.devices).unwrap(), original);
    assert_eq!(digest(&data.models).unwrap(), models);
}

#[test]
fn original_success_never_reapplies_after_later_selection_and_source_variants_are_strict() {
    let mut data = initial();
    let first = request(&data, "first", &bundle(true));
    data.apply_model_change(first.clone(), now()).unwrap();
    let next = request(&data, "next", &bundle(false));
    data.apply_model_change(next, now()).unwrap();
    let current = digest(&data.devices).unwrap();
    let binding = serde_json::to_value(&data.model_registry.bindings["tv"]).unwrap();
    data.apply_model_change(first, now()).unwrap();
    assert_eq!(digest(&data.devices).unwrap(), current);
    assert_eq!(binding["bundle_id"], bundle(false).bundle_id);
    assert!(binding.get("installation_id").is_none());
    for bad in [
        {
            let mut b = binding.clone();
            b["installation_id"] = json!("install-other");
            b
        },
        {
            let mut b = binding.clone();
            b.as_object_mut().unwrap().remove("bundle_id");
            b
        },
        {
            let mut b = binding.clone();
            b["extra"] = json!(true);
            b
        },
    ] {
        assert!(serde_json::from_value::<DeviceBinding>(bad).is_err());
    }
    let mut published = binding;
    published.as_object_mut().unwrap().remove("bundle_id");
    published["installation_id"] = json!("install-old");
    assert!(serde_json::from_value::<DeviceBinding>(published)
        .unwrap()
        .installation_id()
        .is_some());
}

#[test]
fn restored_bundle_and_original_result_cannot_be_rewritten_to_another_source_or_model() {
    let mut data = initial();
    let change = request(&data, "bind", &bundle(true));
    data.apply_model_change(change, now()).unwrap();
    let encoded = serde_json::to_value(data).unwrap();
    for path in ["model", "binding", "result"] {
        let mut bad = encoded.clone();
        match path {
            "model" => bad["models"][bundle(true).model_revision]["model_version"] = json!("2.0.0"),
            "binding" => {
                bad["model_registry"]["bindings"]["tv"]["bundle_id"] =
                    json!(bundle(false).bundle_id)
            }
            _ => {
                bad["model_registry"]["operations"]["bind"]["result"]["value"]["bundle_id"] =
                    json!(bundle(false).bundle_id)
            }
        }
        let restored: Data = serde_json::from_value::<Data>(bad)
            .unwrap()
            .with_model_bundles(catalog());
        assert!(restored.validate_model_registry(now()).is_err());
    }
}
