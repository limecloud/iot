//! 有界文字生成；调用方明确提供本轮上下文，模型没有设备或工具权限。
use crate::{
    digest, ensure, identifier,
    media::content_digest,
    model_job::{Deployment, Status},
    Result,
};
use chrono::{DateTime, Duration, SubsecRound, Utc};
use serde::{Deserialize, Serialize};

pub const MAX_TASKS: usize = 128;
pub const MAX_MESSAGES: usize = 15;
pub const MAX_CONTEXT_BYTES: usize = 8192;
pub const MAX_REQUEST_BYTES: usize = 65536;
pub fn text(value: &str) -> bool {
    !value.trim().is_empty() && crate::transcription::text(value)
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    User,
    Assistant,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Message {
    pub role: Role,
    pub content: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub instructions: String,
    pub messages: Vec<Message>,
    pub retain_seconds: u32,
    pub expires_at: DateTime<Utc>,
}
impl Request {
    pub fn input(&self) -> Result<Input> {
        ensure(
            self.instructions.chars().count() <= 1024
                && crate::transcription::text(&self.instructions)
                && !self.messages.is_empty()
                && self.messages.len() <= MAX_MESSAGES
                && self.messages.len() % 2 == 1
                && self.messages.iter().enumerate().all(|(i, m)| {
                    m.role
                        == if i % 2 == 0 {
                            Role::User
                        } else {
                            Role::Assistant
                        }
                        && text(&m.content)
                }),
            "invalid_text_request",
        )?;
        let bytes =
            self.instructions.len() + self.messages.iter().map(|m| m.content.len()).sum::<usize>();
        ensure(bytes <= MAX_CONTEXT_BYTES, "invalid_text_request")?;
        let input = Input {
            context_digest: digest(
                &serde_json::json!({"instructions":self.instructions,"messages":self.messages}),
            )?,
            context_bytes: bytes,
            message_count: self.messages.len(),
            retain_seconds: self.retain_seconds,
            expires_at: self.expires_at,
        };
        input.validate()?;
        Ok(input)
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Input {
    pub context_digest: String,
    pub context_bytes: usize,
    pub message_count: usize,
    pub retain_seconds: u32,
    pub expires_at: DateTime<Utc>,
}
impl Input {
    pub fn validate(&self) -> Result<()> {
        ensure(
            crate::transcription::hash(&self.context_digest)
                && (1..=MAX_CONTEXT_BYTES).contains(&self.context_bytes)
                && (1..=MAX_MESSAGES).contains(&self.message_count)
                && self.message_count % 2 == 1
                && (60..=3600).contains(&self.retain_seconds)
                && self.expires_at == self.expires_at.trunc_subsecs(3),
            "invalid_text_request",
        )
    }
    pub fn request_digest(&self, space: &str, key: &str) -> Result<String> {
        digest(
            &serde_json::json!({"space_id":space,"idempotency_key":key,"input":{
            "context_digest":self.context_digest,"context_bytes":self.context_bytes,"message_count":self.message_count,
            "retain_seconds":self.retain_seconds,"expires_at":self.expires_at.to_rfc3339_opts(chrono::SecondsFormat::Millis,true)}}),
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
pub struct Usage {
    pub input_tokens: u32,
    pub output_tokens: u32,
}
impl Usage {
    pub fn valid(&self) -> bool {
        self.input_tokens <= 65536 && (1..=1024).contains(&self.output_tokens)
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Task {
    pub text_id: String,
    pub space_id: String,
    pub idempotency_key: String,
    pub request_digest: String,
    pub input: Input,
    pub deployment: Deployment,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub status: Status,
    pub output: Option<Output>,
    pub usage: Option<Usage>,
    pub error_code: Option<String>,
}
impl Task {
    pub fn new(
        space: &str,
        key: &str,
        input: Input,
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
            "invalid_text_deadline",
        )?;
        ensure(
            deployment.adapter == "ollama-text-v1"
                && crate::transcription::hash(&deployment.revision)
                && crate::speech::model_id(&deployment.model)
                && deployment.data_location == "local",
            "invalid_text_deployment",
        )?;
        Ok(Self {
            text_id: format!("text-{}", crate::id()),
            space_id: space.into(),
            idempotency_key: key.into(),
            request_digest: input.request_digest(space, key)?,
            input,
            deployment,
            created_at: now,
            updated_at: now,
            status: Status::Running,
            output: None,
            usage: None,
            error_code: None,
        })
    }
    pub fn validate(&self, space: &str, saved_at: DateTime<Utc>) -> Result<()> {
        let bad = "media_storage_corrupt";
        ensure(
            self.input.validate().is_ok()
                && self.space_id == space
                && identifier(&self.text_id)
                && self.text_id.starts_with("text-")
                && identifier(&self.idempotency_key)
                && self.request_digest
                    == self.input.request_digest(space, &self.idempotency_key)?
                && self.deployment.adapter == "ollama-text-v1"
                && crate::transcription::hash(&self.deployment.revision)
                && crate::speech::model_id(&self.deployment.model)
                && self.deployment.data_location == "local"
                && self.created_at <= self.updated_at
                && self.updated_at <= saved_at
                && self.input.expires_at > self.created_at
                && self.input.expires_at <= self.created_at + Duration::seconds(90),
            bad,
        )?;
        match self.status {
            Status::Running => ensure(
                self.output.is_none()
                    && self.usage.is_none()
                    && self.error_code.is_none()
                    && self.created_at == self.updated_at,
                bad,
            ),
            Status::Succeeded => {
                let output = self.output.as_ref().ok_or_else(|| crate::err(bad))?;
                ensure(
                    self.error_code.is_none()
                        && self.updated_at < self.input.expires_at
                        && self.usage.as_ref().is_none_or(Usage::valid)
                        && output.expires_at
                            == self.updated_at
                                + Duration::seconds(i64::from(self.input.retain_seconds))
                        && crate::transcription::hash(&output.content_digest),
                    bad,
                )?;
                match &output.text {
                    Some(value) => ensure(
                        text(value)
                            && output.cleared_at.is_none()
                            && saved_at < output.expires_at
                            && content_digest(value.as_bytes()) == output.content_digest,
                        bad,
                    ),
                    None => ensure(
                        output
                            .cleared_at
                            .is_some_and(|t| t >= self.updated_at && t <= saved_at),
                        bad,
                    ),
                }
            }
            Status::Unknown => ensure(
                self.output.is_none()
                    && self.usage.is_none()
                    && matches!(
                        self.error_code.as_deref(),
                        Some(
                            "text_provider_unknown" | "text_deadline_exceeded" | "text_interrupted"
                        )
                    ),
                bad,
            ),
            Status::Failed => ensure(
                self.output.is_none()
                    && self.usage.is_none()
                    && matches!(
                        self.error_code.as_deref(),
                        Some(
                            "text_provider_rejected"
                                | "invalid_text_output"
                                | "text_output_too_large"
                                | "text_origin_not_local"
                                | "text_provider_unavailable"
                        )
                    ),
                bad,
            ),
            Status::Discarded => ensure(
                self.output.is_none()
                    && self.usage.is_none()
                    && self.error_code.as_deref() == Some("text_output_discarded"),
                bad,
            ),
        }
    }
}
