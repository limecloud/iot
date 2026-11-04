use crate::{
    commissioning, discovery, environment, frame::Frame, on_off, zcl, zdo, DiscoveryTarget,
    EnvironmentReading, EnvironmentTarget, Error, Interview, InterviewTarget, JoinWindow,
    JoinWindowTarget, Neighbors, OnOffCommand, OnOffCommandTarget, OnOffReading, OnOffTarget,
    Probe, Result,
};
use tokio::{
    io::{AsyncRead, AsyncWrite, AsyncWriteExt},
    time::{timeout_at, Instant},
};

/// 只允许一个在途请求。失败或调用方取消时丢弃传输，禁止重用迟到响应。
pub struct Session<T> {
    stream: Option<T>,
    af: zcl::State,
}

impl<T: AsyncRead + AsyncWrite + Unpin> Session<T> {
    pub fn new(stream: T) -> Self {
        Self {
            stream: Some(stream),
            af: zcl::State::default(),
        }
    }

    pub fn is_closed(&self) -> bool {
        self.stream.is_none()
    }

    pub async fn read_on_off(
        &mut self,
        target: &OnOffTarget,
        deadline: Instant,
    ) -> Result<OnOffReading> {
        target.validate()?;
        let mut transport =
            Transport::new(self.stream.take().ok_or(Error::SessionClosed)?, deadline);
        let result = timeout_at(deadline, on_off::read(&mut transport, &mut self.af, target))
            .await
            .map_err(|_| Error::Timeout)
            .and_then(|result| result);
        if result.is_ok() {
            self.stream = Some(transport.stream);
        }
        result
    }

    /// 固定On或Off只发送一次；协议受理后仍须独立读取状态，失败不重试。
    pub async fn set_on_off(
        &mut self,
        request: &OnOffCommandTarget,
        deadline: Instant,
    ) -> Result<OnOffCommand> {
        request.validate()?;
        let mut transport =
            Transport::new(self.stream.take().ok_or(Error::SessionClosed)?, deadline);
        let result = timeout_at(deadline, on_off::set(&mut transport, &mut self.af, request))
            .await
            .map_err(|_| Error::Timeout)
            .and_then(|result| result);
        if result.is_ok() {
            self.stream = Some(transport.stream);
        }
        result
    }

    /// 写入至多一次；超时/取消后窗口状态未知，不重试或隐式发送关闭。
    pub async fn permit_join(
        &mut self,
        target: &JoinWindowTarget,
        deadline: Instant,
    ) -> Result<JoinWindow> {
        target.validate()?;
        let mut transport =
            Transport::new(self.stream.take().ok_or(Error::SessionClosed)?, deadline);
        let result = timeout_at(deadline, commissioning::permit_join(&mut transport, target))
            .await
            .map_err(|_| Error::Timeout)
            .and_then(|result| result);
        if result.is_ok() {
            self.stream = Some(transport.stream);
        }
        result
    }

    pub async fn neighbors(
        &mut self,
        target: &DiscoveryTarget,
        deadline: Instant,
    ) -> Result<Neighbors> {
        target.validate()?;
        let mut transport =
            Transport::new(self.stream.take().ok_or(Error::SessionClosed)?, deadline);
        let result = timeout_at(deadline, discovery::neighbors(&mut transport, target))
            .await
            .map_err(|_| Error::Timeout)
            .and_then(|result| result);
        if result.is_ok() {
            self.stream = Some(transport.stream);
        }
        result
    }

    pub async fn interview_ieee(
        &mut self,
        target: &InterviewTarget,
        deadline: Instant,
    ) -> Result<Interview> {
        target.validate()?;
        let mut transport =
            Transport::new(self.stream.take().ok_or(Error::SessionClosed)?, deadline);
        let result = timeout_at(deadline, discovery::interview(&mut transport, target))
            .await
            .map_err(|_| Error::Timeout)
            .and_then(|result| result);
        if result.is_ok() {
            self.stream = Some(transport.stream);
        }
        result
    }

    pub async fn read_environment(
        &mut self,
        target: &EnvironmentTarget,
        deadline: Instant,
    ) -> Result<EnvironmentReading> {
        target.validate()?;
        let mut transport =
            Transport::new(self.stream.take().ok_or(Error::SessionClosed)?, deadline);
        let result = timeout_at(
            deadline,
            environment::read(&mut transport, &mut self.af, target),
        )
        .await
        .map_err(|_| Error::Timeout)
        .and_then(|result| result);
        if result.is_ok() {
            self.stream = Some(transport.stream);
        }
        result
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

pub(crate) enum ResponseMatch {
    Zdo(u8, u16, Option<u8>),
    Ieee([u8; 8]),
    Neighbors(u8),
    PermitJoin,
}

impl ResponseMatch {
    fn command(&self) -> u8 {
        match self {
            Self::Zdo(cmd, _, _) => *cmd,
            Self::Ieee(_) => 0x80,
            Self::Neighbors(_) => 0xb1,
            Self::PermitJoin => 0xb6,
        }
    }
    fn matches(&self, data: &[u8]) -> Result<bool> {
        match self {
            Self::Zdo(cmd, address, endpoint) => zdo::matches(*cmd, data, *address, *endpoint),
            Self::Ieee(ieee) => Ok(data.get(1..9).ok_or(Error::InvalidResponse)? == ieee),
            Self::Neighbors(start) => discovery::matches(data, *start),
            Self::PermitJoin => {
                if data.len() != 3 {
                    return Err(Error::InvalidResponse);
                }
                Ok(data[..2] == [0, 0])
            }
        }
    }
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

    // 仅由本crate发送固定SYS/ZDO/AF任务，不提供公开的任意MT发送接口。
    pub async fn request(
        &mut self,
        subsystem: u8,
        command: u8,
        data: Vec<u8>,
        response: Option<ResponseMatch>,
    ) -> Result<Vec<u8>> {
        self.send(subsystem, command, data).await?;
        let mut accepted = false;
        let mut early = None;
        loop {
            let frame = self.next_frame().await?;
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
            } else if let Some(key) = response
                .as_ref()
                .filter(|key| frame.cmd0 == 0x45 && frame.cmd1 == key.command())
            {
                if key.matches(&frame.data)? {
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
                self.skip_notification()?;
            } else {
                return Err(Error::UnexpectedResponse);
            }
        }
    }

    pub async fn send(&mut self, subsystem: u8, command: u8, data: Vec<u8>) -> Result<()> {
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
        Ok(())
    }

    pub async fn next_frame(&mut self) -> Result<Frame> {
        if Instant::now() >= self.deadline {
            return Err(Error::Timeout);
        }
        let frame = Frame::read(&mut self.stream, &mut self.noise_left).await?;
        if (frame.cmd0, frame.cmd1) == (0x41, 0x80) {
            return Err(Error::Reset);
        }
        Ok(frame)
    }

    pub fn skip_notification(&mut self) -> Result<()> {
        self.unrelated_left = self
            .unrelated_left
            .checked_sub(1)
            .ok_or(Error::LimitExceeded)?;
        Ok(())
    }
}
