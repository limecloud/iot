//! 有限DLNA播放适配，不拥有命令账本，也不取得设备MQTT身份。
mod config;
mod xml;
use chrono::Utc;
pub use config::{Config, MediaGrant};
use limeiot_core::{ensure, err, model::Model, protocol::Operation, Result};
use serde::{Deserialize, Serialize};
use std::{future::Future, time::Duration};
use tokio::{
    sync::Mutex,
    time::{timeout_at, Instant},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stage {
    Submitted,
    Rejected,
    Unknown,
}
pub struct Outcome {
    pub stage: Stage,
    pub error: Option<String>,
    pub observed_at: chrono::DateTime<Utc>,
}
impl Outcome {
    fn new(stage: Stage, error: Option<&str>) -> Self {
        Self {
            stage,
            error: error.map(str::to_owned),
            observed_at: Utc::now(),
        }
    }
}
#[derive(Clone, Debug, Serialize)]
pub struct Discovery {
    pub udn: String,
    pub observed_at: chrono::DateTime<Utc>,
}
enum Action {
    Play(String),
    Stop,
    Volume(u8),
}
impl Action {
    fn parse(operation: &Operation) -> Result<Self> {
        ensure(operation.kind == "action.invoke", "invalid_audio_action")?;
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Play {
            media_id: String,
        }
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Volume {
            volume: u8,
        }
        match operation.path.as_str() {
            "playback.play" => {
                let value: Play = serde_json::from_value(operation.value.clone())
                    .map_err(|_| err("invalid_audio_action"))?;
                ensure(
                    limeiot_core::identifier(&value.media_id),
                    "invalid_audio_action",
                )?;
                Ok(Self::Play(value.media_id))
            }
            "playback.stop" if operation.value == serde_json::json!({}) => Ok(Self::Stop),
            "playback.set_volume" => {
                let value: Volume = serde_json::from_value(operation.value.clone())
                    .map_err(|_| err("invalid_audio_action"))?;
                Ok(Self::Volume(value.volume))
            }
            _ => Err(err("invalid_audio_action")),
        }
    }
}
pub fn supports_model(model: &Model) -> bool {
    let supported: Model = serde_json::from_slice(include_bytes!(
        "../../../../contracts/models/dlna-speaker.json"
    ))
    .expect("audio model");
    model.validate().is_ok()
        && model.services.iter().all(|service| {
            service.properties.is_empty()
                && service.events.is_empty()
                && supported.services.iter().any(|expected| {
                    expected.id == service.id && expected.semantic_id == service.semantic_id
                })
                && service.actions.iter().all(|action| {
                    supported
                        .action(&format!("{}.{}", service.id, action.id))
                        .is_ok_and(|expected| {
                            action.semantic_id == expected.semantic_id
                                && action.risk == expected.risk
                                && action.idempotent == expected.idempotent
                                && limeiot_core::execution::supports_action(action)
                                && limeiot_core::compatibility::schema_subset(
                                    &action.input,
                                    &expected.input,
                                )
                        })
                })
        })
}
pub struct Adapter {
    config: Config,
    client: reqwest::Client,
    serial: Mutex<()>,
}
impl Adapter {
    pub fn new(config: Config) -> Result<Self> {
        config.validate()?;
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .referer(false)
            .pool_max_idle_per_host(0)
            .build()
            .map_err(|_| err("invalid_audio_adapter_config"))?;
        Ok(Self {
            config,
            client,
            serial: Mutex::new(()),
        })
    }
    fn deadline(&self, requested: Instant) -> Instant {
        requested.min(Instant::now() + Duration::from_millis(self.config.timeout_ms))
    }
    async fn read_response(request: reqwest::RequestBuilder, deadline: Instant) -> Result<String> {
        timeout_at(deadline, async {
            let mut response = request
                .send()
                .await
                .map_err(|_| err("audio_transport_failed"))?;
            ensure(
                response.status() == reqwest::StatusCode::OK,
                "audio_transport_failed",
            )?;
            ensure(
                response.content_length().is_none_or(|len| len <= 65_536),
                "audio_invalid_response",
            )?;
            let mut bytes = Vec::new();
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|_| err("audio_transport_failed"))?
            {
                ensure(
                    bytes.len() + chunk.len() <= 65_536,
                    "audio_invalid_response",
                )?;
                bytes.extend_from_slice(&chunk);
            }
            String::from_utf8(bytes).map_err(|_| err("audio_invalid_response"))
        })
        .await
        .map_err(|_| err("audio_transport_failed"))?
    }
    async fn identity(&self, deadline: Instant) -> Result<()> {
        let text = Self::read_response(
            self.client
                .get(self.config.endpoint(&self.config.description_path)),
            deadline,
        )
        .await?;
        xml::description(&text, &self.config)
    }
    pub async fn discover(&self, requested: Instant) -> Result<Discovery> {
        let deadline = self.deadline(requested);
        let _guard = timeout_at(deadline, self.serial.lock())
            .await
            .map_err(|_| err("audio_probe_failed"))?;
        self.identity(deadline).await?;
        Ok(Discovery {
            udn: self.config.udn.clone(),
            observed_at: Utc::now(),
        })
    }
    async fn send(&self, service: &str, action: &str, args: &str, deadline: Instant) -> Result<()> {
        let path = if service == xml::AV {
            &self.config.av_transport_path
        } else {
            &self.config.rendering_control_path
        };
        let text = Self::read_response(
            self.client
                .post(self.config.endpoint(path))
                .header("Content-Type", "text/xml; charset=utf-8")
                .header("SOAPACTION", format!("\"{service}#{action}\""))
                .body(xml::request(service, action, args)),
            deadline,
        )
        .await?;
        xml::response(&text, service, action)
    }
    fn media<'a>(
        &'a self,
        action: &Action,
        managed: Option<&'a MediaGrant>,
    ) -> Result<Option<&'a MediaGrant>> {
        if let Action::Play(id) = action {
            let media = if self.config.managed_media {
                managed.filter(|m| m.media_id == *id)
            } else {
                self.config.media.iter().find(|m| m.media_id == *id)
            }
            .ok_or_else(|| err("audio_media_forbidden"))?;
            ensure(media.expires_at > Utc::now(), "audio_media_expired")?;
            Ok(Some(media))
        } else {
            Ok(None)
        }
    }
    /// 每一步副作用前重新核对Owner授权与期限；任一步已发送后不补发、不自动Stop。
    pub async fn execute_authorized<F, Fut>(
        &self,
        operation: &Operation,
        requested: Instant,
        authorize: F,
    ) -> Outcome
    where
        F: Fn() -> Fut,
        Fut: Future<Output = Result<()>>,
    {
        self.execute_with_media_authorized(operation, requested, None, authorize)
            .await
    }
    /// 受管理媒体只由宿主授权解析后传入；协议层仍不依赖平台存储或HTTP路由。
    pub async fn execute_with_media_authorized<F, Fut>(
        &self,
        operation: &Operation,
        requested: Instant,
        managed: Option<MediaGrant>,
        authorize: F,
    ) -> Outcome
    where
        F: Fn() -> Fut,
        Fut: Future<Output = Result<()>>,
    {
        let action = match Action::parse(operation) {
            Ok(action) => action,
            Err(_) => return Outcome::new(Stage::Rejected, Some("invalid_audio_action")),
        };
        if matches!(action, Action::Volume(v) if v > self.config.volume_limit) {
            return Outcome::new(Stage::Rejected, Some("audio_volume_limit"));
        }
        if let Err(error) = self.media(&action, managed.as_ref()) {
            return Outcome::new(Stage::Rejected, Some(&error.code));
        }
        let deadline = self.deadline(requested);
        if Instant::now() >= deadline {
            return Outcome::new(Stage::Rejected, Some("command_expired"));
        }
        let Ok(_guard) = timeout_at(deadline, self.serial.lock()).await else {
            return Outcome::new(Stage::Rejected, Some("command_expired"));
        };
        if let Err(error) = self.identity(deadline).await {
            return Outcome::new(Stage::Rejected, Some(&error.code));
        }
        let steps = match &action {
            Action::Play(_) => {
                let media = match self.media(&action, managed.as_ref()) {
                    Ok(Some(media)) => media,
                    Err(error) => return Outcome::new(Stage::Rejected, Some(&error.code)),
                    _ => unreachable!(),
                };
                vec![
                    (
                        xml::RENDER,
                        "SetVolume",
                        format!(
                            "<Channel>Master</Channel><DesiredVolume>{}</DesiredVolume>",
                            self.config.playback_volume
                        ),
                    ),
                    (
                        xml::AV,
                        "SetAVTransportURI",
                        format!(
                            "<CurrentURI>{}</CurrentURI><CurrentURIMetaData></CurrentURIMetaData>",
                            xml::escape(&media.url)
                        ),
                    ),
                    (xml::AV, "Play", "<Speed>1</Speed>".into()),
                ]
            }
            Action::Stop => vec![(xml::AV, "Stop", String::new())],
            Action::Volume(volume) => vec![(
                xml::RENDER,
                "SetVolume",
                format!("<Channel>Master</Channel><DesiredVolume>{volume}</DesiredVolume>"),
            )],
        };
        for (index, (service, method, args)) in steps.iter().enumerate() {
            let allowed = timeout_at(deadline, async {
                authorize().await?;
                self.media(&action, managed.as_ref())?;
                Ok::<_, limeiot_core::Error>(())
            })
            .await;
            if !matches!(allowed, Ok(Ok(()))) || Instant::now() >= deadline {
                return Outcome::new(
                    if index == 0 {
                        Stage::Rejected
                    } else {
                        Stage::Unknown
                    },
                    Some(if index == 0 {
                        "audio_authorization_rejected"
                    } else {
                        "execution_unknown"
                    }),
                );
            }
            if self.send(service, method, args, deadline).await.is_err() {
                return Outcome::new(Stage::Unknown, Some("execution_unknown"));
            }
        }
        Outcome::new(Stage::Submitted, None)
    }
}
