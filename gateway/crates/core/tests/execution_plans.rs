use chrono::{DateTime, Duration, Utc};
use limeiot_core::{
    digest,
    engine::{Config, Data},
    execution_plans::{parse_change, Change, Completion, Request, Stage, Step},
    model::Model,
    protocol::{CommandRequest, Envelope},
};
use serde_json::{json, Value};

fn now() -> DateTime<Utc> {
    "2026-11-03T00:00:00Z".parse().unwrap()
}
fn message(data: &Data, device: &str, kind: &str, body: Value) -> Envelope {
    let state = &data.devices[device];
    let seq = state.last_seq + 1;
    serde_json::from_value(json!({"v":1,"kind":kind,"message_id":format!("{device}-{seq}"),
        "device_id":device,"model_revision":state.model_revision,"boot_id":state.boot_id.as_deref().unwrap_or("boot-initial"),
        "session_id":state.session_id,"seq":seq,"body":body})).unwrap()
}
fn ready() -> Data {
    let model: Model = serde_json::from_slice(include_bytes!(
        "../../../../contracts/models/gootuan-show-simulator-v2.json"
    ))
    .unwrap();
    model.validate().unwrap();
    let revision = digest(&model).unwrap();
    let config: Config = serde_json::from_value(json!({"space_id":"home","models":[model],"devices":[
        {"device_id":"alpha","model_revision":revision},{"device_id":"beta","model_revision":revision}]})).unwrap();
    let mut data = Data::new(config).unwrap();
    for device in ["alpha", "beta"] {
        let hello = message(&data, device, "hello", json!({"challenge":"challenge"}));
        data.ingest(hello, now()).unwrap();
        let state = message(
            &data,
            device,
            "state",
            json!({"type":"snapshot","revision":1,"properties":[
            {"path":"light.level","value":0,"observed_at":now(),"quality":"confirmed","source":"simulator"}]}),
        );
        data.ingest(state, now()).unwrap();
    }
    data
}
fn light(data: &Data, device: &str, step_id: &str) -> Step {
    serde_json::from_value(json!({"step_id":step_id,"device_id":device,"model_revision":data.devices[device].model_revision,
        "operation":{"type":"property.set","path":"light.level","value":37},"command_timeout_ms":5000,
        "completion":{"type":"command"}})).unwrap()
}
fn show(data: &Data, device: &str, step_id: &str) -> Step {
    serde_json::from_value(json!({"step_id":step_id,"device_id":device,"model_revision":data.devices[device].model_revision,
        "operation":{"type":"action.invoke","path":"show.run","value":{"task_id":"play","generation":"gen-1","step_id":step_id,"duration_ms":1000}},
        "command_timeout_ms":5000,"completion":{"type":"event","path":"show.finished","timeout_ms":120000}})).unwrap()
}
fn apply(data: &mut Data, key: &str, change: Change) -> limeiot_core::execution_plans::Operation {
    data.apply_plan_change(
        Request {
            space_id: "home".into(),
            idempotency_key: key.into(),
            change,
        },
        now(),
    )
    .unwrap()
}
fn create(data: &mut Data, stages: Vec<Stage>) {
    let operation = apply(
        data,
        "create",
        Change::Create {
            plan_id: "play".into(),
            generation: "gen-1".into(),
            stages,
            expires_at: now() + Duration::minutes(10),
        },
    );
    assert_eq!(operation.status, "applied", "{:?}", operation.reason);
}
fn start(data: &mut Data) {
    let expected_revision = data.execution_plan("play").unwrap().revision.clone();
    assert_eq!(
        apply(
            data,
            "start",
            Change::Start {
                plan_id: "play".into(),
                expected_revision
            }
        )
        .status,
        "applied"
    );
}
fn result(data: &mut Data, command_id: &str, status: &str, time: DateTime<Utc>) {
    let command = data.commands[command_id].clone();
    let evidence = if command.request.operation.kind == "action.invoke" {
        json!({"type":"action_result","path":command.request.operation.path,
            "input_digest":digest(&command.request.operation.value).unwrap(),"output":{},"completion":"submitted","observed_at":time})
    } else {
        json!({"type":"device_result","reported":{command.request.operation.path:command.request.operation.value}})
    };
    let envelope = message(
        data,
        &command.request.device_id,
        "result",
        json!({"command_id":command_id,"status":status,"evidence":evidence,"error":"fixture_failure"}),
    );
    data.ingest(envelope, time).unwrap();
}
fn event(
    data: &mut Data,
    device: &str,
    id: &str,
    step_id: &str,
    generation: &str,
    occurred: DateTime<Utc>,
    received: DateTime<Utc>,
) {
    let envelope = message(
        data,
        device,
        "event",
        json!({"event_id":id,"path":"show.finished","occurred_at":occurred,
        "historical":false,"data":{"task_id":"play","generation":generation,"step_id":step_id,"status":"completed"}}),
    );
    let projection = data
        .ingest_with_event_projection(envelope, received)
        .unwrap();
    if let Some(event) = projection.event {
        data.observe_execution_plan_event(&event, received).unwrap();
    }
}
fn public_command(data: &Data) -> CommandRequest {
    serde_json::from_value(json!({"space_id":"home","device_id":"alpha","model_revision":data.devices["alpha"].model_revision,
        "idempotency_key":"manual","expires_at":now()+Duration::seconds(5),"operation":{"type":"property.set","path":"light.level","value":2}})).unwrap()
}

