//! 可选集成的装配入口；协议实现互不依赖，API共用核心的候选与绑定合同。
#[cfg(feature = "android-tv")]
mod android_tv;
#[cfg(feature = "dlna")]
mod dlna;

use crate::application::App;
#[cfg(any(not(feature = "android-tv"), not(feature = "dlna")))]
use limeiot_core::err;
use limeiot_core::{engine::Data, ensure, execution::Route, execution_binding::Offer, Result};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use tokio::task::JoinHandle;

pub struct Registry {
    #[cfg(feature = "android-tv")]
    tv: android_tv::Adapters,
    #[cfg(feature = "dlna")]
    audio: dlna::Adapters,
}

fn validate_identifiers<'a>(
    identifiers: impl IntoIterator<Item = (&'a str, &'a str)>,
) -> Result<()> {
    let mut devices = BTreeSet::new();
    let mut adapters = BTreeSet::new();
    for (device, adapter) in identifiers {
        ensure(
            devices.len() < 16 && devices.insert(device) && adapters.insert(adapter),
            "conflicting_adapter_config",
        )?;
    }
    Ok(())
}

impl Registry {
    pub fn configured() -> Result<Self> {
        // 显式配置了未编译的集成时拒绝启动，避免悄悄忽略设备配置。
        for (key, enabled) in [
            ("LIMEIOT_TV_CONFIG", cfg!(feature = "android-tv")),
            ("LIMEIOT_AUDIO_CONFIG", cfg!(feature = "dlna")),
        ] {
            ensure(
                enabled || std::env::var_os(key).is_none(),
                "integration_not_enabled",
            )?;
        }
        let registry = Self {
            #[cfg(feature = "android-tv")]
            tv: android_tv::configured()?,
            #[cfg(feature = "dlna")]
            audio: dlna::configured()?,
        };
        let groups: &[Vec<(&str, &str)>] = &[
            #[cfg(feature = "android-tv")]
            registry.tv.identifiers().collect(),
            #[cfg(feature = "dlna")]
            registry.audio.identifiers().collect(),
        ];
        validate_identifiers(groups.iter().flatten().copied())?;
        Ok(registry)
    }

    pub fn offer(&self, _data: &Data, _device: &str, _route: &Route) -> Option<Offer> {
        #[cfg(feature = "android-tv")]
        if let Some(offer) = self.tv.offer(_data, _device, _route) {
            return Some(offer);
        }
        #[cfg(feature = "dlna")]
        if let Some(offer) = self.audio.offer(_data, _device, _route) {
            return Some(offer);
        }
        None
    }

    pub async fn list(&self, app: &App, space: &str) -> Result<Value> {
        let store = app.store.lock().await;
        ensure(store.data.space_id == space, "forbidden")?;
        #[cfg(feature = "android-tv")]
        let tv = self.tv.list(&store.data);
        #[cfg(feature = "dlna")]
        let (audio, revisions) = (
            self.audio.list(&store.data),
            self.audio.media_revisions(&store.data),
        );
        drop(store);
        // 媒体文件I/O不持有核心锁；候选与绑定修订来自同一份快照。
        #[cfg(feature = "dlna")]
        let audio = self.audio.list_managed(app, audio, revisions).await?;
        let lists: &[Value] = &[
            #[cfg(feature = "android-tv")]
            tv,
            #[cfg(feature = "dlna")]
            audio,
        ];
        let items: Vec<_> = lists
            .iter()
            .flat_map(|list| {
                list["items"]
                    .as_array()
                    .expect("integration candidates")
                    .iter()
                    .cloned()
            })
            .collect();
        Ok(json!({"items":items,"next_cursor":null}))
    }

    pub async fn applications(&self, _data: &Data, _device: &str) -> Result<Value> {
        #[cfg(feature = "android-tv")]
        {
            self.tv.applications(_data, _device).await
        }
        #[cfg(not(feature = "android-tv"))]
        {
            Err(err("execution_offer_unavailable"))
        }
    }

    pub fn media_target(
        &self,
        _data: &Data,
        _device: &str,
        _revision: &str,
    ) -> Result<limeiot_core::media::GrantTarget> {
        #[cfg(feature = "dlna")]
        {
            self.audio.grant_target(_data, _device, _revision)
        }
        #[cfg(not(feature = "dlna"))]
        {
            Err(err("media_target_unavailable"))
        }
    }

    pub fn start(&self, _app: &App) -> Vec<JoinHandle<()>> {
        vec![
            #[cfg(feature = "android-tv")]
            tokio::spawn(android_tv::run(_app.clone(), self.tv.clone())),
            #[cfg(feature = "dlna")]
            tokio::spawn(dlna::run(_app.clone(), self.audio.clone())),
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn integration_registration_rejects_ambiguous_devices_ids_and_over_capacity() {
        validate_identifiers([("tv", "adb"), ("speaker", "dlna")]).unwrap();
        assert!(validate_identifiers([("tv", "adb"), ("tv", "dlna")]).is_err());
        assert!(validate_identifiers([("tv", "shared"), ("speaker", "shared")]).is_err());
        let values: Vec<_> = (0..17)
            .map(|i| (format!("device-{i}"), format!("adapter-{i}")))
            .collect();
        assert!(validate_identifiers(
            values
                .iter()
                .map(|(device, adapter)| (device.as_str(), adapter.as_str()))
        )
        .is_err());
    }
}
