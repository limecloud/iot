//! 宿主配置的只读观测来源；与设备MQTT身份和动作执行会话相互隔离。
use crate::{
    digest,
    engine::{Data, Observation},
    ensure, err,
    execution::Route,
    id, identifier, Result,
};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Policy {
    pub device_id: String,
    pub model_revision: String,
    pub source: Route,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Sample {
    pub path: String,
    pub value: Value,
    pub unit: Option<String>,
    pub observed_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Snapshot {
    pub sequence: u64,
    pub samples: Vec<Sample>,
}

#[derive(Clone, Debug)]
pub(crate) struct Session {
    pub(crate) token: String,
    started_at: DateTime<Utc>,
    pub(crate) sequence: u64,
}

pub(crate) fn validate_model(model: &crate::model::Model) -> Result<()> {
    validate_observable_model(model)?;
    ensure(
        model.services.iter().all(|service| {
            service
                .properties
                .iter()
                .all(|property| !property.access.iter().any(|access| access == "write"))
        }),
        "observation_model_unsupported",
    )
}

pub(crate) fn validate_observable_model(model: &crate::model::Model) -> Result<()> {
    model
        .validate()
        .map_err(|_| err("observation_model_unsupported"))?;
    let count: usize = model
        .services
        .iter()
        .map(|service| service.properties.len())
        .sum();
    ensure(
        count > 0
            && count <= 64
            && model.services.iter().all(|service| {
                service.actions.is_empty()
                    && service.events.is_empty()
                    && service
                        .properties
                        .iter()
                        .all(|property| property.access.iter().any(|access| access == "read"))
            }),
        "observation_model_unsupported",
    )
}

impl Data {
    /// 仅由宿主装配时注入；策略由持久化宿主配置摘要保护，不从快照恢复。
    pub fn with_observation_sources(mut self, policies: &[Policy]) -> Result<Self> {
        ensure(policies.len() <= 16, "invalid_observation_config")?;
        ensure(
            self.devices
                .values()
                .all(|device| device.observation_policy.is_none()),
            "observation_already_configured",
        )?;
        let mut devices = BTreeSet::new();
        let mut adapters = BTreeSet::new();
        for policy in policies {
            ensure(
                identifier(&policy.device_id)
                    && devices.insert(&policy.device_id)
                    && adapters.insert(&policy.source.adapter_id),
                "invalid_observation_config",
            )?;
            policy.source.validate()?;
            let device = self
                .devices
                .get(&policy.device_id)
                .ok_or_else(|| err("device_not_found"))?;
            ensure(device.routes.is_empty(), "observation_execution_conflict")?;
            self.validate_observation_model(policy)?;
        }
        for policy in policies {
            let device = self.devices.get_mut(&policy.device_id).unwrap();
            device.observation_policy = Some(policy.clone());
            device.observation_session = None;
            device.ready = false;
            device.device_info = None;
            device.receipt_ledger = false;
            device.native_actions = None;
        }
        Ok(self)
    }

    fn validate_observation_model(&self, policy: &Policy) -> Result<()> {
        let device = self
            .devices
            .get(&policy.device_id)
            .ok_or_else(|| err("device_not_found"))?;
        ensure(
            device.model_revision == policy.model_revision,
            "observation_model_mismatch",
        )?;
        let model = self
            .models
            .get(&policy.model_revision)
            .ok_or_else(|| err("observation_model_mismatch"))?;
        ensure(
            digest(model)? == policy.model_revision,
            "observation_model_unsupported",
        )?;
        if let Some(bridge) = &device.property_bridge_policy {
            ensure(bridge.observation == *policy, "observation_source_mismatch")?;
            bridge.validate_model(model)
        } else {
            validate_model(model)
        }
    }

    fn check_observation_policy(&self, policy: &Policy) -> Result<()> {
        let device = self
            .devices
            .get(&policy.device_id)
            .ok_or_else(|| err("device_not_found"))?;
        ensure(
            device.observation_policy.as_ref() == Some(policy),
            "observation_source_mismatch",
        )?;
        ensure(
            self.observation_registry
                .bindings
                .get(&policy.device_id)
                .is_none_or(|binding| binding.active),
            "observation_source_revoked",
        )?;
        self.validate_observation_model(policy)?;
        self.check_model_authority(&policy.device_id)
    }

    pub fn begin_observation(&mut self, policy: &Policy, now: DateTime<Utc>) -> Result<String> {
        self.check_observation_policy(policy)?;
        self.close_property_bridge(&policy.device_id);
        self.reset_threshold_source(&policy.device_id);
        let token = id();
        let device = self.devices.get_mut(&policy.device_id).unwrap();
        device.ready = false;
        device.last_seen = None;
        device.observation_session = Some(Session {
            token: token.clone(),
            started_at: now,
            sequence: 0,
        });
        Ok(token)
    }

    /// 每次提交完整、按序且新鲜的属性集。只有原Store事务成功后才能公布。
    pub fn observe(
        &mut self,
        policy: &Policy,
        token: &str,
        snapshot: Snapshot,
        now: DateTime<Utc>,
    ) -> Result<u64> {
        self.check_observation_policy(policy)?;
        let device = &self.devices[&policy.device_id];
        let session = device
            .observation_session
            .as_ref()
            .ok_or_else(|| err("observation_session_closed"))?;
        ensure(session.token == token, "observation_session_mismatch")?;
        ensure(
            snapshot.sequence == session.sequence + 1 && snapshot.sequence <= 9_007_199_254_740_991,
            "observation_out_of_order",
        )?;
        let model = &self.models[&policy.model_revision];
        let count: usize = model
            .services
            .iter()
            .map(|service| service.properties.len())
            .sum();
        ensure(
            snapshot.samples.len() == count && count <= 64,
            "snapshot_incomplete",
        )?;
        let mut reported = BTreeMap::new();
        for sample in snapshot.samples {
            let property = model.property(&sample.path)?;
            property.schema.validate(&sample.value)?;
            ensure(property.unit == sample.unit, "observation_unit_mismatch")?;
            ensure(
                sample.observed_at >= session.started_at
                    && sample.observed_at <= now
                    && now - sample.observed_at
                        <= Duration::milliseconds(property.max_age_ms as i64),
                "observation_time_invalid",
            )?;
            if session.sequence > 0 {
                ensure(
                    device
                        .reported
                        .get(&sample.path)
                        .is_none_or(|previous| sample.observed_at > previous.observed_at),
                    "observation_out_of_order",
                )?;
            }
            let observation = Observation {
                value: sample.value,
                observed_at: sample.observed_at,
                quality: "confirmed".into(),
                source: format!(
                    "adapter:{}:{}",
                    policy.source.adapter_id, policy.source.revision
                ),
            };
            ensure(
                reported.insert(sample.path, observation).is_none(),
                "snapshot_incomplete",
            )?;
        }
        let was_ready = device.state_ready(now);
        let revision = device
            .state_revision
            .checked_add(1)
            .filter(|value| *value <= 9_007_199_254_740_991)
            .ok_or_else(|| err("capacity_exceeded"))?;
        let device = self.devices.get_mut(&policy.device_id).unwrap();
        device.reported = reported;
        device.state_revision = revision;
        device.ready = true;
        device.last_seen = Some(now);
        device.observation_session.as_mut().unwrap().sequence = snapshot.sequence;
        self.observe_property_bridge(policy, token, now)?;
        self.apply_observation_thresholds(
            &policy.device_id,
            &json!({"source":policy.source,"source_session":token}),
            now,
            was_ready,
        )?;
        Ok(revision)
    }

    pub fn end_observation(&mut self, policy: &Policy, token: &str) -> Result<()> {
        // 撤销模型信任后也允许关闭原来源；旧任务不能关闭较新的会话。
        let device = self
            .devices
            .get(&policy.device_id)
            .ok_or_else(|| err("device_not_found"))?;
        ensure(
            device.observation_policy.as_ref() == Some(policy),
            "observation_source_mismatch",
        )?;
        ensure(
            device
                .observation_session
                .as_ref()
                .is_some_and(|session| session.token == token),
            "observation_session_mismatch",
        )?;
        self.reset_threshold_source(&policy.device_id);
        self.close_property_bridge(&policy.device_id);
        let device = self.devices.get_mut(&policy.device_id).unwrap();
        device.ready = false;
        device.observation_session = None;
        Ok(())
    }
}