#[test]
fn two_device_stage_barrier_uses_original_commands_and_requires_explicit_release() {
    let mut data = ready();
    let first = Stage {
        steps: vec![light(&data, "alpha", "a1"), light(&data, "beta", "b1")],
    };
    let second = Stage {
        steps: vec![light(&data, "alpha", "a2")],
    };
    create(&mut data, vec![first, second]);
    assert!(data.commands.is_empty());
    start(&mut data);
    assert!(data.commands.is_empty());
    data.poll_execution_plans(now()).unwrap();
    assert_eq!(data.commands.len(), 2);
    let sent = data.prepare_dispatch(now());
    assert_eq!(sent.len(), 2);
    let a = data.execution_plan("play").unwrap().children[0]
        .command_id
        .clone();
    let b = data.execution_plan("play").unwrap().children[1]
        .command_id
        .clone();
    result(&mut data, &a, "confirmed", now());
    data.poll_execution_plans(now()).unwrap();
    assert_eq!(data.commands.len(), 2);
    result(&mut data, &b, "confirmed", now());
    data.poll_execution_plans(now()).unwrap();
    assert_eq!(data.commands.len(), 3);
    assert_eq!(data.prepare_dispatch(now()).len(), 1);
    let c = data.execution_plan("play").unwrap().children[2]
        .command_id
        .clone();
    result(&mut data, &c, "confirmed", now());
    data.poll_execution_plans(now()).unwrap();
    let plan = data.execution_plan("play").unwrap();
    assert_eq!(plan.status, "completed");
    assert_eq!(plan.current_stage, 2);
    assert!(data.execution_plan_reserves_device("alpha"));
    let revision = plan.revision.clone();
    assert_eq!(
        apply(
            &mut data,
            "release",
            Change::Release {
                plan_id: "play".into(),
                expected_revision: revision
            }
        )
        .status,
        "applied"
    );
    assert!(!data.execution_plan_reserves_device("alpha"));
    data.validate_execution_plan_registry().unwrap();
}

