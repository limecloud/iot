//! 固定环境与开关映射，共用串口任务和核心的来源、命令授权。
use crate::application::App;
use chrono::{DateTime, Utc};
use limeiot_core::{
    digest,
    engine::Data,
    ensure, err,
    execution::{AdapterReceipt, Route},
    identifier,
    observation::{Policy, Sample, Snapshot},
    observation_binding::{Binding as ManagedBinding, Offer},
    Result,
};
use limeiot_zigbee_znp::{
    serial::Serial, DiscoveryTarget, EnvironmentReading, EnvironmentTarget, Interview,
    InterviewTarget, JoinWindow, JoinWindowTarget, Neighbors, OnOffCommandTarget, OnOffReading,
    Session, Signature,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    sync::{mpsc, oneshot, Semaphore},
    task::JoinSet,
    time::Instant,
};

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct File {
    schema_version: u8,
    bindings: Vec<Binding>,
    #[serde(default)]
    coordinators: Option<Vec<Coordinator>>,
    #[serde(default)]
    on_off_bindings: Option<Vec<Binding>>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Coordinator {
    coordinator_id: String,
    serial: String,
    coordinator_ieee: String,
    timeout_ms: u64,
    poll_interval_ms: u64,
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Binding {
    device_id: String,
    adapter_id: String,
    model_revision: String,
    serial: String,
    target: EnvironmentTarget,
    manufacturer_code: u16,
    signature: Signature,
    timeout_ms: u64,
    poll_interval_ms: u64,
}
#[derive(Clone)]
struct Entry {
    binding: Binding,
    policy: Policy,
    generation: Option<String>,
    mapping: Mapping,
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Mapping {
    Environment,
    OnOff,
}
impl Mapping {
    fn name(self) -> &'static str {
        match self {
            Self::Environment => "znp-environment-v1",
            Self::OnOff => "znp-on-off-v1",
        }
    }
    fn model(self) -> Result<limeiot_core::model::Model> {
        match self {
            Self::Environment => environment_model(),
            Self::OnOff => on_off_model(),
        }
    }
    fn write_paths(self) -> BTreeSet<String> {
        match self {
            Self::Environment => BTreeSet::new(),
            Self::OnOff => BTreeSet::from(["light.power".into()]),
        }
    }
    fn from_manifest(manifest: &Manifest) -> Result<Self> {
        match manifest.mapping.as_str() {
            "znp-environment-v1" => Ok(Self::Environment),
            "znp-on-off-v1" => Ok(Self::OnOff),
            _ => Err(err("invalid_zigbee_manifest")),
        }
    }
}
#[derive(Clone)]
struct Group {
    serial: String,
    coordinator_ieee: String,
    coordinator: Option<Coordinator>,
    entries: Vec<Entry>,
    queries: Arc<Queries>,
}
struct Queries {
    sender: mpsc::Sender<Probe>,
    receiver: Mutex<Option<mpsc::Receiver<Probe>>>,
    slot: Arc<Semaphore>,
    candidates: Mutex<BTreeMap<String, Candidate>>,
}
impl Queries {
    fn new() -> Self {
        let (sender, receiver) = mpsc::channel(1);
        Self {
            sender,
            receiver: Mutex::new(Some(receiver)),
            slot: Arc::new(Semaphore::new(1)),
            candidates: Mutex::new(BTreeMap::new()),
        }
    }
}
struct Probe {
    request: ProbeRequest,
    deadline: Instant,
    response: oneshot::Sender<Result<Value>>,
    _slot: tokio::sync::OwnedSemaphorePermit,
}
enum ProbeRequest {
    Candidate(EnvironmentTarget, Mapping),
    Neighbors,
    Interview(String),
    Join { key: String, duration_seconds: u8 },
}
enum ProbeResult {
    Candidate(EnvironmentTarget, Reading),
    Neighbors(Neighbors),
    Interview(Interview),
    Join(JoinWindow),
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    mapping: String,
    target: EnvironmentTarget,
    manufacturer_code: u16,
    signature: Signature,
    model_revision: String,
}
#[derive(Clone)]
struct Candidate {
    manifest: Manifest,
    source: Route,
    observed_at: DateTime<Utc>,
    expires_at: DateTime<Utc>,
}
impl Candidate {
    fn view(&self) -> Value {
        let mut view = json!({"source":self.source,"model_revision":self.manifest.model_revision,
            "target":self.manifest.target,"manufacturer_code":self.manifest.manufacturer_code,
            "signature":self.manifest.signature,"observed_at":self.observed_at,"expires_at":self.expires_at,
            "protocol":"zigbee-znp","evidence":"unauthenticated_protocol"});
        if self.manifest.mapping == Mapping::OnOff.name() {
            view["write_paths"] = json!(["light.power"]);
        }
        view
    }
    fn offer(&self) -> Result<Offer> {
        let mapping = Mapping::from_manifest(&self.manifest)?;
        Ok(Offer {
            source: self.source.clone(),
            model: mapping.model()?,
            write_paths: mapping.write_paths(),
            manifest: json!(self.manifest),
            observed_at: self.observed_at,
            expires_at: self.expires_at,
        })
    }
}

fn environment_model() -> Result<limeiot_core::model::Model> {
    serde_json::from_str(include_str!(
        "../../../../../contracts/models/environment.json"
    ))
    .map_err(|_| err("invalid_zigbee_config"))
}
fn on_off_model() -> Result<limeiot_core::model::Model> {
    serde_json::from_str(include_str!(
        "../../../../../contracts/models/on-off-light.json"
    ))
    .map_err(|_| err("invalid_zigbee_config"))
}
fn source_id(target: &EnvironmentTarget) -> Result<String> {
    Ok(format!("znp-{}", &digest(target)?[7..]))
}
fn valid_signature(signature: &Signature) -> bool {
    [&signature.manufacturer, &signature.model]
        .iter()
        .all(|value| {
            !value.trim().is_empty() && value.len() <= 32 && !value.chars().any(char::is_control)
        })
}
fn valid_ieee(value: &str) -> bool {
    value.len() == 16
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        && !value.bytes().all(|b| b == b'0')
        && !value.bytes().all(|b| b == b'f')
}
fn manifest_entry(
    device: &str,
    binding: &ManagedBinding,
    coordinator: &Coordinator,
) -> Result<Entry> {
    let manifest: Manifest = serde_json::from_value(binding.manifest.clone())
        .map_err(|_| err("invalid_zigbee_manifest"))?;
    manifest
        .target
        .validate()
        .map_err(|_| err("invalid_zigbee_manifest"))?;
    let mapping = Mapping::from_manifest(&manifest)?;
    ensure(
        valid_signature(&manifest.signature)
            && binding.write_paths == mapping.write_paths()
            && manifest.model_revision == digest(&mapping.model()?)?
            && manifest.model_revision == binding.policy.model_revision
            && binding.policy.source.adapter_id == source_id(&manifest.target)?
            && binding.policy.source.revision == digest(&manifest)?
            && manifest.target.coordinator_ieee == coordinator.coordinator_ieee,
        "invalid_zigbee_manifest",
    )?;
    Ok(Entry {
        mapping,
        policy: binding.policy.clone(),
        generation: Some(binding.generation.clone()),
        binding: Binding {
            device_id: device.into(),
            adapter_id: binding.policy.source.adapter_id.clone(),
            model_revision: manifest.model_revision,
            serial: coordinator.serial.clone(),
            target: manifest.target,
            manufacturer_code: manifest.manufacturer_code,
            signature: manifest.signature,
            timeout_ms: coordinator.timeout_ms,
            poll_interval_ms: coordinator.poll_interval_ms,
        },
    })
}
#[derive(Clone)]
pub struct Adapters {
    groups: Vec<Group>,
}

pub fn configured() -> Result<Adapters> {
    let file = match std::env::var("LIMEIOT_ZIGBEE_CONFIG") {
        Ok(path) => {
            ensure(Path::new(&path).is_absolute(), "invalid_zigbee_config")?;
            let bytes = std::fs::read(path).map_err(|_| err("invalid_zigbee_config"))?;
            let value = limeiot_core::validation::bounded_document(&bytes, 65_536, 12, 4096)
                .ok_or_else(|| err("invalid_zigbee_config"))?;
            serde_json::from_value::<File>(value).map_err(|_| err("invalid_zigbee_config"))?
        }
        Err(std::env::VarError::NotPresent) => File {
            schema_version: 1,
            bindings: vec![],
            coordinators: None,
            on_off_bindings: None,
        },
        Err(_) => return Err(err("invalid_zigbee_config")),
    };
    build(file)
}

fn build(file: File) -> Result<Adapters> {
    ensure(
        (((file.schema_version == 1 && file.coordinators.is_none())
            || (file.schema_version == 2
                && file
                    .coordinators
                    .as_ref()
                    .is_some_and(|items| !items.is_empty() && items.len() <= 4)))
            && file.on_off_bindings.is_none()
            || (file.schema_version == 3
                && file
                    .on_off_bindings
                    .as_ref()
                    .is_some_and(|items| !items.is_empty())
                && file
                    .coordinators
                    .as_ref()
                    .is_none_or(|items| !items.is_empty() && items.len() <= 4)))
            && file.bindings.len() + file.on_off_bindings.as_ref().map_or(0, Vec::len) <= 16,
        "invalid_zigbee_config",
    )?;
    let mut groups: BTreeMap<String, Group> = BTreeMap::new();
    let mut coordinators = BTreeMap::new();
    let mut devices = BTreeSet::new();
    let mut adapters = BTreeSet::new();
    let mut targets = BTreeSet::new();
    let bindings = file
        .bindings
        .into_iter()
        .map(|binding| (binding, Mapping::Environment))
        .chain(
            file.on_off_bindings
                .unwrap_or_default()
                .into_iter()
                .map(|binding| (binding, Mapping::OnOff)),
        );
    for (binding, mapping) in bindings {
        let (name, model) = match mapping {
            Mapping::Environment => ("znp-environment-v1", environment_model()?),
            Mapping::OnOff => ("znp-on-off-v1", on_off_model()?),
        };
        let model_revision = digest(&model)?;
        binding
            .target
            .validate()
            .map_err(|_| err("invalid_zigbee_config"))?;
        ensure(
            identifier(&binding.device_id)
                && devices.insert(binding.device_id.clone())
                && identifier(&binding.adapter_id)
                && adapters.insert(binding.adapter_id.clone())
                && binding.model_revision == model_revision
                && Path::new(&binding.serial).is_absolute()
                && binding.serial.len() <= 1024
                && !binding.serial.contains('\0')
                && (100..=30_000).contains(&binding.timeout_ms)
                && (1000..=10_000).contains(&binding.poll_interval_ms)
                && valid_signature(&binding.signature)
                && targets.insert((
                    binding.target.coordinator_ieee.clone(),
                    binding.target.ieee_address.clone(),
                    binding.target.endpoint,
                )),
            "invalid_zigbee_config",
        )?;
        if let Some(serial) = coordinators.insert(
            binding.target.coordinator_ieee.clone(),
            binding.serial.clone(),
        ) {
            ensure(serial == binding.serial, "conflicting_zigbee_coordinator")?;
        }
        if let Some(group) = groups.get(&binding.serial) {
            ensure(
                group.coordinator_ieee == binding.target.coordinator_ieee,
                "conflicting_zigbee_coordinator",
            )?;
        }
        // 串口路径与轮询策略可调整；能力映射与物理对象身份改变必须显式更换来源。
        let revision = digest(&json!({"mapping":name,"target":binding.target,
            "manufacturer_code":binding.manufacturer_code,"signature":binding.signature,"model_revision":model_revision}))?;
        let policy = Policy {
            device_id: binding.device_id.clone(),
            model_revision: model_revision.clone(),
            source: Route {
                adapter_id: binding.adapter_id.clone(),
                revision,
            },
        };
        groups
            .entry(binding.serial.clone())
            .or_insert_with(|| Group {
                serial: binding.serial.clone(),
                coordinator_ieee: binding.target.coordinator_ieee.clone(),
                coordinator: None,
                entries: vec![],
                queries: Arc::new(Queries::new()),
            })
            .entries
            .push(Entry {
                mapping,
                binding,
                policy,
                generation: None,
            });
    }
    let mut coordinator_ids = BTreeSet::new();
    let mut dynamic_ieees = BTreeSet::new();
    for coordinator in file.coordinators.unwrap_or_default() {
        ensure(
            identifier(&coordinator.coordinator_id)
                && coordinator_ids.insert(coordinator.coordinator_id.clone())
                && dynamic_ieees.insert(coordinator.coordinator_ieee.clone())
                && Path::new(&coordinator.serial).is_absolute()
                && coordinator.serial.len() <= 1024
                && !coordinator.serial.contains('\0')
                && (100..=30_000).contains(&coordinator.timeout_ms)
                && (1000..=10_000).contains(&coordinator.poll_interval_ms),
            "invalid_zigbee_config",
        )?;
        ensure(
            valid_ieee(&coordinator.coordinator_ieee),
            "invalid_zigbee_config",
        )?;
        if let Some(serial) = coordinators.insert(
            coordinator.coordinator_ieee.clone(),
            coordinator.serial.clone(),
        ) {
            ensure(
                serial == coordinator.serial,
                "conflicting_zigbee_coordinator",
            )?;
        }
        let group = groups
            .entry(coordinator.serial.clone())
            .or_insert_with(|| Group {
                serial: coordinator.serial.clone(),
                coordinator_ieee: coordinator.coordinator_ieee.clone(),
                coordinator: None,
                entries: vec![],
                queries: Arc::new(Queries::new()),
            });
        ensure(
            group.coordinator_ieee == coordinator.coordinator_ieee && group.coordinator.is_none(),
            "conflicting_zigbee_coordinator",
        )?;
        group.coordinator = Some(coordinator);
    }
    Ok(Adapters {
        groups: groups.into_values().collect(),
    })
}

impl Adapters {
    pub fn coordinators(&self) -> Result<Value> {
        let items = self
            .groups
            .iter()
            .filter_map(|group| group.coordinator.as_ref())
            .map(coordinator_view)
            .collect::<Result<Vec<_>>>()?;
        Ok(json!({"items":items,"next_cursor":null}))
    }

    pub async fn commission(
        &self,
        app: &App,
        request: crate::commissioning::Request,
    ) -> Result<crate::commissioning::Operation> {
        {
            let store = app.store.lock().await;
            ensure(store.data.space_id == request.space_id, "forbidden")?;
            if let Some(previous) = store.commissioning.get(&request.idempotency_key) {
                ensure(previous.request == request, "idempotency_conflict")?;
                return Ok(previous.clone());
            }
        }
        let group = self
            .groups
            .iter()
            .find(|group| {
                group.coordinator.as_ref().is_some_and(|coordinator| {
                    coordinator.coordinator_id == request.change.coordinator_id
                })
            })
            .ok_or_else(|| err("observation_coordinator_not_found"))?;
        let coordinator = coordinator_view(group.coordinator.as_ref().unwrap())?;
        let slot = group
            .queries
            .slot
            .clone()
            .try_acquire_owned()
            .map_err(|_| err("observation_query_busy"))?;
        let deadline = Instant::now() + Duration::from_millis(coordinator.timeout_ms);
        let key = request.idempotency_key.clone();
        let duration_seconds = request.change.duration_seconds;
        let (operation, created) =
            app.store
                .lock()
                .await
                .reserve_commissioning(request, coordinator, Utc::now())?;
        if !created {
            return Ok(operation);
        }
        let (sender, receiver) = oneshot::channel();
        let queued = group.queries.sender.try_send(Probe {
            request: ProbeRequest::Join {
                key: key.clone(),
                duration_seconds,
            },
            deadline,
            response: sender,
            _slot: slot,
        });
        if queued.is_err() {
            return app.store.lock().await.finish_commissioning(
                &key,
                Err(err("observation_query_unavailable")),
                Utc::now(),
            );
        }
        // 接收者超时或HTTP取消不拥有网络操作；串口actor仍负责保存最终回执。
        let _ = tokio::time::timeout_at(deadline, receiver).await;
        Ok(app
            .store
            .lock()
            .await
            .commissioning_operation(&key)?
            .clone())
    }

    pub fn list(&self) -> Result<Value> {
        let now = Utc::now();
        let mut candidates = vec![];
        let mut coordinators = vec![];
        for group in &self.groups {
            if let Some(coordinator) = &group.coordinator {
                coordinators.push(json!({"coordinator_id":coordinator.coordinator_id,"coordinator_ieee":coordinator.coordinator_ieee,
                    "timeout_ms":coordinator.timeout_ms,"protocol":"zigbee-znp"}));
            }
            let mut cache = group
                .queries
                .candidates
                .lock()
                .map_err(|_| err("observation_query_unavailable"))?;
            cache.retain(|_, candidate| candidate.expires_at > now && candidate.observed_at <= now);
            candidates.extend(cache.values().map(Candidate::view));
        }
        Ok(json!({"coordinators":coordinators,"items":candidates,"next_cursor":null}))
    }

    pub async fn query(&self, bytes: &[u8]) -> Result<Value> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Query {
            coordinator_id: String,
            ieee_address: String,
            endpoint: u8,
            #[serde(default)]
            profile: Option<String>,
        }
        let value = limeiot_core::validation::bounded_document(bytes, 4096, 4, 64)
            .ok_or_else(|| err("invalid_observation_query"))?;
        ensure(
            value
                .get("profile")
                .is_none_or(|profile| profile == "on_off"),
            "invalid_observation_query",
        )?;
        let query: Query =
            serde_json::from_value(value).map_err(|_| err("invalid_observation_query"))?;
        let mapping = match query.profile.as_deref() {
            None => Mapping::Environment,
            Some("on_off") => Mapping::OnOff,
            _ => return Err(err("invalid_observation_query")),
        };
        ensure(
            identifier(&query.coordinator_id),
            "invalid_observation_query",
        )?;
        let group =
            self.groups
                .iter()
                .find(|group| {
                    group.coordinator.as_ref().is_some_and(|coordinator| {
                        coordinator.coordinator_id == query.coordinator_id
                    })
                })
                .ok_or_else(|| err("observation_coordinator_not_found"))?;
        let coordinator = group.coordinator.as_ref().unwrap();
        let target = EnvironmentTarget {
            coordinator_ieee: coordinator.coordinator_ieee.clone(),
            ieee_address: query.ieee_address,
            endpoint: query.endpoint,
        };
        target
            .validate()
            .map_err(|_| err("invalid_observation_query"))?;
        ensure(!self.static_target(&target), "observation_target_in_use")?;
        dispatch(group, ProbeRequest::Candidate(target, mapping)).await
    }

    pub async fn discover(&self, bytes: &[u8], endpoints: bool) -> Result<Value> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct DiscoveryQuery {
            coordinator_id: String,
        }
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct InterviewQuery {
            coordinator_id: String,
            ieee_address: String,
        }
        let value = limeiot_core::validation::bounded_document(bytes, 4096, 4, 64)
            .ok_or_else(|| err("invalid_observation_query"))?;
        let (id, request) = if endpoints {
            let query: InterviewQuery =
                serde_json::from_value(value).map_err(|_| err("invalid_observation_query"))?;
            (
                query.coordinator_id,
                ProbeRequest::Interview(query.ieee_address),
            )
        } else {
            let query: DiscoveryQuery =
                serde_json::from_value(value).map_err(|_| err("invalid_observation_query"))?;
            (query.coordinator_id, ProbeRequest::Neighbors)
        };
        ensure(identifier(&id), "invalid_observation_query")?;
        let group = self
            .groups
            .iter()
            .find(|group| {
                group
                    .coordinator
                    .as_ref()
                    .is_some_and(|coordinator| coordinator.coordinator_id == id)
            })
            .ok_or_else(|| err("observation_coordinator_not_found"))?;
        if let ProbeRequest::Interview(ieee) = &request {
            InterviewTarget {
                coordinator_ieee: group.coordinator_ieee.clone(),
                ieee_address: ieee.clone(),
            }
            .validate()
            .map_err(|_| err("invalid_observation_query"))?;
        }
        dispatch(group, request).await
    }

    fn static_target(&self, target: &EnvironmentTarget) -> bool {
        self.groups.iter().any(|group| {
            group
                .entries
                .iter()
                .any(|entry| &entry.binding.target == target)
        })
    }

    pub fn offer(&self, source: &Route) -> Option<Offer> {
        self.groups.iter().find_map(|group| {
            let candidate = group
                .queries
                .candidates
                .lock()
                .ok()?
                .get(&source.adapter_id)?
                .clone();
            if candidate.source != *source || self.static_target(&candidate.manifest.target) {
                return None;
            }
            candidate.offer().ok()
        })
    }

    async fn entries(&self, app: &App, group: &Group) -> Vec<Entry> {
        let mut entries = group.entries.clone();
        if let Some(coordinator) = &group.coordinator {
            let store = app.store.lock().await;
            for (device, binding) in &store.data.observation_registry.bindings {
                if !binding.active
                    || binding.manifest["target"]["coordinator_ieee"]
                        != coordinator.coordinator_ieee
                {
                    continue;
                }
                match manifest_entry(device, binding, coordinator) {
                    Ok(entry) if !self.static_target(&entry.binding.target) => entries.push(entry),
                    _ => unavailable(&binding.policy, &err("invalid_zigbee_manifest")),
                }
            }
        }
        entries
    }

    pub fn policies(&self) -> Vec<Policy> {
        self.groups
            .iter()
            .flat_map(|group| {
                group
                    .entries
                    .iter()
                    .filter(|entry| entry.mapping == Mapping::Environment)
                    .map(|entry| entry.policy.clone())
            })
            .collect()
    }
    pub fn property_bridges(&self) -> Vec<limeiot_core::property_bridge::Policy> {
        self.groups
            .iter()
            .flat_map(|group| {
                group
                    .entries
                    .iter()
                    .filter(|entry| entry.mapping == Mapping::OnOff)
                    .map(|entry| limeiot_core::property_bridge::Policy {
                        observation: entry.policy.clone(),
                        write_paths: ["light.power".into()].into(),
                    })
            })
            .collect()
    }
    pub fn identifiers(&self) -> impl Iterator<Item = (&str, &str)> {
        self.groups.iter().flat_map(|group| {
            group.entries.iter().map(|entry| {
                (
                    entry.policy.device_id.as_str(),
                    entry.policy.source.adapter_id.as_str(),
                )
            })
        })
    }
}

