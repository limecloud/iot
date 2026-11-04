use super::*;
use chrono::{DateTime, Duration, Utc};
use limeiot_core::{
    engine::Command, execution::AdapterReceipt, observation::Snapshot, property_bridge::Policy,
    protocol::CommandRequest,
};

fn at(second: i64) -> DateTime<Utc> {
    "2026-11-04T00:00:00Z".parse::<DateTime<Utc>>().unwrap() + Duration::seconds(second)
}
fn config() -> Config {
    serde_json::from_str(include_str!("../../../../deploy/dev/config.json")).unwrap()
}
fn policies() -> Vec<Policy> {
    vec![
        serde_json::from_value(json!({"observation":{"device_id":"device-lamp",
        "model_revision":config().devices[0].model_revision,
        "source":{"adapter_id":"property-source","revision":format!("sha256:{}","b".repeat(64))}},
        "write_paths":["light.power","light.brightness"]}))
        .unwrap(),
    ]
}
fn open(path: &str) -> Store {
    Store::open_with_adapter_policies(path, config(), &[], &policies()).unwrap()
}
fn sample(sequence: u64, value: bool, second: i64) -> Snapshot {
    serde_json::from_value(json!({"sequence":sequence,"samples":[
        {"path":"light.power","value":value,"observed_at":at(second)},
        {"path":"light.brightness","value":10,"unit":"percent","observed_at":at(second)}]}))
    .unwrap()
}
fn begin(store: &mut Store, second: i64) -> String {
    let mut token = None;
    store
        .update("observation.started", |data| {
            token = Some(data.begin_observation(&policies()[0].observation, at(second))?);
            Ok(())
        })
        .unwrap();
    token.unwrap()
}
fn request(store: &Store) -> CommandRequest {
    serde_json::from_value(
        json!({"space_id":store.data.space_id,"device_id":"device-lamp",
        "model_revision":store.data.devices["device-lamp"].model_revision,
        "idempotency_key":"power-on","expires_at":at(12),
        "operation":{"type":"property.set","path":"light.power","value":true}}),
    )
    .unwrap()
}
fn ready(store: &mut Store) -> (String, Command) {
    let token = begin(store, 0);
    store
        .update("observation.received", |data| {
            data.observe(
                &policies()[0].observation,
                &token,
                sample(1, false, 1),
                at(1),
            )
        })
        .unwrap();
    let request = request(store);
    let command = store
        .update("command.created", |data| {
            data.create_command(request, at(2), None)
        })
        .unwrap();
    (token, command)
}
fn dispatch(store: &mut Store) -> Command {
    let sent = store
        .update("command.dispatched", |data| {
            Ok(data.prepare_adapter_dispatch("property-source", at(2)))
        })
        .unwrap();
    assert_eq!(sent.len(), 1);
    sent[0].clone()
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
fn saved(store: &Store) -> (u32, String, String) {
    store
        .connection
        .query_row(
            "SELECT version,config_hash,body FROM snapshot WHERE id=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap()
}
fn path(label: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "limeiot-property-{label}-{}.sqlite",
        limeiot_core::id()
    ))
}

#[test]
fn dispatch_write_failure_publishes_no_command_and_retry_only_dispatches_once() {
    let mut store = open(":memory:");
    let (_, command) = ready(&mut store);
    let before = saved(&store);
    let events = store.events(0).unwrap();
    store
        .connection
        .execute_batch("PRAGMA query_only=ON")
        .unwrap();
    assert_eq!(
        store
            .update("command.dispatched", |data| Ok(
                data.prepare_adapter_dispatch("property-source", at(2))
            ))
            .unwrap_err()
            .code,
        "storage_unavailable"
    );
    assert_eq!(store.data.commands[&command.command_id].status, "accepted");
    assert_eq!(saved(&store), before);
    assert_eq!(store.events(0).unwrap(), events);
    store
        .connection
        .execute_batch("PRAGMA query_only=OFF")
        .unwrap();
    assert_eq!(dispatch(&mut store).command_id, command.command_id);
    assert!(store
        .update("command.dispatched", |data| Ok(
            data.prepare_adapter_dispatch("property-source", at(2))
        ))
        .unwrap()
        .is_empty());
}