#[test]
fn submitted_is_not_task_completion_and_correlated_event_is_required() {
    let mut data = ready();
    let stage = Stage {
        steps: vec![show(&data, "alpha", "a1")],
    };
    create(&mut data, vec![stage]);
    start(&mut data);
    data.poll_execution_plans(now()).unwrap();
    data.prepare_dispatch(now());
    let child = data.execution_plan("play").unwrap().children[0]
        .command_id
        .clone();
    result(&mut data, &child, "confirmed", now());
    data.poll_execution_plans(now()).unwrap();
    assert_eq!(data.execution_plan("play").unwrap().status, "running");
    event(
        &mut data,
        "alpha",
        "old-generation",
        "a1",
        "old",
        now(),
        now(),
    );
    event(
        &mut data,
        "beta",
        "wrong-device",
        "a1",
        "gen-1",
        now(),
        now(),
    );
    event(
        &mut data,
        "alpha",
        "wrong-step",
        "old-step",
        "gen-1",
        now(),
        now(),
    );
    assert!(data.execution_plan("play").unwrap().children[0]
        .event
        .is_none());
    event(&mut data, "alpha", "done", "a1", "gen-1", now(), now());
    data.poll_execution_plans(now()).unwrap();
    assert_eq!(data.execution_plan("play").unwrap().status, "completed");
    data.validate_execution_plan_registry().unwrap();
}

#[test]
fn cancel_before_dispatch_rejects_original_children_and_never_issues_later_stage() {
    let mut data = ready();
    let stages = vec![
        Stage {
            steps: vec![light(&data, "alpha", "a1")],
        },
        Stage {
            steps: vec![light(&data, "beta", "b2")],
        },
    ];
    create(&mut data, stages);
    start(&mut data);
    data.poll_execution_plans(now()).unwrap();
    let revision = data.execution_plan("play").unwrap().revision.clone();
    let operation = apply(
        &mut data,
        "cancel",
        Change::Cancel {
            plan_id: "play".into(),
            expected_revision: revision,
        },
    );
    assert_eq!(operation.status, "applied");
    assert_eq!(data.execution_plan("play").unwrap().status, "cancelled");
    assert_eq!(data.commands.len(), 1);
    assert!(data.commands.values().all(|c| c.status == "rejected"));
    assert!(data.prepare_dispatch(now()).is_empty());
    data.poll_execution_plans(now()).unwrap();
    assert_eq!(data.commands.len(), 1);
    data.validate_execution_plan_registry().unwrap();
}

#[test]
fn cancel_dispatched_preserves_effect_uncertainty_and_late_event_cannot_revive() {
    let mut data = ready();
    let stage = Stage {
        steps: vec![show(&data, "alpha", "a1")],
    };
    create(&mut data, vec![stage]);
    start(&mut data);
    data.poll_execution_plans(now()).unwrap();
    data.prepare_dispatch(now());
    let child = data.execution_plan("play").unwrap().children[0]
        .command_id
        .clone();
    let revision = data.execution_plan("play").unwrap().revision.clone();
    apply(
        &mut data,
        "cancel",
        Change::Cancel {
            plan_id: "play".into(),
            expected_revision: revision,
        },
    );
    assert_eq!(data.commands[&child].status, "dispatched");
    assert_eq!(
        data.execution_plan("play").unwrap().physical_stop,
        "unknown"
    );
    result(&mut data, &child, "confirmed", now());
    event(&mut data, "alpha", "late", "a1", "gen-1", now(), now());
    data.poll_execution_plans(now()).unwrap();
    assert_eq!(data.execution_plan("play").unwrap().status, "unknown");
    assert!(data.execution_plan("play").unwrap().children[0]
        .event
        .is_none());
    data.validate_execution_plan_registry().unwrap();
}

#[test]
fn restart_never_replays_or_advances_running_plan() {
    let mut data = ready();
    let stage = Stage {
        steps: vec![light(&data, "alpha", "a1")],
    };
    create(&mut data, vec![stage]);
    start(&mut data);
    data.poll_execution_plans(now()).unwrap();
    data.prepare_dispatch(now());
    let encoded = serde_json::to_vec(&data).unwrap();
    let mut restored: Data = serde_json::from_slice(&encoded).unwrap();
    restored.validate_execution_plan_registry().unwrap();
    restored.recover();
    assert_eq!(restored.execution_plan("play").unwrap().status, "unknown");
    assert!(restored.prepare_dispatch(now()).is_empty());
    restored.poll_execution_plans(now()).unwrap();
    assert_eq!(restored.commands.len(), 1);
    restored.validate_execution_plan_registry().unwrap();
}

