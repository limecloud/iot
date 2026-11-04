//! 固定On/Off状态与明确开关命令。协议受理不代替独立属性读取。
use crate::{
    session::Transport,
    zcl::{self, Attribute, Measurement},
    Error, OnOffTarget, Result, Signature,
};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncWrite};

const HOST: u8 = 239;
const CLUSTERS: [u16; 2] = [0, 6];

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OnOffCommandTarget {
    pub target: OnOffTarget,
    pub manufacturer_code: u16,
    pub signature: Signature,
    pub power: bool,
}
impl OnOffCommandTarget {
    pub fn validate(&self) -> Result<()> {
        self.target.validate()?;
        for text in [&self.signature.manufacturer, &self.signature.model] {
            if text.trim().is_empty() || text.len() > 32 || text.chars().any(char::is_control) {
                return Err(Error::InvalidInput);
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct OnOffReading {
    pub coordinator_ieee: String,
    pub ieee_address: String,
    pub network_address: u16,
    pub endpoint: u8,
    pub manufacturer_code: u16,
    pub signature: Signature,
    pub power: Measurement<bool>,
}

#[derive(Clone, Debug, Serialize)]
pub struct OnOffCommand {
    pub coordinator_ieee: String,
    pub ieee_address: String,
    pub network_address: u16,
    pub endpoint: u8,
    pub manufacturer_code: u16,
    pub signature: Signature,
    pub power_requested: bool,
    pub status: &'static str,
    pub device_state_confirmed: bool,
    pub accepted_at_unix_ms: u64,
}

pub(crate) async fn read<T: AsyncRead + AsyncWrite + Unpin>(
    io: &mut Transport<T>,
    state: &mut zcl::State,
    target: &OnOffTarget,
) -> Result<OnOffReading> {
    let identity = zcl::inspect(io, state, target, HOST, &CLUSTERS).await?;
    let (mut values, received_at_unix_ms) =
        zcl::attributes(io, state, identity.address, target.endpoint, HOST, 6, &[0]).await?;
    let Some(Attribute::Boolean(value)) = values.remove(&0) else {
        return Err(Error::InvalidResponse);
    };
    zcl::recheck(io, target, identity.address).await?;
    Ok(OnOffReading {
        coordinator_ieee: target.coordinator_ieee.clone(),
        ieee_address: target.ieee_address.clone(),
        network_address: identity.address,
        endpoint: target.endpoint,
        manufacturer_code: identity.manufacturer_code,
        signature: identity.signature,
        power: Measurement {
            value,
            received_at_unix_ms,
        },
    })
}

pub(crate) async fn set<T: AsyncRead + AsyncWrite + Unpin>(
    io: &mut Transport<T>,
    state: &mut zcl::State,
    request: &OnOffCommandTarget,
) -> Result<OnOffCommand> {
    let target = &request.target;
    let identity = zcl::inspect(io, state, target, HOST, &CLUSTERS).await?;
    if identity.manufacturer_code != request.manufacturer_code
        || identity.signature != request.signature
    {
        return Err(Error::SignatureMismatch);
    }
    // 以调用方核对的完整指纹和最新地址为界，写入前后均复核目标与协调器。
    zcl::recheck(io, target, identity.address).await?;
    let accepted_at_unix_ms =
        zcl::set_on_off(io, state, target, HOST, identity.address, request.power).await?;
    zcl::recheck(io, target, identity.address).await?;
    Ok(OnOffCommand {
        coordinator_ieee: target.coordinator_ieee.clone(),
        ieee_address: target.ieee_address.clone(),
        network_address: identity.address,
        endpoint: target.endpoint,
        manufacturer_code: identity.manufacturer_code,
        signature: identity.signature,
        power_requested: request.power,
        status: "protocol_accepted",
        device_state_confirmed: false,
        accepted_at_unix_ms,
    })
}
