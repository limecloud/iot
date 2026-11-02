use crate::{digest, ensure, err, id, identifier, model::Model, protocol::*, Result};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Binding {
    pub device_id: String,
    pub model_revision: String,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub routes: BTreeMap<String, crate::execution::Route>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub space_id: String,
    pub models: Vec<Model>,
    pub devices: Vec<Binding>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Observation {
    pub value: Value,
    pub observed_at: DateTime<Utc>,
    pub quality: String,
    pub source: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Device {
    pub device_id: String,
    pub model_revision: String,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub routes: BTreeMap<String, crate::execution::Route>,
    #[serde(skip)]
    pub adapter_sessions: BTreeMap<String, crate::execution::Session>,
    pub ready: bool,
    pub boot_id: Option<String>,
    pub session_id: Option<String>,
    pub last_seq: u64,
    pub last_seen: Option<DateTime<Utc>>,
    pub state_revision: u64,
    pub reported: BTreeMap<String, Observation>,
    pub retired_boots: BTreeSet<String>,
    pub seen: BTreeMap<u64, String>,
    // 会话观测只保存在本次运行内存，备份或重启不能恢复成当前升级事实。
    #[serde(skip)]
    pub device_info: Option<crate::device_info::DeviceInfo>,
    #[serde(skip)]
    pub receipt_ledger: bool,
    // 由本次认证设备会话声明；重启不能从旧快照恢复能力证明。
    #[serde(skip)]
    pub native_actions: Option<BTreeSet<String>>,
}
impl Device {
    pub(crate) fn new_binding(device_id: String, model_revision: String) -> Self {
        Self {
            device_id,
            model_revision,
            routes: BTreeMap::new(),
            adapter_sessions: BTreeMap::new(),
            ready: false,
            boot_id: None,
            session_id: None,
            last_seq: 0,
            last_seen: None,
            state_revision: 0,
            reported: BTreeMap::new(),
            retired_boots: BTreeSet::new(),
            seen: BTreeMap::new(),
            device_info: None,
            receipt_ledger: false,
            native_actions: None,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Command {
    pub command_id: String,
    #[serde(default)]
    pub sequence: u64,
    pub request: CommandRequest,
    pub request_digest: String,
    pub status: String,
    pub envelope: Envelope,
    pub evidence: Option<Value>,
    pub error: Option<String>,
    pub run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_authority: Option<crate::remote::RemoteAuthority>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_route: Option<crate::execution::Route>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Deployment {
    pub revision: String,
    pub rule: Rule,
    pub last_run: Option<DateTime<Utc>>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Run {
    pub run_id: String,
    pub rule_revision: String,
    pub event_id: String,
    pub command_ids: Vec<String>,
    pub error: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Data {
    pub space_id: String,
    pub models: BTreeMap<String, Model>,
    pub devices: BTreeMap<String, Device>,
    pub commands: BTreeMap<String, Command>,
    pub keys: BTreeMap<String, String>,
    pub deployments: BTreeMap<String, Deployment>,
    pub runs: BTreeMap<String, Run>,
    pub event_ids: BTreeMap<String, String>,
    #[serde(default)]
    pub rule_drafts: BTreeMap<String, crate::draft::RuleDraft>,
    #[serde(default)]
    pub control_links: crate::control::Links,
    #[serde(default)]
    pub model_registry: crate::model_registry::Registry,
    #[serde(default)]
    pub ota_registry: crate::ota_tasks::Registry,
    #[serde(default)]
    pub execution_registry: crate::execution_binding::Registry,
}
impl Data {
    pub fn new(config: Config) -> Result<Self> {
        ensure(
            identifier(&config.space_id)
                && !config.devices.is_empty()
                && config.devices.len() <= 64,
            "invalid_config",
        )?;
        let mut models = BTreeMap::new();
        for model in config.models {
            model.validate()?;
            models.insert(digest(&model)?, model);
        }
        let mut devices = BTreeMap::new();
        for binding in config.devices {
            ensure(
                identifier(&binding.device_id)
                    && models.contains_key(&binding.model_revision)
                    && !devices.contains_key(&binding.device_id),
                "invalid_binding",
            )?;
            let mut device = Device::new_binding(binding.device_id, binding.model_revision);
            device.routes = binding.routes;
            devices.insert(device.device_id.clone(), device);
        }
        let data = Self {
            space_id: config.space_id,
            models,
            devices,
            commands: BTreeMap::new(),
            keys: BTreeMap::new(),
            deployments: BTreeMap::new(),
            runs: BTreeMap::new(),
            event_ids: BTreeMap::new(),
            rule_drafts: BTreeMap::new(),
            control_links: BTreeMap::new(),
            model_registry: crate::model_registry::Registry::default(),
            ota_registry: crate::ota_tasks::Registry::default(),
            execution_registry: crate::execution_binding::Registry::default(),
        };
        data.validate_execution_routes()?;
        Ok(data)
    }
    pub fn recover(&mut self) {
        self.reset_ota_approvals(None, "gateway_restarted");
        for link in self.control_links.values_mut() {
            if matches!(
                link.status,
                crate::control::LinkStatus::Reviewing
                    | crate::control::LinkStatus::Claiming
                    | crate::control::LinkStatus::Reconciling
            ) {
                link.status = crate::control::LinkStatus::Unknown;
                link.error = Some("control_unknown".into())
            }
        }
        for draft in self.rule_drafts.values_mut() {
            if draft.status == crate::draft::DraftStatus::Running {
                draft.status = crate::draft::DraftStatus::Unknown;
                draft.error = Some("inference_unknown".into());
            }
        }
        for device in self.devices.values_mut() {
            device.ready = false;
            device.receipt_ledger = false;
            device.native_actions = None;
            device.device_info = None;
            device.adapter_sessions.clear();
        }
        for command in self.commands.values_mut() {
            if command.status == "accepted" {
                command.status = "rejected".into();
                command.error = Some("gateway_restarted".into());
            } else if command.status == "dispatched" {
                command.status = "unknown".into();
                command.error = Some("execution_unknown".into());
            }
        }
    }
    pub fn devices_view(&self, now: DateTime<Utc>) -> Vec<Value> {
        self.devices
            .values()
            .map(|device| {
                let mut view = serde_json::to_value(device).expect("device serialization");
                let native_ready = device.native_ready(now)
                    && self.check_model_authority(&device.device_id).is_ok();
                let ready = !self.execution_blocked(&device.device_id)
                    && (native_ready
                        || self.check_model_authority(&device.device_id).is_ok()
                            && device
                                .routes
                                .values()
                                .any(|route| device.adapter_ready(route, now)));
                view["ready"] = json!(ready);
                view["device_info"] = device
                    .device_info
                    .as_ref()
                    .map(|info| {
                        let mut value =
                            serde_json::to_value(info).expect("device info serialization");
                        value["fresh"] =
                            json!(self.current_device_info(&device.device_id, now).is_ok());
                        value
                    })
                    .unwrap_or(Value::Null);
                for field in ["retired_boots", "seen"] {
                    view.as_object_mut().unwrap().remove(field);
                }
                let model = &self.models[&device.model_revision];
                if self
                    .execution_registry
                    .bindings
                    .get(&device.device_id)
                    .is_some_and(|binding| binding.native_paths.is_some())
                {
                    let availability: BTreeMap<_, _> = model
                        .services
                        .iter()
                        .flat_map(|service| {
                            service.actions.iter().map(|action| {
                                let path = format!("{}.{}", service.id, action.id);
                                let available =
                                    self.check_model_authority(&device.device_id).is_ok()
                                        && !self.ota_reserves_device(&device.device_id, now)
                                        && self.command_session(device, &path, now).is_ok();
                                (path, available)
                            })
                        })
                        .collect();
                    view["action_availability"] = json!(availability);
                }
                for (path, observation) in &device.reported {
                    let age = now
                        .signed_duration_since(observation.observed_at)
                        .num_milliseconds();
                    let fresh = model
                        .property(path)
                        .map(|p| age >= 0 && age <= p.max_age_ms as i64)
                        .unwrap_or(false);
                    if !fresh || !native_ready {
                        view["reported"][path]["quality"] = json!("stale");
                    }
                }
                view
            })
            .collect()
    }
    pub fn create_command(
        &mut self,
        request: CommandRequest,
        now: DateTime<Utc>,
        run_id: Option<String>,
    ) -> Result<Command> {
        ensure(request.space_id == self.space_id, "forbidden")?;
        ensure(
            identifier(&request.idempotency_key),
            "invalid_idempotency_key",
        )?;
        let hash = digest(&request)?;
        if let Some(command_id) = self.keys.get(&request.idempotency_key) {
            let command = &self.commands[command_id];
            ensure(command.request_digest == hash, "idempotency_conflict")?;
            return Ok(command.clone());
        }
        ensure(self.commands.len() < 4096, "capacity_exceeded")?;
        ensure(
            self.commands
                .values()
                .filter(|command| {
                    command.request.device_id == request.device_id
                        && matches!(command.status.as_str(), "accepted" | "dispatched")
                })
                .count()
                < 32,
            "device_queue_full",
        )?;
        ensure(
            request.expires_at > now && request.expires_at <= now + Duration::seconds(30),
            "command_expired",
        )?;
        let device = self
            .devices
            .get(&request.device_id)
            .ok_or_else(|| err("device_not_found"))?;
        self.check_model_authority(&request.device_id)?;
        ensure(
            !self.ota_reserves_device(&request.device_id, now),
            "ota_task_conflict",
        )?;
        let session_id = self.command_session(device, &request.operation.path, now)?;
        ensure(
            device.model_revision == request.model_revision,
            "model_mismatch",
        )?;
        self.models[&device.model_revision].operation(&request.operation)?;
        let sequence = self
            .command_sequence_head()
            .checked_add(1)
            .filter(|sequence| *sequence <= crate::command_receipts::MAX_COMMAND_SEQUENCE)
            .ok_or_else(|| err("capacity_exceeded"))?;
        let command_id = format!("c1-{sequence}-{}", id());
        let envelope = Envelope {
            v: 1,
            kind: "command".into(),
            message_id: command_id.clone(),
            device_id: device.device_id.clone(),
            model_revision: device.model_revision.clone(),
            boot_id: None,
            seq: None,
            session_id,
            body: json!({"command_id":command_id,"issued_at":now,"expires_at":request.expires_at,"operation":request.operation}),
        };
        let command = Command {
            command_id: command_id.clone(),
            sequence,
            request: request.clone(),
            request_digest: hash,
            status: "accepted".into(),
            envelope,
            evidence: None,
            error: None,
            run_id,
            remote_authority: None,
            execution_route: device.routes.get(&request.operation.path).cloned(),
        };
        self.keys
            .insert(request.idempotency_key, command_id.clone());
        self.commands.insert(command_id, command.clone());
        Ok(command)
    }
    pub fn validate_rule(&self, rule: &Rule) -> Result<String> {
        ensure(
            rule.version == 1
                && identifier(&rule.id)
                && rule.conditions.is_empty()
                && !rule.actions.is_empty()
                && rule.actions.len() <= 16
                && rule.cooldown_ms <= 86_400_000,
            "unsupported_rule",
        )?;
        let source = self
            .devices
            .get(&rule.trigger.device)
            .ok_or_else(|| err("device_not_found"))?;
        self.check_model_authority(&source.device_id)?;
        self.models[&source.model_revision].event(&rule.trigger.event)?;
        for action in &rule.actions {
            self.check_model_authority(&action.device)?;
            let target = self
                .devices
                .get(&action.device)
                .ok_or_else(|| err("device_not_found"))?;
            self.models[&target.model_revision].write(&action.set.path, &action.set.value)?;
        }
        digest(rule)
    }
    pub fn deploy(&mut self, rule: Rule) -> Result<Deployment> {
        let revision = self.validate_rule(&rule)?;
        if let Some(existing) = self.deployments.get(&rule.id) {
            if existing.revision == revision {
                return Ok(existing.clone());
            }
        }
        ensure(
            self.deployments.len() < 64 || self.deployments.contains_key(&rule.id),
            "capacity_exceeded",
        )?;
        let deployment = Deployment {
            revision,
            rule,
            last_run: None,
        };
        self.deployments
            .insert(deployment.rule.id.clone(), deployment.clone());
        Ok(deployment)
    }
    pub fn stop_rule(&mut self, id: &str, revision: &str) -> Result<Value> {
        let current = self.deployments.get(id).ok_or_else(|| err("not_found"))?;
        ensure(current.revision == revision, "revision_conflict")?;
        self.deployments.remove(id);
        Ok(json!({"stopped":true,"rule_id":id,"revision":revision}))
    }
    pub fn ingest(&mut self, message: Envelope, now: DateTime<Utc>) -> Result<Option<Envelope>> {
        message.validate()?;
        self.check_model_authority(&message.device_id)?;
        let current = self
            .devices
            .get(&message.device_id)
            .ok_or_else(|| err("device_not_found"))?
            .clone();
        ensure(
            current.model_revision == message.model_revision,
            "model_mismatch",
        )?;
        let boot = message
            .boot_id
            .as_ref()
            .filter(|b| identifier(b))
            .ok_or_else(|| err("invalid_boot"))?;
        let seq = message.seq.ok_or_else(|| err("invalid_sequence"))?;
        let hash = digest(&message)?;
        if message.kind == "hello" {
            ensure(!current.retired_boots.contains(boot), "old_boot")?;
            let native_actions = self.native_action_declaration(&current, &message.body)?;
            let receipt_ledger = match message.body.get("receipt_ledger") {
                None => false,
                Some(value) if value.as_u64() == Some(1) => true,
                _ => return Err(err("unsupported_receipt_ledger")),
            };
            let mut welcome_body = json!({"challenge":message.body["challenge"],"time":now,"max_packet_bytes":MAX_PACKET});
            if receipt_ledger {
                welcome_body["receipt_ledger"] = json!(1);
                welcome_body["command_sequence"] = json!(self.command_sequence_head());
            }
            let _challenge = message
                .body
                .get("challenge")
                .and_then(Value::as_str)
                .filter(|s| identifier(s))
                .ok_or_else(|| err("invalid_challenge"))?;
            if current.boot_id.as_ref() == Some(boot) {
                ensure(seq > current.last_seq, "out_of_order")?;
            }
            let session = id();
            let device = self.devices.get_mut(&message.device_id).unwrap();
            if device.boot_id.as_ref() != Some(boot) {
                ensure(device.retired_boots.len() < 128, "capacity_exceeded")?;
                if let Some(old) = device.boot_id.take() {
                    device.retired_boots.insert(old);
                }
            }
            device.boot_id = Some(boot.clone());
            device.session_id = Some(session.clone());
            device.last_seq = seq;
            device.seen.clear();
            device.seen.insert(seq, hash);
            device.state_revision = 0;
            device.ready = false;
            device.device_info = None;
            device.receipt_ledger = receipt_ledger;
            device.native_actions = native_actions;
            device.last_seen = Some(now);
            self.reset_ota_approvals(Some(&message.device_id), "ota_session_changed");
            return Ok(Some(Envelope {
                v: 1,
                kind: "welcome".into(),
                message_id: id(),
                device_id: message.device_id,
                model_revision: message.model_revision,
                boot_id: None,
                seq: None,
                session_id: Some(session),
                body: welcome_body,
            }));
        }
        ensure(
            current.boot_id.as_ref() == Some(boot)
                && current.session_id == message.session_id
                && message.session_id.is_some(),
            "session_mismatch",
        )?;
        if let Some(previous) = current.seen.get(&seq) {
            ensure(previous == &hash, "duplicate_conflict")?;
            return Ok(None);
        }
        ensure(seq > current.last_seq, "out_of_order")?;
        match message.kind.as_str() {
            "state" => self.apply_state(&message, now)?,
            "result" => self.apply_result(&message, now)?,
            "receipt" => self.receipt_report(&message, now)?,
            "event" => self.apply_event(&message, now)?,
            "device_info" => self.apply_device_info(&message, now)?,
            "ota_result" => self.apply_ota_receipt(&message, now)?,
            "availability" => {
                ensure(
                    message.body["online"].as_bool() == Some(false),
                    "invalid_message",
                )?;
                let device = self.devices.get_mut(&message.device_id).unwrap();
                device.ready = false;
                device.device_info = None;
                self.reset_ota_approvals(Some(&message.device_id), "ota_session_changed");
            }
            _ => return Err(err("unsupported_message")),
        }
        let device = self.devices.get_mut(&message.device_id).unwrap();
        device.last_seq = seq;
        device.last_seen = Some(now);
        device.seen.insert(seq, hash);
        while device.seen.len() > 128 {
            let first = *device.seen.keys().next().unwrap();
            device.seen.remove(&first);
        }
        if matches!(message.kind.as_str(), "result" | "receipt") {
            self.receipt_response(&message)
        } else {
            Ok(None)
        }
    }
    fn apply_state(&mut self, message: &Envelope, now: DateTime<Utc>) -> Result<()> {
        ensure(message.body["type"] == "snapshot", "snapshot_required")?;
        let revision = message.body["revision"]
            .as_u64()
            .ok_or_else(|| err("invalid_state"))?;
        let properties = message.body["properties"]
            .as_array()
            .ok_or_else(|| err("invalid_state"))?;
        let device = &self.devices[&message.device_id];
        ensure(
            revision > device.state_revision && properties.len() <= 64,
            "out_of_order",
        )?;
        let model = &self.models[&device.model_revision];
        let mut reported = BTreeMap::new();
        for entry in properties {
            let path = entry["path"].as_str().ok_or_else(|| err("invalid_state"))?;
            let property = model.property(path)?;
            property.schema.validate(&entry["value"])?;
            let observation:Observation=serde_json::from_value(json!({"value":entry["value"],"observed_at":entry["observed_at"],"quality":entry["quality"],"source":entry["source"]})).map_err(|_|err("invalid_state"))?;
            ensure(
                matches!(
                    observation.quality.as_str(),
                    "confirmed" | "estimated" | "unknown"
                ) && observation.observed_at <= now + Duration::seconds(2)
                    && reported.insert(path.to_string(), observation).is_none(),
                "invalid_state",
            )?;
        }
        let count: usize = model.services.iter().map(|s| s.properties.len()).sum();
        ensure(reported.len() == count, "snapshot_incomplete")?;
        let device = self.devices.get_mut(&message.device_id).unwrap();
        device.reported = reported;
        device.state_revision = revision;
        device.ready = true;
        Ok(())
    }
    fn apply_result(&mut self, message: &Envelope, now: DateTime<Utc>) -> Result<()> {
        let command_id = message.body["command_id"]
            .as_str()
            .ok_or_else(|| err("invalid_result"))?;
        ensure(
            self.commands
                .get(command_id)
                .is_none_or(|command| command.execution_route.is_none()),
            "execution_source_mismatch",
        )?;
        self.apply_command_result(
            &message.device_id,
            message.session_id.as_deref(),
            &message.body,
            now,
        )
    }
    pub(crate) fn apply_command_result(
        &mut self,
        device_id: &str,
        session_id: Option<&str>,
        body: &Value,
        now: DateTime<Utc>,
    ) -> Result<()> {
        let command_id = body["command_id"]
            .as_str()
            .ok_or_else(|| err("invalid_result"))?;
        let command = self
            .commands
            .get_mut(command_id)
            .ok_or_else(|| err("command_not_found"))?;
        ensure(
            command.request.device_id == device_id
                && command.envelope.session_id.as_deref() == session_id,
            "session_mismatch",
        )?;
        let status = body["status"]
            .as_str()
            .ok_or_else(|| err("invalid_result"))?;
        ensure(
            matches!(status, "confirmed" | "failed" | "unknown"),
            "invalid_result",
        )?;
        if status == "unknown" {
            ensure(
                body["error"] == "execution_unknown" && body["evidence"]["type"] == "device_result",
                "invalid_result",
            )?;
        }
        if matches!(command.status.as_str(), "confirmed" | "failed") {
            ensure(
                command.status == status && command.evidence.as_ref() == Some(&body["evidence"]),
                "duplicate_conflict",
            )?;
            return Ok(());
        }
        ensure(
            matches!(command.status.as_str(), "dispatched" | "unknown"),
            "invalid_transition",
        )?;
        if status == "confirmed" {
            if command.request.operation.kind == "action.invoke" {
                let action = self.models[&command.request.model_revision]
                    .action(&command.request.operation.path)?;
                let evidence: ActionEvidence = serde_json::from_value(body["evidence"].clone())
                    .map_err(|_| err("invalid_evidence"))?;
                let issued_at: DateTime<Utc> =
                    serde_json::from_value(command.envelope.body["issued_at"].clone())
                        .map_err(|_| err("invalid_evidence"))?;
                ensure(
                    evidence.kind == "action_result"
                        && evidence.path == command.request.operation.path
                        && evidence.input_digest == digest(&command.request.operation.value)?
                        && evidence.completion == action.completion
                        && evidence.observed_at >= issued_at - Duration::seconds(2)
                        && evidence.observed_at <= now + Duration::seconds(2),
                    "invalid_evidence",
                )?;
                action
                    .output
                    .validate(&evidence.output)
                    .map_err(|_| err("invalid_evidence"))?;
            } else {
                ensure(
                    body["evidence"]["type"] == "device_result"
                        && body["evidence"]["reported"][&command.request.operation.path]
                            == command.request.operation.value,
                    "invalid_evidence",
                )?;
            }
        }
        command.status = status.into();
        command.evidence = Some(body["evidence"].clone());
        command.error = if status == "failed" || status == "unknown" {
            Some(body["error"].as_str().unwrap_or("device_failed").into())
        } else {
            None
        };
        Ok(())
    }
    fn apply_event(&mut self, message: &Envelope, now: DateTime<Utc>) -> Result<()> {
        let event_id = message.body["event_id"]
            .as_str()
            .filter(|v| identifier(v))
            .ok_or_else(|| err("invalid_event"))?;
        let path = message.body["path"]
            .as_str()
            .ok_or_else(|| err("invalid_event"))?;
        let occurred: DateTime<Utc> = serde_json::from_value(message.body["occurred_at"].clone())
            .map_err(|_| err("invalid_event"))?;
        let historical = message.body["historical"]
            .as_bool()
            .ok_or_else(|| err("invalid_event"))?;
        let device = &self.devices[&message.device_id];
        ensure(device.ready, "device_offline")?;
        self.models[&device.model_revision]
            .event(path)?
            .schema
            .validate(&message.body["data"])?;
        let key = format!("{}:{event_id}", message.device_id);
        let hash = digest(&message.body)?;
        if let Some(previous) = self.event_ids.get(&key) {
            ensure(previous == &hash, "duplicate_conflict")?;
            return Ok(());
        }
        ensure(self.event_ids.len() < 4096, "capacity_exceeded")?;
        ensure(occurred <= now + Duration::seconds(2), "invalid_event_time")?;
        self.event_ids.insert(key, hash);
        if historical || now - occurred > Duration::seconds(5) {
            return Ok(());
        }
        let rules: Vec<_> = self
            .deployments
            .values()
            .filter(|d| {
                d.rule.trigger.device == message.device_id
                    && d.rule.trigger.event == path
                    && d.last_run
                        .map(|t| now - t >= Duration::milliseconds(d.rule.cooldown_ms as i64))
                        .unwrap_or(true)
            })
            .cloned()
            .collect();
        for deployment in rules {
            ensure(self.runs.len() < 1024, "capacity_exceeded")?;
            let run_id = id();
            let mut commands = Vec::new();
            let mut error = None;
            for (index, action) in deployment.rule.actions.iter().enumerate() {
                let request = CommandRequest {
                    space_id: self.space_id.clone(),
                    device_id: action.device.clone(),
                    model_revision: self.devices[&action.device].model_revision.clone(),
                    idempotency_key: format!("{run_id}-{index}"),
                    expires_at: now + Duration::seconds(5),
                    operation: Operation {
                        kind: "property.set".into(),
                        path: action.set.path.clone(),
                        value: action.set.value.clone(),
                    },
                };
                match self.create_command(request, now, Some(run_id.clone())) {
                    Ok(command) => commands.push(command.command_id),
                    Err(e) => {
                        error = Some(e.code);
                        break;
                    }
                }
            }
            self.runs.insert(
                run_id.clone(),
                Run {
                    run_id,
                    rule_revision: deployment.revision,
                    event_id: event_id.into(),
                    command_ids: commands,
                    error,
                },
            );
            self.deployments
                .get_mut(&deployment.rule.id)
                .unwrap()
                .last_run = Some(now);
        }
        Ok(())
    }
    pub fn prepare_dispatch(&mut self, now: DateTime<Utc>) -> Vec<Envelope> {
        self.prepare_dispatch_for(None, now)
    }
    pub(crate) fn prepare_dispatch_for(
        &mut self,
        adapter: Option<&str>,
        now: DateTime<Utc>,
    ) -> Vec<Envelope> {
        self.expire_ota_tasks(now);
        let reserved: BTreeSet<_> = self
            .ota_registry
            .tasks
            .values()
            .filter(|task| task.status.reserves(task.expires_at, now))
            .map(|task| task.device_id.clone())
            .collect();
        let untrusted: BTreeSet<_> = self
            .devices
            .keys()
            .filter(|device| self.check_model_authority(device).is_err())
            .cloned()
            .collect();
        let unauthorized: BTreeSet<String> = self
            .commands
            .values()
            .filter(|c| {
                c.status == "accepted"
                    && c.remote_authority
                        .as_ref()
                        .is_some_and(|a| self.authorize_remote(a, "commands.write", now).is_err())
            })
            .map(|c| c.command_id.clone())
            .collect();
        let available: BTreeSet<String> = self
            .commands
            .values()
            .filter(|command| {
                let device = &self.devices[&command.request.device_id];
                command.execution_route.as_ref()
                    == device.routes.get(&command.request.operation.path)
                    && self
                        .command_session(device, &command.request.operation.path, now)
                        .is_ok_and(|session| session == command.envelope.session_id)
            })
            .map(|command| command.command_id.clone())
            .collect();
        for device in self.devices.values_mut() {
            if device
                .last_seen
                .map(|t| now - t > Duration::seconds(15))
                .unwrap_or(false)
            {
                device.ready = false;
            }
        }
        let mut messages = Vec::new();
        let mut active: BTreeSet<_> = self
            .commands
            .values()
            .filter(|command| command.status == "dispatched" && command.request.expires_at > now)
            .map(|command| command.request.device_id.clone())
            .collect();
        let mut ordered: Vec<_> = self
            .commands
            .values()
            .map(|command| (command.sequence, command.command_id.clone()))
            .collect();
        ordered.sort();
        let mut earlier_paths = BTreeSet::new();
        for (_, command_id) in ordered {
            let command = self.commands.get_mut(&command_id).unwrap();
            if command
                .execution_route
                .as_ref()
                .map(|route| route.adapter_id.as_str())
                != adapter
            {
                // 同一设备的受理顺序跨执行端成立；不能越过另一条路径的在先命令。
                if command.status == "accepted" && command.request.expires_at > now {
                    earlier_paths.insert(command.request.device_id.clone());
                }
                continue;
            }
            if command.status == "dispatched" && command.request.expires_at <= now {
                command.status = "unknown".into();
                command.error = Some("execution_unknown".into());
            }
            if command.status != "accepted" {
                continue;
            }
            if reserved.contains(&command.request.device_id) {
                command.status = "rejected".into();
                command.error = Some("ota_task_conflict".into());
                continue;
            }
            if unauthorized.contains(&command.command_id) {
                command.status = "rejected".into();
                command.error = Some("remote_authorization_rejected".into());
                continue;
            }
            if untrusted.contains(&command.request.device_id) {
                command.status = "rejected".into();
                command.error = Some("model_trust_revoked".into());
                continue;
            }
            if command.request.expires_at <= now {
                command.status = "expired".into();
                command.error = Some("command_expired".into());
            } else if !available.contains(&command.command_id) {
                command.status = "rejected".into();
                command.error = Some("device_offline".into());
            } else if !earlier_paths.contains(&command.request.device_id)
                && active.insert(command.request.device_id.clone())
            {
                command.status = "dispatched".into();
                messages.push(command.envelope.clone());
            }
        }
        messages
    }
}