#[test]
fn original_decision_is_recovered_by_key_and_changed_requests_conflict() {
    let mut data = ready();
    let stage = Stage {
        steps: vec![light(&data, "alpha", "a1")],
    };
    create(&mut data, vec![stage]);
    let original = data.execution_plan_operation("create").unwrap().clone();
    start(&mut data);
    assert_eq!(
        digest(
            &data
                .apply_plan_change(original.request.clone(), now() + Duration::hours(1))
                .unwrap()
        )
        .unwrap(),
        digest(&original).unwrap()
    );
    let mut changed = original.request;
    changed.space_id = "other".into();
    assert_eq!(
        data.apply_plan_change(changed, now()).unwrap_err().code,
        "forbidden"
    );
    let mut changed = data
        .execution_plan_operation("create")
        .unwrap()
        .request
        .clone();
    if let Change::Create { generation, .. } = &mut changed.change {
        *generation = "different".into();
    }
    assert_eq!(
        data.apply_plan_change(changed, now()).unwrap_err().code,
        "idempotency_conflict"
    );
    let revision = data.execution_plan("play").unwrap().revision.clone();
    assert_eq!(
        apply(
            &mut data,
            "bad-revision",
            Change::Cancel {
                plan_id: "play".into(),
                expected_revision: format!("sha256:{}", "0".repeat(64))
            }
        )
        .status,
        "conflict"
    );
    assert_eq!(data.execution_plan("play").unwrap().revision, revision);
    data.validate_execution_plan_registry().unwrap();
}

#[test]
fn native_binding_change_refuses_admission_and_reserved_command_cannot_spoof_run_id() {
    let mut data = ready();
    let stage = Stage {
        steps: vec![light(&data, "alpha", "a1")],
    };
    create(&mut data, vec![stage]);
    start(&mut data);
    let command = public_command(&data);
    assert_eq!(
        data.create_command(command.clone(), now(), None)
            .unwrap_err()
            .code,
        "execution_plan_conflict"
    );
    assert_eq!(
        data.create_command(command, now(), Some("play".into()))
            .unwrap_err()
            .code,
        "plan_command_not_authorized"
    );
    data.devices.get_mut("alpha").unwrap().session_id = Some("other-session".into());
    data.poll_execution_plans(now()).unwrap();
    assert!(data.commands.is_empty());
    assert_eq!(data.execution_plan("play").unwrap().status, "failed");
    data.validate_execution_plan_registry().unwrap();
}

#[test]
fn one_failed_performer_ends_stage_as_partial_and_blocks_next_stage() {
    let mut data = ready();
    let stages = vec![
        Stage {
            steps: vec![light(&data, "alpha", "a1"), light(&data, "beta", "b1")],
        },
        Stage {
            steps: vec![light(&data, "alpha", "a2")],
        },
    ];
    create(&mut data, stages);
    start(&mut data);
    data.poll_execution_plans(now()).unwrap();
    data.prepare_dispatch(now());
    let children = data.execution_plan("play").unwrap().children.clone();
    result(&mut data, &children[0].command_id, "confirmed", now());
    result(&mut data, &children[1].command_id, "failed", now());
    data.poll_execution_plans(now()).unwrap();
    assert_eq!(data.execution_plan("play").unwrap().status, "partial");
    assert_eq!(data.commands.len(), 2);
    data.validate_execution_plan_registry().unwrap();
}

