//! 固定动作白名单共用领域状态机；帧不能选择本地身份、URL或任意工具。
use crate::application::App;
use chrono::{DateTime, Utc};
use limeiot_core::{
    control::ControlLink, engine::Command, ensure, err, identifier, protocol::CommandRequest,
    remote::RemoteAuthority, Result,
};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub connection_id: String,
    pub request_id: String,
    pub binding_revision: String,
    pub space_id: String,
    pub local_space_id: String,
    pub principal_id: String,
    pub expires_at: DateTime<Utc>,
    pub action: String,
    pub payload: Value,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Create {
    remote_id: String,
    command: CommandRequest,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Original {
    remote_id: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Page {
    after: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Model {
    revision: String,
}

fn payload<T: serde::de::DeserializeOwned>(value: Value) -> Result<T> {
    serde_json::from_value(value).map_err(|_| err("invalid_remote_request"))
}
fn receipt(command: Command) -> Value {
    json!({"command_id":command.command_id,"request":command.request,"request_digest":command.request_digest,
        "status":command.status,"evidence":command.evidence,"error":command.error})
}
pub async fn execute(
    app: &App,
    link: &ControlLink,
    connection: &str,
    request: Request,
) -> Result<Value> {
    let binding = link
        .binding
        .as_ref()
        .ok_or_else(|| err("remote_authorization_rejected"))?;
    ensure(
        request.connection_id == connection
            && request.request_id.starts_with("rpc-")
            && identifier(&request.request_id),
        "invalid_remote_request",
    )?;
    let authority = RemoteAuthority {
        link_id: link.link_id.clone(),
        control_origin: link.request.control_origin.clone(),
        cloud_space_id: request.space_id,
        local_space_id: request.local_space_id,
        principal_id: request.principal_id,
        binding_revision: request.binding_revision,
        expires_at: request.expires_at,
    };
    ensure(
        authority.binding_revision == binding.revision,
        "remote_authorization_rejected",
    )?;
    let now = Utc::now();
    match request.action.as_str() {
        "commands.create" => {
            let input: Create = payload(request.payload)?;
            // 核对授权、去重及创建均在同一个SQLite事务中，本地撤销不能穿过检查与提交。
            app.update("remote.command.accepted", |data| {
                data.create_remote_command(authority, &input.remote_id, input.command, now)
                    .map(receipt)
            })
            .await
        }
        "commands.get" => {
            let input: Original = payload(request.payload)?;
            let store = app.store.lock().await;
            store
                .data
                .remote_command(&authority, &input.remote_id, now)
                .map(receipt)
        }
        "devices.list" => {
            let page: Page = payload(request.payload)?;
            ensure(
                page.after.is_empty() || identifier(&page.after),
                "invalid_remote_request",
            )?;
            let store = app.store.lock().await;
            store
                .data
                .authorize_remote(&authority, "devices.read", now)?;
            let devices: Vec<_> = store
                .data
                .devices
                .values()
                .filter(|d| d.device_id > page.after)
                .take(9)
                .collect();
            let next = if devices.len() > 8 {
                Some(devices[7].device_id.clone())
            } else {
                None
            };
            let items:Vec<_>=devices.into_iter().take(8).map(|d|json!({"device_id":d.device_id,"model_revision":d.model_revision,
                "ready":d.ready && d.last_seen.is_some_and(|last|now-last<chrono::Duration::seconds(15)),
                "state_revision":d.state_revision,"reported":d.reported,"last_seen":d.last_seen})).collect();
            Ok(json!({"items":items,"next":next,"binding_revision":binding.revision}))
        }
        "models.get" => {
            let input: Model = payload(request.payload)?;
            let store = app.store.lock().await;
            store
                .data
                .authorize_remote(&authority, "devices.read", now)?;
            let model = store
                .data
                .models
                .get(&input.revision)
                .ok_or_else(|| err("model_not_found"))?;
            Ok(json!({"revision":input.revision,"model":model}))
        }
        _ => Err(err("remote_action_rejected")),
    }
}
