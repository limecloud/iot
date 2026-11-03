//! 单张图片的本地观察任务。耐久输入只有摘要，观察结果不具有设备执行权。
use crate::{
    digest, ensure, identifier,
    media::content_digest,
    model_job::{Deployment, Status},
    Result,
};
use chrono::{DateTime, Duration, SubsecRound, Utc};
use serde::{Deserialize, Serialize};

pub const MAX_IMAGE_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_EDGE: u32 = 1024;
pub const MAX_TASKS: usize = 128;
pub const MAX_REQUEST_BYTES: usize = MAX_IMAGE_BYTES.div_ceil(3) * 4 + 8192;
pub fn hash(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..]
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}
pub fn text(value: &str) -> bool {
    !value.trim().is_empty() && crate::transcription::text(value)
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Input {
    pub image_digest: String,
    pub image_bytes: usize,
    pub content_type: String,
    pub prompt_digest: String,
    pub retain_seconds: u32,
    pub expires_at: DateTime<Utc>,
}
impl Input {
    pub fn validate(&self) -> Result<()> {
        ensure(
            hash(&self.image_digest)
                && hash(&self.prompt_digest)
                && (1..=MAX_IMAGE_BYTES).contains(&self.image_bytes)
                && matches!(self.content_type.as_str(), "image/png" | "image/jpeg")
                && (60..=3600).contains(&self.retain_seconds)
                && self.expires_at == self.expires_at.trunc_subsecs(3),
            "invalid_vision_request",
        )
    }
    pub fn request_digest(&self, space: &str, key: &str) -> Result<String> {
        digest(
            &serde_json::json!({"space_id":space,"idempotency_key":key,"input":{
            "image_digest":self.image_digest,"image_bytes":self.image_bytes,"content_type":self.content_type,
            "prompt_digest":self.prompt_digest,"retain_seconds":self.retain_seconds,
            "expires_at":self.expires_at.to_rfc3339_opts(chrono::SecondsFormat::Millis,true)}}),
        )
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ImageSize {
    pub width: u32,
    pub height: u32,
}
impl ImageSize {
    pub fn validate(&self) -> Result<()> {
        ensure(
            (1..=MAX_EDGE).contains(&self.width) && (1..=MAX_EDGE).contains(&self.height),
            "invalid_vision_image",
        )
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Output {
    pub text: Option<String>,
    pub content_digest: String,
    pub expires_at: DateTime<Utc>,
    pub cleared_at: Option<DateTime<Utc>>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Task {
    pub vision_id: String,
    pub space_id: String,
    pub idempotency_key: String,
    pub request_digest: String,
    pub input: Input,
    pub image: ImageSize,
    pub deployment: Deployment,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub status: Status,
    pub output: Option<Output>,
    pub error_code: Option<String>,
}
impl Task {
    pub fn new(
        space: &str,
        key: &str,
        input: Input,
        image: ImageSize,
        deployment: Deployment,
        now: DateTime<Utc>,
    ) -> Result<Self> {
        input.validate()?;
        image.validate()?;
        ensure(
            identifier(space) && identifier(key),
            "invalid_idempotency_key",
        )?;
        ensure(
            input.expires_at > now && input.expires_at <= now + Duration::seconds(90),
            "invalid_vision_deadline",
        )?;
        Ok(Self {
            vision_id: format!("vision-{}", crate::id()),
            space_id: space.into(),
            idempotency_key: key.into(),
            request_digest: input.request_digest(space, key)?,
            input,
            image,
            deployment,
            created_at: now,
            updated_at: now,
            status: Status::Running,
            output: None,
            error_code: None,
        })
    }
    pub fn validate(&self, space: &str, saved_at: DateTime<Utc>) -> Result<()> {
        let corrupt = "media_storage_corrupt";
        ensure(
            self.input.validate().is_ok()
                && self.image.validate().is_ok()
                && self.space_id == space
                && identifier(&self.vision_id)
                && self.vision_id.starts_with("vision-")
                && identifier(&self.idempotency_key)
                && self.request_digest
                    == self.input.request_digest(space, &self.idempotency_key)?
                && self.deployment.adapter == "ollama-vision-v1"
                && hash(&self.deployment.revision)
                && crate::speech::model_id(&self.deployment.model)
                && self.deployment.data_location == "local"
                && self.created_at <= self.updated_at
                && self.updated_at <= saved_at
                && self.input.expires_at > self.created_at
                && self.input.expires_at <= self.created_at + Duration::seconds(90),
            corrupt,
        )?;
        let code = self.error_code.as_deref();
        match self.status {
            Status::Running => ensure(
                self.output.is_none() && code.is_none() && self.created_at == self.updated_at,
                corrupt,
            ),
            Status::Succeeded => {
                let output = self.output.as_ref().ok_or_else(|| crate::err(corrupt))?;
                ensure(
                    code.is_none()
                        && self.updated_at < self.input.expires_at
                        && output.expires_at
                            == self.updated_at
                                + Duration::seconds(i64::from(self.input.retain_seconds))
                        && hash(&output.content_digest),
                    corrupt,
                )?;
                match &output.text {
                    Some(value) => ensure(
                        text(value)
                            && output.cleared_at.is_none()
                            && saved_at < output.expires_at
                            && content_digest(value.as_bytes()) == output.content_digest,
                        corrupt,
                    ),
                    None => ensure(
                        output
                            .cleared_at
                            .is_some_and(|time| time >= self.updated_at && time <= saved_at),
                        corrupt,
                    ),
                }
            }
            Status::Unknown => ensure(
                self.output.is_none()
                    && matches!(
                        code,
                        Some(
                            "vision_provider_unknown"
                                | "vision_deadline_exceeded"
                                | "vision_interrupted"
                        )
                    ),
                corrupt,
            ),
            Status::Discarded => ensure(
                self.output.is_none() && code == Some("vision_output_discarded"),
                corrupt,
            ),
            Status::Failed => ensure(
                self.output.is_none()
                    && matches!(
                        code,
                        Some(
                            "vision_provider_rejected"
                                | "invalid_vision_output"
                                | "vision_output_too_large"
                                | "vision_origin_not_local"
                                | "vision_provider_unavailable"
                        )
                    ),
                corrupt,
            ),
        }
    }
}
