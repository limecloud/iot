use crate::{ensure, identifier, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const MAX_PACKET: usize = 16 * 1024;
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Envelope {
    pub v: u8,
    pub kind: String,
    pub message_id: String,
    pub device_id: String,
    pub model_revision: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub boot_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seq: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub body: Value,
}
impl Envelope {
    pub fn decode(raw: &[u8]) -> Result<Self> {
        let value = crate::validation::bounded_document(raw, MAX_PACKET, 16, 2048)
            .ok_or_else(|| crate::err("invalid_message"))?;
        let message: Self =
            serde_json::from_value(value).map_err(|_| crate::err("invalid_message"))?;
        message.validate()?;
        Ok(message)
    }
    pub fn validate(&self) -> Result<()> {
        ensure(self.v == 1, "unsupported_version")?;
        ensure(
            identifier(&self.device_id) && identifier(&self.message_id),
            "invalid_message",
        )?;
        ensure(
            self.seq.map(|v| v <= 9_007_199_254_740_991).unwrap_or(true),
            "invalid_sequence",
        )
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Operation {
    #[serde(rename = "type")]
    pub kind: String,
    pub path: String,
    pub value: Value,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CommandRequest {
    pub space_id: String,
    pub device_id: String,
    pub model_revision: String,
    pub idempotency_key: String,
    pub expires_at: DateTime<Utc>,
    pub operation: Operation,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActionEvidence {
    #[serde(rename = "type")]
    pub kind: String,
    pub path: String,
    pub input_digest: String,
    pub output: Value,
    pub completion: String,
    pub observed_at: DateTime<Utc>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged, deny_unknown_fields)]
pub enum Trigger {
    Event {
        device: String,
        event: String,
    },
    Property {
        device: String,
        property: PropertyTrigger,
    },
    Schedule {
        schedule: crate::rule_schedule::Schedule,
    },
}
impl Trigger {
    pub fn device(&self) -> Option<&str> {
        match self {
            Self::Event { device, .. } | Self::Property { device, .. } => Some(device),
            Self::Schedule { .. } => None,
        }
    }
    pub fn validate_model(&self, model: &crate::model::Model) -> Result<()> {
        match self {
            Self::Event { event, .. } => model.event(event).map(|_| ()),
            Self::Property { property, .. } => property.validate_model(model),
            Self::Schedule { schedule } => schedule.validate(),
        }
    }
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Edge {
    Rising,
    Falling,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PropertyTrigger {
    pub path: String,
    pub unit: String,
    pub edge: Edge,
    #[serde(deserialize_with = "required_value")]
    pub threshold: Value,
    #[serde(deserialize_with = "required_value")]
    pub hysteresis: Value,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SetValue {
    pub path: String,
    #[serde(deserialize_with = "required_value")]
    pub value: Value,
}
fn required_value<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Value, D::Error> {
    Value::deserialize(deserializer)
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InvokeValue {
    pub path: String,
    #[serde(deserialize_with = "required_value")]
    pub input: Value,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged, deny_unknown_fields)]
pub enum Action {
    Set { device: String, set: SetValue },
    Invoke { device: String, invoke: InvokeValue },
}
impl Action {
    pub fn device(&self) -> &str {
        match self {
            Self::Set { device, .. } | Self::Invoke { device, .. } => device,
        }
    }
    pub fn operation(&self) -> Operation {
        match self {
            Self::Set { set, .. } => Operation {
                kind: "property.set".into(),
                path: set.path.clone(),
                value: set.value.clone(),
            },
            Self::Invoke { invoke, .. } => Operation {
                kind: "action.invoke".into(),
                path: invoke.path.clone(),
                value: invoke.input.clone(),
            },
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Rule {
    pub version: u8,
    pub id: String,
    pub trigger: Trigger,
    pub conditions: Vec<crate::rule_conditions::Condition>,
    pub actions: Vec<Action>,
    pub cooldown_ms: u64,
}