fn coordinator_view(coordinator: &Coordinator) -> Result<crate::commissioning::Coordinator> {
    Ok(crate::commissioning::Coordinator {
        coordinator_id: coordinator.coordinator_id.clone(),
        coordinator_ieee: coordinator.coordinator_ieee.clone(),
        revision: digest(&("zigbee-coordinator-v1", coordinator))?,
        timeout_ms: coordinator.timeout_ms,
    })
}

async fn dispatch(group: &Group, request: ProbeRequest) -> Result<Value> {
    let coordinator = group
        .coordinator
        .as_ref()
        .ok_or_else(|| err("observation_coordinator_not_found"))?;
    let slot = group
        .queries
        .slot
        .clone()
        .try_acquire_owned()
        .map_err(|_| err("observation_query_busy"))?;
    let (sender, receiver) = oneshot::channel();
    let deadline = Instant::now() + Duration::from_millis(coordinator.timeout_ms);
    group
        .queries
        .sender
        .try_send(Probe {
            request,
            deadline,
            response: sender,
            _slot: slot,
        })
        .map_err(|_| err("observation_query_unavailable"))?;
    tokio::time::timeout_at(deadline, receiver)
        .await
        .map_err(|_| err("observation_query_timeout"))?
        .map_err(|_| err("observation_query_unavailable"))?
}

