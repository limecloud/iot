//! 电视执行路由只消费核心已耐久标记的命令，不建立第二套操作账本。
use crate::application::App;
use limeiot_android_tv::{Adapter, Config, Discovery, Stage};
use limeiot_core::{
    digest,
    engine::Data,
    ensure, err,
    execution::{AdapterReceipt, Route},
    identifier, Result,
};
use serde::Deserialize;
use std::{collections::BTreeSet, sync::Arc, time::Duration};
use tokio::{sync::RwLock, task::JoinSet, time::Instant};

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
    discovery: RwLock<Option<(String, Discovery)>>,
}
impl Entry {
    fn matches(
        &self,
        binding: &limeiot_core::execution_binding::View,
        model: &limeiot_core::model::Model,
    ) -> bool {
        let paths: BTreeSet<_> = model
            .services
            .iter()
            .flat_map(|service| {
                service
                    .actions
                    .iter()
                    .map(|action| format!("{}.{}", service.id, action.id))
            })
            .collect();
        binding.device_id == self.device_id
            && limeiot_android_tv::supports_model(model)
            && !paths.is_empty()
            && binding.routes.keys().cloned().collect::<BTreeSet<_>>()
                == match &binding.native_paths {
                    Some(native) => paths.difference(native).cloned().collect(),
                    None => paths,
                }
            && !binding.routes.is_empty()
            && binding.routes.values().all(|route| *route == self.route)
    }
}
#[derive(Clone)]
pub struct Adapters {
    entries: Vec<Arc<Entry>>,
}

pub fn configured() -> Result<Adapters> {
    let file = match std::env::var("LIMEIOT_TV_CONFIG") {
        Ok(path) => {
            ensure(
                std::path::Path::new(&path).is_absolute(),
                "invalid_tv_adapter_config",
            )?;
            let bytes = std::fs::read(path).map_err(|_| err("invalid_tv_adapter_config"))?;
            let value = limeiot_core::validation::bounded_document(&bytes, 65_536, 12, 4096)
                .ok_or_else(|| err("invalid_tv_adapter_config"))?;
            serde_json::from_value::<File>(value).map_err(|_| err("invalid_tv_adapter_config"))?
        }
        Err(std::env::VarError::NotPresent) => File {
            schema_version: 1,
            bindings: vec![],
        },
        Err(_) => return Err(err("invalid_tv_adapter_config")),
    };
    build_configuration(file)
}

fn build_configuration(file: File) -> Result<Adapters> {
    ensure(
        file.schema_version == 1 && file.bindings.len() <= 16,
        "invalid_tv_adapter_config",
    )?;
    let mut ids = BTreeSet::new();
    let mut devices = BTreeSet::new();
    let mut targets = BTreeSet::new();
    let mut serials = BTreeSet::new();
    let mut entries = Vec::new();
    for binding in file.bindings {
        ensure(
            identifier(&binding.adapter_id)
                && identifier(&binding.device_id)
                && ids.insert(binding.adapter_id.clone())
                && devices.insert(binding.device_id.clone())
                && targets.insert(binding.config.target)
                && serials.insert(binding.config.device_serial.clone()),
            "invalid_tv_adapter_config",
        )?;
        let route = Route {
            adapter_id: binding.adapter_id,
            revision: digest(&binding.config)?,
        };
        entries.push(Arc::new(Entry {
            device_id: binding.device_id,
            route,
            adapter: Adapter::new(binding.config.clone())?,
            config: binding.config,
            discovery: RwLock::new(None),
        }));
    }
    Ok(Adapters { entries })
}

