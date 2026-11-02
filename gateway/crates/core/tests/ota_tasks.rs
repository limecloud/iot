use chrono::{DateTime, Duration, Utc};
use limeiot_core::{
    engine::{Config, Data},
    ota_tasks::{self, Change, Operation, Request, Status},
    protocol::{CommandRequest, Envelope},
};
use serde_json::{json, Value};
fn now() -> DateTime<Utc> {
    "2026-11-02T00:00:00Z".parse().unwrap()
}
fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../../contracts/examples/ota-firmware.json"
    ))
    .unwrap()
}
fn envelope(data: &Data, kind: &str, seq: u64, body: Value) -> Envelope {
    let device = &data.devices["device-lamp"];
    serde_json::from_value(json!({"v":1,"kind":kind,"message_id":format!("ota-{seq}"),"device_id":"device-lamp",
        "model_revision":device.model_revision,"boot_id":device.boot_id.as_deref().unwrap_or("ota-boot"),"seq":seq,"session_id":device.session_id,"body":body})).unwrap()
}
fn handshake(data: &mut Data, at: DateTime<Utc>) {
    let mut hello = envelope(data, "hello", 1, json!({"challenge":"ota-challenge"}));
    hello.boot_id = Some(format!("boot-{}", limeiot_core::id()));
    hello.session_id = None;
    data.ingest(hello, at).unwrap();
    let snapshot = envelope(
        data,
        "state",
        2,
        json!({"type":"snapshot","revision":1,"properties":[
        {"path":"light.power","value":false,"observed_at":at,"quality":"confirmed","source":"fixture"},
        {"path":"light.brightness","value":0,"observed_at":at,"quality":"confirmed","source":"fixture"}]}),
    );
    data.ingest(snapshot, at).unwrap();
    report(data, fixture()["request"]["device"].clone(), at);
}
fn report(data: &mut Data, body: Value, at: DateTime<Utc>) {
    let message = envelope(
        data,
        "device_info",
        data.devices["device-lamp"].last_seq + 1,
        body,
    );
    data.ingest(message, at).unwrap();
}
fn initial() -> Data {
    let config: Config =
        serde_json::from_str(include_str!("../../../../deploy/dev/config.json")).unwrap();
    let mut data = Data::new(config).unwrap();
    handshake(&mut data, now());
    data
}
fn apply(data: &mut Data, body: Value, key: &str, at: DateTime<Utc>) -> Operation {
    data.apply_ota_change(
        Request {
            space_id: "space-demo".into(),
            idempotency_key: key.into(),
            change: ota_tasks::parse_change(&serde_json::to_vec(&body).unwrap()).unwrap(),
        },
        at,
    )
    .unwrap()
}
fn trust(data: &mut Data) -> String {
    let value = fixture()["request"]["trust"].clone();
    apply(
        data,
        json!({"type":"trust.add","expected_signing_key_id":value["signing_key_id"],"trust":value}),
        "trust",
        now(),
    )
    .resource
    .unwrap()
    .id
}
fn plan(data: &mut Data, trust: &str, key: &str, at: DateTime<Utc>) -> Operation {
    apply(
        data,
        json!({"type":"tasks.plan","device_id":"device-lamp","trust_id":trust,
        "manifest":fixture()["request"]["manifest"],"expires_at":at+Duration::minutes(10)}),
        key,
        at,
    )
}
fn approve(data: &mut Data, id: &str, key: &str, at: DateTime<Utc>) -> Operation {
    apply(
        data,
        json!({"type":"tasks.approve","task_id":id,"expected_revision":data.ota_registry.tasks[id].revision}),
        key,
        at,
    )
}
#[test]
fn explicit_independent_trust_plan_approval_and_cancel_preserve_original_decisions() {
    let mut data = initial();
    let trust = trust(&mut data);
    assert!(data.model_registry.trusts.is_empty());
    let planned = plan(&mut data, &trust, "plan", now());
    assert_eq!(planned.status, "applied");
    let id = planned.resource.unwrap().id;
    assert_eq!(
        data.approved_ota_request(&id, now()).unwrap_err().code,
        "ota_approval_required"
    );
    let approved = approve(&mut data, &id, "approve", now());
    assert_eq!(approved.status, "applied");
    assert!(data.approved_ota_request(&id, now()).is_ok());
    let command: CommandRequest = serde_json::from_value(json!({"space_id":"space-demo","device_id":"device-lamp",
        "model_revision":data.devices["device-lamp"].model_revision,"idempotency_key":"blocked-command","expires_at":now()+Duration::seconds(5),
        "operation":{"type":"property.set","path":"light.power","value":true}})).unwrap();
    assert_eq!(
        data.create_command(command, now(), None).unwrap_err().code,
        "ota_task_conflict"
    );
    let request = approved.request.clone();
    let cancel_revision = data.ota_registry.tasks[&id].revision.clone();
    let cancelled = apply(
        &mut data,
        json!({"type":"tasks.cancel","task_id":id,"expected_revision":cancel_revision}),
        "cancel",
        now(),
    );
    assert_eq!(cancelled.status, "applied");
    assert_eq!(
        data.apply_ota_change(request, now()).unwrap().operation_id,
        approved.operation_id
    );
    assert_eq!(data.ota_registry.tasks[&id].status, Status::Cancelled);
    assert!(!data.ota_reserves_device("device-lamp", now()));
    data.validate_ota_registry().unwrap();
}
#[test]
fn approval_rechecks_freshness_dynamic_power_busy_and_fixed_target() {
    let mut data = initial();
    let trust = trust(&mut data);
    let id = plan(&mut data, &trust, "plan", now()).resource.unwrap().id;
    assert_eq!(
        approve(&mut data, &id, "stale", now() + Duration::seconds(5))
            .reason
            .as_deref(),
        Some("device_info_stale")
    );
    let mut device = fixture()["request"]["device"].clone();
    device["external_power"] = json!(false);
    device["battery_percent"] = json!(20);
    report(&mut data, device.clone(), now() + Duration::seconds(6));
    assert_eq!(
        approve(&mut data, &id, "low", now() + Duration::seconds(6))
            .reason
            .as_deref(),
        Some("ota_insufficient_power")
    );
    device["battery_percent"] = json!(80);
    device["safe_to_update"] = json!(false);
    report(&mut data, device.clone(), now() + Duration::seconds(7));
    assert_eq!(
        approve(&mut data, &id, "busy", now() + Duration::seconds(7))
            .reason
            .as_deref(),
        Some("ota_device_busy")
    );
    device["safe_to_update"] = json!(true);
    device["firmware_version"] = json!("0.1.1");
    report(&mut data, device.clone(), now() + Duration::seconds(8));
    assert_eq!(
        approve(&mut data, &id, "changed", now() + Duration::seconds(8))
            .reason
            .as_deref(),
        Some("ota_device_changed")
    );
    device["firmware_version"] = json!("0.1.0");
    report(&mut data, device, now() + Duration::seconds(9));
    assert_eq!(
        approve(&mut data, &id, "valid", now() + Duration::seconds(9)).status,
        "applied"
    );
    assert_eq!(
        data.approved_ota_request(&id, now() + Duration::seconds(14))
            .unwrap_err()
            .code,
        "device_info_stale"
    );
    data.validate_ota_registry().unwrap();
}
#[test]
fn restart_requires_new_revision_and_new_approval_even_when_old_decision_is_recovered() {
    let mut data = initial();
    let trust = trust(&mut data);
    let id = plan(&mut data, &trust, "plan", now()).resource.unwrap().id;
    let approved = approve(&mut data, &id, "approve", now());
    let old_revision = data.ota_registry.tasks[&id].revision.clone();
    let saved = serde_json::to_vec(&data).unwrap();
    data = serde_json::from_slice(&saved).unwrap();
    data.validate_ota_registry().unwrap();
    data.recover();
    assert_eq!(data.ota_registry.tasks[&id].status, Status::Planned);
    assert_ne!(data.ota_registry.tasks[&id].revision, old_revision);
    assert!(data.ota_registry.tasks[&id].approval.is_none());
    assert_eq!(
        data.apply_ota_change(approved.request, now())
            .unwrap()
            .status,
        "applied"
    );
    assert_eq!(
        data.approved_ota_request(&id, now()).unwrap_err().code,
        "ota_approval_required"
    );
    handshake(&mut data, now() + Duration::seconds(1));
    assert_eq!(
        approve(&mut data, &id, "new-approval", now() + Duration::seconds(1)).status,
        "applied"
    );
    assert!(data
        .approved_ota_request(&id, now() + Duration::seconds(1))
        .is_ok());
}
#[test]
fn trust_revocation_invalidates_tasks_and_replaying_original_add_does_not_reactivate() {
    let mut data = initial();
    let trust = trust(&mut data);
    let id = plan(&mut data, &trust, "plan", now()).resource.unwrap().id;
    approve(&mut data, &id, "approve", now());
    let original = data.ota_registry.operations["trust"].request.clone();
    let revision = data.ota_registry.trusts[&trust].revision.clone();
    assert_eq!(
        apply(
            &mut data,
            json!({"type":"trust.revoke","trust_id":trust,"expected_revision":revision}),
            "revoke",
            now()
        )
        .status,
        "applied"
    );
    assert_eq!(data.ota_registry.tasks[&id].status, Status::Invalidated);
    data.apply_ota_change(original.clone(), now()).unwrap();
    assert!(!data.ota_registry.trusts[&trust].active);
    assert_eq!(
        apply(
            &mut data,
            serde_json::to_value(original.change).unwrap(),
            "new-add",
            now()
        )
        .reason
        .as_deref(),
        Some("ota_trust_revoked")
    );
    data.validate_ota_registry().unwrap();
}
#[test]
fn duplicate_keys_conflicts_bad_signature_and_deadline_do_not_create_extra_tasks() {
    let mut data = initial();
    let trust = trust(&mut data);
    let first = plan(&mut data, &trust, "plan", now());
    assert_eq!(
        plan(&mut data, &trust, "plan", now()).operation_id,
        first.operation_id
    );
    assert_eq!(
        plan(&mut data, &trust, "second", now()).reason.as_deref(),
        Some("ota_task_conflict")
    );
    let mut other = first.request.clone();
    if let Change::Plan { device_id, .. } = &mut other.change {
        *device_id = "device-button".into();
    }
    assert_eq!(
        data.apply_ota_change(other, now()).unwrap_err().code,
        "idempotency_conflict"
    );
    let id = first.resource.unwrap().id;
    let approved = approve(&mut data, &id, "approve", now());
    assert_eq!(approved.status, "applied");
    data.prepare_dispatch(now() + Duration::minutes(10));
    assert_eq!(data.ota_registry.tasks[&id].status, Status::Expired);
    assert!(data.ota_registry.tasks[&id].approval.is_none());
    assert_eq!(data.ota_registry.tasks.len(), 1);
    data.validate_ota_registry().unwrap();
    let value = json!({"type":"tasks.cancel","task_id":id,"expected_revision":"x"});
    let raw = serde_json::to_string(&value).unwrap();
    assert!(ota_tasks::parse_change(
        raw.replace("\"type\":", "\"type\":\"tasks.cancel\",\"type\":")
            .as_bytes()
    )
    .is_err());
    assert!(ota_tasks::parse_change(b"{\"type\":\"tasks.approve\",\"task_id\":\"x\"}").is_err());
    assert!(ota_tasks::parse_change(b"{\"type\":\"tasks.approve\",\"task_id\":\"x\",\"expected_revision\":\"r\",\"approved\":true}").is_err());
}
#[test]
fn malformed_snapshot_cannot_restore_forged_approval_or_tampered_signed_target() {
    let mut data = initial();
    let trust = trust(&mut data);
    let id = plan(&mut data, &trust, "plan", now()).resource.unwrap().id;
    let mut forged = data.clone();
    forged.ota_registry.tasks.get_mut(&id).unwrap().status = Status::Approved;
    assert!(forged.validate_ota_registry().is_err());
    forged = data.clone();
    forged
        .ota_registry
        .tasks
        .get_mut(&id)
        .unwrap()
        .manifest
        .statement
        .version = "9.0.0".into();
    assert!(forged.validate_ota_registry().is_err());
    forged = data;
    forged
        .ota_registry
        .operations
        .get_mut("plan")
        .unwrap()
        .request_digest = "forged".into();
    assert!(forged.validate_ota_registry().is_err());
}

