//! 本地所有者的有界计划；复用原命令账本，不提供物理急停或节拍承诺。
use crate::{api::ApiError, application::App};
use axum::{
    body::Bytes,
    extract::{Path, Query, State},
    http::HeaderMap,
    routing::{get, post},
    Json, Router,
};
use limeiot_core::{
    ensure, err,
    execution_plans::{parse_change, Operation, Request},
    identifier,
};
use serde::Deserialize;
use serde_json::{json, Value};

type Output<T> = std::result::Result<T, ApiError>;

fn public_operation(operation: Operation) -> limeiot_core::Result<Value> {
    let mut value = serde_json::to_value(operation).map_err(|_| err("invalid_json"))?;
    value
        .as_object_mut()
        .ok_or_else(|| err("invalid_json"))?
        .remove("applied_snapshot");
    Ok(value)
}

pub fn routes() -> Router<App> {
    Router::new()
        .route("/api/v1/spaces/:space/execution-plans", get(list))
        .route("/api/v1/spaces/:space/execution-plans/:id", get(one))
        .route(
            "/api/v1/spaces/:space/execution-plan-operations",
            post(apply),
        )
        .route(
            "/api/v1/spaces/:space/execution-plan-operations/by-key/:id",
            get(resolve),
        )
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    after: Option<String>,
}

async fn list(
    State(app): State<App>,
    Path(space): Path<String>,
    Query(cursor): Query<Cursor>,
) -> Output<Json<Value>> {
    if let Some(after) = &cursor.after {
        ensure(identifier(after), "invalid_cursor")?;
    }
    let store = app.store.lock().await;
    ensure(store.data.space_id == space, "forbidden")?;
    let mut items: Vec<_> = store
        .data
        .execution_plans
        .plans
        .values()
        .filter(|plan| {
            cursor
                .after
                .as_ref()
                .is_none_or(|after| plan.plan_id > *after)
        })
        .take(17)
        .collect();
    let next = (items.len() > 16).then(|| items[15].plan_id.clone());
    items.truncate(16);
    Ok(Json(json!({"items":items,"next_cursor":next})))
}

async fn one(
    State(app): State<App>,
    Path((space, id)): Path<(String, String)>,
) -> Output<Json<Value>> {
    ensure(identifier(&id), "invalid_execution_plan_id")?;
    let store = app.store.lock().await;
    ensure(store.data.space_id == space, "forbidden")?;
    Ok(Json(json!(store.data.execution_plan(&id)?)))
}

async fn apply(
    State(app): State<App>,
    Path(space): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Output<Json<Value>> {
    ensure(
        headers
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| {
                value.split(';').next().map(str::trim) == Some("application/json")
            }),
        "invalid_execution_plan_change",
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
        app.update("execution-plan.operation", |data| {
            public_operation(data.apply_plan_change(
                Request {
                    space_id: space,
                    idempotency_key: key.into(),
                    change,
                },
                chrono::Utc::now(),
            )?)
        })
        .await?,
    ))
}

async fn resolve(
    State(app): State<App>,
    Path((space, key)): Path<(String, String)>,
) -> Output<Json<Value>> {
    ensure(identifier(&key), "invalid_idempotency_key")?;
    let store = app.store.lock().await;
    ensure(store.data.space_id == space, "forbidden")?;
    Ok(Json(public_operation(
        store.data.execution_plan_operation(&key)?.clone(),
    )?))
}

pub async fn run(app: App) {
    let mut ticks = tokio::time::interval(std::time::Duration::from_millis(100));
    ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        ticks.tick().await;
        if !app.store.lock().await.data.has_pending_execution_plans() {
            continue;
        }
        // 即使 Broker 断线也更新期限/未知状态；此处只受理原命令，不发布网络消息。
        if let Err(error) = app
            .update("execution-plan.transitioned", |data| {
                data.poll_execution_plans(chrono::Utc::now())
            })
            .await
        {
            eprintln!(
                "{}",
                json!({"event":"execution-plan.update_failed","code":error.code})
            );
        }
    }
}