#[test]
fn protocol_receipt_and_independent_confirmation_each_commit_atomically() {
    let mut store = open(":memory:");
    let (token, _) = ready(&mut store);
    let command = dispatch(&mut store);
    let before = saved(&store);
    let events = store.events(0).unwrap();
    store
        .connection
        .execute_batch("PRAGMA query_only=ON")
        .unwrap();
    assert_eq!(
        store
            .update("command.protocol_accepted", |data| data
                .apply_property_adapter_result(receipt(&command), at(3)))
            .unwrap_err()
            .code,
        "storage_unavailable"
    );
    assert!(store.data.commands[&command.command_id].evidence.is_none());
    assert_eq!(saved(&store), before);
    assert_eq!(store.events(0).unwrap(), events);
    store
        .connection
        .execute_batch("PRAGMA query_only=OFF")
        .unwrap();
    store
        .update("command.protocol_accepted", |data| {
            data.apply_property_adapter_result(receipt(&command), at(3))
        })
        .unwrap();
    assert_eq!(
        store.data.commands[&command.command_id].status,
        "dispatched"
    );
    assert_eq!(
        store.data.devices["device-lamp"].reported["light.power"].value,
        false
    );
    let before = saved(&store);
    let events = store.events(0).unwrap();
    store
        .connection
        .execute_batch("PRAGMA query_only=ON")
        .unwrap();
    assert_eq!(
        store
            .update("observation.received", |data| data.observe(
                &policies()[0].observation,
                &token,
                sample(2, true, 4),
                at(4)
            ))
            .unwrap_err()
            .code,
        "storage_unavailable"
    );
    assert_eq!(
        store.data.commands[&command.command_id].status,
        "dispatched"
    );
    assert_eq!(
        store.data.devices["device-lamp"].reported["light.power"].value,
        false
    );
    assert_eq!(saved(&store), before);
    assert_eq!(store.events(0).unwrap(), events);
    store
        .connection
        .execute_batch("PRAGMA query_only=OFF")
        .unwrap();
    store
        .update("observation.received", |data| {
            data.observe(
                &policies()[0].observation,
                &token,
                sample(2, true, 4),
                at(4),
            )
        })
        .unwrap();
    assert_eq!(store.data.commands[&command.command_id].status, "confirmed");
    assert_eq!(
        store.data.devices["device-lamp"].reported["light.power"].value,
        true
    );
    assert_eq!(store.events(0).unwrap().len(), events.len() + 1);
    assert_eq!(saved(&store).0, 14);
    assert!(!saved(&store).2.contains("property_bridge_policy"));
}

#[test]
fn restart_and_sqlite_copy_preserve_original_unknown_without_retransmission() {
    let original = path("original");
    let copy = path("copy");
    let mut store = open(original.to_str().unwrap());
    let (old_token, _) = ready(&mut store);
    let command = dispatch(&mut store);
    let original_request = request(&store);
    store
        .update("command.protocol_accepted", |data| {
            data.apply_property_adapter_result(receipt(&command), at(3))
        })
        .unwrap();
    store
        .connection
        .execute("VACUUM INTO ?1", [copy.to_str().unwrap()])
        .unwrap();
    drop(store);
    for path in [&original, &copy] {
        let mut recovered = open(path.to_str().unwrap());
        assert_eq!(
            recovered.data.commands[&command.command_id].status,
            "unknown"
        );
        assert_eq!(
            recovered.data.devices["device-lamp"].reported["light.power"].value,
            false
        );
        assert!(!recovered.data.devices["device-lamp"].ready);
        assert_eq!(
            recovered
                .update("observation.received", |data| {
                    data.observe(
                        &policies()[0].observation,
                        &old_token,
                        sample(2, true, 5),
                        at(5),
                    )
                })
                .unwrap_err()
                .code,
            "observation_session_closed"
        );
        let token = begin(&mut recovered, 4);
        recovered
            .update("observation.received", |data| {
                data.observe(
                    &policies()[0].observation,
                    &token,
                    sample(1, true, 5),
                    at(5),
                )
            })
            .unwrap();
        let original = recovered
            .update("command.created", |data| {
                data.create_command(original_request.clone(), at(5), None)
            })
            .unwrap();
        assert_eq!(original.command_id, command.command_id);
        assert_eq!(original.status, "unknown");
        assert!(recovered
            .update("command.dispatched", |data| Ok(
                data.prepare_adapter_dispatch("property-source", at(5))
            ))
            .unwrap()
            .is_empty());
    }
}

#[test]
fn confirmed_command_survives_recovery_with_original_state_evidence() {
    let path = path("confirmed");
    let mut store = open(path.to_str().unwrap());
    let (token, _) = ready(&mut store);
    let command = dispatch(&mut store);
    store
        .update("command.protocol_accepted", |data| {
            data.apply_property_adapter_result(receipt(&command), at(3))
        })
        .unwrap();
    store
        .update("observation.received", |data| {
            data.observe(
                &policies()[0].observation,
                &token,
                sample(2, true, 4),
                at(4),
            )
        })
        .unwrap();
    let evidence = store.data.commands[&command.command_id].evidence.clone();
    drop(store);
    let restored = open(path.to_str().unwrap());
    assert_eq!(
        restored.data.commands[&command.command_id].status,
        "confirmed"
    );
    assert_eq!(
        restored.data.commands[&command.command_id].evidence,
        evidence
    );
    assert!(!restored.data.devices["device-lamp"].ready);
}

