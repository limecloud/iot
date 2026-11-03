//! 只投影当前会话中通过完整校验的新鲜设备事件，不暴露原始传输信封。
use crate::{engine::Data, protocol::Envelope, Result};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct DeviceEvent {
    pub device_id: String,
    pub model_revision: String,
    pub boot_id: String,
    pub session_id: String,
    pub message_id: String,
    pub seq: u64,
    pub event_id: String,
    pub path: String,
    pub occurred_at: String,
    pub received_at: DateTime<Utc>,
    pub body_digest: String,
    pub data: Value,
}

pub struct Ingested {
    pub response: Option<Envelope>,
    pub event: Option<DeviceEvent>,
}

impl DeviceEvent {
    pub fn parsed_occurrence(&self) -> Result<DateTime<Utc>> {
        self.occurred_at
            .parse()
            .map_err(|_| crate::err("invalid_event_time"))
    }
}

impl Data {
    pub fn ingest_with_event_projection(
        &mut self,
        message: Envelope,
        now: DateTime<Utc>,
    ) -> Result<Ingested> {
        // 候选只保留白名单字段；完整授权、模型、会话、序列和事件校验仍由原入口执行。
        let candidate = self.live_event_candidate(&message, now);
        let response = self.ingest(message, now)?;
        if let Some(event) = &candidate {
            self.observe_execution_plan_event(event, now)?;
        }
        Ok(Ingested {
            response,
            event: candidate,
        })
    }

    fn live_event_candidate(&self, message: &Envelope, now: DateTime<Utc>) -> Option<DeviceEvent> {
        if message.kind != "event" || message.body["historical"].as_bool() != Some(false) {
            return None;
        }
        let event_id = message.body["event_id"].as_str()?;
        // 与 apply_event 完全相同的耐久业务去重键；新信封或重启不能重新投影原事件。
        if self
            .event_ids
            .contains_key(&format!("{}:{event_id}", message.device_id))
        {
            return None;
        }
        let occurred_at: DateTime<Utc> =
            serde_json::from_value(message.body["occurred_at"].clone()).ok()?;
        if now - occurred_at > Duration::seconds(5) || occurred_at > now + Duration::seconds(2) {
            return None;
        }
        Some(DeviceEvent {
            device_id: message.device_id.clone(),
            model_revision: message.model_revision.clone(),
            boot_id: message.boot_id.clone()?,
            session_id: message.session_id.clone()?,
            message_id: message.message_id.clone(),
            seq: message.seq?,
            event_id: event_id.into(),
            path: message.body["path"].as_str()?.into(),
            occurred_at: message.body["occurred_at"].as_str()?.into(),
            received_at: now,
            body_digest: crate::digest(&message.body).ok()?,
            data: message.body.get("data")?.clone(),
        })
    }
}
