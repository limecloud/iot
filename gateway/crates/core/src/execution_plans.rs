//! 本地所有者授权的有界编排；子命令沿用原账本，不提供物理事务、节拍或抢占停止。
use crate::{
    device_events::DeviceEvent,
    digest,
    engine::Data,
    ensure, err, id, identifier,
    protocol::{CommandRequest, Operation as DeviceOperation},
    validation::bounded_document,
    Result,
};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet};

pub const MAX_PLANS: usize = 128;
pub const MAX_OPERATIONS: usize = 1024;
pub const MAX_DEVICES: usize = 8;
pub const MAX_STEPS: usize = 16;
pub const MAX_DURATION_SECONDS: i64 = 900;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Completion {
    Command,
    Event { path: String, timeout_ms: u32 },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Step {
    pub step_id: String,
    pub device_id: String,
    pub model_revision: String,
    pub operation: DeviceOperation,
    pub command_timeout_ms: u32,
    pub completion: Completion,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Stage {
    pub steps: Vec<Step>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
pub enum Change {
    #[serde(rename = "plans.create")]
    Create {
        plan_id: String,
        generation: String,
        stages: Vec<Stage>,
        expires_at: DateTime<Utc>,
    },
    #[serde(rename = "plans.start")]
    Start {
        plan_id: String,
        expected_revision: String,
    },
    #[serde(rename = "plans.cancel")]
    Cancel {
        plan_id: String,
        expected_revision: String,
    },
    #[serde(rename = "plans.release")]
    Release {
        plan_id: String,
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
pub struct Binding {
    pub device_id: String,
    pub model_revision: String,
    pub boot_id: String,
    pub session_id: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Child {
    pub stage_index: usize,
    pub step_id: String,
    pub command_id: String,
    pub event_deadline: Option<DateTime<Utc>>,
    pub event: Option<DeviceEvent>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Plan {
    pub plan_id: String,
    pub generation: String,
    pub revision: String,
    pub definition_digest: String,
    pub stages: Vec<Stage>,
    pub bindings: BTreeMap<String, Binding>,
    pub expires_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
    pub started_at: Option<DateTime<Utc>>,
    pub ended_at: Option<DateTime<Utc>>,
    pub status: String,
    pub reason: Option<String>,
    pub current_stage: usize,
    pub children: Vec<Child>,
    pub physical_stop: String,
    pub released: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Resource {
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
    pub result: Option<Resource>,
    // 原决定的快照用于恢复时重算原revision；之后poll不会改写该结果。
    pub applied_snapshot: Option<Plan>,
    pub created_at: DateTime<Utc>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Registry {
    pub plans: BTreeMap<String, Plan>,
    pub operations: BTreeMap<String, Operation>,
    // 仅在同一确定性事务的stage受理中存在，不可由快照或外部run_id恢复。
    #[serde(skip)]
    admitting: Option<(String, String)>,
}
impl Registry {
    pub fn is_empty(&self) -> bool {
        self.plans.is_empty() && self.operations.is_empty()
    }
}

pub fn parse_change(raw: &[u8]) -> Result<Change> {
    let value =
        bounded_document(raw, 16_384, 20, 4_000).ok_or_else(|| err("invalid_plan_change"))?;
    let change: Change =
        serde_json::from_value(value.clone()).map_err(|_| err("invalid_plan_change"))?;
    ensure(digest(&change)? == digest(&value)?, "invalid_plan_change")?;
    validate_change_shape(&change)?;
    Ok(change)
}
fn valid_digest(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}
fn valid_path(value: &str) -> bool {
    value.split_once('.').is_some_and(|(service, member)| {
        crate::model::local_id(service) && crate::model::local_id(member)
    })
}
fn validate_change_shape(change: &Change) -> Result<()> {
    ensure(identifier(change_id(change)), "invalid_plan_change")?;
    ensure(
        serde_jcs::to_vec(change)
            .map_err(|_| err("invalid_plan_change"))?
            .len()
            <= 16_384,
        "invalid_plan_change",
    )?;
    match change {
        Change::Create {
            generation, stages, ..
        } => {
            ensure(
                identifier(generation) && !stages.is_empty() && stages.len() <= MAX_STEPS,
                "invalid_plan_change",
            )?;
            for stage in stages {
                ensure(
                    !stage.steps.is_empty() && stage.steps.len() <= MAX_DEVICES,
                    "invalid_plan_change",
                )?;
                for step in &stage.steps {
                    ensure(
                        identifier(&step.step_id)
                            && identifier(&step.device_id)
                            && valid_digest(&step.model_revision)
                            && valid_path(&step.operation.path)
                            && matches!(
                                step.operation.kind.as_str(),
                                "property.set" | "action.invoke"
                            )
                            && (1..=30_000).contains(&step.command_timeout_ms),
                        "invalid_plan_change",
                    )?;
                    if let Completion::Event { path, timeout_ms } = &step.completion {
                        ensure(
                            valid_path(path) && (1..=900_000).contains(timeout_ms),
                            "invalid_plan_change",
                        )?;
                    }
                }
            }
        }
        Change::Start {
            expected_revision, ..
        }
        | Change::Cancel {
            expected_revision, ..
        }
        | Change::Release {
            expected_revision, ..
        } => ensure(valid_digest(expected_revision), "invalid_plan_change")?,
    }
    Ok(())
}
fn change_id(change: &Change) -> &str {
    match change {
        Change::Create { plan_id, .. }
        | Change::Start { plan_id, .. }
        | Change::Cancel { plan_id, .. }
        | Change::Release { plan_id, .. } => plan_id,
    }
}
fn definition(plan: &Plan) -> Change {
    Change::Create {
        plan_id: plan.plan_id.clone(),
        generation: plan.generation.clone(),
        stages: plan.stages.clone(),
        expires_at: plan.expires_at,
    }
}
fn revision(plan: &Plan) -> Result<String> {
    let mut value = serde_json::to_value(plan).map_err(|_| err("invalid_plan"))?;
    value
        .as_object_mut()
        .ok_or_else(|| err("invalid_plan"))?
        .remove("revision");
    digest(&value)
}
fn refresh(plan: &mut Plan) -> Result<()> {
    plan.revision = revision(plan)?;
    Ok(())
}
fn terminal(status: &str) -> bool {
    matches!(
        status,
        "completed" | "failed" | "partial" | "cancelled" | "unknown"
    )
}
fn child_key(plan: &Plan, stage: usize, step: &Step) -> Result<String> {
    Ok(format!(
        "plan-{}",
        &digest(&json!({
            "plan_id":plan.plan_id,"generation":plan.generation,
            "stage":stage,"step_id":step.step_id
        }))?[7..]
    ))
}
fn issued(command: &crate::engine::Command) -> Result<DateTime<Utc>> {
    serde_json::from_value(command.envelope.body["issued_at"].clone())
        .map_err(|_| err("storage_corrupt"))
}

impl Data {
    pub fn has_pending_execution_plans(&self) -> bool {
        self.execution_plans
            .plans
            .values()
            .any(|plan| plan.status == "running")
    }
    pub fn execution_plan(&self, plan_id: &str) -> Result<&Plan> {
        self.execution_plans
            .plans
            .get(plan_id)
            .ok_or_else(|| err("execution_plan_not_found"))
    }
    pub fn execution_plan_operation(&self, key: &str) -> Result<&Operation> {
        self.execution_plans
            .operations
            .get(key)
            .ok_or_else(|| err("execution_plan_operation_not_found"))
    }
    pub fn execution_plan_reserves_device(&self, device_id: &str) -> bool {
        self.execution_plans
            .plans
            .values()
            .any(|p| p.started_at.is_some() && !p.released && p.bindings.contains_key(device_id))
    }
    pub fn check_plan_command(&self, device_id: &str, run_id: Option<&str>) -> Result<()> {
        if let Some(plan_id) = run_id.filter(|id| self.execution_plans.plans.contains_key(*id)) {
            let plan = &self.execution_plans.plans[plan_id];
            return ensure(
                plan.status == "running"
                    && !plan.released
                    && plan.bindings.contains_key(device_id)
                    && self
                        .execution_plans
                        .admitting
                        .as_ref()
                        .is_some_and(|(p, d)| p == plan_id && d == device_id),
                "plan_command_not_authorized",
            );
        }
        ensure(
            !self.execution_plan_reserves_device(device_id),
            "execution_plan_conflict",
        )
    }
    pub fn apply_plan_change(&mut self, request: Request, now: DateTime<Utc>) -> Result<Operation> {
        ensure(request.space_id == self.space_id, "forbidden")?;
        ensure(
            identifier(&request.idempotency_key),
            "invalid_idempotency_key",
        )?;
        validate_change_shape(&request.change)?;
        let request_digest = digest(&request)?;
        if let Some(previous) = self
            .execution_plans
            .operations
            .get(&request.idempotency_key)
        {
            ensure(
                previous.request_digest == request_digest,
                "idempotency_conflict",
            )?;
            return Ok(previous.clone());
        }
        ensure(
            self.execution_plans.operations.len() < MAX_OPERATIONS,
            "execution_plan_operation_capacity",
        )?;
        // 单个管理决定失败时不保留半成品，包括start的设备占用。
        let mut next = self.clone();
        let outcome = next.apply_plan_change_once(&request.change, now);
        let (status, reason, snapshot) = match outcome {
            Ok(plan) => {
                *self = next;
                ("applied", None, Some(plan))
            }
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
        let result = snapshot.as_ref().map(|plan| Resource {
            kind: "execution_plan".into(),
            id: plan.plan_id.clone(),
            revision: plan.revision.clone(),
        });
        let operation = Operation {
            operation_id: format!("planop-{}", id()),
            request: request.clone(),
            request_digest,
            status: status.into(),
            reason,
            result,
            applied_snapshot: snapshot,
            created_at: now,
        };
        self.execution_plans
            .operations
            .insert(request.idempotency_key, operation.clone());
        Ok(operation)
    }
    fn apply_plan_change_once(&mut self, change: &Change, now: DateTime<Utc>) -> Result<Plan> {
        if let Change::Create {
            plan_id,
            generation,
            stages,
            expires_at,
        } = change
        {
            ensure(
                self.execution_plans.plans.len() < MAX_PLANS,
                "execution_plan_capacity",
            )?;
            ensure(
                !self.execution_plans.plans.contains_key(plan_id),
                "plan_id_conflict",
            )?;
            ensure(
                !self.runs.contains_key(plan_id)
                    && !self
                        .commands
                        .values()
                        .any(|command| command.run_id.as_deref() == Some(plan_id)),
                "plan_id_conflict",
            )?;
            self.validate_plan_definition(plan_id, generation, stages, *expires_at, now)?;
            let mut bindings = BTreeMap::new();
            for step in stages.iter().flat_map(|stage| &stage.steps) {
                self.check_model_authority(&step.device_id)?;
                let device = self
                    .devices
                    .get(&step.device_id)
                    .ok_or_else(|| err("device_not_found"))?;
                ensure(
                    device.model_revision == step.model_revision,
                    "model_mismatch",
                )?;
                ensure(
                    !device.routes.contains_key(&step.operation.path),
                    "plan_native_only",
                )?;
                let session_id = self
                    .command_session(device, &step.operation.path, now)?
                    .ok_or_else(|| err("device_offline"))?;
                let boot_id = device
                    .boot_id
                    .clone()
                    .ok_or_else(|| err("device_offline"))?;
                bindings.insert(
                    step.device_id.clone(),
                    Binding {
                        device_id: step.device_id.clone(),
                        model_revision: step.model_revision.clone(),
                        boot_id,
                        session_id,
                    },
                );
            }
            let mut plan = Plan {
                plan_id: plan_id.clone(),
                generation: generation.clone(),
                revision: String::new(),
                definition_digest: digest(change)?,
                stages: stages.clone(),
                bindings,
                expires_at: *expires_at,
                created_at: now,
                started_at: None,
                ended_at: None,
                status: "draft".into(),
                reason: None,
                current_stage: 0,
                children: Vec::new(),
                physical_stop: "not_requested".into(),
                released: false,
            };
            refresh(&mut plan)?;
            self.execution_plans
                .plans
                .insert(plan_id.clone(), plan.clone());
            return Ok(plan);
        }
        let plan_id = change_id(change);
        let mut plan = self.execution_plan(plan_id)?.clone();
        let expected = match change {
            Change::Start {
                expected_revision, ..
            }
            | Change::Cancel {
                expected_revision, ..
            }
            | Change::Release {
                expected_revision, ..
            } => expected_revision,
            Change::Create { .. } => unreachable!(),
        };
        ensure(plan.revision == *expected, "revision_conflict")?;
        match change {
            Change::Start { .. } => {
                ensure(
                    plan.status == "draft" && plan.expires_at > now,
                    "plan_not_startable",
                )?;
                self.check_plan_bindings(&plan, now)?;
                for device_id in plan.bindings.keys() {
                    ensure(
                        !self.execution_plan_reserves_device(device_id),
                        "execution_plan_conflict",
                    )?;
                    ensure(
                        !self.ota_reserves_device(device_id, now),
                        "ota_task_conflict",
                    )?;
                    ensure(
                        !self.commands.values().any(|c| {
                            c.request.device_id == *device_id
                                && matches!(c.status.as_str(), "accepted" | "dispatched")
                        }),
                        "device_queue_busy",
                    )?;
                }
                plan.status = "running".into();
                plan.started_at = Some(now);
            }
            Change::Cancel { .. } => {
                ensure(
                    matches!(plan.status.as_str(), "draft" | "running"),
                    "plan_not_cancellable",
                )?;
                let effects = self.plan_may_have_effects(&plan);
                self.reject_plan_accepted(&plan, "plan_cancelled");
                plan.status = if effects { "unknown" } else { "cancelled" }.into();
                plan.physical_stop = if effects { "unknown" } else { "not_requested" }.into();
                plan.reason = Some("plan_cancelled".into());
                plan.ended_at = Some(now);
            }
            Change::Release { .. } => {
                ensure(
                    terminal(&plan.status) && !plan.released,
                    "plan_not_releasable",
                )?;
                plan.released = true;
            }
            Change::Create { .. } => unreachable!(),
        }
        refresh(&mut plan)?;
        self.execution_plans
            .plans
            .insert(plan_id.into(), plan.clone());
        Ok(plan)
    }
    fn validate_plan_definition(
        &self,
        plan_id: &str,
        generation: &str,
        stages: &[Stage],
        expires_at: DateTime<Utc>,
        created_at: DateTime<Utc>,
    ) -> Result<()> {
        ensure(
            identifier(plan_id) && identifier(generation),
            "invalid_plan_identity",
        )?;
        ensure(
            expires_at > created_at
                && expires_at <= created_at + Duration::seconds(MAX_DURATION_SECONDS),
            "invalid_plan_expiry",
        )?;
        let count: usize = stages.iter().map(|s| s.steps.len()).sum();
        ensure(
            !stages.is_empty() && stages.len() <= MAX_STEPS && count > 0 && count <= MAX_STEPS,
            "invalid_plan_bounds",
        )?;
        let mut step_ids = BTreeSet::new();
        let mut devices = BTreeSet::new();
        for stage in stages {
            let mut members = BTreeSet::new();
            ensure(!stage.steps.is_empty(), "invalid_plan_stage")?;
            for step in &stage.steps {
                ensure(
                    identifier(&step.step_id)
                        && step_ids.insert(&step.step_id)
                        && identifier(&step.device_id)
                        && members.insert(&step.device_id),
                    "invalid_plan_step",
                )?;
                devices.insert(&step.device_id);
                ensure(
                    (1..=30_000).contains(&step.command_timeout_ms),
                    "invalid_plan_command_timeout",
                )?;
                let model = self
                    .models
                    .get(&step.model_revision)
                    .ok_or_else(|| err("model_not_found"))?;
                model.operation(&step.operation)?;
                match &step.completion {
                    Completion::Command => {
                        if step.operation.kind == "action.invoke" {
                            ensure(
                                model.action(&step.operation.path)?.completion == "observed",
                                "plan_task_event_required",
                            )?;
                        }
                    }
                    Completion::Event { path, timeout_ms } => {
                        ensure(
                            step.operation.kind == "action.invoke"
                                && (1..=900_000).contains(timeout_ms),
                            "invalid_plan_event_gate",
                        )?;
                        let input = &step.operation.value;
                        ensure(
                            input["task_id"] == plan_id
                                && input["generation"] == generation
                                && input["step_id"] == step.step_id,
                            "plan_task_binding_mismatch",
                        )?;
                        let event = model.event(path)?;
                        // 通用终态事件采用一个小而严格的共同字段集合；产品可另外报告观测细节。
                        for status in ["completed", "failed"] {
                            event
                                .schema
                                .validate(&json!({"task_id":plan_id,"generation":generation,
                                "step_id":step.step_id,"status":status}))?;
                        }
                    }
                }
            }
        }
        ensure(devices.len() <= MAX_DEVICES, "invalid_plan_bounds")
    }
    fn check_plan_bindings(&self, plan: &Plan, now: DateTime<Utc>) -> Result<()> {
        for stage in &plan.stages {
            for step in &stage.steps {
                self.check_model_authority(&step.device_id)?;
                let binding = &plan.bindings[&step.device_id];
                let device = self
                    .devices
                    .get(&step.device_id)
                    .ok_or_else(|| err("device_not_found"))?;
                ensure(
                    device.model_revision == binding.model_revision
                        && device.boot_id.as_deref() == Some(&binding.boot_id)
                        && device.session_id.as_deref() == Some(&binding.session_id)
                        && !device.routes.contains_key(&step.operation.path)
                        && self
                            .command_session(device, &step.operation.path, now)?
                            .as_deref()
                            == Some(&binding.session_id),
                    "plan_session_changed",
                )?;
            }
        }
        Ok(())
    }
    fn reject_plan_accepted(&mut self, plan: &Plan, reason: &str) {
        for child in &plan.children {
            if let Some(command) = self.commands.get_mut(&child.command_id) {
                if command.status == "accepted" {
                    command.status = "rejected".into();
                    command.error = Some(reason.into());
                }
            }
        }
    }
    fn plan_may_have_effects(&self, plan: &Plan) -> bool {
        plan.children.iter().any(|child| {
            self.commands
                .get(&child.command_id)
                .is_some_and(|c| !matches!(c.status.as_str(), "accepted" | "rejected" | "expired"))
        })
    }
    fn step_for<'a>(plan: &'a Plan, child: &Child) -> Result<&'a Step> {
        plan.stages
            .get(child.stage_index)
            .and_then(|s| s.steps.iter().find(|s| s.step_id == child.step_id))
            .ok_or_else(|| err("storage_corrupt"))
    }
    fn child_complete(&self, plan: &Plan, child: &Child) -> bool {
        let Some(command) = self.commands.get(&child.command_id) else {
            return false;
        };
        if command.status != "confirmed" {
            return false;
        }
        match Self::step_for(plan, child).map(|s| &s.completion) {
            Ok(Completion::Command) => true,
            Ok(Completion::Event { .. }) => child
                .event
                .as_ref()
                .is_some_and(|e| e.data["status"] == "completed"),
            Err(_) => false,
        }
    }
    fn finish_plan(
        &mut self,
        mut plan: Plan,
        reason: &str,
        unknown: bool,
        now: DateTime<Utc>,
    ) -> Result<()> {
        let effects = self.plan_may_have_effects(&plan);
        self.reject_plan_accepted(&plan, reason);
        plan.status = if unknown {
            "unknown"
        } else if effects {
            "partial"
        } else {
            "failed"
        }
        .into();
        plan.physical_stop = if effects || unknown {
            "unknown"
        } else {
            "not_requested"
        }
        .into();
        plan.reason = Some(reason.into());
        plan.ended_at = Some(now);
        refresh(&mut plan)?;
        self.execution_plans
            .plans
            .insert(plan.plan_id.clone(), plan);
        Ok(())
    }
    pub fn poll_execution_plans(&mut self, now: DateTime<Utc>) -> Result<()> {
        let mut next = self.clone();
        let ids: Vec<_> = next
            .execution_plans
            .plans
            .values()
            .filter(|p| p.status == "running")
            .map(|p| p.plan_id.clone())
            .collect();
        for plan_id in ids {
            next.poll_execution_plan(&plan_id, now)?;
        }
        *self = next;
        Ok(())
    }
    fn poll_execution_plan(&mut self, plan_id: &str, now: DateTime<Utc>) -> Result<()> {
        for _ in 0..=MAX_STEPS {
            let mut plan = self.execution_plan(plan_id)?.clone();
            if plan.status != "running" {
                return Ok(());
            }
            if now >= plan.expires_at {
                return self.finish_plan(plan, "plan_expired", true, now);
            }
            if let Err(error) = self.check_plan_bindings(&plan, now) {
                let unknown = self.plan_may_have_effects(&plan);
                return self.finish_plan(plan, &error.code, unknown, now);
            }
            let children: Vec<_> = plan
                .children
                .iter()
                .filter(|c| c.stage_index == plan.current_stage)
                .cloned()
                .collect();
            if children.is_empty() {
                // 每个stage全部受理或全部不受理，不给第一台留下孤立命令。
                let mut stage_data = self.clone();
                let mut stage_plan = plan.clone();
                for step in &plan.stages[plan.current_stage].steps {
                    stage_data.execution_plans.admitting =
                        Some((plan.plan_id.clone(), step.device_id.clone()));
                    let request = CommandRequest {
                        space_id: self.space_id.clone(),
                        device_id: step.device_id.clone(),
                        model_revision: step.model_revision.clone(),
                        idempotency_key: child_key(&plan, plan.current_stage, step)?,
                        expires_at: std::cmp::min(
                            now + Duration::milliseconds(i64::from(step.command_timeout_ms)),
                            plan.expires_at,
                        ),
                        operation: step.operation.clone(),
                    };
                    if stage_data.keys.contains_key(&request.idempotency_key) {
                        return self.finish_plan(
                            plan.clone(),
                            "plan_child_key_conflict",
                            false,
                            now,
                        );
                    }
                    let command =
                        match stage_data.create_command(request, now, Some(plan.plan_id.clone())) {
                            Ok(command) => command,
                            Err(error) => {
                                return self.finish_plan(plan.clone(), &error.code, false, now)
                            }
                        };
                    stage_data.execution_plans.admitting = None;
                    stage_plan.children.push(Child {
                        stage_index: plan.current_stage,
                        step_id: step.step_id.clone(),
                        command_id: command.command_id,
                        event_deadline: match step.completion {
                            Completion::Command => None,
                            Completion::Event { timeout_ms, .. } => Some(std::cmp::min(
                                now + Duration::milliseconds(i64::from(timeout_ms)),
                                plan.expires_at,
                            )),
                        },
                        event: None,
                    });
                }
                refresh(&mut stage_plan)?;
                stage_data
                    .execution_plans
                    .plans
                    .insert(plan_id.into(), stage_plan);
                *self = stage_data;
                return Ok(());
            }
            for child in &children {
                let command = self
                    .commands
                    .get_mut(&child.command_id)
                    .ok_or_else(|| err("storage_corrupt"))?;
                if command.request.expires_at <= now
                    && matches!(command.status.as_str(), "accepted" | "dispatched")
                {
                    command.status = if command.status == "accepted" {
                        "expired"
                    } else {
                        "unknown"
                    }
                    .into();
                    command.error = Some(
                        if command.status == "expired" {
                            "command_expired"
                        } else {
                            "execution_unknown"
                        }
                        .into(),
                    );
                }
            }
            if children
                .iter()
                .any(|c| self.commands[&c.command_id].status == "unknown")
            {
                return self.finish_plan(plan, "plan_child_unknown", true, now);
            }
            if children.iter().any(|c| {
                matches!(
                    self.commands[&c.command_id].status.as_str(),
                    "failed" | "expired" | "rejected"
                ) || c
                    .event
                    .as_ref()
                    .is_some_and(|e| e.data["status"] == "failed")
            }) {
                return self.finish_plan(plan, "plan_child_failed", false, now);
            }
            if children.iter().any(|c| {
                c.event.is_none() && c.event_deadline.is_some_and(|deadline| now >= deadline)
            }) {
                return self.finish_plan(plan, "plan_event_timeout", true, now);
            }
            if !children.iter().all(|c| self.child_complete(&plan, c)) {
                return Ok(());
            }
            plan.current_stage += 1;
            if plan.current_stage == plan.stages.len() {
                plan.status = "completed".into();
                plan.ended_at = Some(now);
            }
            refresh(&mut plan)?;
            self.execution_plans.plans.insert(plan_id.into(), plan);
        }
        Err(err("invalid_plan_bounds"))
    }
    pub fn observe_execution_plan_event(
        &mut self,
        event: &DeviceEvent,
        now: DateTime<Utc>,
    ) -> Result<()> {
        let Some(plan_id) = event.data["task_id"].as_str() else {
            return Ok(());
        };
        let Some(mut plan) = self.execution_plans.plans.get(plan_id).cloned() else {
            return Ok(());
        };
        if plan.status != "running" || event.data["generation"] != plan.generation {
            return Ok(());
        }
        let Some(index) = plan.children.iter().position(|c| {
            c.stage_index == plan.current_stage && event.data["step_id"] == c.step_id
        }) else {
            return Ok(());
        };
        let child = &plan.children[index];
        if child.event.is_some() {
            return Ok(());
        }
        let command = self
            .commands
            .get(&child.command_id)
            .ok_or_else(|| err("storage_corrupt"))?;
        if !matches!(command.status.as_str(), "dispatched" | "confirmed") {
            return Ok(());
        }
        if self
            .validate_plan_event(&plan, child, event, Some(now))
            .is_err()
        {
            return Ok(());
        }
        plan.children[index].event = Some(event.clone());
        refresh(&mut plan)?;
        self.execution_plans.plans.insert(plan_id.into(), plan);
        Ok(())
    }
    fn validate_plan_event(
        &self,
        plan: &Plan,
        child: &Child,
        event: &DeviceEvent,
        now: Option<DateTime<Utc>>,
    ) -> Result<()> {
        let step = Self::step_for(plan, child)?;
        let Completion::Event { path, .. } = &step.completion else {
            return Err(err("invalid_plan_event"));
        };
        let binding = &plan.bindings[&step.device_id];
        let command = self
            .commands
            .get(&child.command_id)
            .ok_or_else(|| err("storage_corrupt"))?;
        let since = issued(command)?;
        let occurred_at = event.parsed_occurrence()?;
        ensure(
            event.device_id == step.device_id
                && event.model_revision == step.model_revision
                && event.boot_id == binding.boot_id
                && event.session_id == binding.session_id
                && event.path == *path
                && event.data["task_id"] == plan.plan_id
                && event.data["generation"] == plan.generation
                && event.data["step_id"] == step.step_id
                && matches!(event.data["status"].as_str(), Some("completed" | "failed"))
                && occurred_at >= since
                && event.received_at >= since
                && occurred_at <= event.received_at + Duration::seconds(2)
                && event.received_at - occurred_at <= Duration::seconds(5)
                && child
                    .event_deadline
                    .is_some_and(|deadline| event.received_at < deadline)
                && now.is_none_or(|time| event.received_at <= time)
                && identifier(&event.event_id)
                && identifier(&event.message_id)
                && event.seq > 0
                && event.seq <= crate::command_receipts::MAX_COMMAND_SEQUENCE
                && event.body_digest
                    == digest(&json!({"event_id":event.event_id,"path":event.path,
                "occurred_at":event.occurred_at,"historical":false,"data":event.data}))?
                && self
                    .event_ids
                    .get(&format!("{}:{}", event.device_id, event.event_id))
                    == Some(&event.body_digest),
            "invalid_plan_event",
        )?;
        self.models[&step.model_revision]
            .event(path)?
            .schema
            .validate(&event.data)?;
        if now.is_some() {
            let device = self
                .devices
                .get(&step.device_id)
                .ok_or_else(|| err("device_not_found"))?;
            ensure(
                device.boot_id.as_deref() == Some(&binding.boot_id)
                    && device.session_id.as_deref() == Some(&binding.session_id),
                "plan_session_changed",
            )?;
        }
        Ok(())
    }
    pub fn recover_execution_plans(&mut self) {
        self.execution_plans.admitting = None;
        let plans: Vec<_> = self
            .execution_plans
            .plans
            .values()
            .filter(|p| p.status == "running")
            .cloned()
            .collect();
        for plan in plans {
            // 本方法不创建任何命令；历史accepted只会被拒绝，已发副作用保持unknown。
            let _ = self.finish_plan(plan, "gateway_restarted", true, Utc::now());
        }
    }
    pub fn validate_execution_plan_registry(&self) -> Result<()> {
        let registry = &self.execution_plans;
        ensure(
            registry.admitting.is_none()
                && registry.plans.len() <= MAX_PLANS
                && registry.operations.len() <= MAX_OPERATIONS,
            "storage_corrupt",
        )?;
        let mut operation_ids = BTreeSet::new();
        let mut origins = BTreeMap::new();
        let mut starts = BTreeSet::new();
        let mut releases = BTreeSet::new();
        for (key, operation) in &registry.operations {
            validate_change_shape(&operation.request.change).map_err(|_| err("storage_corrupt"))?;
            ensure(
                identifier(key)
                    && key == &operation.request.idempotency_key
                    && operation.request.space_id == self.space_id
                    && operation.request_digest == digest(&operation.request)?
                    && identifier(&operation.operation_id)
                    && operation_ids.insert(&operation.operation_id),
                "storage_corrupt",
            )?;
            match operation.status.as_str() {
                "applied" => {
                    let plan = operation
                        .applied_snapshot
                        .as_ref()
                        .ok_or_else(|| err("storage_corrupt"))?;
                    let resource = operation
                        .result
                        .as_ref()
                        .ok_or_else(|| err("storage_corrupt"))?;
                    ensure(
                        operation.reason.is_none()
                            && resource.kind == "execution_plan"
                            && resource.id == change_id(&operation.request.change)
                            && resource.id == plan.plan_id
                            && resource.revision == plan.revision,
                        "storage_corrupt",
                    )?;
                    self.validate_plan_snapshot(plan, false)?;
                    match &operation.request.change {
                        Change::Create { .. } => {
                            ensure(
                                plan.status == "draft"
                                    && plan.created_at == operation.created_at
                                    && digest(&definition(plan))?
                                        == digest(&operation.request.change)?
                                    && origins.insert(plan.plan_id.clone(), plan).is_none(),
                                "storage_corrupt",
                            )?;
                        }
                        Change::Start {
                            expected_revision, ..
                        } => {
                            let mut before = plan.clone();
                            before.status = "draft".into();
                            before.started_at = None;
                            ensure(
                                plan.status == "running"
                                    && plan.children.is_empty()
                                    && plan.started_at == Some(operation.created_at)
                                    && revision(&before)? == *expected_revision
                                    && starts.insert(plan.plan_id.clone()),
                                "storage_corrupt",
                            )?;
                        }
                        Change::Cancel {
                            expected_revision, ..
                        } => {
                            let mut before = plan.clone();
                            before.status = if before.started_at.is_some() {
                                "running"
                            } else {
                                "draft"
                            }
                            .into();
                            before.ended_at = None;
                            before.reason = None;
                            before.physical_stop = "not_requested".into();
                            ensure(
                                matches!(plan.status.as_str(), "cancelled" | "unknown")
                                    && plan.reason.as_deref() == Some("plan_cancelled")
                                    && plan.ended_at == Some(operation.created_at)
                                    && revision(&before)? == *expected_revision,
                                "storage_corrupt",
                            )?;
                        }
                        Change::Release {
                            expected_revision, ..
                        } => {
                            let mut before = plan.clone();
                            before.released = false;
                            ensure(
                                plan.released
                                    && terminal(&plan.status)
                                    && revision(&before)? == *expected_revision
                                    && releases.insert(plan.plan_id.clone()),
                                "storage_corrupt",
                            )?;
                        }
                    }
                }
                "rejected" | "conflict" => ensure(
                    operation.reason.is_some()
                        && operation.result.is_none()
                        && operation.applied_snapshot.is_none()
                        && (operation.status != "conflict"
                            || operation.reason.as_deref() == Some("revision_conflict")),
                    "storage_corrupt",
                )?,
                _ => return Err(err("storage_corrupt")),
            }
        }
        ensure(origins.len() == registry.plans.len(), "storage_corrupt")?;
        let mut reserved = BTreeSet::new();
        for (key, plan) in &registry.plans {
            self.validate_plan_snapshot(plan, true)?;
            let origin = origins.get(key).ok_or_else(|| err("storage_corrupt"))?;
            ensure(
                key == &plan.plan_id
                    && plan.definition_digest == origin.definition_digest
                    && digest(&plan.bindings)? == digest(&origin.bindings)?
                    && plan.created_at == origin.created_at
                    && starts.contains(key) == plan.started_at.is_some()
                    && releases.contains(key) == plan.released,
                "storage_corrupt",
            )?;
            if plan.started_at.is_some() && !plan.released {
                for device in plan.bindings.keys() {
                    ensure(reserved.insert(device), "storage_corrupt")?;
                }
            }
        }
        for operation in registry
            .operations
            .values()
            .filter(|o| o.status == "applied")
        {
            let snapshot = operation.applied_snapshot.as_ref().unwrap();
            let current = registry
                .plans
                .get(&snapshot.plan_id)
                .ok_or_else(|| err("storage_corrupt"))?;
            ensure(
                snapshot.definition_digest == current.definition_digest
                    && digest(&snapshot.bindings)? == digest(&current.bindings)?
                    && snapshot.created_at == current.created_at,
                "storage_corrupt",
            )?;
            for child in &snapshot.children {
                let final_child = current
                    .children
                    .iter()
                    .find(|c| c.command_id == child.command_id)
                    .ok_or_else(|| err("storage_corrupt"))?;
                ensure(
                    child.stage_index == final_child.stage_index
                        && child.step_id == final_child.step_id
                        && child.event_deadline == final_child.event_deadline
                        && child
                            .event
                            .as_ref()
                            .is_none_or(|e| final_child.event.as_ref() == Some(e)),
                    "storage_corrupt",
                )?;
            }
        }
        Ok(())
    }
    fn validate_plan_snapshot(&self, plan: &Plan, current: bool) -> Result<()> {
        self.validate_plan_definition(
            &plan.plan_id,
            &plan.generation,
            &plan.stages,
            plan.expires_at,
            plan.created_at,
        )
        .map_err(|_| err("storage_corrupt"))?;
        ensure(
            plan.revision == revision(plan)?
                && plan.definition_digest == digest(&definition(plan))?
                && plan.current_stage <= plan.stages.len()
                && matches!(plan.physical_stop.as_str(), "not_requested" | "unknown"),
            "storage_corrupt",
        )?;
        let mut expected = BTreeSet::new();
        for step in plan.stages.iter().flat_map(|s| &s.steps) {
            expected.insert(step.device_id.clone());
            let binding = plan
                .bindings
                .get(&step.device_id)
                .ok_or_else(|| err("storage_corrupt"))?;
            ensure(
                binding.device_id == step.device_id
                    && binding.model_revision == step.model_revision
                    && identifier(&binding.boot_id)
                    && identifier(&binding.session_id),
                "storage_corrupt",
            )?;
        }
        ensure(
            expected == plan.bindings.keys().cloned().collect(),
            "storage_corrupt",
        )?;
        match plan.status.as_str() {
            "draft" => ensure(
                plan.started_at.is_none()
                    && plan.ended_at.is_none()
                    && plan.children.is_empty()
                    && plan.current_stage == 0
                    && !plan.released
                    && plan.reason.is_none()
                    && plan.physical_stop == "not_requested",
                "storage_corrupt",
            )?,
            "running" => ensure(
                plan.started_at.is_some()
                    && plan.ended_at.is_none()
                    && !plan.released
                    && plan.current_stage < plan.stages.len()
                    && plan.reason.is_none()
                    && plan.physical_stop == "not_requested",
                "storage_corrupt",
            )?,
            "completed" => ensure(
                plan.started_at.is_some()
                    && plan.ended_at.is_some()
                    && plan.current_stage == plan.stages.len()
                    && plan.reason.is_none()
                    && plan.physical_stop == "not_requested",
                "storage_corrupt",
            )?,
            "cancelled" => ensure(
                plan.ended_at.is_some()
                    && plan.reason.as_deref() == Some("plan_cancelled")
                    && plan.physical_stop == "not_requested"
                    && plan.current_stage < plan.stages.len(),
                "storage_corrupt",
            )?,
            "failed" | "partial" | "unknown" => ensure(
                plan.started_at.is_some()
                    && plan.ended_at.is_some()
                    && plan.current_stage < plan.stages.len()
                    && plan.reason.is_some()
                    && (plan.status != "unknown" || plan.physical_stop == "unknown"),
                "storage_corrupt",
            )?,
            _ => return Err(err("storage_corrupt")),
        }
        ensure(
            plan.started_at
                .is_none_or(|s| s >= plan.created_at && s < plan.expires_at)
                && plan
                    .ended_at
                    .is_none_or(|e| e >= plan.started_at.unwrap_or(plan.created_at))
                && (!plan.released || terminal(&plan.status)),
            "storage_corrupt",
        )?;
        let mut child_ids = BTreeSet::new();
        let mut command_ids = BTreeSet::new();
        let mut stages = BTreeMap::<usize, usize>::new();
        for child in &plan.children {
            let step = Self::step_for(plan, child)?;
            ensure(
                child.stage_index <= plan.current_stage
                    && child_ids.insert(&child.step_id)
                    && command_ids.insert(&child.command_id)
                    && plan.started_at.is_some(),
                "storage_corrupt",
            )?;
            *stages.entry(child.stage_index).or_default() += 1;
            let command = self
                .commands
                .get(&child.command_id)
                .ok_or_else(|| err("storage_corrupt"))?;
            let time = issued(command)?;
            let binding = &plan.bindings[&step.device_id];
            ensure(
                command.run_id.as_deref() == Some(&plan.plan_id)
                    && command.execution_route.is_none()
                    && command.command_id == child.command_id
                    && command.envelope.kind == "command"
                    && command.envelope.device_id == step.device_id
                    && command.envelope.model_revision == step.model_revision
                    && command.envelope.body["command_id"] == child.command_id
                    && command.envelope.body["expires_at"] == json!(command.request.expires_at)
                    && matches!(
                        command.status.as_str(),
                        "accepted"
                            | "dispatched"
                            | "confirmed"
                            | "failed"
                            | "unknown"
                            | "rejected"
                            | "expired"
                    )
                    && command.request.space_id == self.space_id
                    && command.request.device_id == step.device_id
                    && command.request.model_revision == step.model_revision
                    && command.request.idempotency_key == child_key(plan, child.stage_index, step)?
                    && command.request_digest == digest(&command.request)?
                    && digest(&command.request.operation)? == digest(&step.operation)?
                    && command.envelope.session_id.as_deref() == Some(&binding.session_id)
                    && command.envelope.body["operation"]
                        == serde_json::to_value(&step.operation)
                            .map_err(|_| err("storage_corrupt"))?
                    && time >= plan.started_at.unwrap()
                    && time < plan.expires_at
                    && command.request.expires_at
                        == std::cmp::min(
                            time + Duration::milliseconds(i64::from(step.command_timeout_ms)),
                            plan.expires_at,
                        ),
                "storage_corrupt",
            )?;
            if command.status == "confirmed" {
                let evidence = command
                    .evidence
                    .as_ref()
                    .ok_or_else(|| err("storage_corrupt"))?;
                if step.operation.kind == "action.invoke" {
                    let evidence: crate::protocol::ActionEvidence =
                        serde_json::from_value(evidence.clone())
                            .map_err(|_| err("storage_corrupt"))?;
                    let action = self.models[&step.model_revision].action(&step.operation.path)?;
                    ensure(
                        evidence.kind == "action_result"
                            && evidence.path == step.operation.path
                            && evidence.input_digest == digest(&step.operation.value)?
                            && evidence.completion == action.completion
                            && evidence.observed_at >= time - Duration::seconds(2),
                        "storage_corrupt",
                    )?;
                    action
                        .output
                        .validate(&evidence.output)
                        .map_err(|_| err("storage_corrupt"))?;
                } else {
                    ensure(
                        evidence["type"] == "device_result"
                            && evidence["reported"][&step.operation.path] == step.operation.value,
                        "storage_corrupt",
                    )?;
                }
            }
            let deadline = match step.completion {
                Completion::Command => None,
                Completion::Event { timeout_ms, .. } => Some(std::cmp::min(
                    time + Duration::milliseconds(i64::from(timeout_ms)),
                    plan.expires_at,
                )),
            };
            ensure(
                child.event_deadline == deadline
                    && self.keys.get(&command.request.idempotency_key) == Some(&child.command_id),
                "storage_corrupt",
            )?;
            if let Some(event) = &child.event {
                self.validate_plan_event(plan, child, event, None)
                    .map_err(|_| err("storage_corrupt"))?;
            }
            if current && child.stage_index < plan.current_stage {
                ensure(self.child_complete(plan, child), "storage_corrupt")?;
            }
            if current && terminal(&plan.status) {
                ensure(command.status != "accepted", "storage_corrupt")?;
            }
        }
        for stage in 0..plan.current_stage {
            ensure(
                stages.get(&stage).copied() == Some(plan.stages[stage].steps.len()),
                "storage_corrupt",
            )?;
        }
        for (stage, count) in stages {
            ensure(count == plan.stages[stage].steps.len(), "storage_corrupt")?;
        }
        if current {
            ensure(
                !self.commands.values().any(|c| {
                    c.run_id.as_deref() == Some(&plan.plan_id)
                        && !command_ids.contains(&c.command_id)
                }),
                "storage_corrupt",
            )?;
            if matches!(plan.status.as_str(), "cancelled" | "failed") {
                ensure(
                    !self.plan_may_have_effects(plan) && plan.physical_stop == "not_requested",
                    "storage_corrupt",
                )?;
            }
            if plan.status == "partial" {
                ensure(plan.physical_stop == "unknown", "storage_corrupt")?;
            }
        }
        Ok(())
    }
}
