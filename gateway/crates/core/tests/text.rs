use chrono::{Duration, SubsecRound, Utc};
use limeiot_core::{
    media::State,
    model_job::{Deployment, Status},
    text::{Input, Message, Output, Request, Role, Task, Usage},
};
fn request() -> Request {
    Request {
        instructions: "用简短中文回答。".into(),
        messages: vec![
            Message {
                role: Role::User,
                content: "我喜欢积木".into(),
            },
            Message {
                role: Role::Assistant,
                content: "你喜欢搭什么？".into(),
            },
            Message {
                role: Role::User,
                content: "我刚才说喜欢什么？".into(),
            },
        ],
        retain_seconds: 60,
        expires_at: Utc::now().round_subsecs(3) + Duration::seconds(60),
    }
}
fn task() -> Task {
    let now = Utc::now().round_subsecs(3);
    let mut r = request();
    r.expires_at = now + Duration::seconds(60);
    Task::new(
        "home",
        "original",
        r.input().unwrap(),
        Deployment {
            adapter: "ollama-text-v1".into(),
            revision: format!("sha256:{}", "a".repeat(64)),
            model: "fixture:text".into(),
            data_location: "local".into(),
        },
        now,
    )
    .unwrap()
}
#[test]
fn text_context_is_explicit_alternating_bounded_and_digest_only() {
    let good = request();
    let input = good.input().unwrap();
    assert_eq!(input.message_count, 3);
    assert!(!serde_json::to_string(&input).unwrap().contains("积木"));
    for mutate in [
        |r: &mut Request| r.messages.clear(),
        |r: &mut Request| {
            r.messages.pop();
        },
        |r: &mut Request| r.messages[0].role = Role::Assistant,
        |r: &mut Request| r.messages[1].role = Role::User,
        |r: &mut Request| r.messages[0].content = " ".into(),
        |r: &mut Request| r.messages[0].content = "坏\0字节".into(),
        |r: &mut Request| r.instructions = "x".repeat(1025),
        |r: &mut Request| r.messages[0].content = "字".repeat(2049),
        |r: &mut Request| r.retain_seconds = 3601,
    ] {
        let mut bad = request();
        mutate(&mut bad);
        assert!(bad.input().is_err());
    }
    let mut edge = request();
    edge.instructions = "x".repeat(1024);
    edge.messages = (0..7)
        .map(|i| Message {
            role: if i % 2 == 0 {
                Role::User
            } else {
                Role::Assistant
            },
            content: "a".repeat(1024),
        })
        .collect();
    assert_eq!(edge.input().unwrap().context_bytes, 8192);
    edge.messages[0].content.push('a');
    assert!(edge.input().is_err());
    let mut bad = serde_json::to_value(&good).unwrap();
    bad["messages"][0]["role"] = "system".into();
    assert!(serde_json::from_value::<Request>(bad).is_err());
    let original = input.request_digest("home", "original").unwrap();
    let mut changed = good;
    changed.messages[0].content.push('!');
    assert_ne!(
        changed
            .input()
            .unwrap()
            .request_digest("home", "original")
            .unwrap(),
        original
    );
}
#[test]
fn text_task_rejects_inconsistent_status_usage_digest_and_deadline() {
    let task = task();
    task.validate("home", task.created_at).unwrap();
    assert!(task.validate("other", task.created_at).is_err());
    let mut bad = task.clone();
    bad.usage = Some(Usage {
        input_tokens: 1,
        output_tokens: 1,
    });
    assert!(bad.validate("home", bad.created_at).is_err());
    let mut bad = task.clone();
    bad.input.context_digest = format!("sha256:{}", "b".repeat(64));
    assert!(bad.validate("home", bad.created_at).is_err());
    let mut bad = task.clone();
    bad.status = Status::Unknown;
    bad.error_code = Some("other_error".into());
    assert!(bad.validate("home", bad.created_at).is_err());
    let mut bad: Input = task.input.clone();
    bad.expires_at = task.created_at + Duration::seconds(91);
    assert!(Task::new(
        "home",
        "other",
        bad,
        task.deployment.clone(),
        task.created_at
    )
    .is_err());
    let mut succeeded = task;
    succeeded.status = Status::Succeeded;
    succeeded.updated_at += Duration::seconds(1);
    succeeded.usage = Some(Usage {
        input_tokens: 10,
        output_tokens: 8,
    });
    succeeded.output = Some(Output {
        text: Some("你喜欢积木。".into()),
        content_digest: limeiot_core::media::content_digest("你喜欢积木。".as_bytes()),
        expires_at: succeeded.updated_at + Duration::seconds(60),
        cleared_at: None,
    });
    succeeded.validate("home", succeeded.updated_at).unwrap();
    let mut bad = succeeded.clone();
    bad.usage.as_mut().unwrap().output_tokens = 1025;
    assert!(bad.validate("home", bad.updated_at).is_err());
    let mut state = State::new("home".into(), succeeded.updated_at);
    state.schema_version = 5;
    state.texts.insert("original".into(), succeeded.clone());
    state.validate().unwrap();
    let now = succeeded.updated_at + Duration::seconds(60);
    assert!(state.prune(now));
    state.saved_at = now;
    state.validate().unwrap();
    assert_eq!(state.texts["original"].output.as_ref().unwrap().text, None);
    for old in 1..=4 {
        state.schema_version = old;
        assert!(state.validate().is_err());
    }
    state.schema_version = 5;
    state.texts.clear();
    assert!(state.validate().is_err());
}
