//! OTA 的耐久发送意图和设备证据；传输层不得自行重试安装。
use crate::{
    digest,
    engine::Data,
    ensure, err, id, identifier,
    ota::Manifest,
    ota_tasks::{task_ref, ResourceRef, Status, Task},
    protocol::{Envelope, MAX_PACKET},
    Result,
};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Install {
    pub task_id: String,
    pub execution_id: String,
    pub manifest_digest: String,
    pub manifest: Manifest,
    pub expires_at: DateTime<Utc>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QueryBody {
    pub task_id: String,
    pub execution_id: String,
    pub request_digest: String,
    pub manifest_digest: String,
    pub expires_at: DateTime<Utc>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReceiptStatus {
    Installing,
    AwaitingBoot,
    Succeeded,
    Rejected,
    Failed,
    RolledBack,
}
impl ReceiptStatus {
    fn rank(self) -> u8 {
        match self {
            Self::Installing => 1,
            Self::AwaitingBoot => 2,
            _ => 3,
        }
    }
    fn task_status(self) -> Status {
        match self {
            Self::Installing | Self::AwaitingBoot => Status::Executing,
            Self::Succeeded => Status::Succeeded,
            _ => Status::Failed,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Receipt {
    pub task_id: String,
    pub execution_id: String,
    pub request_digest: String,
    pub manifest_digest: String,
    pub status: ReceiptStatus,
    pub firmware_version: String,
    pub security_epoch: u32,
    pub image_sha256: String,
    pub pending_update: bool,
    pub error: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Evidence {
    pub envelope: Envelope,
    pub received_at: DateTime<Utc>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Query {
    pub envelope: Envelope,
    pub prepared_at: DateTime<Utc>,
    // 在实际发送前提交；恢复后同样置为true，查询也不自动补发。
    pub attempted: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Execution {
    pub envelope: Envelope,
    pub request_digest: String,
    pub prepared_at: DateTime<Utc>,
    pub attempted_at: Option<DateTime<Utc>>,
    pub receipt: Option<Evidence>,
    pub query: Option<Query>,
    pub query_count: u8,
}
fn packet(envelope: &Envelope) -> Result<()> {
    let raw = serde_json::to_vec(envelope).map_err(|_| err("invalid_ota_execution"))?;
    ensure(raw.len() <= MAX_PACKET, "ota_packet_too_large")?;
    Envelope::decode(&raw)?;
    Ok(())
}
fn receipt(task: &Task, evidence: &Evidence) -> Result<Receipt> {
    let execution = task
        .execution
        .as_ref()
        .ok_or_else(|| err("invalid_ota_execution"))?;
    let install: Install = serde_json::from_value(execution.envelope.body.clone())
        .map_err(|_| err("invalid_ota_execution"))?;
    let message = &evidence.envelope;
    packet(message)?;
    let value: Receipt =
        serde_json::from_value(message.body.clone()).map_err(|_| err("invalid_ota_receipt"))?;
    ensure(
        message.kind == "ota_result"
            && message.device_id == task.device_id
            && message.model_revision == task.baseline.device.model_revision
            && message.boot_id.as_deref().is_some_and(identifier)
            && message.session_id.as_deref().is_some_and(identifier)
            && message.seq.is_some()
            && value.task_id == task.task_id
            && value.execution_id == install.execution_id
            && value.request_digest == execution.request_digest
            && value.manifest_digest == task.manifest_digest
            && execution
                .attempted_at
                .is_some_and(|at| evidence.received_at >= at)
            && value.image_sha256.len() == 71
            && value.image_sha256.starts_with("sha256:")
            && value.image_sha256[7..]
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        "invalid_ota_receipt",
    )?;
    let success = value.status == ReceiptStatus::Succeeded;
    let failed = matches!(
        value.status,
        ReceiptStatus::Rejected | ReceiptStatus::Failed | ReceiptStatus::RolledBack
    );
    ensure(
        failed == value.error.is_some()
            && value.error.as_ref().is_none_or(|error| {
                !error.is_empty()
                    && error.len() <= 64
                    && error.as_bytes()[0].is_ascii_lowercase()
                    && error
                        .bytes()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
            })
            && !value.pending_update
            && value.firmware_version.as_str()
                == if success {
                    &task.manifest.statement.version
                } else {
                    &task.baseline.device.firmware_version
                }
            && value.security_epoch
                == if success {
                    task.manifest.statement.security_epoch
                } else {
                    task.baseline.device.security_epoch
                },
        "invalid_ota_receipt",
    )?;
    if success {
        ensure(
            value.image_sha256 == task.manifest.statement.sha256
                && message.boot_id != execution.envelope.boot_id,
            "invalid_ota_receipt",
        )?;
    } else if value.status == ReceiptStatus::RolledBack {
        ensure(
            message.boot_id != execution.envelope.boot_id,
            "invalid_ota_receipt",
        )?;
    } else if !failed {
        ensure(
            message.boot_id == execution.envelope.boot_id,
            "invalid_ota_receipt",
        )?;
    }
    Ok(value)
}
impl Data {
    pub(crate) fn begin_ota_execution(
        &mut self,
        task_id: &str,
        revision: &str,
        now: DateTime<Utc>,
    ) -> Result<ResourceRef> {
        let task = self
            .ota_registry
            .tasks
            .get(task_id)
            .ok_or_else(|| err("ota_task_not_found"))?;
        ensure(task.revision == revision, "revision_conflict")?;
        self.approved_ota_request(task_id, now)?;
        ensure(task.execution.is_none(), "invalid_ota_transition")?;
        let approval = task.approval.as_ref().unwrap();
        let envelope = Envelope {
            v: 1,
            kind: "ota_install".into(),
            message_id: id(),
            device_id: task.device_id.clone(),
            model_revision: task.baseline.device.model_revision.clone(),
            boot_id: Some(approval.device_info.boot_id.clone()),
            seq: None,
            session_id: Some(approval.device_info.session_id.clone()),
            body: serde_json::to_value(Install {
                task_id: task_id.into(),
                execution_id: format!("otaexec-{}", id()),
                manifest_digest: task.manifest_digest.clone(),
                manifest: task.manifest.clone(),
                expires_at: task.expires_at,
            })
            .map_err(|_| err("invalid_ota_execution"))?,
        };
        packet(&envelope)?;
        let execution = Execution {
            request_digest: digest(&envelope)?,
            envelope,
            prepared_at: now,
            attempted_at: None,
            receipt: None,
            query: None,
            query_count: 0,
        };
        let task = self.ota_registry.tasks.get_mut(task_id).unwrap();
        task.execution = Some(execution);
        task.status = Status::Executing;
        task.reason = None;
        task.revision = id();
        Ok(task_ref(task))
    }
    pub(crate) fn reconcile_ota_execution(
        &mut self,
        task_id: &str,
        revision: &str,
        now: DateTime<Utc>,
    ) -> Result<ResourceRef> {
        let task = self
            .ota_registry
            .tasks
            .get(task_id)
            .ok_or_else(|| err("ota_task_not_found"))?;
        ensure(task.revision == revision, "revision_conflict")?;
        ensure(
            matches!(task.status, Status::Executing | Status::Unknown),
            "invalid_ota_transition",
        )?;
        let execution = task
            .execution
            .as_ref()
            .ok_or_else(|| err("invalid_ota_execution"))?;
        ensure(
            execution.attempted_at.is_some_and(|at| now >= at),
            "ota_not_dispatched",
        )?;
        ensure(execution.query_count < 32, "ota_query_capacity")?;
        ensure(
            execution.query.as_ref().is_none_or(|query| query.attempted),
            "ota_query_pending",
        )?;
        let install: Install = serde_json::from_value(execution.envelope.body.clone())
            .map_err(|_| err("invalid_ota_execution"))?;
        let device = &self.devices[&task.device_id];
        ensure(
            device.ready
                && device
                    .last_seen
                    .is_some_and(|at| now >= at && now - at < Duration::seconds(15)),
            "device_offline",
        )?;
        self.check_model_authority(&task.device_id)?;
        let envelope = Envelope {
            v: 1,
            kind: "ota_query".into(),
            message_id: id(),
            device_id: task.device_id.clone(),
            model_revision: device.model_revision.clone(),
            boot_id: device.boot_id.clone(),
            seq: None,
            session_id: device.session_id.clone(),
            body: serde_json::to_value(QueryBody {
                task_id: task_id.into(),
                execution_id: install.execution_id,
                request_digest: execution.request_digest.clone(),
                manifest_digest: task.manifest_digest.clone(),
                expires_at: now + Duration::seconds(30),
            })
            .map_err(|_| err("invalid_ota_execution"))?,
        };
        packet(&envelope)?;
        let task = self.ota_registry.tasks.get_mut(task_id).unwrap();
        let execution = task.execution.as_mut().unwrap();
        execution.query = Some(Query {
            envelope,
            prepared_at: now,
            attempted: false,
        });
        execution.query_count += 1;
        task.revision = id();
        Ok(task_ref(task))
    }
    // 本函数的输出必须随快照成功提交后才能发布；返回一次即视为可能已发送。
    pub fn prepare_ota_dispatch(&mut self, now: DateTime<Utc>) -> Vec<Envelope> {
        let ids: Vec<_> = self.ota_registry.tasks.keys().cloned().collect();
        let mut messages = Vec::new();
        for key in ids {
            let task = &self.ota_registry.tasks[&key];
            if task.status == Status::Executing {
                let execution = task.execution.as_ref().unwrap();
                if execution.attempted_at.is_none() {
                    let check = self.current_ota_request(task, now).and_then(|_| {
                        ensure(now >= execution.prepared_at, "invalid_ota_time")?;
                        let info = self.current_device_info(&task.device_id, now)?;
                        ensure(
                            Some(&info.boot_id) == execution.envelope.boot_id.as_ref()
                                && Some(&info.session_id) == execution.envelope.session_id.as_ref(),
                            "ota_session_changed",
                        )
                    });
                    let task = self.ota_registry.tasks.get_mut(&key).unwrap();
                    match check {
                        Ok(()) => {
                            let execution = task.execution.as_mut().unwrap();
                            execution.attempted_at = Some(now);
                            messages.push(execution.envelope.clone());
                        }
                        Err(error) => {
                            task.status = Status::Failed;
                            task.reason = Some(error.code);
                        }
                    }
                    task.revision = id();
                } else if now >= task.expires_at {
                    let task = self.ota_registry.tasks.get_mut(&key).unwrap();
                    task.status = Status::Unknown;
                    task.reason = Some("ota_execution_unknown".into());
                    task.revision = id();
                }
            }
            let task = self.ota_registry.tasks.get_mut(&key).unwrap();
            let Some(execution) = task.execution.as_mut() else {
                continue;
            };
            let Some(query) = execution.query.as_mut().filter(|query| !query.attempted) else {
                continue;
            };
            let body: QueryBody = serde_json::from_value(query.envelope.body.clone()).unwrap();
            let device = &self.devices[&task.device_id];
            if matches!(task.status, Status::Executing | Status::Unknown)
                && now >= query.prepared_at
                && now < body.expires_at
                && device.ready
                && device.boot_id == query.envelope.boot_id
                && device.session_id == query.envelope.session_id
            {
                messages.push(query.envelope.clone());
            }
            query.attempted = true;
            task.revision = id();
        }
        messages
    }
    pub(crate) fn interrupt_ota_executions(&mut self, device: Option<&str>, reason: &str) {
        for task in self.ota_registry.tasks.values_mut().filter(|task| {
            matches!(task.status, Status::Executing | Status::Unknown)
                && device.is_none_or(|device| device == task.device_id)
        }) {
            let execution = task.execution.as_mut().unwrap();
            // 已提交发送意图后即使没有任何回执，也只能保留未知与设备占用。
            task.status = if execution.attempted_at.is_some() {
                Status::Unknown
            } else {
                Status::Failed
            };
            if let Some(query) = &mut execution.query {
                query.attempted = true;
            }
            task.reason = Some(reason.into());
            task.revision = id();
        }
    }
    pub(crate) fn apply_ota_receipt(
        &mut self,
        envelope: &Envelope,
        now: DateTime<Utc>,
    ) -> Result<()> {
        let task_id = envelope.body["task_id"]
            .as_str()
            .ok_or_else(|| err("invalid_ota_receipt"))?;
        let task = self
            .ota_registry
            .tasks
            .get(task_id)
            .ok_or_else(|| err("ota_task_not_found"))?;
        let evidence = Evidence {
            envelope: envelope.clone(),
            received_at: now,
        };
        let value = receipt(task, &evidence)?;
        if let Some(previous) = task
            .execution
            .as_ref()
            .and_then(|execution| execution.receipt.as_ref())
        {
            let old = receipt(task, previous)?;
            if digest(&old)? == digest(&value)? {
                return Ok(());
            }
            ensure(
                old.status.rank() < 3 && value.status.rank() > old.status.rank(),
                "ota_receipt_conflict",
            )?;
        }
        ensure(
            matches!(task.status, Status::Executing | Status::Unknown),
            "invalid_ota_transition",
        )?;
        let task = self.ota_registry.tasks.get_mut(task_id).unwrap();
        task.status = value.status.task_status();
        task.reason = value.error;
        task.revision = id();
        let execution = task.execution.as_mut().unwrap();
        execution.receipt = Some(evidence);
        if let Some(query) = &mut execution.query {
            query.attempted = true;
        }
        self.devices
            .get_mut(&envelope.device_id)
            .unwrap()
            .device_info = None;
        Ok(())
    }
    pub(crate) fn validate_ota_execution(&self, task: &Task) -> Result<()> {
        let Some(execution) = &task.execution else {
            return ensure(
                !matches!(
                    task.status,
                    Status::Executing | Status::Unknown | Status::Succeeded | Status::Failed
                ),
                "storage_corrupt",
            );
        };
        ensure(
            matches!(
                task.status,
                Status::Executing | Status::Unknown | Status::Succeeded | Status::Failed
            ),
            "storage_corrupt",
        )?;
        let approval = task
            .approval
            .as_ref()
            .ok_or_else(|| err("storage_corrupt"))?;
        let envelope = &execution.envelope;
        packet(envelope)?;
        let body: Install =
            serde_json::from_value(envelope.body.clone()).map_err(|_| err("storage_corrupt"))?;
        ensure(
            envelope.kind == "ota_install"
                && envelope.device_id == task.device_id
                && envelope.model_revision == task.baseline.device.model_revision
                && envelope.seq.is_none()
                && envelope.boot_id.as_ref() == Some(&approval.device_info.boot_id)
                && envelope.session_id.as_ref() == Some(&approval.device_info.session_id)
                && body.task_id == task.task_id
                && identifier(&body.execution_id)
                && body.execution_id.starts_with("otaexec-")
                && body.manifest_digest == task.manifest_digest
                && digest(&body.manifest)? == task.manifest_digest
                && body.expires_at == task.expires_at
                && execution.request_digest == digest(envelope)?
                && execution.prepared_at >= approval.approved_at
                && execution.prepared_at < task.expires_at
                && execution
                    .attempted_at
                    .is_none_or(|at| at >= execution.prepared_at && at < task.expires_at)
                && execution.query_count <= 32
                && (execution.query_count > 0) == execution.query.is_some(),
            "storage_corrupt",
        )?;
        if task.status == Status::Unknown {
            ensure(execution.attempted_at.is_some(), "storage_corrupt")?;
        }
        if let Some(evidence) = &execution.receipt {
            let value = receipt(task, evidence)?;
            ensure(
                task.status == value.status.task_status()
                    || task.status == Status::Unknown && value.status.rank() < 3,
                "storage_corrupt",
            )?;
        } else {
            ensure(
                task.status != Status::Succeeded
                    && (task.status != Status::Failed || execution.attempted_at.is_none()),
                "storage_corrupt",
            )?;
        }
        if let Some(query) = &execution.query {
            packet(&query.envelope)?;
            let body: QueryBody = serde_json::from_value(query.envelope.body.clone())
                .map_err(|_| err("storage_corrupt"))?;
            ensure(
                execution
                    .attempted_at
                    .is_some_and(|at| query.prepared_at >= at)
                    && query.envelope.kind == "ota_query"
                    && query.envelope.device_id == task.device_id
                    && query.envelope.model_revision == task.baseline.device.model_revision
                    && query.envelope.seq.is_none()
                    && query.envelope.boot_id.as_deref().is_some_and(identifier)
                    && query.envelope.session_id.as_deref().is_some_and(identifier)
                    && body.task_id == task.task_id
                    && body.execution_id
                        == serde_json::from_value::<Install>(envelope.body.clone())
                            .unwrap()
                            .execution_id
                    && body.request_digest == execution.request_digest
                    && body.manifest_digest == task.manifest_digest
                    && body.expires_at == query.prepared_at + Duration::seconds(30),
                "storage_corrupt",
            )?;
        }
        Ok(())
    }
}
