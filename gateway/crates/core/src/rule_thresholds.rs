//! 属性阈值只消费当前会话的新鲜采样；边沿基线不跨重启恢复。
use crate::{
    digest,
    engine::{Data, Observation},
    ensure, err,
    model::Model,
    protocol::{Edge, Envelope, PropertyTrigger, Rule, Trigger},
    Result,
};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Debug)]
pub(crate) struct ThresholdCursor {
    observation: Observation,
    armed: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ThresholdEvidence {
    pub device_id: String,
    pub path: String,
    pub previous: Observation,
    pub current: Observation,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Samples {
    device_id: String,
    path: String,
    historical: bool,
    previous: Observation,
    current: Observation,
}

impl PropertyTrigger {
    pub fn validate_model(&self, model: &Model) -> Result<()> {
        let property = model.property(&self.path)?;
        ensure(
            matches!(property.schema.kind.as_str(), "integer" | "number")
                && property.access.iter().any(|v| v == "read")
                && property.access.iter().any(|v| v == "notify")
                && property.unit.as_deref() == Some(self.unit.as_str()),
            "invalid_threshold",
        )?;
        property
            .schema
            .validate(&self.threshold)
            .map_err(|_| err("invalid_threshold"))?;
        let delta = self
            .hysteresis
            .as_f64()
            .ok_or_else(|| err("invalid_threshold"))?;
        ensure(
            delta.is_finite()
                && (0.0..=9_007_199_254_740_991.0).contains(&delta)
                && (property.schema.kind != "integer" || delta.fract() == 0.0),
            "invalid_threshold",
        )?;
        let boundary = self.rearm_boundary();
        ensure(
            boundary.is_finite()
                && property.schema.minimum.is_none_or(|v| boundary >= v)
                && property.schema.maximum.is_none_or(|v| boundary <= v),
            "invalid_threshold",
        )
    }
    fn rearm_boundary(&self) -> f64 {
        let threshold = self.threshold.as_f64().unwrap();
        let delta = self.hysteresis.as_f64().unwrap();
        match self.edge {
            Edge::Rising => threshold - delta,
            Edge::Falling => threshold + delta,
        }
    }
    fn rearmed(&self, observation: &Observation) -> bool {
        let value = observation.value.as_f64().unwrap();
        match self.edge {
            Edge::Rising => value <= self.rearm_boundary(),
            Edge::Falling => value >= self.rearm_boundary(),
        }
    }
    fn active(&self, observation: &Observation) -> bool {
        let value = observation.value.as_f64().unwrap();
        let threshold = self.threshold.as_f64().unwrap();
        match self.edge {
            Edge::Rising => value > threshold,
            Edge::Falling => value < threshold,
        }
    }
}
fn fresh(sample: &Observation, now: DateTime<Utc>, max_age: u64) -> bool {
    sample.quality == "confirmed"
        && sample.observed_at <= now
        && now - sample.observed_at <= Duration::milliseconds(max_age as i64)
}
fn continuous(previous: &Observation, current: &Observation, max_age: u64) -> bool {
    previous.source == current.source
        && current.observed_at > previous.observed_at
        && current.observed_at - previous.observed_at <= Duration::milliseconds(max_age as i64)
}
impl Data {
    pub(crate) fn reset_threshold_source(&mut self, device: &str) {
        self.threshold_cursors.retain(|id, _| {
            self.deployments
                .get(id)
                .is_some_and(|d| d.rule.trigger.device() != Some(device))
        });
    }
    pub(crate) fn apply_property_thresholds(
        &mut self,
        message: &Envelope,
        now: DateTime<Utc>,
        was_ready: bool,
    ) -> Result<()> {
        let deployments: Vec<_> = self.deployments.values().filter(|d|
            matches!(&d.rule.trigger, Trigger::Property { device, .. } if device == &message.device_id)).cloned().collect();
        for deployment in deployments {
            let Trigger::Property { property, .. } = &deployment.rule.trigger else {
                unreachable!()
            };
            let device = &self.devices[&message.device_id];
            let model = &self.models[&device.model_revision];
            property.validate_model(model)?;
            let max_age = model.property(&property.path)?.max_age_ms;
            let observation = device.reported[&property.path].clone();
            if !fresh(&observation, now, max_age) {
                self.threshold_cursors.remove(&deployment.rule.id);
                continue;
            }
            let previous = self.threshold_cursors.get(&deployment.rule.id).cloned();
            if let Some(cursor) = &previous {
                // 同一或倒序采样不改变边沿基线，包含改值但沿用原时刻的缓存快照。
                if was_ready && observation.observed_at <= cursor.observation.observed_at {
                    continue;
                }
            }
            let mut armed = previous
                .as_ref()
                .filter(|cursor| {
                    was_ready && continuous(&cursor.observation, &observation, max_age)
                })
                .is_some_and(|cursor| cursor.armed);
            let crossed = armed && property.active(&observation);
            if crossed {
                armed = false;
            } else if property.rearmed(&observation) {
                armed = true;
            }
            self.threshold_cursors.insert(
                deployment.rule.id.clone(),
                ThresholdCursor {
                    observation: observation.clone(),
                    armed,
                },
            );
            // 冷却中的边沿也消耗，不等待冷却结束后补发。
            if !crossed
                || deployment.last_run.is_some_and(|t| {
                    now - t < Duration::milliseconds(deployment.rule.cooldown_ms as i64)
                })
            {
                continue;
            }
            let evidence = ThresholdEvidence {
                device_id: message.device_id.clone(),
                path: property.path.clone(),
                previous: previous.unwrap().observation,
                current: observation,
            };
            let event_id = format!(
                "state-{}",
                &digest(&json!({"boot_id":message.boot_id,
                "session_id":message.session_id,"sample":evidence}))?[7..]
            );
            self.run_deployment(deployment, &event_id, Some(evidence), None, now)?;
        }
        Ok(())
    }
    pub fn simulate_rule(&self, rule: &Rule, input: &Value, now: DateTime<Utc>) -> Result<Value> {
        let revision = self.validate_rule(rule)?;
        let condition_evaluation = (!rule.conditions.is_empty())
            .then(|| self.evaluate_conditions(&rule.conditions, now))
            .transpose()?;
        let trigger_matched = match &rule.trigger {
            Trigger::Event { device, event } => {
                let model = &self.models[&self.devices[device].model_revision];
                model.event(event)?.schema.validate(&input["data"])?;
                input["device_id"] == *device
                    && input["path"] == *event
                    && input["historical"] == false
            }
            Trigger::Property { device, property } => {
                let model = &self.models[&self.devices[device].model_revision];
                let samples: Samples =
                    serde_json::from_value(input.clone()).map_err(|_| err("invalid_simulation"))?;
                let spec = model.property(&property.path)?;
                spec.schema.validate(&samples.previous.value)?;
                spec.schema.validate(&samples.current.value)?;
                samples.device_id == *device
                    && samples.path == property.path
                    && !samples.historical
                    && fresh(&samples.previous, now, spec.max_age_ms)
                    && fresh(&samples.current, now, spec.max_age_ms)
                    && continuous(&samples.previous, &samples.current, spec.max_age_ms)
                    && property.rearmed(&samples.previous)
                    && property.active(&samples.current)
            }
            Trigger::Schedule { schedule } => {
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields)]
                struct Sample {
                    scheduled_at: DateTime<Utc>,
                }
                let sample: Sample =
                    serde_json::from_value(input.clone()).map_err(|_| err("invalid_simulation"))?;
                schedule.sample(sample.scheduled_at)?.is_some()
            }
        };
        let matched = trigger_matched && condition_evaluation.as_ref().is_none_or(|e| e.matched);
        let mut result = json!({"executed":false,"simulation":true,"revision":revision,"matched":matched,
            "proposed_actions":if matched {rule.actions.clone()} else {vec![]}});
        if let Some(evaluation) = condition_evaluation {
            result["trigger_matched"] = json!(trigger_matched);
            result["condition_evaluation"] =
                serde_json::to_value(evaluation).map_err(|_| err("invalid_json"))?;
        }
        Ok(result)
    }
}
