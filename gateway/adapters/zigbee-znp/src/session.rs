use crate::{frame::Frame, zdo, Error, Interview, Probe, Result};
use tokio::{
    io::{AsyncRead, AsyncWrite, AsyncWriteExt},
    time::{timeout_at, Instant},
};

/// 只允许一个在途请求。失败或调用方取消时丢弃传输，禁止重用迟到响应。
pub struct Session<T> {
    stream: Option<T>,
}

impl<T: AsyncRead + AsyncWrite + Unpin> Session<T> {
    pub fn new(stream: T) -> Self {
        Self {
            stream: Some(stream),
        }
    }

    pub fn is_closed(&self) -> bool {
        self.stream.is_none()
    }

    pub async fn probe(&mut self, deadline: Instant) -> Result<Probe> {
        let mut transport =
            Transport::new(self.stream.take().ok_or(Error::SessionClosed)?, deadline);
        let result = timeout_at(deadline, zdo::probe(&mut transport))
            .await
            .map_err(|_| Error::Timeout)
            .and_then(|result| result);
        if result.is_ok() {
            self.stream = Some(transport.stream);
        }
        result
    }

    pub async fn interview(&mut self, address: u16, deadline: Instant) -> Result<Interview> {
        // Zigbee 0xfff8..0xffff为保留/广播地址，诊断不执行网络广播。
        if address >= 0xfff8 {
            return Err(Error::InvalidInput);
        }
        let mut transport =
            Transport::new(self.stream.take().ok_or(Error::SessionClosed)?, deadline);
        let result = timeout_at(deadline, zdo::interview(&mut transport, address))
            .await
            .map_err(|_| Error::Timeout)
            .and_then(|result| result);
        if result.is_ok() {
            self.stream = Some(transport.stream);
        }
        result
    }
}

pub(crate) struct Transport<T> {
    stream: T,
    noise_left: usize,
    unrelated_left: usize,
    deadline: Instant,
}

impl<T: AsyncRead + AsyncWrite + Unpin> Transport<T> {
    fn new(stream: T, deadline: Instant) -> Self {
        Self {
            stream,
            noise_left: 64,
            unrelated_left: 32,
            deadline,
        }
    }

    // 只在本模块内发送固定SYS/ZDO读取，不提供任意MT发送接口。
    pub async fn request(
        &mut self,
        subsystem: u8,
        command: u8,
        data: Vec<u8>,
        response: Option<(u8, u16, Option<u8>)>,
    ) -> Result<Vec<u8>> {
        if Instant::now() >= self.deadline {
            return Err(Error::Timeout);
        }
        let bytes = Frame {
            cmd0: 0x20 | subsystem,
            cmd1: command,
            data,
        }
        .encode()?;
        self.stream.write_all(&bytes).await?;
        self.stream.flush().await?;
        let mut accepted = false;
        let mut early = None;
        loop {
            let frame = Frame::read(&mut self.stream, &mut self.noise_left).await?;
            if (frame.cmd0, frame.cmd1) == (0x41, 0x80) {
                return Err(Error::Reset);
            }
            if frame.cmd0 == (0x60 | subsystem) && frame.cmd1 == command {
                if accepted {
                    return Err(Error::UnexpectedResponse);
                }
                if response.is_none() {
                    return Ok(frame.data);
                }
                if frame.data.len() != 1 {
                    return Err(Error::InvalidResponse);
                }
                if frame.data[0] != 0 {
                    return Err(Error::RequestRejected(frame.data[0]));
                }
                accepted = true;
                if let Some(data) = early {
                    return Ok(data);
                }
            } else if let Some((cmd, address, endpoint)) =
                response.filter(|(cmd, _, _)| frame.cmd0 == 0x45 && frame.cmd1 == *cmd)
            {
                if zdo::matches(cmd, &frame.data, address, endpoint)? {
                    if accepted {
                        return Ok(frame.data);
                    }
                    if early.replace(frame.data).is_some() {
                        return Err(Error::UnexpectedResponse);
                    }
                } else {
                    self.skip_notification()?;
                }
            } else if frame.cmd0 & 0xe0 == 0x40 {
                // 无关通知不缓存，也不能延长绝对期限。
                self.skip_notification()?;
            } else {
                // MT没有通用请求ID，不丢弃错配同步响应后继续猜测。
                return Err(Error::UnexpectedResponse);
            }
        }
    }

    fn skip_notification(&mut self) -> Result<()> {
        self.unrelated_left = self
            .unrelated_left
            .checked_sub(1)
            .ok_or(Error::LimitExceeded)?;
        Ok(())
    }
}
