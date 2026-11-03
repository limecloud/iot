use chrono::{DateTime, Duration, NaiveDate, Utc};
use limeiot_core::{
    digest,
    engine::{Config, Data},
    protocol::{Envelope, Rule, Trigger},
    rule_schedule::Schedule,
};
use serde_json::{json, Value};

fn at(value: &str) -> DateTime<Utc> {
    value.parse().unwrap()
}
fn start() -> DateTime<Utc> {
    at("2026-11-03T13:59:59Z")
}
fn due() -> DateTime<Utc> {
    start() + Duration::seconds(1)
}
fn schedule(time: &str, zone: &str) -> Schedule {
    Schedule {
        time: time.into(),
        time_zone: zone.into(),
        weekdays: vec![1, 2, 3, 4, 5, 6, 7],
    }
}
fn rule() -> Rule {
    serde_json::from_value(json!({"version":1,"id":"bedtime","trigger":{"schedule":schedule("22:00","Asia/Shanghai")},
        "conditions":[],"actions":[{"device":"device-lamp","set":{"path":"light.power","value":false}}],"cooldown_ms":0})).unwrap()
}
fn ready() -> Data {
    let config: Config =
        serde_json::from_str(include_str!("../../../../deploy/dev/config.json")).unwrap();
    let mut data = Data::new(config).unwrap();
    let revision = data.devices["device-lamp"].model_revision.clone();
    let hello: Envelope = serde_json::from_value(
        json!({"v":1,"kind":"hello","message_id":"hello","device_id":"device-lamp",
        "model_revision":revision,"boot_id":"boot-lamp","seq":1,"body":{"challenge":"fixture"}}),
    )
    .unwrap();
    data.ingest(hello, start()).unwrap();
    let state:Envelope=serde_json::from_value(json!({"v":1,"kind":"state","message_id":"state","device_id":"device-lamp",
        "model_revision":revision,"boot_id":"boot-lamp","session_id":data.devices["device-lamp"].session_id,"seq":2,
        "body":{"type":"snapshot","revision":1,"properties":[
        {"path":"light.power","value":true,"observed_at":start(),"quality":"confirmed","source":"fixture"},
        {"path":"light.brightness","value":50,"observed_at":start(),"quality":"confirmed","source":"fixture"}]}})).unwrap();
    data.ingest(state, start()).unwrap();
    data
}
#[test]
fn strict_schedule_input_and_legacy_serialization() {
    let legacy: Value = serde_json::from_str(include_str!(
        "../../../../contracts/examples/button-light.json"
    ))
    .unwrap();
    assert_eq!(
        digest(&serde_json::from_value::<Rule>(legacy.clone()).unwrap()).unwrap(),
        digest(&legacy).unwrap()
    );
    for input in [
        json!({"schedule":null}),
        json!({"device":"x","schedule":schedule("22:00","UTC")}),
        json!({"schedule":schedule("22:00","UTC"),"event":"button.pressed"}),
    ] {
        assert!(serde_json::from_value::<Trigger>(input).is_err());
    }
    for time in ["24:00", "22:60", "2:00", "22:00:00", " 22:00", "２２:００"] {
        assert!(schedule(time, "UTC").validate().is_err(), "{time}");
    }
    for zone in ["", "GMT+8", "Asia/Unknown", " Asia/Shanghai"] {
        assert!(schedule("22:00", zone).validate().is_err());
    }
    for days in [vec![], vec![0], vec![8], vec![1, 1]] {
        let mut s = schedule("22:00", "UTC");
        s.weekdays = days;
        assert!(s.validate().is_err());
    }
    assert!(schedule("22:00", "Asia/Shanghai").validate().is_ok());
}
#[test]
fn zone_weekday_and_date_are_resolved_in_local_time() {
    let mut s = schedule("00:00", "Asia/Shanghai");
    s.weekdays = vec![2];
    let evidence = s
        .occurrence(NaiveDate::from_ymd_opt(2026, 11, 3).unwrap())
        .unwrap()
        .unwrap();
    assert_eq!(evidence.scheduled_at, at("2026-11-02T16:00:00Z"));
    assert_eq!(evidence.local_date, "2026-11-03");
    assert!(s
        .occurrence(NaiveDate::from_ymd_opt(2026, 11, 4).unwrap())
        .unwrap()
        .is_none());
    assert!(s.sample(at("2026-11-02T16:00:01Z")).unwrap().is_none());
}
#[test]
fn dst_gap_skips_and_fold_uses_first_occurrence_including_half_hour_transitions() {
    let s = schedule("02:30", "America/New_York");
    assert!(s
        .occurrence(NaiveDate::from_ymd_opt(2026, 3, 8).unwrap())
        .unwrap()
        .is_none());
    let s = schedule("01:30", "America/New_York");
    assert_eq!(
        s.occurrence(NaiveDate::from_ymd_opt(2026, 11, 1).unwrap())
            .unwrap()
            .unwrap()
            .scheduled_at,
        at("2026-11-01T05:30:00Z")
    );
    assert!(s.sample(at("2026-11-01T06:30:00Z")).unwrap().is_none());
    let s = schedule("01:45", "Australia/Lord_Howe");
    assert_eq!(
        s.occurrence(NaiveDate::from_ymd_opt(2026, 4, 5).unwrap())
            .unwrap()
            .unwrap()
            .scheduled_at,
        at("2026-04-04T14:45:00Z")
    );
    assert!(s.sample(at("2026-04-04T15:15:00Z")).unwrap().is_none());
    assert!(schedule("12:00", "Pacific/Apia")
        .occurrence(NaiveDate::from_ymd_opt(2011, 12, 30).unwrap())
        .unwrap()
        .is_none());
}
#[test]
fn schedule_creates_one_command_with_frozen_evidence_without_faking_device_heartbeat() {
    let mut data = ready();
    data.deploy_at(rule(), start()).unwrap();
    let heartbeat = data.devices["device-lamp"].last_seen;
    data.poll_schedules(due() + Duration::milliseconds(100))
        .unwrap();
    data.poll_schedules(due() + Duration::milliseconds(500))
        .unwrap();
    data.poll_schedules(due() + Duration::seconds(1)).unwrap();
    assert_eq!(data.commands.len(), 1);
    assert_eq!(data.runs.len(), 1);
    assert_eq!(data.devices["device-lamp"].last_seen, heartbeat);
    let run = data.runs.values().next().unwrap();
    assert_eq!(run.schedule_trigger.as_ref().unwrap().scheduled_at, due());
    assert_eq!(run.schedule_trigger.as_ref().unwrap().local_time, "22:00");
    assert!(run.error.is_none());
    assert!(run.property_trigger.is_none());
    data.validate_saved_schedules().unwrap();
}
#[test]
fn clock_rollback_and_same_rule_redeploy_do_not_rearm_an_occurrence() {
    let mut data = ready();
    data.deploy_at(rule(), start()).unwrap();
    data.poll_schedules(due()).unwrap();
    let cursor = data.deployments["bedtime"].schedule_cursor;
    data.poll_schedules(start()).unwrap();
    data.deploy_at(rule(), start()).unwrap();
    assert_eq!(data.deployments["bedtime"].schedule_cursor, cursor);
    data.poll_schedules(due()).unwrap();
    assert_eq!(data.runs.len(), 1);
}
#[test]
fn deployment_after_deadline_or_poll_gap_skips_instead_of_catching_up() {
    for deployment in [due(), start() - Duration::seconds(10)] {
        let mut data = ready();
        data.deploy_at(rule(), deployment).unwrap();
        data.poll_schedules(due() + Duration::seconds(1)).unwrap();
        data.poll_schedules(due() + Duration::seconds(2)).unwrap();
        assert!(data.commands.is_empty());
        assert!(data.runs.is_empty());
    }
}
#[test]
fn restart_and_broker_reconnect_skip_the_missed_occurrence() {
    for broker in [false, true] {
        let mut data = ready();
        data.deploy_at(rule(), start()).unwrap();
        if broker {
            data.mqtt_disconnected();
        } else {
            data.recover();
        }
        data.poll_schedules(due() + Duration::seconds(1)).unwrap();
        data.poll_schedules(due() + Duration::seconds(2)).unwrap();
        assert!(data.runs.is_empty());
    }
}
#[test]
fn offline_target_is_not_refreshed_and_failed_occurrence_is_not_retried() {
    let mut data = ready();
    data.devices.get_mut("device-lamp").unwrap().ready = false;
    data.deploy_at(rule(), start()).unwrap();
    data.poll_schedules(due()).unwrap();
    assert!(data.commands.is_empty());
    assert_eq!(data.runs.len(), 1);
    assert_eq!(
        data.runs.values().next().unwrap().error.as_deref(),
        Some("device_offline")
    );
    data.devices.get_mut("device-lamp").unwrap().ready = true;
    data.poll_schedules(due() + Duration::seconds(1)).unwrap();
    assert!(data.commands.is_empty());
}
#[test]
fn unmet_conditions_consume_the_occurrence_without_command_or_cooldown() {
    let mut data = ready();
    let mut candidate = rule();
    candidate.conditions = serde_json::from_value(
        json!([{"device":"device-lamp","property":"light.power","operator":"eq","value":false}]),
    )
    .unwrap();
    data.deploy_at(candidate, start()).unwrap();
    data.poll_schedules(due()).unwrap();
    let run = data.runs.values().next().unwrap();
    assert_eq!(run.error.as_deref(), Some("rule_conditions_not_met"));
    assert!(!run.condition_evaluation.as_ref().unwrap().matched);
    assert!(data.commands.is_empty());
    assert!(data.deployments["bedtime"].last_run.is_none());
    data.devices
        .get_mut("device-lamp")
        .unwrap()
        .reported
        .get_mut("light.power")
        .unwrap()
        .value = json!(false);
    data.poll_schedules(due() + Duration::seconds(1)).unwrap();
    assert_eq!(data.runs.len(), 1);
    assert!(data.commands.is_empty());
}
#[test]
fn simulation_validates_exact_occurrence_and_has_no_side_effect() {
    let data = ready();
    let before = serde_json::to_value(&data).unwrap();
    let good = data
        .simulate_rule(&rule(), &json!({"scheduled_at":due()}), start())
        .unwrap();
    assert_eq!(good["matched"], true);
    assert_eq!(good["executed"], false);
    assert_eq!(good["proposed_actions"].as_array().unwrap().len(), 1);
    let bad = data
        .simulate_rule(
            &rule(),
            &json!({"scheduled_at":due()+Duration::seconds(1)}),
            start(),
        )
        .unwrap();
    assert_eq!(bad["matched"], false);
    assert!(data
        .simulate_rule(
            &rule(),
            &json!({"scheduled_at":due(),"historical":false}),
            start()
        )
        .is_err());
    assert_eq!(serde_json::to_value(&data).unwrap(), before);
}
#[test]
fn corrupt_cursor_and_evidence_are_rejected_and_legacy_event_ids_remain_valid() {
    let mut data = ready();
    data.deploy_at(rule(), start()).unwrap();
    data.poll_schedules(due()).unwrap();
    let mut missing = data.clone();
    missing
        .deployments
        .get_mut("bedtime")
        .unwrap()
        .schedule_cursor = None;
    assert!(missing.validate_saved_schedules().is_err());
    let mut wrong = data.clone();
    wrong
        .runs
        .values_mut()
        .next()
        .unwrap()
        .schedule_trigger
        .as_mut()
        .unwrap()
        .local_date = "2026-11-04".into();
    assert!(wrong.validate_saved_schedules().is_err());
    data.runs.values_mut().next().unwrap().schedule_trigger = None;
    assert!(data.validate_saved_schedules().is_err());
    // 原设备事件ID没有新增保留前缀，不能把历史事件误判为定时资料。
    data.runs.values_mut().next().unwrap().rule_revision = "sha256:legacy-event-rule".into();
    data.validate_saved_schedules().unwrap();
}

#[test]
fn preview_uses_server_timezone_resolution_and_skips_the_second_fold() {
    let s = schedule("22:00", "Asia/Shanghai");
    assert_eq!(s.next_after(start()).unwrap().scheduled_at, due());
    assert_eq!(
        s.next_after(due()).unwrap().scheduled_at,
        due() + Duration::days(1)
    );
    let s = schedule("01:30", "America/New_York");
    assert_eq!(
        s.next_after(at("2026-11-01T05:30:00Z"))
            .unwrap()
            .scheduled_at,
        at("2026-11-02T06:30:00Z")
    );
    let s = schedule("02:30", "America/New_York");
    assert_eq!(
        s.next_after(at("2026-03-08T05:00:00Z"))
            .unwrap()
            .scheduled_at,
        at("2026-03-09T06:30:00Z")
    );
}
