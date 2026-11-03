//! 固定目标、受限动作的 ADB 适配。调用方负责耐久命令与唯一执行路由。
mod config;
mod process;

pub use config::{application_id, ApplicationGrant, Config, LaunchCategory};
use limeiot_core::{ensure, err, model::Model, protocol::Operation, Result};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, time::Duration};
use tokio::{
    sync::Mutex,
    time::{timeout_at, Instant},
};

// 整段为固定远端只读命令，不拼接配置或调用方输入；兼容 API 23 的 sh -c。
const IDENTITY_QUERY: &str = "getprop ro.build.fingerprint && getprop ro.serialno";

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Key {
    Up,
    Down,
    Left,
    Right,
    Select,
    Back,
    Home,
    Menu,
    PlayPause,
}
impl Key {
    fn code(self) -> &'static str {
        match self {
            Self::Up => "19",
            Self::Down => "20",
            Self::Left => "21",
            Self::Right => "22",
            Self::Select => "23",
            Self::Back => "4",
            Self::Home => "3",
            Self::Menu => "82",
            Self::PlayPause => "85",
        }
    }
}

enum Action {
    Press(Key),
    Launch(String),
}
impl Action {
    fn parse(operation: &Operation) -> Result<Self> {
        ensure(operation.kind == "action.invoke", "unsupported_tv_action")?;
        match operation.path.as_str() {
            "remote.press" => {
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields)]
                struct Input {
                    key: Key,
                }
                let input: Input = serde_json::from_value(operation.value.clone())
                    .map_err(|_| err("invalid_tv_action"))?;
                Ok(Self::Press(input.key))
            }
            "apps.launch" => {
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields)]
                struct Input {
                    application_id: String,
                }
                let input: Input = serde_json::from_value(operation.value.clone())
                    .map_err(|_| err("invalid_tv_action"))?;
                ensure(application_id(&input.application_id), "invalid_tv_action")?;
                Ok(Self::Launch(input.application_id))
            }
            _ => Err(err("unsupported_tv_action")),
        }
    }
}

/// 只表示已启用的包，不宣称存在启动 Activity、已在前台或已获控制授权。
#[derive(Clone, Debug, Serialize)]
pub struct Discovery {
    pub fingerprint: String,
    pub applications: BTreeSet<String>,
    pub observed_at: chrono::DateTime<chrono::Utc>,
    pub source: &'static str,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Stage {
    Submitted,
    Rejected,
    Unknown,
}
#[derive(Clone, Debug, Serialize)]
pub struct Outcome {
    pub stage: Stage,
    pub error: Option<&'static str>,
    pub observed_at: chrono::DateTime<chrono::Utc>,
    pub source: &'static str,
}
impl Outcome {
    fn new(stage: Stage, error: Option<&'static str>) -> Self {
        Self {
            stage,
            error,
            observed_at: chrono::Utc::now(),
            source: "android-tv-adb",
        }
    }
}

pub struct Adapter {
    config: Config,
    serial: Mutex<()>,
}
/// 只允许模型声明执行端确实支持的动作和输入子集；应用仍另查当前授权。
pub fn supports_model(model: &Model) -> bool {
    let supported: Model = serde_json::from_slice(include_bytes!(
        "../../../../contracts/models/android-tv-remote.json"
    ))
    .expect("android tv model");
    model.validate().is_ok()
        && model.services.iter().all(|service| {
            service.properties.is_empty()
                && service.events.is_empty()
                && supported
                    .services
                    .iter()
                    .find(|expected| expected.id == service.id)
                    .is_some_and(|expected| expected.semantic_id == service.semantic_id)
                && service.actions.iter().all(|action| {
                    supported
                        .action(&format!("{}.{}", service.id, action.id))
                        .is_ok_and(|expected| {
                            action.semantic_id == expected.semantic_id
                                && action.idempotent == expected.idempotent
                                && action.risk == expected.risk
                                && limeiot_core::execution::supports_action(action)
                                && limeiot_core::compatibility::schema_subset(
                                    &action.input,
                                    &expected.input,
                                )
                        })
                })
        })
}
impl Adapter {
    pub fn new(config: Config) -> Result<Self> {
        config.validate()?;
        let binary = std::fs::symlink_metadata(&config.adb_path)
            .map_err(|_| err("invalid_tv_adapter_config"))?;
        let directory = std::fs::symlink_metadata(&config.state_directory)
            .map_err(|_| err("invalid_tv_adapter_config"))?;
        ensure(
            binary.is_file() && directory.is_dir(),
            "invalid_tv_adapter_config",
        )?;
        Ok(Self {
            config,
            serial: Mutex::new(()),
        })
    }

    fn deadline(&self, requested: Instant) -> Instant {
        requested.min(Instant::now() + Duration::from_millis(self.config.timeout_ms))
    }

    async fn read(&self, args: &[&str], deadline: Instant) -> Result<String> {
        let output = process::run(&self.config, args, deadline)
            .await
            .map_err(|_| err("tv_probe_failed"))?;
        ensure(
            output.success && output.stderr.is_empty(),
            "tv_probe_failed",
        )?;
        String::from_utf8(output.stdout).map_err(|_| err("tv_probe_failed"))
    }

