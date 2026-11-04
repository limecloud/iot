//! 明确授权的观测及属性桥接绑定；协议清单由宿主提供，领域不解释协议字段或访问外部资源。
use crate::{
    digest,
    engine::{Data, Device},
    ensure, err,
    execution::Route,
    id, identifier,
    model::Model,
    observation::Policy,
    validation::bounded_document,
    Result,
};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

pub const MAX_BINDINGS: usize = 16;
pub const MAX_OPERATIONS: usize = 256;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Registry {
    pub bindings: BTreeMap<String, Binding>,
    pub operations: BTreeMap<String, Operation>,
}
impl Registry {
    pub fn is_empty(&self) -> bool {
        self.bindings.is_empty() && self.operations.is_empty()
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Binding {
    pub policy: Policy,
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub write_paths: BTreeSet<String>,
    pub manifest: Value,
    pub active: bool,
    pub generation: String,
    pub changed_at: DateTime<Utc>,
}
impl Binding {
    fn bridge(&self) -> Option<crate::property_bridge::Policy> {
        (!self.write_paths.is_empty()).then(|| crate::property_bridge::Policy {
            observation: self.policy.clone(),
            write_paths: self.write_paths.clone(),
        })
    }
    fn routes(&self) -> BTreeMap<String, Route> {
        self.bridge()
            .filter(|_| self.active)
            .map_or_else(BTreeMap::new, |bridge| bridge.routes())
    }
    fn validate_model(&self, model: &Model) -> Result<()> {
        match self.bridge() {
            Some(bridge) => bridge.validate_model(model),
            None => crate::observation::validate_model(model),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct View {
    pub device_id: String,
    pub revision: String,
    pub binding: Option<Binding>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "type", deny_unknown_fields)]
pub enum Change {
    #[serde(rename = "sources.bind")]
    Bind {
        device_id: String,
        source: Route,
        expected_binding_revision: String,
        expected_model_revision: String,
    },
    #[serde(rename = "sources.revoke")]
    Revoke {
        device_id: String,
        expected_binding_revision: String,
    },
}
impl Change {
    fn device(&self) -> &str {
        match self {
            Self::Bind { device_id, .. } | Self::Revoke { device_id, .. } => device_id,
        }
    }
    fn expected(&self) -> &str {
        match self {
            Self::Bind {
                expected_binding_revision,
                ..
            }
            | Self::Revoke {
                expected_binding_revision,
                ..
            } => expected_binding_revision,
        }
    }
    fn validate(&self) -> Result<()> {
        ensure(
            identifier(self.device()) && is_digest(self.expected()),
            "invalid_observation_change",
        )?;
        if let Self::Bind {
            source,
            expected_model_revision,
            ..
        } = self
        {
            source
                .validate()
                .map_err(|_| err("invalid_observation_change"))?;
            ensure(
                is_digest(expected_model_revision),
                "invalid_observation_change",
            )?;
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub space_id: String,
    pub idempotency_key: String,
    pub change: Change,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Operation {
    pub operation_id: String,
    pub sequence: u32,
    pub request: Request,
    pub request_digest: String,
    pub status: String,
    pub reason: Option<String>,
    pub result: Option<View>,
    pub created_at: DateTime<Utc>,
}

/// 只由宿主完成协议读取后构造；不接受客户端反序列化为授权证据。
pub struct Offer {
    pub source: Route,
    pub model: Model,
    pub write_paths: BTreeSet<String>,
    pub manifest: Value,
    pub observed_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
}

fn is_digest(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|value| {
        value.len() == 64
            && value
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}
fn validate_manifest(source: &Route, manifest: &Value) -> Result<()> {
    source.validate()?;
    let bytes = serde_json::to_vec(manifest).map_err(|_| err("invalid_observation_manifest"))?;
    ensure(
        manifest
            .as_object()
            .is_some_and(|object| !object.is_empty())
            && bounded_document(&bytes, 4096, 8, 256).is_some()
            && digest(manifest)? == source.revision,
        "invalid_observation_manifest",
    )
}
fn view(device: &str, binding: Option<&Binding>) -> Result<View> {
    Ok(View {
        device_id: device.into(),
        revision: digest(&("observation-binding-v1", device, binding))?,
        binding: binding.cloned(),
    })
}

pub fn parse_change(bytes: &[u8]) -> Result<Change> {
    let value =
        bounded_document(bytes, 4096, 4, 64).ok_or_else(|| err("invalid_observation_change"))?;
    let change: Change =
        serde_json::from_value(value.clone()).map_err(|_| err("invalid_observation_change"))?;
    ensure(
        digest(&change)? == digest(&value)?,
        "invalid_observation_change",
    )?;
    change.validate()?;
    Ok(change)
}

impl Data {
    pub fn observation_binding(&self, device: &str) -> Result<View> {
        ensure(identifier(device), "invalid_device_id")?;
        view(device, self.observation_registry.bindings.get(device))
    }
    pub fn observation_operation(&self, key: &str) -> Result<&Operation> {
        self.observation_registry
            .operations
            .get(key)
            .ok_or_else(|| err("observation_operation_not_found"))
    }
    pub fn apply_observation_change(
        &mut self,
        request: Request,
        offer: Option<&Offer>,
        now: DateTime<Utc>,
    ) -> Result<Operation> {
        ensure(request.space_id == self.space_id, "forbidden")?;
        ensure(
            identifier(&request.idempotency_key),
            "invalid_idempotency_key",
        )?;
        request.change.validate()?;
        let request_digest = digest(&request)?;
        if let Some(previous) = self
            .observation_registry
            .operations
            .get(&request.idempotency_key)
        {
            ensure(
                previous.request_digest == request_digest,
                "idempotency_conflict",
            )?;
            return Ok(previous.clone());
        }
        ensure(
            self.observation_registry.operations.len() < MAX_OPERATIONS,
            "observation_operation_capacity",
        )?;
        let operation_id = format!("observationop-{}", id());
        let result = self.change_observation_once(&request.change, offer, &operation_id, now);
        let (status, reason, result) = match result {
            Ok(result) => ("applied", None, Some(result)),
            Err(error) => (
                if error.code == "revision_conflict" {
                    "conflict"
                } else {
                    "rejected"
                },
                Some(error.code),
                None,
            ),
        };
        let operation = Operation {
            operation_id,
            sequence: self.observation_registry.operations.len() as u32 + 1,
            request: request.clone(),
            request_digest,
            status: status.into(),
            reason,
            result,
            created_at: now,
        };
        self.observation_registry
            .operations
            .insert(request.idempotency_key, operation.clone());
        Ok(operation)
    }
    fn change_observation_once(
        &mut self,
        change: &Change,
        offer: Option<&Offer>,
        generation: &str,
        now: DateTime<Utc>,
    ) -> Result<View> {
        let device_id = change.device();
        let previous = self.observation_registry.bindings.get(device_id);
        ensure(
            view(device_id, previous)?.revision == change.expected(),
            "revision_conflict",
        )?;
        let binding = match change {
            Change::Bind {
                source,
                expected_model_revision,
                ..
            } => {
                let offer = offer.ok_or_else(|| err("observation_offer_unavailable"))?;
                ensure(
                    offer.observed_at <= now
                        && offer.expires_at > now
                        && offer
                            .observed_at
                            .checked_add_signed(Duration::seconds(60))
                            .is_some_and(|limit| offer.expires_at <= limit),
                    "observation_offer_expired",
                )?;
                ensure(
                    offer.source == *source && digest(&offer.model)? == *expected_model_revision,
                    "observation_offer_mismatch",
                )?;
                validate_manifest(source, &offer.manifest)?;
                if let Some(previous) = previous {
                    ensure(
                        previous.policy.model_revision == *expected_model_revision
                            && previous.write_paths == offer.write_paths,
                        "observation_model_locked",
                    )?;
                } else {
                    ensure(
                        !self.devices.contains_key(device_id),
                        "observation_device_in_use",
                    )?;
                    ensure(
                        self.devices.len() < 64
                            && self.observation_registry.bindings.len() < MAX_BINDINGS,
                        "capacity_exceeded",
                    )?;
                }
                // 静态来源、原生执行路由与托管来源共享宿主ID，不允许静默接管。
                ensure(
                    !self.devices.values().any(|device| {
                        device.device_id != device_id
                            && (device.observation_policy.as_ref().is_some_and(|policy| {
                                policy.source.adapter_id == source.adapter_id
                                    && self
                                        .observation_registry
                                        .bindings
                                        .get(&device.device_id)
                                        .is_none_or(|binding| binding.active)
                            }) || device
                                .routes
                                .values()
                                .any(|route| route.adapter_id == source.adapter_id))
                    }),
                    "observation_source_in_use",
                )?;
                ensure(
                    self.devices
                        .values()
                        .filter(|device| device.observation_policy.is_some())
                        .count()
                        + usize::from(previous.is_none())
                        <= MAX_BINDINGS,
                    "capacity_exceeded",
                )?;
                if previous.is_some() {
                    self.check_model_authority(device_id)?;
                }
                Binding {
                    policy: Policy {
                        device_id: device_id.into(),
                        model_revision: expected_model_revision.clone(),
                        source: source.clone(),
                    },
                    write_paths: offer.write_paths.clone(),
                    manifest: offer.manifest.clone(),
                    active: true,
                    generation: generation.into(),
                    changed_at: now,
                }
            }
            Change::Revoke { .. } => {
                let mut binding = previous
                    .cloned()
                    .ok_or_else(|| err("observation_binding_not_found"))?;
                binding.active = false;
                binding.generation = generation.into();
                binding.changed_at = now;
                binding
            }
        };
        if let Some(offer) = offer.filter(|_| matches!(change, Change::Bind { .. })) {
            binding.validate_model(&offer.model)?;
        }
        let result = view(device_id, Some(&binding))?;
        // 所有可能失败的核对已完成。授权、设备、模型与失效会话在同一次Store更新中公布。
        if let Some(offer) = offer.filter(|_| matches!(change, Change::Bind { .. })) {
            self.models
                .insert(binding.policy.model_revision.clone(), offer.model.clone());
        }
        if self.devices.contains_key(device_id) {
            self.close_property_bridge(device_id);
        }
        self.reset_threshold_source(device_id);
        let device = self.devices.entry(device_id.into()).or_insert_with(|| {
            Device::new_binding(device_id.into(), binding.policy.model_revision.clone())
        });
        device.observation_policy = Some(binding.policy.clone());
        device.property_bridge_policy = binding.bridge();
        device.routes = binding.routes();
        device.adapter_sessions.clear();
        device.observation_session = None;
        device.ready = false;
        device.last_seen = None;
        if binding.active {
            device.reported.clear();
        }
        self.observation_registry
            .bindings
            .insert(device_id.into(), binding);
        Ok(result)
    }

    /// 快照校验重建决定链；会话与在线性仍由宿主后续读取建立。
    pub fn restore_observation_bindings(mut self) -> Result<Self> {
        self.validate_observation_registry()?;
        for binding in self.observation_registry.bindings.values() {
            let device = self.devices.get_mut(&binding.policy.device_id).unwrap();
            ensure(
                device.observation_policy.is_none(),
                "observation_source_conflict",
            )?;
            device.observation_policy = Some(binding.policy.clone());
            device.property_bridge_policy = binding.bridge();
            device.adapter_sessions.clear();
            device.observation_session = None;
            device.ready = false;
        }
        ensure(
            self.devices
                .values()
                .filter(|device| device.observation_policy.is_some())
                .count()
                <= MAX_BINDINGS,
            "invalid_observation_registry",
        )?;
        let mut sources: BTreeSet<_> = self
            .devices
            .values()
            .filter(|device| device.property_bridge_policy.is_none())
            .flat_map(|device| device.routes.values().map(|route| &route.adapter_id))
            .collect();
        for device in self.devices.values() {
            if let Some(policy) = &device.observation_policy {
                if self
                    .observation_registry
                    .bindings
                    .get(&device.device_id)
                    .is_none_or(|binding| binding.active)
                {
                    ensure(
                        sources.insert(&policy.source.adapter_id),
                        "observation_source_conflict",
                    )?;
                }
            }
        }
        Ok(self)
    }
    pub fn validate_observation_registry(&self) -> Result<()> {
        let registry = &self.observation_registry;
        ensure(
            registry.bindings.len() <= MAX_BINDINGS
                && registry.operations.len() <= MAX_OPERATIONS
                && self.devices.len() <= 64,
            "invalid_observation_registry",
        )?;
        let mut operations: Vec<_> = registry.operations.iter().collect();
        operations.sort_by_key(|(_, operation)| operation.sequence);
        let mut replayed: BTreeMap<String, Binding> = BTreeMap::new();
        let mut ids = BTreeSet::new();
        for (offset, (key, operation)) in operations.iter().enumerate() {
            operation.request.change.validate()?;
            ensure(
                operation.sequence as usize == offset + 1
                    && operation.request.space_id == self.space_id
                    && operation.request.idempotency_key == **key
                    && identifier(key)
                    && digest(&operation.request)? == operation.request_digest
                    && operation
                        .operation_id
                        .strip_prefix("observationop-")
                        .is_some_and(identifier)
                    && ids.insert(&operation.operation_id),
                "invalid_observation_registry",
            )?;
            let change = &operation.request.change;
            match operation.status.as_str() {
                "applied" => {
                    let result = operation
                        .result
                        .as_ref()
                        .ok_or_else(|| err("invalid_observation_registry"))?;
                    let binding = result
                        .binding
                        .as_ref()
                        .ok_or_else(|| err("invalid_observation_registry"))?;
                    ensure(
                        operation.reason.is_none()
                            && view(change.device(), replayed.get(change.device()))?.revision
                                == change.expected()
                            && result == &view(change.device(), Some(binding))?
                            && binding.generation == operation.operation_id
                            && binding.changed_at == operation.created_at,
                        "invalid_observation_registry",
                    )?;
                    validate_manifest(&binding.policy.source, &binding.manifest)?;
                    binding.validate_model(
                        self.models
                            .get(&binding.policy.model_revision)
                            .ok_or_else(|| err("invalid_observation_registry"))?,
                    )?;
                    match change {
                        Change::Bind {
                            source,
                            expected_model_revision,
                            ..
                        } => {
                            ensure(
                                binding.active
                                    && binding.policy.source == *source
                                    && binding.policy.model_revision == *expected_model_revision
                                    && binding.policy.device_id == change.device(),
                                "invalid_observation_registry",
                            )?;
                            if let Some(previous) = replayed.get(change.device()) {
                                ensure(
                                    previous.policy.model_revision == binding.policy.model_revision
                                        && previous.write_paths == binding.write_paths,
                                    "invalid_observation_registry",
                                )?;
                            }
                            ensure(
                                !replayed.values().any(|previous| {
                                    previous.active
                                        && previous.policy.device_id != change.device()
                                        && previous.policy.source.adapter_id == source.adapter_id
                                }),
                                "invalid_observation_registry",
                            )?;
                        }
                        Change::Revoke { .. } => {
                            let previous = replayed
                                .get(change.device())
                                .ok_or_else(|| err("invalid_observation_registry"))?;
                            ensure(
                                !binding.active
                                    && binding.policy == previous.policy
                                    && binding.write_paths == previous.write_paths
                                    && binding.manifest == previous.manifest,
                                "invalid_observation_registry",
                            )?;
                        }
                    }
                    replayed.insert(change.device().into(), binding.clone());
                }
                "rejected" | "conflict" => {
                    ensure(
                        operation.result.is_none()
                            && operation.reason.as_ref().is_some_and(|reason| {
                                !reason.is_empty()
                                    && reason.len() <= 64
                                    && reason.bytes().all(|b| {
                                        b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_'
                                    })
                                    && (operation.status == "conflict")
                                        == (reason == "revision_conflict")
                            })
                            && (operation.status == "conflict")
                                == (view(change.device(), replayed.get(change.device()))?.revision
                                    != change.expected()),
                        "invalid_observation_registry",
                    )?;
                }
                _ => return Err(err("invalid_observation_registry")),
            }
        }
        ensure(
            replayed == registry.bindings,
            "invalid_observation_registry",
        )?;
        for (device_id, binding) in &registry.bindings {
            let device = self
                .devices
                .get(device_id)
                .ok_or_else(|| err("invalid_observation_registry"))?;
            let model = self
                .models
                .get(&binding.policy.model_revision)
                .ok_or_else(|| err("invalid_observation_registry"))?;
            ensure(
                device.device_id == *device_id
                    && binding.policy.device_id == *device_id
                    && device.model_revision == binding.policy.model_revision
                    && digest(model)? == binding.policy.model_revision
                    && device.routes == binding.routes()
                    && device.boot_id.is_none()
                    && device.session_id.is_none()
                    && device.last_seq == 0
                    && device.retired_boots.is_empty()
                    && device.seen.is_empty()
                    && !self.model_registry.bindings.contains_key(device_id)
                    && !self.execution_registry.bindings.contains_key(device_id),
                "invalid_observation_registry",
            )?;
            binding.validate_model(model)?;
        }
        Ok(())
    }
}
