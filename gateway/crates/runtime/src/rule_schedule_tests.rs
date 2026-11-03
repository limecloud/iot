use super::*;
use chrono::{DateTime, Duration, Utc};
use limeiot_core::protocol::{Envelope, Rule};

#[test]
fn schedule_capacity_failure_does_not_block_already_accepted_device_commands() {
    let (mut store, _) = setup();
    let revision = store.data.devices["device-lamp"].model_revision.clone();
    let request = serde_json::from_value(
        json!({"space_id":"space-demo","device_id":"device-lamp","model_revision":revision,
        "idempotency_key":"manual-before-schedule","expires_at":now()+Duration::seconds(5),
        "operation":{"type":"property.set","path":"light.power","value":true}}),
    )
    .unwrap();
    let command = store
        .update("command.created", |data| {
            data.create_command(request, now(), None)
        })
        .unwrap();
    // 旧事件运行占满记录容量，未到时的定时游标仍然有效。
    store
        .update("fixture.history", |data| {
            for index in 0..1024 {
                let run_id = format!("history-{index}");
                data.runs.insert(
                    run_id.clone(),
                    limeiot_core::engine::Run {
                        run_id,
                        rule_revision: format!("sha256:{}", "0".repeat(64)),
                        event_id: format!("event-{index}"),
                        command_ids: vec![],
                        error: None,
                        property_trigger: None,
                        condition_evaluation: None,
                        schedule_trigger: None,
                    },
                );
            }
            Ok(())
        })
        .unwrap();
    assert_eq!(
        store.data.clone().poll_schedules(due()).unwrap_err().code,
        "capacity_exceeded"
    );
    let cursor = store.data.deployments["bedtime"].schedule_cursor;
    let messages = crate::mqtt::pending_messages(&mut store, due()).unwrap();
    assert!(messages
        .iter()
        .any(|message| message.body["command_id"] == command.command_id));
    assert_eq!(
        store.data.commands[&command.command_id].status,
        "dispatched"
    );
    assert_eq!(store.data.runs.len(), 1024);
    assert_eq!(store.data.deployments["bedtime"].schedule_cursor, cursor);
}

