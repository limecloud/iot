//! 有界文字转语音任务。正文只用于当次调用，日志保存摘要；完成不代表播放授权。
use crate::{digest, ensure, identifier, media, Result};
use chrono::{DateTime, Duration, SubsecRound, Utc};
use serde::{Deserialize, Serialize};

pub const MAX_TASKS: usize = 256;
pub const MAX_TEXT_BYTES: usize = 4096;
pub const MAX_CHARACTERS: usize = 1000;
pub fn model_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_:./".contains(&b))
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Input {
    pub text: String,
    pub voice: String,
    pub retain_seconds: u32,
    pub expires_at: DateTime<Utc>,
}
impl Input {
    pub fn validate(&self) -> Result<()> {
        ensure(
            !self.text.trim().is_empty()
                && self.text.len() <= MAX_TEXT_BYTES
                && self.text.chars().count() <= MAX_CHARACTERS
                && !self
                    .text
                    .chars()
                    .any(|c| c.is_control() && c != '\n' && c != '\t')
                && identifier(&self.voice)
                && self.voice.len() <= 64
                && self.expires_at == self.expires_at.trunc_subsecs(3)
                && (60..=86400).contains(&self.retain_seconds),
            "invalid_speech_request",
        )
    }
    pub fn request_digest(&self, space: &str, key: &str) -> Result<String> {
        digest(
            &serde_json::json!({"space_id":space,"idempotency_key":key,"input":{"text":self.text,"voice":self.voice,"retain_seconds":self.retain_seconds,"expires_at":self.expires_at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)}}),
        )
    }
}

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
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Task {
    pub synthesis_id: String,
    pub space_id: String,
    pub idempotency_key: String,
    pub request_digest: String,
    pub input_digest: String,
    pub input_characters: usize,
    pub voice: String,
    pub retain_seconds: u32,
    pub expires_at: DateTime<Utc>,
    pub deployment: Deployment,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub status: Status,
    pub media_id: Option<String>,
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
            "invalid_speech_deadline",
        )?;
        Ok(Self {
            synthesis_id: format!("speech-{}", crate::id()),
            space_id: space.into(),
            idempotency_key: key.into(),
            request_digest: input.request_digest(space, key)?,
            input_digest: media::content_digest(input.text.as_bytes()),
            input_characters: input.text.chars().count(),
            voice: input.voice.clone(),
            retain_seconds: input.retain_seconds,
            expires_at: input.expires_at,
            deployment,
            created_at: now,
            updated_at: now,
            status: Status::Running,
            media_id: None,
            error_code: None,
        })
    }
    pub fn validate(&self, space: &str, saved_at: DateTime<Utc>) -> Result<()> {
        let hash = |s: &str| {
            s.len() == 71
                && s.starts_with("sha256:")
                && s[7..]
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        };
        let code = self.error_code.as_deref();
        let outcome = match self.status {
            Status::Running => {
                self.media_id.is_none() && code.is_none() && self.updated_at == self.created_at
            }
            Status::Succeeded => {
                self.media_id
                    .as_deref()
                    .is_some_and(|s| identifier(s) && s.starts_with("media-"))
                    && code.is_none()
                    && self.updated_at < self.expires_at
            }
            Status::Discarded => self.media_id.is_none() && code == Some("speech_output_discarded"),
            Status::Unknown => {
                self.media_id.is_none()
                    && matches!(
                        code,
                        Some(
                            "speech_provider_unknown"
                                | "speech_deadline_exceeded"
                                | "speech_interrupted"
                        )
                    )
            }
            Status::Failed => {
                self.media_id.is_none()
                    && matches!(
                        code,
                        Some(
                            "speech_provider_rejected"
                                | "invalid_speech_audio"
                                | "speech_output_too_large"
                                | "speech_output_unavailable"
                                | "speech_origin_not_local"
                                | "speech_provider_unavailable"
                        )
                    )
            }
        };
        ensure(
            self.space_id == space
                && identifier(&self.synthesis_id)
                && self.synthesis_id.starts_with("speech-")
                && identifier(&self.idempotency_key)
                && hash(&self.request_digest)
                && hash(&self.input_digest)
                && (1..=MAX_CHARACTERS).contains(&self.input_characters)
                && identifier(&self.voice)
                && self.voice.len() <= 64
                && (60..=86400).contains(&self.retain_seconds)
                && self.deployment.adapter == "local-http-speech-v1"
                && hash(&self.deployment.revision)
                && model_id(&self.deployment.model)
                && self.deployment.data_location == "local"
                && self.created_at <= self.updated_at
                && self.updated_at <= saved_at
                && self.expires_at > self.created_at
                && self.expires_at <= self.created_at + Duration::seconds(90)
                && outcome,
            "media_storage_corrupt",
        )
    }
}
