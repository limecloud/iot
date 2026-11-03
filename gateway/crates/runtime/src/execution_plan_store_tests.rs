use super::*;
use chrono::{DateTime, Duration, Utc};
use limeiot_core::{
    execution_plans::{Change, Request},
    protocol::Envelope,
};
use std::path::PathBuf;

fn config() -> Config {
    let base: Value =
        serde_json::from_str(include_str!("../../../../deploy/dev/config.json")).unwrap();
    let model = base["models"][0].clone();
    let revision = digest(&model).unwrap();
    serde_json::from_value(json!({"space_id":"plan-store","models":[model],"devices":[
        {"device_id":"alpha","model_revision":revision},
        {"device_id":"beta","model_revision":revision}]}))
    .unwrap()
}
fn database_path() -> PathBuf {
    std::env::temp_dir().join(format!("limeiot-plan-store-{}.sqlite", limeiot_core::id()))
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
fn message(data: &Data, device: &str, kind: &str, body: Value) -> Envelope {
    let current = &data.devices[device];
    serde_json::from_value(json!({"v":1,"kind":kind,
        "message_id":format!("{device}-{}",current.last_seq+1),"device_id":device,
        "model_revision":current.model_revision,"boot_id":format!("boot-{device}"),
        "session_id":current.session_id,"seq":current.last_seq+1,"body":body}))
    .unwrap()
}
fn handshake(store: &mut Store) {
    let now = Utc::now();
    for device in ["alpha", "beta"] {
        let hello = message(
            &store.data,
            device,
            "hello",
            json!({"challenge":"plan-store"}),
        );
        store
            .update("device.hello", |data| data.ingest(hello, now))
            .unwrap();
        let state = message(
            &store.data,
            device,
            "state",
            json!({"type":"snapshot","revision":1,
            "properties":[
                {"path":"light.power","value":false,"observed_at":now,"quality":"confirmed","source":"fixture"},
                {"path":"light.brightness","value":0,"observed_at":now,"quality":"confirmed","source":"fixture"}]}),
        );
        store
            .update("device.state", |data| data.ingest(state, now))
            .unwrap();
    }
}
fn ready_store() -> (Store, PathBuf) {
    let path = database_path();
    let mut store = Store::open(path.to_str().unwrap(), config()).unwrap();
    handshake(&mut store);
    (store, path)
}
fn create_request(data: &Data, now: DateTime<Utc>) -> Request {
    let step = |device: &str, id: &str, value: bool| {
        json!({
        "step_id":id,"device_id":device,"model_revision":data.devices[device].model_revision,
        "operation":{"type":"property.set","path":"light.power","value":value},
        "command_timeout_ms":5000,"completion":{"type":"command"}})
    };
    serde_json::from_value(
        json!({"space_id":data.space_id,"idempotency_key":"original-create",
        "change":{"type":"plans.create","plan_id":"play","generation":"generation-one",
            "expires_at":now+Duration::minutes(10),"stages":[
                {"steps":[step("alpha","a-on",true),step("beta","b-on",true)]},
                {"steps":[step("alpha","a-off",false)]}]}}),
    )
    .unwrap()
}
fn create(store: &mut Store, now: DateTime<Utc>) -> Request {
    let request = create_request(&store.data, now);
    let operation = store
        .update("execution.plan.create", |data| {
            data.apply_plan_change(request.clone(), now)
        })
        .unwrap();
    assert_eq!(operation.status, "applied", "{:?}", operation.reason);
    request
}
fn start(store: &mut Store, now: DateTime<Utc>) -> Request {
    let request = Request {
        space_id: store.data.space_id.clone(),
        idempotency_key: "original-start".into(),
        change: Change::Start {
            plan_id: "play".into(),
            expected_revision: store.data.execution_plan("play").unwrap().revision.clone(),
        },
    };
    let operation = store
        .update("execution.plan.start", |data| {
            data.apply_plan_change(request.clone(), now)
        })
        .unwrap();
    assert_eq!(operation.status, "applied", "{:?}", operation.reason);
    request
}
fn running_store() -> (Store, PathBuf) {
    let (mut store, path) = ready_store();
    let now = Utc::now();
    create(&mut store, now);
    start(&mut store, now);
    store
        .update("execution.plan.poll", |data| data.poll_execution_plans(now))
        .unwrap();
    assert_eq!(store.data.commands.len(), 2);
    store.data.validate_execution_plan_registry().unwrap();
    (store, path)
}
fn rehash_plan(value: &mut Value) {
    let plan = &mut value["execution_plans"]["plans"]["play"];
    let mut content = plan.clone();
    content.as_object_mut().unwrap().remove("revision");
    plan["revision"] = json!(digest(&content).unwrap());
}

#[test]
fn legacy_v10_v11_read_without_plan_registry_or_implicit_v12_upgrade() {
    for version in [10, 11] {
        let path = database_path();
        let store = Store::open(path.to_str().unwrap(), config()).unwrap();
        let (_, _, body) = snapshot(&store.connection);
        assert!(serde_json::from_str::<Value>(&body)
            .unwrap()
            .get("execution_plans")
            .is_none());
        store
            .connection
            .execute("UPDATE snapshot SET version=?1", [version])
            .unwrap();
        drop(store);
        let store = Store::open(path.to_str().unwrap(), config()).unwrap();
        assert_eq!(snapshot(&store.connection).0, version as u32);
        assert!(store.data.execution_plans.is_empty());
        assert!(
            serde_json::from_str::<Value>(&snapshot(&store.connection).2)
                .unwrap()
                .get("execution_plans")
                .is_none()
        );
    }
}

#[test]
fn first_plan_commit_upgrades_to_v12_and_original_decision_remains_readable() {
    let (mut store, path) = ready_store();
    assert_eq!(snapshot(&store.connection).0, 10);
    let request = create(&mut store, Utc::now());
    let original = serde_json::to_value(
        store
            .data
            .execution_plan_operation("original-create")
            .unwrap(),
    )
    .unwrap();
    let saved = snapshot(&store.connection);
    assert_eq!(saved.0, 12);
    assert!(serde_json::from_str::<Value>(&saved.2).unwrap()["execution_plans"].is_object());
    drop(store);
    let mut store = Store::open(path.to_str().unwrap(), config()).unwrap();
    assert_eq!(snapshot(&store.connection).0, 12);
    assert_eq!(store.data.execution_plan("play").unwrap().status, "draft");
    let before = snapshot(&store.connection);
    let prior_events = events(&store.connection);
    let recovered = store
        .update("execution.plan.create", |data| {
            data.apply_plan_change(request, Utc::now())
        })
        .unwrap();
    assert_eq!(serde_json::to_value(recovered).unwrap(), original);
    assert_eq!(snapshot(&store.connection), before);
    assert_eq!(events(&store.connection), prior_events);
}

#[test]
fn corrupt_or_smuggled_plan_snapshots_fail_before_rewrite_or_recovery_event() {
    for mode in [
        "missing-registry",
        "fake-revision",
        "wrong-child",
        "operation-key",
        "command-key",
        "v10-registry",
        "v11-registry",
    ] {
        let (store, path) = running_store();
        let (mut version, _, body) = snapshot(&store.connection);
        let mut value: Value = serde_json::from_str(&body).unwrap();
        match mode {
            "missing-registry" => {
                value.as_object_mut().unwrap().remove("execution_plans");
            }
            "fake-revision" => {
                value["execution_plans"]["plans"]["play"]["revision"] =
                    json!(format!("sha256:{}", "0".repeat(64)))
            }
            "wrong-child" => {
                let other =
                    value["execution_plans"]["plans"]["play"]["children"][1]["command_id"].clone();
                value["execution_plans"]["plans"]["play"]["children"][0]["command_id"] = other;
                rehash_plan(&mut value);
            }
            "operation-key" => {
                let operation = &mut value["execution_plans"]["operations"]["original-create"];
                operation["request"]["idempotency_key"] = json!("forged-original");
                operation["request_digest"] = json!(digest(&operation["request"]).unwrap());
            }
            "command-key" => {
                let child = value["execution_plans"]["plans"]["play"]["children"][0]["command_id"]
                    .as_str()
                    .unwrap()
                    .to_owned();
                let old = value["commands"][&child]["request"]["idempotency_key"]
                    .as_str()
                    .unwrap()
                    .to_owned();
                value["commands"][&child]["request"]["idempotency_key"] = json!("forged-child-key");
                value["commands"][&child]["request_digest"] =
                    json!(digest(&value["commands"][&child]["request"]).unwrap());
                value["keys"].as_object_mut().unwrap().remove(&old);
                value["keys"]["forged-child-key"] = json!(child);
            }
            "v10-registry" => version = 10,
            "v11-registry" => version = 11,
            _ => unreachable!(),
        }
        store
            .connection
            .execute(
                "UPDATE snapshot SET version=?1,body=?2",
                params![version, value.to_string()],
            )
            .unwrap();
        let raw = snapshot(&store.connection);
        let prior_events = events(&store.connection);
        drop(store);
        assert!(
            matches!(Store::open(path.to_str().unwrap(), config()), Err(error) if error.code == "storage_corrupt"),
            "accepted {mode}"
        );
        let connection = Connection::open(&path).unwrap();
        assert_eq!(snapshot(&connection), raw, "rewrote {mode}");
        assert_eq!(
            events(&connection),
            prior_events,
            "published recovery for {mode}"
        );
    }
}

#[test]
fn late_sqlite_failure_rolls_back_plan_decision_children_and_events() {
    let (mut store, _) = ready_store();
    let now = Utc::now();
    let request = create_request(&store.data, now);
    let before = serde_json::to_value(&store.data).unwrap();
    let raw = snapshot(&store.connection);
    let prior_events = events(&store.connection);
    store.connection.execute_batch("CREATE TRIGGER fail_plan_create BEFORE INSERT ON events WHEN NEW.type='execution.plan.create' BEGIN SELECT RAISE(ABORT,'injected'); END").unwrap();
    let failed = store.update("execution.plan.create", |data| {
        data.apply_plan_change(request, now)
    });
    assert_eq!(failed.unwrap_err().code, "storage_unavailable");
    assert_eq!(serde_json::to_value(&store.data).unwrap(), before);
    assert_eq!(snapshot(&store.connection), raw);
    assert_eq!(events(&store.connection), prior_events);
    assert!(store.data.execution_plans.is_empty());
    assert!(store.data.commands.is_empty());
    store
        .connection
        .execute_batch("DROP TRIGGER fail_plan_create")
        .unwrap();
    create(&mut store, now);
    start(&mut store, now);
    let before = serde_json::to_value(&store.data).unwrap();
    let raw = snapshot(&store.connection);
    let prior_events = events(&store.connection);
    store.connection.execute_batch("CREATE TRIGGER fail_plan_poll BEFORE INSERT ON events WHEN NEW.type='execution.plan.poll' BEGIN SELECT RAISE(ABORT,'injected'); END").unwrap();
    let failed = store.update("execution.plan.poll", |data| data.poll_execution_plans(now));
    assert_eq!(failed.unwrap_err().code, "storage_unavailable");
    assert_eq!(serde_json::to_value(&store.data).unwrap(), before);
    assert_eq!(snapshot(&store.connection), raw);
    assert_eq!(events(&store.connection), prior_events);
    assert!(store.data.commands.is_empty());
    assert!(store
        .data
        .execution_plan("play")
        .unwrap()
        .children
        .is_empty());
}

#[test]
fn running_v12_recovers_unknown_with_original_children_and_never_replays() {
    let (mut store, path) = running_store();
    let dispatched = store
        .update("commands.transitioned", |data| {
            Ok(data.prepare_dispatch(Utc::now()))
        })
        .unwrap();
    assert_eq!(dispatched.len(), 2);
    let commands: Vec<_> = store
        .data
        .commands
        .values()
        .map(|command| {
            (
                command.command_id.clone(),
                command.envelope.clone(),
                command.request_digest.clone(),
            )
        })
        .collect();
    let operations = serde_json::to_value(&store.data.execution_plans.operations).unwrap();
    drop(store);
    let mut store = Store::open(path.to_str().unwrap(), config()).unwrap();
    let plan = store.data.execution_plan("play").unwrap();
    assert_eq!(plan.status, "unknown");
    assert_eq!(plan.physical_stop, "unknown");
    assert_eq!(plan.reason.as_deref(), Some("gateway_restarted"));
    assert_eq!(plan.current_stage, 0);
    assert_eq!(plan.children.len(), 2);
    assert!(!plan.released);
    assert_eq!(snapshot(&store.connection).0, 12);
    assert_eq!(
        serde_json::to_value(&store.data.execution_plans.operations).unwrap(),
        operations
    );
    for (id, envelope, digest) in &commands {
        let current = &store.data.commands[id];
        assert_eq!(current.status, "unknown");
        assert_eq!(
            serde_json::to_value(&current.envelope).unwrap(),
            serde_json::to_value(envelope).unwrap()
        );
        assert_eq!(&current.request_digest, digest);
    }
    handshake(&mut store);
    let before = serde_json::to_value(&store.data).unwrap();
    let raw = snapshot(&store.connection);
    let prior_events = events(&store.connection);
    store
        .update("execution.plan.poll", |data| {
            data.poll_execution_plans(Utc::now())
        })
        .unwrap();
    assert!(store
        .update("commands.transitioned", |data| Ok(
            data.prepare_dispatch(Utc::now())
        ))
        .unwrap()
        .is_empty());
    assert_eq!(serde_json::to_value(&store.data).unwrap(), before);
    assert_eq!(snapshot(&store.connection), raw);
    assert_eq!(events(&store.connection), prior_events);
    assert_eq!(store.data.commands.len(), commands.len());
    store.data.validate_execution_plan_registry().unwrap();
}
