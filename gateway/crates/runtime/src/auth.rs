//! 本地所有者会话适配器。会话不跨进程恢复，重启后需重新登录。
use crate::{api::ApiError, application::App};
use axum::{
    extract::{Request, State},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode, Uri},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use limeiot_core::err;
use serde::Deserialize;
use serde_json::json;
use std::{
    collections::{HashMap, VecDeque},
    time::{Duration, Instant},
};
use subtle::ConstantTimeEq;
use tokio::sync::Mutex;

const SESSION_SECONDS: u64 = 8 * 60 * 60;

struct Session {
    csrf: String,
    deadline: Instant,
    expires_at: chrono::DateTime<chrono::Utc>,
}
#[derive(Default)]
struct Sessions {
    items: HashMap<String, Session>,
    failures: VecDeque<Instant>,
}
pub struct BrowserAuth {
    origin: String,
    authority: String,
    secure: bool,
    sessions: Mutex<Sessions>,
}
#[derive(Clone)]
pub struct SessionKey(pub Option<String>);

impl BrowserAuth {
    pub fn new(origin: &str, loopback: bool) -> Result<Self, Box<dyn std::error::Error>> {
        let uri: Uri = origin.parse()?;
        let scheme = uri.scheme_str().ok_or("public origin requires scheme")?;
        let authority = uri.authority().ok_or("public origin requires host")?;
        let local = matches!(uri.host(), Some("127.0.0.1" | "localhost" | "[::1]"));
        if !matches!(scheme, "http" | "https")
            || uri.path() != "/"
            || uri.query().is_some()
            || authority.as_str().contains('@')
            || (scheme != "https" && !(loopback && local))
            || origin != format!("{scheme}://{authority}")
        {
            return Err(
                "public origin must be exact HTTPS origin (loopback HTTP for development)".into(),
            );
        }
        Ok(Self {
            origin: origin.into(),
            authority: authority.as_str().into(),
            secure: scheme == "https",
            sessions: Mutex::new(Sessions::default()),
        })
    }
    fn cookie_name(&self) -> &str {
        if self.secure {
            "__Host-limeiot_session"
        } else {
            "limeiot_session"
        }
    }
    fn cookie(&self, headers: &HeaderMap) -> Option<String> {
        let mut values = headers
            .get_all(header::COOKIE)
            .iter()
            .filter_map(|v| v.to_str().ok())
            .flat_map(|v| v.split(';'))
            .filter_map(|v| v.trim().split_once('='))
            .filter(|(name, _)| *name == self.cookie_name())
            .map(|(_, value)| value);
        let value = values.next()?;
        if value.len() != 64 || values.next().is_some() {
            return None;
        }
        Some(value.into())
    }
    fn set_cookie(&self, value: &str, age: u64) -> HeaderValue {
        HeaderValue::from_str(&format!(
            "{}={value}; Path=/; HttpOnly; SameSite=Strict; Max-Age={age}{}",
            self.cookie_name(),
            if self.secure { "; Secure" } else { "" }
        ))
        .expect("generated cookie")
    }
    fn same_origin(&self, headers: &HeaderMap) -> bool {
        headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) == Some(&self.origin)
    }
    pub async fn active(&self, key: &SessionKey) -> bool {
        match &key.0 {
            None => true,
            Some(key) => self
                .sessions
                .lock()
                .await
                .items
                .get(key)
                .is_some_and(|session| session.deadline > Instant::now()),
        }
    }
}
fn secret() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}
fn denied(code: &str) -> Response {
    ApiError(err(code)).into_response()
}

