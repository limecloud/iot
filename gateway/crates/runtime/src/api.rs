use crate::application::App;
use crate::auth::{self, SessionKey};
use axum::{
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{HeaderMap, StatusCode},
    middleware,
    response::{
        sse::{Event, Sse},
        IntoResponse, Response,
    },
    Extension, Json, Router,
};
use limeiot_core::{
    draft::{DraftRequest, DraftStatus, RuleDraft},
    engine::Data,
    ensure, err,
    protocol::{CommandRequest, Rule},
    Error,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{convert::Infallible, sync::atomic::Ordering};

pub(crate) struct ApiError(pub Error);
impl From<Error> for ApiError {
    fn from(e: Error) -> Self {
        Self(e)
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = match self.0.code.as_str() {
            "unauthenticated" => StatusCode::UNAUTHORIZED,
            "forbidden" => StatusCode::FORBIDDEN,
            "device_not_found"
            | "command_not_found"
            | "draft_not_found"
            | "control_link_not_found"
            | "model_operation_not_found"
            | "model_trust_not_found"
            | "model_installation_not_found"
            | "model_bundle_not_found"
            | "ota_task_not_found"
            | "ota_trust_not_found"
            | "ota_operation_not_found"
            | "execution_operation_not_found"
            | "media_not_found"
            | "media_operation_not_found"
            | "speech_not_found"
            | "transcription_not_found"
            | "vision_not_found"
            | "execution_plan_not_found"
            | "execution_plan_operation_not_found"
            | "not_found" => StatusCode::NOT_FOUND,
            "idempotency_conflict"
            | "device_offline"
            | "model_mismatch"
            | "event_gap"
            | "revision_conflict"
            | "control_already_bound" => StatusCode::CONFLICT,
            "transcription_source_mismatch" | "transcription_already_completed" => {
                StatusCode::CONFLICT
            }
            "ota_task_conflict" | "execution_plan_conflict" | "speech_already_completed" => {
                StatusCode::CONFLICT
            }
            "storage_unavailable"
            | "inference_not_configured"
            | "control_not_configured"
            | "media_storage_unavailable"
            | "speech_not_configured"
            | "transcription_not_configured"
            | "vision_not_configured"
            | "media_not_configured" => StatusCode::SERVICE_UNAVAILABLE,
            "inference_busy"
            | "control_busy"
            | "model_operation_capacity"
            | "ota_operation_capacity" => StatusCode::TOO_MANY_REQUESTS,
            "execution_operation_capacity" => StatusCode::TOO_MANY_REQUESTS,
            "transcription_busy" | "transcription_capacity" => StatusCode::TOO_MANY_REQUESTS,
            "vision_busy" | "vision_capacity" => StatusCode::TOO_MANY_REQUESTS,
            "media_operation_capacity" | "media_capacity" | "speech_busy" | "speech_capacity" => {
                StatusCode::TOO_MANY_REQUESTS
            }
            "execution_plan_capacity" | "execution_plan_operation_capacity" => {
                StatusCode::TOO_MANY_REQUESTS
            }
            _ => StatusCode::UNPROCESSABLE_ENTITY,
        };
        (
            status,
            Json(json!({"error":{"code":self.0.code,"request_id":limeiot_core::id()}})),
        )
            .into_response()
    }
}
type ApiResult<T> = Result<T, ApiError>;
pub fn router(app: App) -> Router {
    let api = Router::new()
        .route("/api/v1/schema", axum::routing::get(schema))
        .route("/api/v1/spaces", axum::routing::get(spaces))
        .route("/api/v1/spaces/:space/devices", axum::routing::get(devices))
        .route(
            "/api/v1/spaces/:space/devices/:device",
            axum::routing::get(device),
        )
        .route(
            "/api/v1/spaces/:space/capabilities",
            axum::routing::get(capabilities),
        )
        .route(
            "/api/v1/model-releases/:revision",
            axum::routing::get(model),
        )
        .route(
            "/api/v1/spaces/:space/commands",
            axum::routing::post(command_create).get(command_list),
        )
        .route(
            "/api/v1/spaces/:space/commands/:command",
            axum::routing::get(command_get),
        )
        .route(
            "/api/v1/spaces/:space/commands/by-key/:key",
            axum::routing::get(command_resolve),
        )
        .route(
            "/api/v1/spaces/:space/:rule_action",
            axum::routing::post(rule_action),
        )
        .route(
            "/api/v1/spaces/:space/rule-deployments",
            axum::routing::post(rule_deploy).get(rule_list),
        )
        .route(
            "/api/v1/spaces/:space/rule-deployments/:rule/stop",
            axum::routing::post(rule_stop),
        )
        .route(
            "/api/v1/spaces/:space/rule-drafts",
            axum::routing::post(draft_create).get(draft_list),
        )
        .route(
            "/api/v1/spaces/:space/rule-drafts/:draft",
            axum::routing::get(draft_get),
        )
        .route(
            "/api/v1/spaces/:space/rule-drafts/by-key/:key",
            axum::routing::get(draft_resolve),
        )
        .route("/api/v1/spaces/:space/runs", axum::routing::get(runs))
        .route("/api/v1/spaces/:space/events", axum::routing::get(events))
        .route(
            "/api/v1/spaces/:space/events/stream",
            axum::routing::get(stream),
        )
        .merge(crate::control_api::routes())
        .merge(crate::model_api::routes())
        .merge(crate::ota_api::routes())
        .merge(crate::execution_api::routes())
        .merge(crate::execution_plan_api::routes())
        .merge(crate::media::routes())
        .merge(crate::speech::routes())
        .merge(crate::transcription::routes())
        .merge(crate::vision::routes())
        .route_layer(middleware::from_fn_with_state(app.clone(), auth::authorize));
    Router::new()
        .route("/healthz", axum::routing::get(health))
        .route(
            "/api/v1/auth/session",
            axum::routing::post(auth::login).get(auth::session),
        )
        .route("/api/v1/auth/logout", axum::routing::post(auth::logout))
        .merge(api)
        .fallback_service(tower_http::services::ServeDir::new(app.home_dir.as_str()))
        .layer(DefaultBodyLimit::max(16384))
        .layer(middleware::from_fn_with_state(app.clone(), auth::boundary))
        .with_state(app)
}
fn check(data: &Data, space: &str) -> ApiResult<()> {
    ensure(data.space_id == space, "forbidden").map_err(Into::into)
}
async fn health(State(app): State<App>) -> Json<Value> {
    Json(
        json!({"status":"ok","broker_connected":app.broker.load(Ordering::Relaxed),"mode":"loopback_simulation"}),
    )
}
async fn schema() -> Json<Value> {
    Json(
        serde_json::from_str(include_str!("../../../../contracts/tools/catalog.json"))
            .expect("tool catalog"),
    )
}
async fn spaces(State(app): State<App>) -> Json<Value> {
    Json(json!({"items":[{"space_id":app.store.lock().await.data.space_id}],"next_cursor":null}))
}
async fn devices(State(app): State<App>, Path(space): Path<String>) -> ApiResult<Json<Value>> {
    let store = app.store.lock().await;
    check(&store.data, &space)?;
    Ok(Json(
        json!({"items":store.data.devices_view(chrono::Utc::now()),"next_cursor":null}),
    ))
}
async fn device(
    State(app): State<App>,
    Path((space, device)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    let store = app.store.lock().await;
    check(&store.data, &space)?;
    Ok(Json(
        store
            .data
            .devices_view(chrono::Utc::now())
            .into_iter()
            .find(|d| d["device_id"] == device)
            .ok_or_else(|| err("device_not_found"))?,
    ))
}
async fn capabilities(State(app): State<App>, Path(space): Path<String>) -> ApiResult<Json<Value>> {
    let vision = app
        .vision
        .as_ref()
        .map(|service| service.capabilities())
        .unwrap_or_else(|| json!({"configured":false,"capability":"vision.understand"}));
    let transcription = app
        .transcription
        .as_ref()
        .map(|service| service.capabilities())
        .unwrap_or_else(|| json!({"configured":false,"capability":"audio.transcribe"}));
    let speech = app
        .speech
        .as_ref()
        .map(|service| service.capabilities())
        .unwrap_or_else(|| json!({"configured":false,"capability":"audio.synthesize"}));
    let store = app.store.lock().await;
    check(&store.data, &space)?;
    Ok(Json(
        json!({"space_id":space,"mode":"loopback_simulation","operations":serde_json::from_str::<Value>(include_str!("../../../../contracts/tools/catalog.json")).unwrap()["operations"],"models":store.data.models,"inference":{"configured":app.inference.is_some(),"provider":"ollama","model":app.inference.as_ref().map(|p|p.model()),"data_location":"local","concurrency":1,"max_output_tokens":1024},"speech":speech,"transcription":transcription,"vision":vision,"limits":{"devices":64,"commands":4096,"rules":64,"runs":1024,"dedup_events":4096,"rule_drafts":128,"model_trusts":limeiot_core::model_registry::MAX_TRUSTS,"model_installations":limeiot_core::model_registry::MAX_INSTALLATIONS,"model_operations":limeiot_core::model_registry::MAX_OPERATIONS}}),
    ))
}
async fn model(State(app): State<App>, Path(revision): Path<String>) -> ApiResult<Json<Value>> {
    Ok(Json(
        serde_json::to_value(
            app.store
                .lock()
                .await
                .data
                .models
                .get(&revision)
                .ok_or_else(|| err("not_found"))?,
        )
        .unwrap(),
    ))
}
async fn command_create(
    State(app): State<App>,
    Path(space): Path<String>,
    headers: HeaderMap,
    Json(mut input): Json<Value>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    {
        let store = app.store.lock().await;
        check(&store.data, &space)?;
    }
    let key = headers
        .get("idempotency-key")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| err("invalid_idempotency_key"))?;
    let object = input
        .as_object_mut()
        .ok_or_else(|| err("invalid_request"))?;
    ensure(
        !object.contains_key("space_id") && !object.contains_key("idempotency_key"),
        "invalid_request",
    )?;
    object.insert("space_id".into(), json!(space));
    object.insert("idempotency_key".into(), json!(key));
    let request: CommandRequest =
        serde_json::from_value(input).map_err(|_| err("invalid_request"))?;
    let command = app
        .update("command.created", |data| {
            data.create_command(request, chrono::Utc::now(), None)
        })
        .await?;
    Ok((
        StatusCode::ACCEPTED,
        Json(serde_json::to_value(command).unwrap()),
    ))
}
async fn command_get(
    State(app): State<App>,
    Path((space, command)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    let store = app.store.lock().await;
    check(&store.data, &space)?;
    Ok(Json(
        serde_json::to_value(
            store
                .data
                .commands
                .get(&command)
                .ok_or_else(|| err("command_not_found"))?,
        )
        .unwrap(),
    ))
}
#[derive(Deserialize)]
struct CommandCursor {
    cursor: Option<String>,
}
async fn command_list(
    State(app): State<App>,
    Path(space): Path<String>,
    Query(cursor): Query<CommandCursor>,
) -> ApiResult<Json<Value>> {
    let store = app.store.lock().await;
    check(&store.data, &space)?;
    let mut commands: Vec<_> = store.data.commands.values().collect();
    commands.sort_by(|a, b| {
        b.request
            .expires_at
            .cmp(&a.request.expires_at)
            .then(b.command_id.cmp(&a.command_id))
    });
    let start = match cursor.cursor {
        Some(id) => {
            commands
                .iter()
                .position(|c| c.command_id == id)
                .ok_or_else(|| err("invalid_cursor"))?
                + 1
        }
        None => 0,
    };
    let end = (start + 100).min(commands.len());
    let next = if end < commands.len() {
        Some(&commands[end - 1].command_id)
    } else {
        None
    };
    Ok(Json(
        json!({"items":commands[start..end],"next_cursor":next}),
    ))
}
// 路由适配器显式分发冒号动作，保持业务 URL 与领域方法独立。
async fn command_resolve(
    State(app): State<App>,
    Path((space, key)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    let store = app.store.lock().await;
    check(&store.data, &space)?;
    let command = store
        .data
        .keys
        .get(&key)
        .and_then(|id| store.data.commands.get(id))
        .ok_or_else(|| err("command_not_found"))?;
    Ok(Json(serde_json::to_value(command).unwrap()))
}
fn draft_view(mut draft: RuleDraft) -> RuleDraft {
    // 截止后仍无耐久结果只能报未知，不把推理中断或提交失败伪装成仍在生成。
    if draft.status == DraftStatus::Running && draft.request.expires_at <= chrono::Utc::now() {
        draft.status = DraftStatus::Unknown;
        draft.error = Some("inference_unknown".into());
    }
    draft
}
async fn draft_create(
    State(app): State<App>,
    Path(space): Path<String>,
    headers: HeaderMap,
    Json(mut input): Json<Value>,
) -> ApiResult<(StatusCode, Json<RuleDraft>)> {
    let key = headers
        .get("idempotency-key")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| err("invalid_idempotency_key"))?;
    let object = input
        .as_object_mut()
        .ok_or_else(|| err("invalid_request"))?;
    ensure(
        !object.contains_key("space_id") && !object.contains_key("idempotency_key"),
        "invalid_request",
    )?;
    object.insert("space_id".into(), json!(space));
    object.insert("idempotency_key".into(), json!(key));
    let request: DraftRequest =
        serde_json::from_value(input).map_err(|_| err("invalid_request"))?;
    let mut store = app.store.lock().await;
    check(&store.data, &space)?;
    if let Some(draft) = store.data.existing_draft(&request)? {
        return Ok((StatusCode::ACCEPTED, Json(draft_view(draft))));
    }
    let provider = app
        .inference
        .clone()
        .ok_or_else(|| err("inference_not_configured"))?;
    let permit = app
        .inference_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| err("inference_busy"))?;
    let draft = store.update("inference.started", |data| {
        data.create_draft(request, provider.model(), chrono::Utc::now())
    })?;
    let context = store.data.draft_context();
    drop(store);
    let _ = app.bus.send(());
    let response = draft.clone();
    tokio::spawn(async move {
        let remaining = (draft.request.expires_at - chrono::Utc::now())
            .to_std()
            .unwrap_or_default()
            .min(std::time::Duration::from_secs(90));
        let result = if remaining.is_zero() {
            Err(err("draft_expired"))
        } else {
            tokio::time::timeout(
                remaining,
                provider.generate(&draft.draft_id, &draft.request.prompt, context),
            )
            .await
            .unwrap_or_else(|_| Err(err("inference_timeout")))
        };
        let (rule, usage) = match result {
            Ok(reply) => (Ok(reply.rule), reply.usage),
            Err(error) => (Err(error), None),
        };
        if let Err(error) = app
            .update("inference.finished", |data| {
                data.finish_draft(&draft.draft_id, rule, usage, chrono::Utc::now())
            })
            .await
        {
            eprintln!(
                "{}",
                json!({"event":"inference.commit_failed","draft_id":draft.draft_id,"code":error.code})
            );
        }
        drop(permit);
    });
    Ok((StatusCode::ACCEPTED, Json(response)))
}
async fn draft_get(
    State(app): State<App>,
    Path((space, id)): Path<(String, String)>,
) -> ApiResult<Json<RuleDraft>> {
    let store = app.store.lock().await;
    check(&store.data, &space)?;
    Ok(Json(draft_view(
        store
            .data
            .rule_drafts
            .get(&id)
            .cloned()
            .ok_or_else(|| err("draft_not_found"))?,
    )))
}
async fn draft_resolve(
    State(app): State<App>,
    Path((space, key)): Path<(String, String)>,
) -> ApiResult<Json<RuleDraft>> {
    let store = app.store.lock().await;
    check(&store.data, &space)?;
    Ok(Json(draft_view(store.data.resolve_draft(&key)?.clone())))
}
async fn draft_list(State(app): State<App>, Path(space): Path<String>) -> ApiResult<Json<Value>> {
    let store = app.store.lock().await;
    check(&store.data, &space)?;
    let mut items: Vec<_> = store
        .data
        .rule_drafts
        .values()
        .cloned()
        .map(draft_view)
        .collect();
    items.sort_by(|a, b| {
        b.created_at
            .cmp(&a.created_at)
            .then(b.draft_id.cmp(&a.draft_id))
    });
    Ok(Json(json!({"items":items,"next_cursor":null})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Revision {
    revision: String,
}
async fn rule_stop(
    State(app): State<App>,
    Path((space, rule)): Path<(String, String)>,
    Json(input): Json<Revision>,
) -> ApiResult<Json<Value>> {
    {
        check(&app.store.lock().await.data, &space)?;
    }
    Ok(Json(
        app.update("rule.stopped", |data| {
            data.stop_rule(&rule, &input.revision)
        })
        .await?,
    ))
}
async fn rule_action(
    State(app): State<App>,
    Path((space, action)): Path<(String, String)>,
    Json(input): Json<Value>,
) -> ApiResult<Json<Value>> {
    match action.as_str() {
        "rules:validate" => {
            rule_validate(
                State(app),
                Path(space),
                Json(serde_json::from_value(input).map_err(|_| err("invalid_rule"))?),
            )
            .await
        }
        "rules:simulate" => {
            rule_simulate(
                State(app),
                Path(space),
                Json(serde_json::from_value(input).map_err(|_| err("invalid_rule"))?),
            )
            .await
        }
        _ => Err(err("not_found").into()),
    }
}
async fn rule_validate(
    State(app): State<App>,
    Path(space): Path<String>,
    Json(rule): Json<Rule>,
) -> ApiResult<Json<Value>> {
    let store = app.store.lock().await;
    check(&store.data, &space)?;
    let mut result = json!({"valid":true,"revision":store.data.validate_rule(&rule)?});
    if let limeiot_core::protocol::Trigger::Schedule { schedule } = &rule.trigger {
        result["schedule_preview"] = serde_json::to_value(schedule.next_after(chrono::Utc::now())?)
            .map_err(|_| err("invalid_json"))?;
    }
    Ok(Json(result))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Simulation {
    rule: Rule,
    event: Value,
}
async fn rule_simulate(
    State(app): State<App>,
    Path(space): Path<String>,
    Json(input): Json<Simulation>,
) -> ApiResult<Json<Value>> {
    let store = app.store.lock().await;
    check(&store.data, &space)?;
    Ok(Json(store.data.simulate_rule(
        &input.rule,
        &input.event,
        chrono::Utc::now(),
    )?))
}
async fn rule_deploy(
    State(app): State<App>,
    Path(space): Path<String>,
    headers: HeaderMap,
    Json(rule): Json<Rule>,
) -> ApiResult<Json<Value>> {
    {
        let store = app.store.lock().await;
        check(&store.data, &space)?;
    }
    let expected = headers.get("if-match");
    let absent = headers.get("if-none-match");
    ensure(
        headers.get_all("if-match").iter().count() <= 1
            && headers.get_all("if-none-match").iter().count() <= 1,
        "invalid_request",
    )?;
    ensure(expected.is_none() || absent.is_none(), "invalid_request")?;
    let expected = expected
        .map(|value| {
            let text = value.to_str().map_err(|_| err("invalid_request"))?;
            let revision = text
                .strip_prefix('"')
                .and_then(|value| value.strip_suffix('"'))
                .ok_or_else(|| err("invalid_request"))?;
            ensure(
                revision.len() == 71
                    && revision.starts_with("sha256:")
                    && revision[7..]
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
                "invalid_request",
            )?;
            Ok::<_, Error>(revision.to_owned())
        })
        .transpose()?;
    if let Some(value) = absent {
        ensure(value == "*", "invalid_request")?;
    }
    Ok(Json(
        serde_json::to_value(
            app.update("rule.deployed", |data| {
                let current = data.deployments.get(&rule.id);
                if let Some(expected) = &expected {
                    ensure(
                        current.is_some_and(|value| &value.revision == expected),
                        "revision_conflict",
                    )?;
                } else if absent.is_some() {
                    ensure(current.is_none(), "revision_conflict")?;
                }
                data.deploy(rule)
            })
            .await?,
        )
        .unwrap(),
    ))
}
async fn rule_list(State(app): State<App>, Path(space): Path<String>) -> ApiResult<Json<Value>> {
    let store = app.store.lock().await;
    check(&store.data, &space)?;
    Ok(Json(
        json!({"items":store.data.deployments.values().collect::<Vec<_>>(),"next_cursor":null}),
    ))
}
async fn runs(State(app): State<App>, Path(space): Path<String>) -> ApiResult<Json<Value>> {
    let store = app.store.lock().await;
    check(&store.data, &space)?;
    Ok(Json(
        json!({"items":store.data.runs.values().collect::<Vec<_>>(),"next_cursor":null}),
    ))
}
#[derive(Deserialize)]
struct Cursor {
    #[serde(default)]
    after: i64,
}
async fn events(
    State(app): State<App>,
    Path(space): Path<String>,
    Query(cursor): Query<Cursor>,
) -> ApiResult<Json<Value>> {
    let store = app.store.lock().await;
    check(&store.data, &space)?;
    ensure(cursor.after >= 0, "invalid_cursor")?;
    let items = store.events(cursor.after)?;
    Ok(Json(
        json!({"items":items,"next_cursor":items.last().map(|e|e["event_id"].clone())}),
    ))
}
async fn stream(
    State(app): State<App>,
    Extension(session): Extension<SessionKey>,
    Path(space): Path<String>,
    headers: HeaderMap,
    Query(cursor): Query<Cursor>,
) -> ApiResult<Sse<impl futures_util::Stream<Item = Result<Event, Infallible>>>> {
    let after = headers
        .get("last-event-id")
        .map(|v| {
            v.to_str()
                .ok()
                .and_then(|s| s.parse::<i64>().ok())
                .ok_or_else(|| err("invalid_cursor"))
        })
        .transpose()?
        .unwrap_or(cursor.after);
    let receiver = app.bus.subscribe();
    {
        let store = app.store.lock().await;
        check(&store.data, &space)?;
        ensure(after >= 0, "invalid_cursor")?;
        store.events(after)?;
    }
    let output = futures_util::stream::unfold(
        (app, receiver, after, false, session),
        |(app, mut receiver, mut after, done, session)| async move {
            if done {
                return None;
            }
            loop {
                if !app.auth.active(&session).await {
                    return Some((
                        Ok(Event::default().event("session.expired").data("{}")),
                        (app, receiver, after, true, session),
                    ));
                }
                let entries = app.store.lock().await.events(after);
                match entries {
                    Ok(entries) if !entries.is_empty() => {
                        let entry = &entries[0];
                        after = entry["event_id"].as_i64().unwrap();
                        let event = Event::default()
                            .id(after.to_string())
                            .event(entry["type"].as_str().unwrap())
                            .data(entry.to_string());
                        return Some((Ok(event), (app, receiver, after, false, session)));
                    }
                    Err(error) => {
                        return Some((
                            Ok(Event::default()
                                .event("gap")
                                .data(json!({"error":error.code}).to_string())),
                            (app, receiver, after, true, session),
                        ))
                    }
                    _ => {}
                }
                // 通知可合并或溢出，关键事实始终按耐久游标回读。
                let _ =
                    tokio::time::timeout(std::time::Duration::from_secs(10), receiver.recv()).await;
            }
        },
    );
    Ok(Sse::new(output).keep_alive(axum::response::sse::KeepAlive::default()))
}
