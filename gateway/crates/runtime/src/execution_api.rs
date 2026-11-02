//! 绑定变更只引用宿主已校验的提供方，不接收目标地址、凭据或Shell。
use crate::{api::ApiError, application::App};
use axum::{
    body::Bytes,
    extract::{Path, State},
    http::HeaderMap,
    routing::get,
    Json, Router,
};
use limeiot_core::{
    ensure, err,
    execution_binding::{self, Change, Operation, Request},
    identifier, Result,
};
use serde_json::{json, Value};
type Output<T> = std::result::Result<T, ApiError>;
pub fn routes() -> Router<App> {
    Router::new()
        .route("/api/v1/spaces/:space/execution-adapters", get(adapters))
        .route(
            "/api/v1/spaces/:space/devices/:device/execution-binding",
            get(binding),
        )
        .route(
            "/api/v1/spaces/:space/devices/:device/applications",
            get(applications),
        )
        .route(
            "/api/v1/spaces/:space/execution-operations",
            axum::routing::post(apply),
        )
        .route(
            "/api/v1/spaces/:space/execution-operations/by-key/:key",
            get(resolve),
        )
}
fn check(data: &limeiot_core::engine::Data, space: &str) -> Result<()> {
    ensure(data.space_id == space, "forbidden")
}
async fn adapters(State(app): State<App>, Path(space): Path<String>) -> Output<Json<Value>> {
    let store = app.store.lock().await;
    check(&store.data, &space)?;
    Ok(Json(app.tv.list(&store.data)))
}
async fn binding(
    State(app): State<App>,
    Path((space, device)): Path<(String, String)>,
) -> Output<Json<Value>> {
    ensure(identifier(&device), "invalid_device_id")?;
    let store = app.store.lock().await;
    check(&store.data, &space)?;
    Ok(Json(json!(store.data.execution_binding(&device)?)))
}
async fn applications(
    State(app): State<App>,
    Path((space, device)): Path<(String, String)>,
) -> Output<Json<Value>> {
    ensure(identifier(&device), "invalid_device_id")?;
    let store = app.store.lock().await;
    check(&store.data, &space)?;
    Ok(Json(app.tv.applications(&store.data, &device).await?))
}
async fn apply(
    State(app): State<App>,
    Path(space): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Output<Json<Operation>> {
    ensure(
        headers
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| {
                value.split(';').next().map(str::trim) == Some("application/json")
            }),
        "invalid_execution_change",
    )?;
    ensure(
        headers.get_all("idempotency-key").iter().count() == 1,
        "invalid_idempotency_key",
    )?;
    let key = headers
        .get("idempotency-key")
        .and_then(|value| value.to_str().ok())
        .filter(|value| identifier(value))
        .ok_or_else(|| err("invalid_idempotency_key"))?;
    let change = execution_binding::parse_change(&body)?;
    let result = app
        .update("execution.operation", |data| {
            let offer = match &change {
                Change::Bind {
                    device_id, route, ..
                }
                | Change::Compose {
                    device_id, route, ..
                } => app.tv.offer(data, device_id, route),
                _ => None,
            };
            data.apply_execution_change(
                Request {
                    space_id: space,
                    idempotency_key: key.into(),
                    change,
                },
                offer.as_ref(),
                chrono::Utc::now(),
            )
        })
        .await?;
    Ok(Json(result))
}
async fn resolve(
    State(app): State<App>,
    Path((space, key)): Path<(String, String)>,
) -> Output<Json<Operation>> {
    ensure(identifier(&key), "invalid_idempotency_key")?;
    let store = app.store.lock().await;
    check(&store.data, &space)?;
    Ok(Json(store.data.execution_operation(&key)?.clone()))
}
