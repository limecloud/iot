//! 远程传输只提交受限领域动作；当前本地配对决定执行权。
use crate::{
    control::LinkStatus,
    engine::{Command, Data},
    ensure, err, identifier,
    protocol::CommandRequest,
    Result,
};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RemoteAuthority {
    pub link_id: String,
    pub control_origin: String,
    pub cloud_space_id: String,
    pub local_space_id: String,
    pub principal_id: String,
    pub binding_revision: String,
    pub expires_at: DateTime<Utc>,
}

impl Data {
    pub fn authorize_remote(
        &self,
        authority: &RemoteAuthority,
        scope: &str,
        now: DateTime<Utc>,
    ) -> Result<()> {
        ensure(
            authority.expires_at > now && authority.expires_at <= now + Duration::seconds(10),
            "remote_authorization_expired",
        )?;
        let link = self
            .control_links
            .get(&authority.link_id)
            .ok_or_else(|| err("remote_authorization_rejected"))?;
        let binding = link
            .binding
            .as_ref()
            .ok_or_else(|| err("remote_authorization_rejected"))?;
        ensure(
            link.status == LinkStatus::Active
                && link.approved_at.is_some()
                && binding.active
                && link.request.control_origin == authority.control_origin
                && self.space_id == authority.local_space_id
                && binding.local_space_id == authority.local_space_id
                && binding.space_id == authority.cloud_space_id
                && binding.principal_id == authority.principal_id
                && binding.revision == authority.binding_revision
                && binding.scopes.iter().any(|s| s == scope),
            "remote_authorization_rejected",
        )
    }

    pub fn create_remote_command(
        &mut self,
        authority: RemoteAuthority,
        remote_id: &str,
        mut request: CommandRequest,
        now: DateTime<Utc>,
    ) -> Result<Command> {
        self.authorize_remote(&authority, "commands.write", now)?;
        ensure(
            remote_id.starts_with("remote-") && identifier(remote_id),
            "invalid_remote_id",
        )?;
        request.space_id = self.space_id.clone();
        request.idempotency_key = remote_id.into();
        if let Some(command_id) = self.keys.get(remote_id) {
            let command = &self.commands[command_id];
            ensure(
                command
                    .remote_authority
                    .as_ref()
                    .is_some_and(|a| same_identity(a, &authority)),
                "idempotency_conflict",
            )?;
        }
        let command = self.create_command(request, now, None)?;
        let command = self
            .commands
            .get_mut(&command.command_id)
            .ok_or_else(|| err("command_not_found"))?;
        if command.remote_authority.is_none() {
            command.remote_authority = Some(authority);
        }
        Ok(command.clone())
    }

    pub fn remote_command(
        &self,
        authority: &RemoteAuthority,
        remote_id: &str,
        now: DateTime<Utc>,
    ) -> Result<Command> {
        self.authorize_remote(authority, "commands.write", now)?;
        let id = self
            .keys
            .get(remote_id)
            .ok_or_else(|| err("command_not_found"))?;
        let command = &self.commands[id];
        ensure(
            command
                .remote_authority
                .as_ref()
                .is_some_and(|a| same_identity(a, authority)),
            "command_not_found",
        )?;
        Ok(command.clone())
    }
}
fn same_identity(a: &RemoteAuthority, b: &RemoteAuthority) -> bool {
    a.link_id == b.link_id
        && a.control_origin == b.control_origin
        && a.cloud_space_id == b.cloud_space_id
        && a.local_space_id == b.local_space_id
        && a.principal_id == b.principal_id
        && a.binding_revision == b.binding_revision
}
