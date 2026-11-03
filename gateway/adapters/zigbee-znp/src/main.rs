use limeiot_zigbee_znp::{Error, Result};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

struct Input {
    command: String,
    serial: PathBuf,
    timeout_ms: u64,
    address: Option<u16>,
}

fn input() -> Result<Input> {
    let mut args = std::env::args().skip(1);
    let command = args.next().ok_or(Error::InvalidInput)?;
    if !matches!(command.as_str(), "probe" | "interview") {
        return Err(Error::InvalidInput);
    }
    let mut serial = None;
    let mut timeout_ms = None;
    let mut address = None;
    while let Some(flag) = args.next() {
        let value = args.next().ok_or(Error::InvalidInput)?;
        match flag.as_str() {
            "--serial" if serial.is_none() => serial = Some(PathBuf::from(value)),
            "--timeout-ms" if timeout_ms.is_none() => {
                if !value.bytes().all(|byte| byte.is_ascii_digit()) {
                    return Err(Error::InvalidInput);
                }
                timeout_ms = Some(value.parse::<u64>().map_err(|_| Error::InvalidInput)?);
            }
            "--address" if address.is_none() => {
                let hex = value.strip_prefix("0x").ok_or(Error::InvalidInput)?;
                if hex.len() != 4 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                    return Err(Error::InvalidInput);
                }
                address = Some(u16::from_str_radix(hex, 16).map_err(|_| Error::InvalidInput)?);
            }
            _ => return Err(Error::InvalidInput),
        }
    }
    let timeout_ms = timeout_ms.unwrap_or(5000);
    let serial = serial.ok_or(Error::InvalidInput)?;
    if !(100..=30000).contains(&timeout_ms)
        || !serial.is_absolute()
        || serial.as_os_str().len() > 1024
        || (command == "interview") != address.is_some()
        || address.is_some_and(|address| address >= 0xfff8)
    {
        return Err(Error::InvalidInput);
    }
    Ok(Input {
        command,
        serial,
        timeout_ms,
        address,
    })
}

#[cfg(unix)]
async fn execute(input: Input) -> Result<Value> {
    use limeiot_zigbee_znp::{serial::Serial, Session};
    use tokio::time::Instant;
    let deadline = Instant::now() + Duration::from_millis(input.timeout_ms);
    let mut session = Session::new(Serial::open(&input.serial)?);
    let result = if let Some(address) = input.address {
        serde_json::to_value(session.interview(address, deadline).await?)
    } else {
        serde_json::to_value(session.probe(deadline).await?)
    }
    .map_err(|_| Error::InvalidResponse)?;
    let observed_at_unix_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| Error::InvalidResponse)?
        .as_millis();
    Ok(json!({
        "schema_version":1,"operation":input.command,"protocol":"znp",
        "evidence":"unauthenticated_protocol","device_binding_created":false,
        "observed_at_unix_ms":observed_at_unix_ms,"result":result
    }))
}

#[cfg(not(unix))]
async fn execute(_: Input) -> Result<Value> {
    Err(Error::InvalidInput)
}

#[cfg(unix)]
async fn execute_cancellable(input: Input) -> Result<Value> {
    use tokio::signal::unix::{signal, SignalKind};
    let mut interrupt = signal(SignalKind::interrupt())?;
    let mut terminate = signal(SignalKind::terminate())?;
    tokio::select! {
        biased;
        _ = interrupt.recv() => Err(Error::Cancelled),
        _ = terminate.recv() => Err(Error::Cancelled),
        result = execute(input) => result,
    }
}

#[cfg(not(unix))]
async fn execute_cancellable(input: Input) -> Result<Value> {
    execute(input).await
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let result = match input() {
        Ok(input) => execute_cancellable(input).await,
        Err(error) => Err(error),
    };
    match result {
        Ok(value) => println!("{value}"),
        Err(error) => {
            let mut detail = json!({"code":error.to_string()});
            if let Some(status) = error.status() {
                detail["status"] = json!(status);
            }
            eprintln!("{}", json!({"error":detail}));
            std::process::exit(if matches!(error, Error::InvalidInput) {
                2
            } else {
                5
            });
        }
    }
}