#[test]
fn wrong_fingerprint_bad_signature_and_unresolved_commands_cannot_prepare_installation() {
    let mut data = initial();
    let trust_value = fixture()["request"]["trust"].clone();
    let rejected = apply(
        &mut data,
        json!({"type":"trust.add","trust":trust_value,"expected_signing_key_id":format!("sha256:{}","0".repeat(64))}),
        "wrong-key",
        now(),
    );
    assert_eq!(
        rejected.reason.as_deref(),
        Some("signing_key_confirmation_mismatch")
    );
    assert!(data.ota_registry.trusts.is_empty());
    let trusted = trust(&mut data);
    let mut manifest = fixture()["request"]["manifest"].clone();
    manifest["statement"]["version"] = json!("0.3.0");
    assert_eq!(apply(&mut data, json!({"type":"tasks.plan","device_id":"device-lamp","trust_id":trusted,"manifest":manifest,"expires_at":now()+Duration::minutes(1)}), "tampered", now()).reason.as_deref(), Some("invalid_ota_signature"));
    assert!(data.ota_registry.tasks.is_empty());
    let command: CommandRequest = serde_json::from_value(json!({"space_id":"space-demo","device_id":"device-lamp",
        "model_revision":data.devices["device-lamp"].model_revision,"idempotency_key":"pending-command","expires_at":now()+Duration::seconds(5),
        "operation":{"type":"property.set","path":"light.power","value":true}})).unwrap();
    let accepted = data.create_command(command, now(), None).unwrap();
    for status in ["accepted", "dispatched", "unknown"] {
        data.commands.get_mut(&accepted.command_id).unwrap().status = status.into();
        assert_eq!(
            plan(&mut data, &trusted, status, now()).reason.as_deref(),
            Some("ota_commands_pending")
        );
    }
    data.commands.get_mut(&accepted.command_id).unwrap().status = "failed".into();
    assert_eq!(
        plan(&mut data, &trusted, "after-terminal", now()).status,
        "applied"
    );
}

