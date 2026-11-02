//! 本地所有者固件信任及升级计划；批准不启动网络或设备安装。
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
    ota_tasks::{parse_change, Operation, Request},
    Result,
};
use serde::Deserialize;
use serde_json::{json, Value};
type Output<T> = std::result::Result<T, ApiError>;
pub fn routes() -> Router<App> {
    Router::new()
        .route("/api/v1/spaces/:space/firmware-trusts", get(trusts))
        .route("/api/v1/spaces/:space/firmware-trusts/:id", get(trust))
        .route("/api/v1/spaces/:space/ota-tasks", get(tasks))
        .route("/api/v1/spaces/:space/ota-tasks/:id", get(task))
        .route(
            "/api/v1/spaces/:space/ota-operations",
            axum::routing::post(apply),
        )
        .route(
            "/api/v1/spaces/:space/ota-operations/by-key/:id",
            get(resolve),
        )
}
fn check(data: &limeiot_core::engine::Data, space: &str) -> Result<()> {
    ensure(data.space_id == space, "forbidden")
}
async fn trusts(State(app): State<App>, Path(space): Path<String>) -> Output<Json<Value>> {
    let store = app.store.lock().await;
    check(&store.data, &space)?;
    Ok(Json(
        json!({"items":store.data.ota_registry.trusts.values().collect::<Vec<_>>(),"next_cursor":null}),
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
        .ota_registry
        .trusts
        .get(&id)
        .ok_or_else(|| err("ota_trust_not_found"))?)))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    after: Option<String>,
}
async fn tasks(
    State(app): State<App>,
    Path(space): Path<String>,
    Query(cursor): Query<Cursor>,
) -> Output<Json<Value>> {
    if let Some(after) = &cursor.after {
        ensure(identifier(after), "invalid_cursor")?;
    }
    let store = app.store.lock().await;
    check(&store.data, &space)?;
    let mut items: Vec<_> = store
        .data
        .ota_registry
        .tasks
        .values()
        .filter(|task| {
            cursor
                .after
                .as_ref()
                .is_none_or(|after| task.task_id > *after)
        })
        .take(17)
        .collect();
    let next = (items.len() > 16).then(|| items[15].task_id.clone());
    items.truncate(16);
    Ok(Json(json!({"items":items,"next_cursor":next})))
}
async fn task(
    State(app): State<App>,
    Path((space, id)): Path<(String, String)>,
) -> Output<Json<Value>> {
    let store = app.store.lock().await;
    check(&store.data, &space)?;
    Ok(Json(json!(store
        .data
        .ota_registry
        .tasks
        .get(&id)
        .ok_or_else(|| err("ota_task_not_found"))?)))
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
        "invalid_ota_change",
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
    let change = parse_change(&body)?;
    Ok(Json(
        app.update("ota.operation", |data| {
            data.apply_ota_change(
                Request {
                    space_id: space,
                    idempotency_key: key.into(),
                    change,
                },
                chrono::Utc::now(),
            )
        })
        .await?,
    ))
}
async fn resolve(
    State(app): State<App>,
    Path((space, key)): Path<(String, String)>,
) -> Output<Json<Operation>> {
    ensure(identifier(&key), "invalid_idempotency_key")?;
    let store = app.store.lock().await;
    check(&store.data, &space)?;
    Ok(Json(store.data.ota_operation(&key)?.clone()))
}