fn now() -> DateTime<Utc> {
    "2026-11-03T13:59:59Z".parse().unwrap()
}
fn due() -> DateTime<Utc> {
    now() + Duration::seconds(1)
}
fn config() -> Config {
    serde_json::from_str(include_str!("../../../../deploy/dev/config.json")).unwrap()
}
fn rule() -> Rule {
    serde_json::from_value(json!({"version":1,"id":"bedtime","trigger":{"schedule":{"time":"22:00","time_zone":"Asia/Shanghai","weekdays":[1,2,3,4,5,6,7]}},
        "conditions":[],"actions":[{"device":"device-lamp","set":{"path":"light.power","value":false}}],"cooldown_ms":0})).unwrap()
}
fn setup() -> (Store, std::path::PathBuf) {
    let path = std::env::temp_dir().join(format!("limeiot-schedule-{}.sqlite", limeiot_core::id()));
    let mut store = Store::open(path.to_str().unwrap(), config()).unwrap();
    let revision = store.data.devices["device-lamp"].model_revision.clone();
    for (seq, kind, body) in [
        (1, "hello", json!({"challenge":"fixture"})),
        (
            2,
            "state",
            json!({"type":"snapshot","revision":1,"properties":[
        {"path":"light.power","value":true,"observed_at":now(),"quality":"confirmed","source":"fixture"},
        {"path":"light.brightness","value":50,"observed_at":now(),"quality":"confirmed","source":"fixture"}]}),
        ),
    ] {
        let input:Envelope=serde_json::from_value(json!({"v":1,"kind":kind,"message_id":format!("message-{seq}"),"device_id":"device-lamp","model_revision":revision,
            "boot_id":"boot-lamp","session_id":store.data.devices["device-lamp"].session_id,"seq":seq,"body":body})).unwrap();
        store
            .update("device.message", |d| d.ingest(input, now()))
            .unwrap();
    }
    store
        .update("rule.deployed", |d| d.deploy_at(rule(), now()))
        .unwrap();
    store
        .update("schedule.tick", |d| d.poll_schedules(now()))
        .unwrap();
    (store, path)
}
#[test]
fn schedule_cursor_run_and_command_commit_atomically_and_keep_v11_after_removal() {
    let (mut store, path) = setup();
    let before = serde_json::to_value(&store.data).unwrap();
    let events = store.events(0).unwrap().len();
    store
        .connection
        .execute_batch("PRAGMA query_only=ON")
        .unwrap();
    assert_eq!(
        store
            .update("schedule.tick", |d| d.poll_schedules(due()))
            .unwrap_err()
            .code,
        "storage_unavailable"
    );
    assert_eq!(serde_json::to_value(&store.data).unwrap(), before);
    assert_eq!(store.events(0).unwrap().len(), events);
    store
        .connection
        .execute_batch("PRAGMA query_only=OFF")
        .unwrap();
    store
        .update("schedule.tick", |d| d.poll_schedules(due()))
        .unwrap();
    assert_eq!(store.data.commands.len(), 1);
    assert_eq!(store.data.runs.len(), 1);
    let original = serde_json::to_value(&store.data.runs).unwrap();
    drop(store);
    let mut store = Store::open(path.to_str().unwrap(), config()).unwrap();
    store
        .update("schedule.tick", |d| {
            d.poll_schedules(due() + Duration::seconds(1))
        })
        .unwrap();
    assert_eq!(serde_json::to_value(&store.data.runs).unwrap(), original);
    assert_eq!(store.data.commands.len(), 1);
    let revision = store.data.deployments["bedtime"].revision.clone();
    store
        .update("rule.stopped", |d| d.stop_rule("bedtime", &revision))
        .unwrap();
    assert_eq!(
        store
            .connection
            .query_row("SELECT version FROM snapshot", [], |r| r.get::<_, u32>(0))
            .unwrap(),
        11
    );
}
#[test]
fn v10_cannot_hide_schedule_cursor_or_evidence_and_bad_v11_is_not_rewritten() {
    let (mut store, _) = setup();
    store
        .update("schedule.tick", |d| d.poll_schedules(due()))
        .unwrap();
    let original = serde_json::to_value(&store.data).unwrap();
    let mut missing = original.clone();
    missing["deployments"]["bedtime"]
        .as_object_mut()
        .unwrap()
        .remove("schedule_cursor");
    let mut wrong = original.clone();
    wrong["runs"]
        .as_object_mut()
        .unwrap()
        .values_mut()
        .next()
        .unwrap()["schedule_trigger"]["local_time"] = json!("23:00");
    let mut cursor_only = original.clone();
    cursor_only["deployments"]["bedtime"]["rule"] = serde_json::from_str::<Value>(include_str!(
        "../../../../contracts/examples/button-light.json"
    ))
    .unwrap();
    let mut evidence_only = original.clone();
    evidence_only["deployments"] = json!({});
    for (version, body) in [
        (10, original),
        (10, cursor_only),
        (10, evidence_only),
        (11, missing),
        (11, wrong),
    ] {
        let path = std::env::temp_dir().join(format!(
            "limeiot-schedule-corrupt-{}.sqlite",
            limeiot_core::id()
        ));
        let store = Store::open(path.to_str().unwrap(), config()).unwrap();
        let raw = body.to_string();
        store
            .connection
            .execute(
                "UPDATE snapshot SET version=?1,body=?2",
                params![version, raw],
            )
            .unwrap();
        let events = store.events(0).unwrap().len();
        drop(store);
        assert!(
            matches!(Store::open(path.to_str().unwrap(),config()),Err(e) if e.code=="storage_corrupt")
        );
        let disk = Connection::open(&path).unwrap();
        assert_eq!(
            disk.query_row("SELECT version,body FROM snapshot", [], |r| Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?
            )))
            .unwrap(),
            (version, raw)
        );
        assert_eq!(
            disk.query_row("SELECT COUNT(*) FROM events", [], |r| r.get::<_, usize>(0))
                .unwrap(),
            events
        );
    }
}
#[test]
fn subsecond_polls_do_not_rewrite_schedule_snapshots() {
    let (mut store, _) = setup();
    store
        .update("schedule.tick", |d| d.poll_schedules(due()))
        .unwrap();
    let events = store.events(0).unwrap().len();
    for milliseconds in [50, 100, 500, 999] {
        store
            .update("schedule.tick", |d| {
                d.poll_schedules(due() + Duration::milliseconds(milliseconds))
            })
            .unwrap();
    }
    assert_eq!(store.events(0).unwrap().len(), events);
    assert_eq!(store.data.commands.len(), 1);
}
