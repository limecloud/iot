//! 外部本地语音提供方适配及耐久任务装配；提供方不获得任何设备控制权限。
use crate::{api::ApiError, application::App};
use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, Path, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use futures_util::future::BoxFuture;
use limeiot_core::{
    ensure, err, identifier,
    media::{wav, MAX_OBJECT_BYTES},
    speech::{Deployment, Input, Task},
    Result,
};
use reqwest::{Client, Url};
use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};
use tokio::sync::Semaphore;

pub trait SpeechProvider: Send + Sync {
    fn deployment(&self) -> &Deployment;
    fn voices(&self) -> &[String];
    fn synthesize<'a>(&'a self, input: &'a Input) -> BoxFuture<'a, Result<Vec<u8>>>;
}
pub struct Speech {
    provider: Arc<dyn SpeechProvider>,
    slots: Arc<Semaphore>,
}
struct LocalHttp {
    origin: Url,
    deployment: Deployment,
    voices: Vec<String>,
    ca: Option<reqwest::Certificate>,
}
pub fn configured(media_configured: bool) -> Result<Option<Arc<Speech>>> {
    let settings: Vec<Option<String>> =
        ["LIMEIOT_TTS_URL", "LIMEIOT_TTS_MODEL", "LIMEIOT_TTS_VOICES"]
            .into_iter()
            .map(|key| std::env::var(key).ok())
            .collect();
    if settings.iter().all(Option::is_none) {
        return Ok(None);
    }
    ensure(media_configured, "speech_requires_media")?;
    let [Some(origin), Some(model), Some(voices)] = settings.as_slice() else {
        return Err(err("invalid_speech_config"));
    };
    let origin = Url::parse(origin).map_err(|_| err("invalid_speech_config"))?;
    ensure(
        matches!(origin.scheme(), "http" | "https")
            && origin.host_str().is_some()
            && origin.username().is_empty()
            && origin.password().is_none()
            && origin.path() == "/"
            && origin.query().is_none()
            && origin.fragment().is_none()
            && limeiot_core::speech::model_id(model),
        "invalid_speech_config",
    )?;
    let voices: Vec<String> = voices.split(',').map(str::to_owned).collect();
    ensure(
        !voices.is_empty()
            && voices.len() <= 32
            && voices
                .iter()
                .all(|voice| identifier(voice) && voice.len() <= 64)
            && voices
                .iter()
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                == voices.len(),
        "invalid_speech_config",
    )?;
    let ca_bytes = std::env::var("LIMEIOT_TTS_CA_FILE")
        .ok()
        .filter(|s| !s.is_empty())
        .map(|path| std::fs::read(path).map_err(|_| err("invalid_speech_config")))
        .transpose()?;
    let ca = ca_bytes
        .as_ref()
        .map(|bytes| {
            reqwest::Certificate::from_pem(bytes).map_err(|_| err("invalid_speech_config"))
        })
        .transpose()?;
    let revision = limeiot_core::digest(
        &json!({"adapter":"local-http-speech-v1","origin":origin.as_str(),"model":model,"voices":voices,"ca_digest":ca_bytes.map(|bytes|limeiot_core::media::content_digest(&bytes))}),
    )?;
    let provider = LocalHttp {
        origin,
        deployment: Deployment {
            adapter: "local-http-speech-v1".into(),
            revision,
            model: model.clone(),
            data_location: "local".into(),
        },
        voices,
        ca,
    };
    Ok(Some(Arc::new(Speech {
        provider: Arc::new(provider),
        slots: Arc::new(Semaphore::new(1)),
    })))
}
impl LocalHttp {
    async fn client(&self) -> Result<Client> {
        crate::local_provider::client(&self.origin, self.ca.as_ref(), "speech").await
    }
}
impl SpeechProvider for LocalHttp {
    fn deployment(&self) -> &Deployment {
        &self.deployment
    }
    fn voices(&self) -> &[String] {
        &self.voices
    }
    fn synthesize<'a>(&'a self, input: &'a Input) -> BoxFuture<'a, Result<Vec<u8>>> {
        Box::pin(async move {
            let mut response = self.client().await?.post(self.origin.join("v1/audio/speech").map_err(|_| err("speech_provider_unavailable"))?).header("Accept", "audio/wav").header("Accept-Encoding", "identity")
                .json(&json!({"model":self.deployment.model,"input":input.text,"voice":input.voice,"response_format":"wav","speed":1})).send().await.map_err(|_| err("speech_provider_unknown"))?;
            if response.status().is_client_error() {
                return Err(err("speech_provider_rejected"));
            }
            ensure(
                response.status() == StatusCode::OK,
                "speech_provider_unknown",
            )?;
            ensure(
                response
                    .headers()
                    .get("content-type")
                    .and_then(|v| v.to_str().ok())
                    .is_some_and(|v| {
                        matches!(
                            v.split(';').next().map(str::trim),
                            Some("audio/wav" | "audio/x-wav")
                        )
                    })
                    && response
                        .headers()
                        .get("content-encoding")
                        .is_none_or(|v| v == "identity"),
                "invalid_speech_audio",
            )?;
            ensure(
                response
                    .content_length()
                    .is_none_or(|n| n <= MAX_OBJECT_BYTES as u64),
                "speech_output_too_large",
            )?;
            let mut bytes = Vec::new();
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|_| err("speech_provider_unknown"))?
            {
                ensure(
                    bytes.len() + chunk.len() <= MAX_OBJECT_BYTES,
                    "speech_output_too_large",
                )?;
                bytes.extend_from_slice(&chunk);
            }
            wav(&bytes).map_err(|_| err("invalid_speech_audio"))?;
            Ok(bytes)
        })
    }
}
impl Speech {
    pub fn capabilities(&self) -> Value {
        json!({"configured":true,"capability":"audio.synthesize","deployment":self.provider.deployment(),"voices":self.provider.voices(),"concurrency":1,"max_text_bytes":4096,"max_characters":1000,"max_output_bytes":MAX_OBJECT_BYTES,"max_audio_seconds":60,"max_deadline_seconds":90,"streaming":false,"provider_cancellation":false})
    }
}
pub fn routes() -> Router<App> {
    Router::new()
        .route(
            "/api/v1/spaces/:space/speech-syntheses",
            post(create).layer(DefaultBodyLimit::max(8192)),
        )
        .route(
            "/api/v1/spaces/:space/speech-syntheses/by-key/:key",
            get(resolve),
        )
        .route(
            "/api/v1/spaces/:space/speech-syntheses/by-key/:key/discard",
            post(discard).layer(DefaultBodyLimit::max(128)),
        )
}
async fn media(app: &App, space: &str) -> Result<Arc<crate::media::Media>> {
    ensure(app.store.lock().await.data.space_id == space, "forbidden")?;
    app.media.clone().ok_or_else(|| err("media_not_configured"))
}
async fn original(media: &crate::media::Media, key: String) -> Result<Task> {
    ensure(identifier(&key), "invalid_idempotency_key")?;
    media
        .work(move |store| {
            store.ready()?;
            store
                .state
                .speech
                .get(&key)
                .cloned()
                .ok_or_else(|| err("speech_not_found"))
        })
        .await
}
async fn create(
    State(app): State<App>,
    Path(space): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> std::result::Result<(StatusCode, Json<Task>), ApiError> {
    let media = media(&app, &space).await?;
    ensure(
        headers.get_all("idempotency-key").iter().count() == 1,
        "invalid_idempotency_key",
    )?;
    let key = headers
        .get("idempotency-key")
        .and_then(|s| s.to_str().ok())
        .filter(|s| identifier(s))
        .ok_or_else(|| err("invalid_idempotency_key"))?
        .to_owned();
    ensure(
        headers
            .get("content-type")
            .and_then(|s| s.to_str().ok())
            .is_some_and(|s| s.split(';').next().map(str::trim) == Some("application/json")),
        "invalid_speech_request",
    )?;
    let value = limeiot_core::validation::bounded_document(&body, 8192, 3, 32)
        .ok_or_else(|| err("invalid_speech_request"))?;
    let input: Input = serde_json::from_value(value).map_err(|_| err("invalid_speech_request"))?;
    input.validate()?;
    let digest = input.request_digest(&space, &key)?;
    match original(&media, key.clone()).await {
        Ok(old) => {
            ensure(old.request_digest == digest, "idempotency_conflict")?;
            return Ok((StatusCode::OK, Json(old)));
        }
        Err(error) if error.code == "speech_not_found" => {}
        Err(error) => return Err(error.into()),
    }
    let service = app
        .speech
        .clone()
        .ok_or_else(|| err("speech_not_configured"))?;
    ensure(
        service.provider.voices().contains(&input.voice),
        "speech_voice_unavailable",
    )?;
    let permit = service
        .slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| err("speech_busy"))?;
    let owned_input = input.clone();
    let deployment = service.provider.deployment().clone();
    let (task, created) = media
        .work(move |store| store.speech_accept(key, &owned_input, deployment))
        .await?;
    if created {
        let key = task.idempotency_key.clone();
        let deadline = task.expires_at;
        tokio::spawn(async move {
            let _permit = permit;
            let remaining = (deadline - chrono::Utc::now())
                .to_std()
                .unwrap_or(Duration::ZERO);
            let result = tokio::time::timeout(remaining, service.provider.synthesize(&input))
                .await
                .unwrap_or_else(|_| Err(err("speech_deadline_exceeded")));
            if media
                .work(move |store| store.speech_finish(&key, result))
                .await
                .is_err()
            {
                eprintln!(
                    "{}",
                    json!({"event":"speech.commit_failed","code":"media_storage_unavailable"})
                );
            }
        });
    }
    Ok((
        if created {
            StatusCode::ACCEPTED
        } else {
            StatusCode::OK
        },
        Json(task),
    ))
}
async fn resolve(
    State(app): State<App>,
    Path((space, key)): Path<(String, String)>,
) -> std::result::Result<Json<Task>, ApiError> {
    let media = media(&app, &space).await?;
    Ok(Json(original(&media, key).await?))
}
async fn discard(
    State(app): State<App>,
    Path((space, key)): Path<(String, String)>,
    body: Bytes,
) -> std::result::Result<Json<Task>, ApiError> {
    let media = media(&app, &space).await?;
    ensure(
        identifier(&key) && (body.is_empty() || body.as_ref() == b"{}"),
        "invalid_speech_request",
    )?;
    Ok(Json(
        media.work(move |store| store.speech_discard(&key)).await?,
    ))
}
