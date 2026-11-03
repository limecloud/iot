use crate::{Error, Result};
use tokio::io::{AsyncRead, AsyncReadExt};

pub(crate) const MAX_DATA: usize = 250;

#[derive(Debug)]
pub(crate) struct Frame {
    pub cmd0: u8,
    pub cmd1: u8,
    pub data: Vec<u8>,
}

impl Frame {
    pub fn encode(&self) -> Result<Vec<u8>> {
        if self.data.len() > MAX_DATA {
            return Err(Error::LimitExceeded);
        }
        let mut bytes = vec![0xfe, self.data.len() as u8, self.cmd0, self.cmd1];
        bytes.extend_from_slice(&self.data);
        bytes.push(bytes[1..].iter().fold(0, |sum, byte| sum ^ byte));
        Ok(bytes)
    }

    pub async fn read(
        stream: &mut (impl AsyncRead + Unpin),
        noise_left: &mut usize,
    ) -> Result<Self> {
        loop {
            if stream.read_u8().await? == 0xfe {
                break;
            }
            *noise_left = noise_left.checked_sub(1).ok_or(Error::LimitExceeded)?;
        }
        let len = stream.read_u8().await?;
        if usize::from(len) > MAX_DATA {
            return Err(Error::InvalidFrame);
        }
        let mut bytes = vec![0; usize::from(len) + 3];
        stream.read_exact(&mut bytes).await?;
        if bytes.iter().fold(len, |sum, byte| sum ^ byte) != 0 {
            return Err(Error::InvalidFrame);
        }
        Ok(Self {
            cmd0: bytes[0],
            cmd1: bytes[1],
            data: bytes[2..bytes.len() - 1].to_vec(),
        })
    }
}
