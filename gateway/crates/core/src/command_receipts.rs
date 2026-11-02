//! 原命令账本上的设备回执确认；不单独保存第二套执行状态。
use crate::{digest, engine::Data, ensure, err, protocol::Envelope, Result};
use chrono::{DateTime, Utc};
use serde_json::json;

pub const MAX_COMMAND_SEQUENCE: u64 = 9_007_199_254_740_991;

/// 序号与两个下行ID绑定，回收正文后仍能拒绝旧ID的新会话重包。
pub fn command_sequence(value: &str) -> Option<u64> {
    let (number, nonce) = value.strip_prefix("c1-")?.split_once('-')?;
    let sequence: u64 = number.parse().ok()?;
    (sequence > 0
        && sequence <= MAX_COMMAND_SEQUENCE
        && sequence.to_string() == number
        && uuid::Uuid::parse_str(nonce).ok()?.to_string() == nonce)
        .then_some(sequence)
}

impl Data {
    pub fn validate_command_receipts(&self) -> Result<()> {
        let mut sequences = std::collections::BTreeSet::new();
        for (id, command) in &self.commands {
            ensure(command.sequence <= MAX_COMMAND_SEQUENCE, "storage_corrupt")?;
            ensure(
                command.sequence == 0 || sequences.insert(command.sequence),
                "storage_corrupt",
            )?;
            if id.starts_with("c1-") {
                ensure(
                    command_sequence(id) == Some(command.sequence)
                        && command.envelope.message_id == *id
                        && command.command_id == *id
                        && command.envelope.body["command_id"] == *id,
                    "storage_corrupt",
                )?;
            }
        }
        Ok(())
    }

    pub(crate) fn receipt_report(&mut self, message: &Envelope, now: DateTime<Utc>) -> Result<()> {
        let body = message
            .body
            .as_object()
            .ok_or_else(|| err("invalid_receipt"))?;
        ensure(body.len() == 2, "invalid_receipt")?;
        let original: Envelope = serde_json::from_value(message.body["command"].clone())
            .map_err(|_| err("invalid_receipt"))?;
        let id = original.body["command_id"]
            .as_str()
            .ok_or_else(|| err("invalid_receipt"))?;
        let stored = self
            .commands
            .get(id)
            .ok_or_else(|| err("command_not_found"))?;
        ensure(
            stored.request.device_id == message.device_id
                && stored.execution_route.is_none()
                && digest(&stored.envelope)? == digest(&original)?
                && message.body["result"]["command_id"] == id,
            "invalid_receipt",
        )?;
        let session = stored.envelope.session_id.clone();
        self.apply_command_result(
            &message.device_id,
            session.as_deref(),
            &message.body["result"],
            now,
        )?;
        // 网关重启不要求设备重连Broker；完整原结果查询可恢复本会话的回执协商。
        self.devices
            .get_mut(&message.device_id)
            .unwrap()
            .receipt_ledger = true;
        Ok(())
    }

    pub(crate) fn receipt_response(&self, message: &Envelope) -> Result<Option<Envelope>> {
        if !self.devices[&message.device_id].receipt_ledger {
            return Ok(None);
        }
        let result = if message.kind == "receipt" {
            &message.body["result"]
        } else {
            &message.body
        };
        if !matches!(result["status"].as_str(), Some("confirmed" | "failed")) {
            return Ok(None);
        }
        let id = result["command_id"]
            .as_str()
            .ok_or_else(|| err("invalid_receipt"))?;
        let stored = self
            .commands
            .get(id)
            .ok_or_else(|| err("command_not_found"))?;
        ensure(
            stored.request.device_id == message.device_id
                && stored.execution_route.is_none()
                && stored.status == result["status"]
                && stored.evidence.as_ref() == Some(&result["evidence"])
                && (stored.status != "failed"
                    || stored.error.as_deref() == result["error"].as_str()),
            "duplicate_conflict",
        )?;
        Ok(Some(Envelope {
            v: 1,
            kind: "receipt".into(),
            message_id: crate::id(),
            device_id: message.device_id.clone(),
            model_revision: message.model_revision.clone(),
            boot_id: None,
            seq: None,
            session_id: message.session_id.clone(),
            body: json!({"command_id":id,"command_digest":digest(&stored.envelope)?,"result_digest":digest(result)?}),
        }))
    }

    pub(crate) fn command_sequence_head(&self) -> u64 {
        self.commands
            .values()
            .map(|command| command.sequence)
            .max()
            .unwrap_or(0)
    }
}
