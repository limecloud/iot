//! 文字生成复用媒体快照的独占写入与原子提交，输入正文只存在于本次调用内存。
use crate::media_store::Store;
use limeiot_core::{
    ensure, err,
    model_job::{Deployment, Status},
    text::{Input, Output, Task, Usage, MAX_TASKS},
    Result,
};
impl Store {
    pub fn text_accept(
        &mut self,
        key: String,
        input: Input,
        deployment: Deployment,
    ) -> Result<(Task, bool)> {
        self.ready()?;
        let digest = input.request_digest(&self.state.space_id, &key)?;
        if let Some(old) = self.state.texts.get(&key) {
            ensure(old.request_digest == digest, "idempotency_conflict")?;
            return Ok((old.clone(), false));
        }
        ensure(self.state.texts.len() < MAX_TASKS, "text_capacity")?;
        ensure(
            !self
                .state
                .texts
                .values()
                .any(|t| matches!(t.status, Status::Running | Status::Unknown)),
            "text_busy",
        )?;
        let now = self.now()?;
        let task = Task::new(&self.state.space_id, &key, input, deployment, now)?;
        let mut next = self.state.clone();
        next.schema_version = 5;
        next.saved_at = now;
        next.texts.insert(key, task.clone());
        self.persist(next)?;
        Ok((task, true))
    }
    pub fn text_finish(
        &mut self,
        key: &str,
        result: Result<(String, Option<Usage>)>,
    ) -> Result<Task> {
        self.ready()?;
        let mut task = self
            .state
            .texts
            .get(key)
            .cloned()
            .ok_or_else(|| err("text_not_found"))?;
        if task.status != Status::Running {
            return Ok(task);
        }
        let now = self.now()?;
        let result = if now >= task.input.expires_at {
            Err(err("text_deadline_exceeded"))
        } else {
            result
        };
        match result.and_then(|(value, usage)| {
            ensure(
                limeiot_core::text::text(&value) && usage.as_ref().is_none_or(Usage::valid),
                "invalid_text_output",
            )?;
            Ok((value, usage))
        }) {
            Ok((value, usage)) => {
                task.status = Status::Succeeded;
                task.usage = usage;
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
                    "text_provider_unknown" | "text_deadline_exceeded" | "text_interrupted"
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
        next.texts.insert(key.into(), task.clone());
        self.persist(next)?;
        Ok(task)
    }
    pub fn text_discard(&mut self, key: &str) -> Result<Task> {
        self.ready()?;
        let mut task = self
            .state
            .texts
            .get(key)
            .cloned()
            .ok_or_else(|| err("text_not_found"))?;
        let now = self.now()?;
        match task.status {
            Status::Succeeded => {
                let output = task.output.as_mut().expect("validated text output");
                if output.text.take().is_none() {
                    return Ok(task);
                }
                output.cleared_at = Some(now);
            }
            Status::Running | Status::Unknown => {
                task.status = Status::Discarded;
                task.error_code = Some("text_output_discarded".into());
                task.updated_at = now;
            }
            _ => return Ok(task),
        }
        let mut next = self.state.clone();
        next.saved_at = now;
        next.texts.insert(key.into(), task.clone());
        self.persist(next)?;
        Ok(task)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Duration, SubsecRound, Utc};
    struct Fixture {
        directory: std::path::PathBuf,
        path: std::path::PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let directory =
                std::env::temp_dir().join(format!("limeiot-text-{}", limeiot_core::id()));
            std::fs::create_dir(&directory).unwrap();
            let path = directory.join("state.json");
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
            context_digest: format!("sha256:{}", "b".repeat(64)),
            context_bytes: 10,
            message_count: 1,
            retain_seconds: 60,
            expires_at: Utc::now().round_subsecs(3) + Duration::seconds(60),
        }
    }
    fn deployment() -> Deployment {
        Deployment {
            adapter: "ollama-text-v1".into(),
            revision: format!("sha256:{}", "c".repeat(64)),
            model: "fixture:text".into(),
            data_location: "local".into(),
        }
    }
    #[test]
    fn text_store_restarts_as_unknown_and_never_resends_or_publishes_discarded_output() {
        let f = Fixture::new();
        let mut store = f.open();
        let original = input();
        let task = store
            .text_accept("first".into(), original.clone(), deployment())
            .unwrap()
            .0;
        store.state.validate().unwrap();
        drop(store);
        let mut store = f.open();
        assert_eq!(store.state.texts["first"].status, Status::Unknown);
        assert_eq!(store.state.texts["first"].text_id, task.text_id);
        let (old, created) = store
            .text_accept("first".into(), original, deployment())
            .unwrap();
        assert!(!created);
        assert_eq!(old.text_id, task.text_id);
        assert_eq!(
            store
                .text_accept("second".into(), input(), deployment())
                .unwrap_err()
                .code,
            "text_busy"
        );
        store.text_discard("first").unwrap();
        assert_eq!(
            store
                .text_finish("first", Ok(("迟到正文".into(), None)))
                .unwrap()
                .status,
            Status::Discarded
        );
        store
            .text_accept("second".into(), input(), deployment())
            .unwrap();
        store
            .text_finish(
                "second",
                Ok((
                    "保留这段文字".into(),
                    Some(Usage {
                        input_tokens: 2,
                        output_tokens: 3,
                    }),
                )),
            )
            .unwrap();
        store.state.validate().unwrap();
        store.text_discard("second").unwrap();
        drop(store);
        let store = f.open();
        assert_eq!(
            store.state.texts["second"].output.as_ref().unwrap().text,
            None
        );
        assert!(!std::fs::read_to_string(&f.path)
            .unwrap()
            .contains("迟到正文"));
    }
    #[test]
    fn text_store_failed_commit_does_not_accept_and_corrupt_old_versions_are_not_rewritten() {
        let f = Fixture::new();
        let mut store = f.open();
        std::fs::create_dir(&f.path).unwrap();
        assert_eq!(
            store
                .text_accept("unsaved".into(), input(), deployment())
                .unwrap_err()
                .code,
            "media_storage_unavailable"
        );
        assert!(store.state.texts.is_empty());
        assert!(store.ready().is_err());
        let f = Fixture::new();
        let mut store = f.open();
        store
            .text_accept("original".into(), input(), deployment())
            .unwrap();
        drop(store);
        let mut value: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&f.path).unwrap()).unwrap();
        value["schema_version"] = 4.into();
        let bytes = serde_json::to_vec(&value).unwrap();
        std::fs::write(&f.path, &bytes).unwrap();
        assert!(Store::open(&f.path, "home").is_err());
        assert_eq!(std::fs::read(&f.path).unwrap(), bytes);
    }
    #[test]
    fn text_store_vision_can_coexist_without_downgrading_snapshot() {
        let f = Fixture::new();
        let mut store = f.open();
        store
            .text_accept("text".into(), input(), deployment())
            .unwrap();
        store
            .text_finish("text", Ok(("你好".into(), None)))
            .unwrap();
        store
            .vision_accept(
                "image".into(),
                limeiot_core::vision::Input {
                    image_digest: format!("sha256:{}", "a".repeat(64)),
                    image_bytes: 50,
                    content_type: "image/png".into(),
                    prompt_digest: format!("sha256:{}", "b".repeat(64)),
                    retain_seconds: 60,
                    expires_at: input().expires_at,
                },
                limeiot_core::vision::ImageSize {
                    width: 1,
                    height: 1,
                },
                Deployment {
                    adapter: "ollama-vision-v1".into(),
                    ..deployment()
                },
            )
            .unwrap();
        assert_eq!(store.state.schema_version, 5);
        store.state.validate().unwrap();
        drop(store);
        let store = f.open();
        assert_eq!(store.state.texts["text"].status, Status::Succeeded);
        assert_eq!(store.state.visions["image"].status, Status::Unknown);
    }
}
