use super::*;
use chrono::{DateTime, Duration, Utc};
use limeiot_core::{
    observation::{Policy, Snapshot},
    observation_binding::{Change, Offer, Request},
    protocol::Envelope,
};
use std::path::PathBuf;

fn at(second: i64) -> DateTime<Utc> {
    "2026-11-04T00:00:00Z".parse::<DateTime<Utc>>().unwrap() + Duration::seconds(second)
}
fn config() -> Config {
    serde_json::from_str(include_str!("../../../../deploy/dev/config.json")).unwrap()
}
fn path() -> PathBuf {
    std::env::temp_dir().join(format!(
        "limeiot-observation-binding-{}.sqlite",
        limeiot_core::id()
    ))
}
fn offer() -> Offer {
    let manifest = json!({"mapping":"fixture-environment-v1","target":"alpha"});
    Offer {
        source: serde_json::from_value(
            json!({"adapter_id":"fixture-source-alpha","revision":digest(&manifest).unwrap()}),
        )
        .unwrap(),
        model: serde_json::from_str(include_str!(
            "../../../../contracts/models/environment.json"
        ))
        .unwrap(),
        manifest,
        write_paths: Default::default(),
        observed_at: at(0),
        expires_at: at(60),
    }
}
fn request(data: &Data, key: &str, offer: &Offer) -> Request {
    Request {
        space_id: data.space_id.clone(),
        idempotency_key: key.into(),
        change: Change::Bind {
            device_id: "sensor".into(),
            source: offer.source.clone(),
            expected_model_revision: digest(&offer.model).unwrap(),
            expected_binding_revision: data.observation_binding("sensor").unwrap().revision,
        },
    }
}
fn revoke(data: &Data) -> Request {
    Request {
        space_id: data.space_id.clone(),
        idempotency_key: "revoke".into(),
        change: Change::Revoke {
            device_id: "sensor".into(),
            expected_binding_revision: data.observation_binding("sensor").unwrap().revision,
        },
    }
}
fn attach(store: &mut Store) -> (Request, Policy) {
    let offer = offer();
    let request = request(&store.data, "create", &offer);
    let operation = store
        .update("observation.bound", |data| {
            data.apply_observation_change(request.clone(), Some(&offer), at(0))
        })
        .unwrap();
    assert_eq!(operation.status, "applied", "{:?}", operation.reason);
    (request, operation.result.unwrap().binding.unwrap().policy)
}
fn sample(sequence: u64, second: i64) -> Snapshot {
    serde_json::from_value(json!({"sequence":sequence,"samples":[
        {"path":"environment.temperature","value":2300,"unit":"celsius_x100","observed_at":at(second)},
        {"path":"environment.humidity","value":5000,"unit":"percent_x100","observed_at":at(second)}]})).unwrap()
}
fn snapshot(connection: &Connection) -> (u32, String, String) {
    connection
        .query_row(
            "SELECT version,config_hash,body FROM snapshot WHERE id=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap()
}
fn events(connection: &Connection) -> Vec<(i64, String, String)> {
    connection
        .prepare("SELECT id,type,data FROM events ORDER BY id")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .unwrap()
        .map(std::result::Result::unwrap)
        .collect()
}

#[test]
fn managed_property_bridge_uses_v15_and_restores_exact_routes_without_replaying_commands() {
    let path = path();
    let mut store = Store::open(path.to_str().unwrap(), config()).unwrap();
    let mut offer = offer();
    offer.model = serde_json::from_str(include_str!(
        "../../../../contracts/models/on-off-light.json"
    ))
    .unwrap();
    offer.write_paths.insert("light.power".into());
    let input = request(&store.data, "switch-bind", &offer);
    store
        .connection
        .execute_batch("PRAGMA query_only=ON")
        .unwrap();
    assert!(store
        .update("sources.bound", |data| data.apply_observation_change(
            input.clone(),
            Some(&offer),
            at(0)
        ))
        .is_err());
    assert!(!store.data.devices.contains_key("sensor"));
    store
        .connection
        .execute_batch("PRAGMA query_only=OFF")
        .unwrap();
    let operation = store
        .update("sources.bound", |data| {
            data.apply_observation_change(input.clone(), Some(&offer), at(0))
        })
        .unwrap();
    assert_eq!(operation.status, "applied");
    let original = snapshot(&store.connection);
    assert_eq!(original.0, 15);
    let original_events = events(&store.connection);
    drop(store);
    let store = Store::open(path.to_str().unwrap(), config()).unwrap();
    assert_eq!(
        store.data.devices["sensor"].routes["light.power"],
        offer.source
    );
    assert!(store.data.has_property_bridges());
    assert!(!store.data.devices["sensor"].ready);
    assert_eq!(snapshot(&store.connection), original);
    let recovered_events = events(&store.connection);
    assert_eq!(
        &recovered_events[..original_events.len()],
        original_events.as_slice()
    );
    assert_eq!(recovered_events.len(), original_events.len() + 1);
    assert_eq!(recovered_events.last().unwrap().1, "gateway.recovered");
    drop(store);
    for mode in ["old-version", "future", "missing-route", "extra-route"] {
        let connection = Connection::open(&path).unwrap();
        let mut body: Value = serde_json::from_str(&original.2).unwrap();
        let version = match mode {
            "old-version" => 13,
            "future" => 16,
            "missing-route" => {
                body["devices"]["sensor"]["routes"] = json!({});
                15
            }
            "extra-route" => {
                body["devices"]["sensor"]["routes"]["light.extra"] = json!(offer.source);
                15
            }
            _ => unreachable!(),
        };
        connection
            .execute(
                "UPDATE snapshot SET version=?1,body=?2",
                rusqlite::params![version, body.to_string()],
            )
            .unwrap();
        let before = snapshot(&connection);
        assert!(
            Store::open(path.to_str().unwrap(), config()).is_err(),
            "{mode}"
        );
        assert_eq!(snapshot(&connection), before, "{mode}");
        assert_eq!(events(&connection), recovered_events, "{mode}");
    }
}
fn native(policy: &Policy) -> Envelope {
    serde_json::from_value(json!({"v":1,"kind":"hello","message_id":"native-takeover",
        "device_id":policy.device_id,"model_revision":policy.model_revision,"boot_id":"native","seq":1,
        "body":{"challenge":"native"}})).unwrap()
}

#[test]
fn binding_recovery_preserves_original_decision_but_not_source_liveness_or_tokens() {
    let path = path();
    let mut store = Store::open(path.to_str().unwrap(), config()).unwrap();
    let (request, policy) = attach(&mut store);
    let original =
        serde_json::to_value(store.data.observation_operation("create").unwrap()).unwrap();
    let token = store.data.begin_observation(&policy, at(0)).unwrap();
    store
        .update("observation.received", |data| {
            data.observe(&policy, &token, sample(1, 1), at(1))
        })
        .unwrap();
    let saved = snapshot(&store.connection);
    assert_eq!(saved.0, 13);
    assert_eq!(saved.1, digest(&config()).unwrap());
    assert!(!saved.2.contains(&token));
    assert!(serde_json::from_str::<Value>(&saved.2)
        .unwrap()
        .get("execution_plans")
        .is_none());
    drop(store);
    let mut store = Store::open(path.to_str().unwrap(), config()).unwrap();
    assert!(!store.data.devices["sensor"].ready);
    assert_eq!(
        store.data.devices["sensor"].reported["environment.temperature"].value,
        2300
    );
    assert_eq!(
        store
            .data
            .observe(&policy, &token, sample(2, 2), at(2))
            .unwrap_err()
            .code,
        "observation_session_closed"
    );
    assert_eq!(
        store.data.ingest(native(&policy), at(2)).unwrap_err().code,
        "observation_source_mismatch"
    );
    let before = snapshot(&store.connection);
    let before_events = events(&store.connection);
    let recovered = store
        .update("observation.bound", |data| {
            data.apply_observation_change(request, None, at(100))
        })
        .unwrap();
    assert_eq!(serde_json::to_value(recovered).unwrap(), original);
    assert_eq!(snapshot(&store.connection), before);
    assert_eq!(events(&store.connection), before_events);
}

#[test]
fn revoke_is_durable_and_explicit_rebind_requires_a_new_decision_and_new_session() {
    let path = path();
    let mut store = Store::open(path.to_str().unwrap(), config()).unwrap();
    let (_, policy) = attach(&mut store);
    let token = store.data.begin_observation(&policy, at(0)).unwrap();
    store
        .update("observation.received", |data| {
            data.observe(&policy, &token, sample(1, 1), at(1))
        })
        .unwrap();
    let request = revoke(&store.data);
    let revoked = store
        .update("observation.revoked", |data| {
            data.apply_observation_change(request.clone(), None, at(2))
        })
        .unwrap();
    assert_eq!(revoked.status, "applied");
    drop(store);
    let mut store = Store::open(path.to_str().unwrap(), config()).unwrap();
    assert_eq!(
        store
            .data
            .begin_observation(&policy, at(3))
            .unwrap_err()
            .code,
        "observation_source_revoked"
    );
    assert_eq!(
        store.data.ingest(native(&policy), at(3)).unwrap_err().code,
        "observation_source_mismatch"
    );
    assert_eq!(
        serde_json::to_value(
            store
                .data
                .apply_observation_change(request, None, at(100))
                .unwrap()
        )
        .unwrap(),
        serde_json::to_value(revoked).unwrap()
    );
    let offer = offer();
    let request = self::request(&store.data, "rebind", &offer);
    let operation = store
        .update("observation.bound", |data| {
            data.apply_observation_change(request, Some(&offer), at(3))
        })
        .unwrap();
    assert_eq!(operation.status, "applied");
    assert!(store.data.devices["sensor"].reported.is_empty());
    assert!(!store.data.devices["sensor"].ready);
    assert!(store.data.commands.is_empty());
    assert!(store.data.runs.is_empty());
    drop(store);
    let mut store = Store::open(path.to_str().unwrap(), config()).unwrap();
    let current = store.data.begin_observation(&policy, at(4)).unwrap();
    assert_eq!(
        store
            .data
            .end_observation(&policy, &token)
            .unwrap_err()
            .code,
        "observation_session_mismatch"
    );
    store
        .update("observation.received", |data| {
            data.observe(&policy, &current, sample(1, 5), at(5))
        })
        .unwrap();
    assert_eq!(snapshot(&store.connection).0, 13);
}

#[test]
fn failed_snapshot_or_event_commit_never_publishes_device_model_authority_or_operation() {
    for failure in ["snapshot", "event"] {
        let mut store = Store::open(":memory:", config()).unwrap();
        let before = snapshot(&store.connection);
        let before_events = events(&store.connection);
        match failure {
            "snapshot" => store.connection.execute_batch("PRAGMA query_only=ON").unwrap(),
            "event" => store.connection.execute_batch("CREATE TEMP TRIGGER reject_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'fixture'); END;").unwrap(),
            _ => unreachable!(),
        }
        let offer = offer();
        let request = request(&store.data, "create", &offer);
        assert_eq!(
            store
                .update("observation.bound", |data| data.apply_observation_change(
                    request,
                    Some(&offer),
                    at(0)
                ))
                .unwrap_err()
                .code,
            "storage_unavailable"
        );
        assert!(!store.data.devices.contains_key("sensor"));
        assert!(!store
            .data
            .models
            .contains_key(&digest(&offer.model).unwrap()));
        assert!(store.data.observation_registry.is_empty());
        assert_eq!(snapshot(&store.connection), before, "{failure}");
        assert_eq!(events(&store.connection), before_events, "{failure}");
    }
}

#[test]
fn a_failed_revoke_or_rebind_keeps_the_previous_committed_source_and_token() {
    for change in ["revoke", "rebind"] {
        let mut store = Store::open(":memory:", config()).unwrap();
        let (_, policy) = attach(&mut store);
        let token = store.data.begin_observation(&policy, at(0)).unwrap();
        store
            .update("observation.received", |data| {
                data.observe(&policy, &token, sample(1, 1), at(1))
            })
            .unwrap();
        let before = snapshot(&store.connection);
        let offer = offer();
        let request = if change == "revoke" {
            revoke(&store.data)
        } else {
            request(&store.data, "rebind", &offer)
        };
        store
            .connection
            .execute_batch("PRAGMA query_only=ON")
            .unwrap();
        assert_eq!(
            store
                .update("observation.changed", |data| data.apply_observation_change(
                    request,
                    Some(&offer),
                    at(2)
                ))
                .unwrap_err()
                .code,
            "storage_unavailable"
        );
        assert_eq!(snapshot(&store.connection), before);
        store
            .connection
            .execute_batch("PRAGMA query_only=OFF")
            .unwrap();
        store
            .update("observation.received", |data| {
                data.observe(&policy, &token, sample(2, 2), at(2))
            })
            .unwrap();
        assert!(store.data.devices["sensor"].ready);
        assert_eq!(store.data.observation_registry.operations.len(), 1);
    }
}

#[test]
fn legacy_versions_cannot_hide_source_state_and_corrupt_v13_is_never_rewritten() {
    for mode in [
        "v10",
        "v11",
        "v12",
        "missing",
        "empty",
        "sequence",
        "generation",
        "operation",
        "device",
        "future",
    ] {
        let path = path();
        let mut store = Store::open(path.to_str().unwrap(), config()).unwrap();
        attach(&mut store);
        let (mut version, _, body) = snapshot(&store.connection);
        let mut value: Value = serde_json::from_str(&body).unwrap();
        match mode {
            "v10" => version = 10,
            "v11" => version = 11,
            "v12" => {
                version = 12;
                value["execution_plans"] = json!({"plans":{},"operations":{}});
            }
            "missing" => {
                value
                    .as_object_mut()
                    .unwrap()
                    .remove("observation_registry");
            }
            "empty" => value["observation_registry"] = json!({"bindings":{},"operations":{}}),
            "sequence" => {
                value["observation_registry"]["operations"]["create"]["sequence"] = json!(2)
            }
            "generation" => {
                value["observation_registry"]["bindings"]["sensor"]["generation"] = json!("forged")
            }
            "operation" => {
                value["observation_registry"]["operations"]
                    .as_object_mut()
                    .unwrap()
                    .remove("create");
            }
            "device" => {
                value["devices"].as_object_mut().unwrap().remove("sensor");
            }
            "future" => version = 14,
            _ => unreachable!(),
        }
        store
            .connection
            .execute(
                "UPDATE snapshot SET version=?1,body=?2",
                params![version, value.to_string()],
            )
            .unwrap();
        let before = snapshot(&store.connection);
        let before_events = events(&store.connection);
        drop(store);
        let error = Store::open(path.to_str().unwrap(), config())
            .err()
            .expect(mode);
        assert_eq!(
            error.code,
            if mode == "future" {
                "storage_config_mismatch"
            } else {
                "storage_corrupt"
            },
            "{mode}"
        );
        let connection = Connection::open(path).unwrap();
        assert_eq!(snapshot(&connection), before, "{mode}");
        assert_eq!(events(&connection), before_events, "{mode}");
    }
}

#[test]
fn existing_v12_plans_and_rejected_source_decisions_can_share_v13_without_downgrade() {
    let path = path();
    let mut store = Store::open(path.to_str().unwrap(), config()).unwrap();
    let plan: limeiot_core::execution_plans::Request = serde_json::from_value(json!({
        "space_id":store.data.space_id,"idempotency_key":"invalid-plan",
        "change":{"type":"plans.start","plan_id":"absent","expected_revision":format!("sha256:{}","0".repeat(64))}
    })).unwrap();
    let result = store
        .update("execution.plan.start", |data| {
            data.apply_plan_change(plan, at(0))
        })
        .unwrap();
    assert_eq!(result.status, "rejected");
    assert_eq!(snapshot(&store.connection).0, 12);
    let offer = offer();
    let request = request(&store.data, "no-offer", &offer);
    let result = store
        .update("observation.bound", |data| {
            data.apply_observation_change(request, None, at(0))
        })
        .unwrap();
    assert_eq!(result.status, "rejected");
    assert_eq!(snapshot(&store.connection).0, 13);
    assert!(store.data.observation_registry.bindings.is_empty());
    let saved = snapshot(&store.connection);
    assert!(serde_json::from_str::<Value>(&saved.2).unwrap()["execution_plans"].is_object());
    drop(store);
    let mut store = Store::open(path.to_str().unwrap(), config()).unwrap();
    assert_eq!(snapshot(&store.connection).0, 13);
    assert_eq!(
        store
            .data
            .execution_plan_operation("invalid-plan")
            .unwrap()
            .status,
        "rejected"
    );
    assert_eq!(
        store.data.observation_operation("no-offer").unwrap().status,
        "rejected"
    );
    attach(&mut store);
    assert_eq!(snapshot(&store.connection).0, 13);
}
