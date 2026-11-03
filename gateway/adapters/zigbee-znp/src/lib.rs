//! 第一方ZNP诊断与只读ZDO访谈。协议数据不取得平台身份或控制权。
mod frame;
#[cfg(unix)]
pub mod serial;
mod session;
mod zdo;

pub use session::Session;
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
    #[error("znp_session_closed")]
    SessionClosed,
    #[error("invalid_znp_input")]
    InvalidInput,
}

impl Error {
    pub fn status(&self) -> Option<u8> {
        match self {
            Self::RequestRejected(status) | Self::DeviceRejected(status) => Some(*status),
            _ => None,
        }
    }
}
