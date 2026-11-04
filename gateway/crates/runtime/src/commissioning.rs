//! 宿主网络管理合同；与设备身份、观测绑定及领域执行命令分别记录。
use chrono::{DateTime, Utc};
use limeiot_core::{digest, ensure, err, identifier, validation::bounded_document, Result};
use serde::{Deserialize, Serialize};

pub const MAX_OPERATIONS: usize = 256;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Change {
    pub coordinator_id: String,
    pub expected_revision: String,
    pub duration_seconds: u8,
}
impl Change {
    pub fn validate(&self) -> Result<()> {
        ensure(
            identifier(&self.coordinator_id)
                && valid_revision(&self.expected_revision)
                && self.duration_seconds <= 120,
            "invalid_zigbee_change",
        )
    }
}
pub fn parse_change(bytes: &[u8]) -> Result<Change> {
    let value = bounded_document(bytes, 4096, 4, 64).ok_or_else(|| err("invalid_zigbee_change"))?;
    let change: Change =
        serde_json::from_value(value.clone()).map_err(|_| err("invalid_zigbee_change"))?;
    change.validate()?;
    ensure(digest(&change)? == digest(&value)?, "invalid_zigbee_change")?;
    Ok(change)
}
pub fn valid_revision(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}
fn valid_ieee(value: &str) -> bool {
    value.len() == 16
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        && value != "0000000000000000"
        && value != "ffffffffffffffff"
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Coordinator {
    pub coordinator_id: String,
    pub coordinator_ieee: String,
    pub revision: String,
    pub timeout_ms: u64,
}
impl Coordinator {
    pub fn validate(&self) -> Result<()> {
        ensure(
            identifier(&self.coordinator_id)
                && valid_ieee(&self.coordinator_ieee)
                && valid_revision(&self.revision)
                && (100..=30000).contains(&self.timeout_ms),
            "invalid_zigbee_coordinator",
        )
    }
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub space_id: String,
    pub idempotency_key: String,
    pub change: Change,
}
impl Request {
    pub fn validate(&self) -> Result<()> {
        ensure(
            identifier(&self.space_id) && identifier(&self.idempotency_key),
            "invalid_zigbee_change",
        )?;
        self.change.validate()
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Receipt {
    pub coordinator_ieee: String,
    pub duration_seconds: u8,
    pub observed_at: DateTime<Utc>,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Operation {
    pub operation_id: String,
    pub sequence: u32,
    pub request: Request,
    pub request_digest: String,
    pub coordinator: Coordinator,
    pub status: String,
    pub reason: Option<String>,
    pub result: Option<Receipt>,
    pub created_at: DateTime<Utc>,
    pub blocked_until: DateTime<Utc>,
    pub completed_at: Option<DateTime<Utc>>,
}
impl Operation {
    pub fn validate(&self) -> Result<()> {
        self.request.validate()?;
        self.coordinator.validate()?;
        let change = &self.request.change;
        ensure(
            identifier(&self.operation_id)
                && self.sequence > 0
                && self.sequence <= MAX_OPERATIONS as u32
                && self.request_digest == digest(&self.request)?
                && self.coordinator.coordinator_id == change.coordinator_id
                && self.coordinator.revision == change.expected_revision
                && self.blocked_until
                    == self.created_at
                        + chrono::Duration::milliseconds(
                            self.coordinator.timeout_ms as i64
                                + i64::from(change.duration_seconds) * 1000,
                        )
                && self.completed_at.is_none_or(|at| at >= self.created_at),
            "invalid_zigbee_operation",
        )?;
        match self.status.as_str() {
            "unknown" => ensure(
                self.result.is_none()
                    && self.reason.as_ref().is_some_and(|code| {
                        !code.is_empty()
                            && code.len() <= 64
                            && code
                                .bytes()
                                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
                    }),
                "invalid_zigbee_operation",
            ),
            "protocol_accepted" => ensure(
                self.reason.is_none()
                    && self.result.as_ref().is_some_and(|receipt| {
                        receipt.coordinator_ieee == self.coordinator.coordinator_ieee
                            && receipt.duration_seconds == change.duration_seconds
                            && self.completed_at == Some(receipt.observed_at)
                    }),
                "invalid_zigbee_operation",
            ),
            _ => Err(err("invalid_zigbee_operation")),
        }
    }
}