impl Adapters {
    pub fn identifiers(&self) -> impl Iterator<Item = (&str, &str)> {
        self.entries
            .iter()
            .map(|entry| (entry.device_id.as_str(), entry.route.adapter_id.as_str()))
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
        if !limeiot_android_tv::supports_model(model) {
            return None;
        }
        Some(limeiot_core::execution_binding::Offer {
            device_id: device_id.into(),
            route: route.clone(),
            model_revision: device.model_revision.clone(),
            paths: model
                .services
                .iter()
                .flat_map(|service| {
                    service
                        .actions
                        .iter()
                        .map(|action| format!("{}.{}", service.id, action.id))
                })
                .collect(),
        })
    }
    pub fn list(&self, data: &Data) -> serde_json::Value {
        serde_json::json!({"items":self.entries.iter().map(|entry| serde_json::json!({
            "device_id":entry.device_id,"route":entry.route,"compatible":self.offer(data,&entry.device_id,&entry.route).is_some(),
            "target":entry.config.target.to_string(),"fingerprint":entry.config.fingerprint,"device_serial":entry.config.device_serial,
            "applications":entry.config.applications
        })).collect::<Vec<_>>(),"next_cursor":null})
    }
    pub async fn applications(&self, data: &Data, device_id: &str) -> Result<serde_json::Value> {
        let binding = data.execution_binding(device_id)?;
        let entry = self
            .entries
            .iter()
            .find(|entry| {
                entry.device_id == device_id
                    && binding.routes.get("apps.launch") == Some(&entry.route)
            })
            .ok_or_else(|| err("execution_offer_unavailable"))?;
        let cache = entry.discovery.read().await;
        let current = cache.as_ref().filter(|(revision, discovery)| {
            *revision == binding.revision && {
                let age = chrono::Utc::now() - discovery.observed_at;
                age >= chrono::Duration::zero() && age < chrono::Duration::seconds(15)
            }
        });
        Ok(match current {
            Some((_, discovery)) => {
                serde_json::json!({"device_id":device_id,"binding_revision":binding.revision,"fresh":true,
                "observed_at":discovery.observed_at,"items":discovery.applications.iter().map(|id|serde_json::json!({
                    "application_id":id,"authorized":entry.config.applications.iter().any(|grant| grant.application_id == *id)
                })).collect::<Vec<_>>(),"next_cursor":null})
            }
            None => {
                serde_json::json!({"device_id":device_id,"binding_revision":binding.revision,"fresh":false,"observed_at":null,"items":[],"next_cursor":null})
            }
        })
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
                    entry.matches(binding, &store.data.models[&binding.model_revision])
                })
        };
        let revision = binding.map(|binding| binding.revision);
        if revision != active_revision {
            active_revision = revision.clone();
            next_probe = Instant::now();
            session_id = limeiot_core::id();
            *entry.discovery.write().await = None;
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
            *entry.discovery.write().await = probe.ok().map(|discovery| (revision, discovery));
        }
        let commands = app
            .update("commands.transitioned", |data| {
                Ok(data.prepare_adapter_dispatch(&entry.route.adapter_id, chrono::Utc::now()))
            })
            .await;
        let Ok(commands) = commands else {
            continue;
        };
        for command in commands {
            let remaining = (command.request.expires_at - chrono::Utc::now())
                .to_std()
                .unwrap_or(Duration::ZERO);
            let outcome = entry
                .adapter
                .execute_authorized(
                    &command.request.operation,
                    Instant::now() + remaining,
                    || async {
                        app.store
                            .lock()
                            .await
                            .data
                            .recheck_adapter_dispatch(&command, chrono::Utc::now())
                    },
                )
                .await;
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
                error: outcome.error.map(str::to_owned),
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
    fn fixture(full_model: bool) -> (Data, File) {
        let config: Config=serde_json::from_value(json!({"schema_version":1,"adb_path":std::env::current_exe().unwrap(),
            "state_directory":std::env::temp_dir(),"server_port":5049,"target":"192.168.31.94:5555",
            "fingerprint":"sample/device/build:6.0.1/version:user/release-keys","device_serial":"sample-tv-001",
            "applications":[],"timeout_ms":3000})).unwrap();
        let route = Route {
            adapter_id: "tv-adb".into(),
            revision: digest(&config).unwrap(),
        };
        let model: limeiot_core::model::Model = serde_json::from_slice(if full_model {
            include_bytes!("../../../../contracts/models/android-tv.json").as_slice()
        } else {
            include_bytes!("../../../../contracts/models/android-tv-remote.json").as_slice()
        })
        .unwrap();
        let data=Data::new(serde_json::from_value(json!({"space_id":"home","models":[model],"devices":[{
            "device_id":"tv","model_revision":digest(&model).unwrap(),"routes":{"remote.press":route,"apps.launch":route}}]})).unwrap()).unwrap();
        (
            data,
            File {
                schema_version: 1,
                bindings: vec![Binding {
                    device_id: "tv".into(),
                    adapter_id: "tv-adb".into(),
                    config,
                }],
            },
        )
    }
    #[test]
    fn precise_action_model_and_matching_owner_configuration_are_required() {
        let (data, file) = fixture(false);
        let route = data.devices["tv"].routes["remote.press"].clone();
        let adapters = build_configuration(file).unwrap();
        assert!(adapters.offer(&data, "tv", &route).is_some());
        let (data, file) = fixture(true);
        assert!(build_configuration(file)
            .unwrap()
            .offer(&data, "tv", &route)
            .is_none());
        let (data, mut file) = fixture(false);
        file.bindings[0].config.timeout_ms = 4000;
        let adapters = build_configuration(file).unwrap();
        assert!(adapters.offer(&data, "tv", &route).is_none());
        assert_eq!(adapters.list(&data)["items"][0]["compatible"], true);
        assert_ne!(
            adapters.list(&data)["items"][0]["route"]["revision"],
            route.revision
        );
        assert!(build_configuration(File {
            schema_version: 1,
            bindings: vec![]
        })
        .unwrap()
        .entries
        .is_empty());
    }
    #[test]
    fn incomplete_or_split_legacy_routes_do_not_activate_the_tv_provider() {
        let (mut data, file) = fixture(false);
        let adapters = build_configuration(file).unwrap();
        let entry = &adapters.entries[0];
        assert!(entry.matches(
            &data.execution_binding("tv").unwrap(),
            &data.models[&data.devices["tv"].model_revision]
        ));
        data.devices
            .get_mut("tv")
            .unwrap()
            .routes
            .remove("apps.launch");
        assert!(!entry.matches(
            &data.execution_binding("tv").unwrap(),
            &data.models[&data.devices["tv"].model_revision]
        ));
        let mut other = entry.route.clone();
        other.adapter_id = "other-adapter".into();
        data.devices
            .get_mut("tv")
            .unwrap()
            .routes
            .insert("apps.launch".into(), other);
        assert!(!entry.matches(
            &data.execution_binding("tv").unwrap(),
            &data.models[&data.devices["tv"].model_revision]
        ));
        // 候选仍可供所有者明确修复绑定，调度不能据候选兼容提前激活。
        assert!(adapters.offer(&data, "tv", &entry.route).is_some());
    }
    #[tokio::test]
    async fn composed_paths_activate_only_their_provider_and_do_not_project_native_app_grants() {
        use limeiot_core::execution_binding::{Change, Request};
        let (mut data, file) = fixture(false);
        let adapters = build_configuration(file).unwrap();
        let route = adapters.entries[0].route.clone();
        let offer = adapters.offer(&data, "tv", &route).unwrap();
        let now = chrono::Utc::now();
        let device = data.devices.get_mut("tv").unwrap();
        device.ready = true;
        device.last_seen = Some(now);
        device.session_id = Some("native-session".into());
        device.native_actions = Some(["apps.launch".into()].into());
        let change = Change::Compose {
            device_id: "tv".into(),
            route,
            native_paths: ["apps.launch".into()].into(),
            expected_native_session: "native-session".into(),
            expected_binding_revision: data.execution_binding("tv").unwrap().revision,
            expected_model_revision: data.devices["tv"].model_revision.clone(),
        };
        data.apply_execution_change(
            Request {
                space_id: "home".into(),
                idempotency_key: "compose".into(),
                change,
            },
            Some(&offer),
            now,
        )
        .unwrap();
        let binding = data.execution_binding("tv").unwrap();
        assert!(adapters.entries[0].matches(&binding, &data.models[&binding.model_revision]));
        assert_eq!(
            adapters.applications(&data, "tv").await.unwrap_err().code,
            "execution_offer_unavailable"
        );
        let mut forged = binding;
        forged.native_paths = None;
        assert!(!adapters.entries[0].matches(&forged, &data.models[&forged.model_revision]));
    }
    #[test]
    fn startup_cannot_claim_a_result_the_static_executor_does_not_produce() {
        for output in [
            json!({"type":"string","maxLength":64}),
            json!({"type":"object","properties":{"status":{"type":"boolean"}},"required":["status"],"additionalProperties":false}),
            json!({"type":"object","additionalProperties":true}),
            json!({"type":"object"}),
        ] {
            let (mut data, file) = fixture(false);
            let revision = data.devices["tv"].model_revision.clone();
            let route = data.devices["tv"].routes["remote.press"].clone();
            data.models.get_mut(&revision).unwrap().services[0].actions[0].output =
                serde_json::from_value(output).unwrap();
            assert!(build_configuration(file)
                .unwrap()
                .offer(&data, "tv", &route)
                .is_none());
        }
        let (mut data, file) = fixture(false);
        let revision = data.devices["tv"].model_revision.clone();
        let route = data.devices["tv"].routes["remote.press"].clone();
        data.models.get_mut(&revision).unwrap().services[0].actions[0].completion =
            "observed".into();
        assert!(build_configuration(file)
            .unwrap()
            .offer(&data, "tv", &route)
            .is_none());
    }
}