enum Reading {
    Environment(EnvironmentReading),
    OnOff(OnOffReading),
}

fn snapshot(entry: &Entry, reading: Reading, sequence: u64) -> Result<Snapshot> {
    let reading = match reading {
        Reading::Environment(reading) => reading,
        Reading::OnOff(reading) => {
            ensure(
                reading.signature == entry.binding.signature
                    && reading.manufacturer_code == entry.binding.manufacturer_code,
                "zigbee_signature_mismatch",
            )?;
            return Ok(Snapshot {
                sequence,
                samples: vec![Sample {
                    path: "light.power".into(),
                    value: json!(reading.power.value),
                    unit: None,
                    observed_at: measurement_time(reading.power.received_at_unix_ms)?,
                }],
            });
        }
    };
    ensure(
        reading.signature == entry.binding.signature
            && reading.manufacturer_code == entry.binding.manufacturer_code,
        "zigbee_signature_mismatch",
    )?;
    Ok(Snapshot {
        sequence,
        samples: vec![
            Sample {
                path: "environment.temperature".into(),
                value: json!(reading.temperature_celsius_x100.value),
                unit: Some("celsius_x100".into()),
                observed_at: measurement_time(
                    reading.temperature_celsius_x100.received_at_unix_ms,
                )?,
            },
            Sample {
                path: "environment.humidity".into(),
                value: json!(reading.humidity_percent_x100.value),
                unit: Some("percent_x100".into()),
                observed_at: measurement_time(reading.humidity_percent_x100.received_at_unix_ms)?,
            },
        ],
    })
}

