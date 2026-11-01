use crate::{
    api::ApiError, application::App, control_client::ControlAccess, identity::MachineIdentity,
};
use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use limeiot_core::{
    control::{hexadecimal, LinkRequest, LinkStatus, LinkView},
    ensure, err, Result,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

pub fn routes() -> Router<App> {
    Router::new()
        .route(
            "/api/v1/spaces/:space/control-pairings",
            get(list).post(create),
        )
        .route(
            "/api/v1/spaces/:space/control-pairings/by-key/:id",
            get(resolve),
        )
        .route("/api/v1/spaces/:space/control-pairings/:id", get(one))
        .route(
            "/api/v1/spaces/:space/control-pairings/:id/approve",
            post(approve),
        )
        .route(
            "/api/v1/spaces/:space/control-pairings/:id/reconcile",
            post(reconcile),
        )
        .route(
            "/api/v1/spaces/:space/control-pairings/:id/revoke",
            post(revoke),
        )
}
type Output<T> = std::result::Result<T, ApiError>;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    control_origin: String,
    pairing_id: String,
    code: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Approval {
    review_revision: String,
}
fn access(app: &App) -> Result<Arc<ControlAccess>> {
    app.control
        .clone()
        .ok_or_else(|| err("control_not_configured"))
}
fn check(data: &limeiot_core::engine::Data, space: &str) -> Result<()> {
    ensure(data.space_id == space, "forbidden")
}
async fn list(State(app): State<App>, Path(space): Path<String>) -> Output<Json<Value>> {
    let store = app.store.lock().await;
    check(&store.data, &space)?;
    let items: Vec<_> = store
        .data
        .control_links
        .values()
        .map(|v| v.view())
        .collect::<Result<_>>()?;
    Ok(Json(
        json!({"items":items,"next_cursor":null,"configured":app.control.is_some(),"allowed_origins":app.control.as_ref().map(|v|v.provider.origins()).unwrap_or_default(),"gateway_id":app.control.as_ref().map(|v|v.identity.gateway_id()),"connection":app.connection.read().await.clone()}),
    ))
}
async fn one(
    State(app): State<App>,
    Path((space, id)): Path<(String, String)>,
) -> Output<Json<LinkView>> {
    let store = app.store.lock().await;
    check(&store.data, &space)?;
    Ok(Json(
        store
            .data
            .control_links
            .get(&id)
            .ok_or_else(|| err("control_link_not_found"))?
            .view()?,
    ))
}
async fn resolve(
    State(app): State<App>,
    Path((space, key)): Path<(String, String)>,
) -> Output<Json<LinkView>> {
    let store = app.store.lock().await;
    check(&store.data, &space)?;
    Ok(Json(store.data.resolve_control_link(&key)?.view()?))
}
fn key(headers: &HeaderMap) -> Result<String> {
    let value = headers
        .get("idempotency-key")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| err("invalid_idempotency_key"))?;
    ensure(limeiot_core::identifier(value), "invalid_idempotency_key")?;
    Ok(value.into())
}
async fn create(
    State(app): State<App>,
    Path(space): Path<String>,
    headers: HeaderMap,
    Json(input): Json<Input>,
) -> Output<(StatusCode, Json<LinkView>)> {
    ensure(hexadecimal(&input.code), "invalid_pairing_code")?;
    let request = LinkRequest {
        space_id: space.clone(),
        idempotency_key: key(&headers)?,
        control_origin: input.control_origin,
        pairing_id: input.pairing_id,
        code_digest: MachineIdentity::code_digest(&input.code),
    };
    let mut store = app.store.lock().await;
    check(&store.data, &space)?;
    if let Some(view) = store.data.existing_control_link(&request)? {
        return Ok((StatusCode::ACCEPTED, Json(view)));
    }
    let access = access(&app)?;
    ensure(
        access.provider.origins().contains(&request.control_origin),
        "control_origin_not_allowed",
    )?;
    let permit = access
        .slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| err("control_busy"))?;
    let sealed = access
        .identity
        .seal(&format!("{space}:{}", request.idempotency_key), &input.code)?;
    let view = store.update("control.review_started", |data| {
        data.create_control_link(request, sealed, chrono::Utc::now())
    })?;
    drop(store);
    let _ = app.bus.send(());
    let id = view.link_id.clone();
    tokio::spawn(async move {
        review_remote(&app, &access, &id).await;
        drop(permit)
    });
    Ok((StatusCode::ACCEPTED, Json(view)))
}
async fn review_remote(app: &App, access: &ControlAccess, id: &str) {
    let link = app.store.lock().await.data.control_links.get(id).cloned();
    let Some(link) = link else { return };
    let result = match access.identity.open(
        &format!("{}:{}", link.request.space_id, link.request.idempotency_key),
        &link.sealed_code,
    ) {
        Ok(code) => {
            access
                .provider
                .review(
                    &link.request.control_origin,
                    &link.request.pairing_id,
                    &code,
                )
                .await
        }
        Err(e) => Err(e),
    };
    if let Err(error) = app
        .update("control.review_finished", |data| {
            data.finish_control_review(id, result, chrono::Utc::now())
        })
        .await
    {
        log_failure(id, &error.code)
    }
}
async fn approve(
    State(app): State<App>,
    Path((space, id)): Path<(String, String)>,
    Json(input): Json<Approval>,
) -> Output<(StatusCode, Json<LinkView>)> {
    let mut store = app.store.lock().await;
    check(&store.data, &space)?;
    let original = store
        .data
        .control_links
        .get(&id)
        .ok_or_else(|| err("control_link_not_found"))?
        .clone();
    if original.approved_at.is_some() || original.status == LinkStatus::Revoked {
        return Ok((
            StatusCode::ACCEPTED,
            Json(store.data.approve_control_link(
                &id,
                &input.review_revision,
                chrono::Utc::now(),
            )?),
        ));
    }
    let access = access(&app)?;
    let permit = access
        .slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| err("control_busy"))?;
    let code = access.identity.open(
        &format!("{space}:{}", original.request.idempotency_key),
        &original.sealed_code,
    )?;
    let view = store.update("control.approved", |data| {
        data.approve_control_link(&id, &input.review_revision, chrono::Utc::now())
    })?;
    drop(store);
    let _ = app.bus.send(());
    let review = view
        .review
        .as_ref()
        .ok_or_else(|| err("control_review_required"))?;
    let claim = access
        .identity
        .claim(&review.control_origin, &review.pairing, &space, code);
    tokio::spawn(async move {
        let result = access
            .provider
            .claim(
                &original.request.control_origin,
                &original.request.pairing_id,
                &claim,
            )
            .await;
        if let Err(error) = app
            .update("control.claim_finished", |data| {
                data.finish_control_claim(
                    &id,
                    &access.identity.gateway_id(),
                    &access.identity.public(),
                    result,
                )
            })
            .await
        {
            log_failure(&id, &error.code)
        };
        drop(permit)
    });
    Ok((StatusCode::ACCEPTED, Json(view)))
}
async fn reconcile(
    State(app): State<App>,
    Path((space, id)): Path<(String, String)>,
) -> Output<(StatusCode, Json<LinkView>)> {
    let mut store = app.store.lock().await;
    check(&store.data, &space)?;
    let link = store
        .data
        .control_links
        .get(&id)
        .ok_or_else(|| err("control_link_not_found"))?
        .clone();
    if !matches!(link.status, LinkStatus::Unknown | LinkStatus::Active) {
        return Ok((StatusCode::ACCEPTED, Json(link.view()?)));
    }
    let access = access(&app)?;
    let permit = access
        .slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| err("control_busy"))?;
    let view = store.update("control.reconcile_started", |data| {
        data.reconcile_control_link(&id)
    })?;
    drop(store);
    let _ = app.bus.send(());
    tokio::spawn(async move {
        if let Some(review) = &link.review {
            if link.approved_at.is_some() {
                let result = match access.identity.open(
                    &format!("{space}:{}", link.request.idempotency_key),
                    &link.sealed_code,
                ) {
                    Ok(code) => {
                        let claim = access.identity.claim(
                            &review.control_origin,
                            &review.pairing,
                            &space,
                            code,
                        );
                        access
                            .provider
                            .status(
                                &link.request.control_origin,
                                &link.request.pairing_id,
                                &claim,
                            )
                            .await
                    }
                    Err(e) => Err(e),
                };
                if let Err(error) = app
                    .update("control.reconcile_finished", |data| {
                        data.finish_control_claim(
                            &id,
                            &access.identity.gateway_id(),
                            &access.identity.public(),
                            result,
                        )
                    })
                    .await
                {
                    log_failure(&id, &error.code)
                };
                drop(permit);
                return;
            }
        };
        review_remote(&app, &access, &id).await;
        drop(permit)
    });
    Ok((StatusCode::ACCEPTED, Json(view)))
}
async fn revoke(
    State(app): State<App>,
    Path((space, id)): Path<(String, String)>,
) -> Output<Json<LinkView>> {
    check(&app.store.lock().await.data, &space)?;
    Ok(Json(
        app.update("control.revoked", |data| data.revoke_control_link(&id))
            .await?,
    ))
}
fn log_failure(id: &str, code: &str) {
    eprintln!(
        "{}",
        json!({"event":"control.commit_failed","link_id":id,"code":code})
    )
}