#[test]
fn new_device_session_revokes_approval_and_clock_cannot_move_before_approval() {
    let mut data = initial();
    let trusted = trust(&mut data);
    let id = plan(&mut data, &trusted, "plan", now())
        .resource
        .unwrap()
        .id;
    report(
        &mut data,
        fixture()["request"]["device"].clone(),
        now() + Duration::seconds(2),
    );
    approve(&mut data, &id, "approve", now() + Duration::seconds(2));
    assert_eq!(
        data.approved_ota_request(&id, now() + Duration::seconds(1))
            .unwrap_err()
            .code,
        "invalid_ota_time"
    );
    handshake(&mut data, now() + Duration::seconds(3));
    assert_eq!(data.ota_registry.tasks[&id].status, Status::Planned);
    assert_eq!(
        data.ota_registry.tasks[&id].reason.as_deref(),
        Some("ota_session_changed")
    );
    assert_eq!(
        data.approved_ota_request(&id, now() + Duration::seconds(3))
            .unwrap_err()
            .code,
        "ota_approval_required"
    );
    data.validate_ota_registry().unwrap();
}

fn executing() -> (Data, String) {
    let mut data = initial();
    let trusted = trust(&mut data);
    let id = plan(&mut data, &trusted, "plan", now())
        .resource
        .unwrap()
        .id;
    approve(&mut data, &id, "approve", now());
    let revision = data.ota_registry.tasks[&id].revision.clone();
    assert_eq!(
        apply(
            &mut data,
            json!({"type":"tasks.execute","task_id":id,"expected_revision":revision}),
            "execute",
            now()
        )
        .status,
        "applied"
    );
    (data, id)
}
fn ota_result(data: &Data, task_id: &str, status: &str) -> Value {
    let task = &data.ota_registry.tasks[task_id];
    let execution = task.execution.as_ref().unwrap();
    let success = status == "succeeded";
    json!({"task_id":task_id,"execution_id":execution.envelope.body["execution_id"],
        "request_digest":execution.request_digest,"manifest_digest":task.manifest_digest,"status":status,
        "firmware_version":if success { &task.manifest.statement.version } else { &task.baseline.device.firmware_version },
        "security_epoch":if success { task.manifest.statement.security_epoch } else { task.baseline.device.security_epoch },
        "image_sha256":if success { task.manifest.statement.sha256.clone() } else { format!("sha256:{}", "0".repeat(64)) },
        "pending_update":false,"error":if ["failed","rejected","rolled_back"].contains(&status) { Some("fixture_failure") } else { None }})
}
fn receive_ota(
    data: &mut Data,
    body: Value,
    at: DateTime<Utc>,
) -> limeiot_core::Result<Option<Envelope>> {
    let message = envelope(
        data,
        "ota_result",
        data.devices["device-lamp"].last_seq + 1,
        body,
    );
    data.ingest(message, at)
}
#[test]
fn execute_is_explicit_and_dispatch_intent_is_emitted_only_once() {
    let mut data = initial();
    let trusted = trust(&mut data);
    let id = plan(&mut data, &trusted, "plan", now())
        .resource
        .unwrap()
        .id;
    let revision = data.ota_registry.tasks[&id].revision.clone();
    assert_eq!(
        apply(
            &mut data,
            json!({"type":"tasks.execute","task_id":id,"expected_revision":revision}),
            "unapproved",
            now()
        )
        .reason
        .as_deref(),
        Some("ota_approval_required")
    );
    approve(&mut data, &id, "approve", now());
    assert!(data.prepare_ota_dispatch(now()).is_empty());
    let revision = data.ota_registry.tasks[&id].revision.clone();
    let original = apply(
        &mut data,
        json!({"type":"tasks.execute","task_id":id,"expected_revision":revision}),
        "execute",
        now(),
    );
    assert!(data.ota_registry.tasks[&id]
        .execution
        .as_ref()
        .unwrap()
        .attempted_at
        .is_none());
    let messages = data.prepare_ota_dispatch(now());
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].kind, "ota_install");
    assert!(messages[0].body.get("trust").is_none());
    assert!(messages[0].body.get("public_key").is_none());
    assert_eq!(
        data.ota_registry.tasks[&id]
            .execution
            .as_ref()
            .unwrap()
            .request_digest,
        limeiot_core::digest(&messages[0]).unwrap()
    );
    assert!(data.prepare_ota_dispatch(now()).is_empty());
    assert_eq!(
        data.apply_ota_change(original.request, now())
            .unwrap()
            .operation_id,
        original.operation_id
    );
    assert!(data.prepare_ota_dispatch(now()).is_empty());
    data.validate_ota_registry().unwrap();
}
#[test]
fn interruption_before_dispatch_fails_safely_but_possible_delivery_never_releases_occupancy() {
    let (mut unsent, id) = executing();
    unsent.recover();
    assert_eq!(unsent.ota_registry.tasks[&id].status, Status::Failed);
    assert!(!unsent.ota_reserves_device("device-lamp", now()));
    assert!(unsent.prepare_ota_dispatch(now()).is_empty());
    unsent.validate_ota_registry().unwrap();
    let (mut data, id) = executing();
    data.prepare_ota_dispatch(now());
    data.recover();
    assert_eq!(data.ota_registry.tasks[&id].status, Status::Unknown);
    data.prepare_dispatch(now() + Duration::hours(1));
    assert!(data.ota_reserves_device("device-lamp", now() + Duration::hours(1)));
    assert!(data
        .prepare_ota_dispatch(now() + Duration::hours(1))
        .is_empty());
    let revision = data.ota_registry.tasks[&id].revision.clone();
    assert_eq!(
        apply(
            &mut data,
            json!({"type":"tasks.cancel","task_id":id,"expected_revision":revision}),
            "cancel-running",
            now()
        )
        .reason
        .as_deref(),
        Some("invalid_ota_transition")
    );
    let trusted = data.ota_registry.tasks[&id].trust_id.clone();
    let revision = data.ota_registry.trusts[&trusted].revision.clone();
    apply(
        &mut data,
        json!({"type":"trust.revoke","trust_id":trusted,"expected_revision":revision}),
        "revoke-running",
        now(),
    );
    assert_eq!(data.ota_registry.tasks[&id].status, Status::Unknown);
    assert!(data.ota_reserves_device("device-lamp", now() + Duration::days(1)));
    data.validate_ota_registry().unwrap();
    handshake(&mut data, now() + Duration::hours(1));
    let body = ota_result(&data, &id, "rolled_back");
    receive_ota(&mut data, body, now() + Duration::hours(1)).unwrap();
    assert_eq!(data.ota_registry.tasks[&id].status, Status::Failed);
    assert!(!data.ota_reserves_device("device-lamp", now() + Duration::hours(1)));
    data.validate_ota_registry().unwrap();
}
#[test]
fn execution_dispatch_rechecks_freshness_and_expiry_without_installing() {
    for delay in [5, 600] {
        let (mut data, id) = executing();
        assert!(data
            .prepare_ota_dispatch(now() + Duration::seconds(delay))
            .is_empty());
        assert_eq!(data.ota_registry.tasks[&id].status, Status::Failed);
        assert!(data.ota_registry.tasks[&id]
            .execution
            .as_ref()
            .unwrap()
            .attempted_at
            .is_none());
        data.validate_ota_registry().unwrap();
    }
    let (mut data, id) = executing();
    data.prepare_ota_dispatch(now());
    data.prepare_ota_dispatch(now() + Duration::minutes(10));
    assert_eq!(data.ota_registry.tasks[&id].status, Status::Unknown);
    assert!(data.ota_reserves_device("device-lamp", now() + Duration::minutes(10)));
    data.validate_ota_registry().unwrap();
}
#[test]
fn receipt_identity_pending_image_boot_and_phase_cannot_forge_completion() {
    let (mut data, id) = executing();
    let body = ota_result(&data, &id, "installing");
    assert!(receive_ota(&mut data, body.clone(), now()).is_err());
    data.prepare_ota_dispatch(now());
    receive_ota(&mut data, body.clone(), now()).unwrap();
    let revision = data.ota_registry.tasks[&id].revision.clone();
    receive_ota(&mut data, body, now()).unwrap();
    assert_eq!(data.ota_registry.tasks[&id].revision, revision);
    let awaiting = ota_result(&data, &id, "awaiting_boot");
    receive_ota(&mut data, awaiting, now()).unwrap();
    let regression = ota_result(&data, &id, "installing");
    assert_eq!(
        receive_ota(&mut data, regression, now()).unwrap_err().code,
        "ota_receipt_conflict"
    );
    let success = ota_result(&data, &id, "succeeded");
    assert!(receive_ota(&mut data, success.clone(), now()).is_err());
    handshake(&mut data, now() + Duration::seconds(1));
    for field in [
        "request_digest",
        "execution_id",
        "manifest_digest",
        "image_sha256",
        "firmware_version",
    ] {
        let mut invalid = success.clone();
        invalid[field] = json!("wrong");
        assert!(receive_ota(&mut data, invalid, now() + Duration::seconds(1)).is_err());
    }
    let mut pending = success.clone();
    pending["pending_update"] = json!(true);
    assert!(receive_ota(&mut data, pending, now() + Duration::seconds(1)).is_err());
    let mut extra = success.clone();
    extra["trusted"] = json!(true);
    assert!(receive_ota(&mut data, extra, now() + Duration::seconds(1)).is_err());
    receive_ota(&mut data, success, now() + Duration::seconds(1)).unwrap();
    assert_eq!(data.ota_registry.tasks[&id].status, Status::Succeeded);
    assert!(!data.ota_reserves_device("device-lamp", now()));
    let failed = ota_result(&data, &id, "failed");
    assert_eq!(
        receive_ota(&mut data, failed, now() + Duration::seconds(1))
            .unwrap_err()
            .code,
        "ota_receipt_conflict"
    );
    data.validate_ota_registry().unwrap();
}
#[test]
fn explicit_reconcile_after_restart_only_queries_original_execution_even_after_deadline() {
    let (mut data, id) = executing();
    data.prepare_ota_dispatch(now());
    let original = data.ota_registry.tasks[&id]
        .execution
        .as_ref()
        .unwrap()
        .request_digest
        .clone();
    data.recover();
    let later = now() + Duration::hours(1);
    handshake(&mut data, later);
    let revision = data.ota_registry.tasks[&id].revision.clone();
    let resolved = apply(
        &mut data,
        json!({"type":"tasks.reconcile","task_id":id,"expected_revision":revision}),
        "reconcile",
        later,
    );
    assert_eq!(resolved.status, "applied");
    let messages = data.prepare_ota_dispatch(later);
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].kind, "ota_query");
    assert_eq!(messages[0].body["request_digest"], original);
    assert!(messages[0].body.get("manifest").is_none());
    assert!(data.prepare_ota_dispatch(later).is_empty());
    data.apply_ota_change(resolved.request, later).unwrap();
    assert!(data.prepare_ota_dispatch(later).is_empty());
    let body = ota_result(&data, &id, "rejected");
    receive_ota(&mut data, body, later).unwrap();
    assert_eq!(data.ota_registry.tasks[&id].status, Status::Failed);
    data.validate_ota_registry().unwrap();
}
#[test]
fn stored_execution_digest_delivery_and_receipt_tampering_are_rejected() {
    let (mut data, id) = executing();
    data.prepare_ota_dispatch(now());
    for field in ["request_digest", "attempted_at", "envelope"] {
        let mut value = serde_json::to_value(&data).unwrap();
        value["ota_registry"]["tasks"][&id]["execution"][field] = match field {
            "request_digest" => json!("sha256:forged"),
            "attempted_at" => json!("2026-11-03T00:00:00Z"),
            _ => json!({}),
        };
        let invalid = serde_json::from_value::<Data>(value);
        assert!(invalid.is_err() || invalid.unwrap().validate_ota_registry().is_err());
    }
    data.ota_registry.tasks.get_mut(&id).unwrap().status = Status::Succeeded;
    assert!(data.validate_ota_registry().is_err());
}

