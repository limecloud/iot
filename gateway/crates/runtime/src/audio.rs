//! DLNA静态执行端复用核心绑定、FIFO和耐久命令，不建立播放队列或重试账本。
use crate::application::App;
use limeiot_core::{
    digest,
    engine::Data,
    ensure, err,
    execution::{AdapterReceipt, Route},
    identifier, Result,
};
use limeiot_dlna::{Adapter, Config, Stage};
use serde::Deserialize;
use std::{collections::BTreeSet, sync::Arc, time::Duration};
use tokio::{task::JoinSet, time::Instant};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct File {
    schema_version: u8,
    bindings: Vec<Binding>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Binding {
    device_id: String,
    adapter_id: String,
    config: Config,
}
struct Entry {
    device_id: String,
    route: Route,
    adapter: Adapter,
    config: Config,
}
#[derive(Clone)]
pub struct Adapters {
    entries: Vec<Arc<Entry>>,
}
pub fn configured() -> Result<Adapters> {
    let file = match std::env::var("LIMEIOT_AUDIO_CONFIG") {
        Ok(path) => {
            ensure(
                std::path::Path::new(&path).is_absolute(),
                "invalid_audio_adapter_config",
            )?;
            let bytes = std::fs::read(path).map_err(|_| err("invalid_audio_adapter_config"))?;
            let value = limeiot_core::validation::bounded_document(&bytes, 65_536, 12, 4096)
                .ok_or_else(|| err("invalid_audio_adapter_config"))?;
            serde_json::from_value::<File>(value)
                .map_err(|_| err("invalid_audio_adapter_config"))?
        }
        Err(std::env::VarError::NotPresent) => File {
            schema_version: 1,
            bindings: vec![],
        },
        Err(_) => return Err(err("invalid_audio_adapter_config")),
    };
    build(file)
}
fn build(file: File) -> Result<Adapters> {
    ensure(
        file.schema_version == 1 && file.bindings.len() <= 16,
        "invalid_audio_adapter_config",
    )?;
    let mut devices = BTreeSet::new();
    let mut ids = BTreeSet::new();
    let mut targets = BTreeSet::new();
    let mut udns = BTreeSet::new();
    let mut entries = vec![];
    for binding in file.bindings {
        ensure(
            identifier(&binding.device_id)
                && identifier(&binding.adapter_id)
                && devices.insert(binding.device_id.clone())
                && ids.insert(binding.adapter_id.clone())
                && targets.insert(binding.config.target)
                && udns.insert(binding.config.udn.clone()),
            "invalid_audio_adapter_config",
        )?;
        entries.push(Arc::new(Entry {
            device_id: binding.device_id,
            route: Route {
                adapter_id: binding.adapter_id,
                revision: digest(&binding.config)?,
            },
            adapter: Adapter::new(binding.config.clone())?,
            config: binding.config,
        }));
    }
    Ok(Adapters { entries })
}
impl Adapters {
    pub fn grant_target(
        &self,
        data: &Data,
        device_id: &str,
        binding_revision: &str,
    ) -> Result<limeiot_core::media::GrantTarget> {
        let binding = data.execution_binding(device_id)?;
        ensure(binding.revision == binding_revision, "revision_conflict")?;
        let entry = self
            .entries
            .iter()
            .find(|entry| {
                entry.device_id == device_id
                    && entry.config.managed_media
                    && binding.routes.get("playback.play") == Some(&entry.route)
            })
            .ok_or_else(|| err("media_target_unavailable"))?;
        ensure(
            self.offer(data, device_id, &entry.route).is_some(),
            "media_target_unavailable",
        )?;
        Ok(limeiot_core::media::GrantTarget {
            device_id: device_id.into(),
            binding_revision: binding_revision.into(),
            source_ip: *entry.config.target.ip(),
        })
    }
    pub fn validate_with_tv(&self, tv: &crate::tv::Adapters) -> Result<()> {
        let mut ids = BTreeSet::new();
        let mut devices = BTreeSet::new();
        let all: Vec<_> = tv
            .identifiers()
            .chain(
                self.entries
                    .iter()
                    .map(|e| (e.device_id.as_str(), e.route.adapter_id.as_str())),
            )
            .collect();
        ensure(
            all.len() <= 16
                && all
                    .into_iter()
                    .all(|(device, id)| ids.insert(id) && devices.insert(device)),
            "conflicting_adapter_config",
        )
    }
    pub fn offer(
        &self,
        data: &Data,
        device_id: &str,
        route: &Route,
    ) -> Option<limeiot_core::execution_binding::Offer> {
        self.entries
            .iter()
            .find(|entry| entry.device_id == device_id && entry.route == *route)?;
        let device = data.devices.get(device_id)?;
        let model = data.models.get(&device.model_revision)?;
        if !limeiot_dlna::supports_model(model) {
            return None;
        }
        Some(limeiot_core::execution_binding::Offer {
            device_id: device_id.into(),
            route: route.clone(),
            model_revision: device.model_revision.clone(),
            paths: model
                .services
                .iter()
                .flat_map(|s| s.actions.iter().map(|a| format!("{}.{}", s.id, a.id)))
                .collect(),
        })
    }
    pub fn list(&self, data: &Data) -> serde_json::Value {
        serde_json::json!({"items":self.entries.iter().map(|entry| serde_json::json!({
            "kind":"dlna", "device_id":entry.device_id, "route":entry.route,
            "compatible":self.offer(data,&entry.device_id,&entry.route).is_some(),
            "target":entry.config.target.to_string(), "udn":entry.config.udn,
            "volume_limit":entry.config.volume_limit, "playback_volume":entry.config.playback_volume,
            "media":entry.config.media.iter().map(|m| serde_json::json!({"media_id":m.media_id,"expires_at":m.expires_at})).collect::<Vec<_>>()
        })).collect::<Vec<_>>(), "next_cursor":null})
    }
    pub fn media_revisions(&self, data: &Data) -> std::collections::BTreeMap<String, String> {
        self.entries
            .iter()
            .filter(|entry| entry.config.managed_media)
            .filter_map(|entry| {
                data.execution_binding(&entry.device_id)
                    .ok()
                    .map(|binding| (entry.device_id.clone(), binding.revision))
            })
            .collect()
    }
    pub async fn list_managed(
        &self,
        app: &App,
        mut value: serde_json::Value,
        revisions: std::collections::BTreeMap<String, String>,
    ) -> Result<serde_json::Value> {
        for item in value["items"].as_array_mut().expect("audio candidates") {
            let id = item["device_id"].as_str().unwrap_or_default().to_owned();
            if self
                .entries
                .iter()
                .any(|e| e.device_id == id && e.config.managed_media)
            {
                item["managed_media"] = serde_json::json!(true);
                if let (Some(media), Some(revision)) = (&app.media, revisions.get(&id)) {
                    item["media"] = serde_json::json!(media.choices(&id, revision).await?);
                }
            }
        }
        Ok(value)
    }
}
pub async fn run(app: App, adapters: Adapters) {
    let mut tasks = JoinSet::new();
    for entry in adapters.entries {
        tasks.spawn(run_entry(app.clone(), entry));
    }
    while tasks.join_next().await.is_some() {}
}
async fn run_entry(app: App, entry: Arc<Entry>) {
    let mut interval = tokio::time::interval(Duration::from_millis(50));
    let mut next_probe = Instant::now();
    let mut active_revision = None;
    let mut session_id = limeiot_core::id();
    loop {
        interval.tick().await;
        let binding = {
            let store = app.store.lock().await;
            store
                .data
                .execution_binding(&entry.device_id)
                .ok()
                .filter(|binding| {
                    let Some(offer) = app.audio.offer(&store.data, &entry.device_id, &entry.route)
                    else {
                        return false;
                    };
                    let paths = match &binding.native_paths {
                        Some(native) => offer.paths.difference(native).cloned().collect(),
                        None => offer.paths,
                    };
                    !binding.routes.is_empty()
                        && binding.routes.keys().cloned().collect::<BTreeSet<_>>() == paths
                        && binding.routes.values().all(|r| *r == entry.route)
                })
        };
        let revision = binding.map(|b| b.revision);
        if revision != active_revision {
            active_revision = revision.clone();
            next_probe = Instant::now();
            session_id = limeiot_core::id();
        }
        let Some(revision) = revision else {
            continue;
        };
        if Instant::now() >= next_probe {
            let probe = entry
                .adapter
                .discover(Instant::now() + Duration::from_secs(5))
                .await;
            let result = app
                .update("adapter.connection", |data| {
                    ensure(
                        data.execution_binding(&entry.device_id)?.revision == revision,
                        "revision_conflict",
                    )?;
                    if probe.is_ok() {
                        data.adapter_seen(
                            &entry.device_id,
                            &entry.route,
                            &session_id,
                            chrono::Utc::now(),
                        )
                    } else {
                        data.adapter_disconnected(&entry.route.adapter_id);
                        Ok(())
                    }
                })
                .await;
            next_probe = Instant::now() + Duration::from_secs(5);
            if result.is_err() {
                continue;
            }
        }
        let Ok(commands) = app
            .update("commands.transitioned", |data| {
                Ok(data.prepare_adapter_dispatch(&entry.route.adapter_id, chrono::Utc::now()))
            })
            .await
        else {
            continue;
        };
        for command in commands {
            let remaining = (command.request.expires_at - chrono::Utc::now())
                .to_std()
                .unwrap_or(Duration::ZERO);
            let managed = if entry.config.managed_media
                && command.request.operation.path == "playback.play"
            {
                match &app.media {
                    Some(media) => {
                        let binding = app
                            .store
                            .lock()
                            .await
                            .data
                            .execution_binding(&entry.device_id);
                        match binding {
                            Ok(binding) => media
                                .playback(
                                    command.request.operation.value["media_id"]
                                        .as_str()
                                        .unwrap_or_default(),
                                    &entry.device_id,
                                    &binding.revision,
                                )
                                .await
                                .map(Some),
                            Err(error) => Err(error),
                        }
                    }
                    None => Err(err("media_not_configured")),
                }
            } else {
                Ok(None)
            };
            let outcome = match managed {
                Err(error) => limeiot_dlna::Outcome {
                    stage: Stage::Rejected,
                    error: Some(error.code),
                    observed_at: chrono::Utc::now(),
                },
                Ok(managed) => {
                    entry
                        .adapter
                        .execute_with_media_authorized(
                            &command.request.operation,
                            Instant::now() + remaining,
                            managed.clone(),
                            || async {
                                let binding = {
                                    let store = app.store.lock().await;
                                    store
                                        .data
                                        .recheck_adapter_dispatch(&command, chrono::Utc::now())?;
                                    store.data.execution_binding(&entry.device_id)?
                                };
                                if let Some(original) = &managed {
                                    let current = app
                                        .media
                                        .as_ref()
                                        .ok_or_else(|| err("media_not_configured"))?
                                        .playback(
                                            &original.media_id,
                                            &entry.device_id,
                                            &binding.revision,
                                        )
                                        .await?;
                                    ensure(current.url == original.url, "audio_media_forbidden")?;
                                }
                                Ok(())
                            },
                        )
                        .await
                }
            };
            let receipt = AdapterReceipt {
                command_id: command.command_id,
                request_digest: command.request_digest,
                route: entry.route.clone(),
                session_id: command.envelope.session_id.unwrap_or_default(),
                status: match outcome.stage {
                    Stage::Submitted => "confirmed",
                    Stage::Rejected => "failed",
                    Stage::Unknown => "unknown",
                }
                .into(),
                error: outcome.error,
                observed_at: outcome.observed_at,
            };
            let _ = app
                .update("adapter.result", |data| {
                    data.apply_adapter_result(receipt, chrono::Utc::now())
                })
                .await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn file() -> File {
        serde_json::from_value(json!({"schema_version":1,"bindings":[{"device_id":"speaker","adapter_id":"dlna",
            "config":{"schema_version":1,"target":"127.0.0.1:18111","description_path":"/description.xml","av_transport_path":"/av","rendering_control_path":"/render",
            "udn":"uuid:test-speaker","playback_volume":10,"volume_limit":20,"media":[{"media_id":"chime","url":"http://127.0.0.1:18112/chime.wav","expires_at":"2030-01-01T00:00:00Z"}],"timeout_ms":3000}}]})).unwrap()
    }
    #[test]
    fn audio_candidates_never_bind_or_expose_media_urls() {
        let model: limeiot_core::model::Model = serde_json::from_slice(include_bytes!(
            "../../../../contracts/models/dlna-speaker.json"
        ))
        .unwrap();
        let data=Data::new(serde_json::from_value(json!({"space_id":"home","models":[model],"devices":[{"device_id":"speaker","model_revision":digest(&model).unwrap()}]})).unwrap()).unwrap();
        let adapters = build(file()).unwrap();
        let list = adapters.list(&data);
        assert_eq!(list["items"][0]["compatible"], true);
        assert!(!list.to_string().contains("chime.wav"));
        assert_eq!(data.execution_binding("speaker").unwrap().state, "native");
        let wrong = Route {
            adapter_id: "dlna".into(),
            revision: format!("sha256:{}", "a".repeat(64)),
        };
        assert!(adapters.offer(&data, "speaker", &wrong).is_none());
        assert_eq!(
            adapters
                .offer(&data, "speaker", &adapters.entries[0].route)
                .unwrap()
                .paths
                .len(),
            3
        );
    }
    #[test]
    fn duplicate_audio_devices_targets_and_udns_are_rejected() {
        for field in ["device", "adapter", "target", "udn"] {
            let mut file = file();
            let mut second = Binding {
                device_id: "second".into(),
                adapter_id: "second".into(),
                config: file.bindings[0].config.clone(),
            };
            second.config.target = "127.0.0.1:18113".parse().unwrap();
            second.config.udn = "uuid:second".into();
            match field {
                "device" => second.device_id = "speaker".into(),
                "adapter" => second.adapter_id = "dlna".into(),
                "target" => second.config.target = file.bindings[0].config.target,
                _ => second.config.udn = file.bindings[0].config.udn.clone(),
            }
            file.bindings.push(second);
            assert!(build(file).is_err(), "{field}");
        }
    }
}
