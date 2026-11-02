//! 当前应用会话的设备自报信息。报告不是硬件证明，也不授予升级权限。
use crate::{engine::Data, ensure, err, ota, protocol::Envelope, Result};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};

pub const MAX_INFO_AGE_SECONDS: i64 = 5;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeviceInfo {
    pub device: ota::Device,
    pub boot_id: String,
    pub session_id: String,
    pub seq: u64,
    pub received_at: DateTime<Utc>,
}

impl Data {
    pub(crate) fn apply_device_info(
        &mut self,
        message: &Envelope,
        now: DateTime<Utc>,
    ) -> Result<()> {
        let info: ota::Device =
            serde_json::from_value(message.body.clone()).map_err(|_| err("invalid_device_info"))?;
        ensure(
            serde_json::to_value(&info).ok().as_ref() == Some(&message.body),
            "invalid_device_info",
        )?;
        ota::check_device(&info)?;
        ensure(
            info.device_id == message.device_id && info.model_revision == message.model_revision,
            "device_info_mismatch",
        )?;
        let report = DeviceInfo {
            device: info,
            boot_id: message.boot_id.clone().ok_or_else(|| err("invalid_boot"))?,
            session_id: message
                .session_id
                .clone()
                .ok_or_else(|| err("session_mismatch"))?,
            seq: message.seq.ok_or_else(|| err("invalid_sequence"))?,
            received_at: now,
        };
        self.devices
            .get_mut(&message.device_id)
            .unwrap()
            .device_info = Some(report);
        Ok(())
    }

    pub fn current_device_info(&self, id: &str, now: DateTime<Utc>) -> Result<&DeviceInfo> {
        self.check_model_authority(id)?;
        let device = self
            .devices
            .get(id)
            .ok_or_else(|| err("device_not_found"))?;
        ensure(
            device.ready
                && device.last_seen.is_some_and(|at| {
                    let age = now.signed_duration_since(at);
                    age >= Duration::zero() && age < Duration::seconds(15)
                }),
            "device_offline",
        )?;
        let info = device
            .device_info
            .as_ref()
            .ok_or_else(|| err("device_info_unavailable"))?;
        ensure(
            device.boot_id.as_ref() == Some(&info.boot_id)
                && device.session_id.as_ref() == Some(&info.session_id)
                && info.device.device_id == id
                && info.device.model_revision == device.model_revision
                && info.seq <= device.last_seq,
            "device_info_mismatch",
        )?;
        let age = now.signed_duration_since(info.received_at);
        ensure(
            age >= Duration::zero() && age < Duration::seconds(MAX_INFO_AGE_SECONDS),
            "device_info_stale",
        )?;
        ota::check_device(&info.device)?;
        Ok(info)
    }
}
