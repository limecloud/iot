//! 已上传有限录音的转写任务。结果随源音频清除，不产生设备指令。
use crate::{
    digest, ensure, identifier, media,
    model_job::{Deployment, Status},
    Result,
};
use chrono::{DateTime, Duration, SubsecRound, Utc};
use serde::{Deserialize, Serialize};

pub const MAX_TASKS: usize = 256;
pub const MAX_TEXT_BYTES: usize = 8192;
pub const MAX_CHARACTERS: usize = 2048;
pub fn hash(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..]
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub fn language(value: &str) -> bool {
    matches!(value, "auto" | "zh" | "en")
}
pub fn text(value: &str) -> bool {
    value.len() <= MAX_TEXT_BYTES
        && value.chars().count() <= MAX_CHARACTERS
        && !value
            .chars()
            .any(|c| c.is_control() && c != '\n' && c != '\t')
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Input {
    pub media_id: String,
    pub media_digest: String,
    pub language: String,
    pub expires_at: DateTime<Utc>,
}
impl Input {
    pub fn validate(&self) -> Result<()> {
        ensure(
            identifier(&self.media_id)
                && self.media_id.starts_with("media-")
                && hash(&self.media_digest)
                && language(&self.language)
                && self.expires_at == self.expires_at.trunc_subsecs(3),
            "invalid_transcription_request",
        )
    }
    pub fn request_digest(&self, space: &str, key: &str) -> Result<String> {
        digest(
            &serde_json::json!({"space_id":space,"idempotency_key":key,"input":{"media_id":self.media_id,"media_digest":self.media_digest,"language":self.language,"expires_at":self.expires_at.to_rfc3339_opts(chrono::SecondsFormat::Millis,true)}}),
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
    pub transcription_id: String,
    pub space_id: String,
    pub idempotency_key: String,
    pub request_digest: String,
    pub input: Input,
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
        input: &Input,
        deployment: Deployment,
        now: DateTime<Utc>,
    ) -> Result<Self> {
        input.validate()?;
        ensure(
            identifier(space) && identifier(key),
            "invalid_idempotency_key",
        )?;
        ensure(
            input.expires_at > now && input.expires_at <= now + Duration::seconds(90),
            "invalid_transcription_deadline",
        )?;
        Ok(Self {
            transcription_id: format!("transcription-{}", crate::id()),
            space_id: space.into(),
            idempotency_key: key.into(),
            request_digest: input.request_digest(space, key)?,
            input: input.clone(),
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
                && self.space_id == space
                && identifier(&self.transcription_id)
                && self.transcription_id.starts_with("transcription-")
                && identifier(&self.idempotency_key)
                && hash(&self.request_digest)
                && self.request_digest
                    == self.input.request_digest(space, &self.idempotency_key)?
                && self.deployment.adapter == "local-http-transcription-v1"
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
                        && output.expires_at > self.updated_at
                        && hash(&output.content_digest),
                    corrupt,
                )?;
                match &output.text {
                    Some(value) => ensure(
                        text(value)
                            && output.cleared_at.is_none()
                            && media::content_digest(value.as_bytes()) == output.content_digest,
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
            Status::Discarded => ensure(
                self.output.is_none() && code == Some("transcription_output_discarded"),
                corrupt,
            ),
            Status::Unknown => ensure(
                self.output.is_none()
                    && matches!(
                        code,
                        Some(
                            "transcription_provider_unknown"
                                | "transcription_deadline_exceeded"
                                | "transcription_interrupted"
                        )
                    ),
                corrupt,
            ),
            Status::Failed => ensure(
                self.output.is_none()
                    && matches!(
                        code,
                        Some(
                            "transcription_provider_rejected"
                                | "invalid_transcription_output"
                                | "transcription_output_too_large"
                                | "transcription_source_unavailable"
                                | "transcription_origin_not_local"
                                | "transcription_provider_unavailable"
                        )
                    ),
                corrupt,
            ),
        }
    }
}
