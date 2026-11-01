use chrono::{Duration, Utc};
use limeiot_core::{
    control::*,
    engine::{Config, Data},
    protocol::CommandRequest,
    remote::RemoteAuthority,
};
use serde_json::json;

fn paired() -> (Data, RemoteAuthority) {
    let config: Config =
        serde_json::from_str(include_str!("../../../../deploy/dev/config.json")).unwrap();
    let mut data = Data::new(config).unwrap();
    let now = Utc::now();
    let device = data.devices.get_mut("device-lamp").unwrap();
    device.ready = true;
    device.last_seen = Some(now);
    device.session_id = Some("session-test".into());
    let request = LinkRequest {
        space_id: data.space_id.clone(),
        idempotency_key: "pair-test".into(),
        control_origin: "https://iot.example".into(),
        pairing_id: "pair-test".into(),
        code_digest: "a".repeat(64),
    };
    let link = data
        .create_control_link(request, "sealed".into(), now)
        .unwrap();
    let scopes = vec!["commands.write".into(), "devices.read".into()];
    let review = Review {
        control_origin: "https://iot.example".into(),
        pairing: Pairing {
            pairing_id: "pair-test".into(),
            space_id: "cloud-home".into(),
            owner: Principal {
                principal_id: "p-owner".into(),
                issuer: "https://id.example".into(),
                subject: "owner".into(),
                name: "所有者".into(),
            },
            challenge: "b".repeat(64),
            scopes: scopes.clone(),
            expires_at: now + Duration::seconds(110),
            claimed: false,
            cancelled: false,
        },
    };
    let reviewed = data
        .finish_control_review(&link.link_id, Ok(review), now)
        .unwrap();
    data.approve_control_link(
        &link.link_id,
        reviewed.review_revision.as_ref().unwrap(),
        now,
    )
    .unwrap();
    let binding = CloudBinding {
        gateway_id: "gw-test".into(),
        space_id: "cloud-home".into(),
        local_space_id: data.space_id.clone(),
        principal_id: "p-owner".into(),
        public_key: "public-test".into(),
        scopes,
        revision: format!("rev-{}", "d".repeat(64)),
        active: true,
        created_at: now,
    };
    assert_eq!(
        data.finish_control_claim(&link.link_id, "gw-test", "public-test", Ok(binding))
            .unwrap()
            .status,
        LinkStatus::Active
    );
    let authority = RemoteAuthority {
        link_id: link.link_id,
        control_origin: "https://iot.example".into(),
        cloud_space_id: "cloud-home".into(),
        local_space_id: data.space_id.clone(),
        principal_id: "p-owner".into(),
        binding_revision: format!("rev-{}", "d".repeat(64)),
        expires_at: now + Duration::seconds(9),
    };
    (data, authority)
}
fn input(data: &Data) -> CommandRequest {
    serde_json::from_value(json!({"space_id":data.space_id,"idempotency_key":"caller-key","device_id":"device-lamp","model_revision":data.devices["device-lamp"].model_revision,"expires_at":Utc::now()+Duration::seconds(25),"operation":{"type":"property.set","path":"light.power","value":true}})).unwrap()
}

#[test]
fn both_binding_identity_and_scope_are_current_for_every_remote_action() {
    let (mut data, authority) = paired();
    for field in [
        "origin",
        "cloud",
        "local",
        "principal",
        "revision",
        "expired",
        "too-long",
    ] {
        let mut changed = authority.clone();
        match field {
            "origin" => changed.control_origin = "https://other.example".into(),
            "cloud" => changed.cloud_space_id = "other".into(),
            "local" => changed.local_space_id = "other".into(),
            "principal" => changed.principal_id = "other".into(),
            "revision" => changed.binding_revision = "old".into(),
            "expired" => changed.expires_at = Utc::now(),
            _ => changed.expires_at = Utc::now() + Duration::seconds(11),
        }
        assert!(
            data.create_remote_command(changed, "remote-one", input(&data), Utc::now())
                .is_err(),
            "{field}"
        );
    }
    data.control_links
        .get_mut(&authority.link_id)
        .unwrap()
        .binding
        .as_mut()
        .unwrap()
        .scopes = vec!["devices.read".into()];
    assert!(data
        .create_remote_command(authority, "remote-one", input(&data), Utc::now())
        .is_err());
    assert!(data.commands.is_empty());
}

#[test]
fn remote_keys_do_not_expose_local_commands_and_never_change_original_parameters() {
    let (mut data, authority) = paired();
    let request = input(&data);
    let created = data
        .create_remote_command(authority.clone(), "remote-one", request.clone(), Utc::now())
        .unwrap();
    assert_eq!(
        data.create_remote_command(authority.clone(), "remote-one", request.clone(), Utc::now())
            .unwrap()
            .command_id,
        created.command_id
    );
    let mut changed = request;
    changed.operation.value = json!(false);
    assert_eq!(
        data.create_remote_command(authority.clone(), "remote-one", changed, Utc::now())
            .unwrap_err()
            .code,
        "idempotency_conflict"
    );
    let mut local = input(&data);
    local.idempotency_key = "remote-local-collision".into();
    data.create_command(local.clone(), Utc::now(), None)
        .unwrap();
    assert_eq!(
        data.remote_command(&authority, "remote-local-collision", Utc::now())
            .unwrap_err()
            .code,
        "command_not_found"
    );
    assert_eq!(
        data.create_remote_command(authority, "remote-local-collision", local, Utc::now())
            .unwrap_err()
            .code,
        "idempotency_conflict"
    );
}

#[test]
fn revoke_or_expired_delegation_before_dispatch_cannot_reach_the_device() {
    for revoke in [true, false] {
        let (mut data, authority) = paired();
        let now = Utc::now();
        let command = data
            .create_remote_command(authority.clone(), "remote-one", input(&data), now)
            .unwrap();
        let dispatch_at = if revoke {
            data.revoke_control_link(&authority.link_id).unwrap();
            now
        } else {
            authority.expires_at
        };
        assert!(data.prepare_dispatch(dispatch_at).is_empty());
        assert_eq!(data.commands[&command.command_id].status, "rejected");
        assert_eq!(
            data.commands[&command.command_id].error.as_deref(),
            Some("remote_authorization_rejected")
        );
    }
}

#[test]
fn recovery_queries_the_durable_remote_command_without_renewing_or_replaying_it() {
    let (mut data, authority) = paired();
    let request = input(&data);
    let command = data
        .create_remote_command(authority.clone(), "remote-one", request.clone(), Utc::now())
        .unwrap();
    assert_eq!(data.prepare_dispatch(Utc::now()).len(), 1);
    let mut restored: Data = serde_json::from_str(&serde_json::to_string(&data).unwrap()).unwrap();
    restored.recover();
    assert!(restored.prepare_dispatch(Utc::now()).is_empty());
    assert_eq!(
        restored
            .remote_command(&authority, "remote-one", Utc::now())
            .unwrap()
            .status,
        "unknown"
    );
    let mut fresh = authority;
    fresh.expires_at = Utc::now() + Duration::seconds(10);
    assert_eq!(
        restored
            .create_remote_command(fresh, "remote-one", request, Utc::now())
            .unwrap()
            .command_id,
        command.command_id
    );
    assert_eq!(restored.commands.len(), 1);
    assert!(restored.prepare_dispatch(Utc::now()).is_empty());
}
