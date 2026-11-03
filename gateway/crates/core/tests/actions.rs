use chrono::{DateTime, Duration, Utc};
use limeiot_core::{
    compatibility::compare_documents,
    digest,
    engine::{Config, Data},
    model::Model,
    protocol::{Action, CommandRequest, Envelope, Rule},
    validation::validate_document,
};
use serde_json::{json, Value};

fn now() -> DateTime<Utc> {
    "2026-11-02T00:00:00Z".parse().unwrap()
}
fn model() -> Value {
    serde_json::from_slice(include_bytes!(
        "../../../../contracts/models/android-tv.json"
    ))
    .unwrap()
}
fn message(data: &Data, kind: &str, seq: u64, body: Value) -> Envelope {
    serde_json::from_value(
        json!({"v":1,"kind":kind,"message_id":format!("message-{seq}"),
        "device_id":"tv","model_revision":data.devices["tv"].model_revision,
        "boot_id":"boot-tv","session_id":data.devices["tv"].session_id,"seq":seq,"body":body}),
    )
    .unwrap()
}
fn ready() -> Data {
    let model: Model = serde_json::from_value(model()).unwrap();
    let demo: Value =
        serde_json::from_str(include_str!("../../../../deploy/dev/config.json")).unwrap();
    let mut data = Data::new(
        serde_json::from_value::<Config>(json!({"space_id":"home",
        "devices":[{"device_id":"tv","model_revision":digest(&model).unwrap()},demo["devices"][1]],"models":[model,demo["models"][1]]}))
        .unwrap(),
    )
    .unwrap();
    let hello = message(&data, "hello", 1, json!({"challenge":"tv-challenge"}));
    data.ingest(hello, now()).unwrap();
    let state = message(
        &data,
        "state",
        2,
        json!({"type":"snapshot","revision":1,"properties":[
        {"path":"audio.volume","value":20,"observed_at":now(),"quality":"confirmed","source":"tv-agent"},
        {"path":"audio.muted","value":false,"observed_at":now(),"quality":"confirmed","source":"tv-agent"}]}),
    );
    data.ingest(state, now()).unwrap();
    data
}

