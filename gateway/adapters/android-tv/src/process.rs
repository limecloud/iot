use crate::Config;
use std::{io, process::Stdio};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
    time::{timeout_at, Instant},
};

const MAX_STDOUT: usize = 131_072;
const MAX_STDERR: usize = 4096;

pub(crate) struct Output {
    pub success: bool,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

#[derive(Clone, Copy, Debug)]
pub(crate) enum Failure {
    NotStarted,
    Interrupted,
}

async fn bounded(mut pipe: impl AsyncRead + Unpin, limit: usize) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    let mut buffer = [0; 4096];
    loop {
        let count = pipe.read(&mut buffer).await?;
        if count == 0 {
            return Ok(bytes);
        }
        if bytes.len() + count > limit {
            return Err(io::Error::other("adb_output_limit"));
        }
        bytes.extend_from_slice(&buffer[..count]);
    }
}

pub(crate) async fn run(
    config: &Config,
    args: &[&str],
    deadline: Instant,
) -> Result<Output, Failure> {
    if Instant::now() >= deadline {
        return Err(Failure::NotStarted);
    }
    let mut command = Command::new(&config.adb_path);
    command
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("LANG", "C")
        .env("LC_ALL", "C")
        .env("ANDROID_USER_HOME", &config.state_directory)
        .env("ADB_VENDOR_KEYS", config.state_directory.join("adbkey"))
        .current_dir(&config.state_directory)
        // 显式服务器地址防止客户端自动启动默认全局 ADB daemon。
        .args(["-H", "127.0.0.1", "-P"])
        .arg(config.server_port.to_string())
        .arg("-s")
        .arg(config.target.to_string())
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command.spawn().map_err(|_| Failure::NotStarted)?;
    let stdout = child.stdout.take().ok_or(Failure::Interrupted)?;
    let stderr = child.stderr.take().ok_or(Failure::Interrupted)?;
    let result = timeout_at(deadline, async {
        tokio::try_join!(
            child.wait(),
            bounded(stdout, MAX_STDOUT),
            bounded(stderr, MAX_STDERR)
        )
    })
    .await;
    match result {
        Ok(Ok((status, stdout, stderr))) => Ok(Output {
            success: status.success(),
            stdout,
            stderr,
        }),
        _ => {
            // 超时、读失败或输出越界后回收当前子进程，不再执行第二次命令。
            let _ = child.kill().await;
            let _ = child.wait().await;
            Err(Failure::Interrupted)
        }
    }
}
