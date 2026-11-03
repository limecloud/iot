//! 独立本地语音识别提供方及耐久任务；仅接收已有媒体ID与固定摘要。
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
    model_job::Deployment,
    transcription::{Input, Task},
    Result,
};
use reqwest::Url;
use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};
use tokio::sync::Semaphore;

pub trait TranscriptionProvider: Send + Sync {
    fn deployment(&self) -> &Deployment;
    fn transcribe<'a>(&'a self, input: &'a Input, audio: Vec<u8>) -> BoxFuture<'a, Result<String>>;
}
pub struct Transcription {
    provider: Arc<dyn TranscriptionProvider>,
    slots: Arc<Semaphore>,
}
struct LocalHttp {
    origin: Url,
    deployment: Deployment,
    ca: Option<reqwest::Certificate>,
}
pub fn configured(media: bool) -> Result<Option<Arc<Transcription>>> {
    let settings = [
        std::env::var("LIMEIOT_ASR_URL").ok(),
        std::env::var("LIMEIOT_ASR_MODEL").ok(),
    ];
    if settings.iter().all(Option::is_none) {
        return Ok(None);
    }
    ensure(media, "transcription_requires_media")?;
    let [Some(origin), Some(model)] = settings else {
        return Err(err("invalid_transcription_config"));
    };
    let origin = Url::parse(&origin).map_err(|_| err("invalid_transcription_config"))?;
    ensure(
        matches!(origin.scheme(), "http" | "https")
            && origin.host_str().is_some()
            && origin.username().is_empty()
            && origin.password().is_none()
            && origin.path() == "/"
            && origin.query().is_none()
            && origin.fragment().is_none()
            && limeiot_core::speech::model_id(&model),
        "invalid_transcription_config",
    )?;
    let ca_bytes = std::env::var("LIMEIOT_ASR_CA_FILE")
        .ok()
        .filter(|s| !s.is_empty())
        .map(|path| std::fs::read(path).map_err(|_| err("invalid_transcription_config")))
        .transpose()?;
    let ca = ca_bytes
        .as_ref()
        .map(|bytes| {
            reqwest::Certificate::from_pem(bytes).map_err(|_| err("invalid_transcription_config"))
        })
        .transpose()?;
    let revision = limeiot_core::digest(
        &json!({"adapter":"local-http-transcription-v1","origin":origin.as_str(),"model":model,"ca_digest":ca_bytes.map(|bytes|limeiot_core::media::content_digest(&bytes))}),
    )?;
    Ok(Some(Arc::new(Transcription {
        provider: Arc::new(LocalHttp {
            origin,
            deployment: Deployment {
                adapter: "local-http-transcription-v1".into(),
                revision,
                model,
                data_location: "local".into(),
            },
            ca,
        }),
        slots: Arc::new(Semaphore::new(1)),
    })))
}
impl TranscriptionProvider for LocalHttp {
    fn deployment(&self) -> &Deployment {
        &self.deployment
    }
    fn transcribe<'a>(&'a self, input: &'a Input, audio: Vec<u8>) -> BoxFuture<'a, Result<String>> {
        Box::pin(async move {
            let client =
                crate::local_provider::client(&self.origin, self.ca.as_ref(), "transcription")
                    .await?;
            let mut response = client
                .post(
                    self.origin
                        .join("v1/audio/transcriptions")
                        .map_err(|_| err("transcription_provider_unavailable"))?,
                )
                .header("Content-Type", "audio/wav")
                .header("Accept", "application/json")
                .header("Accept-Encoding", "identity")
                .header("X-Limeiot-Model", &self.deployment.model)
                .header("X-Limeiot-Language", &input.language)
                .body(audio)
                .send()
                .await
                .map_err(|_| err("transcription_provider_unknown"))?;
            ensure(
                !response.status().is_client_error(),
                "transcription_provider_rejected",
            )?;
            ensure(
                response.status() == StatusCode::OK,
                "transcription_provider_unknown",
            )?;
            ensure(
                response
                    .headers()
                    .get("content-type")
                    .and_then(|h| h.to_str().ok())
                    .is_some_and(|h| {
                        h.split(';').next().map(str::trim) == Some("application/json")
                    })
                    && response
                        .headers()
                        .get("content-encoding")
                        .is_none_or(|h| h == "identity"),
                "invalid_transcription_output",
            )?;
            ensure(
                response.content_length().is_none_or(|n| n <= 32768),
                "transcription_output_too_large",
            )?;
            let mut bytes = Vec::new();
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|_| err("transcription_provider_unknown"))?
            {
                ensure(
                    bytes.len() + chunk.len() <= 32768,
                    "transcription_output_too_large",
                )?;
                bytes.extend_from_slice(&chunk);
            }
            let value = limeiot_core::validation::bounded_document(&bytes, 32768, 3, 32)
                .ok_or_else(|| err("invalid_transcription_output"))?;
            ensure(
                value
                    .as_object()
                    .is_some_and(|value| value.len() == 1 && value.contains_key("text")),
                "invalid_transcription_output",
            )?;
            let text = value["text"]
                .as_str()
                .filter(|value| limeiot_core::transcription::text(value))
                .ok_or_else(|| err("invalid_transcription_output"))?;
            Ok(text.into())
        })
    }
}
impl Transcription {
    pub fn capabilities(&self) -> Value {
        json!({"configured":true,"capability":"audio.transcribe","deployment":self.provider.deployment(),"languages":["auto","zh","en"],"concurrency":1,"max_audio_bytes":4194304,"max_audio_seconds":60,"max_text_bytes":8192,"max_characters":2048,"max_deadline_seconds":90,"streaming":false,"provider_cancellation":false})
    }
}
pub fn routes() -> Router<App> {
    Router::new()
        .route(
            "/api/v1/spaces/:space/audio-transcriptions",
            post(create).layer(DefaultBodyLimit::max(4096)),
        )
        .route(
            "/api/v1/spaces/:space/audio-transcriptions/by-key/:key",
            get(resolve),
        )
        .route(
            "/api/v1/spaces/:space/audio-transcriptions/by-key/:key/discard",
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
            let now = store.now()?;
            store.prune(now)?;
            store
                .state
                .transcriptions
                .get(&key)
                .cloned()
                .ok_or_else(|| err("transcription_not_found"))
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
        "invalid_transcription_request",
    )?;
    let value = limeiot_core::validation::bounded_document(&body, 4096, 3, 32)
        .ok_or_else(|| err("invalid_transcription_request"))?;
    let input: Input =
        serde_json::from_value(value).map_err(|_| err("invalid_transcription_request"))?;
    input.validate()?;
    let digest = input.request_digest(&space, &key)?;
    match original(&media, key.clone()).await {
        Ok(old) => {
            ensure(old.request_digest == digest, "idempotency_conflict")?;
            return Ok((StatusCode::OK, Json(old)));
        }
        Err(error) if error.code == "transcription_not_found" => {}
        Err(error) => return Err(error.into()),
    }
    let service = app
        .transcription
        .clone()
        .ok_or_else(|| err("transcription_not_configured"))?;
    let permit = service
        .slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| err("transcription_busy"))?;
    let owned = input.clone();
    let deployment = service.provider.deployment().clone();
    let (task, created, audio) = media
        .work(move |store| store.transcription_accept(key, &owned, deployment))
        .await?;
    if created {
        let key = task.idempotency_key.clone();
        let deadline = task.input.expires_at;
        tokio::spawn(async move {
            let _permit = permit;
            let remaining = (deadline - chrono::Utc::now())
                .to_std()
                .unwrap_or(Duration::ZERO);
            let result =
                tokio::time::timeout(remaining, service.provider.transcribe(&input, audio))
                    .await
                    .unwrap_or_else(|_| Err(err("transcription_deadline_exceeded")));
            if media
                .work(move |store| store.transcription_finish(&key, result))
                .await
                .is_err()
            {
                eprintln!(
                    "{}",
                    json!({"event":"transcription.commit_failed","code":"media_storage_unavailable"})
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
        "invalid_transcription_request",
    )?;
    Ok(Json(
        media
            .work(move |store| store.transcription_discard(&key))
            .await?,
    ))
}
