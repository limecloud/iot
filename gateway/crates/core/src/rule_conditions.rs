//! 有界条件只读取当前会话的新鲜观测；不执行IO或隐式类型/单位转换。
use crate::{
    engine::{Data, Observation},
    ensure, err,
    model::Model,
    Result,
};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const MAX_NODES: usize = 32;
pub const MAX_DEPTH: usize = 4;
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(untagged, deny_unknown_fields)]
pub enum Condition {
    Compare(Comparison),
    All { all: Vec<Condition> },
    Any { any: Vec<Condition> },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Comparison {
    pub device: String,
    pub property: String,
    pub operator: Operator,
    #[serde(deserialize_with = "value")]
    pub value: Value,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "unit"
    )]
    pub unit: Option<String>,
}
fn value<'de, D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Value, D::Error> {
    Value::deserialize(d)
}
fn unit<'de, D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Option<String>, D::Error> {
    String::deserialize(d).map(Some)
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Operator {
    Eq,
    Ne,
    Lt,
    Lte,
    Gt,
    Gte,
}
impl Comparison {
    pub fn validate_model(&self, model: &Model) -> Result<()> {
        let property = model
            .property(&self.property)
            .map_err(|_| err("invalid_condition"))?;
        ensure(
            property.access.iter().any(|a| a == "read") && property.unit == self.unit,
            "invalid_condition",
        )?;
        ensure(
            matches!(
                property.schema.kind.as_str(),
                "integer" | "number" | "string" | "boolean"
            ),
            "invalid_condition",
        )?;
        ensure(
            matches!(self.operator, Operator::Eq | Operator::Ne)
                || matches!(property.schema.kind.as_str(), "integer" | "number"),
            "invalid_condition",
        )?;
        property
            .schema
            .validate(&self.value)
            .map_err(|_| err("invalid_condition"))
    }
    fn matches(&self, observed: &Value) -> bool {
        if let (Some(a), Some(b)) = (observed.as_f64(), self.value.as_f64()) {
            match self.operator {
                Operator::Eq => a == b,
                Operator::Ne => a != b,
                Operator::Lt => a < b,
                Operator::Lte => a <= b,
                Operator::Gt => a > b,
                Operator::Gte => a >= b,
            }
        } else {
            match self.operator {
                Operator::Eq => observed == &self.value,
                Operator::Ne => observed != &self.value,
                _ => false,
            }
        }
    }
}
fn walk(
    conditions: &[Condition],
    depth: usize,
    count: &mut usize,
    visit: &mut impl FnMut(&Comparison) -> Result<()>,
) -> Result<()> {
    ensure(
        conditions.len() <= 16 && (conditions.is_empty() || depth <= MAX_DEPTH),
        "invalid_condition",
    )?;
    for condition in conditions {
        *count += 1;
        ensure(*count <= MAX_NODES, "invalid_condition")?;
        match condition {
            Condition::Compare(c) => visit(c)?,
            Condition::All { all: children } | Condition::Any { any: children } => {
                ensure(!children.is_empty(), "invalid_condition")?;
                walk(children, depth + 1, count, visit)?;
            }
        }
    }
    Ok(())
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Evaluation {
    pub evaluated_at: DateTime<Utc>,
    pub conditions: Vec<Condition>,
    pub matched: bool,
    pub results: Vec<Node>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Node {
    pub matched: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_revision: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observation: Option<Observation>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<Node>,
}
impl Data {
    pub fn validate_conditions(&self, conditions: &[Condition]) -> Result<()> {
        walk(conditions, 1, &mut 0, &mut |c| {
            let device = self
                .devices
                .get(&c.device)
                .ok_or_else(|| err("device_not_found"))?;
            self.check_model_authority(&c.device)?;
            c.validate_model(&self.models[&device.model_revision])
        })
    }
    pub(crate) fn validate_condition_binding(
        &self,
        conditions: &[Condition],
        device: &str,
        model: &Model,
    ) -> Result<()> {
        walk(conditions, 1, &mut 0, &mut |c| {
            if c.device == device {
                c.validate_model(model)
            } else {
                Ok(())
            }
        })
    }
    pub fn validate_saved_conditions(&self) -> Result<()> {
        for deployment in self.deployments.values() {
            walk(&deployment.rule.conditions, 1, &mut 0, &mut |c| {
                let device = self
                    .devices
                    .get(&c.device)
                    .ok_or_else(|| err("invalid_condition"))?;
                c.validate_model(&self.models[&device.model_revision])
            })?;
        }
        for run in self.runs.values() {
            if let Some(evaluation) = &run.condition_evaluation {
                ensure(!evaluation.conditions.is_empty(), "invalid_condition")?;
                walk(&evaluation.conditions, 1, &mut 0, &mut |_| Ok(()))?;
                self.validate_evaluation(
                    &evaluation.conditions,
                    &evaluation.results,
                    evaluation.evaluated_at,
                )?;
                ensure(
                    evaluation.matched == evaluation.results.iter().all(|n| n.matched),
                    "invalid_condition",
                )?;
            }
        }
        Ok(())
    }
    fn validate_evaluation(
        &self,
        conditions: &[Condition],
        nodes: &[Node],
        now: DateTime<Utc>,
    ) -> Result<()> {
        ensure(conditions.len() == nodes.len(), "invalid_condition")?;
        for (condition, node) in conditions.iter().zip(nodes) {
            match condition {
                Condition::Compare(c) => {
                    ensure(
                        node.children.is_empty() && node.model_revision.is_some(),
                        "invalid_condition",
                    )?;
                    if node.reason.is_none() {
                        let model = self
                            .models
                            .get(node.model_revision.as_ref().unwrap())
                            .ok_or_else(|| err("invalid_condition"))?;
                        c.validate_model(model)?;
                        let observation = node
                            .observation
                            .as_ref()
                            .ok_or_else(|| err("invalid_condition"))?;
                        let property = model.property(&c.property)?;
                        property.schema.validate(&observation.value)?;
                        ensure(
                            observation.quality == "confirmed"
                                && observation.observed_at <= now
                                && now - observation.observed_at
                                    <= Duration::milliseconds(property.max_age_ms as i64)
                                && node.matched == c.matches(&observation.value),
                            "invalid_condition",
                        )?;
                    } else {
                        ensure(!node.matched, "invalid_condition")?;
                    }
                }
                Condition::All { all } | Condition::Any { any: all } => {
                    ensure(
                        node.observation.is_none()
                            && node.model_revision.is_none()
                            && node.reason.is_none(),
                        "invalid_condition",
                    )?;
                    self.validate_evaluation(all, &node.children, now)?;
                    let matched = match condition {
                        Condition::All { .. } => node.children.iter().all(|n| n.matched),
                        _ => node.children.iter().any(|n| n.matched),
                    };
                    ensure(node.matched == matched, "invalid_condition")?;
                }
            }
        }
        Ok(())
    }
    pub fn evaluate_conditions(
        &self,
        conditions: &[Condition],
        now: DateTime<Utc>,
    ) -> Result<Evaluation> {
        walk(conditions, 1, &mut 0, &mut |_| Ok(()))?;
        let results: Vec<_> = conditions
            .iter()
            .map(|c| self.evaluate_condition(c, now))
            .collect();
        Ok(Evaluation {
            evaluated_at: now,
            conditions: conditions.to_vec(),
            matched: results.iter().all(|n| n.matched),
            results,
        })
    }
    fn evaluate_condition(&self, condition: &Condition, now: DateTime<Utc>) -> Node {
        let mut node = Node {
            matched: false,
            reason: None,
            model_revision: None,
            observation: None,
            children: Vec::new(),
        };
        match condition {
            Condition::All { all } | Condition::Any { any: all } => {
                node.children = all
                    .iter()
                    .map(|c| self.evaluate_condition(c, now))
                    .collect();
                node.matched = match condition {
                    Condition::All { .. } => node.children.iter().all(|c| c.matched),
                    _ => node.children.iter().any(|c| c.matched),
                };
            }
            Condition::Compare(c) => {
                let Some(device) = self.devices.get(&c.device) else {
                    node.reason = Some("device_not_found".into());
                    return node;
                };
                node.model_revision = Some(device.model_revision.clone());
                node.observation = device.reported.get(&c.property).cloned();
                let reason = if self.check_model_authority(&c.device).is_err() {
                    Some("model_authority_unavailable")
                } else if !device.ready
                    || device.observation_policy.is_some() && !device.state_ready(now)
                    || device
                        .last_seen
                        .is_none_or(|seen| seen > now || now - seen > Duration::seconds(30))
                {
                    Some("device_offline")
                } else if let Some(observation) = &node.observation {
                    let property = self.models[&device.model_revision].property(&c.property);
                    if let Ok(property) = property {
                        if c.validate_model(&self.models[&device.model_revision])
                            .is_err()
                            || property.schema.validate(&observation.value).is_err()
                        {
                            Some("invalid_condition")
                        } else if observation.quality != "confirmed" {
                            Some("unconfirmed_observation")
                        } else if observation.observed_at > now {
                            Some("future_observation")
                        } else if now - observation.observed_at
                            > Duration::milliseconds(property.max_age_ms as i64)
                        {
                            Some("stale_observation")
                        } else {
                            node.matched = c.matches(&observation.value);
                            None
                        }
                    } else {
                        Some("invalid_condition")
                    }
                } else {
                    Some("missing_observation")
                };
                node.reason = reason.map(str::to_owned);
            }
        }
        node
    }
}
