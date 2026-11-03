//! 管理API与独立局域网媒体出口；下载仅接受短时、目标绑定的路径凭证。
use crate::{api::ApiError, application::App, media_store::Store};
use axum::{
    body::{Body, Bytes},
    extract::{ConnectInfo, DefaultBodyLimit, Path, State},
    http::{header, HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::{DateTime, Utc};
#[cfg(feature = "dlna")]
use limeiot_core::media::Grant;
use limeiot_core::{
    ensure, err, identifier,
    media::{Change, Operation, Receipt, Request, MAX_OBJECT_BYTES},
    Result,
};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    net::{IpAddr, SocketAddr, SocketAddrV4},
    path::PathBuf,
    sync::{Arc, Mutex},
};

#[derive(Clone, Serialize)]
pub struct Pull {
    pub prepared_at: DateTime<Utc>,
    pub method: String,
    pub range_start: usize,
    pub range_end: usize,
    pub status: u16,
}
pub struct Media {
    space_id: String,
    store: Arc<Mutex<Store>>,
    epoch: String,
    #[cfg(feature = "dlna")]
    origin: String,
    authority: String,
    pub listen: SocketAddr,
    pulls: Mutex<BTreeMap<String, Vec<Pull>>>,
}
// 应用层的短时播放凭证；具体协议在集成层转换，媒体服务不依赖DLNA类型。
#[cfg(feature = "dlna")]
pub struct PlaybackGrant {
    pub media_id: String,
    pub url: String,
    pub expires_at: DateTime<Utc>,
}
impl Media {
    pub(crate) async fn work<T: Send + 'static>(
        &self,
        action: impl FnOnce(&mut Store) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let store = self.store.clone();
        tokio::task::spawn_blocking(move || {
            let mut store = store.lock().map_err(|_| err("media_storage_unavailable"))?;
            action(&mut store)
        })
        .await
        .map_err(|_| err("media_storage_unavailable"))?
    }
    #[cfg(feature = "dlna")]
    fn url(&self, grant: &Grant) -> String {
        format!(
            "{}/media/v1/{}/{}.wav",
            self.origin, grant.grant_id, grant.token
        )
    }
    fn operation(&self, operation: &Operation) -> Value {
        let result = match &operation.result {
            Receipt::Granted { grant } => {
                json!({"type":"granted","grant_id":grant.grant_id,"media_id":grant.media_id,"device_id":grant.device_id,"binding_revision":grant.binding_revision,"created_at":grant.created_at,"expires_at":grant.expires_at,"issued_in_process":grant.epoch==self.epoch})
            }
            receipt => serde_json::to_value(receipt).expect("typed media receipt"),
        };
        json!({"space_id":self.space_id,"operation_id":operation.operation_id,"idempotency_key":operation.idempotency_key,"request_digest":operation.request_digest,"kind":operation.kind,"created_at":operation.created_at,"result":result})
    }
    #[cfg(feature = "dlna")]
    pub async fn playback(
        &self,
        media_id: &str,
        device_id: &str,
        revision: &str,
    ) -> Result<PlaybackGrant> {
        let id = media_id.to_owned();
        let device = device_id.to_owned();
        let revision = revision.to_owned();
        let epoch = self.epoch.clone();
        let grant = self
            .work(move |store| {
                let now = store.now()?;
                store.state.active_object(&id, now)?;
                store
                    .state
                    .grants
                    .values()
                    .filter_map(|record| {
                        store.state.grant(&record.grant.grant_id, &epoch, now).ok()
                    })
                    .filter(|g| {
                        g.media_id == id && g.device_id == device && g.binding_revision == revision
                    })
                    .max_by_key(|g| g.created_at)
                    .cloned()
                    .ok_or_else(|| err("audio_media_forbidden"))
            })
            .await?;
        Ok(PlaybackGrant {
            media_id: grant.media_id.clone(),
            url: self.url(&grant),
            expires_at: grant.expires_at,
        })
    }
    #[cfg(feature = "dlna")]
    pub async fn choices(&self, device: &str, revision: &str) -> Result<Vec<Value>> {
        let device = device.to_owned();
        let revision = revision.to_owned();
        let epoch = self.epoch.clone();
        self.work(move |store| {
            let now = store.now()?;
            let mut result = BTreeMap::new();
            for record in store.state.grants.values() {
                if let Ok(grant) = store.state.grant(&record.grant.grant_id, &epoch, now) {
                    if grant.device_id == device && grant.binding_revision == revision {
                        result.insert(
                            grant.media_id.clone(),
                            json!({"media_id":grant.media_id,"expires_at":grant.expires_at}),
                        );
                    }
                }
            }
            Ok(result.into_values().take(32).collect())
        })
        .await
    }
}
pub fn configured(space_id: &str) -> Result<Option<Arc<Media>>> {
    let listen = std::env::var("LIMEIOT_MEDIA_LISTEN");
    let origin = std::env::var("LIMEIOT_MEDIA_ORIGIN");
    if matches!(
        (&listen, &origin),
        (
            Err(std::env::VarError::NotPresent),
            Err(std::env::VarError::NotPresent)
        )
    ) {
        return Ok(None);
    }
    let listen: SocketAddrV4 = listen
        .map_err(|_| err("invalid_media_config"))?
        .parse()
        .map_err(|_| err("invalid_media_config"))?;
    let origin = origin.map_err(|_| err("invalid_media_config"))?;
    let uri = reqwest::Url::parse(&origin).map_err(|_| err("invalid_media_config"))?;
    ensure(
        (listen.ip().is_unspecified() || listen.ip().is_private() || listen.ip().is_loopback())
            && listen.port() != 0
            && uri.scheme() == "http"
            && uri.username().is_empty()
            && uri.password().is_none()
            && uri.path() == "/"
            && uri.query().is_none()
            && uri.fragment().is_none()
            && uri.port_or_known_default() == Some(listen.port())
            && origin == uri.origin().ascii_serialization()
            && uri
                .host_str()
                .and_then(|s| s.parse::<std::net::Ipv4Addr>().ok())
                .is_some_and(|ip| ip.is_private() || ip.is_loopback()),
        "invalid_media_config",
    )?;
    let path = match std::env::var("LIMEIOT_MEDIA_DB") {
        Ok(path) => PathBuf::from(path),
        Err(std::env::VarError::NotPresent) => PathBuf::from(format!(
            "{}.media.json",
            crate::application::setting("LIMEIOT_DB", ".dev/gateway.sqlite")
        )),
        Err(_) => return Err(err("invalid_media_config")),
    };
    ensure(
        path.file_name()
            .and_then(|s| s.to_str())
            .is_some_and(|s| s.ends_with(".media.json")),
        "invalid_media_config",
    )?;
    let core_path = PathBuf::from(crate::application::setting(
        "LIMEIOT_DB",
        ".dev/gateway.sqlite",
    ));
    let canonical = |path: &std::path::Path| -> Result<PathBuf> {
        Ok(path
            .parent()
            .ok_or_else(|| err("invalid_media_config"))?
            .canonicalize()
            .map_err(|_| err("invalid_media_config"))?
            .join(
                path.file_name()
                    .ok_or_else(|| err("invalid_media_config"))?,
            ))
    };
    ensure(
        canonical(&path)? != canonical(&core_path)?,
        "invalid_media_config",
    )?;
    let store = Store::open(&path, space_id)?;
    Ok(Some(Arc::new(Media {
        space_id: space_id.into(),
        store: Arc::new(Mutex::new(store)),
        epoch: limeiot_core::id(),
        authority: uri.authority().to_owned(),
        #[cfg(feature = "dlna")]
        origin,
        listen: SocketAddr::V4(listen),
        pulls: Mutex::new(BTreeMap::new()),
    })))
}
pub fn routes() -> Router<App> {
    Router::new()
        .route("/api/v1/spaces/:space/media", get(list))
        .route(
            "/api/v1/spaces/:space/media-operations",
            post(apply).layer(DefaultBodyLimit::max(
                MAX_OBJECT_BYTES.div_ceil(3) * 4 + 4096,
            )),
        )
        .route(
            "/api/v1/spaces/:space/media-operations/by-key/:key",
            get(resolve),
        )
}
fn service(app: &App) -> Result<Arc<Media>> {
    app.media.clone().ok_or_else(|| err("media_not_configured"))
}
async fn check(app: &App, space: &str) -> Result<()> {
    ensure(app.store.lock().await.data.space_id == space, "forbidden")
}
async fn list(
    State(app): State<App>,
    Path(space): Path<String>,
) -> std::result::Result<Json<Value>, ApiError> {
    check(&app, &space).await?;
    let Some(media) = app.media.clone() else {
        return Ok(Json(
            json!({"space_id":space,"configured":false,"items":[],"grants":[],"next_cursor":null}),
        ));
    };
    let epoch = media.epoch.clone();
    let mut value=media.work(move|store| {
        let now=store.now()?;
        Ok(json!({"space_id":store.state.space_id,"configured":true,"items":store.state.objects.values().map(|o|json!({"metadata":o.metadata,"available":store.state.active_object(&o.metadata.media_id,now).is_ok(),"deleted_at":o.deleted_at})).collect::<Vec<_>>(),
            "grants":store.state.grants.values().map(|r|json!({"grant_id":r.grant.grant_id,"media_id":r.grant.media_id,"device_id":r.grant.device_id,"binding_revision":r.grant.binding_revision,"created_at":r.grant.created_at,"expires_at":r.grant.expires_at,"active_in_process":store.state.grant(&r.grant.grant_id,&epoch,now).is_ok(),"revoked_at":r.revoked_at})).collect::<Vec<_>>(),"next_cursor":null}))
    }).await?;
    for grant in value["grants"].as_array_mut().expect("grants") {
        let current = app
            .integrations
            .media_target(
                &app.store.lock().await.data,
                grant["device_id"].as_str().unwrap_or_default(),
                grant["binding_revision"].as_str().unwrap_or_default(),
            )
            .is_ok();
        grant["binding_current"] = json!(current);
        let pulls = media
            .pulls
            .lock()
            .map_err(|_| err("media_storage_unavailable"))?;
        grant["pulls"] = json!(pulls
            .get(grant["grant_id"].as_str().unwrap_or_default())
            .cloned()
            .unwrap_or_default());
    }
    Ok(Json(value))
}
async fn apply(
    State(app): State<App>,
    Path(space): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> std::result::Result<Json<Value>, ApiError> {
    check(&app, &space).await?;
    let media = service(&app)?;
    ensure(
        headers.get_all("idempotency-key").iter().count() == 1,
        "invalid_idempotency_key",
    )?;
    let key = headers
        .get("idempotency-key")
        .and_then(|v| v.to_str().ok())
        .filter(|v| identifier(v))
        .ok_or_else(|| err("invalid_idempotency_key"))?
        .to_owned();
    ensure(
        headers
            .get("content-type")
            .and_then(|h| h.to_str().ok())
            .is_some_and(|v| v.split(';').next().map(str::trim) == Some("application/json")),
        "invalid_media_change",
    )?;
    let value = limeiot_core::validation::bounded_document(
        &body,
        MAX_OBJECT_BYTES.div_ceil(3) * 4 + 4096,
        5,
        64,
    )
    .ok_or_else(|| err("invalid_media_change"))?;
    let change: Change = serde_json::from_value(value).map_err(|_| err("invalid_media_change"))?;
    let request = Request {
        space_id: space,
        idempotency_key: key,
        change,
    };
    // 原键先核对；恢复历史grant不依赖仍然存在的设备绑定，也不重新授权。
    let digest = limeiot_core::digest(&request)?;
    let original_key = request.idempotency_key.clone();
    let old = media
        .work(move |store| {
            store.ready()?;
            Ok(store.state.operations.get(&original_key).cloned())
        })
        .await?;
    if let Some(old) = old {
        ensure(old.request_digest == digest, "idempotency_conflict")?;
        return Ok(Json(media.operation(&old)));
    }
    let target = if let Change::Grant {
        device_id,
        expected_binding_revision,
        ..
    } = &request.change
    {
        Some(app.integrations.media_target(
            &app.store.lock().await.data,
            device_id,
            expected_binding_revision,
        )?)
    } else {
        None
    };
    let epoch = media.epoch.clone();
    let result = media
        .work(move |store| store.apply(request, target, &epoch, Utc::now()))
        .await?;
    Ok(Json(media.operation(&result)))
}
async fn resolve(
    State(app): State<App>,
    Path((space, key)): Path<(String, String)>,
) -> std::result::Result<Json<Value>, ApiError> {
    check(&app, &space).await?;
    ensure(identifier(&key), "invalid_idempotency_key")?;
    let media = service(&app)?;
    let result = media
        .work(move |store| {
            store.ready()?;
            store
                .state
                .operations
                .get(&key)
                .cloned()
                .ok_or_else(|| err("media_operation_not_found"))
        })
        .await?;
    Ok(Json(media.operation(&result)))
}
fn range(value: &str, length: usize) -> Result<(usize, usize)> {
    ensure(value.len() <= 128, "invalid_media_range")?;
    let value = value
        .strip_prefix("bytes=")
        .ok_or_else(|| err("invalid_media_range"))?;
    let (start, end) = value
        .split_once('-')
        .ok_or_else(|| err("invalid_media_range"))?;
    let number = |s: &str| -> Result<usize> {
        ensure(
            !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()),
            "invalid_media_range",
        )?;
        s.parse().map_err(|_| err("invalid_media_range"))
    };
    if start.is_empty() {
        let suffix = number(end)?;
        ensure(suffix > 0, "invalid_media_range")?;
        return Ok((length.saturating_sub(suffix), length - 1));
    }
    let start = number(start)?;
    let end = if end.is_empty() {
        length - 1
    } else {
        number(end)?.min(length - 1)
    };
    ensure(start < length && start <= end, "invalid_media_range")?;
    Ok((start, end))
}
async fn download(
    State(app): State<App>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path((id, name)): Path<(String, String)>,
    method: Method,
    headers: HeaderMap,
) -> Response {
    let fail = || StatusCode::NOT_FOUND.into_response();
    let Ok(media) = service(&app) else {
        return fail();
    };
    if headers.get(header::HOST).and_then(|v| v.to_str().ok()) != Some(media.authority.as_str())
        || !identifier(&id)
        || name.len() != 68
        || !name.ends_with(".wav")
        || !name
            .bytes()
            .take(64)
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        || headers.contains_key(header::ORIGIN)
    {
        return fail();
    }
    let token = name[..64].to_owned();
    let epoch = media.epoch.clone();
    let key = id.clone();
    let grant = media
        .work(move |store| {
            let now = store.now()?;
            let grant = store.state.grant(&key, &epoch, now)?;
            ensure(
                grant.token == token && IpAddr::V4(grant.source_ip) == peer.ip(),
                "media_not_found",
            )?;
            Ok(grant.clone())
        })
        .await;
    let Ok(grant) = grant else {
        return fail();
    };
    if app
        .integrations
        .media_target(
            &app.store.lock().await.data,
            &grant.device_id,
            &grant.binding_revision,
        )
        .is_err()
    {
        return fail();
    }
    let key = grant.media_id.clone();
    let epoch = media.epoch.clone();
    let grant_id = grant.grant_id.clone();
    let data = media
        .work(move |store| {
            let now = store.now()?;
            store.state.grant(&grant_id, &epoch, now)?;
            let object = store.state.active_object(&key, now)?;
            Ok((
                STANDARD
                    .decode(object.content_base64.as_ref().expect("active content"))
                    .map_err(|_| err("media_storage_corrupt"))?,
                object.metadata.content_digest.clone(),
            ))
        })
        .await;
    let Ok((bytes, digest)) = data else {
        return fail();
    };
    let length = bytes.len();
    let etag = format!("\"{digest}\"");
    let mut response = if headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        == Some(&etag)
    {
        StatusCode::NOT_MODIFIED.into_response()
    } else {
        let accept_range = headers
            .get(header::IF_RANGE)
            .is_none_or(|v| v.to_str().ok() == Some(&etag));
        let requested = if accept_range {
            headers.get(header::RANGE)
        } else {
            None
        };
        let result = match requested {
            Some(header) if headers.get_all(header::RANGE).iter().count() == 1 => header
                .to_str()
                .map_err(|_| err("invalid_media_range"))
                .and_then(|v| range(v, length)),
            Some(_) => Err(err("invalid_media_range")),
            None => Ok((0, length - 1)),
        };
        match result {
            Err(_) => {
                let mut response = StatusCode::RANGE_NOT_SATISFIABLE.into_response();
                response.headers_mut().insert(
                    header::CONTENT_RANGE,
                    format!("bytes */{length}").parse().unwrap(),
                );
                response
            }
            Ok((start, end)) => {
                let status = if requested.is_some() {
                    StatusCode::PARTIAL_CONTENT
                } else {
                    StatusCode::OK
                };
                let mut response = (
                    status,
                    Body::from(if method == Method::HEAD {
                        Vec::new()
                    } else {
                        bytes[start..=end].to_vec()
                    }),
                )
                    .into_response();
                response.headers_mut().insert(
                    header::CONTENT_LENGTH,
                    (end - start + 1).to_string().parse().unwrap(),
                );
                if status == StatusCode::PARTIAL_CONTENT {
                    response.headers_mut().insert(
                        header::CONTENT_RANGE,
                        format!("bytes {start}-{end}/{length}").parse().unwrap(),
                    );
                }
                if let Ok(mut pulls) = media.pulls.lock() {
                    let records = pulls.entry(id).or_default();
                    if records.len() == 16 {
                        records.remove(0);
                    }
                    records.push(Pull {
                        prepared_at: Utc::now(),
                        method: method.to_string(),
                        range_start: start,
                        range_end: end,
                        status: status.as_u16(),
                    });
                }
                response
            }
        }
    };
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, "audio/wav".parse().unwrap());
    headers.insert(header::ACCEPT_RANGES, "bytes".parse().unwrap());
    headers.insert(header::ETAG, etag.parse().unwrap());
    headers.insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    headers.insert("x-content-type-options", "nosniff".parse().unwrap());
    headers.insert("referrer-policy", "no-referrer".parse().unwrap());
    response
}
pub async fn serve(app: App, listener: tokio::net::TcpListener) {
    let router = Router::new()
        .route("/media/v1/:id/:name", get(download))
        .fallback(|| async { StatusCode::NOT_FOUND })
        .with_state(app);
    if axum::serve(
        listener,
        router.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await
    .is_err()
    {
        eprintln!("media_listener_unavailable");
    }
}
pub async fn maintenance(media: Arc<Media>) {
    let mut interval = tokio::time::interval(std::time::Duration::from_secs(30));
    loop {
        interval.tick().await;
        let _ = media.work(|store| store.prune(Utc::now())).await;
    }
}

#[cfg(test)]
mod tests {
    use super::range;
    #[test]
    fn media_range_is_bounded_and_rejects_multiple_or_invalid_ranges() {
        for (value, expected) in [
            ("bytes=0-", (0, 45)),
            ("bytes=10-20", (10, 20)),
            ("bytes=-2", (44, 45)),
            ("bytes=-100", (0, 45)),
            ("bytes=44-99", (44, 45)),
        ] {
            assert_eq!(range(value, 46).unwrap(), expected);
        }
        for value in [
            "bytes=-0",
            "bytes=46-",
            "bytes=20-10",
            "bytes=0-1,3-4",
            "bits=0-1",
            "bytes=+1-2",
            "bytes=1 -2",
            "bytes=-",
            "bytes=999999999999999999999999999999-",
        ] {
            assert!(range(value, 46).is_err(), "{value}");
        }
    }
}