#[test]
fn original_execution_queries_are_bounded_and_pending_queries_cannot_be_overwritten() {
    let (mut data, id) = executing();
    data.prepare_ota_dispatch(now());
    for index in 0..32 {
        let revision = data.ota_registry.tasks[&id].revision.clone();
        let result = apply(
            &mut data,
            json!({"type":"tasks.reconcile","task_id":id,"expected_revision":revision}),
            &format!("query-{index}"),
            now(),
        );
        assert_eq!(result.status, "applied");
        if index == 0 {
            let revision = data.ota_registry.tasks[&id].revision.clone();
            assert_eq!(
                apply(
                    &mut data,
                    json!({"type":"tasks.reconcile","task_id":id,"expected_revision":revision}),
                    "query-pending",
                    now()
                )
                .reason
                .as_deref(),
                Some("ota_query_pending")
            );
        }
        let messages = data.prepare_ota_dispatch(now());
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].kind, "ota_query");
        data.apply_ota_change(result.request, now()).unwrap();
        assert!(data.prepare_ota_dispatch(now()).is_empty());
    }
    let revision = data.ota_registry.tasks[&id].revision.clone();
    assert_eq!(
        apply(
            &mut data,
            json!({"type":"tasks.reconcile","task_id":id,"expected_revision":revision}),
            "query-full",
            now()
        )
        .reason
        .as_deref(),
        Some("ota_query_capacity")
    );
    data.validate_ota_registry().unwrap();
}

