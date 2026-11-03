//! 本地所有者明确授权发布者、安装模型和绑定设备。云会话不产生这些权限。
use crate::{
    compatibility, digest,
    engine::{Data, Device},
    ensure, err, id, identifier, release,
    validation::bounded_document,
    Result,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;

pub const MAX_OPERATIONS: usize = 1024;
pub const MAX_TRUSTS: usize = 32;
pub const MAX_INSTALLATIONS: usize = 128;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
pub enum Change {
    #[serde(rename = "trust.add")]
    TrustAdd {
        trust: Value,
        expected_signing_key_id: String,
    },
    #[serde(rename = "trust.revoke")]
    TrustRevoke {
        trust_id: String,
        expected_revision: String,
    },
    #[serde(rename = "models.install")]
    Install {
        trust_id: String,
        artifact: Value,
        expected_release_id: Option<String>,
    },
    #[serde(rename = "devices.bind")]
    Bind {
        device_id: String,
        installation_id: String,
        expected_model_revision: Option<String>,
        expected_binding_revision: Option<String>,
    },
    #[serde(rename = "devices.bind-bundle")]
    BindBundle {
        device_id: String,
        bundle_id: String,
        expected_model_revision: Option<String>,
        expected_binding_revision: Option<String>,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub space_id: String,
    pub idempotency_key: String,
    pub change: Change,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PublisherTrust {
    pub trust_id: String,
    pub revision: String,
    pub trust: release::Trust,
    pub active: bool,
    pub created_at: DateTime<Utc>,
    pub revoked_at: Option<DateTime<Utc>>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Installation {
    pub installation_id: String,
    pub trust_id: String,
    pub artifact: release::Artifact,
    pub installed_at: DateTime<Utc>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(untagged, deny_unknown_fields)]
pub enum DeviceBinding {
    Installation {
        device_id: String,
        model_revision: String,
        installation_id: String,
        revision: String,
        bound_at: DateTime<Utc>,
    },
    Bundle {
        device_id: String,
        model_revision: String,
        bundle_id: String,
        revision: String,
        bound_at: DateTime<Utc>,
    },
}
impl DeviceBinding {
    pub fn device_id(&self) -> &str {
        match self {
            Self::Installation { device_id, .. } | Self::Bundle { device_id, .. } => device_id,
        }
    }
    pub fn model_revision(&self) -> &str {
        match self {
            Self::Installation { model_revision, .. } | Self::Bundle { model_revision, .. } => {
                model_revision
            }
        }
    }
    pub fn revision(&self) -> &str {
        match self {
            Self::Installation { revision, .. } | Self::Bundle { revision, .. } => revision,
        }
    }
    pub fn installation_id(&self) -> Option<&str> {
        match self {
            Self::Installation {
                installation_id, ..
            } => Some(installation_id),
            Self::Bundle { .. } => None,
        }
    }
    pub fn bundle_id(&self) -> Option<&str> {
        match self {
            Self::Bundle { bundle_id, .. } => Some(bundle_id),
            Self::Installation { .. } => None,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
pub enum Resource {
    Trust(PublisherTrust),
    Installation(Box<Installation>),
    Binding(DeviceBinding),
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Operation {
    pub operation_id: String,
    pub request: Request,
    pub request_digest: String,
    pub status: String,
    pub reason: Option<String>,
    pub result: Option<Resource>,
    pub created_at: DateTime<Utc>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Registry {
    pub trusts: BTreeMap<String, PublisherTrust>,
    pub installations: BTreeMap<String, Installation>,
    pub heads: BTreeMap<String, String>,
    pub bindings: BTreeMap<String, DeviceBinding>,
    pub operations: BTreeMap<String, Operation>,
}

pub fn parse_change(raw: &[u8]) -> Result<Change> {
    let value =
        bounded_document(raw, 16_384, 20, 2400).ok_or_else(|| err("invalid_model_change"))?;
    let change: Change =
        serde_json::from_value(value.clone()).map_err(|_| err("invalid_model_change"))?;
    // Option字段必须显式为null或具体基线，不能遗漏后默认为None。
    ensure(digest(&change)? == digest(&value)?, "invalid_model_change")?;
    Ok(change)
}
fn bytes(value: &impl Serialize) -> Result<Vec<u8>> {
    serde_jcs::to_vec(value).map_err(|_| err("invalid_model_change"))
}
fn trust_id(trust: &release::Trust) -> Result<String> {
    Ok(format!("trust-{}", &digest(trust)?[7..]))
}
fn installation_id(artifact: &release::Artifact, trust: &str) -> Result<String> {
    Ok(format!(
        "install-{}",
        &digest(&json!({"artifact":artifact,"trust_id":trust}))?[7..]
    ))
}

impl Data {
    pub fn model_operation(&self, key: &str) -> Result<&Operation> {
        self.model_registry
            .operations
            .get(key)
            .ok_or_else(|| err("model_operation_not_found"))
    }
    pub fn apply_model_change(
        &mut self,
        request: Request,
        now: DateTime<Utc>,
    ) -> Result<Operation> {
        ensure(request.space_id == self.space_id, "forbidden")?;
        ensure(
            identifier(&request.idempotency_key),
            "invalid_idempotency_key",
        )?;
        let request_digest = digest(&request)?;
        if let Some(previous) = self.model_registry.operations.get(&request.idempotency_key) {
            ensure(
                previous.request_digest == request_digest,
                "idempotency_conflict",
            )?;
            return Ok(previous.clone());
        }
        ensure(
            self.model_registry.operations.len() < MAX_OPERATIONS,
            "model_operation_capacity",
        )?;
        let result = self.apply_model_change_once(&request.change, now);
        let (status, reason, resource) = match result {
            Ok(resource) => ("applied", None, Some(resource)),
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
            operation_id: format!("modelop-{}", id()),
            request: request.clone(),
            request_digest,
            status: status.into(),
            reason,
            result: resource,
            created_at: now,
        };
        self.model_registry
            .operations
            .insert(request.idempotency_key, operation.clone());
        Ok(operation)
    }
    fn apply_model_change_once(&mut self, change: &Change, now: DateTime<Utc>) -> Result<Resource> {
        match change {
            Change::TrustAdd {
                trust,
                expected_signing_key_id,
            } => {
                let trust = release::verify_trust(&bytes(trust)?)?;
                ensure(
                    trust.signing_key_id == *expected_signing_key_id,
                    "signing_key_confirmation_mismatch",
                )?;
                let key = trust_id(&trust)?;
                if let Some(current) = self.model_registry.trusts.get(&key) {
                    ensure(current.active, "model_trust_revoked")?;
                    return Ok(Resource::Trust(current.clone()));
                }
                ensure(
                    self.model_registry.trusts.len() < MAX_TRUSTS,
                    "model_trust_capacity",
                )?;
                let record = PublisherTrust {
                    trust_id: key.clone(),
                    revision: id(),
                    trust,
                    active: true,
                    created_at: now,
                    revoked_at: None,
                };
                self.model_registry.trusts.insert(key, record.clone());
                Ok(Resource::Trust(record))
            }
            Change::TrustRevoke {
                trust_id,
                expected_revision,
            } => {
                let record = self
                    .model_registry
                    .trusts
                    .get(trust_id)
                    .ok_or_else(|| err("model_trust_not_found"))?;
                ensure(record.revision == *expected_revision, "revision_conflict")?;
                if !record.active {
                    return Ok(Resource::Trust(record.clone()));
                }
                let affected: Vec<_> = self
                    .model_registry
                    .bindings
                    .values()
                    .filter(|binding| {
                        binding
                            .installation_id()
                            .and_then(|id| self.model_registry.installations.get(id))
                            .is_some_and(|installation| installation.trust_id == *trust_id)
                    })
                    .map(|binding| binding.device_id().to_owned())
                    .collect();
                let record = self.model_registry.trusts.get_mut(trust_id).unwrap();
                record.active = false;
                record.revoked_at = Some(now);
                record.revision = id();
                let result = record.clone();
                for device in affected {
                    self.invalidate_model_device(&device, "model_trust_revoked");
                }
                Ok(Resource::Trust(result))
            }
            Change::Install {
                trust_id,
                artifact,
                expected_release_id,
            } => {
                let trusted = self
                    .model_registry
                    .trusts
                    .get(trust_id)
                    .ok_or_else(|| err("model_trust_not_found"))?;
                ensure(trusted.active, "model_trust_revoked")?;
                let artifact =
                    release::verify_artifact(&bytes(artifact)?, &bytes(&trusted.trust)?, now)?;
                let statement = &artifact.statement;
                let current = self
                    .model_registry
                    .heads
                    .get(&statement.model.model_id)
                    .and_then(|key| self.model_registry.installations.get(key));
                ensure(
                    current.map(|v| &v.artifact.statement.release_id)
                        == expected_release_id.as_ref(),
                    "revision_conflict",
                )?;
                if let Some(previous) = self
                    .model_registry
                    .installations
                    .values()
                    .find(|v| v.artifact.statement.release_id == statement.release_id)
                {
                    ensure(
                        previous.trust_id == *trust_id
                            && digest(&previous.artifact)? == digest(&artifact)?,
                        "release_id_conflict",
                    )?;
                    ensure(
                        current
                            .is_some_and(|head| head.installation_id == previous.installation_id),
                        "model_downgrade",
                    )?;
                    return Ok(Resource::Installation(Box::new(previous.clone())));
                }
                if let Some(current) = current {
                    let old = &current.artifact.statement;
                    ensure(
                        old.issuer == statement.issuer
                            && old.publisher_id == statement.publisher_id
                            && old.product_id == statement.product_id,
                        "model_publisher_conflict",
                    )?;
                    let compared = compatibility::compare_documents(&bytes(
                        &json!({"baseline":old.model,"candidate":statement.model}),
                    )?);
                    ensure(
                        compared.compatible == Some(true),
                        "incompatible_installed_model",
                    )?;
                }
                ensure(
                    self.model_registry.installations.len() < MAX_INSTALLATIONS,
                    "model_installation_capacity",
                )?;
                let key = installation_id(&artifact, trust_id)?;
                let record = Installation {
                    installation_id: key.clone(),
                    trust_id: trust_id.clone(),
                    artifact,
                    installed_at: now,
                };
                self.models.insert(
                    record.artifact.statement.model_revision.clone(),
                    record.artifact.statement.model.clone(),
                );
                self.model_registry.heads.insert(
                    record.artifact.statement.model.model_id.clone(),
                    key.clone(),
                );
                self.model_registry
                    .installations
                    .insert(key, record.clone());
                Ok(Resource::Installation(Box::new(record)))
            }
            Change::Bind {
                device_id,
                installation_id,
                expected_model_revision,
                expected_binding_revision,
            } => {
                self.check_binding_baseline(
                    device_id,
                    expected_model_revision,
                    expected_binding_revision,
                )?;
                let installed = self
                    .model_registry
                    .installations
                    .get(installation_id)
                    .ok_or_else(|| err("model_installation_not_found"))?;
                ensure(
                    self.model_registry
                        .trusts
                        .get(&installed.trust_id)
                        .is_some_and(|v| v.active),
                    "model_trust_revoked",
                )?;
                let model = installed.artifact.statement.model.clone();
                ensure(
                    self.model_registry.heads.get(&model.model_id) == Some(installation_id),
                    "model_installation_superseded",
                )?;
                self.bind_device_model(
                    DeviceBinding::Installation {
                        device_id: device_id.clone(),
                        model_revision: installed.artifact.statement.model_revision.clone(),
                        installation_id: installation_id.clone(),
                        revision: id(),
                        bound_at: now,
                    },
                    model,
                    now,
                )
            }
            Change::BindBundle {
                device_id,
                bundle_id,
                expected_model_revision,
                expected_binding_revision,
            } => {
                self.check_binding_baseline(
                    device_id,
                    expected_model_revision,
                    expected_binding_revision,
                )?;
                let bundle = self.model_bundles.get(bundle_id)?.clone();
                self.bind_device_model(
                    DeviceBinding::Bundle {
                        device_id: device_id.clone(),
                        model_revision: bundle.model_revision,
                        bundle_id: bundle.bundle_id,
                        revision: id(),
                        bound_at: now,
                    },
                    bundle.model,
                    now,
                )
            }
        }
    }
    fn check_binding_baseline(
        &self,
        device_id: &str,
        expected_model: &Option<String>,
        expected_binding: &Option<String>,
    ) -> Result<()> {
        ensure(identifier(device_id), "invalid_device_id")?;
        ensure(
            self.devices.get(device_id).map(|v| &v.model_revision) == expected_model.as_ref()
                && self
                    .model_registry
                    .bindings
                    .get(device_id)
                    .map(|v| v.revision())
                    == expected_binding.as_deref(),
            "revision_conflict",
        )
    }
    fn bind_device_model(
        &mut self,
        binding: DeviceBinding,
        model: crate::model::Model,
        now: DateTime<Utc>,
    ) -> Result<Resource> {
        let device_id_owned = binding.device_id().to_owned();
        let device_id = &device_id_owned;
        let current = self.devices.get(device_id);
        if let Some(device) = current {
            if !device.routes.is_empty() {
                let native = self
                    .execution_registry
                    .bindings
                    .get(device_id)
                    .and_then(|binding| binding.native_paths.as_ref());
                ensure(
                    crate::execution::supports_native_state(&model)
                        && model.services.iter().all(|service| {
                            (service.properties.is_empty() || native.is_some())
                                && self.models[&device.model_revision]
                                    .services
                                    .iter()
                                    .any(|old| {
                                        old.id == service.id
                                            && old.semantic_id == service.semantic_id
                                    })
                                && service.actions.iter().all(|action| {
                                    let path = format!("{}.{}", service.id, action.id);
                                    device.routes.contains_key(&path)
                                        || native.is_some_and(|paths| paths.contains(&path))
                                })
                        }),
                    "bound_routes_incompatible",
                )?;
            }
            for path in device.routes.keys() {
                ensure(
                    model.action(path).is_ok_and(|action| {
                        crate::execution::supports_action(action)
                            && self.models[&device.model_revision]
                                .action(path)
                                .is_ok_and(|old| {
                                    old.semantic_id == action.semantic_id
                                        && old.idempotent == action.idempotent
                                        && old.risk == action.risk
                                        && crate::compatibility::schema_subset(
                                            &action.input,
                                            &old.input,
                                        )
                                })
                    }),
                    "bound_routes_incompatible",
                )?;
            }
        }
        if let Some(previous) = self
            .model_registry
            .bindings
            .get(device_id)
            .filter(|previous| {
                previous.installation_id() == binding.installation_id()
                    && previous.bundle_id() == binding.bundle_id()
            })
        {
            return Ok(Resource::Binding(previous.clone()));
        }
        ensure(
            !self.ota_reserves_device(device_id, now),
            "ota_task_conflict",
        )?;
        ensure(
            !self.execution_plan_reserves_device(device_id),
            "execution_plan_conflict",
        )?;
        ensure(
            current.is_some() || self.devices.len() < 64,
            "capacity_exceeded",
        )?;
        // 不静默停用已有规则；不再支持规则中任一能力时先要求所有者处理规则。
        for deployment in self.deployments.values() {
            let rule = &deployment.rule;
            self.validate_condition_binding(&rule.conditions, device_id, &model)
                .map_err(|_| err("bound_rules_incompatible"))?;
            if rule.trigger.device() == Some(device_id.as_str()) {
                rule.trigger
                    .validate_model(&model)
                    .map_err(|_| err("bound_rules_incompatible"))?;
            }
            for action in rule.actions.iter().filter(|v| v.device() == device_id) {
                model
                    .operation(&action.operation())
                    .map_err(|_| err("bound_rules_incompatible"))?;
            }
        }
        let mut device = current.cloned().unwrap_or_else(|| {
            Device::new_binding(device_id.clone(), binding.model_revision().to_owned())
        });
        if let Some(boot) = device.boot_id.take() {
            ensure(
                device.retired_boots.contains(&boot) || device.retired_boots.len() < 128,
                "capacity_exceeded",
            )?;
            device.retired_boots.insert(boot);
        }
        device.model_revision = binding.model_revision().to_owned();
        device.ready = false;
        device.device_info = None;
        device.adapter_sessions.clear();
        device.session_id = None;
        device.last_seq = 0;
        device.last_seen = None;
        device.state_revision = 0;
        device.reported.clear();
        device.seen.clear();
        device.receipt_ledger = false;
        device.native_actions = None;
        self.invalidate_model_device(device_id, "device_model_changed");
        self.models
            .insert(binding.model_revision().to_owned(), model);
        self.devices.insert(device_id.clone(), device);
        self.model_registry
            .bindings
            .insert(device_id.clone(), binding.clone());
        Ok(Resource::Binding(binding))
    }
    fn invalidate_model_device(&mut self, device: &str, reason: &str) {
        self.reset_threshold_source(device);
        if let Some(device) = self.devices.get_mut(device) {
            device.ready = false;
            device.device_info = None;
            device.adapter_sessions.clear();
        }
        for command in self
            .commands
            .values_mut()
            .filter(|v| v.request.device_id == device)
        {
            match command.status.as_str() {
                "accepted" => {
                    command.status = "rejected".into();
                    command.error = Some(reason.into());
                }
                "dispatched" => {
                    command.status = "unknown".into();
                    command.error = Some("execution_unknown".into());
                }
                _ => {}
            }
        }
    }
    fn validate_binding_source(&self, binding: &DeviceBinding) -> Result<()> {
        let model = match binding {
            DeviceBinding::Installation {
                installation_id, ..
            } => self
                .model_registry
                .installations
                .get(installation_id)
                .ok_or_else(|| err("storage_corrupt"))?
                .artifact
                .statement
                .model
                .clone(),
            DeviceBinding::Bundle { bundle_id, .. } => {
                self.model_bundles.get(bundle_id)?.model.clone()
            }
        };
        ensure(
            identifier(binding.device_id())
                && identifier(binding.revision())
                && binding.model_revision() == digest(&model)?
                && self
                    .models
                    .get(binding.model_revision())
                    .map(digest)
                    .transpose()?
                    == Some(digest(&model)?),
            "storage_corrupt",
        )
    }
    pub fn check_model_authority(&self, device: &str) -> Result<()> {
        if let Some(binding) = self.model_registry.bindings.get(device) {
            if let Some(installation_id) = binding.installation_id() {
                let installed = self
                    .model_registry
                    .installations
                    .get(installation_id)
                    .ok_or_else(|| err("storage_corrupt"))?;
                ensure(
                    self.model_registry
                        .trusts
                        .get(&installed.trust_id)
                        .is_some_and(|v| v.active),
                    "model_trust_revoked",
                )?;
            } else {
                self.validate_binding_source(binding)?;
            }
        }
        Ok(())
    }
    pub fn validate_model_registry(&self, now: DateTime<Utc>) -> Result<()> {
        let registry = &self.model_registry;
        ensure(
            registry.trusts.len() <= MAX_TRUSTS
                && registry.installations.len() <= MAX_INSTALLATIONS
                && registry.operations.len() <= MAX_OPERATIONS,
            "storage_corrupt",
        )?;
        for (key, record) in &registry.trusts {
            let trust = release::verify_trust(&bytes(&record.trust)?)?;
            ensure(
                key == &record.trust_id
                    && *key == trust_id(&trust)?
                    && identifier(&record.revision)
                    && record.active == record.revoked_at.is_none(),
                "storage_corrupt",
            )?;
        }
        for (key, record) in &registry.installations {
            let trust = registry
                .trusts
                .get(&record.trust_id)
                .ok_or_else(|| err("storage_corrupt"))?;
            let artifact =
                release::verify_artifact(&bytes(&record.artifact)?, &bytes(&trust.trust)?, now)?;
            let head = registry
                .heads
                .get(&artifact.statement.model.model_id)
                .and_then(|key| registry.installations.get(key))
                .ok_or_else(|| err("storage_corrupt"))?;
            ensure(
                compatibility::version(&head.artifact.statement.model.model_version)
                    >= compatibility::version(&artifact.statement.model.model_version),
                "storage_corrupt",
            )?;
            ensure(
                key == &record.installation_id
                    && *key == installation_id(&artifact, &record.trust_id)?
                    && self
                        .models
                        .get(&artifact.statement.model_revision)
                        .map(digest)
                        .transpose()?
                        == Some(digest(&artifact.statement.model)?),
                "storage_corrupt",
            )?;
        }
        for (model, key) in &registry.heads {
            ensure(
                registry
                    .installations
                    .get(key)
                    .is_some_and(|v| v.artifact.statement.model.model_id == *model),
                "storage_corrupt",
            )?;
        }
        for (device, binding) in &registry.bindings {
            self.validate_binding_source(binding)?;
            ensure(
                device == binding.device_id()
                    && self
                        .devices
                        .get(device)
                        .is_some_and(|v| v.model_revision == binding.model_revision()),
                "storage_corrupt",
            )?;
        }
        for (key, operation) in &registry.operations {
            ensure(
                key == &operation.request.idempotency_key
                    && identifier(key)
                    && operation.request.space_id == self.space_id
                    && digest(&operation.request)? == operation.request_digest
                    && match operation.status.as_str() {
                        "applied" => operation.reason.is_none() && operation.result.is_some(),
                        "rejected" | "conflict" => {
                            operation.reason.is_some() && operation.result.is_none()
                        }
                        _ => false,
                    },
                "storage_corrupt",
            )?;
            if operation.status == "applied" {
                match &operation.request.change {
                    Change::Bind {
                        device_id,
                        installation_id,
                        ..
                    } => {
                        let Some(Resource::Binding(binding)) = &operation.result else {
                            return Err(err("storage_corrupt"));
                        };
                        self.validate_binding_source(binding)?;
                        ensure(
                            binding.device_id() == device_id
                                && binding.installation_id() == Some(installation_id.as_str()),
                            "storage_corrupt",
                        )?;
                    }
                    Change::BindBundle {
                        device_id,
                        bundle_id,
                        ..
                    } => {
                        let Some(Resource::Binding(binding)) = &operation.result else {
                            return Err(err("storage_corrupt"));
                        };
                        self.validate_binding_source(binding)?;
                        ensure(
                            binding.device_id() == device_id
                                && binding.bundle_id() == Some(bundle_id.as_str()),
                            "storage_corrupt",
                        )?;
                    }
                    _ => {}
                }
            }
        }
        Ok(())
    }
}
