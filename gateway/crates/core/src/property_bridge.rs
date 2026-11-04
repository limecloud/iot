//! 同一物模型的属性观测与执行桥接；协议受理不代替独立状态读回。
use crate::{
    digest,
    engine::{Command, Data, Device},
    ensure, err,
    execution::{AdapterReceipt, Session},
    identifier, observation, Result,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Policy {
    pub observation: observation::Policy,
    pub write_paths: BTreeSet<String>,
}

impl Policy {
    pub(crate) fn validate_model(&self, model: &crate::model::Model) -> Result<()> {
        observation::validate_observable_model(model)?;
        let writable: BTreeSet<_> = model
            .services
            .iter()
            .flat_map(|service| {
                service
                    .properties
                    .iter()
                    .filter(|property| property.access.iter().any(|access| access == "write"))
                    .map(|property| format!("{}.{}", service.id, property.id))
            })
            .collect();
        ensure(
            !writable.is_empty() && writable == self.write_paths,
            "property_bridge_model_unsupported",
        )
    }

    pub(crate) fn routes(&self) -> BTreeMap<String, crate::execution::Route> {
        self.write_paths
            .iter()
            .map(|path| (path.clone(), self.observation.source.clone()))
            .collect()
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Acceptance {
    #[serde(rename = "type")]
    kind: String,
    receipt: AdapterReceipt,
    source_sequence: u64,
    state_revision: u64,
    received_at: DateTime<Utc>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Confirmation {
    #[serde(rename = "type")]
    kind: String,
    acceptance: Acceptance,
    path: String,
    value: serde_json::Value,
    observed_at: DateTime<Utc>,
    source_sequence: u64,
    state_revision: u64,
}

impl Acceptance {
    fn validate(&self, command: &Command) -> Result<()> {
        let issued_at: DateTime<Utc> =
            serde_json::from_value(command.envelope.body["issued_at"].clone())
                .map_err(|_| err("invalid_evidence"))?;
        ensure(
            self.kind == "property_adapter_result"
                && self.receipt.command_id == command.command_id
                && Some(&self.receipt.route) == command.execution_route.as_ref()
                && Some(self.receipt.session_id.as_str()) == command.envelope.session_id.as_deref()
                && self.receipt.request_digest == command.request_digest
                && self.receipt.status == "protocol_accepted"
                && self.receipt.error.is_none()
                && self.receipt.observed_at >= issued_at
                && self.receipt.observed_at <= self.received_at
                && self.received_at < command.request.expires_at
                && self.source_sequence > 0
                && self.source_sequence <= crate::command_receipts::MAX_COMMAND_SEQUENCE
                && self.state_revision > 0
                && self.state_revision <= crate::command_receipts::MAX_COMMAND_SEQUENCE,
            "invalid_evidence",
        )
    }
}

impl Confirmation {
    fn validate(&self, command: &Command) -> Result<()> {
        self.acceptance.validate(command)?;
        ensure(
            self.kind == "property_observation_result"
                && command.status == "confirmed"
                && self.path == command.request.operation.path
                && self.value == command.request.operation.value
                && self.observed_at > self.acceptance.received_at
                && self.observed_at < command.request.expires_at
                && self.source_sequence > self.acceptance.source_sequence
                && self.source_sequence <= crate::command_receipts::MAX_COMMAND_SEQUENCE
                && self.state_revision > self.acceptance.state_revision
                && self.state_revision <= crate::command_receipts::MAX_COMMAND_SEQUENCE,
            "invalid_evidence",
        )
    }
}

/// 云端沿用已确认属性回执，不导出本地route、来源token或受理基线。
pub fn remote_evidence(command: &Command) -> Result<Option<serde_json::Value>> {
    if command.execution_route.is_none() || command.request.operation.kind != "property.set" {
        return Ok(command.evidence.clone());
    }
    if command.status != "confirmed" {
        return Ok(None);
    }
    let confirmed: Confirmation = serde_json::from_value(
        command
            .evidence
            .clone()
            .ok_or_else(|| err("invalid_evidence"))?,
    )
    .map_err(|_| err("invalid_evidence"))?;
    confirmed.validate(command)?;
    Ok(Some(
        json!({"type":"device_result","reported":{confirmed.path:confirmed.value}}),
    ))
}

impl Data {
    /// 仅供宿主装配。策略不序列化，精确纳入Store的配置摘要。
    pub fn with_property_bridges(mut self, policies: &[Policy]) -> Result<Self> {
        ensure(
            policies.len()
                + self
                    .devices
                    .values()
                    .filter(|device| device.observation_policy.is_some())
                    .count()
                <= 16
                && self
                    .devices
                    .values()
                    .all(|device| device.property_bridge_policy.is_none()),
            "invalid_property_bridge_config",
        )?;
        let mut devices = BTreeSet::new();
        let mut adapters = BTreeSet::new();
        for policy in policies {
            let source = &policy.observation;
            source.source.validate()?;
            ensure(
                identifier(&source.device_id)
                    && devices.insert(&source.device_id)
                    && adapters.insert(&source.source.adapter_id),
                "invalid_property_bridge_config",
            )?;
            let device = self
                .devices
                .get(&source.device_id)
                .ok_or_else(|| err("device_not_found"))?;
            ensure(
                device.observation_policy.is_none()
                    && !self
                        .observation_registry
                        .bindings
                        .contains_key(&source.device_id)
                    && !self
                        .execution_registry
                        .bindings
                        .contains_key(&source.device_id)
                    && (device.routes.is_empty() || device.routes == policy.routes())
                    && !self.devices.values().any(|other| {
                        other.device_id != source.device_id
                            && (other
                                .routes
                                .values()
                                .any(|route| route.adapter_id == source.source.adapter_id)
                                || other.observation_policy.as_ref().is_some_and(|bound| {
                                    bound.source.adapter_id == source.source.adapter_id
                                }))
                    }),
                "property_bridge_source_conflict",
            )?;
            ensure(
                device.model_revision == source.model_revision,
                "observation_model_mismatch",
            )?;
            let model = self
                .models
                .get(&source.model_revision)
                .ok_or_else(|| err("observation_model_mismatch"))?;
            ensure(
                digest(model)? == source.model_revision,
                "property_bridge_model_unsupported",
            )?;
            policy.validate_model(model)?;
        }
        for policy in policies {
            let device = self.devices.get_mut(&policy.observation.device_id).unwrap();
            device.routes = policy.routes();
            device.property_bridge_policy = Some(policy.clone());
            device.observation_policy = Some(policy.observation.clone());
            device.observation_session = None;
            device.adapter_sessions.clear();
            device.ready = false;
            device.device_info = None;
            device.receipt_ledger = false;
            device.native_actions = None;
        }
        Ok(self)
    }

    /// 恢复时路由必须与宿主授权逐字匹配；缺失或额外路由不能被静默重建。
    pub fn validate_persisted_property_bridges(&self, policies: &[Policy]) -> Result<()> {
        for policy in policies {
            ensure(
                self.devices
                    .get(&policy.observation.device_id)
                    .is_some_and(|device| device.routes == policy.routes()),
                "storage_corrupt",
            )?;
        }
        Ok(())
    }

    pub fn has_property_bridges(&self) -> bool {
        self.devices
            .values()
            .any(|device| device.property_bridge_policy.is_some())
    }

    pub(crate) fn check_property_bridge_session(
        &self,
        device: &Device,
        path: &str,
        now: DateTime<Utc>,
    ) -> Result<()> {
        let Some(policy) = &device.property_bridge_policy else {
            return Ok(());
        };
        let model = &self.models[&device.model_revision];
        ensure(
            policy.write_paths.contains(path)
                && device.observation_policy.as_ref() == Some(&policy.observation)
                && device.state_ready(now)
                && device.observation_session.as_ref().is_some_and(|source| {
                    source.sequence > 0
                        && device
                            .adapter_sessions
                            .get(&policy.observation.source.adapter_id)
                            .is_some_and(|adapter| {
                                adapter.route == policy.observation.source
                                    && adapter.session_id == source.token
                            })
                })
                && model.services.iter().all(|service| {
                    service.properties.iter().all(|property| {
                        device
                            .reported
                            .get(&format!("{}.{}", service.id, property.id))
                            .is_some_and(|sample| {
                                let age = now
                                    .signed_duration_since(sample.observed_at)
                                    .num_milliseconds();
                                sample.quality == "confirmed"
                                    && age >= 0
                                    && age <= property.max_age_ms as i64
                            })
                    })
                }),
            "device_offline",
        )
    }

    pub(crate) fn close_property_bridge(&mut self, device_id: &str) {
        let device = self.devices.get_mut(device_id).unwrap();
        let Some(policy) = &device.property_bridge_policy else {
            return;
        };
        device
            .adapter_sessions
            .remove(&policy.observation.source.adapter_id);
        for command in self
            .commands
            .values_mut()
            .filter(|command| command.request.device_id == device_id)
        {
            match command.status.as_str() {
                "accepted" => {
                    command.status = "rejected".into();
                    command.error = Some("device_offline".into());
                }
                "dispatched" => {
                    command.status = "unknown".into();
                    command.error = Some("execution_unknown".into());
                }
                _ => {}
            }
        }
    }

    /// 固定属性命令的协议受理证据。仍占用原FIFO，绝不写入reported。
    pub fn apply_property_adapter_result(
        &mut self,
        receipt: AdapterReceipt,
        now: DateTime<Utc>,
    ) -> Result<Command> {
        let command = self
            .commands
            .get(&receipt.command_id)
            .ok_or_else(|| err("command_not_found"))?
            .clone();
        ensure(
            command.request.operation.kind == "property.set" && command.execution_route.is_some(),
            "unsupported_execution_route",
        )?;
        ensure(
            command.execution_route.as_ref() == Some(&receipt.route)
                && command.envelope.session_id.as_deref() == Some(receipt.session_id.as_str())
                && command.request_digest == receipt.request_digest,
            "execution_source_mismatch",
        )?;
        ensure(command.status == "dispatched", "invalid_transition")?;
        ensure(
            matches!(receipt.status.as_str(), "protocol_accepted" | "unknown"),
            "invalid_result",
        )?;
        if receipt.status == "unknown" {
            ensure(
                receipt.error.as_deref() == Some("execution_unknown"),
                "invalid_result",
            )?;
            let stored = self.commands.get_mut(&command.command_id).unwrap();
            stored.status = "unknown".into();
            stored.error = Some("execution_unknown".into());
            // 保留此前已受理证据，未知不是相反状态的确认。
            if stored.evidence.is_none() {
                stored.evidence = Some(json!({"type":"device_result"}));
            }
            return Ok(stored.clone());
        }
        if let Some(evidence) = &command.evidence {
            let accepted: Acceptance =
                serde_json::from_value(evidence.clone()).map_err(|_| err("invalid_evidence"))?;
            accepted.validate(&command)?;
            ensure(
                digest(&accepted.receipt)? == digest(&receipt)?,
                "duplicate_conflict",
            )?;
            return Ok(command);
        }
        self.recheck_adapter_dispatch(&command, now)?;
        let device = &self.devices[&command.request.device_id];
        ensure(
            device.property_bridge_policy.is_some(),
            "property_bridge_session_required",
        )?;
        let source = device
            .observation_session
            .as_ref()
            .ok_or_else(|| err("observation_session_closed"))?;
        let accepted = Acceptance {
            kind: "property_adapter_result".into(),
            receipt,
            source_sequence: source.sequence,
            state_revision: device.state_revision,
            received_at: now,
        };
        accepted.validate(&command)?;
        let stored = self.commands.get_mut(&command.command_id).unwrap();
        stored.evidence = Some(json!(accepted));
        Ok(stored.clone())
    }

    pub(crate) fn observe_property_bridge(
        &mut self,
        policy: &observation::Policy,
        token: &str,
        now: DateTime<Utc>,
    ) -> Result<()> {
        let device = self.devices.get_mut(&policy.device_id).unwrap();
        if device.property_bridge_policy.is_none() {
            return Ok(());
        }
        device.adapter_sessions.insert(
            policy.source.adapter_id.clone(),
            Session {
                route: policy.source.clone(),
                session_id: token.into(),
                observed_at: now,
            },
        );
        let sequence = device.observation_session.as_ref().unwrap().sequence;
        for command in self.commands.values_mut().filter(|command| {
            command.request.device_id == policy.device_id
                && command.status == "dispatched"
                && command.execution_route.as_ref() == Some(&policy.source)
                && command.envelope.session_id.as_deref() == Some(token)
        }) {
            if command.request.expires_at <= now {
                command.status = "unknown".into();
                command.error = Some("execution_unknown".into());
                continue;
            }
            let Some(evidence) = &command.evidence else {
                continue;
            };
            let accepted: Acceptance =
                serde_json::from_value(evidence.clone()).map_err(|_| err("invalid_evidence"))?;
            accepted.validate(command)?;
            let path = &command.request.operation.path;
            let sample = &device.reported[path];
            if sequence > accepted.source_sequence
                && device.state_revision > accepted.state_revision
                && sample.observed_at > accepted.received_at
                && sample.value == command.request.operation.value
            {
                command.evidence = Some(json!(Confirmation {
                    kind: "property_observation_result".into(),
                    acceptance: accepted,
                    path: path.clone(),
                    value: sample.value.clone(),
                    observed_at: sample.observed_at,
                    source_sequence: sequence,
                    state_revision: device.state_revision,
                }));
                command.status = "confirmed".into();
                command.error = None;
            }
        }
        Ok(())
    }

    pub fn validate_property_bridge_receipts(&self) -> Result<()> {
        for command in self.commands.values().filter(|command| {
            command.execution_route.is_some() && command.request.operation.kind == "property.set"
        }) {
            ensure(
                matches!(
                    command.status.as_str(),
                    "accepted" | "dispatched" | "confirmed" | "unknown" | "rejected" | "expired"
                ) && digest(&command.request)? == command.request_digest
                    && command.envelope.body["operation"] == json!(command.request.operation)
                    && command.envelope.body["expires_at"] == json!(command.request.expires_at),
                "invalid_evidence",
            )?;
            let Some(evidence) = &command.evidence else {
                ensure(command.status != "confirmed", "invalid_evidence")?;
                continue;
            };
            match evidence["type"].as_str() {
                Some("property_adapter_result") => {
                    ensure(
                        matches!(command.status.as_str(), "dispatched" | "unknown"),
                        "invalid_evidence",
                    )?;
                    let accepted: Acceptance = serde_json::from_value(evidence.clone())
                        .map_err(|_| err("invalid_evidence"))?;
                    accepted.validate(command)?;
                }
                Some("property_observation_result") => {
                    let confirmed: Confirmation = serde_json::from_value(evidence.clone())
                        .map_err(|_| err("invalid_evidence"))?;
                    confirmed.validate(command)?;
                }
                Some("device_result") => {
                    ensure(
                        command.status == "unknown" && evidence == &json!({"type":"device_result"}),
                        "invalid_evidence",
                    )?;
                }
                _ => return Err(err("invalid_evidence")),
            }
        }
        Ok(())
    }
}
