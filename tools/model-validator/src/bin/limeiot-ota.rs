//! 固件离线校验、签名制品准备与受控下载入口，不修改设备或信任。
#[path = "../ota_download.rs"]
mod download;
#[path = "../ota_sign.rs"]
mod publication;
#[path = "../ota_publish.rs"]
mod publish;

use limeiot_core::ota;
use serde_json::json;
use std::{collections::BTreeMap, fs::File, io::Read, path::Path};

fn regular_file(path: &Path) -> std::io::Result<File> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW);
    }
    let file = options.open(path)?;
    if !file.metadata()?.is_file() {
        return Err(std::io::Error::other("regular file required"));
    }
    Ok(file)
}

fn run() -> Result<i32, &'static str> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() == 1 && args[0] == "schema" {
        let mut catalog: serde_json::Value =
            serde_json::from_str(include_str!("../../../../contracts/tools/ota.json"))
                .map_err(|_| "ota_component_unavailable")?;
        catalog["schemas"] = json!({
            "verification": serde_json::from_str::<serde_json::Value>(include_str!(
                "../../../../contracts/ota.schema.json"
            )).map_err(|_| "ota_component_unavailable")?,
            "release": serde_json::from_str::<serde_json::Value>(include_str!(
                "../../../../contracts/ota-release.schema.json"
            )).map_err(|_| "ota_component_unavailable")?
        });
        println!("{catalog}");
        return Ok(0);
    }
    let mode = args.first().and_then(|arg| arg.to_str()).unwrap_or("");
    if !(mode == "verify" && args.len() == 5
        || mode == "download" && [5, 7].contains(&args.len())
        || mode == "keygen" && args.len() == 3
        || mode == "publish" && args.len() == 9
        || mode == "sign" && args.len() == 11)
    {
        return Err("ota_arguments_required");
    }
    let allowed: &[&str] = if mode == "verify" {
        &["--input", "--image"]
    } else if mode == "download" {
        &["--input", "--output-dir", "--ca-file"]
    } else if mode == "keygen" {
        &["--output-dir"]
    } else if mode == "publish" {
        &["--bundle", "--trust", "--repository", "--base-url"]
    } else {
        &["--input", "--trust", "--key", "--image", "--output-dir"]
    };
    let mut flags = BTreeMap::new();
    for pair in args[1..].chunks_exact(2) {
        let name = pair[0].to_str().ok_or("ota_arguments_required")?;
        if !allowed.contains(&name) || flags.insert(name, &pair[1]).is_some() {
            return Err("ota_arguments_required");
        }
    }
    if mode == "keygen" {
        return Ok(publication::keygen(Path::new(flags["--output-dir"])));
    }
    if mode == "sign" {
        return Ok(publication::sign(
            Path::new(flags["--input"]),
            Path::new(flags["--trust"]),
            Path::new(flags["--key"]),
            Path::new(flags["--image"]),
            Path::new(flags["--output-dir"]),
        ));
    }
    if mode == "publish" {
        return Ok(publish::run(
            Path::new(flags["--bundle"]),
            Path::new(flags["--trust"]),
            Path::new(flags["--repository"]),
            flags["--base-url"]
                .to_str()
                .ok_or("ota_arguments_required")?,
        ));
    }
    if !flags.contains_key("--input")
        || !flags.contains_key(if mode == "verify" {
            "--image"
        } else {
            "--output-dir"
        })
    {
        return Err("ota_arguments_required");
    }
    let mut raw = Vec::new();
    regular_file(Path::new(flags["--input"]))
        .map_err(|_| "ota_input_io")?
        .take((ota::MAX_REQUEST_BYTES + 1) as u64)
        .read_to_end(&mut raw)
        .map_err(|_| "ota_input_io")?;
    if mode == "download" {
        return Ok(download::run(
            &raw,
            Path::new(flags["--output-dir"]),
            flags.get("--ca-file").map(Path::new),
        ));
    }
    let image = regular_file(Path::new(flags["--image"])).map_err(|_| "ota_image_io")?;
    let report = ota::verify_document(&raw, image, chrono::Utc::now());
    let code = if report.valid {
        0
    } else if report
        .issues
        .iter()
        .any(|issue| issue.code == "ota_image_io")
    {
        5
    } else {
        2
    };
    println!(
        "{}",
        serde_json::to_string(&report).map_err(|_| "ota_component_unavailable")?
    );
    Ok(code)
}

fn main() {
    let code = match run() {
        Ok(code) => code,
        Err(code) => {
            eprintln!("{}", json!({"error":{"code":code}}));
            if code == "ota_arguments_required" {
                2
            } else {
                5
            }
        }
    };
    std::process::exit(code);
}
