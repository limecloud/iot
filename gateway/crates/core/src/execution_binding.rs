//! 适配绑定是独立的本地决定；原请求、撤销与修订由网关耐久提交。
use crate::{
    digest, engine::Data, ensure, err, execution::Route, id, identifier, model::Model, Result,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

pub const MAX_OPERATIONS: usize = 256;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Registry {
    pub bindings: BTreeMap<String, Binding>,
    pub operations: BTreeMap<String, Operation>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Binding {
    pub device_id: String,
    pub generation: String,
    pub route: Option<Route>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_paths: Option<BTreeSet<String>>,
    pub changed_at: DateTime<Utc>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct View {
    pub device_id: String,
    pub model_revision: String,
    pub revision: String,
    pub state: String,
    pub routes: BTreeMap<String, Route>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_paths: Option<BTreeSet<String>>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "type", deny_unknown_fields)]
pub enum Change {
    #[serde(rename = "bindings.bind")]
    Bind {
        device_id: String,
        route: Route,
        expected_binding_revision: String,
        expected_model_revision: String,
    },
    #[serde(rename = "bindings.compose")]
    Compose {
        device_id: String,
        route: Route,
        native_paths: BTreeSet<String>,
        expected_native_session: String,
        expected_binding_revision: String,
        expected_model_revision: String,
    },
    #[serde(rename = "bindings.revoke")]
    Revoke {
        device_id: String,
        expected_binding_revision: String,
    },
}
impl Change {
    fn validate(&self) -> Result<()> {
        let (device_id, expected) = match self {
            Self::Bind {
                device_id,
                route,
                expected_binding_revision,
                expected_model_revision,
            }
            | Self::Compose {
                device_id,
                route,
                expected_binding_revision,
                expected_model_revision,
                ..
            } => {
                route
                    .validate()
                    .map_err(|_| err("invalid_execution_change"))?;
                ensure(
                    is_digest(expected_model_revision),
                    "invalid_execution_change",
                )?;
                (device_id, expected_binding_revision)
            }
            Self::Revoke {
                device_id,
                expected_binding_revision,
            } => (device_id, expected_binding_revision),
        };
        if let Self::Compose {
            native_paths,
            expected_native_session,
            ..
        } = self
        {
            ensure(
                identifier(expected_native_session)
                    && !native_paths.is_empty()
                    && native_paths.len() <= 64
                    && native_paths.iter().all(|path| {
                        path.split_once('.').is_some_and(|(service, action)| {
                            crate::model::local_id(service) && crate::model::local_id(action)
                        })
                    }),
                "invalid_execution_change",
            )?;
        }
        ensure(
            identifier(device_id) && is_digest(expected),
            "invalid_execution_change",
        )
    }
}

fn is_digest(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

fn routed_actions(model: &Model) -> Result<BTreeSet<String>> {
    model
        .validate()
        .map_err(|_| err("execution_model_incompatible"))?;
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
    ensure(
        !paths.is_empty()
            && model.services.iter().all(|service| {
                service.properties.is_empty()
                    && service.events.is_empty()
                    && service
                        .actions
                        .iter()
                        .all(crate::execution::supports_action)
            }),
        "execution_model_incompatible",
    )?;
    Ok(paths)
}

fn external_paths(model: &Model, native: Option<&BTreeSet<String>>) -> Result<BTreeSet<String>> {
    let all = routed_actions(model)?;
    if let Some(native) = native {
        ensure(
            !native.is_empty() && native.len() <= 64 && native.is_subset(&all) && *native != all,
            "execution_model_incompatible",
        )?;
        Ok(all.difference(native).cloned().collect())
    } else {
        Ok(all)
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
    pub request: Request,
    pub request_digest: String,
    pub status: String,
    pub reason: Option<String>,
    pub result: Option<View>,
    pub created_at: DateTime<Utc>,
}

/// 仅由宿主已验证的提供方构造；不从客户端反序列化。
pub struct Offer {
    pub device_id: String,
    pub route: Route,
    pub model_revision: String,
    pub paths: BTreeSet<String>,
}
pub fn parse_change(raw: &[u8]) -> Result<Change> {
    let value = crate::validation::bounded_document(raw, 4096, 4, 256)
        .ok_or_else(|| err("invalid_execution_change"))?;
    let change: Change =
        serde_json::from_value(value.clone()).map_err(|_| err("invalid_execution_change"))?;
    ensure(
        digest(&change)? == digest(&value)?,
        "invalid_execution_change",
    )?;
    change.validate()?;
    Ok(change)
}
impl Data {
    pub(crate) fn native_action_declaration(
        &self,
        device: &crate::engine::Device,
        body: &serde_json::Value,
    ) -> Result<Option<BTreeSet<String>>> {
        let paths = body
            .get("execution_paths")
            .map(|value| -> Result<BTreeSet<String>> {
                let items = value
                    .as_array()
                    .ok_or_else(|| err("invalid_execution_capabilities"))?;
                ensure(
                    !items.is_empty() && items.len() <= 64,
                    "invalid_execution_capabilities",
                )?;
                let mut paths = BTreeSet::new();
                let model = &self.models[&device.model_revision];
                for value in items {
                    let path = value
                        .as_str()
                        .ok_or_else(|| err("invalid_execution_capabilities"))?;
                    ensure(
                        paths.insert(path.into()) && model.action(path).is_ok(),
                        "invalid_execution_capabilities",
                    )?;
                }
                Ok(paths)
            })
            .transpose()?;
        if let Some(expected) = self
            .execution_registry
            .bindings
            .get(&device.device_id)
            .and_then(|binding| binding.native_paths.as_ref())
        {
            ensure(
                paths
                    .as_ref()
                    .is_some_and(|offered| expected.is_subset(offered)),
                "execution_capabilities_mismatch",
            )?;
        }
        Ok(paths)
    }
    pub fn execution_blocked(&self, device: &str) -> bool {
        self.execution_registry
            .bindings
            .get(device)
            .is_some_and(|binding| binding.route.is_none())
    }
    pub fn execution_binding(&self, device_id: &str) -> Result<View> {
        let device = self
            .devices
            .get(device_id)
            .ok_or_else(|| err("device_not_found"))?;
        let record = self.execution_registry.bindings.get(device_id);
        Ok(View {
            device_id: device_id.into(),
            model_revision: device.model_revision.clone(),
            revision: digest(&(device_id, &device.model_revision, &device.routes, record))?,
            state: if self.execution_blocked(device_id) {
                "revoked"
            } else if device.routes.is_empty() {
                "native"
            } else if record.is_some_and(|binding| binding.native_paths.is_some()) {
                "composed"
            } else {
                "bound"
            }
            .into(),
            routes: device.routes.clone(),
            native_paths: record.and_then(|binding| binding.native_paths.clone()),
        })
    }
    pub fn execution_operation(&self, key: &str) -> Result<&Operation> {
        self.execution_registry
            .operations
            .get(key)
            .ok_or_else(|| err("execution_operation_not_found"))
    }
    pub fn apply_execution_change(
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
        if let Some(old) = self
            .execution_registry
            .operations
            .get(&request.idempotency_key)
        {
            ensure(old.request_digest == request_digest, "idempotency_conflict")?;
            return Ok(old.clone());
        }
        ensure(
            self.execution_registry.operations.len() < MAX_OPERATIONS,
            "execution_operation_capacity",
        )?;
        let result = self.apply_execution_change_once(&request.change, offer, now);
        let (status, reason, result) = match result {
            Ok(view) => ("applied", None, Some(view)),
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
            operation_id: format!("executionop-{}", id()),
            request: request.clone(),
            request_digest,
            status: status.into(),
            reason,
            result,
            created_at: now,
        };
        self.execution_registry
            .operations
            .insert(request.idempotency_key, operation.clone());
        Ok(operation)
    }
    fn apply_execution_change_once(
        &mut self,
        change: &Change,
        offer: Option<&Offer>,
        now: DateTime<Utc>,
    ) -> Result<View> {
        let (device_id, expected) = match change {
            Change::Bind {
                device_id,
                expected_binding_revision,
                ..
            }
            | Change::Compose {
                device_id,
                expected_binding_revision,
                ..
            }
            | Change::Revoke {
                device_id,
                expected_binding_revision,
            } => (device_id, expected_binding_revision),
        };
        ensure(identifier(device_id), "invalid_device_id")?;
        ensure(
            self.execution_binding(device_id)?.revision == *expected,
            "revision_conflict",
        )?;
        let native_paths = match change {
            Change::Compose { native_paths, .. } => Some(native_paths.clone()),
            _ => None,
        };
        let next_route = match change {
            Change::Bind {
                route,
                expected_model_revision,
                ..
            }
            | Change::Compose {
                route,
                expected_model_revision,
                ..
            } => {
                route.validate()?;
                let offer = offer.ok_or_else(|| err("execution_offer_unavailable"))?;
                let device = &self.devices[device_id];
                ensure(
                    device.model_revision == *expected_model_revision,
                    "revision_conflict",
                )?;
                ensure(
                    offer.device_id == *device_id
                        && offer.route == *route
                        && offer.model_revision == *expected_model_revision,
                    "execution_offer_mismatch",
                )?;
                self.check_model_authority(device_id)?;
                let model = &self.models[expected_model_revision];
                let paths = routed_actions(model)?;
                let external = external_paths(model, native_paths.as_ref())?;
                ensure(
                    if native_paths.is_some() {
                        offer.paths.is_subset(&paths) && external.is_subset(&offer.paths)
                    } else {
                        paths == offer.paths
                    },
                    "execution_model_incompatible",
                )?;
                if let Change::Compose {
                    expected_native_session,
                    ..
                } = change
                {
                    ensure(
                        device.native_ready(now)
                            && device.session_id.as_ref() == Some(expected_native_session)
                            && device.native_actions.as_ref().is_some_and(|offered| {
                                native_paths
                                    .as_ref()
                                    .is_some_and(|selected| selected.is_subset(offered))
                            }),
                        "execution_native_proof_required",
                    )?;
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
                    !self.commands.values().any(|command| {
                        command.request.device_id == *device_id && command.status == "dispatched"
                    }),
                    "execution_in_flight",
                )?;
                ensure(
                    !self.devices.values().any(|other| {
                        other.device_id != *device_id
                            && other
                                .routes
                                .values()
                                .any(|bound| bound.adapter_id == route.adapter_id)
                    }),
                    "execution_adapter_in_use",
                )?;
                Some(route.clone())
            }
            Change::Revoke { .. } => {
                ensure(
                    !self.devices[device_id].routes.is_empty() || self.execution_blocked(device_id),
                    "execution_binding_not_found",
                )?;
                None
            }
        };
        let device = self.devices.get_mut(device_id).unwrap();
        device.routes.clear();
        if let Some(route) = &next_route {
            let model = &self.models[&device.model_revision];
            for path in external_paths(model, native_paths.as_ref())? {
                device.routes.insert(path, route.clone());
            }
        }
        device.ready = false;
        device.device_info = None;
        device.adapter_sessions.clear();
        for command in self
            .commands
            .values_mut()
            .filter(|command| command.request.device_id == *device_id)
        {
            if command.status == "accepted" {
                command.status = "rejected".into();
                command.error = Some("execution_binding_changed".into());
            } else if command.status == "dispatched" {
                command.status = "unknown".into();
                command.error = Some("execution_unknown".into());
            }
        }
        self.execution_registry.bindings.insert(
            device_id.clone(),
            Binding {
                device_id: device_id.clone(),
                generation: id(),
                route: next_route,
                native_paths,
                changed_at: now,
            },
        );
        self.execution_binding(device_id)
    }
    pub fn validate_execution_registry(&self) -> Result<()> {
        ensure(
            self.execution_registry.bindings.len() <= 64
                && self.execution_registry.operations.len() <= MAX_OPERATIONS,
            "invalid_execution_registry",
        )?;
        for (device_id, binding) in &self.execution_registry.bindings {
            let device = self
                .devices
                .get(device_id)
                .ok_or_else(|| err("invalid_execution_registry"))?;
            ensure(
                binding.device_id == *device_id
                    && identifier(device_id)
                    && identifier(&binding.generation),
                "invalid_execution_registry",
            )?;
            if let Some(route) = &binding.route {
                route.validate()?;
                let model = self
                    .models
                    .get(&device.model_revision)
                    .ok_or_else(|| err("invalid_execution_registry"))?;
                let paths = external_paths(model, binding.native_paths.as_ref())?;
                ensure(
                    device.routes.keys().cloned().collect::<BTreeSet<_>>() == paths
                        && device.routes.values().all(|current| current == route)
                        && !self.devices.values().any(|other| {
                            other.device_id != *device_id
                                && other
                                    .routes
                                    .values()
                                    .any(|bound| bound.adapter_id == route.adapter_id)
                        }),
                    "invalid_execution_registry",
                )?;
            } else {
                ensure(
                    device.routes.is_empty() && binding.native_paths.is_none(),
                    "invalid_execution_registry",
                )?;
            }
        }
        for (key, operation) in &self.execution_registry.operations {
            operation.request.change.validate()?;
            ensure(
                operation.request.space_id == self.space_id
                    && operation.request.idempotency_key == *key
                    && identifier(key)
                    && operation.request_digest == digest(&operation.request)?
                    && operation
                        .operation_id
                        .strip_prefix("executionop-")
                        .is_some_and(|suffix| suffix.len() <= 100 && identifier(suffix))
                    && match operation.status.as_str() {
                        "applied" => operation.result.is_some() && operation.reason.is_none(),
                        "rejected" | "conflict" => {
                            operation.result.is_none()
                                && operation.reason.as_ref().is_some_and(|reason| {
                                    !reason.is_empty()
                                        && reason.len() <= 64
                                        && reason.as_bytes()[0].is_ascii_lowercase()
                                        && reason.bytes().all(|byte| {
                                            byte.is_ascii_lowercase()
                                                || byte.is_ascii_digit()
                                                || byte == b'_'
                                        })
                                        && (operation.status == "conflict")
                                            == (reason == "revision_conflict")
                                })
                        }
                        _ => false,
                    },
                "invalid_execution_registry",
            )?;
            if let Some(view) = &operation.result {
                let (device_id, expected, route, model_revision) = match &operation.request.change {
                    Change::Bind {
                        device_id,
                        route,
                        expected_binding_revision,
                        expected_model_revision,
                    }
                    | Change::Compose {
                        device_id,
                        route,
                        expected_binding_revision,
                        expected_model_revision,
                        ..
                    } => (
                        device_id,
                        expected_binding_revision,
                        Some(route),
                        Some(expected_model_revision),
                    ),
                    Change::Revoke {
                        device_id,
                        expected_binding_revision,
                    } => (device_id, expected_binding_revision, None, None),
                };
                ensure(
                    view.device_id == *device_id
                        && self.execution_registry.bindings.contains_key(device_id)
                        && is_digest(&view.model_revision)
                        && is_digest(&view.revision)
                        && view.revision != *expected,
                    "invalid_execution_registry",
                )?;
                let model = self
                    .models
                    .get(&view.model_revision)
                    .ok_or_else(|| err("invalid_execution_registry"))?;
                let expected_native = match &operation.request.change {
                    Change::Compose { native_paths, .. } => Some(native_paths),
                    _ => None,
                };
                ensure(
                    view.native_paths.as_ref() == expected_native,
                    "invalid_execution_registry",
                )?;
                match route {
                    Some(route) => ensure(
                        view.state
                            == if expected_native.is_some() {
                                "composed"
                            } else {
                                "bound"
                            }
                            && Some(&view.model_revision) == model_revision
                            && view.routes.keys().cloned().collect::<BTreeSet<_>>()
                                == external_paths(model, expected_native)?
                            && view.routes.values().all(|current| current == route),
                        "invalid_execution_registry",
                    )?,
                    None => ensure(
                        view.state == "revoked" && view.routes.is_empty(),
                        "invalid_execution_registry",
                    )?,
                }
            }
        }
        Ok(())
    }
}
