//! 有界独立媒体快照；所有阻塞I/O在媒体worker执行，不持有核心SQLite锁。
use limeiot_core::{
    ensure, err,
    media::{GrantTarget, Operation, Request, State},
    Result,
};
use std::{
    fs::{File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

pub struct Store {
    pub state: State,
    path: PathBuf,
    poisoned: bool,
    clock: chrono::DateTime<chrono::Utc>,
    tick: std::time::Instant,
    _lock: File,
}
impl Store {
    pub fn open(path: &Path, space_id: &str) -> Result<Self> {
        let fail = || err("media_storage_unavailable");
        let parent = path
            .parent()
            .ok_or_else(fail)?
            .canonicalize()
            .map_err(|_| fail())?;
        let path = parent.join(path.file_name().ok_or_else(fail)?);
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
        }
        let lock = options
            .open(path.with_extension("media.lock"))
            .map_err(|_| fail())?;
        ensure(
            lock.metadata().map_err(|_| fail())?.is_file(),
            "media_storage_unavailable",
        )?;
        #[cfg(unix)]
        {
            use std::os::unix::{fs::PermissionsExt, io::AsRawFd};
            ensure(
                lock.metadata().map_err(|_| fail())?.permissions().mode() & 0o077 == 0,
                "media_storage_unavailable",
            )?;
            // flock仅作用于本服务打开的普通锁文件，File存活期间保持唯一写入者。
            ensure(
                unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0,
                "media_storage_busy",
            )?;
        }
        #[cfg(not(unix))]
        {
            return Err(err("media_platform_unsupported"));
        }
        let state = match std::fs::symlink_metadata(&path) {
            Ok(metadata) => {
                ensure(
                    metadata.is_file() && metadata.len() <= 48 * 1024 * 1024,
                    "media_storage_corrupt",
                )?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    ensure(
                        metadata.permissions().mode() & 0o077 == 0,
                        "media_storage_unavailable",
                    )?;
                }
                let mut options = OpenOptions::new();
                options.read(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
                }
                let file = options.open(&path).map_err(|_| fail())?;
                let metadata = file.metadata().map_err(|_| fail())?;
                ensure(
                    metadata.is_file() && metadata.len() <= 48 * 1024 * 1024,
                    "media_storage_corrupt",
                )?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    ensure(
                        metadata.permissions().mode() & 0o077 == 0,
                        "media_storage_unavailable",
                    )?;
                }
                let mut bytes = Vec::new();
                file.take(48 * 1024 * 1024 + 1)
                    .read_to_end(&mut bytes)
                    .map_err(|_| fail())?;
                let value = limeiot_core::validation::bounded_document(
                    &bytes,
                    48 * 1024 * 1024,
                    12,
                    100_000,
                )
                .ok_or_else(|| err("media_storage_corrupt"))?;
                let state: State =
                    serde_json::from_value(value).map_err(|_| err("media_storage_corrupt"))?;
                state.validate()?;
                ensure(state.space_id == space_id, "media_storage_corrupt")?;
                state
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                State::new(space_id.into(), chrono::Utc::now())
            }
            Err(_) => return Err(fail()),
        };
        let now = chrono::Utc::now();
        ensure(now >= state.saved_at, "media_clock_invalid")?;
        let mut store = Self {
            state,
            path,
            poisoned: false,
            clock: now,
            tick: std::time::Instant::now(),
            _lock: lock,
        };
        // 正文从不进入快照；重启不能重新发送，未完成调用只能保留未知。
        let mut next = store.state.clone();
        let mut interrupted = false;
        for task in next.speech.values_mut() {
            if task.status == limeiot_core::speech::Status::Running {
                task.status = limeiot_core::speech::Status::Unknown;
                task.error_code = Some("speech_interrupted".into());
                task.updated_at = now;
                interrupted = true;
            }
        }
        if interrupted {
            next.saved_at = now;
            store.persist(next)?;
        }
        Ok(store)
    }
    pub fn ready(&self) -> Result<()> {
        ensure(!self.poisoned, "media_storage_unavailable")
    }
    pub fn now(&mut self) -> Result<chrono::DateTime<chrono::Utc>> {
        self.ready()?;
        let elapsed = chrono::Duration::from_std(self.tick.elapsed())
            .map_err(|_| err("media_clock_invalid"))?;
        self.clock = (self.clock + elapsed).max(chrono::Utc::now());
        self.tick = std::time::Instant::now();
        Ok(self.clock)
    }
    fn persist(&mut self, next: State) -> Result<()> {
        self.ready()?;
        let temp = self
            .path
            .with_extension(format!("media-{}.tmp", limeiot_core::id()));
        let result = (|| -> std::io::Result<()> {
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&temp)?;
            serde_json::to_writer(&mut file, &next)?;
            file.write_all(b"\n")?;
            file.sync_all()?;
            // 只替换本服务自己的快照；不接受符号链接或不受控目标。
            match std::fs::symlink_metadata(&self.path) {
                Ok(meta) if meta.is_file() => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                _ => return Err(std::io::ErrorKind::PermissionDenied.into()),
            }
            std::fs::rename(&temp, &self.path)?;
            File::open(self.path.parent().expect("canonical parent"))?.sync_all()?;
            Ok(())
        })();
        if result.is_err() {
            self.poisoned = true;
            let _ = std::fs::remove_file(&temp);
            return Err(err("media_storage_unavailable"));
        }
        self.state = next;
        Ok(())
    }
    pub fn apply(
        &mut self,
        request: Request,
        target: Option<GrantTarget>,
        epoch: &str,
        now: chrono::DateTime<chrono::Utc>,
    ) -> Result<Operation> {
        self.ready()?;
        let now = now.max(self.now()?);
        let mut next = self.state.clone();
        let result = next.apply(request, target, epoch, now)?;
        if !self.state.operations.contains_key(&result.idempotency_key) {
            self.persist(next)?;
        }
        Ok(result)
    }
    pub fn prune(&mut self, now: chrono::DateTime<chrono::Utc>) -> Result<()> {
        self.ready()?;
        let now = now.max(self.now()?);
        let mut next = self.state.clone();
        if next.prune(now) {
            next.saved_at = now;
            self.persist(next)?;
        }
        Ok(())
    }
    pub fn speech_accept(
        &mut self,
        key: String,
        input: &limeiot_core::speech::Input,
        deployment: limeiot_core::speech::Deployment,
    ) -> Result<(limeiot_core::speech::Task, bool)> {
        self.ready()?;
        let digest = input.request_digest(&self.state.space_id, &key)?;
        if let Some(old) = self.state.speech.get(&key) {
            ensure(old.request_digest == digest, "idempotency_conflict")?;
            return Ok((old.clone(), false));
        }
        ensure(
            self.state.speech.len() < limeiot_core::speech::MAX_TASKS,
            "speech_capacity",
        )?;
        let now = self.now()?;
        let task =
            limeiot_core::speech::Task::new(&self.state.space_id, &key, input, deployment, now)?;
        let mut next = self.state.clone();
        next.schema_version = 2;
        next.saved_at = now;
        next.speech.insert(key, task.clone());
        self.persist(next)?;
        Ok((task, true))
    }
    pub fn speech_finish(
        &mut self,
        key: &str,
        result: Result<Vec<u8>>,
    ) -> Result<limeiot_core::speech::Task> {
        use limeiot_core::speech::Status;
        self.ready()?;
        let old = self
            .state
            .speech
            .get(key)
            .cloned()
            .ok_or_else(|| err("speech_not_found"))?;
        if old.status != Status::Running {
            return Ok(old);
        }
        let now = self.now()?;
        let mut next = self.state.clone();
        let mut task = old;
        let result = if now >= task.expires_at {
            Err(err("speech_deadline_exceeded"))
        } else {
            result
        };
        let publication = match result {
            Ok(bytes) => {
                use base64::{engine::general_purpose::STANDARD, Engine};
                let request = Request {
                    space_id: next.space_id.clone(),
                    idempotency_key: task.synthesis_id.clone(),
                    change: limeiot_core::media::Change::Upload {
                        content_base64: STANDARD.encode(bytes),
                        retain_seconds: task.retain_seconds,
                    },
                };
                next.apply(request, None, "speech", now)
                    .map(|op| match op.result {
                        limeiot_core::media::Receipt::Uploaded { media } => media.media_id,
                        _ => unreachable!("typed upload"),
                    })
                    .map_err(|_| err("speech_output_unavailable"))
            }
            Err(error) => Err(error),
        };
        match publication {
            Ok(id) => {
                task.status = Status::Succeeded;
                task.media_id = Some(id);
            }
            Err(error) => {
                task.status = if matches!(
                    error.code.as_str(),
                    "speech_provider_unknown" | "speech_deadline_exceeded" | "speech_interrupted"
                ) {
                    Status::Unknown
                } else {
                    Status::Failed
                };
                task.error_code = Some(error.code);
            }
        }
        task.updated_at = now;
        next.speech.insert(key.into(), task.clone());
        next.saved_at = now;
        self.persist(next)?;
        Ok(task)
    }
    pub fn speech_discard(&mut self, key: &str) -> Result<limeiot_core::speech::Task> {
        use limeiot_core::speech::Status;
        self.ready()?;
        let mut task = self
            .state
            .speech
            .get(key)
            .cloned()
            .ok_or_else(|| err("speech_not_found"))?;
        ensure(task.status != Status::Succeeded, "speech_already_completed")?;
        if task.status != Status::Running {
            return Ok(task);
        }
        let now = self.now()?;
        task.status = Status::Discarded;
        task.error_code = Some("speech_output_discarded".into());
        task.updated_at = now;
        let mut next = self.state.clone();
        next.speech.insert(key.into(), task.clone());
        next.saved_at = now;
        self.persist(next)?;
        Ok(task)
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD, Engine};
    use limeiot_core::media::{Change, Receipt};
    use std::os::unix::fs::{symlink, PermissionsExt};

    struct Fixture {
        directory: PathBuf,
        path: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let directory =
                std::env::temp_dir().join(format!("limeiot-media-{}", limeiot_core::id()));
            std::fs::create_dir(&directory).unwrap();
            let path = directory.join("store.media.json");
            Self { directory, path }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.directory);
        }
    }
    fn request(key: &str) -> Request {
        let mut bytes = vec![0; 46];
        bytes[..4].copy_from_slice(b"RIFF");
        bytes[4..8].copy_from_slice(&38u32.to_le_bytes());
        bytes[8..16].copy_from_slice(b"WAVEfmt ");
        bytes[16..20].copy_from_slice(&16u32.to_le_bytes());
        bytes[20..22].copy_from_slice(&1u16.to_le_bytes());
        bytes[22..24].copy_from_slice(&1u16.to_le_bytes());
        bytes[24..28].copy_from_slice(&8000u32.to_le_bytes());
        bytes[28..32].copy_from_slice(&16000u32.to_le_bytes());
        bytes[32..34].copy_from_slice(&2u16.to_le_bytes());
        bytes[34..36].copy_from_slice(&16u16.to_le_bytes());
        bytes[36..40].copy_from_slice(b"data");
        bytes[40..44].copy_from_slice(&2u32.to_le_bytes());
        Request {
            space_id: "home".into(),
            idempotency_key: key.into(),
            change: Change::Upload {
                content_base64: STANDARD.encode(bytes),
                retain_seconds: 60,
            },
        }
    }
    #[test]
    fn media_store_durable_receipt_single_writer_and_restore() {
        let fixture = Fixture::new();
        let mut store = Store::open(&fixture.path, "home").unwrap();
        assert_eq!(
            Store::open(&fixture.path, "home").err().unwrap().code,
            "media_storage_busy"
        );
        let first = store
            .apply(request("upload"), None, "epoch", chrono::Utc::now())
            .unwrap();
        assert_eq!(
            std::fs::metadata(&fixture.path)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        drop(store);
        let mut reopened = Store::open(&fixture.path, "home").unwrap();
        let original = reopened
            .apply(request("upload"), None, "new-epoch", chrono::Utc::now())
            .unwrap();
        assert_eq!(first.operation_id, original.operation_id);
        assert_eq!(reopened.state.objects.len(), 1);
    }
    #[test]
    fn media_store_write_failure_does_not_publish_and_poisons_instance() {
        let fixture = Fixture::new();
        let mut store = Store::open(&fixture.path, "home").unwrap();
        store
            .apply(request("first"), None, "epoch", chrono::Utc::now())
            .unwrap();
        let bytes = std::fs::read(&fixture.path).unwrap();
        let original_path = fixture.path.with_extension("previous");
        std::fs::rename(&fixture.path, &original_path).unwrap();
        std::fs::create_dir(&fixture.path).unwrap();
        assert_eq!(
            store
                .apply(request("failed"), None, "epoch", chrono::Utc::now())
                .unwrap_err()
                .code,
            "media_storage_unavailable"
        );
        assert!(!store.state.operations.contains_key("failed"));
        assert_eq!(store.state.objects.len(), 1);
        assert!(store.now().is_err());
        assert!(store.prune(chrono::Utc::now()).is_err());
        assert_eq!(std::fs::read(original_path).unwrap(), bytes);
    }
    #[test]
    fn media_store_corrupt_future_symlink_or_wrong_scope_never_rewrite() {
        for variant in 0..4 {
            let fixture = Fixture::new();
            let mut store = Store::open(&fixture.path, "home").unwrap();
            store
                .apply(request("first"), None, "epoch", chrono::Utc::now())
                .unwrap();
            drop(store);
            let mut value: serde_json::Value =
                serde_json::from_slice(&std::fs::read(&fixture.path).unwrap()).unwrap();
            if variant == 0 {
                value["schema_version"] = 2.into();
            }
            if variant == 1 {
                value["saved_at"] = "2099-01-01T00:00:00Z".into();
            }
            std::fs::write(&fixture.path, serde_json::to_vec(&value).unwrap()).unwrap();
            let bytes = std::fs::read(&fixture.path).unwrap();
            if variant == 2 {
                let target = fixture.directory.join("target");
                std::fs::rename(&fixture.path, &target).unwrap();
                symlink(target, &fixture.path).unwrap();
            }
            assert!(
                Store::open(&fixture.path, if variant == 3 { "other" } else { "home" }).is_err()
            );
            assert_eq!(std::fs::read(&fixture.path).unwrap(), bytes);
        }
    }
    #[test]
    fn media_store_prune_survives_restore_and_old_upload_cannot_revive_body() {
        let fixture = Fixture::new();
        let mut store = Store::open(&fixture.path, "home").unwrap();
        let past = chrono::Utc::now() - chrono::Duration::seconds(120);
        let mut state = State::new("home".into(), past);
        let operation = state.apply(request("upload"), None, "epoch", past).unwrap();
        store.persist(state).unwrap();
        let Receipt::Uploaded { media } = operation.result else {
            panic!()
        };
        store.prune(chrono::Utc::now()).unwrap();
        assert!(store.state.objects[&media.media_id]
            .content_base64
            .is_none());
        drop(store);
        let mut reopened = Store::open(&fixture.path, "home").unwrap();
        let original = reopened
            .apply(request("upload"), None, "new-epoch", chrono::Utc::now())
            .unwrap();
        assert_eq!(original.operation_id, operation.operation_id);
        assert!(reopened.state.objects[&media.media_id]
            .content_base64
            .is_none());
        reopened.state.validate().unwrap();
    }
}