fn action_rule() -> Rule {
    serde_json::from_value(json!({"version":1,"id":"button-tv","trigger":{"device":"device-button","event":"button.pressed"},"conditions":[],"cooldown_ms":10000,"actions":[
        {"device":"tv","invoke":{"path":"remote.press","input":{"key":"home"}}},
        {"device":"tv","set":{"path":"audio.volume","value":37}},
        {"device":"tv","invoke":{"path":"apps.launch","input":{"application_id":"org.example.player"}}}
    ]})).unwrap()
}
fn button(data: &Data, kind: &str, seq: u64, body: Value) -> Envelope {
    serde_json::from_value(json!({"v":1,"kind":kind,"message_id":format!("button-{seq}"),"device_id":"device-button","model_revision":data.devices["device-button"].model_revision,"boot_id":"boot-button","session_id":data.devices["device-button"].session_id,"seq":seq,"body":body})).unwrap()
}
#[test]
fn rule_action_shape_is_exclusive_required_and_legacy_bytes_are_unchanged() {
    let valid = json!({"device":"tv","invoke":{"path":"remote.press","input":{"key":"home"}}});
    assert_eq!(
        serde_json::to_value(serde_json::from_value::<Action>(valid.clone()).unwrap()).unwrap(),
        valid
    );
    for bad in [
        json!({"device":"tv"}),
        json!({"device":"tv","set":null}),
        json!({"device":"tv","invoke":null}),
        json!({"device":"tv","set":{"path":"audio.muted"}}),
        json!({"device":"tv","invoke":{"path":"remote.press"}}),
        json!({"device":"tv","invoke":{"path":"remote.press","input":{},"value":{}}}),
        json!({"device":"tv","set":{"path":"audio.muted","value":true},"invoke":{"path":"remote.press","input":{}}}),
        json!({"device":"tv","invoke":{"path":"remote.press","input":{}},"set":null}),
        json!({"device":"tv","invoke":{"path":"remote.press","input":{}},"shell":"reboot"}),
    ] {
        assert!(
            serde_json::from_value::<Action>(bad.clone()).is_err(),
            "{bad}"
        );
    }
    let original: Value = serde_json::from_str(include_str!(
        "../../../../contracts/examples/button-light.json"
    ))
    .unwrap();
    let parsed: Rule = serde_json::from_value(original.clone()).unwrap();
    assert_eq!(serde_json::to_value(&parsed).unwrap(), original);
    assert_eq!(digest(&parsed).unwrap(), digest(&original).unwrap());
}
#[test]
fn ai_drafts_do_not_gain_action_generation_from_the_rule_extension() {
    let mut data = ready();
    let request = serde_json::from_value(json!({"space_id":"home","idempotency_key":"ai-action","prompt":"按下按钮回到电视主页","expires_at":now()+Duration::seconds(60)})).unwrap();
    let draft = data.create_draft(request, "fixture-local", now()).unwrap();
    let mut rule = action_rule();
    rule.id = format!("ai-{}", draft.draft_id);
    assert!(data.validate_rule(&rule).is_ok());
    let result = data
        .finish_draft(&draft.draft_id, Ok(rule), None, now())
        .unwrap();
    assert_eq!(result.error.as_deref(), Some("invalid_model_output"));
    assert!(result.rule.is_none());
    assert!(data.deployments.is_empty());
    assert!(data.commands.is_empty());
}
#[test]
fn mixed_rule_validates_inputs_and_preserves_event_dedupe_fifo_and_unknown_recovery() {
    let mut data = ready();
    let rule = action_rule();
    for (path, input, expected) in [
        ("remote.press", json!({"key":"shell"}), "invalid_value"),
        (
            "remote.press",
            json!({"key":"home","shell":"reboot"}),
            "invalid_value",
        ),
        ("remote.missing", json!({}), "unsupported_capability"),
    ] {
        let mut bad = serde_json::to_value(&rule).unwrap();
        bad["actions"][0]["invoke"] = json!({"path":path,"input":input});
        assert_eq!(
            data.validate_rule(&serde_json::from_value(bad).unwrap())
                .unwrap_err()
                .code,
            expected
        );
    }
    let deployment = data.deploy(rule.clone()).unwrap();
    assert_eq!(data.deploy(rule).unwrap().revision, deployment.revision);
    assert!(data.commands.is_empty());
    let hello = button(&data, "hello", 1, json!({"challenge":"button"}));
    data.ingest(hello, now()).unwrap();
    let state = button(
        &data,
        "state",
        2,
        json!({"type":"snapshot","revision":1,"properties":[]}),
    );
    data.ingest(state, now()).unwrap();
    for (seq, id, historical) in [
        (3, "first", false),
        (4, "first", false),
        (5, "history", true),
        (6, "cooling", false),
    ] {
        let event = button(
            &data,
            "event",
            seq,
            json!({"event_id":id,"path":"button.pressed","occurred_at":now(),"historical":historical,"data":{"count":1}}),
        );
        data.ingest(event, now()).unwrap();
    }
    assert_eq!(data.runs.len(), 1);
    assert_eq!(data.commands.len(), 3);
    let run = data.runs.values().next().unwrap();
    let commands: Vec<_> = run
        .command_ids
        .iter()
        .map(|id| &data.commands[id])
        .collect();
    assert_eq!(
        commands
            .iter()
            .map(|c| c.request.operation.kind.as_str())
            .collect::<Vec<_>>(),
        ["action.invoke", "property.set", "action.invoke"]
    );
    assert_eq!(commands[0].request.operation.value, json!({"key":"home"}));
    let first = commands[0].command_id.clone();
    assert_eq!(data.prepare_dispatch(now()).len(), 1);
    assert_eq!(data.commands[&first].status, "dispatched");
    assert!(data.prepare_dispatch(now()).is_empty());
    let mut recovered: Data = serde_json::from_value(serde_json::to_value(&data).unwrap()).unwrap();
    recovered.recover();
    assert_eq!(recovered.commands[&first].status, "unknown");
    assert!(recovered
        .prepare_dispatch(now() + Duration::seconds(6))
        .is_empty());
    assert_eq!(
        recovered.deployments["button-tv"].revision,
        deployment.revision
    );
    assert_eq!(recovered.commands.len(), 3);
}
fn request(data: &Data) -> CommandRequest {
    serde_json::from_value(json!({"space_id":"home","device_id":"tv",
        "model_revision":data.devices["tv"].model_revision,"idempotency_key":"one-press",
        "expires_at":now()+Duration::seconds(5),
        "operation":{"type":"action.invoke","path":"remote.press","value":{"key":"home"}}}))
    .unwrap()
}
fn evidence(completion: &str) -> Value {
    json!({"type":"action_result","path":"remote.press","input_digest":digest(&json!({"key":"home"})).unwrap(),
        "completion":completion,"output":{},"observed_at":now()})
}

