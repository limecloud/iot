//! Unix串口适配。关闭时恢复原termios，库/协议层不依赖宿主串口类型。
use std::{
    fs::{File, OpenOptions},
    io::{self, Read, Write},
    os::{
        fd::AsRawFd,
        unix::{
            fs::{FileTypeExt, OpenOptionsExt},
            io::RawFd,
        },
    },
    path::Path,
    pin::Pin,
    task::{ready, Context, Poll},
};
use tokio::io::{unix::AsyncFd, AsyncRead, AsyncWrite, ReadBuf};

struct Handle {
    file: File,
    original: Option<libc::termios>,
    exclusive: bool,
}

impl AsRawFd for Handle {
    fn as_raw_fd(&self) -> RawFd {
        self.file.as_raw_fd()
    }
}

impl Drop for Handle {
    fn drop(&mut self) {
        // 句柄仍有效；恢复只影响本次打开的TTY，不操作DTR/RTS或发送复位命令。
        unsafe {
            if let Some(original) = &self.original {
                libc::tcsetattr(self.as_raw_fd(), libc::TCSANOW, original);
                // 丢弃本会话未消费输入，也清除Darwin恢复规范模式后的PENDIN状态。
                // 不等待输出排空，避免断连设备在Drop中阻塞。
                libc::tcflush(self.as_raw_fd(), libc::TCIFLUSH);
            }
            if self.exclusive {
                libc::ioctl(self.as_raw_fd(), libc::TIOCNXCL as _);
            }
        }
    }
}

pub struct Serial {
    inner: AsyncFd<Handle>,
}

impl Serial {
    pub fn open(path: &Path) -> io::Result<Self> {
        if !path.is_absolute() || path.as_os_str().len() > 1024 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "absolute_serial_path_required",
            ));
        }
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(libc::O_NONBLOCK | libc::O_NOCTTY | libc::O_CLOEXEC)
            .open(path)?;
        if !file.metadata()?.file_type().is_char_device() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "serial_character_device_required",
            ));
        }
        let mut handle = Handle {
            file,
            original: None,
            exclusive: false,
        };
        let fd = handle.as_raw_fd();
        // flock保护遵守锁的进程，TIOCEXCL防止后续普通进程重复打开。
        if unsafe { libc::flock(fd, libc::LOCK_EX | libc::LOCK_NB) } != 0
            || unsafe { libc::ioctl(fd, libc::TIOCEXCL as _) } != 0
        {
            return Err(io::Error::last_os_error());
        }
        handle.exclusive = true;
        let mut original = std::mem::MaybeUninit::<libc::termios>::uninit();
        if unsafe { libc::tcgetattr(fd, original.as_mut_ptr()) } != 0 {
            return Err(io::Error::last_os_error());
        }
        // tcgetattr成功后termios已完整初始化。
        let original = unsafe { original.assume_init() };
        handle.original = Some(original);
        let mut configured = original;
        unsafe {
            libc::cfmakeraw(&mut configured);
            libc::cfsetispeed(&mut configured, libc::B115200);
            libc::cfsetospeed(&mut configured, libc::B115200);
        }
        configured.c_cflag |= libc::CLOCAL | libc::CREAD;
        configured.c_iflag &= !(libc::IXON | libc::IXOFF | libc::IXANY);
        configured.c_cflag &= !(libc::PARENB | libc::CSTOPB | libc::CSIZE);
        configured.c_cflag |= libc::CS8;
        #[cfg(any(target_os = "linux", target_os = "macos", target_os = "ios"))]
        {
            configured.c_cflag &= !libc::CRTSCTS;
        }
        configured.c_cc[libc::VMIN] = 1;
        configured.c_cc[libc::VTIME] = 0;
        if unsafe { libc::tcsetattr(fd, libc::TCSANOW, &configured) } != 0
            || unsafe { libc::tcflush(fd, libc::TCIFLUSH) } != 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(Self {
            // Handle独占所有权且不暴露fd，注册期间不会关闭或替换描述符。
            inner: unsafe { AsyncFd::register(handle)? },
        })
    }
}

impl AsyncRead for Serial {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if buf.remaining() == 0 {
            return Poll::Ready(Ok(()));
        }
        loop {
            let mut guard = ready!(self.inner.poll_read_ready(cx))?;
            match guard.try_io(|inner| (&inner.get_ref().file).read(buf.initialize_unfilled())) {
                Ok(Ok(count)) => {
                    buf.advance(count);
                    return Poll::Ready(Ok(()));
                }
                Ok(Err(error)) => return Poll::Ready(Err(error)),
                Err(_) => continue,
            }
        }
    }
}

impl AsyncWrite for Serial {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        loop {
            let mut guard = ready!(self.inner.poll_write_ready(cx))?;
            match guard.try_io(|inner| (&inner.get_ref().file).write(bytes)) {
                Ok(result) => return Poll::Ready(result),
                Err(_) => continue,
            }
        }
    }

    fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready((&self.inner.get_ref().file).flush())
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.poll_flush(cx)
    }
}
