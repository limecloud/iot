//! 独立固件信任、耐久计划与明确批准；设备安装经独立执行合同调度。
use crate::{
    device_info::DeviceInfo, digest, engine::Data, ensure, err, id, identifier, ota,
    validation::bounded_document, Result,
};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const MAX_OPERATIONS: usize = 512;
pub const MAX_TRUSTS: usize = 32;
pub const MAX_TASKS: usize = 128;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
pub enum Change {
    #[serde(rename = "trust.add")]
    TrustAdd {
        trust: Box<ota::Trust>,
        expected_signing_key_id: String,
    },
    #[serde(rename = "trust.revoke")]
    TrustRevoke {
        trust_id: String,
        expected_revision: String,
    },
    #[serde(rename = "tasks.plan")]
    Plan {
        device_id: String,
        trust_id: String,
        manifest: Box<ota::Manifest>,
        expires_at: DateTime<Utc>,
    },
    #[serde(rename = "tasks.approve")]
    Approve {
        task_id: String,
        expected_revision: String,
    },
    #[serde(rename = "tasks.execute")]
    Execute {
        task_id: String,
        expected_revision: String,
    },
    #[serde(rename = "tasks.reconcile")]
    Reconcile {
        task_id: String,
        expected_revision: String,
    },
    #[serde(rename = "tasks.cancel")]
    Cancel {
        task_id: String,
        expected_revision: String,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub space_id: String,
    pub idempotency_key: String,
    pub change: Change,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FirmwareTrust {
    pub trust_id: String,
    pub revision: String,
    pub trust: ota::Trust,
    pub active: bool,
    pub created_at: DateTime<Utc>,
    pub revoked_at: Option<DateTime<Utc>>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Planned,
    Approved,
    Cancelled,
    Expired,
    Invalidated,
    Executing,
    Unknown,
    Succeeded,
    Failed,
}
impl Status {
    pub(crate) fn pending(self) -> bool {
        matches!(self, Self::Planned | Self::Approved)
    }
    pub(crate) fn active(self) -> bool {
        self.pending() || matches!(self, Self::Executing | Self::Unknown)
    }
    pub(crate) fn reserves(self, expires_at: DateTime<Utc>, now: DateTime<Utc>) -> bool {
        self == Self::Approved && expires_at > now
            || matches!(self, Self::Executing | Self::Unknown)
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Approval {
    pub approved_at: DateTime<Utc>,
    pub device_info: DeviceInfo,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Task {
    pub task_id: String,
    pub revision: String,
    pub device_id: String,
    pub trust_id: String,
    pub trust_revision: String,
    pub manifest: ota::Manifest,
    pub manifest_digest: String,
    pub baseline: DeviceInfo,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub status: Status,
    pub approval: Option<Approval>,
    #[serde(default)]
    pub execution: Option<crate::ota_execution::Execution>,
    pub reason: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResourceRef {
    pub kind: String,
    pub id: String,
    pub revision: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Operation {
    pub operation_id: String,
    pub request: Request,
    pub request_digest: String,
    pub status: String,
    pub reason: Option<String>,
    pub resource: Option<ResourceRef>,
    pub created_at: DateTime<Utc>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Registry {
    pub trusts: BTreeMap<String, FirmwareTrust>,
    pub tasks: BTreeMap<String, Task>,
    pub operations: BTreeMap<String, Operation>,
}
pub fn parse_change(raw: &[u8]) -> Result<Change> {
    let value = bounded_document(raw, 16_384, 16, 2048).ok_or_else(|| err("invalid_ota_change"))?;
    let change: Change =
        serde_json::from_value(value.clone()).map_err(|_| err("invalid_ota_change"))?;
    ensure(digest(&change)? == digest(&value)?, "invalid_ota_change")?;
    Ok(change)
}
fn trust_id(trust: &ota::Trust) -> Result<String> {
    Ok(format!("fwtrust-{}", &digest(trust)?[7..]))
}
fn same_target(left: &ota::Device, right: &ota::Device) -> bool {
    [
        &left.device_id,
        &left.product_id,
        &left.architecture,
        &left.chip,
        &left.board,
        &left.hardware_revision,
        &left.firmware_version,
        &left.bootloader_version,
        &left.model_revision,
    ] == [
        &right.device_id,
        &right.product_id,
        &right.architecture,
        &right.chip,
        &right.board,
        &right.hardware_revision,
        &right.firmware_version,
        &right.bootloader_version,
        &right.model_revision,
    ] && left.protocol_version == right.protocol_version
        && left.security_epoch == right.security_epoch
        && left.ota_capacity_bytes == right.ota_capacity_bytes
}
pub(crate) fn task_ref(task: &Task) -> ResourceRef {
    ResourceRef {
        kind: "ota_task".into(),
        id: task.task_id.clone(),
        revision: task.revision.clone(),
    }
}
fn trust_ref(trust: &FirmwareTrust) -> ResourceRef {
    ResourceRef {
        kind: "firmware_trust".into(),
        id: trust.trust_id.clone(),
        revision: trust.revision.clone(),
    }
}
impl Data {
    pub fn ota_operation(&self, key: &str) -> Result<&Operation> {
        self.ota_registry
            .operations
            .get(key)
            .ok_or_else(|| err("ota_operation_not_found"))
    }
    pub fn apply_ota_change(&mut self, request: Request, now: DateTime<Utc>) -> Result<Operation> {
        ensure(request.space_id == self.space_id, "forbidden")?;
        ensure(
            identifier(&request.idempotency_key),
            "invalid_idempotency_key",
        )?;
        let request_digest = digest(&request)?;
        if let Some(previous) = self.ota_registry.operations.get(&request.idempotency_key) {
            ensure(
                previous.request_digest == request_digest,
                "idempotency_conflict",
            )?;
            return Ok(previous.clone());
        }
        ensure(
            self.ota_registry.operations.len() < MAX_OPERATIONS,
            "ota_operation_capacity",
        )?;
        self.expire_ota_tasks(now);
        let (status, reason, resource) = match self.apply_ota_change_once(&request.change, now) {
            Ok(resource) => ("applied", None, Some(resource)),
            Err(error) => (
                if error.code == "revision_conflict" {
                    "conflict"
                } else {
                    "rejected"
                },
                Some(error.code),
                None,
            ),
        };
        let operation = Operation {
            operation_id: format!("otaop-{}", id()),
            request: request.clone(),
            request_digest,
            status: status.into(),
            reason,
            resource,
            created_at: now,
        };
        self.ota_registry
            .operations
            .insert(request.idempotency_key, operation.clone());
        Ok(operation)
    }
    fn apply_ota_change_once(
        &mut self,
        change: &Change,
        now: DateTime<Utc>,
    ) -> Result<ResourceRef> {
        match change {
            Change::TrustAdd {
                trust,
                expected_signing_key_id,
            } => {
                ota::check_trust(trust, now)?;
                ensure(
                    trust.signing_key_id == *expected_signing_key_id,
                    "signing_key_confirmation_mismatch",
                )?;
                let key = trust_id(trust)?;
                if let Some(record) = self.ota_registry.trusts.get(&key) {
                    ensure(record.active, "ota_trust_revoked")?;
                    return Ok(trust_ref(record));
                }
                ensure(
                    self.ota_registry.trusts.len() < MAX_TRUSTS,
                    "ota_trust_capacity",
                )?;
                let record = FirmwareTrust {
                    trust_id: key.clone(),
                    revision: id(),
                    trust: *trust.clone(),
                    active: true,
                    created_at: now,
                    revoked_at: None,
                };
                let reference = trust_ref(&record);
                self.ota_registry.trusts.insert(key, record);
                Ok(reference)
            }
            Change::TrustRevoke {
                trust_id,
                expected_revision,
            } => {
                let record = self
                    .ota_registry
                    .trusts
                    .get_mut(trust_id)
                    .ok_or_else(|| err("ota_trust_not_found"))?;
                ensure(record.revision == *expected_revision, "revision_conflict")?;
                ensure(record.active, "ota_trust_revoked")?;
                record.active = false;
                record.revoked_at = Some(now);
                record.revision = id();
                let reference = trust_ref(record);
                for task in self
                    .ota_registry
                    .tasks
                    .values_mut()
                    .filter(|task| task.trust_id == *trust_id && task.status.active())
                {
                    if task.status.pending() {
                        task.status = Status::Invalidated;
                        task.approval = None;
                    } else if task
                        .execution
                        .as_ref()
                        .is_some_and(|e| e.attempted_at.is_some())
                    {
                        task.status = Status::Unknown;
                    } else {
                        task.status = Status::Failed;
                    }
                    if let Some(execution) = &mut task.execution {
                        if let Some(query) = &mut execution.query {
                            query.attempted = true;
                        }
                    }
                    task.reason = Some("ota_trust_revoked".into());
                    task.revision = id();
                }
                Ok(reference)
            }
            Change::Plan {
                device_id,
                trust_id,
                manifest,
                expires_at,
            } => {
                ensure(
                    *expires_at > now && *expires_at <= now + Duration::minutes(15),
                    "ota_task_expired",
                )?;
                ensure(
                    self.ota_registry.tasks.len() < MAX_TASKS,
                    "ota_task_capacity",
                )?;
                ensure(
                    !self
                        .ota_registry
                        .tasks
                        .values()
                        .any(|task| task.device_id == *device_id && task.status.active()),
                    "ota_task_conflict",
                )?;
                let trust = self.active_ota_trust(trust_id)?;
                let baseline = self.current_device_info(device_id, now)?.clone();
                self.check_ota_commands(device_id)?;
                ota::check_request(
                    &ota::Request {
                        manifest: *manifest.clone(),
                        trust: trust.trust.clone(),
                        device: baseline.device.clone(),
                    },
                    now,
                )?;
                let task = Task {
                    task_id: format!("ota-{}", id()),
                    revision: id(),
                    device_id: device_id.clone(),
                    trust_id: trust_id.clone(),
                    trust_revision: trust.revision.clone(),
                    manifest: *manifest.clone(),
                    manifest_digest: digest(manifest)?,
                    baseline,
                    created_at: now,
                    expires_at: *expires_at,
                    status: Status::Planned,
                    approval: None,
                    execution: None,
                    reason: None,
                };
                let reference = task_ref(&task);
                self.ota_registry.tasks.insert(task.task_id.clone(), task);
                Ok(reference)
            }
            Change::Approve {
                task_id,
                expected_revision,
            } => {
                let task = self
                    .ota_registry
                    .tasks
                    .get(task_id)
                    .ok_or_else(|| err("ota_task_not_found"))?;
                ensure(task.revision == *expected_revision, "revision_conflict")?;
                ensure(task.status == Status::Planned, "invalid_ota_transition")?;
                self.current_ota_request(task, now)?;
                let observation = self.current_device_info(&task.device_id, now)?.clone();
                let task = self.ota_registry.tasks.get_mut(task_id).unwrap();
                task.status = Status::Approved;
                task.approval = Some(Approval {
                    approved_at: now,
                    device_info: observation,
                });
                task.reason = None;
                task.revision = id();
                Ok(task_ref(task))
            }
            Change::Execute {
                task_id,
                expected_revision,
            } => self.begin_ota_execution(task_id, expected_revision, now),
            Change::Reconcile {
                task_id,
                expected_revision,
            } => self.reconcile_ota_execution(task_id, expected_revision, now),
            Change::Cancel {
                task_id,
                expected_revision,
            } => {
                let task = self
                    .ota_registry
                    .tasks
                    .get_mut(task_id)
                    .ok_or_else(|| err("ota_task_not_found"))?;
                ensure(task.revision == *expected_revision, "revision_conflict")?;
                ensure(task.status.pending(), "invalid_ota_transition")?;
                task.status = Status::Cancelled;
                task.approval = None;
                task.reason = None;
                task.revision = id();
                Ok(task_ref(task))
            }
        }
    }
    fn active_ota_trust(&self, id: &str) -> Result<&FirmwareTrust> {
        let trust = self
            .ota_registry
            .trusts
            .get(id)
            .ok_or_else(|| err("ota_trust_not_found"))?;
        ensure(trust.active, "ota_trust_revoked")?;
        Ok(trust)
    }
    fn check_ota_commands(&self, device_id: &str) -> Result<()> {
        ensure(
            !self.commands.values().any(|command| {
                command.request.device_id == device_id
                    && matches!(
                        command.status.as_str(),
                        "accepted" | "dispatched" | "unknown"
                    )
            }),
            "ota_commands_pending",
        )
    }
    pub(crate) fn current_ota_request(
        &self,
        task: &Task,
        now: DateTime<Utc>,
    ) -> Result<ota::Request> {
        ensure(
            now >= task.created_at && now < task.expires_at,
            "ota_task_expired",
        )?;
        let trust = self.active_ota_trust(&task.trust_id)?;
        ensure(trust.revision == task.trust_revision, "ota_trust_changed")?;
        let info = self.current_device_info(&task.device_id, now)?;
        ensure(
            same_target(&task.baseline.device, &info.device),
            "ota_device_changed",
        )?;
        self.check_ota_commands(&task.device_id)?;
        let request = ota::Request {
            manifest: task.manifest.clone(),
            trust: trust.trust.clone(),
            device: info.device.clone(),
        };
        ota::check_request(&request, now)?;
        Ok(request)
    }
    // 明确执行前的实时预检；批准本身不会触发设备操作。
    pub fn approved_ota_request(&self, task_id: &str, now: DateTime<Utc>) -> Result<ota::Request> {
        let task = self
            .ota_registry
            .tasks
            .get(task_id)
            .ok_or_else(|| err("ota_task_not_found"))?;
        ensure(task.status == Status::Approved, "ota_approval_required")?;
        let approval = task
            .approval
            .as_ref()
            .ok_or_else(|| err("ota_approval_required"))?;
        ensure(now >= approval.approved_at, "invalid_ota_time")?;
        let request = self.current_ota_request(task, now)?;
        let info = self.current_device_info(&task.device_id, now)?;
        ensure(
            info.boot_id == approval.device_info.boot_id
                && info.session_id == approval.device_info.session_id,
            "ota_session_changed",
        )?;
        Ok(request)
    }
    pub fn ota_reserves_device(&self, device_id: &str, now: DateTime<Utc>) -> bool {
        self.ota_registry
            .tasks
            .values()
            .any(|task| task.device_id == device_id && task.status.reserves(task.expires_at, now))
    }
    pub(crate) fn expire_ota_tasks(&mut self, now: DateTime<Utc>) {
        for task in self
            .ota_registry
            .tasks
            .values_mut()
            .filter(|task| task.status.pending() && task.expires_at <= now)
        {
            task.status = Status::Expired;
            task.approval = None;
            task.reason = Some("ota_task_expired".into());
            task.revision = id();
        }
    }
    pub(crate) fn reset_ota_approvals(&mut self, device: Option<&str>, reason: &str) {
        self.interrupt_ota_executions(device, reason);
        for task in self.ota_registry.tasks.values_mut().filter(|task| {
            task.status == Status::Approved && device.is_none_or(|id| task.device_id == id)
        }) {
            task.status = Status::Planned;
            task.approval = None;
            task.reason = Some(reason.into());
            task.revision = id();
        }
    }
    pub fn validate_ota_registry(&self) -> Result<()> {
        let registry = &self.ota_registry;
        ensure(
            registry.trusts.len() <= MAX_TRUSTS
                && registry.tasks.len() <= MAX_TASKS
                && registry.operations.len() <= MAX_OPERATIONS,
            "storage_corrupt",
        )?;
        for (key, record) in &registry.trusts {
            ensure(
                *key == record.trust_id
                    && *key == trust_id(&record.trust)?
                    && identifier(&record.revision)
                    && record.active == record.revoked_at.is_none()
                    && record.revoked_at.is_none_or(|at| at >= record.created_at),
                "storage_corrupt",
            )?;
            ota::check_trust(&record.trust, record.created_at)?;
        }
        let mut active_devices = std::collections::BTreeSet::new();
        for (key, task) in &registry.tasks {
            let trust = registry
                .trusts
                .get(&task.trust_id)
                .ok_or_else(|| err("storage_corrupt"))?;
            ensure(
                *key == task.task_id
                    && identifier(key)
                    && identifier(&task.revision)
                    && identifier(&task.trust_revision)
                    && self.devices.contains_key(&task.device_id)
                    && task.device_id == task.baseline.device.device_id
                    && task.expires_at > task.created_at
                    && task.expires_at <= task.created_at + Duration::minutes(15)
                    && task.manifest_digest == digest(&task.manifest)?
                    && task.baseline.received_at <= task.created_at
                    && task.created_at - task.baseline.received_at < Duration::seconds(5)
                    && identifier(&task.baseline.boot_id)
                    && identifier(&task.baseline.session_id)
                    && task.baseline.seq <= 9_007_199_254_740_991
                    && (task.status == Status::Approved || task.execution.is_some())
                        == task.approval.is_some(),
                "storage_corrupt",
            )?;
            ota::check_request(
                &ota::Request {
                    manifest: task.manifest.clone(),
                    trust: trust.trust.clone(),
                    device: task.baseline.device.clone(),
                },
                task.created_at,
            )?;
            if task.status.active() {
                ensure(
                    (!task.status.pending()
                        || trust.active && trust.revision == task.trust_revision)
                        && active_devices.insert(&task.device_id),
                    "storage_corrupt",
                )?;
            }
            self.validate_ota_execution(task)?;
            if let Some(approval) = &task.approval {
                let observed = &approval.device_info;
                ensure(
                    approval.approved_at >= task.created_at
                        && approval.approved_at < task.expires_at
                        && identifier(&observed.boot_id)
                        && identifier(&observed.session_id)
                        && observed.seq <= 9_007_199_254_740_991
                        && observed.received_at <= approval.approved_at
                        && approval.approved_at - observed.received_at < Duration::seconds(5)
                        && same_target(&task.baseline.device, &observed.device),
                    "storage_corrupt",
                )?;
                ota::check_request(
                    &ota::Request {
                        manifest: task.manifest.clone(),
                        trust: trust.trust.clone(),
                        device: observed.device.clone(),
                    },
                    approval.approved_at,
                )?;
            }
        }
        for (key, operation) in &registry.operations {
            ensure(
                *key == operation.request.idempotency_key
                    && identifier(key)
                    && operation.request.space_id == self.space_id
                    && operation.request_digest == digest(&operation.request)?
                    && identifier(&operation.operation_id)
                    && matches!(
                        operation.status.as_str(),
                        "applied" | "rejected" | "conflict"
                    )
                    && (operation.status == "applied") == operation.resource.is_some()
                    && (operation.status == "applied") == operation.reason.is_none(),
                "storage_corrupt",
            )?;
            if let Some(resource) = &operation.resource {
                ensure(identifier(&resource.revision), "storage_corrupt")?;
                ensure(
                    match (&operation.request.change, resource.kind.as_str()) {
                        (Change::TrustAdd { trust, .. }, "firmware_trust") => {
                            resource.id == trust_id(trust)?
                                && registry.trusts.contains_key(&resource.id)
                        }
                        (Change::TrustRevoke { trust_id, .. }, "firmware_trust") => {
                            resource.id == *trust_id && registry.trusts.contains_key(&resource.id)
                        }
                        (
                            Change::Plan {
                                device_id,
                                manifest,
                                ..
                            },
                            "ota_task",
                        ) => registry.tasks.get(&resource.id).is_some_and(|task| {
                            task.device_id == *device_id
                                && digest(manifest).ok().as_ref() == Some(&task.manifest_digest)
                        }),
                        (
                            Change::Approve { task_id, .. }
                            | Change::Cancel { task_id, .. }
                            | Change::Execute { task_id, .. }
                            | Change::Reconcile { task_id, .. },
                            "ota_task",
                        ) => resource.id == *task_id && registry.tasks.contains_key(&resource.id),
                        _ => false,
                    },
                    "storage_corrupt",
                )?;
            }
        }
        Ok(())
    }
}