fn measurement_time(value: u64) -> Result<DateTime<Utc>> {
    i64::try_from(value)
        .ok()
        .and_then(DateTime::from_timestamp_millis)
        .ok_or_else(|| err("observation_time_invalid"))
}

fn check_generation(data: &Data, entry: &Entry) -> Result<()> {
    if let Some(generation) = &entry.generation {
        ensure(
            data.observation_registry
                .bindings
                .get(&entry.policy.device_id)
                .is_some_and(|binding| {
                    binding.active
                        && binding.generation == *generation
                        && binding.policy == entry.policy
                }),
            "observation_source_changed",
        )?;
    }
    Ok(())
}

async fn begin(app: &App, entry: &Entry) -> Result<String> {
    let mut token = None;
    // 事件只写设备标识；原来源token不通过Store输出进入事件表。
    app.update("observation.started", |data| {
        check_generation(data, entry)?;
        let now = DateTime::from_timestamp_millis(Utc::now().timestamp_millis())
            .ok_or_else(|| err("observation_time_invalid"))?;
        token = Some(data.begin_observation(&entry.policy, now)?);
        Ok(json!({"device_id":entry.policy.device_id}))
    })
    .await?;
    token.ok_or_else(|| err("observation_session_closed"))
}

struct Source {
    token: Option<String>,
    sequence: u64,
    due: Instant,
}

async fn end(app: &App, entry: &Entry, source: &mut Source) {
    source.sequence = 0;
    if let Some(token) = source.token.take() {
        if let Err(error) = app
            .update("observation.closed", |data| {
                data.end_observation(&entry.policy, &token)?;
                Ok(json!({"device_id":entry.policy.device_id}))
            })
            .await
        {
            unavailable(&entry.policy, &error);
        }
    }
}

fn unavailable(policy: &Policy, error: &limeiot_core::Error) {
    eprintln!(
        "{}",
        json!({"event":"zigbee.observation_unavailable","adapter_id":policy.source.adapter_id,"error":error.code})
    );
}

fn shared_failure(error: &limeiot_zigbee_znp::Error) -> bool {
    // 只有明确属于当前目标的失败保留其他来源；共享传输或身份不明的错误整组失效。
    !matches!(
        error,
        limeiot_zigbee_znp::Error::Timeout
            | limeiot_zigbee_znp::Error::DeviceRejected(_)
            | limeiot_zigbee_znp::Error::ProfileUnsupported
            | limeiot_zigbee_znp::Error::ZclRejected(_)
            | limeiot_zigbee_znp::Error::DeliveryFailed(_)
            | limeiot_zigbee_znp::Error::SignatureMismatch
    )
}

struct Active {
    entry: Entry,
    source: Source,
}

