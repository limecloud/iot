use crate::{session::Transport, Error, Result};
use serde::Serialize;
use tokio::io::{AsyncRead, AsyncWrite};

#[derive(Debug, Serialize)]
pub struct Probe {
    pub capabilities: u16,
    pub transport_revision: u8,
    pub product_id: u8,
    pub major: u8,
    pub minor: u8,
    pub maintenance: u8,
    // 固件定制的版本扩展保留原字节，不猜测其修订/引导类型。
    pub version_extension: Vec<u8>,
}

#[derive(Debug, Serialize)]
pub struct NodeDescriptor {
    pub logical_type: u8,
    pub flags: u8,
    pub frequency_band_flags: u8,
    pub mac_capabilities: u8,
    pub manufacturer_code: u16,
    pub max_buffer_size: u8,
    pub max_incoming_transfer_size: u16,
    pub server_mask: u16,
    pub max_outgoing_transfer_size: u16,
    pub descriptor_capability: u8,
}

#[derive(Debug, Serialize)]
pub struct Endpoint {
    pub endpoint: u8,
    pub profile_id: u16,
    pub device_id: u16,
    pub device_version: u8,
    pub input_clusters: Vec<u16>,
    pub output_clusters: Vec<u16>,
}

#[derive(Debug, Serialize)]
pub struct Interview {
    pub ncp: Probe,
    pub network_address: u16,
    pub ieee_address: String,
    pub node: NodeDescriptor,
    pub endpoints: Vec<Endpoint>,
}

fn word(data: &[u8], offset: usize) -> Result<u16> {
    let bytes = data.get(offset..offset + 2).ok_or(Error::InvalidResponse)?;
    Ok(u16::from_le_bytes([bytes[0], bytes[1]]))
}

pub(crate) fn matches(cmd: u8, data: &[u8], address: u16, endpoint: Option<u8>) -> Result<bool> {
    if cmd == 0x81 {
        // IEEE响应与其他ZDO响应不同，没有源短地址前缀。
        return Ok(word(data, 9)? == address);
    }
    if word(data, 0)? != address || word(data, 3)? != address {
        return Ok(false);
    }
    if data[2] != 0 {
        return Err(Error::DeviceRejected(data[2]));
    }
    if let Some(endpoint) = endpoint {
        return Ok(*data.get(6).ok_or(Error::InvalidResponse)? == endpoint);
    }
    Ok(true)
}

pub(crate) async fn probe<T: AsyncRead + AsyncWrite + Unpin>(
    io: &mut Transport<T>,
) -> Result<Probe> {
    let capabilities = io.request(1, 1, vec![], None).await?;
    if capabilities.len() != 2 {
        return Err(Error::InvalidResponse);
    }
    let capabilities = word(&capabilities, 0)?;
    if capabilities & 1 == 0 {
        return Err(Error::CapabilityMissing);
    }
    let version = io.request(1, 2, vec![], None).await?;
    if !(5..=16).contains(&version.len()) {
        return Err(Error::InvalidResponse);
    }
    Ok(Probe {
        capabilities,
        transport_revision: version[0],
        product_id: version[1],
        major: version[2],
        minor: version[3],
        maintenance: version[4],
        version_extension: version[5..].to_vec(),
    })
}

async fn ieee<T: AsyncRead + AsyncWrite + Unpin>(
    io: &mut Transport<T>,
    address: u16,
) -> Result<String> {
    let mut request = address.to_le_bytes().to_vec();
    request.extend_from_slice(&[0, 0]); // 单设备地址请求，不请求关联设备列表。
    let data = io
        .request(5, 1, request, Some((0x81, address, None)))
        .await?;
    if data.first() != Some(&0) {
        return Err(Error::DeviceRejected(
            *data.first().ok_or(Error::InvalidResponse)?,
        ));
    }
    // 固定TI参考实现总是附加startIndex和关联计数。
    if data.len() != 13
        || data[11..] != [0, 0]
        || data[1..9].iter().all(|byte| *byte == 0)
        || data[1..9].iter().all(|byte| *byte == 0xff)
    {
        return Err(Error::InvalidResponse);
    }
    Ok(format!(
        "{:016x}",
        u64::from_le_bytes(data[1..9].try_into().unwrap())
    ))
}

