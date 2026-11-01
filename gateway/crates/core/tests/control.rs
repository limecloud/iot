use chrono::{Duration, Utc};
use limeiot_core::{
    control::*,
    digest,
    engine::{Config, Data},
    err,
};

fn data() -> Data {
    let config: Config =
        serde_json::from_str(include_str!("../../../../deploy/dev/config.json")).unwrap();
    Data::new(config).unwrap()
}
fn input(key: &str) -> LinkRequest {
    LinkRequest {
        space_id: "space-demo".into(),
        idempotency_key: key.into(),
        control_origin: "https://iot.example".into(),
        pairing_id: "pair-original".into(),
        code_digest: "a".repeat(64),
    }
}
fn review() -> Review {
    Review {
        control_origin: "https://iot.example".into(),
        pairing: Pairing {
            pairing_id: "pair-original".into(),
            space_id: "cloud-home".into(),
            owner: Principal {
                principal_id: "cloud-owner".into(),
                issuer: "https://identity.example".into(),
                subject: "owner".into(),
                name: "家庭所有者".into(),
            },
            challenge: "b".repeat(64),
            scopes: vec!["commands.write".into(), "devices.read".into()],
            expires_at: Utc::now() + Duration::seconds(110),
            claimed: false,
            cancelled: false,
        },
    }
}
fn binding() -> CloudBinding {
    CloudBinding {
        gateway_id: "gateway".into(),
        space_id: "cloud-home".into(),
        local_space_id: "space-demo".into(),
        principal_id: "cloud-owner".into(),
        public_key: "public".into(),
        scopes: vec!["commands.write".into(), "devices.read".into()],
        revision: format!("rev-{}", "d".repeat(64)),
        active: true,
        created_at: Utc::now(),
    }
}
#[test]
fn review_does_not_authorize_and_approval_binds_the_reviewed_revision() {
    let mut d = data();
    let request = input("one");
    let initial = d
        .create_control_link(request.clone(), "ciphertext".into(), Utc::now())
        .unwrap();
    let ready = d
        .finish_control_review(&initial.link_id, Ok(review()), Utc::now())
        .unwrap();
    assert_eq!(ready.status, LinkStatus::AwaitingApproval);
    assert!(ready.approved_at.is_none());
    assert!(d.commands.is_empty());
    assert!(d.deployments.is_empty());
    assert_eq!(
        d.approve_control_link(&ready.link_id, "wrong", Utc::now())
            .unwrap_err()
            .code,
        "revision_conflict"
    );
    let approved = d
        .approve_control_link(
            &ready.link_id,
            ready.review_revision.as_ref().unwrap(),
            Utc::now(),
        )
        .unwrap();
    assert_eq!(approved.status, LinkStatus::Claiming);
    let original = d
        .create_control_link(request, "different-ciphertext".into(), Utc::now())
        .unwrap();
    assert_eq!(original.link_id, ready.link_id);
    assert_eq!(original.status, LinkStatus::Claiming);
    let public = serde_json::to_string(&approved).unwrap();
    assert!(
        !public.contains("ciphertext")
            && !public.contains("code_digest")
            && !public.contains("sealed_code")
    );
    assert_eq!(
        d.create_control_link(input("two"), "sealed".into(), Utc::now())
            .unwrap_err()
            .code,
        "control_already_bound"
    );
}
#[test]
fn unknown_claim_requires_original_query_and_revoke_cannot_be_undone() {
    let mut d = data();
    let initial = d
        .create_control_link(input("one"), "sealed".into(), Utc::now())
        .unwrap();
    let r = review();
    let revision = digest(&r).unwrap();
    d.finish_control_review(&initial.link_id, Ok(r), Utc::now())
        .unwrap();
    d.approve_control_link(&initial.link_id, &revision, Utc::now())
        .unwrap();
    d.recover();
    assert_eq!(
        d.resolve_control_link("one").unwrap().status,
        LinkStatus::Unknown
    );
    let unknown = d
        .finish_control_claim(
            &initial.link_id,
            "gateway",
            "public",
            Err(err("control_unknown")),
        )
        .unwrap();
    assert!(unknown.binding.is_none());
    assert_eq!(
        d.approve_control_link(&initial.link_id, &revision, Utc::now())
            .unwrap()
            .status,
        LinkStatus::Unknown
    );
    d.reconcile_control_link(&initial.link_id).unwrap();
    assert_eq!(
        d.finish_control_claim(&initial.link_id, "gateway", "public", Ok(binding()))
            .unwrap()
            .status,
        LinkStatus::Active
    );
    d.revoke_control_link(&initial.link_id).unwrap();
    assert_eq!(
        d.finish_control_claim(&initial.link_id, "gateway", "public", Ok(binding()))
            .unwrap()
            .status,
        LinkStatus::Revoked
    );
    assert_eq!(
        d.approve_control_link(&initial.link_id, &revision, Utc::now())
            .unwrap_err()
            .code,
        "control_link_revoked"
    );
    assert!(d
        .create_control_link(input("new"), "sealed".into(), Utc::now())
        .is_ok());
}
#[test]
fn scope_owner_and_expiry_changes_do_not_gain_authority() {
    for mode in ["scope", "origin", "claimed", "expired"] {
        let mut d = data();
        let v = d
            .create_control_link(input(mode), "sealed".into(), Utc::now())
            .unwrap();
        let mut r = review();
        match mode {
            "scope" => r.pairing.scopes = vec!["*".into()],
            "origin" => r.control_origin = "https://other.example".into(),
            "claimed" => r.pairing.claimed = true,
            _ => r.pairing.expires_at = Utc::now() - Duration::seconds(1),
        };
        let ended = d
            .finish_control_review(&v.link_id, Ok(r), Utc::now())
            .unwrap();
        assert!(matches!(
            ended.status,
            LinkStatus::Rejected | LinkStatus::Expired
        ));
        assert!(ended.approved_at.is_none());
        assert!(ended.binding.is_none())
    }
    let mut d = data();
    let v = d
        .create_control_link(input("one"), "sealed".into(), Utc::now())
        .unwrap();
    let r = review();
    let revision = digest(&r).unwrap();
    d.finish_control_review(&v.link_id, Ok(r.clone()), Utc::now())
        .unwrap();
    assert_eq!(
        d.approve_control_link(&v.link_id, &revision, r.pairing.expires_at)
            .unwrap_err()
            .code,
        "control_pairing_expired"
    );
    let mut changed = input("one");
    changed.pairing_id = "another".into();
    assert_eq!(
        d.existing_control_link(&changed).unwrap_err().code,
        "idempotency_conflict"
    );
}
#[test]
fn mismatched_binding_is_unknown_and_cannot_replace_the_approved_scope() {
    let mut d = data();
    let v = d
        .create_control_link(input("one"), "sealed".into(), Utc::now())
        .unwrap();
    let r = review();
    let revision = digest(&r).unwrap();
    d.finish_control_review(&v.link_id, Ok(r), Utc::now())
        .unwrap();
    d.approve_control_link(&v.link_id, &revision, Utc::now())
        .unwrap();
    let mut b = binding();
    b.scopes.push("rules.write".into());
    let result = d
        .finish_control_claim(&v.link_id, "gateway", "public", Ok(b))
        .unwrap();
    assert_eq!(result.status, LinkStatus::Unknown);
    assert!(result.binding.is_none());
    assert_eq!(
        d.create_control_link(input("new"), "sealed".into(), Utc::now())
            .unwrap_err()
            .code,
        "control_already_bound"
    );
}
