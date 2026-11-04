//! 通用文字生成端口；Ollama位于适配层，不接收设备目录、凭据或执行工具。
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
    media::content_digest,
    model_job::Deployment,
    text::{Request, Task, Usage, MAX_REQUEST_BYTES},
    Result,
};
use reqwest::Url;
use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};
use tokio::sync::Semaphore;

pub trait TextProvider: Send + Sync {
    fn deployment(&self) -> &Deployment;
    fn generate<'a>(&'a self, request: Request) -> BoxFuture<'a, Result<(String, Option<Usage>)>>;
}
pub struct Text {
    provider: Arc<dyn TextProvider>,
    slots: Arc<Semaphore>,
}
struct Ollama {
    origin: Url,
    deployment: Deployment,
    ca: Option<reqwest::Certificate>,
}
pub fn configured(media: bool) -> Result<Option<Arc<Text>>> {
    let values = [
        std::env::var("LIMEIOT_TEXT_URL").ok(),
        std::env::var("LIMEIOT_TEXT_MODEL").ok(),
    ];
    if values.iter().all(Option::is_none) {
        return Ok(None);
    }
    ensure(media, "text_requires_media")?;
    let [Some(origin), Some(model)] = values else {
        return Err(err("invalid_text_config"));
    };
    let origin = Url::parse(&origin).map_err(|_| err("invalid_text_config"))?;
    ensure(
        matches!(origin.scheme(), "http" | "https")
            && origin.host_str().is_some()
            && origin.username().is_empty()
            && origin.password().is_none()
            && origin.path() == "/"
            && origin.query().is_none()
            && origin.fragment().is_none()
            && limeiot_core::speech::model_id(&model),
        "invalid_text_config",
    )?;
    let ca_bytes = std::env::var("LIMEIOT_TEXT_CA_FILE")
        .ok()
        .filter(|s| !s.is_empty())
        .map(|p| std::fs::read(p).map_err(|_| err("invalid_text_config")))
        .transpose()?;
    let ca = ca_bytes
        .as_ref()
        .map(|b| reqwest::Certificate::from_pem(b).map_err(|_| err("invalid_text_config")))
        .transpose()?;
    let revision = limeiot_core::digest(
        &json!({"adapter":"ollama-text-v1","origin":origin.as_str(),"model":model,
        "ca_digest":ca_bytes.map(|b|content_digest(&b)),"context_tokens":4096,"output_tokens":1024}),
    )?;
    Ok(Some(Arc::new(Text {
        provider: Arc::new(Ollama {
            origin,
            deployment: Deployment {
                adapter: "ollama-text-v1".into(),
                revision,
                model,
                data_location: "local".into(),
            },
            ca,
        }),
        slots: Arc::new(Semaphore::new(1)),
    })))
}
impl TextProvider for Ollama {
    fn deployment(&self) -> &Deployment {
        &self.deployment
    }
    fn generate<'a>(&'a self, request: Request) -> BoxFuture<'a, Result<(String, Option<Usage>)>> {
        Box::pin(async move {
            let client =
                crate::local_provider::client(&self.origin, self.ca.as_ref(), "text").await?;
            let mut messages = vec![
                json!({"role":"system","content":"You provide text responses to the supplied conversation. Be clear about uncertainty. You have no tools, device access or permission to execute actions. Do not claim that you have controlled any device."}),
            ];
            if !request.instructions.is_empty() {
                messages.push(json!({"role":"system","content":request.instructions}));
            }
            messages.extend(
                request
                    .messages
                    .into_iter()
                    .map(|m| json!({"role":m.role,"content":m.content})),
            );
            let mut response=client.post(self.origin.join("api/chat").map_err(|_|err("text_provider_unavailable"))?)
                .header("Accept","application/json").header("Accept-Encoding","identity")
                .json(&json!({"model":self.deployment.model,"stream":false,"keep_alive":0,
                    "options":{"num_ctx":4096,"num_predict":1024,"temperature":0},"messages":messages}))
                .send().await.map_err(|_|err("text_provider_unknown"))?;
            ensure(
                !response.status().is_client_error(),
                "text_provider_rejected",
            )?;
            ensure(response.status() == StatusCode::OK, "text_provider_unknown")?;
            ensure(
                response
                    .headers()
                    .get("content-type")
                    .and_then(|v| v.to_str().ok())
                    .is_some_and(|v| {
                        v.split(';').next().map(str::trim) == Some("application/json")
                    })
                    && response
                        .headers()
                        .get("content-encoding")
                        .is_none_or(|v| v == "identity"),
                "invalid_text_output",
            )?;
            ensure(
                response.content_length().is_none_or(|n| n <= 65536),
                "text_output_too_large",
            )?;
            let mut bytes = Vec::new();
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|_| err("text_provider_unknown"))?
            {
                ensure(bytes.len() + chunk.len() <= 65536, "text_output_too_large")?;
                bytes.extend_from_slice(&chunk);
            }
            decode(&bytes, &self.deployment.model)
        })
    }
}
fn decode(bytes: &[u8], model: &str) -> Result<(String, Option<Usage>)> {
    let value = limeiot_core::validation::bounded_document(bytes, 65536, 5, 128)
        .ok_or_else(|| err("invalid_text_output"))?;
    ensure(
        value["model"] == model
            && value["done"] == true
            && value["done_reason"] == "stop"
            && value["message"]["role"] == "assistant"
            && value["message"].as_object().is_some_and(|m| {
                m.keys()
                    .all(|k| matches!(k.as_str(), "role" | "content" | "thinking"))
            }),
        "invalid_text_output",
    )?;
    let text = value["message"]["content"]
        .as_str()
        .filter(|s| limeiot_core::text::text(s))
        .ok_or_else(|| err("invalid_text_output"))?;
    let usage = match (value.get("prompt_eval_count"), value.get("eval_count")) {
        (None, None) => None,
        (Some(input), Some(output)) => {
            let input = input
                .as_u64()
                .filter(|n| *n <= 65536)
                .ok_or_else(|| err("invalid_text_output"))?;
            let output = output
                .as_u64()
                .filter(|n| (1..=1024).contains(n))
                .ok_or_else(|| err("invalid_text_output"))?;
            Some(Usage {
                input_tokens: input as u32,
                output_tokens: output as u32,
            })
        }
        _ => return Err(err("invalid_text_output")),
    };
    Ok((text.into(), usage))
}
impl Text {
    pub fn capabilities(&self) -> Value {
        json!({"configured":true,"capability":"text.generate","deployment":self.provider.deployment(),
            "max_messages":15,"max_context_bytes":8192,"max_instructions_characters":1024,"max_text_bytes":8192,
            "max_characters":2048,"max_output_tokens":1024,"max_deadline_seconds":90,"max_retain_seconds":3600,
            "concurrency":1,"streaming":false,"provider_cancellation":false,"input_storage":"digest_only",
            "server_memory":false,"device_execution":false})
    }
}
pub fn routes() -> Router<App> {
    Router::new()
        .route(
            "/api/v1/spaces/:space/text-generations",
            post(create).layer(DefaultBodyLimit::max(MAX_REQUEST_BYTES)),
        )
        .route(
            "/api/v1/spaces/:space/text-generations/by-key/:key",
            get(resolve),
        )
        .route(
            "/api/v1/spaces/:space/text-generations/by-key/:key/discard",
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
                .texts
                .get(&key)
                .cloned()
                .ok_or_else(|| err("text_not_found"))
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
        .and_then(|h| h.to_str().ok())
        .filter(|s| identifier(s))
        .ok_or_else(|| err("invalid_idempotency_key"))?
        .to_owned();
    ensure(
        headers.get_all("content-type").iter().count() == 1
            && headers
                .get("content-type")
                .and_then(|h| h.to_str().ok())
                .is_some_and(|h| h.split(';').next().map(str::trim) == Some("application/json")),
        "invalid_text_request",
    )?;
    let value = limeiot_core::validation::bounded_document(&body, MAX_REQUEST_BYTES, 4, 128)
        .ok_or_else(|| err("invalid_text_request"))?;
    let request: Request =
        serde_json::from_value(value).map_err(|_| err("invalid_text_request"))?;
    let input = request.input()?;
    let digest = input.request_digest(&space, &key)?;
    match original(&media, key.clone()).await {
        Ok(old) => {
            ensure(old.request_digest == digest, "idempotency_conflict")?;
            return Ok((StatusCode::OK, Json(old)));
        }
        Err(error) if error.code == "text_not_found" => {}
        Err(error) => return Err(error.into()),
    }
    let service = app.text.clone().ok_or_else(|| err("text_not_configured"))?;
    let permit = service
        .slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| err("text_busy"))?;
    let deployment = service.provider.deployment().clone();
    let (task, created) = media
        .work(move |store| store.text_accept(key, input, deployment))
        .await?;
    if created {
        let key = task.idempotency_key.clone();
        let deadline = task.input.expires_at;
        tokio::spawn(async move {
            let _permit = permit;
            let remaining = (deadline - chrono::Utc::now())
                .to_std()
                .unwrap_or(Duration::ZERO);
            let result = tokio::select! {
                biased;
                _=app.wait_for_shutdown() => Err(err("text_interrupted")),
                result=tokio::time::timeout(remaining,service.provider.generate(request)) => result.unwrap_or_else(|_|Err(err("text_deadline_exceeded"))),
            };
            if media
                .work(move |store| store.text_finish(&key, result))
                .await
                .is_err()
            {
                eprintln!(
                    "{}",
                    json!({"event":"text.commit_failed","code":"media_storage_unavailable"})
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
        "invalid_text_request",
    )?;
    Ok(Json(
        media.work(move |store| store.text_discard(&key)).await?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn text_provider_rejects_tools_wrong_model_truncation_and_invalid_usage() {
        let good = json!({"model":"fixture:text","done":true,"done_reason":"stop","message":{"role":"assistant","content":"你好"},"prompt_eval_count":5,"eval_count":2});
        assert_eq!(
            decode(&serde_json::to_vec(&good).unwrap(), "fixture:text")
                .unwrap()
                .1
                .unwrap()
                .output_tokens,
            2
        );
        for change in 0..7 {
            let mut bad = good.clone();
            match change {
                0 => {
                    bad["message"]["tool_calls"] = json!([{"function":{"name":"commands.create"}}])
                }
                1 => bad["done_reason"] = "length".into(),
                2 => bad["model"] = "other".into(),
                3 => bad["eval_count"] = 1025.into(),
                4 => bad["prompt_eval_count"] = 1.5.into(),
                5 => bad["message"]["content"] = "x".repeat(2049).into(),
                _ => bad["message"]["content"] = "\0".into(),
            };
            assert!(decode(&serde_json::to_vec(&bad).unwrap(), "fixture:text").is_err());
        }
        assert!(decode(
            br#"{"model":"fixture:text","done":true,"done":false}"#,
            "fixture:text"
        )
        .is_err());
    }
}
