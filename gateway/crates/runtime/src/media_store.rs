//! 有界独立媒体快照；所有阻塞I/O在媒体worker执行，不持有核心SQLite锁。
use limeiot_core::{
    ensure, err,
    media::{GrantTarget, Operation, Request, State},
    Result,
};
use std::{
    fs::{File, OpenOptions},
    io::{BufWriter, Read, Write},
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
// 新能力共用快照后，先按实际JSON转义计数，避免成功写入却超过启动读取上限。
struct SnapshotBudget(usize);
impl Write for SnapshotBudget {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0 = self
            .0
            .checked_sub(bytes.len())
            .ok_or_else(|| std::io::Error::other("snapshot_capacity"))?;
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
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
        for task in next.transcriptions.values_mut() {
            if task.status == limeiot_core::model_job::Status::Running {
                task.status = limeiot_core::model_job::Status::Unknown;
                task.error_code = Some("transcription_interrupted".into());
                task.updated_at = now;
                interrupted = true;
            }
        }
        for task in next.visions.values_mut() {
            if task.status == limeiot_core::model_job::Status::Running {
                task.status = limeiot_core::model_job::Status::Unknown;
                task.error_code = Some("vision_interrupted".into());
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
    pub(crate) fn persist(&mut self, mut next: State) -> Result<()> {
        self.ready()?;
        next.prune(next.saved_at);
        serde_json::to_writer(SnapshotBudget(48 * 1024 * 1024 - 1), &next)
            .map_err(|_| err("media_capacity"))?;
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
            {
                // 合并JSON碎片写入；先检查flush，再同步文件和目录，保留原耐久顺序。
                let mut writer = BufWriter::new(&mut file);
                serde_json::to_writer(&mut writer, &next)?;
                writer.write_all(b"\n")?;
                writer.flush()?;
            }
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
        ensure(
            !self.state.speech.values().any(|task| {
                matches!(
                    task.status,
                    limeiot_core::speech::Status::Running | limeiot_core::speech::Status::Unknown
                )
            }),
            "speech_busy",
        )?;
        let now = self.now()?;
        let task =
            limeiot_core::speech::Task::new(&self.state.space_id, &key, input, deployment, now)?;
        let mut next = self.state.clone();
        next.schema_version = next.schema_version.max(2);
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
            Ok(bytes) => next
                .add_audio(&bytes, task.retain_seconds, now)
                .map(|media| media.media_id)
                .map_err(|_| err("speech_output_unavailable")),
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
        if !matches!(task.status, Status::Running | Status::Unknown) {
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

impl Store {
    pub fn transcription_accept(
        &mut self,
        key: String,
        input: &limeiot_core::transcription::Input,
        deployment: limeiot_core::model_job::Deployment,
    ) -> Result<(limeiot_core::transcription::Task, bool, Vec<u8>)> {
        use base64::{engine::general_purpose::STANDARD, Engine};
        use limeiot_core::{
            model_job::Status,
            transcription::{Task, MAX_TASKS},
        };
        self.ready()?;
        let digest = input.request_digest(&self.state.space_id, &key)?;
        if let Some(old) = self.state.transcriptions.get(&key) {
            ensure(old.request_digest == digest, "idempotency_conflict")?;
            return Ok((old.clone(), false, Vec::new()));
        }
        ensure(
            self.state.transcriptions.len() < MAX_TASKS,
            "transcription_capacity",
        )?;
        ensure(
            !self
                .state
                .transcriptions
                .values()
                .any(|task| matches!(task.status, Status::Running | Status::Unknown)),
            "transcription_busy",
        )?;
        let now = self.now()?;
        let task = Task::new(&self.state.space_id, &key, input, deployment, now)?;
        let object = self.state.active_object(&input.media_id, now)?;
        ensure(
            object.metadata.content_digest == input.media_digest,
            "transcription_source_mismatch",
        )?;
        let bytes = STANDARD
            .decode(object.content_base64.as_ref().expect("active audio"))
            .map_err(|_| err("media_storage_corrupt"))?;
        let mut next = self.state.clone();
        next.schema_version = next.schema_version.max(3);
        next.saved_at = now;
        next.transcriptions.insert(key, task.clone());
        self.persist(next)?;
        Ok((task, true, bytes))
    }
    pub fn transcription_finish(
        &mut self,
        key: &str,
        result: Result<String>,
    ) -> Result<limeiot_core::transcription::Task> {
        use limeiot_core::{
            model_job::Status,
            transcription::{text, Output},
        };
        self.ready()?;
        let mut task = self
            .state
            .transcriptions
            .get(key)
            .cloned()
            .ok_or_else(|| err("transcription_not_found"))?;
        if task.status != Status::Running {
            return Ok(task);
        }
        let now = self.now()?;
        let result = if now >= task.input.expires_at {
            Err(err("transcription_deadline_exceeded"))
        } else {
            result
        };
        let publication = result.and_then(|value| {
            ensure(text(&value), "invalid_transcription_output")?;
            let source = self
                .state
                .active_object(&task.input.media_id, now)
                .map_err(|_| err("transcription_source_unavailable"))?;
            Ok(Output {
                text: Some(value.clone()),
                content_digest: limeiot_core::media::content_digest(value.as_bytes()),
                expires_at: source.metadata.expires_at,
                cleared_at: None,
            })
        });
        match publication {
            Ok(output) => {
                task.status = Status::Succeeded;
                task.output = Some(output);
            }
            Err(error) => {
                task.status = if matches!(
                    error.code.as_str(),
                    "transcription_provider_unknown"
                        | "transcription_deadline_exceeded"
                        | "transcription_interrupted"
                ) {
                    Status::Unknown
                } else {
                    Status::Failed
                };
                task.error_code = Some(error.code);
            }
        }
        task.updated_at = now;
        let mut next = self.state.clone();
        next.saved_at = now;
        next.transcriptions.insert(key.into(), task.clone());
        self.persist(next)?;
        Ok(task)
    }
    pub fn transcription_discard(
        &mut self,
        key: &str,
    ) -> Result<limeiot_core::transcription::Task> {
        use limeiot_core::model_job::Status;
        self.ready()?;
        let mut task = self
            .state
            .transcriptions
            .get(key)
            .cloned()
            .ok_or_else(|| err("transcription_not_found"))?;
        ensure(
            task.status != Status::Succeeded,
            "transcription_already_completed",
        )?;
        if !matches!(task.status, Status::Running | Status::Unknown) {
            return Ok(task);
        }
        let now = self.now()?;
        task.status = Status::Discarded;
        task.error_code = Some("transcription_output_discarded".into());
        task.updated_at = now;
        let mut next = self.state.clone();
        next.saved_at = now;
        next.transcriptions.insert(key.into(), task.clone());
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
    fn speech_input() -> limeiot_core::speech::Input {
        limeiot_core::speech::Input {
            text: "不保存这段私密文本".into(),
            voice: "local".into(),
            retain_seconds: 600,
            expires_at: chrono::DateTime::from_timestamp_millis(
                chrono::Utc::now().timestamp_millis() + 60000,
            )
            .unwrap(),
        }
    }
    fn speech_deployment() -> limeiot_core::speech::Deployment {
        limeiot_core::speech::Deployment {
            adapter: "local-http-speech-v1".into(),
            model: "test".into(),
            revision: format!("sha256:{}", "a".repeat(64)),
            data_location: "local".into(),
        }
    }
    #[test]
    fn speech_restart_never_resends_text_and_discard_blocks_late_publication() {
        use limeiot_core::speech::Status;
        let fixture = Fixture::new();
        let input = speech_input();
        let mut store = Store::open(&fixture.path, "space").unwrap();
        let (task, first) = store
            .speech_accept("first".into(), &input, speech_deployment())
            .unwrap();
        assert!(first);
        assert!(
            !store
                .speech_accept("first".into(), &input, speech_deployment())
                .unwrap()
                .1
        );
        let mut changed = input.clone();
        changed.text.push('!');
        assert_eq!(
            store
                .speech_accept("first".into(), &changed, speech_deployment())
                .unwrap_err()
                .code,
            "idempotency_conflict"
        );
        assert!(!std::fs::read_to_string(&fixture.path)
            .unwrap()
            .contains(&input.text));
        drop(store);
        let mut store = Store::open(&fixture.path, "space").unwrap();
        assert_eq!(store.state.speech["first"].status, Status::Unknown);
        assert_eq!(store.state.speech["first"].synthesis_id, task.synthesis_id);
        assert_eq!(
            store
                .speech_finish("first", Err(err("speech_provider_unknown")))
                .unwrap()
                .error_code
                .as_deref(),
            Some("speech_interrupted")
        );
        assert_eq!(
            store
                .speech_accept("blocked".into(), &input, speech_deployment())
                .unwrap_err()
                .code,
            "speech_busy"
        );
        store.speech_discard("first").unwrap();
        store
            .speech_accept("second".into(), &input, speech_deployment())
            .unwrap();
        store.speech_discard("second").unwrap();
        assert_eq!(
            store
                .speech_finish("second", Ok(vec![0; 46]))
                .unwrap()
                .status,
            Status::Discarded
        );
        assert!(store.state.objects.is_empty());
        store.state.validate().unwrap();
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
    fn transcription_result_retention_source_delete_and_restart() {
        use limeiot_core::{model_job::Deployment, transcription::Input};
        let fixture = Fixture::new();
        let mut store = Store::open(&fixture.path, "home").unwrap();
        let now = store.now().unwrap();
        let Receipt::Uploaded { media } = store
            .apply(request("source"), None, "epoch", now)
            .unwrap()
            .result
        else {
            panic!("uploaded source")
        };
        let input = Input {
            media_id: media.media_id.clone(),
            media_digest: media.content_digest.clone(),
            language: "auto".into(),
            expires_at: chrono::DateTime::from_timestamp_millis(now.timestamp_millis() + 60000)
                .unwrap(),
        };
        let deployment = Deployment {
            adapter: "local-http-transcription-v1".into(),
            revision: format!("sha256:{}", "a".repeat(64)),
            model: "fixture".into(),
            data_location: "local".into(),
        };
        let (original, created, bytes) = store
            .transcription_accept("first".into(), &input, deployment.clone())
            .unwrap();
        assert!(created);
        assert!(!bytes.is_empty());
        assert_eq!(store.state.schema_version, 3);
        store.state.validate().unwrap();
        let text = "识别结果不会变成设备指令";
        let completed = store
            .transcription_finish("first", Ok(text.into()))
            .unwrap();
        assert_eq!(
            completed.output.as_ref().unwrap().text.as_deref(),
            Some(text)
        );
        // 两种能力共存时，后续TTS受理不得将媒体v3降回v2。
        store
            .speech_accept("tts".into(), &speech_input(), speech_deployment())
            .unwrap();
        assert_eq!(store.state.schema_version, 3);
        store.speech_discard("tts").unwrap();
        store.state.validate().unwrap();
        drop(store);
        let mut store = Store::open(&fixture.path, "home").unwrap();
        store.state.validate().unwrap();
        assert_eq!(
            store.state.transcriptions["first"].transcription_id,
            original.transcription_id
        );
        let mut expired = store.state.clone();
        let later = media.expires_at + chrono::Duration::seconds(1);
        assert!(expired.prune(later));
        expired.saved_at = later;
        expired.validate().unwrap();
        assert!(expired.transcriptions["first"]
            .output
            .as_ref()
            .unwrap()
            .text
            .is_none());
        let now = store.now().unwrap();
        store
            .apply(
                Request {
                    space_id: "home".into(),
                    idempotency_key: "delete".into(),
                    change: Change::Delete {
                        media_id: media.media_id,
                    },
                },
                None,
                "epoch",
                now,
            )
            .unwrap();
        let output = store.state.transcriptions["first"].output.as_ref().unwrap();
        assert!(output.text.is_none());
        assert!(output.cleared_at.is_some());
        store.state.validate().unwrap();
        drop(store);
        let store = Store::open(&fixture.path, "home").unwrap();
        assert!(store.state.transcriptions["first"]
            .output
            .as_ref()
            .unwrap()
            .text
            .is_none());
        let mut tampered = store.state.clone();
        tampered.schema_version = 2;
        assert!(tampered.validate().is_err());
    }

    #[test]
    fn transcription_commit_failure_keeps_original_unknown_and_blocks_late_results() {
        use limeiot_core::{
            model_job::{Deployment, Status},
            transcription::Input,
        };
        let fixture = Fixture::new();
        let mut store = Store::open(&fixture.path, "home").unwrap();
        let now = store.now().unwrap();
        let Receipt::Uploaded { media } = store
            .apply(request("source"), None, "epoch", now)
            .unwrap()
            .result
        else {
            panic!("source")
        };
        let input = Input {
            media_id: media.media_id,
            media_digest: media.content_digest,
            language: "zh".into(),
            expires_at: chrono::DateTime::from_timestamp_millis(now.timestamp_millis() + 60000)
                .unwrap(),
        };
        let deployment = Deployment {
            adapter: "local-http-transcription-v1".into(),
            revision: format!("sha256:{}", "a".repeat(64)),
            model: "fixture".into(),
            data_location: "local".into(),
        };
        store
            .transcription_accept("first".into(), &input, deployment.clone())
            .unwrap();
        store.path = fixture.directory.join("missing/snapshot.json");
        assert_eq!(
            store
                .transcription_finish("first", Ok("不能发布未保存的结果".into()))
                .unwrap_err()
                .code,
            "media_storage_unavailable"
        );
        assert!(store.ready().is_err());
        drop(store);
        let mut store = Store::open(&fixture.path, "home").unwrap();
        assert_eq!(store.state.transcriptions["first"].status, Status::Unknown);
        assert_eq!(
            store
                .transcription_accept("new".into(), &input, deployment)
                .unwrap_err()
                .code,
            "transcription_busy"
        );
        store.transcription_discard("first").unwrap();
        assert_eq!(
            store
                .transcription_finish("first", Ok("迟到结果".into()))
                .unwrap()
                .status,
            Status::Discarded
        );
        assert!(store.state.transcriptions["first"].output.is_none());
        store.state.validate().unwrap();
    }
    #[test]
    fn speech_output_has_independent_identity_and_atomic_storage_failure() {
        use limeiot_core::speech::Status;
        let fixture = Fixture::new();
        let mut store = Store::open(&fixture.path, "home").unwrap();
        let input = speech_input();
        let (task, _) = store
            .speech_accept("speech".into(), &input, speech_deployment())
            .unwrap();
        let uploaded = store
            .apply(
                request(&task.synthesis_id),
                None,
                "epoch",
                chrono::Utc::now(),
            )
            .unwrap();
        let Receipt::Uploaded { media: uploaded } = uploaded.result else {
            panic!("upload");
        };
        let limeiot_core::media::Change::Upload { content_base64, .. } = request("unused").change
        else {
            panic!("upload");
        };
        let bytes = STANDARD.decode(content_base64).unwrap();
        let finished = store.speech_finish("speech", Ok(bytes.clone())).unwrap();
        assert_eq!(finished.status, Status::Succeeded);
        assert_ne!(
            finished.media_id.as_deref(),
            Some(uploaded.media_id.as_str())
        );
        assert_eq!(store.state.operations.len(), 1);
        assert_eq!(store.state.objects.len(), 2);
        store.state.validate().unwrap();
        drop(store);
        assert_eq!(
            Store::open(&fixture.path, "home").unwrap().state.speech["speech"].status,
            Status::Succeeded
        );

        let fixture = Fixture::new();
        let mut store = Store::open(&fixture.path, "home").unwrap();
        store
            .speech_accept("speech".into(), &input, speech_deployment())
            .unwrap();
        let before = std::fs::read(&fixture.path).unwrap();
        let previous = fixture.path.with_extension("previous");
        std::fs::rename(&fixture.path, &previous).unwrap();
        std::fs::create_dir(&fixture.path).unwrap();
        assert_eq!(
            store.speech_finish("speech", Ok(bytes)).unwrap_err().code,
            "media_storage_unavailable"
        );
        assert_eq!(store.state.speech["speech"].status, Status::Running);
        assert!(store.state.objects.is_empty());
        assert!(store.ready().is_err());
        assert_eq!(std::fs::read(&previous).unwrap(), before);
        drop(store);
        std::fs::remove_dir(&fixture.path).unwrap();
        std::fs::rename(previous, &fixture.path).unwrap();
        let recovered = Store::open(&fixture.path, "home").unwrap();
        assert_eq!(recovered.state.speech["speech"].status, Status::Unknown);
        assert!(recovered.state.objects.is_empty());
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