#[test]
fn whole_stage_admission_rolls_back_when_second_device_queue_is_full() {
    let mut data = ready();
    let stage = Stage {
        steps: vec![light(&data, "alpha", "a1"), light(&data, "beta", "b1")],
    };
    create(&mut data, vec![stage]);
    start(&mut data);
    // 另一受理者的持久容量占位模拟；直接造测试数据，生产API受reservation阻止。
    let template = public_command(&data);
    let mut scratch = ready();
    let original = scratch.create_command(template, now(), None).unwrap();
    for i in 0..32 {
        let mut c = original.clone();
        c.command_id = format!("block-{i}");
        c.request.device_id = "beta".into();
        data.commands.insert(c.command_id.clone(), c);
    }
    data.poll_execution_plans(now()).unwrap();
    assert_eq!(data.commands.len(), 32);
    assert!(data.execution_plan("play").unwrap().children.is_empty());
    assert_eq!(
        data.execution_plan("play").unwrap().reason.as_deref(),
        Some("device_queue_full")
    );
    assert!(!data
        .commands
        .values()
        .any(|c| c.run_id.as_deref() == Some("play")));
}

#[test]
fn definition_bounds_and_submitted_without_event_are_rejected_without_effects() {
    let mut data = ready();
    let mut step = show(&data, "alpha", "a1");
    step.completion = Completion::Command;
    let operation = apply(
        &mut data,
        "bad-submitted",
        Change::Create {
            plan_id: "play".into(),
            generation: "gen-1".into(),
            stages: vec![Stage { steps: vec![step] }],
            expires_at: now() + Duration::minutes(1),
        },
    );
    assert_eq!(
        operation.reason.as_deref(),
        Some("plan_task_event_required")
    );
    let step = light(&data, "alpha", "a1");
    let operation = apply(
        &mut data,
        "duplicate",
        Change::Create {
            plan_id: "play".into(),
            generation: "gen-1".into(),
            stages: vec![Stage {
                steps: vec![step.clone(), step],
            }],
            expires_at: now() + Duration::minutes(1),
        },
    );
    assert_eq!(operation.status, "rejected");
    let step = light(&data, "alpha", "a1");
    let operation = apply(
        &mut data,
        "long",
        Change::Create {
            plan_id: "play".into(),
            generation: "gen-1".into(),
            stages: vec![Stage { steps: vec![step] }],
            expires_at: now() + Duration::minutes(16),
        },
    );
    assert_eq!(operation.reason.as_deref(), Some("invalid_plan_expiry"));
    assert!(data.commands.is_empty());
    assert!(data.execution_plans.plans.is_empty());
    data.validate_execution_plan_registry().unwrap();
}

#[test]
fn expired_child_is_not_reissued_and_event_before_issue_does_not_complete() {
    let mut data = ready();
    let stage = Stage {
        steps: vec![show(&data, "alpha", "a1")],
    };
    create(&mut data, vec![stage]);
    start(&mut data);
    data.poll_execution_plans(now()).unwrap();
    data.prepare_dispatch(now());
    let child = data.execution_plan("play").unwrap().children[0]
        .command_id
        .clone();
    result(&mut data, &child, "confirmed", now());
    event(
        &mut data,
        "alpha",
        "before",
        "a1",
        "gen-1",
        now() - Duration::milliseconds(1),
        now(),
    );
    assert!(data.execution_plan("play").unwrap().children[0]
        .event
        .is_none());
    // 模拟持续心跳以单独测任务事件期限，而非15秒连接时效。
    for device in data.devices.values_mut() {
        device.last_seen = Some(now() + Duration::minutes(2));
    }
    data.poll_execution_plans(now() + Duration::minutes(2))
        .unwrap();
    assert_eq!(data.execution_plan("play").unwrap().status, "unknown");
    assert_eq!(
        data.execution_plan("play").unwrap().reason.as_deref(),
        Some("plan_event_timeout")
    );
    assert_eq!(data.commands.len(), 1);
    data.validate_execution_plan_registry().unwrap();
}

