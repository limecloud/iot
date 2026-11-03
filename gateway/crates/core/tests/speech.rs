use chrono::{Duration, TimeZone, Utc};
use limeiot_core::{
    media::State,
    speech::{Deployment, Input, Status, Task},
};

fn input() -> Input {
    Input {
        text: "你好，青柠。".into(),
        voice: "zh_female".into(),
        retain_seconds: 600,
        expires_at: Utc.with_ymd_and_hms(2026, 11, 3, 12, 0, 30).unwrap(),
    }
}
fn deployment() -> Deployment {
    Deployment {
        adapter: "local-http-speech-v1".into(),
        revision: format!("sha256:{}", "a".repeat(64)),
        model: "local/model-v1".into(),
        data_location: "local".into(),
    }
}
#[test]
fn bounded_input_and_canonical_request() {
    let i = input();
    i.validate().unwrap();
    let same: Input = serde_json::from_value(serde_json::json!({"text":i.text,"voice":i.voice,"retain_seconds":600,"expires_at":"2026-11-03T20:00:30+08:00"})).unwrap();
    assert_eq!(
        i.request_digest("space", "key").unwrap(),
        same.request_digest("space", "key").unwrap()
    );
    let mut changed = i.clone();
    changed.text.push('!');
    assert_ne!(
        i.request_digest("space", "key").unwrap(),
        changed.request_digest("space", "key").unwrap()
    );
    for text in [" ".to_string(), "a".repeat(1001), "\0hello".to_string()] {
        let mut bad = i.clone();
        bad.text = text;
        assert!(bad.validate().is_err());
    }
    let mut fractional = i;
    fractional.expires_at += Duration::nanoseconds(1);
    assert!(fractional.validate().is_err());
}
#[test]
fn snapshots_preserve_summaries_and_reject_forged_outcomes() {
    let i = input();
    let now = i.expires_at - Duration::seconds(30);
    let task = Task::new("space", "key", &i, deployment(), now).unwrap();
    task.validate("space", now).unwrap();
    let raw = serde_json::to_string(&task).unwrap();
    assert!(!raw.contains(&i.text));
    let mut state = State::new("space".into(), now);
    state.speech.insert("key".into(), task.clone());
    assert!(state.validate().is_err());
    state.schema_version = 2;
    state.validate().unwrap();
    let mut corrupted = task;
    corrupted.status = Status::Succeeded;
    assert!(corrupted.validate("space", now).is_err());
    corrupted.status = Status::Unknown;
    corrupted.error_code = Some("speech_interrupted".into());
    corrupted.validate("space", now).unwrap();
    corrupted.error_code = Some("anything".into());
    assert!(corrupted.validate("space", now).is_err());
    state.speech.clear();
    state.schema_version = 1;
    let old = serde_json::to_string(&state).unwrap();
    assert!(!old.contains("speech"));
    serde_json::from_str::<State>(&old)
        .unwrap()
        .validate()
        .unwrap();
}
