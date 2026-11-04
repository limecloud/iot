//! 固定ZCL读取和On/Off共用AF序号、端点与回执关联，不对外开放任意报文。
use crate::{
    session::{ResponseMatch, Transport},
    zdo, Endpoint, Error, Result,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::io::{AsyncRead, AsyncWrite};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct EndpointTarget {
    pub coordinator_ieee: String,
    pub ieee_address: String,
    pub endpoint: u8,
}
impl EndpointTarget {
    pub fn validate(&self) -> Result<()> {
        for value in [&self.coordinator_ieee, &self.ieee_address] {
            if value.len() != 16
                || !value
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                || value.bytes().all(|b| b == b'0')
                || value.bytes().all(|b| b == b'f')
            {
                return Err(Error::InvalidInput);
            }
        }
        if !(1..=240).contains(&self.endpoint) || self.coordinator_ieee == self.ieee_address {
            return Err(Error::InvalidInput);
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Signature {
    pub manufacturer: String,
    pub model: String,
    pub application_version: u8,
    pub hardware_version: u8,
}

#[derive(Clone, Debug, Serialize)]
pub struct Measurement<T> {
    pub value: T,
    pub received_at_unix_ms: u64,
}

#[derive(Default)]
pub(crate) struct State {
    host_ready: BTreeSet<u8>,
    next_id: u16,
}

fn ieee_bytes(value: &str) -> Result<[u8; 8]> {
    Ok(u64::from_str_radix(value, 16)
        .map_err(|_| Error::InvalidInput)?
        .to_le_bytes())
}
fn word(data: &[u8], at: usize) -> Result<u16> {
    let value = data.get(at..at + 2).ok_or(Error::InvalidResponse)?;
    Ok(u16::from_le_bytes([value[0], value[1]]))
}
fn timestamp() -> Result<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| Error::InvalidResponse)?
        .as_millis()
        .try_into()
        .map_err(|_| Error::InvalidResponse)
}

async fn local_descriptor<T: AsyncRead + AsyncWrite + Unpin>(
    io: &mut Transport<T>,
    host: u8,
) -> Result<Endpoint> {
    zdo::simple(
        &io.request(
            5,
            4,
            vec![0, 0, 0, 0, host],
            Some(ResponseMatch::Zdo(0x84, 0, Some(host))),
        )
        .await?,
    )
}

async fn ensure_host<T: AsyncRead + AsyncWrite + Unpin>(
    io: &mut Transport<T>,
    state: &mut State,
    host: u8,
    clusters: &[u16],
) -> Result<()> {
    if state.host_ready.contains(&host) {
        return Ok(());
    }
    let active = io
        .request(
            5,
            5,
            vec![0, 0, 0, 0],
            Some(ResponseMatch::Zdo(0x85, 0, None)),
        )
        .await?;
    if !zdo::active_endpoints(&active)?.contains(&host) {
        // AF_REGISTER只创建NCP运行期端点，不删除已有端点、不写NV或开放入网。
        let mut request = vec![host, 4, 1, 5, 0, 0, 0, 0, clusters.len() as u8];
        for cluster in clusters {
            request.extend_from_slice(&cluster.to_le_bytes());
        }
        let response = io.request(4, 0, request, None).await?;
        if response.len() != 1 {
            return Err(Error::InvalidResponse);
        }
        if response[0] != 0 {
            return Err(Error::RequestRejected(response[0]));
        }
    }
    let descriptor = local_descriptor(io, host).await?;
    let mut output = descriptor.output_clusters.clone();
    output.sort_unstable();
    if descriptor.profile_id != 0x0104
        || descriptor.device_id != 5
        || descriptor.device_version != 0
        || !descriptor.input_clusters.is_empty()
        || output != clusters
    {
        return Err(Error::EndpointConflict);
    }
    state.host_ready.insert(host);
    Ok(())
}

#[derive(Clone, Copy)]
struct Destination {
    address: u16,
    endpoint: u8,
    host: u8,
    cluster: u16,
}
enum Request<'a> {
    Attributes(&'a [u16]),
    OnOff(bool),
}

/// 同时核对MT受理、APS投递回执及ZCL属性响应；任一失败不返回采样。
async fn exchange<T: AsyncRead + AsyncWrite + Unpin>(
    io: &mut Transport<T>,
    state: &mut State,
    destination: Destination,
    command: Request<'_>,
) -> Result<(Vec<u8>, u64)> {
    let Destination {
        address,
        endpoint,
        host,
        cluster,
    } = destination;
    let id: u8 = state.next_id.try_into().map_err(|_| Error::LimitExceeded)?;
    state.next_id += 1;
    let zcl = match command {
        Request::Attributes(ids) => {
            let mut payload = vec![0x10, id, 0];
            for attribute in ids {
                payload.extend_from_slice(&attribute.to_le_bytes());
            }
            payload
        }
        // 保留Default Response，不提供Toggle或任意Cluster命令。
        Request::OnOff(power) => vec![0x01, id, u8::from(power)],
    };
    let mut request = address.to_le_bytes().to_vec();
    request.extend_from_slice(&[endpoint, host]);
    request.extend_from_slice(&cluster.to_le_bytes());
    request.extend_from_slice(&[id, 0x10, 30, zcl.len() as u8]);
    request.extend_from_slice(&zcl);
    io.send(4, 1, request).await?;
    let mut accepted = false;
    let mut delivered = false;
    let mut response = None;
    loop {
        let frame = io.next_frame().await?;
        match (frame.cmd0, frame.cmd1) {
            (0x64, 1) => {
                if accepted || frame.data.len() != 1 {
                    return Err(Error::UnexpectedResponse);
                }
                if frame.data[0] != 0 {
                    return Err(Error::RequestRejected(frame.data[0]));
                }
                accepted = true;
            }
            (0x44, 0x80) => {
                if frame.data.len() != 3 {
                    return Err(Error::InvalidResponse);
                }
                if frame.data[1] == host && frame.data[2] == id {
                    if delivered {
                        return Err(Error::UnexpectedResponse);
                    }
                    if frame.data[0] != 0 {
                        return Err(Error::DeliveryFailed(frame.data[0]));
                    }
                    delivered = true;
                } else {
                    io.skip_notification()?;
                }
            }
            (0x44, 0x81) => {
                let data = &frame.data;
                if data.len() < 20 {
                    return Err(Error::InvalidResponse);
                }
                let len = usize::from(data[16]);
                if data.len() != 20 + len {
                    return Err(Error::InvalidResponse);
                }
                if word(data, 0)? != 0
                    || word(data, 2)? != cluster
                    || word(data, 4)? != address
                    || data[6] != endpoint
                    || data[7] != host
                    || data[8] != 0
                {
                    io.skip_notification()?;
                    continue;
                }
                let payload = &data[17..17 + len];
                if payload.len() < 3 {
                    return Err(Error::InvalidResponse);
                }
                if payload[1] != id {
                    io.skip_notification()?;
                    continue;
                }
                if response.is_some() {
                    return Err(Error::UnexpectedResponse);
                }
                response = Some((payload.to_vec(), timestamp()?));
            }
            (cmd0, _) if cmd0 & 0xe0 == 0x40 => io.skip_notification()?,
            _ => return Err(Error::UnexpectedResponse),
        }
        if accepted && delivered {
            if let Some(response) = response.take() {
                return Ok(response);
            }
        }
    }
}

pub(crate) enum Attribute {
    Byte(u8),
    Boolean(bool),
    Unsigned(u16),
    Signed(i16),
    Text(String),
}
fn parse_attributes(payload: &[u8], ids: &[u16]) -> Result<BTreeMap<u16, Attribute>> {
    // 只接受全局、标准、server-to-client响应。厂商扩展需要独立映射。
    if payload.len() < 3 || payload[0] & 0xef != 0x08 {
        return Err(Error::InvalidResponse);
    }
    if payload[2] == 0x0b {
        if payload.len() != 5 || payload[3] != 0 {
            return Err(Error::InvalidResponse);
        }
        return Err(Error::ZclRejected(payload[4]));
    }
    if payload[2] != 1 {
        return Err(Error::InvalidResponse);
    }
    let mut at = 3;
    let mut result = BTreeMap::new();
    while at < payload.len() {
        let id = word(payload, at)?;
        at += 2;
        let status = *payload.get(at).ok_or(Error::InvalidResponse)?;
        at += 1;
        if status != 0 {
            return Err(Error::ZclRejected(status));
        }
        if !ids.contains(&id) || result.contains_key(&id) {
            return Err(Error::InvalidResponse);
        }
        let kind = *payload.get(at).ok_or(Error::InvalidResponse)?;
        at += 1;
        let value = match kind {
            0x10 => {
                let value = *payload.get(at).ok_or(Error::InvalidResponse)?;
                at += 1;
                if value > 1 {
                    return Err(Error::InvalidResponse);
                }
                Attribute::Boolean(value == 1)
            }
            0x20 => {
                let value = *payload.get(at).ok_or(Error::InvalidResponse)?;
                at += 1;
                Attribute::Byte(value)
            }
            0x21 => {
                let value = word(payload, at)?;
                at += 2;
                Attribute::Unsigned(value)
            }
            0x29 => {
                let value = word(payload, at)? as i16;
                at += 2;
                Attribute::Signed(value)
            }
            0x42 => {
                let len = usize::from(*payload.get(at).ok_or(Error::InvalidResponse)?);
                at += 1;
                if len == 0 || len > 32 {
                    return Err(Error::InvalidResponse);
                }
                let bytes = payload.get(at..at + len).ok_or(Error::InvalidResponse)?;
                at += len;
                let text = std::str::from_utf8(bytes).map_err(|_| Error::InvalidResponse)?;
                if text.trim().is_empty() || text.chars().any(char::is_control) {
                    return Err(Error::InvalidResponse);
                }
                Attribute::Text(text.to_owned())
            }
            _ => return Err(Error::InvalidResponse),
        };
        result.insert(id, value);
    }
    if result.len() != ids.len() {
        return Err(Error::InvalidResponse);
    }
    Ok(result)
}

pub(crate) async fn attributes<T: AsyncRead + AsyncWrite + Unpin>(
    io: &mut Transport<T>,
    state: &mut State,
    address: u16,
    endpoint: u8,
    host: u8,
    cluster: u16,
    ids: &[u16],
) -> Result<(BTreeMap<u16, Attribute>, u64)> {
    let (payload, received) = exchange(
        io,
        state,
        Destination {
            address,
            endpoint,
            host,
            cluster,
        },
        Request::Attributes(ids),
    )
    .await?;
    Ok((parse_attributes(&payload, ids)?, received))
}

pub(crate) struct Identity {
    pub address: u16,
    pub manufacturer_code: u16,
    pub signature: Signature,
}

pub(crate) async fn inspect<T: AsyncRead + AsyncWrite + Unpin>(
    io: &mut Transport<T>,
    state: &mut State,
    target: &EndpointTarget,
    host: u8,
    clusters: &[u16],
) -> Result<Identity> {
    let ncp = zdo::probe(io).await?;
    if ncp.capabilities & 0x14 != 0x14 {
        return Err(Error::CapabilityMissing);
    }
    if zdo::ieee(io, 0).await? != target.coordinator_ieee {
        return Err(Error::IdentityChanged);
    }
    let address = zdo::lookup(io, ieee_bytes(&target.ieee_address)?).await?;
    let interview = zdo::interview(io, address).await?;
    if interview.ieee_address != target.ieee_address {
        return Err(Error::IdentityChanged);
    }
    let endpoint = interview
        .endpoints
        .iter()
        .find(|ep| ep.endpoint == target.endpoint)
        .ok_or(Error::ProfileUnsupported)?;
    if endpoint.profile_id != 0x0104
        || !clusters.iter().all(|c| endpoint.input_clusters.contains(c))
    {
        return Err(Error::ProfileUnsupported);
    }
    ensure_host(io, state, host, clusters).await?;
    let (mut basic, _) =
        attributes(io, state, address, target.endpoint, host, 0, &[1, 3, 4, 5]).await?;
    let (
        Some(Attribute::Byte(application_version)),
        Some(Attribute::Byte(hardware_version)),
        Some(Attribute::Text(manufacturer)),
        Some(Attribute::Text(model)),
    ) = (
        basic.remove(&1),
        basic.remove(&3),
        basic.remove(&4),
        basic.remove(&5),
    )
    else {
        return Err(Error::InvalidResponse);
    };
    Ok(Identity {
        address,
        manufacturer_code: interview.node.manufacturer_code,
        signature: Signature {
            manufacturer,
            model,
            application_version,
            hardware_version,
        },
    })
}

pub(crate) async fn recheck<T: AsyncRead + AsyncWrite + Unpin>(
    io: &mut Transport<T>,
    target: &EndpointTarget,
    address: u16,
) -> Result<()> {
    if zdo::lookup(io, ieee_bytes(&target.ieee_address)?).await? != address
        || zdo::ieee(io, 0).await? != target.coordinator_ieee
    {
        return Err(Error::IdentityChanged);
    }
    Ok(())
}

pub(crate) async fn set_on_off<T: AsyncRead + AsyncWrite + Unpin>(
    io: &mut Transport<T>,
    state: &mut State,
    target: &EndpointTarget,
    host: u8,
    address: u16,
    power: bool,
) -> Result<u64> {
    let (payload, received) = exchange(
        io,
        state,
        Destination {
            address,
            endpoint: target.endpoint,
            host,
            cluster: 6,
        },
        Request::OnOff(power),
    )
    .await?;
    if payload.len() != 5
        || payload[0] & 0xef != 0x08
        || payload[2] != 0x0b
        || payload[3] != u8::from(power)
    {
        return Err(Error::InvalidResponse);
    }
    if payload[4] != 0 {
        return Err(Error::ZclRejected(payload[4]));
    }
    Ok(received)
}
