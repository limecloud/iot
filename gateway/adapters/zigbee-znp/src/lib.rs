//! 第一方ZNP诊断、ZDO访谈、固定属性、On/Off与有限入网。协议数据不取得平台身份。
mod commissioning;
mod discovery;
mod environment;
mod frame;
mod on_off;
#[cfg(unix)]
pub mod serial;
mod session;
mod zcl;
mod zdo;

pub use commissioning::{JoinWindow, JoinWindowTarget};
pub use discovery::{DiscoveryTarget, InterviewTarget, Neighbor, Neighbors};
pub use environment::EnvironmentReading;
pub use on_off::{OnOffCommand, OnOffCommandTarget, OnOffReading};
pub use session::Session;
pub use zcl::{EndpointTarget as EnvironmentTarget, EndpointTarget as OnOffTarget, Signature};
pub use zdo::{Endpoint, Interview, NodeDescriptor, Probe};

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("serial_io_failed")]
    Io(#[from] std::io::Error),
    #[error("znp_timeout")]
    Timeout,
    #[error("znp_cancelled")]
    Cancelled,
    #[error("znp_invalid_frame")]
    InvalidFrame,
    #[error("znp_invalid_response")]
    InvalidResponse,
    #[error("znp_unexpected_response")]
    UnexpectedResponse,
    #[error("znp_reset")]
    Reset,
    #[error("znp_limit_exceeded")]
    LimitExceeded,
    #[error("znp_request_rejected")]
    RequestRejected(u8),
    #[error("znp_device_rejected")]
    DeviceRejected(u8),
    #[error("znp_capability_missing")]
    CapabilityMissing,
    #[error("znp_identity_changed")]
    IdentityChanged,
    #[error("znp_signature_mismatch")]
    SignatureMismatch,
    #[error("znp_coordinator_required")]
    CoordinatorRequired,
    #[error("znp_neighbor_table_changed")]
    NeighborTableChanged,
    #[error("znp_endpoint_conflict")]
    EndpointConflict,
    #[error("znp_profile_unsupported")]
    ProfileUnsupported,
    #[error("znp_zcl_rejected")]
    ZclRejected(u8),
    #[error("znp_delivery_failed")]
    DeliveryFailed(u8),
    #[error("znp_session_closed")]
    SessionClosed,
    #[error("invalid_znp_input")]
    InvalidInput,
}

impl Error {
    pub fn status(&self) -> Option<u8> {
        match self {
            Self::RequestRejected(status)
            | Self::DeviceRejected(status)
            | Self::ZclRejected(status)
            | Self::DeliveryFailed(status) => Some(*status),
            _ => None,
        }
    }
}