    async fn identity(&self, deadline: Instant) -> Result<()> {
        let output = self.read(&["shell", IDENTITY_QUERY], deadline).await?;
        let mut lines = output.lines();
        let fingerprint = lines.next().ok_or_else(|| err("tv_probe_failed"))?;
        let serial = lines.next().ok_or_else(|| err("tv_probe_failed"))?;
        ensure(
            output.ends_with('\n') && lines.next().is_none(),
            "tv_probe_failed",
        )?;
        ensure(
            fingerprint == self.config.fingerprint && serial == self.config.device_serial,
            "tv_identity_mismatch",
        )
    }

    async fn packages(&self, deadline: Instant) -> Result<BTreeSet<String>> {
        let output = self
            .read(&["shell", "pm", "list", "packages", "-e"], deadline)
            .await?;
        let mut packages = BTreeSet::new();
        for line in output.lines() {
            let id = line
                .strip_prefix("package:")
                .filter(|id| *id == "android" || application_id(id))
                .ok_or_else(|| err("invalid_tv_discovery"))?;
            ensure(
                packages.insert(id.to_owned()) && packages.len() <= 2048,
                "invalid_tv_discovery",
            )?;
        }
        Ok(packages)
    }

    pub async fn discover(&self, requested: Instant) -> Result<Discovery> {
        let deadline = self.deadline(requested);
        let _guard = timeout_at(deadline, self.serial.lock())
            .await
            .map_err(|_| err("tv_probe_failed"))?;
        self.identity(deadline).await?;
        let applications = self.packages(deadline).await?;
        Ok(Discovery {
            fingerprint: self.config.fingerprint.clone(),
            applications,
            observed_at: chrono::Utc::now(),
            source: "android-tv-adb",
        })
    }

    /// 只提交一次。调用前须由网关提交执行意图；本适配器不补发、不自动降级。
    pub async fn execute(&self, operation: &Operation, requested: Instant) -> Outcome {
        self.execute_authorized(operation, requested, || async { Ok(()) })
            .await
    }

    /// 只读预检完成后、可能产生副作用前，再由命令 Owner 核对当前授权。
    pub async fn execute_authorized<F, Fut>(
        &self,
        operation: &Operation,
        requested: Instant,
        authorize: F,
    ) -> Outcome
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Result<()>>,
    {
        let action = match Action::parse(operation) {
            Ok(action) => action,
            Err(_) => return Outcome::new(Stage::Rejected, Some("invalid_tv_action")),
        };
        let category = if let Action::Launch(id) = &action {
            match self
                .config
                .applications
                .iter()
                .find(|grant| &grant.application_id == id)
            {
                Some(grant) => Some(grant.category),
                None => return Outcome::new(Stage::Rejected, Some("tv_application_forbidden")),
            }
        } else {
            None
        };
        let deadline = self.deadline(requested);
        let Ok(_guard) = timeout_at(deadline, self.serial.lock()).await else {
            return Outcome::new(Stage::Rejected, Some("command_expired"));
        };
        if let Err(error) = self.identity(deadline).await {
            return Outcome::new(
                Stage::Rejected,
                Some(if error.code == "tv_identity_mismatch" {
                    "tv_identity_mismatch"
                } else {
                    "tv_probe_failed"
                }),
            );
        }
        let args = match &action {
            Action::Press(key) => vec!["shell", "input", "keyevent", key.code()],
            Action::Launch(id) => {
                match self.packages(deadline).await {
                    Ok(packages) if packages.contains(id) => {}
                    Ok(_) => {
                        return Outcome::new(Stage::Rejected, Some("tv_application_unavailable"))
                    }
                    Err(_) => return Outcome::new(Stage::Rejected, Some("tv_probe_failed")),
                }
                vec![
                    "shell",
                    "am",
                    "start",
                    "-W",
                    "-a",
                    "android.intent.action.MAIN",
                    "-c",
                    category.expect("launch grant checked").intent(),
                    "-p",
                    id,
                ]
            }
        };
        match timeout_at(deadline, authorize()).await {
            Ok(Ok(())) => {}
            _ => return Outcome::new(Stage::Rejected, Some("tv_authorization_rejected")),
        }
        match process::run(&self.config, &args, deadline).await {
            Ok(output) => {
                let valid_stdout = match action {
                    Action::Press(_) => output.stdout.is_empty(),
                    Action::Launch(_) => std::str::from_utf8(&output.stdout).is_ok_and(|text| {
                        text.lines().any(|line| line == "Status: ok")
                            && !text.lines().any(|line| {
                                line.starts_with("Error:") || line.starts_with("Exception")
                            })
                    }),
                };
                if output.success && output.stderr.is_empty() && valid_stdout {
                    Outcome::new(Stage::Submitted, None)
                } else {
                    Outcome::new(Stage::Unknown, Some("execution_unknown"))
                }
            }
            Err(process::Failure::NotStarted) => {
                Outcome::new(Stage::Rejected, Some("tv_not_started"))
            }
            Err(process::Failure::Interrupted) => {
                Outcome::new(Stage::Unknown, Some("execution_unknown"))
            }
        }
    }
}
