//! 只读候选查询与明确来源决定；串口和协议清单始终由宿主拥有。
use crate::{api::ApiError, application::App};
use axum::{
    body::Bytes,
    extract::{Path, State},
    http::HeaderMap,
    routing::get,
    Json, Router,
};
use limeiot_core::{
    ensure, err, identifier,
    observation_binding::{self, Change, Operation, Request},
};
use serde_json::{json, Value};
type Output<T> = std::result::Result<T, ApiError>;

pub fn routes() -> Router<App> {
    Router::new()
        .route(
            "/api/v1/spaces/:space/zigbee-coordinators",
            get(coordinators),
        )
        .route(
            "/api/v1/spaces/:space/zigbee-operations",
            get(zigbee_operations).post(commission),
        )
        .route(
            "/api/v1/spaces/:space/zigbee-operations/by-key/:key",
            get(zigbee_resolve),
        )
        .route(
            "/api/v1/spaces/:space/observation-candidates",
            get(candidates).post(query),
        )
        .route(
            "/api/v1/spaces/:space/observation-discoveries",
            axum::routing::post(discover),
        )
        .route(
            "/api/v1/spaces/:space/observation-endpoints",
            axum::routing::post(endpoints),
        )
        .route(
            "/api/v1/spaces/:space/devices/:device/observation-binding",
            get(binding),
        )
        .route(
            "/api/v1/spaces/:space/observation-operations",
            axum::routing::post(apply),
        )
        .route(
            "/api/v1/spaces/:space/observation-operations/by-key/:key",
            get(resolve),
        )
}
async fn coordinators(State(app): State<App>, Path(space): Path<String>) -> Output<Json<Value>> {
    Ok(Json(
        app.integrations.zigbee_coordinators(&app, &space).await?,
    ))
}
async fn zigbee_operations(
    State(app): State<App>,
    Path(space): Path<String>,
) -> Output<Json<Value>> {
    let store = app.store.lock().await;
    ensure(store.data.space_id == space, "forbidden")?;
    let mut operations: Vec<_> = store.commissioning.values().cloned().collect();
    operations.sort_by_key(|operation| operation.sequence);
    Ok(Json(json!({"items":operations,"next_cursor":null})))
}
async fn zigbee_resolve(
    State(app): State<App>,
    Path((space, key)): Path<(String, String)>,
) -> Output<Json<crate::commissioning::Operation>> {
    let store = app.store.lock().await;
    ensure(store.data.space_id == space, "forbidden")?;
    Ok(Json(store.commissioning_operation(&key)?.clone()))
}
async fn commission(
    State(app): State<App>,
    Path(space): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Output<Json<crate::commissioning::Operation>> {
    json_content(&headers)?;
    ensure(
        headers.get_all("idempotency-key").iter().count() == 1,
        "invalid_idempotency_key",
    )?;
    let key = headers
        .get("idempotency-key")
        .and_then(|value| value.to_str().ok())
        .filter(|value| identifier(value))
        .ok_or_else(|| err("invalid_idempotency_key"))?;
    let request = crate::commissioning::Request {
        space_id: space,
        idempotency_key: key.into(),
        change: crate::commissioning::parse_change(&body)?,
    };
    Ok(Json(
        app.integrations.zigbee_commission(&app, request).await?,
    ))
}
fn json_content(headers: &HeaderMap) -> limeiot_core::Result<()> {
    ensure(
        headers
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| {
                value.split(';').next().map(str::trim) == Some("application/json")
            }),
        "invalid_observation_change",
    )
}
async fn candidates(State(app): State<App>, Path(space): Path<String>) -> Output<Json<Value>> {
    Ok(Json(
        app.integrations
            .observation_candidates(&app, &space)
            .await?,
    ))
}
async fn query(
    State(app): State<App>,
    Path(space): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Output<Json<Value>> {
    json_content(&headers)?;
    Ok(Json(
        app.integrations
            .observation_query(&app, &space, &body)
            .await?,
    ))
}
async fn discover(
    State(app): State<App>,
    Path(space): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Output<Json<Value>> {
    json_content(&headers)?;
    Ok(Json(
        app.integrations
            .observation_discovery(&app, &space, &body, false)
            .await?,
    ))
}
async fn endpoints(
    State(app): State<App>,
    Path(space): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Output<Json<Value>> {
    json_content(&headers)?;
    Ok(Json(
        app.integrations
            .observation_discovery(&app, &space, &body, true)
            .await?,
    ))
}
async fn binding(
    State(app): State<App>,
    Path((space, device)): Path<(String, String)>,
) -> Output<Json<Value>> {
    let store = app.store.lock().await;
    ensure(store.data.space_id == space, "forbidden")?;
    Ok(Json(json!(store.data.observation_binding(&device)?)))
}
async fn apply(
    State(app): State<App>,
    Path(space): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Output<Json<Operation>> {
    json_content(&headers)?;
    ensure(
        headers.get_all("idempotency-key").iter().count() == 1,
        "invalid_idempotency_key",
    )?;
    let key = headers
        .get("idempotency-key")
        .and_then(|value| value.to_str().ok())
        .filter(|value| identifier(value))
        .ok_or_else(|| err("invalid_idempotency_key"))?;
    let change = observation_binding::parse_change(&body)?;
    let result = app
        .update("observation.operation", |data| {
            let offer = match &change {
                Change::Bind { source, .. } => app.integrations.observation_offer(source),
                _ => None,
            };
            data.apply_observation_change(
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
    ensure(store.data.space_id == space, "forbidden")?;
    Ok(Json(store.data.observation_operation(&key)?.clone()))
}
