use limeiot_core::{ensure, Result};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, net::SocketAddrV4, path::PathBuf};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LaunchCategory {
    Leanback,
    Launcher,
}
impl LaunchCategory {
    pub(crate) fn intent(self) -> &'static str {
        match self {
            Self::Leanback => "android.intent.category.LEANBACK_LAUNCHER",
            Self::Launcher => "android.intent.category.LAUNCHER",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ApplicationGrant {
    pub application_id: String,
    pub category: LaunchCategory,
}

/// 本地所有者提供的固定执行配置；不接受命令正文覆盖连接目标或授权。
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub schema_version: u8,
    pub adb_path: PathBuf,
    pub state_directory: PathBuf,
    pub server_port: u16,
    pub target: SocketAddrV4,
    pub fingerprint: String,
    pub device_serial: String,
    pub applications: Vec<ApplicationGrant>,
    pub timeout_ms: u64,
}

pub fn application_id(value: &str) -> bool {
    value.len() <= 255
        && value.contains('.')
        && value.split('.').all(|part| {
            part.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
        })
}

impl Config {
    pub fn validate(&self) -> Result<()> {
        ensure(
            self.schema_version == 1
                && self.adb_path.is_absolute()
                && self.state_directory.is_absolute()
                && self.server_port >= 1024
                && self.server_port != 5037
                && self.target.ip().is_private()
                && self.target.port() != 0
                && (50..=5000).contains(&self.timeout_ms)
                && (16..=512).contains(&self.fingerprint.len())
                && self
                    .fingerprint
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"/._:-".contains(&byte))
                && self.applications.len() <= 32,
            "invalid_tv_adapter_config",
        )?;
        ensure(
            limeiot_core::identifier(&self.device_serial),
            "invalid_tv_adapter_config",
        )?;
        let mut ids = BTreeSet::new();
        ensure(
            self.applications.iter().all(|grant| {
                application_id(&grant.application_id) && ids.insert(&grant.application_id)
            }),
            "invalid_tv_adapter_config",
        )
    }
}
