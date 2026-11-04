//! 固定HA环境传感器读取，复用第一方ZCL传输，不提供任意ZCL命令。
use crate::{
    session::Transport,
    zcl::{self, Attribute, Measurement, Signature},
    EnvironmentTarget, Error, Result,
};
use serde::Serialize;
use tokio::io::{AsyncRead, AsyncWrite};

const HOST: u8 = 240;
const CLUSTERS: [u16; 3] = [0, 0x0402, 0x0405];

#[derive(Clone, Debug, Serialize)]
pub struct EnvironmentReading {
    pub coordinator_ieee: String,
    pub ieee_address: String,
    pub network_address: u16,
    pub endpoint: u8,
    pub manufacturer_code: u16,
    pub signature: Signature,
    pub temperature_celsius_x100: Measurement<i16>,
    pub humidity_percent_x100: Measurement<u16>,
}

pub(crate) async fn read<T: AsyncRead + AsyncWrite + Unpin>(
    io: &mut Transport<T>,
    state: &mut zcl::State,
    target: &EnvironmentTarget,
) -> Result<EnvironmentReading> {
    let identity = zcl::inspect(io, state, target, HOST, &CLUSTERS).await?;
    let (mut temperature, temperature_time) = zcl::attributes(
        io,
        state,
        identity.address,
        target.endpoint,
        HOST,
        0x0402,
        &[0],
    )
    .await?;
    let Some(Attribute::Signed(temperature)) = temperature.remove(&0) else {
        return Err(Error::InvalidResponse);
    };
    let (mut humidity, humidity_time) = zcl::attributes(
        io,
        state,
        identity.address,
        target.endpoint,
        HOST,
        0x0405,
        &[0],
    )
    .await?;
    let Some(Attribute::Unsigned(humidity)) = humidity.remove(&0) else {
        return Err(Error::InvalidResponse);
    };
    // 与当前平台环境模型精确一致；无效值与模型范围外值不钳制。
    if !(-4500..=13000).contains(&temperature) || humidity > 10000 {
        return Err(Error::InvalidResponse);
    }
    zcl::recheck(io, target, identity.address).await?;
    Ok(EnvironmentReading {
        coordinator_ieee: target.coordinator_ieee.clone(),
        ieee_address: target.ieee_address.clone(),
        network_address: identity.address,
        endpoint: target.endpoint,
        manufacturer_code: identity.manufacturer_code,
        signature: identity.signature,
        temperature_celsius_x100: Measurement {
            value: temperature,
            received_at_unix_ms: temperature_time,
        },
        humidity_percent_x100: Measurement {
            value: humidity,
            received_at_unix_ms: humidity_time,
        },
    })
}
