//! 协调器邻居表分页读取；只提供当前邻居证据，不开放入网或创建平台设备。
use crate::{
    session::{ResponseMatch, Transport},
    zdo, Error, Interview, Probe, Result,
};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncWrite};

const MAX_NEIGHBORS: usize = 64;
const ENTRY_BYTES: usize = 22;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DiscoveryTarget {
    pub coordinator_ieee: String,
}
impl DiscoveryTarget {
    pub fn validate(&self) -> Result<()> {
        if !valid_ieee(&self.coordinator_ieee) {
            return Err(Error::InvalidInput);
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct InterviewTarget {
    pub coordinator_ieee: String,
    pub ieee_address: String,
}
impl InterviewTarget {
    pub fn validate(&self) -> Result<()> {
        if !valid_ieee(&self.coordinator_ieee)
            || !valid_ieee(&self.ieee_address)
            || self.coordinator_ieee == self.ieee_address
        {
            return Err(Error::InvalidInput);
        }
        Ok(())
    }
}

pub(crate) async fn interview<T: AsyncRead + AsyncWrite + Unpin>(
    io: &mut Transport<T>,
    target: &InterviewTarget,
) -> Result<Interview> {
    let ncp = zdo::probe(io).await?;
    if ncp.capabilities & 0x10 == 0 {
        return Err(Error::CapabilityMissing);
    }
    if zdo::ieee(io, 0).await? != target.coordinator_ieee {
        return Err(Error::IdentityChanged);
    }
    let ieee = u64::from_str_radix(&target.ieee_address, 16)
        .map_err(|_| Error::InvalidInput)?
        .to_le_bytes();
    let address = zdo::lookup(io, ieee).await?;
    let result = zdo::interview(io, address).await?;
    if result.ieee_address != target.ieee_address
        || zdo::lookup(io, ieee).await? != address
        || zdo::ieee(io, 0).await? != target.coordinator_ieee
    {
        return Err(Error::IdentityChanged);
    }
    Ok(result)
}

pub(crate) fn valid_ieee(value: &str) -> bool {
    value.len() == 16
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        && !value.bytes().all(|b| b == b'0')
        && !value.bytes().all(|b| b == b'f')
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct Neighbor {
    pub extended_pan_id: String,
    pub ieee_address: String,
    pub network_address: u16,
    pub device_type: u8,
    pub rx_on_when_idle: u8,
    pub relationship: u8,
    pub flags: u8,
    pub permit_joining: u8,
    pub depth: u8,
    pub link_quality: u8,
}

#[derive(Debug, Serialize)]
pub struct Neighbors {
    pub ncp: Probe,
    pub coordinator_ieee: String,
    pub network_address: u16,
    pub scope: &'static str,
    pub table_entries: u8,
    pub page_count: u8,
    pub items: Vec<Neighbor>,
}

pub(crate) fn matches(data: &[u8], start: u8) -> Result<bool> {
    let source = data.get(..2).ok_or(Error::InvalidResponse)?;
    if source != [0, 0] {
        return Ok(false);
    }
    let status = *data.get(2).ok_or(Error::InvalidResponse)?;
    if status != 0 {
        return Err(Error::DeviceRejected(status));
    }
    Ok(*data.get(4).ok_or(Error::InvalidResponse)? == start)
}

fn extended(data: &[u8]) -> String {
    format!("{:016x}", u64::from_le_bytes(data.try_into().unwrap()))
}

fn page(data: &[u8], start: usize) -> Result<(u8, Vec<Neighbor>)> {
    if data.len() < 6 || data[..3] != [0, 0, 0] || usize::from(data[4]) != start {
        return Err(Error::InvalidResponse);
    }
    let total = usize::from(data[3]);
    let count = usize::from(data[5]);
    if total > MAX_NEIGHBORS {
        return Err(Error::LimitExceeded);
    }
    if start > total
        || start + count > total
        || (count == 0 && start < total)
        || data.len() != 6 + count * ENTRY_BYTES
    {
        return Err(Error::InvalidResponse);
    }
    let mut items = Vec::with_capacity(count);
    for entry in data[6..].chunks_exact(ENTRY_BYTES) {
        let ieee_address = extended(&entry[8..16]);
        if !valid_ieee(&ieee_address) {
            return Err(Error::InvalidResponse);
        }
        let network_address = u16::from_le_bytes([entry[16], entry[17]]);
        if network_address == 0 || network_address >= 0xfff8 {
            return Err(Error::InvalidResponse);
        }
        items.push(Neighbor {
            extended_pan_id: extended(&entry[..8]),
            ieee_address,
            network_address,
            device_type: entry[18] & 3,
            rx_on_when_idle: (entry[18] >> 2) & 3,
            relationship: (entry[18] >> 4) & 7,
            flags: entry[18],
            permit_joining: entry[19],
            depth: entry[20],
            link_quality: entry[21],
        });
    }
    Ok((data[3], items))
}

pub(crate) async fn neighbors<T: AsyncRead + AsyncWrite + Unpin>(
    io: &mut Transport<T>,
    target: &DiscoveryTarget,
) -> Result<Neighbors> {
    let ncp = zdo::probe(io).await?;
    if ncp.capabilities & 0x10 == 0 {
        return Err(Error::CapabilityMissing);
    }
    if zdo::ieee(io, 0).await? != target.coordinator_ieee {
        return Err(Error::IdentityChanged);
    }
    let mut items: Vec<Neighbor> = Vec::new();
    let mut total = None;
    let mut page_count = 0;
    loop {
        let start = items.len() as u8;
        let data = io
            .request(
                5,
                0x31,
                vec![0, 0, start],
                Some(ResponseMatch::Neighbors(start)),
            )
            .await?;
        let (entries, page) = page(&data, usize::from(start))?;
        if total.is_some_and(|total| total != entries) {
            return Err(Error::NeighborTableChanged);
        }
        total = Some(entries);
        for item in page {
            if item.ieee_address == target.coordinator_ieee
                || items.iter().any(|known| {
                    known.ieee_address == item.ieee_address
                        || known.network_address == item.network_address
                })
            {
                return Err(Error::NeighborTableChanged);
            }
            items.push(item);
        }
        page_count += 1;
        if items.len() == usize::from(entries) {
            break;
        }
    }
    if zdo::ieee(io, 0).await? != target.coordinator_ieee {
        return Err(Error::IdentityChanged);
    }
    Ok(Neighbors {
        ncp,
        coordinator_ieee: target.coordinator_ieee.clone(),
        network_address: 0,
        scope: "coordinator_neighbors",
        table_entries: total.unwrap(),
        page_count,
        items,
    })
}
