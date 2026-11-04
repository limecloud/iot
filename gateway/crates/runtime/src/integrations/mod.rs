//! 可选集成的装配入口；协议实现互不依赖，API共用核心的候选与绑定合同。
#[cfg(feature = "android-tv")]
mod android_tv;
#[cfg(feature = "dlna")]
mod dlna;
#[cfg(all(feature = "zigbee-znp", unix))]
mod zigbee;

use crate::application::App;
#[cfg(any(not(feature = "android-tv"), not(feature = "dlna")))]
use limeiot_core::err;
use limeiot_core::{engine::Data, ensure, execution::Route, execution_binding::Offer, Result};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use tokio::task::JoinSet;

#[cfg(any(
    feature = "android-tv",
    feature = "dlna",
    all(feature = "zigbee-znp", unix)
))]
async fn run_owned_tasks(app: &App, mut tasks: JoinSet<()>) {
    loop {
        tokio::select! {
            biased;
            _ = app.wait_for_shutdown() => break,
            result = tasks.join_next() => if result.is_none() { break; },
        }
    }
    tasks.shutdown().await;
}

pub struct Registry {
    #[cfg(feature = "android-tv")]
    tv: android_tv::Adapters,
    #[cfg(feature = "dlna")]
    audio: dlna::Adapters,
    #[cfg(all(feature = "zigbee-znp", unix))]
    zigbee: zigbee::Adapters,
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
    pub async fn zigbee_coordinators(&self, app: &App, space: &str) -> Result<Value> {
        ensure(app.store.lock().await.data.space_id == space, "forbidden")?;
        #[cfg(all(feature = "zigbee-znp", unix))]
        {
            self.zigbee.coordinators()
        }
        #[cfg(not(all(feature = "zigbee-znp", unix)))]
        {
            Ok(json!({"items":[],"next_cursor":null}))
        }
    }

    pub async fn zigbee_commission(
        &self,
        app: &App,
        request: crate::commissioning::Request,
    ) -> Result<crate::commissioning::Operation> {
        request.validate()?;
        {
            let store = app.store.lock().await;
            ensure(store.data.space_id == request.space_id, "forbidden")?;
            if let Some(previous) = store.commissioning.get(&request.idempotency_key) {
                ensure(previous.request == request, "idempotency_conflict")?;
                return Ok(previous.clone());
            }
        }
        #[cfg(all(feature = "zigbee-znp", unix))]
        {
            self.zigbee.commission(app, request).await
        }
        #[cfg(not(all(feature = "zigbee-znp", unix)))]
        {
            Err(limeiot_core::err("observation_not_enabled"))
        }
    }

    pub fn configured() -> Result<Self> {
        // 显式配置了未编译的集成时拒绝启动，避免悄悄忽略设备配置。
        for (key, enabled) in [
            ("LIMEIOT_TV_CONFIG", cfg!(feature = "android-tv")),
            ("LIMEIOT_AUDIO_CONFIG", cfg!(feature = "dlna")),
            (
                "LIMEIOT_ZIGBEE_CONFIG",
                cfg!(all(feature = "zigbee-znp", unix)),
            ),
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
            #[cfg(all(feature = "zigbee-znp", unix))]
            zigbee: zigbee::configured()?,
        };
        let groups: &[Vec<(&str, &str)>] = &[
            #[cfg(feature = "android-tv")]
            registry.tv.identifiers().collect(),
            #[cfg(feature = "dlna")]
            registry.audio.identifiers().collect(),
            #[cfg(all(feature = "zigbee-znp", unix))]
            registry.zigbee.identifiers().collect(),
        ];
        validate_identifiers(groups.iter().flatten().copied())?;
        Ok(registry)
    }

    pub fn observation_sources(&self) -> Vec<limeiot_core::observation::Policy> {
        let groups: &[Vec<limeiot_core::observation::Policy>] = &[
            #[cfg(all(feature = "zigbee-znp", unix))]
            self.zigbee.policies(),
        ];
        groups.iter().flatten().cloned().collect()
    }
    pub fn property_bridges(&self) -> Vec<limeiot_core::property_bridge::Policy> {
        #[cfg(all(feature = "zigbee-znp", unix))]
        {
            self.zigbee.property_bridges()
        }
        #[cfg(not(all(feature = "zigbee-znp", unix)))]
        {
            Vec::new()
        }
    }

    pub async fn observation_candidates(&self, app: &App, space: &str) -> Result<Value> {
        ensure(app.store.lock().await.data.space_id == space, "forbidden")?;
        #[cfg(all(feature = "zigbee-znp", unix))]
        {
            self.zigbee.list()
        }
        #[cfg(not(all(feature = "zigbee-znp", unix)))]
        {
            Ok(json!({"coordinators":[],"items":[],"next_cursor":null}))
        }
    }

    pub async fn observation_query(&self, app: &App, space: &str, _body: &[u8]) -> Result<Value> {
        ensure(app.store.lock().await.data.space_id == space, "forbidden")?;
        #[cfg(all(feature = "zigbee-znp", unix))]
        {
            self.zigbee.query(_body).await
        }
        #[cfg(not(all(feature = "zigbee-znp", unix)))]
        {
            Err(limeiot_core::err("observation_not_enabled"))
        }
    }

    pub async fn observation_discovery(
        &self,
        app: &App,
        space: &str,
        _body: &[u8],
        _endpoints: bool,
    ) -> Result<Value> {
        ensure(app.store.lock().await.data.space_id == space, "forbidden")?;
        #[cfg(all(feature = "zigbee-znp", unix))]
        {
            self.zigbee.discover(_body, _endpoints).await
        }
        #[cfg(not(all(feature = "zigbee-znp", unix)))]
        {
            Err(limeiot_core::err("observation_not_enabled"))
        }
    }

    pub fn observation_offer(
        &self,
        _source: &Route,
    ) -> Option<limeiot_core::observation_binding::Offer> {
        #[cfg(all(feature = "zigbee-znp", unix))]
        {
            self.zigbee.offer(_source)
        }
        #[cfg(not(all(feature = "zigbee-znp", unix)))]
        {
            None
        }
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

    pub fn start(&self, _app: &App, _tasks: &mut JoinSet<()>) {
        #[cfg(feature = "android-tv")]
        _tasks.spawn(android_tv::run(_app.clone(), self.tv.clone()));
        #[cfg(feature = "dlna")]
        _tasks.spawn(dlna::run(_app.clone(), self.audio.clone()));
        #[cfg(all(feature = "zigbee-znp", unix))]
        _tasks.spawn(zigbee::run(_app.clone(), self.zigbee.clone()));
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
