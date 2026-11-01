//! 规则草案只保存推理结果，不拥有部署或设备执行权。
use crate::{digest, engine::Data, ensure, err, id, identifier, protocol::Rule, Result};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DraftRequest {
    pub space_id: String,
    pub idempotency_key: String,
    pub prompt: String,
    pub expires_at: DateTime<Utc>,
}
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DraftStatus {
    Running,
    Completed,
    Rejected,
    Unknown,
    Expired,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct InferenceUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RuleDraft {
    pub draft_id: String,
    pub request: DraftRequest,
    pub request_digest: String,
    pub context_revision: String,
    pub provider: String,
    pub model: String,
    pub status: DraftStatus,
    pub created_at: DateTime<Utc>,
    pub rule: Option<Rule>,
    pub rule_revision: Option<String>,
    pub usage: Option<InferenceUsage>,
    pub error: Option<String>,
}
impl Data {
    pub fn draft_context(&self) -> Value {
        json!({"devices":self.devices.values().map(|d|json!({"device_id":d.device_id,"model_revision":d.model_revision})).collect::<Vec<_>>(),"models":self.models})
    }
    pub fn resolve_draft(&self, key: &str) -> Result<&RuleDraft> {
        self.rule_drafts
            .values()
            .find(|draft| draft.request.idempotency_key == key)
            .ok_or_else(|| err("draft_not_found"))
    }
    pub fn existing_draft(&self, request: &DraftRequest) -> Result<Option<RuleDraft>> {
        ensure(request.space_id == self.space_id, "forbidden")?;
        if let Ok(existing) = self.resolve_draft(&request.idempotency_key) {
            ensure(
                existing.request_digest == digest(request)?,
                "idempotency_conflict",
            )?;
            return Ok(Some(existing.clone()));
        }
        Ok(None)
    }
    pub fn create_draft(
        &mut self,
        request: DraftRequest,
        model: &str,
        now: DateTime<Utc>,
    ) -> Result<RuleDraft> {
        if let Some(existing) = self.existing_draft(&request)? {
            return Ok(existing);
        }
        ensure(
            identifier(&request.idempotency_key),
            "invalid_idempotency_key",
        )?;
        ensure(
            !request.prompt.trim().is_empty()
                && request.prompt.chars().count() <= 512
                && request.prompt.len() <= 2048
                && !request.prompt.contains('\0'),
            "invalid_prompt",
        )?;
        ensure(
            request.expires_at > now && request.expires_at <= now + Duration::seconds(120),
            "draft_expired",
        )?;
        ensure(self.rule_drafts.len() < 128, "capacity_exceeded")?;
        let context = self.draft_context();
        ensure(
            serde_json::to_vec(&context)
                .map_err(|_| err("invalid_json"))?
                .len()
                <= 16384,
            "inference_context_too_large",
        )?;
        let draft = RuleDraft {
            draft_id: id(),
            request_digest: digest(&request)?,
            request,
            context_revision: digest(&context)?,
            provider: "ollama".into(),
            model: model.into(),
            status: DraftStatus::Running,
            created_at: now,
            rule: None,
            rule_revision: None,
            usage: None,
            error: None,
        };
        self.rule_drafts
            .insert(draft.draft_id.clone(), draft.clone());
        Ok(draft)
    }
    pub fn finish_draft(
        &mut self,
        draft_id: &str,
        result: Result<Rule>,
        usage: Option<InferenceUsage>,
        now: DateTime<Utc>,
    ) -> Result<RuleDraft> {
        let mut draft = self
            .rule_drafts
            .get(draft_id)
            .cloned()
            .ok_or_else(|| err("draft_not_found"))?;
        ensure(draft.status == DraftStatus::Running, "invalid_transition")?;
        draft.usage = usage;
        let uncertain_error = result.as_ref().err().filter(|error| {
            matches!(
                error.code.as_str(),
                "inference_unknown" | "inference_timeout"
            )
        });
        if let Some(error) = uncertain_error {
            draft.status = DraftStatus::Unknown;
            draft.error = Some(error.code.clone());
        } else if now >= draft.request.expires_at {
            draft.status = DraftStatus::Expired;
            draft.error = Some("draft_expired".into());
        } else if draft.context_revision != digest(&self.draft_context())? {
            draft.status = DraftStatus::Rejected;
            draft.error = Some("inference_context_changed".into());
        } else {
            match result.and_then(|rule| {
                ensure(
                    rule.id == format!("ai-{}", draft.draft_id),
                    "invalid_model_output",
                )?;
                let revision = self.validate_rule(&rule)?;
                Ok((rule, revision))
            }) {
                Ok((rule, revision)) => {
                    draft.status = DraftStatus::Completed;
                    draft.rule = Some(rule);
                    draft.rule_revision = Some(revision);
                }
                Err(error) => {
                    draft.status = DraftStatus::Rejected;
                    draft.error = Some(error.code);
                }
            }
        }
        self.rule_drafts.insert(draft_id.into(), draft.clone());
        Ok(draft)
    }
}