async fn refresh(
    app: &App,
    adapters: &Adapters,
    group: &Group,
    active: &mut BTreeMap<String, Active>,
) {
    let desired: BTreeMap<_, _> = adapters
        .entries(app, group)
        .await
        .into_iter()
        .map(|entry| (entry.policy.device_id.clone(), entry))
        .collect();
    let removed: Vec<_> = active
        .iter()
        .filter(|(key, item)| {
            desired.get(*key).is_none_or(|entry| {
                entry.policy != item.entry.policy || entry.generation != item.entry.generation
            })
        })
        .map(|(key, _)| key.clone())
        .collect();
    for key in removed {
        let mut item = active.remove(&key).unwrap();
        end(app, &item.entry, &mut item.source).await;
    }
    for (key, entry) in desired {
        active.entry(key).or_insert_with(|| Active {
            entry,
            source: Source {
                token: None,
                sequence: 0,
                due: Instant::now(),
            },
        });
    }
}

async fn end_all(app: &App, active: &mut BTreeMap<String, Active>) {
    for item in active.values_mut() {
        end(app, &item.entry, &mut item.source).await;
        item.source.due = Instant::now() + Duration::from_secs(1);
    }
}

fn transport<'a>(
    group: &Group,
    session: &'a mut Option<Session<Serial>>,
    reads: &mut usize,
) -> limeiot_zigbee_znp::Result<&'a mut Session<Serial>> {
    // AF容量属于串口会话；查询与轮询共用预算，正常轮换保留健康来源的基线。
    if *reads == 85 {
        *session = None;
    }
    if session.is_none() {
        *session = Some(Session::new(Serial::open(Path::new(&group.serial))?));
        *reads = 0;
    }
    Ok(session.as_mut().unwrap())
}

async fn read(
    group: &Group,
    session: &mut Option<Session<Serial>>,
    reads: &mut usize,
    target: &EnvironmentTarget,
    deadline: Instant,
) -> limeiot_zigbee_znp::Result<EnvironmentReading> {
    let result = transport(group, session, reads)?
        .read_environment(target, deadline)
        .await;
    if result.is_ok() {
        *reads += 1;
    } else {
        *session = None;
    }
    result
}

async fn read_entry(
    group: &Group,
    session: &mut Option<Session<Serial>>,
    reads: &mut usize,
    entry: &Entry,
    deadline: Instant,
) -> limeiot_zigbee_znp::Result<Reading> {
    read_mapping(
        group,
        session,
        reads,
        &entry.binding.target,
        entry.mapping,
        deadline,
    )
    .await
}

async fn read_mapping(
    group: &Group,
    session: &mut Option<Session<Serial>>,
    reads: &mut usize,
    target: &EnvironmentTarget,
    mapping: Mapping,
    deadline: Instant,
) -> limeiot_zigbee_znp::Result<Reading> {
    if mapping == Mapping::Environment {
        return read(group, session, reads, target, deadline)
            .await
            .map(Reading::Environment);
    }
    let result = transport(group, session, reads)?
        .read_on_off(target, deadline)
        .await;
    if result.is_ok() {
        *reads += 1;
    } else {
        *session = None;
    }
    result.map(Reading::OnOff)
}

/// 与采样和入网共用唯一串口；先提交原命令意图，再单次发送。
async fn execute_pending(
    app: &App,
    group: &Group,
    active: &mut BTreeMap<String, Active>,
    session: &mut Option<Session<Serial>>,
    reads: &mut usize,
) -> bool {
    let entries: Vec<_> = active
        .values()
        .filter(|item| item.entry.mapping == Mapping::OnOff)
        .map(|item| item.entry.clone())
        .collect();
    for entry in entries {
        let now = Utc::now();
        let pending = app
            .store
            .lock()
            .await
            .data
            .commands
            .values()
            .any(|command| {
                command.execution_route.as_ref() == Some(&entry.policy.source)
                    && (command.status == "accepted"
                        || (command.status == "dispatched" && command.request.expires_at <= now))
            });
        if !pending {
            continue;
        }
        let commands = match app
            .update("command.dispatched", |data| {
                Ok(data.prepare_adapter_dispatch(&entry.policy.source.adapter_id, now))
            })
            .await
        {
            Ok(commands) => commands,
            Err(error) => {
                unavailable(&entry.policy, &error);
                continue;
            }
        };
        if let Some(command) = commands.into_iter().next() {
            let request = {
                let store = app.store.lock().await;
                store
                    .data
                    .recheck_adapter_dispatch(&command, Utc::now())
                    .and_then(|()| {
                        ensure(
                            command.request.operation.kind == "property.set"
                                && command.request.operation.path == "light.power"
                                && command.execution_route.as_ref() == Some(&entry.policy.source),
                            "execution_source_mismatch",
                        )?;
                        Ok(OnOffCommandTarget {
                            target: entry.binding.target.clone(),
                            manufacturer_code: entry.binding.manufacturer_code,
                            signature: entry.binding.signature.clone(),
                            power: command
                                .request
                                .operation
                                .value
                                .as_bool()
                                .ok_or_else(|| err("invalid_value"))?,
                        })
                    })
            };
            let remaining = (command.request.expires_at - Utc::now())
                .to_std()
                .unwrap_or_default();
            let result = match request {
                Ok(request) if !remaining.is_zero() => match transport(group, session, reads) {
                    Ok(transport) => {
                        transport
                            .set_on_off(
                                &request,
                                Instant::now()
                                    + remaining
                                        .min(Duration::from_millis(entry.binding.timeout_ms)),
                            )
                            .await
                    }
                    Err(error) => Err(error),
                },
                _ => Err(limeiot_zigbee_znp::Error::InvalidInput),
            };
            let shared = result.as_ref().err().is_some_and(shared_failure);
            let accepted = result.is_ok();
            if accepted {
                *reads += 1;
            } else {
                *session = None;
            }
            let now = Utc::now();
            let receipt = AdapterReceipt {
                command_id: command.command_id.clone(),
                route: entry.policy.source.clone(),
                session_id: command.envelope.session_id.clone().unwrap_or_default(),
                request_digest: command.request_digest.clone(),
                status: if accepted {
                    "protocol_accepted"
                } else {
                    "unknown"
                }
                .into(),
                error: (!accepted).then(|| "execution_unknown".into()),
                observed_at: now,
            };
            if let Err(error) = app
                .update("command.adapter_result", |data| {
                    match data.apply_property_adapter_result(receipt.clone(), now) {
                        Err(_) if accepted => {
                            let mut unknown = receipt.clone();
                            unknown.status = "unknown".into();
                            unknown.error = Some("execution_unknown".into());
                            data.apply_property_adapter_result(unknown, now)
                        }
                        result => result,
                    }
                })
                .await
            {
                unavailable(&entry.policy, &error);
            }
            if shared {
                end_all(app, active).await;
            } else if let Some(item) = active.get_mut(&entry.policy.device_id) {
                if !accepted {
                    end(app, &entry, &mut item.source).await;
                }
                // 协议受理后立即独立读取，不用请求值填充状态。
                item.source.due = Instant::now();
            }
            return true;
        }
    }
    false
}

