//! 自有领域合同与确定性校验，不依赖 MQTT、HTTP 或数据库框架。
pub mod command_receipts;
pub mod compatibility;
pub mod control;
pub mod device_events;
pub mod device_info;
pub mod draft;
pub mod engine;
pub mod execution;
pub mod execution_binding;
pub mod execution_plans;
pub mod media;
pub mod model;
pub mod model_bundles;
pub mod model_registry;
pub mod ota;
pub mod ota_execution;
pub mod ota_tasks;
pub mod protocol;
pub mod release;
pub mod remote;
pub mod rule_budget;
pub mod rule_conditions;
pub mod rule_graph;
pub mod rule_schedule;
pub mod rule_thresholds;
pub mod speech;
pub mod validation;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, thiserror::Error)]
#[error("{code}")]
pub struct Error {
    pub code: String,
}
pub type Result<T> = std::result::Result<T, Error>;
pub fn err(code: &str) -> Error {
    Error { code: code.into() }
}
pub fn ensure(condition: bool, code: &str) -> Result<()> {
    if condition {
        Ok(())
    } else {
        Err(err(code))
    }
}
pub fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
pub fn digest(value: &impl Serialize) -> Result<String> {
    use sha2::{Digest, Sha256};
    let bytes = serde_jcs::to_vec(value).map_err(|_| err("invalid_json"))?;
    Ok(format!("sha256:{:x}", Sha256::digest(bytes)))
}
pub fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}
