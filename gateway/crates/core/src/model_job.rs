//! 有界模型任务的共享状态与部署身份；各能力自行校验输入和输出。
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Deployment {
    pub adapter: String,
    pub revision: String,
    pub model: String,
    pub data_location: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Running,
    Succeeded,
    Failed,
    Unknown,
    Discarded,
}
