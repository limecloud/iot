use super::*;
use chrono::{DateTime, Duration, Utc};
use limeiot_core::{
    observation::{Policy, Snapshot},
    protocol::{Envelope, Rule},
};

fn at(second: i64) -> DateTime<Utc> {
    "2026-11-04T00:00:00Z".parse::<DateTime<Utc>>().unwrap() + Duration::seconds(second)
}
fn config() -> Config {
    let mut config: Config =
        serde_json::from_str(include_str!("../../../../deploy/dev/config.json")).unwrap();
    let model: limeiot_core::model::Model = serde_json::from_str(include_str!(
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
fn sources() -> Vec<Policy> {
    vec![serde_json::from_value(json!({"device_id":"sensor","model_revision":config().devices.last().unwrap().model_revision,
        "source":{"adapter_id":"znp-sensor","revision":format!("sha256:{}","a".repeat(64))}})).unwrap()]
}
fn sample(sequence: u64, value: i64, second: i64) -> Snapshot {
    serde_json::from_value(json!({"sequence":sequence,"samples":[
        {"path":"environment.temperature","value":value,"unit":"celsius_x100","observed_at":at(second)},
        {"path":"environment.humidity","value":5000,"unit":"percent_x100","observed_at":at(second)}]})).unwrap()
}
fn begin(store: &mut Store, policy: &Policy) -> String {
    let mut token = None;
    store
        .update("observation.started", |data| {
            token = Some(data.begin_observation(policy, at(0))?);
            Ok(())
        })
        .unwrap();
    token.unwrap()
}
fn lamp(store: &mut Store) {
    for (kind, body) in [
        ("hello", json!({"challenge":"fixture"})),
        (
            "state",
            json!({"type":"snapshot","revision":1,"properties":[
        {"path":"light.power","value":true,"observed_at":at(0),"quality":"confirmed","source":"fixture"},
        {"path":"light.brightness","value":50,"observed_at":at(0),"quality":"confirmed","source":"fixture"}]}),
        ),
    ] {
        store.update("device.message", |data| {
            let device = &data.devices["device-lamp"];
            let envelope: Envelope = serde_json::from_value(json!({"v":1,"kind":kind,"message_id":format!("message-{}",device.last_seq+1),
                "device_id":"device-lamp","model_revision":device.model_revision,"boot_id":"lamp-boot","seq":device.last_seq+1,"session_id":device.session_id,"body":body})).unwrap();
            data.ingest(envelope, at(0))
        }).unwrap();
    }
}

#[test]
fn observation_state_threshold_run_and_command_commit_atomically_without_persisting_source_token() {
    let sources = sources();
    let policy = &sources[0];
    let mut store = Store::open_with_observation_sources(":memory:", config(), &sources).unwrap();
    let token = begin(&mut store, policy);
    lamp(&mut store);
    let rule: Rule = serde_json::from_value(json!({"version":1,"id":"external-temperature","trigger":{"device":"sensor","property":{
        "path":"environment.temperature","unit":"celsius_x100","edge":"rising","threshold":2800,"hysteresis":100}},
        "conditions":[],"actions":[{"device":"device-lamp","set":{"path":"light.brightness","value":30}}],"cooldown_ms":0})).unwrap();
    store
        .update("rule.deployed", |data| data.deploy(rule))
        .unwrap();
    store
        .update("observation.received", |data| {
            data.observe(policy, &token, sample(1, 2700, 1), at(1))
        })
        .unwrap();
    let before = serde_json::to_value(&store.data).unwrap();
    let events = store.events(0).unwrap();
    store
        .connection
        .execute_batch("PRAGMA query_only=ON")
        .unwrap();
    assert_eq!(
        store
            .update("observation.received", |data| data.observe(
                policy,
                &token,
                sample(2, 2801, 2),
                at(2)
            ))
            .unwrap_err()
            .code,
        "storage_unavailable"
    );
    assert_eq!(serde_json::to_value(&store.data).unwrap(), before);
    assert_eq!(store.events(0).unwrap(), events);
    store
        .connection
        .execute_batch("PRAGMA query_only=OFF")
        .unwrap();
    store
        .update("observation.received", |data| {
            data.observe(policy, &token, sample(2, 2801, 2), at(2))
        })
        .unwrap();
    assert_eq!(store.data.runs.len(), 1);
    assert_eq!(store.data.commands.len(), 1);
    assert_eq!(
        store.data.devices["sensor"].reported["environment.temperature"].value,
        2801
    );
    let body: String = store
        .connection
        .query_row("SELECT body FROM snapshot WHERE id=1", [], |row| row.get(0))
        .unwrap();
    assert!(!body.contains(&token));
    assert!(!serde_json::to_string(&store.events(0).unwrap())
        .unwrap()
        .contains(&token));
}

#[test]
fn restart_keeps_old_values_stale_and_rejects_native_takeover_or_removed_source_configuration() {
    let path = std::env::temp_dir().join(format!("limeiot-source-{}.sqlite", limeiot_core::id()));
    let sources = sources();
    let policy = &sources[0];
    let mut store =
        Store::open_with_observation_sources(path.to_str().unwrap(), config(), &sources).unwrap();
    let token = begin(&mut store, policy);
    store
        .update("observation.received", |data| {
            data.observe(policy, &token, sample(1, 2300, 1), at(1))
        })
        .unwrap();
    drop(store);
    let mut recovered =
        Store::open_with_observation_sources(path.to_str().unwrap(), config(), &sources).unwrap();
    assert_eq!(
        recovered.data.devices["sensor"].reported["environment.temperature"].value,
        2300
    );
    let view = recovered
        .data
        .devices_view(at(2))
        .into_iter()
        .find(|item| item["device_id"] == "sensor")
        .unwrap();
    assert_eq!(view["ready"], false);
    assert_eq!(
        view["reported"]["environment.temperature"]["quality"],
        "stale"
    );
    assert_eq!(
        recovered
            .update("observation.received", |data| data.observe(
                policy,
                &token,
                sample(2, 2900, 2),
                at(2)
            ))
            .unwrap_err()
            .code,
        "observation_session_closed"
    );
    let hello: Envelope = serde_json::from_value(json!({"v":1,"kind":"hello","message_id":"native-takeover","device_id":"sensor",
        "model_revision":policy.model_revision,"boot_id":"native","seq":1,"body":{"challenge":"native"}})).unwrap();
    assert_eq!(
        recovered
            .update("device.message", |data| data.ingest(hello, at(2)))
            .unwrap_err()
            .code,
        "observation_source_mismatch"
    );
    let stored: (String, String) = recovered
        .connection
        .query_row(
            "SELECT body,config_hash FROM snapshot WHERE id=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    drop(recovered);
    let error = Store::open(path.to_str().unwrap(), config()).err().unwrap();
    assert_eq!(error.code, "storage_config_mismatch");
    let mut changed = sources;
    changed[0].source.revision = format!("sha256:{}", "b".repeat(64));
    assert_eq!(
        Store::open_with_observation_sources(path.to_str().unwrap(), config(), &changed)
            .err()
            .unwrap()
            .code,
        "storage_config_mismatch"
    );
    let connection = Connection::open(path).unwrap();
    let after: (String, String) = connection
        .query_row(
            "SELECT body,config_hash FROM snapshot WHERE id=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(stored, after);
}

#[test]
fn source_order_is_canonical_but_adding_a_source_to_a_native_database_requires_migration() {
    let path = std::env::temp_dir().join(format!(
        "limeiot-source-order-{}.sqlite",
        limeiot_core::id()
    ));
    let mut config = config();
    let mut second = config.devices.last().unwrap().clone();
    second.device_id = "sensor2".into();
    config.devices.push(second);
    let mut sources = sources();
    let mut second = sources[0].clone();
    second.device_id = "sensor2".into();
    second.source.adapter_id = "znp-sensor2".into();
    sources.push(second);
    drop(
        Store::open_with_observation_sources(path.to_str().unwrap(), config.clone(), &sources)
            .unwrap(),
    );
    sources.reverse();
    drop(Store::open_with_observation_sources(path.to_str().unwrap(), config, &sources).unwrap());
    let path = std::env::temp_dir().join(format!(
        "limeiot-native-source-{}.sqlite",
        limeiot_core::id()
    ));
    drop(
        Store::open(
            path.to_str().unwrap(),
            super::observation_store_tests::config(),
        )
        .unwrap(),
    );
    assert_eq!(
        Store::open_with_observation_sources(
            path.to_str().unwrap(),
            super::observation_store_tests::config(),
            &super::observation_store_tests::sources()
        )
        .err()
        .unwrap()
        .code,
        "storage_config_mismatch"
    );
}
