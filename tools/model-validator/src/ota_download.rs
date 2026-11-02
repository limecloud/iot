//! 受控固件下载适配器。领域预检和实际文件验签均复用core，成功不授权安装。
use limeiot_core::ota::{self, Request, Verification};
use reqwest::{header, Client, StatusCode};
use serde::Serialize;
use serde_json::json;
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::Path,
    time::Duration,
};

#[derive(Debug)]
struct Failure {
    code: String,
    exit: i32,
}
impl Failure {
    fn new(code: impl Into<String>, exit: i32) -> Self {
        Self {
            code: code.into(),
            exit,
        }
    }
    fn io(code: &str) -> Self {
        Self::new(code, 5)
    }
    fn invalid(code: impl Into<String>) -> Self {
        Self::new(code, 2)
    }
}

#[derive(Serialize)]
struct Receipt {
    version: u8,
    downloader: &'static str,
    status: &'static str,
    request_digest: String,
    artifact_id: String,
    bytes_received: u32,
    verification: Option<Verification>,
    error: Option<String>,
}

fn new_file(path: &Path) -> Result<File, Failure> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path).map_err(|_| Failure::io("ota_output_io"))
}

fn sync_directory(path: &Path) -> Result<(), Failure> {
    #[cfg(unix)]
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| Failure::io("ota_output_io"))?;
    Ok(())
}

fn save_receipt(directory: &Path, receipt: &Receipt) -> Result<(), Failure> {
    let mut file = new_file(&directory.join("receipt.tmp"))?;
    serde_json::to_writer(&mut file, receipt).map_err(|_| Failure::io("ota_output_io"))?;
    file.sync_all().map_err(|_| Failure::io("ota_output_io"))?;
    fs::rename(
        directory.join("receipt.tmp"),
        directory.join("receipt.json"),
    )
    .map_err(|_| Failure::io("ota_output_io"))?;
    sync_directory(directory)
}

fn client(ca_file: Option<&Path>) -> Result<Client, Failure> {
    let mut builder = Client::builder()
        .https_only(true)
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .no_zstd()
        .connect_timeout(Duration::from_secs(5))
        .read_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30));
    if let Some(path) = ca_file {
        let mut bytes = Vec::new();
        super::regular_file(path)
            .map_err(|_| Failure::io("ota_ca_io"))?
            .take(65_537)
            .read_to_end(&mut bytes)
            .map_err(|_| Failure::io("ota_ca_io"))?;
        if bytes.len() > 65_536 {
            return Err(Failure::invalid("invalid_ota_ca"));
        }
        let certificates = reqwest::Certificate::from_pem_bundle(&bytes)
            .map_err(|_| Failure::invalid("invalid_ota_ca"))?;
        if certificates.is_empty() || certificates.len() > 16 {
            return Err(Failure::invalid("invalid_ota_ca"));
        }
        for certificate in certificates {
            builder = builder.add_root_certificate(certificate);
        }
    }
    builder
        .build()
        .map_err(|_| Failure::io("ota_component_unavailable"))
}

async fn transfer(
    client: &Client,
    request: &Request,
    raw: &[u8],
    directory: &Path,
    receipt: &mut Receipt,
) -> Result<(), Failure> {
    let mut image = new_file(&directory.join("image.part"))?;
    let statement = &request.manifest.statement;
    let mut response = client
        .get(&statement.download.url)
        .header(header::ACCEPT_ENCODING, "identity")
        .send()
        .await
        .map_err(|_| Failure::io("ota_download_network"))?;
    if response.status().is_redirection() {
        return Err(Failure::invalid("ota_download_redirect"));
    }
    if response.status() != StatusCode::OK {
        return Err(Failure::io("ota_download_http"));
    }
    if response
        .headers()
        .get_all(header::CONTENT_ENCODING)
        .iter()
        .any(|v| v != "identity")
    {
        return Err(Failure::invalid("ota_download_encoding"));
    }
    if response
        .content_length()
        .is_some_and(|size| size != u64::from(statement.size_bytes))
    {
        return Err(Failure::invalid("ota_image_size_mismatch"));
    }
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| Failure::io("ota_download_network"))?
    {
        if chunk.len() > (statement.size_bytes - receipt.bytes_received) as usize {
            return Err(Failure::invalid("ota_image_size_mismatch"));
        }
        image
            .write_all(&chunk)
            .map_err(|_| Failure::io("ota_output_io"))?;
        receipt.bytes_received += chunk.len() as u32;
    }
    image
        .sync_all()
        .and_then(|_| image.seek(SeekFrom::Start(0)))
        .map_err(|_| Failure::io("ota_output_io"))?;
    // 使用同一文件描述符验证实际下载字节；再次核对结束时的清单有效期。
    let verification = ota::verify_document(raw, &mut image, chrono::Utc::now());
    let failure = verification.issues.first().map(|issue| {
        Failure::new(
            &issue.code,
            if issue.code == "ota_image_io" { 5 } else { 2 },
        )
    });
    receipt.verification = Some(verification);
    if let Some(failure) = failure {
        return Err(failure);
    }
    // 同目录hard-link只创建新名称，绝不覆盖现有固件。
    fs::hard_link(directory.join("image.part"), directory.join("firmware.bin"))
        .map_err(|_| Failure::io("ota_output_io"))?;
    fs::remove_file(directory.join("image.part")).map_err(|_| Failure::io("ota_output_io"))?;
    sync_directory(directory)
}

async fn download(
    raw: &[u8],
    directory: &Path,
    ca_file: Option<&Path>,
) -> Result<(Receipt, i32), Failure> {
    let request = ota::parse_document(raw).map_err(|error| Failure::invalid(error.code))?;
    ota::check_request(&request, chrono::Utc::now())
        .map_err(|error| Failure::invalid(error.code))?;
    let client = client(ca_file)?;
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(directory).map_err(|error| {
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            Failure::new("ota_output_exists", 4)
        } else {
            Failure::io("ota_output_io")
        }
    })?;
    let parent = directory
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    sync_directory(parent)?;
    let mut original = new_file(&directory.join("request.json"))?;
    original
        .write_all(raw)
        .and_then(|_| original.sync_all())
        .map_err(|_| Failure::io("ota_output_io"))?;
    let mut receipt = Receipt {
        version: 1,
        downloader: "limeiot.ota-download/1.0.0",
        status: "started",
        request_digest: limeiot_core::digest(&request)
            .map_err(|_| Failure::invalid("invalid_ota_document"))?,
        artifact_id: request.manifest.statement.artifact_id.clone(),
        bytes_received: 0,
        verification: None,
        error: None,
    };
    save_receipt(directory, &receipt)?;
    let exit = match transfer(&client, &request, raw, directory, &mut receipt).await {
        Ok(()) => {
            receipt.status = "verified";
            0
        }
        Err(failure) => {
            receipt.status = "failed";
            receipt.error = Some(failure.code);
            failure.exit
        }
    };
    save_receipt(directory, &receipt)?;
    Ok((receipt, exit))
}

pub(super) fn run(raw: &[u8], directory: &Path, ca_file: Option<&Path>) -> i32 {
    let result = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| Failure::io("ota_component_unavailable"))
        .and_then(|runtime| runtime.block_on(download(raw, directory, ca_file)));
    match result {
        Ok((receipt, exit)) => {
            println!(
                "{}",
                serde_json::to_string(&receipt).expect("bounded receipt")
            );
            exit
        }
        Err(failure) => {
            eprintln!("{}", json!({"error":{"code":failure.code}}));
            failure.exit
        }
    }
}