fn node(data: &[u8]) -> Result<NodeDescriptor> {
    if data.len() != 18 || data[5] & 7 > 2 {
        return Err(Error::InvalidResponse);
    }
    Ok(NodeDescriptor {
        logical_type: data[5] & 7,
        flags: data[5],
        frequency_band_flags: data[6],
        mac_capabilities: data[7],
        manufacturer_code: word(data, 8)?,
        max_buffer_size: data[10],
        max_incoming_transfer_size: word(data, 11)?,
        server_mask: word(data, 13)?,
        max_outgoing_transfer_size: word(data, 15)?,
        descriptor_capability: data[17],
    })
}

fn active_endpoints(data: &[u8]) -> Result<Vec<u8>> {
    let count = usize::from(*data.get(5).ok_or(Error::InvalidResponse)?);
    if count > 16 {
        return Err(Error::LimitExceeded);
    }
    if data.len() != 6 + count {
        return Err(Error::InvalidResponse);
    }
    let endpoints = data[6..].to_vec();
    let mut unique = endpoints.clone();
    unique.sort_unstable();
    unique.dedup();
    if unique.len() != count || endpoints.iter().any(|ep| !(1..=240).contains(ep)) {
        return Err(Error::InvalidResponse);
    }
    Ok(endpoints)
}

fn clusters(data: &[u8], position: &mut usize) -> Result<Vec<u16>> {
    let count = usize::from(*data.get(*position).ok_or(Error::InvalidResponse)?);
    *position += 1;
    if count > 32 {
        return Err(Error::LimitExceeded);
    }
    let mut values = Vec::with_capacity(count);
    for _ in 0..count {
        let value = word(data, *position)?;
        if values.contains(&value) {
            return Err(Error::InvalidResponse);
        }
        values.push(value);
        *position += 2;
    }
    Ok(values)
}

fn simple(data: &[u8]) -> Result<Endpoint> {
    let len = usize::from(*data.get(5).ok_or(Error::InvalidResponse)?);
    if len < 8 || data.len() != 6 + len {
        return Err(Error::InvalidResponse);
    }
    let mut position = 12;
    let input_clusters = clusters(data, &mut position)?;
    let output_clusters = clusters(data, &mut position)?;
    if position != data.len() {
        return Err(Error::InvalidResponse);
    }
    Ok(Endpoint {
        endpoint: data[6],
        profile_id: word(data, 7)?,
        device_id: word(data, 9)?,
        device_version: data[11] & 0x0f,
        input_clusters,
        output_clusters,
    })
}

pub(crate) async fn interview<T: AsyncRead + AsyncWrite + Unpin>(
    io: &mut Transport<T>,
    address: u16,
) -> Result<Interview> {
    let ncp = probe(io).await?;
    if ncp.capabilities & 0x10 == 0 {
        return Err(Error::CapabilityMissing);
    }
    let ieee_address = ieee(io, address).await?;
    let request = [address.to_le_bytes(), address.to_le_bytes()].concat();
    let node = node(
        &io.request(5, 2, request.clone(), Some((0x82, address, None)))
            .await?,
    )?;
    let active = io
        .request(5, 5, request.clone(), Some((0x85, address, None)))
        .await?;
    let mut endpoints = Vec::new();
    for ep in active_endpoints(&active)? {
        let mut data = request.clone();
        data.push(ep);
        let descriptor = io
            .request(5, 4, data, Some((0x84, address, Some(ep))))
            .await?;
        endpoints.push(simple(&descriptor)?);
    }
    // 访谈前后再次核对短地址对应的IEEE，地址变化拒绝整个候选。
    if ieee(io, address).await? != ieee_address {
        return Err(Error::IdentityChanged);
    }
    Ok(Interview {
        ncp,
        network_address: address,
        ieee_address,
        node,
        endpoints,
    })
}
