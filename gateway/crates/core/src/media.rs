//! 本地有限音频对象与播放授权。仅保存平台ID，不接收任意外部URL。
use crate::{digest, ensure, err, identifier, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

pub const MAX_OBJECT_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_TOTAL_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_OBJECTS: usize = 256;
pub const MAX_OPERATIONS: usize = 1024;
pub const MAX_GRANTS: usize = 512;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AudioFormat {
    pub sample_rate: u32,
    pub channels: u16,
    pub bits_per_sample: u16,
    pub frames: u32,
}
/// 首期接受完整有限PCM WAV，不运行任意解码器或转码程序。
pub fn wav(bytes: &[u8]) -> Result<AudioFormat> {
    let invalid = || err("invalid_media_audio");
    ensure(
        bytes.len() >= 46 && bytes.len() <= MAX_OBJECT_BYTES,
        "invalid_media_audio",
    )?;
    let u32_at = |offset: usize| {
        u32::from_le_bytes(bytes[offset..offset + 4].try_into().expect("bounded WAV"))
    };
    let u16_at = |offset: usize| {
        u16::from_le_bytes(bytes[offset..offset + 2].try_into().expect("bounded WAV"))
    };
    ensure(
        &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WAVE" && u32_at(4) as usize == bytes.len() - 8,
        "invalid_media_audio",
    )?;
    let mut position = 12;
    let mut format = None;
    let mut data = None;
    while position < bytes.len() {
        ensure(bytes.len() - position >= 8, "invalid_media_audio")?;
        let length = u32_at(position + 4) as usize;
        let end = position
            .checked_add(8)
            .and_then(|p| p.checked_add(length))
            .ok_or_else(invalid)?;
        ensure(end <= bytes.len(), "invalid_media_audio")?;
        match &bytes[position..position + 4] {
            b"fmt " => {
                ensure(
                    format.is_none() && data.is_none() && length == 16,
                    "invalid_media_audio",
                )?;
                let start = position + 8;
                let channels = u16_at(start + 2);
                let rate = u32_at(start + 4);
                let bits = u16_at(start + 14);
                ensure(
                    u16_at(start) == 1
                        && (1..=2).contains(&channels)
                        && (8000..=48000).contains(&rate)
                        && bits == 16
                        && u16_at(start + 12) == channels * 2
                        && u32_at(start + 8) == rate * u32::from(channels) * 2,
                    "invalid_media_audio",
                )?;
                format = Some(AudioFormat {
                    sample_rate: rate,
                    channels,
                    bits_per_sample: bits,
                    frames: 0,
                });
            }
            b"data" => {
                ensure(
                    format.is_some() && data.is_none() && length > 0,
                    "invalid_media_audio",
                )?;
                data = Some(length);
            }
            _ => return Err(invalid()),
        }
        position = end.checked_add(length % 2).ok_or_else(invalid)?;
        ensure(position <= bytes.len(), "invalid_media_audio")?;
    }
    let mut format = format.ok_or_else(invalid)?;
    let length = data.ok_or_else(invalid)?;
    let alignment = usize::from(format.channels) * 2;
    ensure(
        length % alignment == 0 && length / alignment <= format.sample_rate as usize * 60,
        "invalid_media_audio",
    )?;
    format.frames = (length / alignment) as u32;
    Ok(format)
}
pub fn content_digest(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Change {
    #[serde(rename = "media.upload")]
    Upload {
        content_base64: String,
        retain_seconds: u32,
    },
    #[serde(rename = "media.delete")]
    Delete { media_id: String },
    #[serde(rename = "media.grant")]
    Grant {
        media_id: String,
        device_id: String,
        expected_binding_revision: String,
        valid_for_seconds: u16,
    },
    #[serde(rename = "media.revoke")]
    Revoke { grant_id: String },
}
impl Change {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Upload { .. } => "media.upload",
            Self::Delete { .. } => "media.delete",
            Self::Grant { .. } => "media.grant",
            Self::Revoke { .. } => "media.revoke",
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub space_id: String,
    pub idempotency_key: String,
    pub change: Change,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Metadata {
    pub media_id: String,
    pub space_id: String,
    pub content_type: String,
    pub purpose: String,
    pub actor: String,
    pub byte_length: usize,
    pub content_digest: String,
    pub audio: AudioFormat,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Object {
    pub metadata: Metadata,
    pub content_base64: Option<String>,
    pub deleted_at: Option<DateTime<Utc>>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Grant {
    pub grant_id: String,
    pub media_id: String,
    pub device_id: String,
    pub binding_revision: String,
    pub source_ip: std::net::Ipv4Addr,
    pub epoch: String,
    pub token: String,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GrantRecord {
    pub grant: Grant,
    pub revoked_at: Option<DateTime<Utc>>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Receipt {
    Uploaded { media: Metadata },
    Deleted { media_id: String },
    Granted { grant: Grant },
    Revoked { grant_id: String },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Operation {
    pub operation_id: String,
    pub idempotency_key: String,
    pub request_digest: String,
    pub kind: String,
    pub created_at: DateTime<Utc>,
    pub result: Receipt,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct State {
    pub schema_version: u8,
    pub space_id: String,
    pub saved_at: DateTime<Utc>,
    pub objects: BTreeMap<String, Object>,
    pub grants: BTreeMap<String, GrantRecord>,
    pub operations: BTreeMap<String, Operation>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub speech: BTreeMap<String, crate::speech::Task>,
}
pub struct GrantTarget {
    pub device_id: String,
    pub binding_revision: String,
    pub source_ip: std::net::Ipv4Addr,
}
impl State {
    pub fn new(space_id: String, now: DateTime<Utc>) -> Self {
        Self {
            schema_version: 1,
            space_id,
            saved_at: now,
            objects: BTreeMap::new(),
            grants: BTreeMap::new(),
            operations: BTreeMap::new(),
            speech: BTreeMap::new(),
        }
    }
    pub fn active_object(&self, id: &str, now: DateTime<Utc>) -> Result<&Object> {
        let object = self.objects.get(id).ok_or_else(|| err("media_not_found"))?;
        ensure(
            object.deleted_at.is_none()
                && object.metadata.created_at <= now
                && now < object.metadata.expires_at
                && object.content_base64.is_some(),
            "media_not_found",
        )?;
        Ok(object)
    }
    pub fn grant(&self, id: &str, epoch: &str, now: DateTime<Utc>) -> Result<&Grant> {
        let record = self.grants.get(id).ok_or_else(|| err("media_not_found"))?;
        let grant = &record.grant;
        ensure(
            record.revoked_at.is_none()
                && grant.epoch == epoch
                && grant.created_at <= now
                && now < grant.expires_at,
            "media_not_found",
        )?;
        self.active_object(&grant.media_id, now)?;
        Ok(grant)
    }
    pub fn prune(&mut self, now: DateTime<Utc>) -> bool {
        let mut changed = false;
        for object in self.objects.values_mut() {
            if object.metadata.expires_at <= now && object.content_base64.take().is_some() {
                changed = true;
            }
        }
        changed
    }
    pub fn apply(
        &mut self,
        request: Request,
        target: Option<GrantTarget>,
        epoch: &str,
        now: DateTime<Utc>,
    ) -> Result<Operation> {
        ensure(request.space_id == self.space_id, "forbidden")?;
        ensure(
            identifier(&request.idempotency_key),
            "invalid_idempotency_key",
        )?;
        let request_digest = digest(&request)?;
        if let Some(original) = self.operations.get(&request.idempotency_key) {
            ensure(
                original.request_digest == request_digest,
                "idempotency_conflict",
            )?;
            return Ok(original.clone());
        }
        ensure(
            self.operations.len() < MAX_OPERATIONS,
            "media_operation_capacity",
        )?;
        ensure(now >= self.saved_at, "media_clock_invalid")?;
        self.prune(now);
        let result = match &request.change {
            Change::Upload {
                content_base64,
                retain_seconds,
            } => {
                ensure(
                    (60..=86400).contains(retain_seconds)
                        && content_base64.len() <= MAX_OBJECT_BYTES.div_ceil(3) * 4,
                    "invalid_media_upload",
                )?;
                let bytes = STANDARD
                    .decode(content_base64)
                    .map_err(|_| err("invalid_media_upload"))?;
                ensure(
                    STANDARD.encode(&bytes) == *content_base64,
                    "invalid_media_upload",
                )?;
                let audio = wav(&bytes)?;
                let total: usize = self
                    .objects
                    .values()
                    .filter(|o| o.content_base64.is_some())
                    .map(|o| o.metadata.byte_length)
                    .sum();
                ensure(
                    self.objects.len() < MAX_OBJECTS && total + bytes.len() <= MAX_TOTAL_BYTES,
                    "media_capacity",
                )?;
                let metadata = Metadata {
                    media_id: format!("media-{}", crate::id()),
                    space_id: self.space_id.clone(),
                    content_type: "audio/wav".into(),
                    purpose: "device_playback".into(),
                    actor: "local_owner".into(),
                    byte_length: bytes.len(),
                    content_digest: content_digest(&bytes),
                    audio,
                    created_at: now,
                    expires_at: now + Duration::seconds(i64::from(*retain_seconds)),
                };
                self.objects.insert(
                    metadata.media_id.clone(),
                    Object {
                        metadata: metadata.clone(),
                        content_base64: Some(content_base64.clone()),
                        deleted_at: None,
                    },
                );
                Receipt::Uploaded { media: metadata }
            }
            Change::Delete { media_id } => {
                ensure(identifier(media_id), "invalid_media_change")?;
                let object = self
                    .objects
                    .get_mut(media_id)
                    .ok_or_else(|| err("media_not_found"))?;
                object.content_base64 = None;
                object.deleted_at.get_or_insert(now);
                for record in self
                    .grants
                    .values_mut()
                    .filter(|g| g.grant.media_id == *media_id)
                {
                    record.revoked_at.get_or_insert(now);
                }
                Receipt::Deleted {
                    media_id: media_id.clone(),
                }
            }
            Change::Grant {
                media_id,
                device_id,
                expected_binding_revision,
                valid_for_seconds,
            } => {
                ensure(
                    (5..=600).contains(valid_for_seconds),
                    "invalid_media_change",
                )?;
                ensure(
                    identifier(device_id) && identifier(epoch),
                    "invalid_media_change",
                )?;
                crate::execution::Route {
                    adapter_id: "media".into(),
                    revision: expected_binding_revision.clone(),
                }
                .validate()?;
                ensure(self.grants.len() < MAX_GRANTS, "media_capacity")?;
                let object = self.active_object(media_id, now)?;
                let target = target.ok_or_else(|| err("media_target_unavailable"))?;
                ensure(
                    target.source_ip.is_private() || target.source_ip.is_loopback(),
                    "media_target_unavailable",
                )?;
                ensure(
                    target.device_id == *device_id
                        && target.binding_revision == *expected_binding_revision,
                    "revision_conflict",
                )?;
                let grant = Grant {
                    grant_id: format!("grant-{}", crate::id()),
                    media_id: media_id.clone(),
                    device_id: device_id.clone(),
                    binding_revision: expected_binding_revision.clone(),
                    source_ip: target.source_ip,
                    epoch: epoch.into(),
                    token: format!(
                        "{}{}",
                        uuid::Uuid::new_v4().simple(),
                        uuid::Uuid::new_v4().simple()
                    ),
                    created_at: now,
                    expires_at: (now + Duration::seconds(i64::from(*valid_for_seconds)))
                        .min(object.metadata.expires_at),
                };
                self.grants.insert(
                    grant.grant_id.clone(),
                    GrantRecord {
                        grant: grant.clone(),
                        revoked_at: None,
                    },
                );
                Receipt::Granted { grant }
            }
            Change::Revoke { grant_id } => {
                ensure(identifier(grant_id), "invalid_media_change")?;
                self.grants
                    .get_mut(grant_id)
                    .ok_or_else(|| err("media_not_found"))?
                    .revoked_at
                    .get_or_insert(now);
                Receipt::Revoked {
                    grant_id: grant_id.clone(),
                }
            }
        };
        let operation = Operation {
            operation_id: format!("mediaop-{}", crate::id()),
            idempotency_key: request.idempotency_key.clone(),
            request_digest,
            kind: request.change.kind().into(),
            created_at: now,
            result,
        };
        self.operations
            .insert(request.idempotency_key, operation.clone());
        self.saved_at = now;
        Ok(operation)
    }
    pub fn validate(&self) -> Result<()> {
        let valid = || err("media_storage_corrupt");
        ensure(
            ((self.schema_version == 1 && self.speech.is_empty())
                || (self.schema_version == 2 && !self.speech.is_empty()))
                && identifier(&self.space_id)
                && self.objects.len() <= MAX_OBJECTS
                && self.grants.len() <= MAX_GRANTS
                && self.operations.len() <= MAX_OPERATIONS,
            "media_storage_corrupt",
        )?;
        ensure(
            self.speech.len() <= crate::speech::MAX_TASKS,
            "media_storage_corrupt",
        )?;
        for (key, task) in &self.speech {
            ensure(key == &task.idempotency_key, "media_storage_corrupt")?;
            task.validate(&self.space_id, self.saved_at)?;
            if let Some(id) = &task.media_id {
                let object = self.objects.get(id).ok_or_else(valid)?;
                ensure(
                    object.metadata.created_at >= task.created_at
                        && object.metadata.created_at == task.updated_at
                        && object.metadata.expires_at
                            == task.updated_at + Duration::seconds(i64::from(task.retain_seconds)),
                    "media_storage_corrupt",
                )?;
            }
        }
        let mut total = 0;
        for (id, object) in &self.objects {
            let meta = &object.metadata;
            ensure(
                id == &meta.media_id
                    && id.starts_with("media-")
                    && identifier(id)
                    && meta.space_id == self.space_id
                    && meta.content_type == "audio/wav"
                    && meta.actor == "local_owner"
                    && meta.purpose == "device_playback"
                    && meta.created_at <= self.saved_at
                    && meta.expires_at > meta.created_at
                    && meta.expires_at <= meta.created_at + Duration::days(1)
                    && (46..=MAX_OBJECT_BYTES).contains(&meta.byte_length)
                    && object
                        .deleted_at
                        .is_none_or(|t| t >= meta.created_at && t <= self.saved_at),
                "media_storage_corrupt",
            )?;
            if let Some(content) = &object.content_base64 {
                let bytes = STANDARD.decode(content).map_err(|_| valid())?;
                ensure(
                    object.deleted_at.is_none()
                        && STANDARD.encode(&bytes) == *content
                        && bytes.len() == meta.byte_length
                        && content_digest(&bytes) == meta.content_digest
                        && wav(&bytes).is_ok_and(|f| f == meta.audio),
                    "media_storage_corrupt",
                )?;
                total += bytes.len();
            } else {
                ensure(
                    object.deleted_at.is_some() || meta.expires_at <= self.saved_at,
                    "media_storage_corrupt",
                )?;
            }
        }
        ensure(total <= MAX_TOTAL_BYTES, "media_storage_corrupt")?;
        for (id, record) in &self.grants {
            let grant = &record.grant;
            let object = self.objects.get(&grant.media_id).ok_or_else(valid)?;
            ensure(
                id == &grant.grant_id
                    && id.starts_with("grant-")
                    && identifier(id)
                    && identifier(&grant.device_id)
                    && identifier(&grant.epoch)
                    && grant.token.len() == 64
                    && grant
                        .token
                        .bytes()
                        .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
                    && grant.binding_revision.len() == 71
                    && grant.binding_revision.starts_with("sha256:")
                    && grant.binding_revision[7..]
                        .bytes()
                        .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
                    && (grant.source_ip.is_private() || grant.source_ip.is_loopback())
                    && grant.created_at >= object.metadata.created_at
                    && grant.created_at <= self.saved_at
                    && grant.expires_at > grant.created_at
                    && grant.expires_at <= grant.created_at + Duration::seconds(600)
                    && grant.expires_at <= object.metadata.expires_at
                    && record
                        .revoked_at
                        .is_none_or(|t| t >= grant.created_at && t <= self.saved_at),
                "media_storage_corrupt",
            )?;
        }
        for (key, operation) in &self.operations {
            ensure(
                key == &operation.idempotency_key
                    && identifier(key)
                    && operation.operation_id.starts_with("mediaop-")
                    && identifier(&operation.operation_id)
                    && operation.request_digest.len() == 71
                    && operation.request_digest.starts_with("sha256:")
                    && operation.request_digest[7..]
                        .bytes()
                        .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
                    && operation.created_at <= self.saved_at,
                "media_storage_corrupt",
            )?;
            let consistent = match &operation.result {
                Receipt::Uploaded { media } => {
                    operation.kind == "media.upload"
                        && self
                            .objects
                            .get(&media.media_id)
                            .is_some_and(|o| o.metadata == *media)
                        && media.created_at == operation.created_at
                }
                Receipt::Granted { grant } => {
                    operation.kind == "media.grant"
                        && self
                            .grants
                            .get(&grant.grant_id)
                            .is_some_and(|g| g.grant == *grant)
                        && grant.created_at == operation.created_at
                }
                Receipt::Deleted { media_id } => {
                    operation.kind == "media.delete"
                        && self.objects.get(media_id).is_some_and(|o| {
                            o.deleted_at.is_some_and(|t| t <= operation.created_at)
                        })
                }
                Receipt::Revoked { grant_id } => {
                    operation.kind == "media.revoke"
                        && self.grants.get(grant_id).is_some_and(|g| {
                            g.revoked_at.is_some_and(|t| t <= operation.created_at)
                        })
                }
            };
            ensure(consistent, "media_storage_corrupt")?;
        }
        Ok(())
    }
}
