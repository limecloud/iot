//! 本地不可覆盖的制品仓库；静态HTTPS只暴露完成提交的镜像和清单。
use super::publication::{self, Failure, Result};
use serde_json::json;
use std::{fs, path::Path};

fn repository_directory(path: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path).map_err(|_| Failure::io("ota_repository_io"))?;
    if !metadata.is_dir() {
        return Err(Failure::invalid("invalid_ota_repository"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o022 != 0 {
            return Err(Failure::invalid("ota_repository_permissions"));
        }
    }
    Ok(())
}

pub fn run(bundle: &Path, trust: &Path, repository: &Path, base_url: &str) -> i32 {
    publication::emit((|| {
        // 完整重验在任何仓库写入前完成；不读取私钥，也不根据ready文本授信。
        let validated = publication::validate_bundle(bundle, trust, base_url)?;
        repository_directory(repository)?;
        let artifacts = repository.join("artifacts");
        match publication::directory(&artifacts) {
            Ok(()) => (),
            Err(error) if error.exit == 4 => repository_directory(&artifacts)?,
            Err(error) => return Err(error),
        }
        let statement = &validated.manifest.statement;
        let output = artifacts.join(&statement.artifact_id);
        publication::directory(&output)?;
        for (name, bytes) in &validated.files {
            publication::write(&output.join(name), bytes)?;
        }
        publication::sync(&output)?;
        validated.recheck()?;
        let receipt = json!({"version":1, "publisher":"limeiot.ota-publish/1.0.0", "status":"stored",
            "artifact_id":statement.artifact_id, "manifest_digest":validated.receipt["manifest_digest"],
            "image_size_bytes":statement.size_bytes, "image_sha256":statement.sha256,
            "download_url":statement.download.url});
        publication::write(
            &output.join("publication.pending.json"),
            &publication::json_bytes(&receipt)?,
        )?;
        // 最后的独占硬链接原子提交标记；中断留下的目录不会自动覆盖、续写或暴露。
        fs::hard_link(
            output.join("publication.pending.json"),
            output.join("published.json"),
        )
        .map_err(|_| Failure::io("ota_repository_commit_io"))?;
        publication::sync(&output)?;
        Ok(receipt)
    })())
}
