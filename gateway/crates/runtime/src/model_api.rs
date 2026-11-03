//! 本地模型变更无外部网络请求；原决定和资源由同一次SQLite快照提交。
use crate::{api::ApiError, application::App};
use axum::{
    body::Bytes,
    extract::{Path, Query, State},
    http::HeaderMap,
    routing::get,
    Json, Router,
};
use limeiot_core::{
    ensure, err, identifier,
    model_registry::{parse_change, Operation, Request},
    Result,
};
use serde::Deserialize;
use serde_json::{json, Value};

type Output<T> = std::result::Result<T, ApiError>;
pub fn routes() -> Router<App> {
    Router::new()
        .route("/api/v1/spaces/:space/model-bundles", get(bundles))
        .route("/api/v1/spaces/:space/model-bundles/:id", get(bundle))
        .route("/api/v1/spaces/:space/model-trusts", get(trusts))
        .route("/api/v1/spaces/:space/model-trusts/:id", get(trust))
        .route(
            "/api/v1/spaces/:space/model-installations",
            get(installations),
        )
        .route(
            "/api/v1/spaces/:space/model-installations/:id",
            get(installation),
        )
        .route(
            "/api/v1/spaces/:space/devices/:id/model-binding",
            get(binding),
        )
        .route(
            "/api/v1/spaces/:space/model-operations",
            axum::routing::post(apply),
        )
        .route(
            "/api/v1/spaces/:space/model-operations/by-key/:id",
            get(resolve),
        )
}
fn check(data: &limeiot_core::engine::Data, space: &str) -> Result<()> {
    ensure(data.space_id == space, "forbidden")
}
async fn bundles(State(app): State<App>, Path(space): Path<String>) -> Output<Json<Value>> {
    let store = app.store.lock().await;
    check(&store.data, &space)?;
    Ok(Json(
        json!({"items":limeiot_core::model_bundles::catalog()?,"next_cursor":null}),
    ))
}
async fn bundle(
    State(app): State<App>,
    Path((space, id)): Path<(String, String)>,
) -> Output<Json<Value>> {
    let store = app.store.lock().await;
    check(&store.data, &space)?;
    Ok(Json(json!(limeiot_core::model_bundles::get(&id)?)))
}
async fn trusts(State(app): State<App>, Path(space): Path<String>) -> Output<Json<Value>> {
    let store = app.store.lock().await;
    check(&store.data, &space)?;
    Ok(Json(
        json!({"items":store.data.model_registry.trusts.values().collect::<Vec<_>>(),"next_cursor":null}),
    ))
}
async fn trust(
    State(app): State<App>,
    Path((space, id)): Path<(String, String)>,
) -> Output<Json<Value>> {
    let store = app.store.lock().await;
    check(&store.data, &space)?;
    Ok(Json(json!(store
        .data
        .model_registry
        .trusts
        .get(&id)
        .ok_or_else(|| err("model_trust_not_found"))?)))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    after: Option<String>,
}
async fn installations(
    State(app): State<App>,
    Path(space): Path<String>,
    Query(cursor): Query<Cursor>,
) -> Output<Json<Value>> {
    let store = app.store.lock().await;
    check(&store.data, &space)?;
    if let Some(after) = &cursor.after {
        ensure(identifier(after), "invalid_cursor")?;
    }
    let mut items: Vec<_> = store
        .data
        .model_registry
        .installations
        .values()
        .filter(|v| {
            cursor
                .after
                .as_ref()
                .is_none_or(|after| v.installation_id > *after)
        })
        .take(17)
        .collect();
    let next = (items.len() > 16).then(|| items[15].installation_id.clone());
    items.truncate(16);
    Ok(Json(
        json!({"items":items,"next_cursor":next,"heads":store.data.model_registry.heads}),
    ))
}
async fn installation(
    State(app): State<App>,
    Path((space, id)): Path<(String, String)>,
) -> Output<Json<Value>> {
    let store = app.store.lock().await;
    check(&store.data, &space)?;
    Ok(Json(json!(store
        .data
        .model_registry
        .installations
        .get(&id)
        .ok_or_else(|| err("model_installation_not_found"))?)))
}
async fn binding(
    State(app): State<App>,
    Path((space, id)): Path<(String, String)>,
) -> Output<Json<Value>> {
    ensure(identifier(&id), "invalid_device_id")?;
    let store = app.store.lock().await;
    check(&store.data, &space)?;
    let device = store.data.devices.get(&id);
    Ok(Json(
        json!({"device_id":id,"model_revision":device.map(|v|&v.model_revision),
        "binding":store.data.model_registry.bindings.get(&id),
        "trust_active":device.is_some()&&store.data.check_model_authority(&id).is_ok()}),
    ))
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
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.split(';').next().map(str::trim) == Some("application/json")),
        "invalid_model_change",
    )?;
    ensure(
        headers.get_all("idempotency-key").iter().count() == 1,
        "invalid_idempotency_key",
    )?;
    let key = headers
        .get("idempotency-key")
        .and_then(|v| v.to_str().ok())
        .filter(|v| identifier(v))
        .ok_or_else(|| err("invalid_idempotency_key"))?;
    let change = parse_change(&body)?;
    let operation = app
        .update("model.operation", |data| {
            data.apply_model_change(
                Request {
                    space_id: space,
                    idempotency_key: key.into(),
                    change,
                },
                chrono::Utc::now(),
            )
        })
        .await?;
    Ok(Json(operation))
}
async fn resolve(
    State(app): State<App>,
    Path((space, key)): Path<(String, String)>,
) -> Output<Json<Operation>> {
    ensure(identifier(&key), "invalid_idempotency_key")?;
    let store = app.store.lock().await;
    check(&store.data, &space)?;
    Ok(Json(store.data.model_operation(&key)?.clone()))
}