fn candidate(group: &Group, target: EnvironmentTarget, reading: Reading) -> Result<Value> {
    let (mapping, coordinator_ieee, ieee_address, endpoint, manufacturer_code, signature) =
        match reading {
            Reading::Environment(r) => (
                Mapping::Environment,
                r.coordinator_ieee,
                r.ieee_address,
                r.endpoint,
                r.manufacturer_code,
                r.signature,
            ),
            Reading::OnOff(r) => (
                Mapping::OnOff,
                r.coordinator_ieee,
                r.ieee_address,
                r.endpoint,
                r.manufacturer_code,
                r.signature,
            ),
        };
    ensure(
        valid_signature(&signature)
            && coordinator_ieee == target.coordinator_ieee
            && ieee_address == target.ieee_address
            && endpoint == target.endpoint,
        "invalid_zigbee_manifest",
    )?;
    let manifest = Manifest {
        mapping: mapping.name().into(),
        target: target.clone(),
        manufacturer_code,
        signature,
        model_revision: digest(&mapping.model()?)?,
    };
    let now = Utc::now();
    let candidate = Candidate {
        source: Route {
            adapter_id: source_id(&target)?,
            revision: digest(&manifest)?,
        },
        manifest,
        observed_at: now,
        expires_at: now + chrono::Duration::seconds(60),
    };
    let mut cache = group
        .queries
        .candidates
        .lock()
        .map_err(|_| err("observation_query_unavailable"))?;
    cache.retain(|_, candidate| candidate.expires_at > now && candidate.observed_at <= now);
    ensure(
        cache.len() < 16 || cache.contains_key(&candidate.source.adapter_id),
        "observation_candidate_capacity",
    )?;
    let view = candidate.view();
    cache.insert(candidate.source.adapter_id.clone(), candidate);
    Ok(view)
}

async fn probe_read(
    group: &Group,
    request: ProbeRequest,
    session: &mut Option<Session<Serial>>,
    reads: &mut usize,
    deadline: Instant,
) -> limeiot_zigbee_znp::Result<ProbeResult> {
    match request {
        ProbeRequest::Candidate(target, mapping) => {
            read_mapping(group, session, reads, &target, mapping, deadline)
                .await
                .map(|reading| ProbeResult::Candidate(target, reading))
        }
        ProbeRequest::Neighbors => transport(group, session, reads)?
            .neighbors(
                &DiscoveryTarget {
                    coordinator_ieee: group.coordinator_ieee.clone(),
                },
                deadline,
            )
            .await
            .map(ProbeResult::Neighbors),
        ProbeRequest::Interview(ieee_address) => transport(group, session, reads)?
            .interview_ieee(
                &InterviewTarget {
                    coordinator_ieee: group.coordinator_ieee.clone(),
                    ieee_address,
                },
                deadline,
            )
            .await
            .map(ProbeResult::Interview),
        ProbeRequest::Join {
            duration_seconds, ..
        } => transport(group, session, reads)?
            .permit_join(
                &JoinWindowTarget {
                    coordinator_ieee: group.coordinator_ieee.clone(),
                    duration_seconds,
                },
                deadline,
            )
            .await
            .map(ProbeResult::Join),
    }
}

async fn probe(
    app: &App,
    group: &Group,
    job: Probe,
    session: &mut Option<Session<Serial>>,
    reads: &mut usize,
    active: &mut BTreeMap<String, Active>,
) {
    let join_key = match &job.request {
        ProbeRequest::Join { key, .. } => Some(key.clone()),
        _ => None,
    };
    if join_key.is_none() && (job.response.is_closed() || job.deadline <= Instant::now()) {
        return;
    }
    let result = match probe_read(group, job.request, session, reads, job.deadline).await {
        Ok(ProbeResult::Join(window)) => Ok(json!(crate::commissioning::Receipt {
            coordinator_ieee: window.coordinator_ieee,
            duration_seconds: window.duration_seconds,
            observed_at: Utc::now(),
        })),
        Ok(ProbeResult::Candidate(target, reading)) => candidate(group, target, reading),
        Ok(found) => {
            let coordinator = group.coordinator.as_ref().unwrap();
            let now = Utc::now();
            let mut view = json!({"coordinator_id":coordinator.coordinator_id,
                "coordinator_ieee":group.coordinator_ieee,"observed_at":now,
                "expires_at":now + chrono::Duration::seconds(60),
                "protocol":"zigbee-znp","evidence":"unauthenticated_protocol"});
            match found {
                ProbeResult::Neighbors(neighbors) => {
                    view["scope"] = json!(neighbors.scope);
                    view["items"] = json!(neighbors.items);
                }
                ProbeResult::Interview(interview) => {
                    view["ieee_address"] = json!(interview.ieee_address);
                    view["network_address"] = json!(interview.network_address);
                    view["manufacturer_code"] = json!(interview.node.manufacturer_code);
                    view["endpoints"] = json!(interview.endpoints);
                }
                ProbeResult::Candidate(_, _) | ProbeResult::Join(_) => unreachable!(),
            }
            Ok(view)
        }
        Err(error) => {
            *session = None;
            if shared_failure(&error) {
                end_all(app, active).await;
            }
            let code = if matches!(error, limeiot_zigbee_znp::Error::Timeout) {
                "observation_query_timeout".into()
            } else {
                error.to_string()
            };
            Err(err(&code))
        }
    };
    let result = if let Some(key) = join_key {
        let receipt = result.and_then(|value| {
            serde_json::from_value(value).map_err(|_| err("invalid_zigbee_receipt"))
        });
        let operation = app
            .store
            .lock()
            .await
            .finish_commissioning(&key, receipt, Utc::now());
        let _ = app.bus.send(());
        operation.map(|value| json!(value))
    } else {
        result
    };
    let _ = job.response.send(result);
}

