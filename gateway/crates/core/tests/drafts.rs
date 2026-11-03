use chrono::{Duration, Utc};
use limeiot_core::{
    draft::{DraftRequest, DraftStatus},
    engine::{Config, Data},
    protocol::Rule,
};

fn data() -> Data {
    Data::new(
        serde_json::from_str::<Config>(include_str!("../../../../deploy/dev/config.json")).unwrap(),
    )
    .unwrap()
}
fn request() -> DraftRequest {
    DraftRequest {
        space_id: "space-demo".into(),
        idempotency_key: "draft-original".into(),
        prompt: "按下按钮时打开灯".into(),
        expires_at: Utc::now() + Duration::seconds(100),
    }
}
fn rule(id: &str) -> Rule {
    let mut rule: Rule = serde_json::from_str(include_str!(
        "../../../../contracts/examples/button-light.json"
    ))
    .unwrap();
    rule.id = format!("ai-{id}");
    rule
}
#[test]
fn drafts_are_idempotent_validated_and_never_deploy_or_execute() {
    let mut data = data();
    let input = request();
    let now = Utc::now();
    let first = data
        .create_draft(input.clone(), "local-model", now)
        .unwrap();
    assert_eq!(
        data.create_draft(input.clone(), "changed-model", now)
            .unwrap()
            .draft_id,
        first.draft_id
    );
    let mut conflict = input;
    conflict.prompt = "关闭灯".into();
    assert_eq!(
        data.create_draft(conflict, "local-model", now)
            .unwrap_err()
            .code,
        "idempotency_conflict"
    );
    let finished = data
        .finish_draft(&first.draft_id, Ok(rule(&first.draft_id)), None, now)
        .unwrap();
    assert_eq!(finished.status, DraftStatus::Completed);
    assert!(data.deployments.is_empty() && data.commands.is_empty());
    let mut input = request();
    input.idempotency_key = "invalid-output".into();
    let second = data.create_draft(input, "local-model", now).unwrap();
    let mut invalid = rule(&second.draft_id);
    match &mut invalid.actions[0] {
        limeiot_core::protocol::Action::Set { device, .. }
        | limeiot_core::protocol::Action::Invoke { device, .. } => {
            *device = "other-space-device".into()
        }
    }
    let rejected = data
        .finish_draft(&second.draft_id, Ok(invalid), None, now)
        .unwrap();
    assert_eq!(rejected.status, DraftStatus::Rejected);
    assert!(rejected.rule.is_none());
    assert!(data.deployments.is_empty() && data.commands.is_empty());
}
#[test]
fn interrupted_inference_recovers_unknown_without_replay_and_late_output_expires() {
    let mut data = data();
    let input = request();
    let now = Utc::now();
    let first = data
        .create_draft(input.clone(), "local-model", now)
        .unwrap();
    data.recover();
    let recovered = data.create_draft(input, "local-model", now).unwrap();
    assert_eq!(recovered.draft_id, first.draft_id);
    assert_eq!(recovered.status, DraftStatus::Unknown);
    let mut input = request();
    input.idempotency_key = "expired-output".into();
    let end = input.expires_at;
    let second = data.create_draft(input, "local-model", now).unwrap();
    assert_eq!(
        data.finish_draft(&second.draft_id, Ok(rule(&second.draft_id)), None, end)
            .unwrap()
            .status,
        DraftStatus::Expired
    );
}
#[test]
fn context_changes_reject_inference_output() {
    let mut data = data();
    let now = Utc::now();
    let first = data.create_draft(request(), "local-model", now).unwrap();
    data.devices.remove("device-button");
    let result = data
        .finish_draft(&first.draft_id, Ok(rule(&first.draft_id)), None, now)
        .unwrap();
    assert_eq!(result.error.as_deref(), Some("inference_context_changed"));
    assert!(result.rule.is_none());
}

#[test]
fn provider_uncertainty_at_deadline_stays_unknown() {
    for code in ["inference_unknown", "inference_timeout"] {
        let mut data = data();
        let input = request();
        let end = input.expires_at;
        let draft = data.create_draft(input, "local-model", Utc::now()).unwrap();
        let finished = data
            .finish_draft(&draft.draft_id, Err(limeiot_core::err(code)), None, end)
            .unwrap();
        assert_eq!(finished.status, DraftStatus::Unknown);
        assert_eq!(finished.error.as_deref(), Some(code));
        assert!(finished.rule.is_none());
        assert!(data.deployments.is_empty() && data.commands.is_empty());
    }
}