// Host 白名单防止 DNS rebinding；不信任客户端提供的 Forwarded 头。
pub async fn boundary(State(app): State<App>, request: Request, next: Next) -> Response {
    let headers = request.headers();
    let authority = request
        .uri()
        .authority()
        .map(|v| v.as_str())
        .or_else(|| headers.get(header::HOST).and_then(|v| v.to_str().ok()));
    let rejected = authority != Some(app.auth.authority.as_str())
        || headers
            .get("sec-fetch-site")
            .is_some_and(|v| v == "cross-site")
        || (headers.contains_key(header::ORIGIN) && !app.auth.same_origin(headers));
    let private = request.uri().path().starts_with("/api/") || request.uri().path() == "/healthz";
    let mut response = if rejected {
        denied("forbidden")
    } else {
        next.run(request).await
    };
    let headers = response.headers_mut();
    if private {
        headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    }
    headers.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    headers.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    headers.insert("content-security-policy", HeaderValue::from_static("default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"));
    response
}
pub async fn authorize(State(app): State<App>, mut request: Request, next: Next) -> Response {
    let headers = request.headers();
    if let Some(auth) = headers.get(header::AUTHORIZATION) {
        let expected = format!("Bearer {}", app.token);
        if headers.contains_key(header::ORIGIN) {
            return denied("forbidden");
        }
        if !bool::from(auth.as_bytes().ct_eq(expected.as_bytes())) {
            return denied("unauthenticated");
        }
        request.extensions_mut().insert(SessionKey(None));
    } else {
        let Some(key) = app.auth.cookie(headers) else {
            return denied("unauthenticated");
        };
        let sessions = app.auth.sessions.lock().await;
        let Some(session) = sessions
            .items
            .get(&key)
            .filter(|s| s.deadline > Instant::now())
        else {
            return denied("unauthenticated");
        };
        if !matches!(*request.method(), Method::GET | Method::HEAD) {
            let csrf = headers
                .get("x-csrf-token")
                .map(|v| v.as_bytes())
                .unwrap_or_default();
            if !app.auth.same_origin(headers) || !bool::from(csrf.ct_eq(session.csrf.as_bytes())) {
                return denied("forbidden");
            }
        }
        drop(sessions);
        request.extensions_mut().insert(SessionKey(Some(key)));
    }
    next.run(request).await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Login {
    token: String,
}
pub async fn login(
    State(app): State<App>,
    headers: HeaderMap,
    Json(input): Json<Login>,
) -> Response {
    if !app.auth.same_origin(&headers) {
        return denied("forbidden");
    }
    let now = Instant::now();
    let mut sessions = app.auth.sessions.lock().await;
    sessions
        .failures
        .retain(|at| now.duration_since(*at) < Duration::from_secs(60));
    if sessions.failures.len() >= 5 {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            [(header::RETRY_AFTER, "60")],
            Json(json!({"error":{"code":"rate_limited"}})),
        )
            .into_response();
    }
    if input.token.len() > 1024 || !bool::from(input.token.as_bytes().ct_eq(app.token.as_bytes())) {
        sessions.failures.push_back(now);
        return denied("unauthenticated");
    }
    sessions.items.retain(|_, s| s.deadline > now);
    if let Some(old) = app.auth.cookie(&headers) {
        sessions.items.remove(&old);
    }
    if sessions.items.len() >= 32 {
        return denied("session_capacity");
    }
    let key = secret();
    let session = Session {
        csrf: secret(),
        deadline: now + Duration::from_secs(SESSION_SECONDS),
        expires_at: chrono::Utc::now() + chrono::Duration::seconds(SESSION_SECONDS as i64),
    };
    let value =
        json!({"authenticated":true,"csrf_token":session.csrf,"expires_at":session.expires_at});
    sessions.items.insert(key.clone(), session);
    (
        [(
            header::SET_COOKIE,
            app.auth.set_cookie(&key, SESSION_SECONDS),
        )],
        Json(value),
    )
        .into_response()
}
pub async fn session(State(app): State<App>, headers: HeaderMap) -> Response {
    let Some(key) = app.auth.cookie(&headers) else {
        return denied("unauthenticated");
    };
    let sessions = app.auth.sessions.lock().await;
    match sessions
        .items
        .get(&key)
        .filter(|s| s.deadline > Instant::now())
    {
        Some(session) => Json(
            json!({"authenticated":true,"csrf_token":session.csrf,"expires_at":session.expires_at}),
        )
        .into_response(),
        None => denied("unauthenticated"),
    }
}
pub async fn logout(State(app): State<App>, headers: HeaderMap) -> Response {
    let Some(key) = app.auth.cookie(&headers) else {
        return denied("unauthenticated");
    };
    let mut sessions = app.auth.sessions.lock().await;
    if let Some(session) = sessions.items.get(&key) {
        let csrf = headers
            .get("x-csrf-token")
            .map(|v| v.as_bytes())
            .unwrap_or_default();
        if !app.auth.same_origin(&headers) || !bool::from(csrf.ct_eq(session.csrf.as_bytes())) {
            return denied("forbidden");
        }
    } else {
        return denied("unauthenticated");
    }
    sessions.items.remove(&key);
    let _ = app.bus.send(());
    (
        [(header::SET_COOKIE, app.auth.set_cookie("", 0))],
        StatusCode::NO_CONTENT,
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn remote_listener_requires_exact_https_origin() {
        for origin in [
            "http://nas.local",
            "https://nas.local/",
            "https://nas.local/path",
            "https://nas.local?x=1",
            "https://user@nas.local",
            "http://127.0.0.1",
        ] {
            assert!(BrowserAuth::new(origin, false).is_err(), "{origin}");
        }
        assert!(BrowserAuth::new("https://nas.local:8443", false).is_ok());
        assert!(BrowserAuth::new("http://127.0.0.1:17880", true).is_ok());
    }
}