#[test]
fn policy_hash_is_canonical_and_removed_or_changed_authority_is_rejected_without_writing() {
    let path = path("policy");
    let mut config = config();
    let mut policies = policies();
    let mut second = config.devices[0].clone();
    second.device_id = "second-lamp".into();
    config.devices.push(second);
    let mut second = policies[0].clone();
    second.observation.device_id = "second-lamp".into();
    second.observation.source.adapter_id = "second-source".into();
    policies.push(second);
    let store =
        Store::open_with_adapter_policies(path.to_str().unwrap(), config.clone(), &[], &policies)
            .unwrap();
    let before = saved(&store);
    drop(store);
    policies.reverse();
    let store =
        Store::open_with_adapter_policies(path.to_str().unwrap(), config.clone(), &[], &policies)
            .unwrap();
    assert_eq!(saved(&store), before);
    drop(store);
    let mut changed = policies.clone();
    changed[0].observation.source.revision = format!("sha256:{}", "a".repeat(64));
    assert_eq!(
        Store::open_with_adapter_policies(path.to_str().unwrap(), config.clone(), &[], &changed)
            .err()
            .unwrap()
            .code,
        "storage_config_mismatch"
    );
    assert_eq!(
        Store::open(path.to_str().unwrap(), config)
            .err()
            .unwrap()
            .code,
        "storage_config_mismatch"
    );
    let connection = Connection::open(path).unwrap();
    let after: (u32, String, String) = connection
        .query_row("SELECT version,config_hash,body FROM snapshot", [], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .unwrap();
    assert_eq!(after, before);
}

#[test]
fn tampered_routes_receipts_and_downgraded_snapshot_are_rejected_without_repairing_them() {
    for mode in [
        "missing-route",
        "extra-route",
        "receipt-digest",
        "early-confirmation",
        "downgrade",
    ] {
        let path = path(mode);
        let mut store = open(path.to_str().unwrap());
        let (token, _) = ready(&mut store);
        let command = dispatch(&mut store);
        store
            .update("command.protocol_accepted", |data| {
                data.apply_property_adapter_result(receipt(&command), at(3))
            })
            .unwrap();
        if mode == "early-confirmation" {
            store
                .update("observation.received", |data| {
                    data.observe(
                        &policies()[0].observation,
                        &token,
                        sample(2, true, 4),
                        at(4),
                    )
                })
                .unwrap();
        }
        let mut raw: Value = serde_json::from_str(&saved(&store).2).unwrap();
        match mode {
            "missing-route" => {
                raw["devices"]["device-lamp"]["routes"]
                    .as_object_mut()
                    .unwrap()
                    .remove("light.power");
            }
            "extra-route" => {
                raw["devices"]["device-lamp"]["routes"]["light.other"] =
                    json!(policies()[0].observation.source);
            }
            "receipt-digest" => {
                raw["commands"][&command.command_id]["evidence"]["receipt"]["request_digest"] =
                    json!("wrong-digest");
            }
            "early-confirmation" => {
                raw["commands"][&command.command_id]["evidence"]["observed_at"] = json!(at(3));
            }
            "downgrade" => {}
            _ => unreachable!(),
        }
        store
            .connection
            .execute(
                "UPDATE snapshot SET body=?1,version=?2",
                params![raw.to_string(), if mode == "downgrade" { 13 } else { 14 }],
            )
            .unwrap();
        let before = saved(&store);
        drop(store);
        assert_eq!(
            Store::open_with_adapter_policies(path.to_str().unwrap(), config(), &[], &policies())
                .err()
                .unwrap()
                .code,
            "storage_corrupt",
            "{mode}"
        );
        let connection = Connection::open(path).unwrap();
        let after: (u32, String, String) = connection
            .query_row("SELECT version,config_hash,body FROM snapshot", [], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .unwrap();
        assert_eq!(before, after, "{mode}");
    }
}

#[test]
fn empty_bridge_configuration_keeps_existing_native_configuration_hash_and_version() {
    let store = Store::open_with_adapter_policies(":memory:", config(), &[], &[]).unwrap();
    assert_eq!(saved(&store).0, 10);
    assert_eq!(saved(&store).1, digest(&config()).unwrap());
}
