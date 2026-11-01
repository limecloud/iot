//! 云侧身份不产生本地执行权。配对经过本地审核，未知结果只允许查询原记录。
use crate::{digest, ensure, err, id, identifier, Result};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Principal {
    pub principal_id: String,
    pub issuer: String,
    pub subject: String,
    pub name: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Pairing {
    pub pairing_id: String,
    pub space_id: String,
    pub owner: Principal,
    pub challenge: String,
    pub scopes: Vec<String>,
    pub expires_at: DateTime<Utc>,
    pub claimed: bool,
    pub cancelled: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Review {
    pub control_origin: String,
    pub pairing: Pairing,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct CloudBinding {
    pub gateway_id: String,
    pub space_id: String,
    pub local_space_id: String,
    pub principal_id: String,
    pub public_key: String,
    pub scopes: Vec<String>,
    pub revision: String,
    pub active: bool,
    pub created_at: DateTime<Utc>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LinkRequest {
    pub space_id: String,
    pub idempotency_key: String,
    pub control_origin: String,
    pub pairing_id: String,
    pub code_digest: String,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum LinkStatus {
    Reviewing,
    AwaitingApproval,
    Claiming,
    Reconciling,
    Active,
    Unknown,
    Rejected,
    Expired,
    Revoked,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ControlLink {
    pub link_id: String,
    pub request: LinkRequest,
    pub request_digest: String,
    pub sealed_code: String,
    pub status: LinkStatus,
    pub review: Option<Review>,
    pub approved_at: Option<DateTime<Utc>>,
    pub binding: Option<CloudBinding>,
    pub error: Option<String>,
    pub created_at: DateTime<Utc>,
}
#[derive(Clone, Debug, Serialize)]
pub struct LinkView {
    pub link_id: String,
    pub idempotency_key: String,
    pub control_origin: String,
    pub pairing_id: String,
    pub status: LinkStatus,
    pub review: Option<Review>,
    pub review_revision: Option<String>,
    pub approved_at: Option<DateTime<Utc>>,
    pub binding: Option<CloudBinding>,
    pub error: Option<String>,
    pub created_at: DateTime<Utc>,
}
impl ControlLink {
    pub fn view(&self) -> Result<LinkView> {
        Ok(LinkView {
            link_id: self.link_id.clone(),
            idempotency_key: self.request.idempotency_key.clone(),
            control_origin: self.request.control_origin.clone(),
            pairing_id: self.request.pairing_id.clone(),
            status: self.status,
            review: self.review.clone(),
            review_revision: self.review.as_ref().map(digest).transpose()?,
            approved_at: self.approved_at,
            binding: self.binding.clone(),
            error: self.error.clone(),
            created_at: self.created_at,
        })
    }
    fn reserves_authority(&self) -> bool {
        self.status != LinkStatus::Revoked
            && (self.status == LinkStatus::Active || self.approved_at.is_some())
    }
}
pub fn hexadecimal(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub fn proof(origin: &str, pair: &Pairing, gateway: &str, local: &str, public: &str) -> String {
    [
        "LIMEIOT-PAIR-1",
        origin,
        &pair.pairing_id,
        &pair.challenge,
        &pair.space_id,
        gateway,
        local,
        &pair.owner.principal_id,
        public,
        &pair.expires_at.timestamp().to_string(),
    ]
    .join("\n")
}
impl crate::engine::Data {
    pub fn resolve_control_link(&self, key: &str) -> Result<&ControlLink> {
        self.control_links
            .values()
            .find(|v| v.request.idempotency_key == key)
            .ok_or_else(|| err("control_link_not_found"))
    }
    pub fn existing_control_link(&self, request: &LinkRequest) -> Result<Option<LinkView>> {
        ensure(request.space_id == self.space_id, "forbidden")?;
        if let Ok(existing) = self.resolve_control_link(&request.idempotency_key) {
            ensure(
                existing.request_digest == digest(request)?,
                "idempotency_conflict",
            )?;
            return existing.view().map(Some);
        };
        Ok(None)
    }
    pub fn create_control_link(
        &mut self,
        request: LinkRequest,
        sealed_code: String,
        now: DateTime<Utc>,
    ) -> Result<LinkView> {
        if let Some(existing) = self.existing_control_link(&request)? {
            return Ok(existing);
        }
        ensure(
            identifier(&request.idempotency_key)
                && identifier(&request.pairing_id)
                && hexadecimal(&request.code_digest),
            "invalid_request",
        )?;
        ensure(self.control_links.len() < 128, "capacity_exceeded")?;
        ensure(
            !self
                .control_links
                .values()
                .any(ControlLink::reserves_authority),
            "control_already_bound",
        )?;
        let value = ControlLink {
            link_id: id(),
            request_digest: digest(&request)?,
            request,
            sealed_code,
            status: LinkStatus::Reviewing,
            review: None,
            approved_at: None,
            binding: None,
            error: None,
            created_at: now,
        };
        let view = value.view()?;
        self.control_links.insert(value.link_id.clone(), value);
        Ok(view)
    }
    pub fn finish_control_review(
        &mut self,
        id: &str,
        result: Result<Review>,
        now: DateTime<Utc>,
    ) -> Result<LinkView> {
        let link = self
            .control_links
            .get_mut(id)
            .ok_or_else(|| err("control_link_not_found"))?;
        if link.status == LinkStatus::Revoked {
            return link.view();
        }
        ensure(
            link.approved_at.is_none()
                && matches!(
                    link.status,
                    LinkStatus::Reviewing | LinkStatus::Unknown | LinkStatus::Reconciling
                ),
            "invalid_transition",
        )?;
        let result = result.and_then(|review| {
            let p = &review.pairing;
            ensure(
                review.control_origin == link.request.control_origin
                    && p.pairing_id == link.request.pairing_id
                    && identifier(&p.space_id)
                    && identifier(&p.owner.principal_id)
                    && !p.owner.subject.is_empty()
                    && p.owner.subject.len() <= 255
                    && !p.owner.issuer.is_empty()
                    && p.owner.issuer.len() <= 512
                    && p.owner.name.chars().count() <= 160
                    && hexadecimal(&p.challenge),
                "control_invalid_response",
            )?;
            ensure(
                !p.claimed
                    && !p.cancelled
                    && p.expires_at > now
                    && p.expires_at <= now + Duration::seconds(120),
                "control_pairing_expired",
            )?;
            let allowed = [
                "commands.write",
                "devices.read",
                "rules.read",
                "rules.write",
            ];
            ensure(
                !p.scopes.is_empty()
                    && p.scopes.len() <= 4
                    && p.scopes
                        .iter()
                        .all(|scope| allowed.contains(&scope.as_str()))
                    && p.scopes.windows(2).all(|v| v[0] < v[1]),
                "control_invalid_scope",
            )?;
            Ok(review)
        });
        match result {
            Ok(review) => {
                link.review = Some(review);
                link.status = LinkStatus::AwaitingApproval;
                link.error = None
            }
            Err(error) => {
                link.status =
                    if error.code == "control_unknown" || error.code == "control_unavailable" {
                        LinkStatus::Unknown
                    } else if error.code == "control_pairing_expired" {
                        LinkStatus::Expired
                    } else {
                        LinkStatus::Rejected
                    };
                link.error = Some(error.code)
            }
        };
        link.view()
    }
    pub fn approve_control_link(
        &mut self,
        id: &str,
        revision: &str,
        now: DateTime<Utc>,
    ) -> Result<LinkView> {
        let link = self
            .control_links
            .get(id)
            .ok_or_else(|| err("control_link_not_found"))?;
        let review = link
            .review
            .as_ref()
            .ok_or_else(|| err("control_review_required"))?;
        ensure(digest(review)? == revision, "revision_conflict")?;
        ensure(link.status != LinkStatus::Revoked, "control_link_revoked")?;
        if link.approved_at.is_some() {
            return link.view();
        }
        ensure(
            link.status == LinkStatus::AwaitingApproval,
            "control_review_required",
        )?;
        ensure(review.pairing.expires_at > now, "control_pairing_expired")?;
        ensure(
            !self
                .control_links
                .values()
                .any(|v| v.link_id != id && v.reserves_authority()),
            "control_already_bound",
        )?;
        let link = self.control_links.get_mut(id).unwrap();
        link.approved_at = Some(now);
        link.status = LinkStatus::Claiming;
        link.error = None;
        link.view()
    }
    pub fn finish_control_claim(
        &mut self,
        id: &str,
        gateway: &str,
        public: &str,
        result: Result<CloudBinding>,
    ) -> Result<LinkView> {
        let link = self
            .control_links
            .get_mut(id)
            .ok_or_else(|| err("control_link_not_found"))?;
        if link.status == LinkStatus::Revoked {
            return link.view();
        };
        ensure(link.approved_at.is_some(), "control_review_required")?;
        let review = link
            .review
            .as_ref()
            .ok_or_else(|| err("control_review_required"))?;
        let result = result.and_then(|b| {
            ensure(
                b.gateway_id == gateway
                    && b.public_key == public
                    && b.space_id == review.pairing.space_id
                    && b.local_space_id == self.space_id
                    && b.principal_id == review.pairing.owner.principal_id
                    && b.scopes == review.pairing.scopes
                    && b.revision.starts_with("rev-")
                    && hexadecimal(&b.revision[4..]),
                "control_invalid_response",
            )?;
            if let Some(old) = &link.binding {
                ensure(old.revision == b.revision, "control_invalid_response")?
            };
            Ok(b)
        });
        match result {
            Ok(binding) => {
                link.status = if binding.active {
                    LinkStatus::Active
                } else {
                    LinkStatus::Revoked
                };
                link.binding = Some(binding);
                link.error = None
            }
            Err(error) => {
                link.status = LinkStatus::Unknown;
                link.error = Some(error.code)
            }
        };
        link.view()
    }
    pub fn revoke_control_link(&mut self, id: &str) -> Result<LinkView> {
        let link = self
            .control_links
            .get_mut(id)
            .ok_or_else(|| err("control_link_not_found"))?;
        link.status = LinkStatus::Revoked;
        link.error = None;
        link.view()
    }
    pub fn reconcile_control_link(&mut self, id: &str) -> Result<LinkView> {
        let link = self
            .control_links
            .get_mut(id)
            .ok_or_else(|| err("control_link_not_found"))?;
        ensure(
            matches!(link.status, LinkStatus::Unknown | LinkStatus::Active),
            "invalid_transition",
        )?;
        link.status = LinkStatus::Reconciling;
        link.view()
    }
}
pub type Links = BTreeMap<String, ControlLink>;