async fn group(app: App, group: Group, adapters: Adapters) {
    let Some(mut queries) = group
        .queries
        .receiver
        .lock()
        .ok()
        .and_then(|mut receiver| receiver.take())
    else {
        return;
    };
    let mut active = BTreeMap::new();
    let mut changes = app.bus.subscribe();
    let mut cursor = 0;
    let mut session = None;
    let mut reads = 0;
    let mut last_probe = false;
    let mut last_write = false;
    loop {
        refresh(&app, &adapters, &group, &mut active).await;
        let keys: Vec<_> = active.keys().cloned().collect();
        let due = (0..keys.len())
            .map(|offset| (cursor + offset) % keys.len())
            .find(|index| active[&keys[*index]].source.due <= Instant::now());
        if (!last_write || due.is_none())
            && execute_pending(&app, &group, &mut active, &mut session, &mut reads).await
        {
            last_write = true;
            continue;
        }
        // 查询之间至少服务一个到期轮询，避免连续查询饿死已绑定设备。
        if !last_probe || due.is_none() {
            if let Ok(job) = queries.try_recv() {
                probe(&app, &group, job, &mut session, &mut reads, &mut active).await;
                last_probe = true;
                continue;
            }
        }
        let Some(index) = due else {
            let wake = active
                .values()
                .map(|item| item.source.due)
                .min()
                .unwrap_or_else(|| Instant::now() + Duration::from_secs(60));
            let job = tokio::select! {
                job = queries.recv() => job,
                _ = tokio::time::sleep_until(wake) => None,
                _ = changes.recv() => None,
            };
            if let Some(job) = job {
                probe(&app, &group, job, &mut session, &mut reads, &mut active).await;
                last_probe = true;
            }
            continue;
        };
        cursor = (index + 1) % keys.len();
        last_probe = false;
        last_write = false;
        let key = &keys[index];
        let item = active.get_mut(key).unwrap();
        let entry = item.entry.clone();
        if item.source.token.is_none() {
            match begin(&app, &entry).await {
                Ok(token) => item.source.token = Some(token),
                Err(error) => {
                    unavailable(&entry.policy, &error);
                    item.source.due = Instant::now() + Duration::from_secs(1);
                    continue;
                }
            }
        }
        let sequence = item.source.sequence + 1;
        let token = item.source.token.as_ref().unwrap().clone();
        let result = match read_entry(
            &group,
            &mut session,
            &mut reads,
            &entry,
            Instant::now() + Duration::from_millis(entry.binding.timeout_ms),
        )
        .await
        {
            Ok(reading) => match snapshot(&entry, reading, sequence) {
                Ok(snapshot) => {
                    app.update("observation.received", |data| {
                        check_generation(data, &entry)?;
                        data.observe(&entry.policy, &token, snapshot, Utc::now())
                    })
                    .await
                }
                Err(error) => Err(error),
            },
            Err(error) => {
                if shared_failure(&error) {
                    end_all(&app, &mut active).await;
                }
                Err(err(&error.to_string()))
            }
        };
        let item = active.get_mut(key).unwrap();
        match result {
            Ok(_) => {
                item.source.sequence += 1;
                item.source.due =
                    Instant::now() + Duration::from_millis(entry.binding.poll_interval_ms);
            }
            Err(error) => {
                unavailable(&entry.policy, &error);
                end(&app, &entry, &mut item.source).await;
                item.source.due = Instant::now() + Duration::from_secs(1);
            }
        }
    }
}

