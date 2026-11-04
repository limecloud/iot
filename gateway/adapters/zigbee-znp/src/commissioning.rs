//! 已有协调器的有限入网窗口；不创建网络、写入密钥或认领平台设备。
use crate::{
    discovery::valid_ieee,
    session::{ResponseMatch, Transport},
    zdo, Error, Probe, Result,
};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncWrite};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct JoinWindowTarget {
    pub coordinator_ieee: String,
    pub duration_seconds: u8,
}
impl JoinWindowTarget {
    pub fn validate(&self) -> Result<()> {
        if !valid_ieee(&self.coordinator_ieee) || self.duration_seconds > 120 {
            return Err(Error::InvalidInput);
        }
        Ok(())
    }
}

#[derive(Debug, Serialize)]
pub struct JoinWindow {
    pub ncp: Probe,
    pub coordinator_ieee: String,
    pub network_address: u16,
    pub scope: &'static str,
    pub duration_seconds: u8,
    pub trust_center_significance: u8,
    pub status: &'static str,
}

pub(crate) async fn permit_join<T: AsyncRead + AsyncWrite + Unpin>(
    io: &mut Transport<T>,
    target: &JoinWindowTarget,
) -> Result<JoinWindow> {
    let ncp = zdo::probe(io).await?;
    if ncp.capabilities & 0x10 == 0 {
        return Err(Error::CapabilityMissing);
    }
    if zdo::ieee(io, 0).await? != target.coordinator_ieee {
        return Err(Error::IdentityChanged);
    }
    let node = zdo::node(
        &io.request(5, 2, vec![0; 4], Some(ResponseMatch::Zdo(0x82, 0, None)))
            .await?,
    )?;
    if node.logical_type != 0 {
        return Err(Error::CoordinatorRequired);
    }
    // 16位单播到本协调器；0关闭，1..=120有限开放，禁止0xff永久开放。
    let response = io
        .request(
            5,
            0x36,
            vec![2, 0, 0, target.duration_seconds, 1],
            Some(ResponseMatch::PermitJoin),
        )
        .await?;
    if response[2] != 0 {
        return Err(Error::DeviceRejected(response[2]));
    }
    if zdo::ieee(io, 0).await? != target.coordinator_ieee {
        return Err(Error::IdentityChanged);
    }
    Ok(JoinWindow {
        ncp,
        coordinator_ieee: target.coordinator_ieee.clone(),
        network_address: 0,
        scope: "coordinator",
        duration_seconds: target.duration_seconds,
        trust_center_significance: 1,
        status: "protocol_accepted",
    })
}