#[test]
fn action_models_validate_inputs_metadata_and_shared_identifier_space() {
    let original = model();
    assert!(validate_document(&serde_json::to_vec(&original).unwrap()).valid);
    let m: Model = serde_json::from_value(original.clone()).unwrap();
    for value in [
        json!({"key":"shell"}),
        json!({"key":"home","command":"reboot"}),
        json!("home"),
        json!({}),
    ] {
        let mut op = request(&ready()).operation;
        op.value = value;
        assert_eq!(m.operation(&op).unwrap_err().code, "invalid_value");
    }
    for (pointer, value, code) in [
        ("/schema_version", json!(1), "unsupported_actions"),
        (
            "/services/0/actions/0/risk",
            json!("unrestricted"),
            "invalid_action_risk",
        ),
        (
            "/services/0/actions/0/completion",
            json!("success"),
            "invalid_action_completion",
        ),
        (
            "/services/2/actions",
            json!([{
                "id":"volume","semantic_id":"urn:limeiot:action:volume:1","input":{"type":"boolean"},
                "output":{"type":"boolean"},"idempotent":false,"risk":"low","completion":"submitted"
            }]),
            "invalid_or_duplicate_identifier",
        ),
    ] {
        let mut changed = original.clone();
        *changed.pointer_mut(pointer).unwrap() = value;
        let report = validate_document(&serde_json::to_vec(&changed).unwrap());
        assert!(!report.valid, "{pointer}");
        assert!(
            report.issues.iter().any(|issue| issue.code == code),
            "{:?}",
            report.issues
        );
    }
}

#[test]
fn actions_require_exact_input_output_scope_and_current_device_session() {
    let mut data = ready();
    let input = request(&data);
    let command = data.create_command(input.clone(), now(), None).unwrap();
    assert_eq!(data.prepare_dispatch(now()).len(), 1);
    assert!(data.prepare_dispatch(now()).is_empty());
    for bad_evidence in [
        json!({"type":"device_result","reported":{"remote.press":{"key":"home"}}}),
        evidence("observed"),
        {
            let mut v = evidence("submitted");
            v["output"] = json!({"unexpected":true});
            v
        },
        {
            let mut v = evidence("submitted");
            v["input_digest"] = json!(digest(&json!({"key":"back"})).unwrap());
            v
        },
        {
            let mut v = evidence("submitted");
            v["observed_at"] = json!(now() + Duration::minutes(1));
            v
        },
    ] {
        let result = message(
            &data,
            "result",
            3,
            json!({"command_id":command.command_id,"status":"confirmed","evidence":bad_evidence}),
        );
        assert_eq!(
            data.ingest(result, now()).unwrap_err().code,
            "invalid_evidence"
        );
        assert_eq!(data.commands[&command.command_id].status, "dispatched");
    }
    let result = message(
        &data,
        "result",
        3,
        json!({"command_id":command.command_id,"status":"confirmed","evidence":evidence("submitted")}),
    );
    data.ingest(result.clone(), now()).unwrap();
    data.ingest(result, now()).unwrap();
    assert_eq!(data.commands[&command.command_id].status, "confirmed");
    assert_eq!(data.devices["tv"].reported.len(), 2);
    assert!(!data.devices["tv"].reported.contains_key("remote.press"));
    assert_eq!(
        data.create_command(input, now() + Duration::minutes(1), None)
            .unwrap()
            .command_id,
        command.command_id
    );
}

