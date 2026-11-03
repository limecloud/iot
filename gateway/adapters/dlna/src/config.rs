use chrono::{DateTime, Utc};
use limeiot_core::{ensure, identifier, Result};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, net::SocketAddrV4};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct MediaGrant {
    pub media_id: String,
    pub url: String,
    pub expires_at: DateTime<Utc>,
}

/// 所有者固定目标和媒体；命令只传媒体ID，不能覆盖网络地址。
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub schema_version: u8,
    pub target: SocketAddrV4,
    pub description_path: String,
    pub av_transport_path: String,
    pub rendering_control_path: String,
    pub udn: String,
    pub playback_volume: u8,
    pub volume_limit: u8,
    pub media: Vec<MediaGrant>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub managed_media: bool,
    pub timeout_ms: u64,
}

pub(crate) fn local_target(target: SocketAddrV4) -> bool {
    (target.ip().is_private() || target.ip().is_loopback()) && target.port() != 0
}
pub(crate) fn local_path(path: &str) -> bool {
    path.starts_with('/')
        && !path.starts_with("//")
        && path.len() <= 512
        && path
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"/._-".contains(&b))
        && !path.split('/').any(|part| matches!(part, "." | ".."))
}
impl Config {
    pub fn validate(&self) -> Result<()> {
        ensure(
            self.schema_version == 1
                && local_target(self.target)
                && local_path(&self.description_path)
                && local_path(&self.av_transport_path)
                && local_path(&self.rendering_control_path)
                && self.udn.starts_with("uuid:")
                && (6..=128).contains(&self.udn.len())
                && self
                    .udn
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b":_-".contains(&b))
                && self.playback_volume <= self.volume_limit
                && (1..=30).contains(&self.volume_limit)
                && (50..=5000).contains(&self.timeout_ms)
                && self.media.len() <= 32,
            "invalid_audio_adapter_config",
        )?;
        ensure(
            !self.managed_media || self.media.is_empty(),
            "invalid_audio_adapter_config",
        )?;
        let mut ids = BTreeSet::new();
        for media in &self.media {
            let parsed = url::Url::parse(&media.url).ok();
            ensure(
                identifier(&media.media_id)
                    && ids.insert(&media.media_id)
                    && media.url.len() <= 1024
                    && parsed.is_some_and(|url| {
                        url.scheme() == "http"
                            && url.username().is_empty()
                            && url.password().is_none()
                            && url.query().is_none()
                            && url.fragment().is_none()
                            && local_path(url.path())
                            && matches!(url.host(), Some(url::Host::Ipv4(ip)) if local_target(SocketAddrV4::new(ip, url.port_or_known_default().unwrap_or(0))))
                            && url.as_str() == media.url
                    }),
                "invalid_audio_adapter_config",
            )?;
        }
        Ok(())
    }
    pub(crate) fn endpoint(&self, path: &str) -> String {
        format!("http://{}{path}", self.target)
    }
}
