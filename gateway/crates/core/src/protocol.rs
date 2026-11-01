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
pub struct Trigger {
    pub device: String,
    pub event: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SetValue {
    pub path: String,
    pub value: Value,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Action {
    pub device: String,
    pub set: SetValue,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Rule {
    pub version: u8,
    pub id: String,
    pub trigger: Trigger,
    pub conditions: Vec<Value>,
    pub actions: Vec<Action>,
    pub cooldown_ms: u64,
}