#[test]
fn unknown_non_idempotent_action_is_never_resent_after_restart() {
    let mut data = ready();
    let input = request(&data);
    let command = data.create_command(input.clone(), now(), None).unwrap();
    data.prepare_dispatch(now());
    let mut restarted: Data = serde_json::from_slice(&serde_json::to_vec(&data).unwrap()).unwrap();
    restarted.recover();
    assert!(restarted.prepare_dispatch(now()).is_empty());
    assert_eq!(restarted.commands[&command.command_id].status, "unknown");
    assert_eq!(
        restarted
            .create_command(input, now(), None)
            .unwrap()
            .command_id,
        command.command_id
    );
    let mut conflict = request(&data);
    conflict.operation.value = json!({"key":"back"});
    assert_eq!(
        restarted
            .create_command(conflict, now(), None)
            .unwrap_err()
            .code,
        "idempotency_conflict"
    );
}

#[test]
fn physical_commands_keep_acceptance_order_with_a_bounded_device_queue() {
    let mut data = ready();
    let mut ids = Vec::new();
    for index in 0..32 {
        let mut input = request(&data);
        input.idempotency_key = format!("press-{index}");
        let command = data.create_command(input, now(), None).unwrap();
        ids.push(command.command_id);
    }
    let mut overflow = request(&data);
    overflow.idempotency_key = "overflow".into();
    assert_eq!(
        data.create_command(overflow, now(), None).unwrap_err().code,
        "device_queue_full"
    );
    for (index, id) in ids.iter().enumerate() {
        let outgoing = data.prepare_dispatch(now());
        assert_eq!(outgoing.len(), 1);
        assert_eq!(outgoing[0].body["command_id"], *id);
        assert!(data.prepare_dispatch(now()).is_empty());
        let result = message(
            &data,
            "result",
            3 + index as u64,
            json!({"command_id":id,"status":"confirmed","evidence":evidence("submitted")}),
        );
        data.ingest(result, now()).unwrap();
    }
    assert!(data.prepare_dispatch(now()).is_empty());
}

#[test]
fn action_compatibility_protects_old_inputs_new_outputs_and_side_effect_semantics() {
    let old = model();
    let compare = |candidate: Value| {
        compare_documents(
            &serde_json::to_vec(&json!({"baseline":old,"candidate":candidate})).unwrap(),
        )
    };
    let mut new = old.clone();
    new["model_version"] = json!("1.1.0");
    assert_eq!(compare(new.clone()).compatible, Some(true));
    for (pointer, value, code) in [
        (
            "/services/0/actions/0/input/properties/key/enum",
            json!(["home"]),
            "action_input_incompatible",
        ),
        (
            "/services/0/actions/0/idempotent",
            json!(true),
            "action_idempotency_changed",
        ),
        (
            "/services/0/actions/0/risk",
            json!("high"),
            "action_risk_changed",
        ),
        (
            "/services/0/actions/0/completion",
            json!("observed"),
            "action_completion_changed",
        ),
        (
            "/services/0/actions/0/output",
            json!({"type":"boolean"}),
            "action_output_incompatible",
        ),
    ] {
        let mut changed = new.clone();
        *changed.pointer_mut(pointer).unwrap() = value;
        let report = compare(changed);
        assert!(report.valid);
        assert_eq!(report.compatible, Some(false));
        assert!(report.issues.iter().any(|issue| issue.code == code));
    }
    new["services"][0]["actions"] = json!([]);
    new["services"][0]["events"] =
        json!([{"id":"test","semantic_id":"urn:limeiot:event:test:1","schema":{"type":"boolean"}}]);
    assert!(compare(new)
        .issues
        .iter()
        .any(|issue| issue.code == "action_removed"));
}