#[test]
fn model_rebinding_is_blocked_until_original_installation_has_terminal_evidence() {
    use limeiot_core::model_registry::{self, Resource};
    let (mut data, id) = executing();
    let model: Value = serde_json::from_str(include_str!(
        "../../../../contracts/examples/model-release.json"
    ))
    .unwrap();
    let request = |change, key: &str| model_registry::Request {
        space_id: "space-demo".into(),
        idempotency_key: key.into(),
        change,
    };
    let trusted = data
        .apply_model_change(
            request(
                model_registry::Change::TrustAdd {
                    trust: model["trust"].clone(),
                    expected_signing_key_id: model["trust"]["signing_key_id"]
                        .as_str()
                        .unwrap()
                        .into(),
                },
                "model-trust",
            ),
            now(),
        )
        .unwrap();
    let Some(Resource::Trust(trusted)) = trusted.result else {
        panic!()
    };
    let installed = data
        .apply_model_change(
            request(
                model_registry::Change::Install {
                    trust_id: trusted.trust_id,
                    artifact: model["artifact"].clone(),
                    expected_release_id: None,
                },
                "model-install",
            ),
            now(),
        )
        .unwrap();
    let Some(Resource::Installation(installed)) = installed.result else {
        panic!("{:?}", installed.reason)
    };
    let binding = model_registry::Change::Bind {
        device_id: "device-lamp".into(),
        installation_id: installed.installation_id,
        expected_model_revision: Some(data.devices["device-lamp"].model_revision.clone()),
        expected_binding_revision: None,
    };
    data.prepare_ota_dispatch(now());
    assert_eq!(
        data.apply_model_change(request(binding.clone(), "bind-executing"), now())
            .unwrap()
            .reason
            .as_deref(),
        Some("ota_task_conflict")
    );
    data.recover();
    assert_eq!(
        data.apply_model_change(request(binding.clone(), "bind-unknown"), now())
            .unwrap()
            .reason
            .as_deref(),
        Some("ota_task_conflict")
    );
    handshake(&mut data, now() + Duration::seconds(1));
    let body = ota_result(&data, &id, "rejected");
    receive_ota(&mut data, body, now() + Duration::seconds(1)).unwrap();
    assert_eq!(
        data.apply_model_change(request(binding, "bind-after-terminal"), now())
            .unwrap()
            .status,
        "applied"
    );
    data.validate_ota_registry().unwrap();
}