pub async fn run(app: App, adapters: Adapters) {
    let mut tasks = JoinSet::new();
    for entry in &adapters.groups {
        tasks.spawn(group(app.clone(), entry.clone(), adapters.clone()));
    }
    super::run_owned_tasks(&app, tasks).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    fn file() -> File {
        let model: limeiot_core::model::Model = serde_json::from_str(include_str!(
            "../../../../../contracts/models/environment.json"
        ))
        .unwrap();
        serde_json::from_value(json!({"schema_version":1,"bindings":[{"device_id":"sensor","adapter_id":"znp-sensor","model_revision":digest(&model).unwrap(),
            "serial":"/dev/ttyUSB0","target":{"coordinator_ieee":"0102030405060708","ieee_address":"1122334455667788","endpoint":1},
            "manufacturer_code":4660,"signature":{"manufacturer":"LimeIoT","model":"Environment-1","application_version":2,"hardware_version":1},"timeout_ms":5000,"poll_interval_ms":2000}]})).unwrap()
    }
    fn coordinator_file() -> File {
        let mut file = file();
        let binding = file.bindings.remove(0);
        file.schema_version = 2;
        file.coordinators = Some(vec![Coordinator {
            coordinator_id: "home-znp".into(),
            serial: binding.serial,
            coordinator_ieee: binding.target.coordinator_ieee,
            timeout_ms: 1000,
            poll_interval_ms: 1000,
        }]);
        file
    }

    #[test]
    fn coordinator_only_installations_need_no_logical_device_or_changed_static_policy_hash() {
        let adapters = build(coordinator_file()).unwrap();
        assert_eq!(adapters.groups.len(), 1);
        assert!(adapters.policies().is_empty());
        assert!(adapters.groups[0].entries.is_empty());
        let list = adapters.list().unwrap();
        assert_eq!(list["coordinators"][0]["coordinator_id"], "home-znp");
        assert_eq!(list["items"], json!([]));
        assert!(!list.to_string().contains("/dev/"));
        let mut mixed = coordinator_file();
        mixed.bindings = file().bindings;
        let adapters = build(mixed).unwrap();
        assert_eq!(adapters.groups.len(), 1);
        assert_eq!(adapters.policies().len(), 1);
        assert_eq!(adapters.groups[0].entries.len(), 1);
    }

    #[test]
    fn coordinator_identity_ids_paths_and_version_boundaries_are_unambiguous() {
        for mode in [
            "legacy",
            "missing",
            "empty",
            "duplicate-id",
            "duplicate-ieee",
            "same-port-other-ieee",
            "other-port-same-ieee",
            "bad-ieee",
            "relative-path",
        ] {
            let mut file = coordinator_file();
            match mode {
                "legacy" => file.schema_version = 1,
                "missing" => file.coordinators = None,
                "empty" => file.coordinators = Some(vec![]),
                "bad-ieee" => {
                    file.coordinators.as_mut().unwrap()[0].coordinator_ieee =
                        "ffffffffffffffff".into()
                }
                "relative-path" => file.coordinators.as_mut().unwrap()[0].serial = "ttyUSB0".into(),
                _ => {
                    let first = &file.coordinators.as_ref().unwrap()[0];
                    let mut second = first.clone();
                    match mode {
                        "duplicate-id" => {
                            second.serial = "/dev/ttyUSB1".into();
                            second.coordinator_ieee = "0102030405060709".into();
                        }
                        "duplicate-ieee" => second.coordinator_id = "other".into(),
                        "same-port-other-ieee" => {
                            second.coordinator_id = "other".into();
                            second.coordinator_ieee = "0102030405060709".into();
                        }
                        "other-port-same-ieee" => {
                            file.bindings = self::file().bindings;
                            second.serial = "/dev/ttyUSB1".into();
                            file.coordinators = Some(vec![]);
                        }
                        _ => unreachable!(),
                    }
                    file.coordinators.as_mut().unwrap().push(second);
                }
            }
            assert!(build(file).is_err(), "{mode}");
        }
    }

    #[tokio::test]
    async fn query_rejects_client_ports_extra_fields_static_aliases_and_busy_groups_before_io() {
        let adapters = build(coordinator_file()).unwrap();
        for input in [
            json!({"coordinator_id":"absent","ieee_address":"1122334455667788","endpoint":1}),
            json!({"coordinator_id":"home-znp","ieee_address":"ffffffffffffffff","endpoint":1}),
            json!({"coordinator_id":"home-znp","ieee_address":"1122334455667788","endpoint":0}),
            json!({"coordinator_id":"home-znp","ieee_address":"1122334455667788","endpoint":1,"serial":"/dev/ttyUSB1"}),
        ] {
            assert!(adapters
                .query(&serde_json::to_vec(&input).unwrap())
                .await
                .is_err());
        }
        let input = serde_json::to_vec(
            &json!({"coordinator_id":"home-znp","ieee_address":"1122334455667788","endpoint":1}),
        )
        .unwrap();
        let permit = adapters.groups[0]
            .queries
            .slot
            .clone()
            .try_acquire_owned()
            .unwrap();
        assert_eq!(
            adapters.query(&input).await.unwrap_err().code,
            "observation_query_busy"
        );
        drop(permit);
        let mut mixed = coordinator_file();
        mixed.bindings = file().bindings;
        assert_eq!(
            build(mixed).unwrap().query(&input).await.unwrap_err().code,
            "observation_target_in_use"
        );
    }

    #[test]
    fn persisted_protocol_manifests_and_generation_are_rechecked_before_polling() {
        use limeiot_core::{
            engine::Config,
            observation_binding::{Change, Request},
        };
        let adapters = build(coordinator_file()).unwrap();
        let coordinator = adapters.groups[0].coordinator.as_ref().unwrap();
        let static_binding = file().bindings.remove(0);
        let manifest = Manifest {
            mapping: "znp-environment-v1".into(),
            target: static_binding.target,
            manufacturer_code: static_binding.manufacturer_code,
            signature: static_binding.signature,
            model_revision: static_binding.model_revision,
        };
        let now = Utc::now();
        let candidate = Candidate {
            source: Route {
                adapter_id: source_id(&manifest.target).unwrap(),
                revision: digest(&manifest).unwrap(),
            },
            manifest,
            observed_at: now,
            expires_at: now + chrono::Duration::seconds(60),
        };
        let config: Config =
            serde_json::from_str(include_str!("../../../../../deploy/dev/config.json")).unwrap();
        let mut data = Data::new(config).unwrap();
        let change = Change::Bind {
            device_id: "dynamic".into(),
            source: candidate.source.clone(),
            expected_binding_revision: data.observation_binding("dynamic").unwrap().revision,
            expected_model_revision: candidate.manifest.model_revision.clone(),
        };
        data.apply_observation_change(
            Request {
                space_id: data.space_id.clone(),
                idempotency_key: "first".into(),
                change,
            },
            Some(&candidate.offer().unwrap()),
            now,
        )
        .unwrap();
        let binding = data.observation_registry.bindings["dynamic"].clone();
        let entry = manifest_entry("dynamic", &binding, coordinator).unwrap();
        check_generation(&data, &entry).unwrap();
        for mode in ["port", "mapping", "source", "model"] {
            let mut changed = binding.clone();
            match mode {
                "port" => changed.manifest["serial"] = json!("/dev/ttyUSB1"),
                "mapping" => changed.manifest["mapping"] = json!("unknown-v1"),
                "source" => changed.policy.source.adapter_id = "alias".into(),
                "model" => changed.policy.model_revision = format!("sha256:{}", "0".repeat(64)),
                _ => unreachable!(),
            }
            assert!(
                manifest_entry("dynamic", &changed, coordinator).is_err(),
                "{mode}"
            );
        }
        data.observation_registry
            .bindings
            .get_mut("dynamic")
            .unwrap()
            .generation = "other-generation".into();
        assert_eq!(
            check_generation(&data, &entry).unwrap_err().code,
            "observation_source_changed"
        );
        data.observation_registry
            .bindings
            .get_mut("dynamic")
            .unwrap()
            .active = false;
        assert!(check_generation(&data, &entry).is_err());
    }
    #[test]
    fn physical_identity_and_exact_mapping_are_stable_across_serial_and_poll_changes() {
        let original = build(file()).unwrap().policies();
        let mut changed = file();
        changed.bindings[0].serial = "/dev/serial/by-id/new-port".into();
        changed.bindings[0].poll_interval_ms = 3000;
        changed.bindings[0].timeout_ms = 6000;
        assert_eq!(build(changed).unwrap().policies(), original);
        for change in ["manufacturer", "target"] {
            let mut changed = file();
            if change == "manufacturer" {
                changed.bindings[0].signature.manufacturer = "Other".into();
            } else {
                changed.bindings[0].target.ieee_address = "1122334455667789".into();
            }
            assert_ne!(build(changed).unwrap().policies(), original);
        }
    }
    #[test]
    fn one_serial_owner_groups_devices_and_conflicting_identity_or_mapping_is_rejected() {
        let mut valid = file();
        let mut second = valid.bindings[0].clone();
        second.device_id = "sensor2".into();
        second.adapter_id = "znp-sensor2".into();
        second.target.ieee_address = "1122334455667789".into();
        valid.bindings.push(second);
        let adapters = build(valid.clone()).unwrap();
        assert_eq!(adapters.groups.len(), 1);
        assert_eq!(adapters.policies().len(), 2);
        let mut invalid = valid.clone();
        invalid.bindings[1].serial = "/dev/ttyUSB1".into();
        assert!(build(invalid).is_err());
        let mut invalid = valid.clone();
        invalid.bindings[1].target.coordinator_ieee = "0102030405060709".into();
        assert!(build(invalid).is_err());
        let mut invalid = valid;
        invalid.bindings[1].target = invalid.bindings[0].target.clone();
        assert!(build(invalid).is_err());
        let mut invalid = file();
        invalid.bindings[0].signature.model = " ".into();
        assert!(build(invalid).is_err());
        let mut invalid = file();
        invalid.bindings[0].model_revision = format!("sha256:{}", "0".repeat(64));
        assert!(build(invalid).is_err());
    }

    #[test]
    fn mixed_on_off_and_environment_share_one_owner_with_separate_explicit_authority() {
        let mut mixed = file();
        mixed.schema_version = 3;
        let mut switch = mixed.bindings[0].clone();
        switch.device_id = "switch".into();
        switch.adapter_id = "znp-switch".into();
        switch.target.ieee_address = "1122334455667789".into();
        switch.model_revision = digest(&on_off_model().unwrap()).unwrap();
        switch.signature.model = "Switch-1".into();
        mixed.on_off_bindings = Some(vec![switch]);
        let adapters = build(mixed.clone()).unwrap();
        assert_eq!(adapters.groups.len(), 1);
        assert_eq!(adapters.policies().len(), 1);
        assert_eq!(adapters.property_bridges().len(), 1);
        assert_eq!(
            adapters.property_bridges()[0].write_paths,
            ["light.power".into()].into()
        );
        let data: limeiot_core::engine::Config = serde_json::from_value(json!({"space_id":"home",
            "models":[environment_model().unwrap(), on_off_model().unwrap()],
            "devices":[{"device_id":"sensor","model_revision":digest(&environment_model().unwrap()).unwrap()},
                {"device_id":"switch","model_revision":digest(&on_off_model().unwrap()).unwrap()}]})).unwrap();
        Data::new(data)
            .unwrap()
            .with_observation_sources(&adapters.policies())
            .unwrap()
            .with_property_bridges(&adapters.property_bridges())
            .unwrap()
            .restore_observation_bindings()
            .unwrap();
        for mode in [
            "legacy",
            "duplicate-target",
            "wrong-model",
            "adapter-collision",
        ] {
            let mut invalid = mixed.clone();
            match mode {
                "legacy" => invalid.schema_version = 1,
                "duplicate-target" => {
                    invalid.on_off_bindings.as_mut().unwrap()[0].target =
                        invalid.bindings[0].target.clone()
                }
                "wrong-model" => {
                    invalid.on_off_bindings.as_mut().unwrap()[0].model_revision =
                        invalid.bindings[0].model_revision.clone()
                }
                "adapter-collision" => {
                    invalid.on_off_bindings.as_mut().unwrap()[0].adapter_id =
                        invalid.bindings[0].adapter_id.clone()
                }
                _ => unreachable!(),
            }
            assert!(build(invalid).is_err(), "{mode}");
        }
    }
}
