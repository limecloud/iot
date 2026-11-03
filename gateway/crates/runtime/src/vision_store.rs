//! 视觉任务复用媒体快照的原子提交与独立I/O锁，图片和问题正文不入库。
use crate::media_store::Store;
use limeiot_core::{
    ensure, err,
    model_job::{Deployment, Status},
    vision::{ImageSize, Input, Output, Task, MAX_TASKS},
    Result,
};

impl Store {
    pub fn vision_accept(
        &mut self,
        key: String,
        input: Input,
        image: ImageSize,
        deployment: Deployment,
    ) -> Result<(Task, bool)> {
        self.ready()?;
        let digest = input.request_digest(&self.state.space_id, &key)?;
        if let Some(old) = self.state.visions.get(&key) {
            ensure(old.request_digest == digest, "idempotency_conflict")?;
            return Ok((old.clone(), false));
        }
        ensure(self.state.visions.len() < MAX_TASKS, "vision_capacity")?;
        ensure(
            !self
                .state
                .visions
                .values()
                .any(|task| matches!(task.status, Status::Running | Status::Unknown)),
            "vision_busy",
        )?;
        let now = self.now()?;
        let task = Task::new(&self.state.space_id, &key, input, image, deployment, now)?;
        let mut next = self.state.clone();
        next.schema_version = 4;
        next.saved_at = now;
        next.visions.insert(key, task.clone());
        self.persist(next)?;
        Ok((task, true))
    }
    pub fn vision_finish(&mut self, key: &str, result: Result<String>) -> Result<Task> {
        self.ready()?;
        let mut task = self
            .state
            .visions
            .get(key)
            .cloned()
            .ok_or_else(|| err("vision_not_found"))?;
        if task.status != Status::Running {
            return Ok(task);
        }
        let now = self.now()?;
        let result = if now >= task.input.expires_at {
            Err(err("vision_deadline_exceeded"))
        } else {
            result
        };
        match result.and_then(|value| {
            ensure(limeiot_core::vision::text(&value), "invalid_vision_output")?;
            Ok(value)
        }) {
            Ok(value) => {
                task.status = Status::Succeeded;
                task.output = Some(Output {
                    content_digest: limeiot_core::media::content_digest(value.as_bytes()),
                    text: Some(value),
                    expires_at: now
                        + chrono::Duration::seconds(i64::from(task.input.retain_seconds)),
                    cleared_at: None,
                });
            }
            Err(error) => {
                task.status = if matches!(
                    error.code.as_str(),
                    "vision_provider_unknown" | "vision_deadline_exceeded" | "vision_interrupted"
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
        next.visions.insert(key.into(), task.clone());
        self.persist(next)?;
        Ok(task)
    }
    pub fn vision_discard(&mut self, key: &str) -> Result<Task> {
        self.ready()?;
        let mut task = self
            .state
            .visions
            .get(key)
            .cloned()
            .ok_or_else(|| err("vision_not_found"))?;
        let now = self.now()?;
        match task.status {
            Status::Succeeded => {
                let output = task.output.as_mut().expect("validated vision output");
                if output.text.take().is_none() {
                    return Ok(task);
                }
                output.cleared_at = Some(now);
            }
            Status::Running | Status::Unknown => {
                task.status = Status::Discarded;
                task.updated_at = now;
                task.error_code = Some("vision_output_discarded".into());
            }
            _ => return Ok(task),
        }
        let mut next = self.state.clone();
        next.saved_at = now;
        next.visions.insert(key.into(), task.clone());
        self.persist(next)?;
        Ok(task)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD, Engine};
    struct Fixture {
        directory: std::path::PathBuf,
        path: std::path::PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let directory =
                std::env::temp_dir().join(format!("limeiot-vision-{}", limeiot_core::id()));
            std::fs::create_dir(&directory).unwrap();
            let path = directory.join("gateway.media.json");
            Self { directory, path }
        }
        fn open(&self) -> Store {
            Store::open(&self.path, "home").unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.directory);
        }
    }
    fn input() -> Input {
        Input {
            image_digest: format!("sha256:{}", "a".repeat(64)),
            image_bytes: 100,
            content_type: "image/png".into(),
            prompt_digest: format!("sha256:{}", "b".repeat(64)),
            retain_seconds: 60,
            expires_at: chrono::Utc::now()
                .checked_add_signed(chrono::Duration::seconds(60))
                .unwrap()
                .round_subsecs(3),
        }
    }
    fn deployment() -> Deployment {
        Deployment {
            adapter: "ollama-vision-v1".into(),
            revision: format!("sha256:{}", "c".repeat(64)),
            model: "fixture:vision".into(),
            data_location: "local".into(),
        }
    }
    fn accept(store: &mut Store, key: &str) -> Task {
        store
            .vision_accept(
                key.into(),
                input(),
                ImageSize {
                    width: 1,
                    height: 1,
                },
                deployment(),
            )
            .unwrap()
            .0
    }
    use chrono::SubsecRound;
    #[test]
    fn vision_store_durable_unknown_blocks_new_requests_and_clears_late_output() {
        let fixture = Fixture::new();
        let mut store = fixture.open();
        let task = accept(&mut store, "first");
        store.state.validate().unwrap();
        drop(store);
        let mut store = fixture.open();
        assert_eq!(store.state.visions["first"].status, Status::Unknown);
        assert_eq!(store.state.visions["first"].vision_id, task.vision_id);
        assert_eq!(
            store
                .vision_accept(
                    "second".into(),
                    input(),
                    ImageSize {
                        width: 1,
                        height: 1
                    },
                    deployment()
                )
                .unwrap_err()
                .code,
            "vision_busy"
        );
        store.vision_discard("first").unwrap();
        assert_eq!(
            store
                .vision_finish("first", Ok("late".into()))
                .unwrap()
                .status,
            Status::Discarded
        );
        store.state.validate().unwrap();
    }
    #[test]
    fn vision_store_success_clear_and_ttl_keep_original_without_resurrection() {
        let fixture = Fixture::new();
        let mut store = fixture.open();
        accept(&mut store, "first");
        let completed = store
            .vision_finish("first", Ok("图片包含一个红色方块。".into()))
            .unwrap();
        store.state.validate().unwrap();
        let mut future = store.state.clone();
        let later = completed.output.as_ref().unwrap().expires_at + chrono::Duration::seconds(1);
        assert!(future.prune(later));
        future.saved_at = later;
        future.validate().unwrap();
        assert!(future.visions["first"]
            .output
            .as_ref()
            .unwrap()
            .text
            .is_none());
        store.vision_discard("first").unwrap();
        let original = store.vision_finish("first", Ok("late".into())).unwrap();
        assert_eq!(original.status, Status::Succeeded);
        assert!(original.output.unwrap().text.is_none());
        drop(store);
        let store = fixture.open();
        store.state.validate().unwrap();
        assert!(store.state.visions["first"]
            .output
            .as_ref()
            .unwrap()
            .text
            .is_none());
    }
    #[test]
    fn vision_store_v4_survives_asr_acceptance_and_digest_corruption_is_rejected() {
        let fixture = Fixture::new();
        let mut store = fixture.open();
        accept(&mut store, "first");
        store.vision_discard("first").unwrap();
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&40u32.to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&8000u32.to_le_bytes());
        wav.extend_from_slice(&16000u32.to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&4u32.to_le_bytes());
        wav.extend_from_slice(&[0; 4]);
        let now = store.now().unwrap();
        let operation = store
            .apply(
                limeiot_core::media::Request {
                    space_id: "home".into(),
                    idempotency_key: "upload".into(),
                    change: limeiot_core::media::Change::Upload {
                        content_base64: STANDARD.encode(&wav),
                        retain_seconds: 600,
                    },
                },
                None,
                "epoch",
                now,
            )
            .unwrap();
        let limeiot_core::media::Receipt::Uploaded { media } = operation.result else {
            panic!("upload");
        };
        store
            .transcription_accept(
                "asr".into(),
                &limeiot_core::transcription::Input {
                    media_id: media.media_id,
                    media_digest: media.content_digest,
                    language: "auto".into(),
                    expires_at: input().expires_at,
                },
                Deployment {
                    adapter: "local-http-transcription-v1".into(),
                    ..deployment()
                },
            )
            .unwrap();
        assert_eq!(store.state.schema_version, 4);
        store.state.validate().unwrap();
        drop(store);
        let store = fixture.open();
        assert_eq!(store.state.schema_version, 4);
        store.state.validate().unwrap();
        let mut bad = store.state.clone();
        bad.visions.get_mut("first").unwrap().input.image_digest =
            format!("sha256:{}", "d".repeat(64));
        assert_eq!(bad.validate().unwrap_err().code, "media_storage_corrupt");
    }
}
