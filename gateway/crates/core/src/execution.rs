//! 外部适配绑定与内部执行入口；不授予设备 MQTT 身份。
use crate::{
    digest,
    engine::{Command, Data, Device},
    ensure, err, identifier,
    model::ActionDefinition,
    Result,
};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// 当前静态执行入口只能产生 submitted 与严格空对象输出。
pub fn supports_action(action: &ActionDefinition) -> bool {
    action.completion == "submitted"
        && action.output.kind == "object"
        && action.output.properties.is_empty()
        && action.output.required.is_empty()
        && action.output.additional == Some(false)
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Route {
    pub adapter_id: String,
    pub revision: String,
}
impl Route {
    pub fn validate(&self) -> Result<()> {
        ensure(
            identifier(&self.adapter_id)
                && self.revision.len() == 71
                && self.revision.starts_with("sha256:")
                && self.revision[7..]
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
            "invalid_execution_route",
        )
    }
}

#[derive(Clone, Debug)]
pub struct Session {
    pub route: Route,
    pub session_id: String,
    pub observed_at: DateTime<Utc>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AdapterReceipt {
    pub command_id: String,
    pub route: Route,
    pub session_id: String,
    pub request_digest: String,
    pub status: String,
    pub error: Option<String>,
    pub observed_at: DateTime<Utc>,
}
impl Device {
    pub(crate) fn native_ready(&self, now: DateTime<Utc>) -> bool {
        self.ready
            && self.last_seen.is_some_and(|seen| {
                let age = now - seen;
                age >= Duration::zero() && age < Duration::seconds(15)
            })
    }
    pub fn adapter_ready(&self, route: &Route, now: DateTime<Utc>) -> bool {
        self.adapter_sessions
            .get(&route.adapter_id)
            .is_some_and(|session| {
                let age = now - session.observed_at;
                session.route == *route && age >= Duration::zero() && age < Duration::seconds(15)
            })
    }
}

impl Data {
    pub fn mqtt_disconnected(&mut self) {
        self.reset_ota_approvals(None, "broker_disconnected");
        for device in self.devices.values_mut() {
            device.ready = false;
            device.device_info = None;
        }
        for command in self
            .commands
            .values_mut()
            .filter(|command| command.execution_route.is_none())
        {
            match command.status.as_str() {
                "accepted" => {
                    command.status = "rejected".into();
                    command.error = Some("device_offline".into());
                }
                "dispatched" => {
                    command.status = "unknown".into();
                    command.error = Some("execution_unknown".into());
                }
                _ => {}
            }
        }
    }
    pub fn adapter_seen(
        &mut self,
        device: &str,
        route: &Route,
        session_id: &str,
        now: DateTime<Utc>,
    ) -> Result<()> {
        route.validate()?;
        ensure(identifier(session_id), "invalid_session")?;
        self.check_model_authority(device)?;
        let device = self
            .devices
            .get_mut(device)
            .ok_or_else(|| err("device_not_found"))?;
        ensure(
            device.routes.values().any(|bound| bound == route),
            "execution_route_mismatch",
        )?;
        device.adapter_sessions.insert(
            route.adapter_id.clone(),
            Session {
                route: route.clone(),
                session_id: session_id.into(),
                observed_at: now,
            },
        );
        Ok(())
    }
    pub fn adapter_disconnected(&mut self, adapter_id: &str) {
        for device in self.devices.values_mut() {
            device.adapter_sessions.remove(adapter_id);
        }
        for command in self.commands.values_mut() {
            if command
                .execution_route
                .as_ref()
                .is_some_and(|route| route.adapter_id == adapter_id)
            {
                match command.status.as_str() {
                    "accepted" => {
                        command.status = "rejected".into();
                        command.error = Some("device_offline".into());
                    }
                    "dispatched" => {
                        command.status = "unknown".into();
                        command.error = Some("execution_unknown".into());
                    }
                    _ => {}
                }
            }
        }
    }
    pub(crate) fn command_session(
        &self,
        device: &Device,
        path: &str,
        now: DateTime<Utc>,
    ) -> Result<Option<String>> {
        ensure(
            !self.execution_blocked(&device.device_id),
            "execution_binding_revoked",
        )?;
        if let Some(route) = device.routes.get(path) {
            ensure(device.adapter_ready(route, now), "device_offline")?;
            Ok(Some(
                device.adapter_sessions[&route.adapter_id]
                    .session_id
                    .clone(),
            ))
        } else {
            if let Some(paths) = &device.native_actions {
                ensure(paths.contains(path), "execution_capability_unavailable")?;
            }
            if let Some(paths) = self
                .execution_registry
                .bindings
                .get(&device.device_id)
                .and_then(|binding| binding.native_paths.as_ref())
            {
                ensure(
                    paths.contains(path)
                        && device
                            .native_actions
                            .as_ref()
                            .is_some_and(|offered| paths.is_subset(offered)),
                    "execution_capability_unavailable",
                )?;
            }
            ensure(device.native_ready(now), "device_offline")?;
            Ok(device.session_id.clone())
        }
    }
    pub fn prepare_adapter_dispatch(&mut self, adapter: &str, now: DateTime<Utc>) -> Vec<Command> {
        self.prepare_dispatch_for(Some(adapter), now)
            .iter()
            .filter_map(|envelope| envelope.body["command_id"].as_str())
            .map(|command_id| self.commands[command_id].clone())
            .collect()
    }
    pub fn recheck_adapter_dispatch(&self, command: &Command, now: DateTime<Utc>) -> Result<()> {
        let current = self
            .commands
            .get(&command.command_id)
            .ok_or_else(|| err("command_not_found"))?;
        ensure(
            current.status == "dispatched"
                && current.request_digest == command.request_digest
                && current.execution_route == command.execution_route
                && current.execution_route.is_some()
                && current.request.expires_at > now,
            "execution_authorization_rejected",
        )?;
        self.check_model_authority(&current.request.device_id)?;
        let device = &self.devices[&current.request.device_id];
        ensure(
            device.model_revision == current.request.model_revision
                && device.routes.get(&current.request.operation.path)
                    == current.execution_route.as_ref()
                && self.command_session(device, &current.request.operation.path, now)?
                    == current.envelope.session_id
                && !self.ota_reserves_device(&current.request.device_id, now),
            "execution_authorization_rejected",
        )?;
        if let Some(authority) = &current.remote_authority {
            self.authorize_remote(authority, "commands.write", now)?;
        }
        Ok(())
    }
    pub fn apply_adapter_result(
        &mut self,
        receipt: AdapterReceipt,
        now: DateTime<Utc>,
    ) -> Result<Command> {
        let AdapterReceipt {
            command_id,
            route,
            session_id,
            request_digest,
            status,
            error,
            observed_at,
        } = receipt;
        let command = self
            .commands
            .get(&command_id)
            .ok_or_else(|| err("command_not_found"))?
            .clone();
        ensure(
            command.execution_route.as_ref() == Some(&route)
                && command.envelope.session_id.as_deref() == Some(session_id.as_str())
                && command.request_digest == request_digest,
            "execution_source_mismatch",
        )?;
        // 旧执行端的迟到证据只更新对应原命令，不赋予新绑定控制权。
        let evidence = if status == "confirmed" {
            json!({"type":"action_result","path":command.request.operation.path,
                "input_digest":digest(&command.request.operation.value)?,"output":{},
                "completion":"submitted","observed_at":observed_at})
        } else {
            json!({"type":"device_result"})
        };
        let body: Value =
            json!({"command_id":command_id,"status":status,"error":error,"evidence":evidence});
        self.apply_command_result(&command.request.device_id, Some(&session_id), &body, now)?;
        Ok(self.commands[&command_id].clone())
    }
    pub fn validate_execution_routes(&self) -> Result<()> {
        for device in self.devices.values() {
            let model = self
                .models
                .get(&device.model_revision)
                .ok_or_else(|| err("model_mismatch"))?;
            for (path, route) in &device.routes {
                route.validate()?;
                let action = model.action(path)?;
                ensure(supports_action(action), "unsupported_execution_route")?;
            }
        }
        for command in self.commands.values() {
            if let Some(route) = &command.execution_route {
                route.validate()?;
                ensure(
                    command.request.operation.kind == "action.invoke",
                    "unsupported_execution_route",
                )?;
            }
        }
        Ok(())
    }
}