#[test]
fn durable_validation_rejects_rehashed_forged_progress_binding_and_original_decision() {
    let mut data = ready();
    let stage = Stage {
        steps: vec![light(&data, "alpha", "a1")],
    };
    create(&mut data, vec![stage]);
    start(&mut data);
    data.poll_execution_plans(now()).unwrap();
    data.validate_execution_plan_registry().unwrap();
    let value = serde_json::to_value(&data).unwrap();
    for mode in ["progress", "binding", "operation", "child"] {
        let mut corrupt = value.clone();
        let plan = &mut corrupt["execution_plans"]["plans"]["play"];
        match mode {
            "progress" => {
                plan["status"] = json!("completed");
                plan["current_stage"] = json!(1);
                plan["ended_at"] = json!(now());
            }
            "binding" => plan["bindings"]["alpha"]["session_id"] = json!("forged"),
            "child" => plan["children"][0]["command_id"] = json!("missing"),
            "operation" => {}
            _ => unreachable!(),
        }
        let mut projected = plan.clone();
        projected.as_object_mut().unwrap().remove("revision");
        plan["revision"] = json!(digest(&projected).unwrap());
        if mode == "operation" {
            corrupt["execution_plans"]["operations"]["create"]["request_digest"] =
                json!("sha256:bad");
        }
        let restored: Data = serde_json::from_value(corrupt).unwrap();
        assert!(
            restored.validate_execution_plan_registry().is_err(),
            "accepted {mode}"
        );
    }
}

#[test]
fn duplicate_keys_unknown_fields_and_missing_required_fields_fail_parse() {
    for raw in [
        br#"{"type":"plans.start","plan_id":"p","plan_id":"q","expected_revision":"x"}"#.as_slice(),
        br#"{"type":"plans.start","plan_id":"p"}"#,
        br#"{"type":"plans.cancel","plan_id":"p","expected_revision":"x","force":true}"#,
    ] {
        assert!(parse_change(raw).is_err());
    }
}

#[test]
fn lexical_event_times_preserve_body_proof_and_tampered_payload_is_rejected() {
    for literal in ["2026-11-03T00:00:00.000Z", "2026-11-03T08:00:00+08:00"] {
        let mut data = ready();
        let stage = Stage {
            steps: vec![show(&data, "alpha", "a1")],
        };
        create(&mut data, vec![stage]);
        start(&mut data);
        data.poll_execution_plans(now()).unwrap();
        data.prepare_dispatch(now());
        let child = data.execution_plan("play").unwrap().children[0]
            .command_id
            .clone();
        result(&mut data, &child, "confirmed", now());
        let envelope = message(
            &data,
            "alpha",
            "event",
            json!({"event_id":"lexical-done",
            "path":"show.finished","occurred_at":literal,"historical":false,
            "data":{"task_id":"play","generation":"gen-1","step_id":"a1","status":"completed"}}),
        );
        let accepted = data.ingest_with_event_projection(envelope, now()).unwrap();
        let event = accepted.event.unwrap();
        assert_eq!(event.occurred_at, literal);
        data.observe_execution_plan_event(&event, now()).unwrap();
        data.poll_execution_plans(now()).unwrap();
        assert_eq!(
            data.execution_plan("play").unwrap().status,
            "completed",
            "{literal}"
        );
        data.validate_execution_plan_registry().unwrap();
        let mut corrupt = serde_json::to_value(&data).unwrap();
        let plan = &mut corrupt["execution_plans"]["plans"]["play"];
        plan["children"][0]["event"]["data"]["status"] = json!("failed");
        let mut content = plan.clone();
        content.as_object_mut().unwrap().remove("revision");
        plan["revision"] = json!(digest(&content).unwrap());
        let restored: Data = serde_json::from_value(corrupt).unwrap();
        assert!(restored.validate_execution_plan_registry().is_err());
    }
}
