//! 控制面 HTTP 适配器只允许安装者配置的精确 origin，不转发所有者凭据。
use crate::identity::{Claim, MachineIdentity};
use futures_util::future::BoxFuture;
use limeiot_core::{
    control::{CloudBinding, Review},
    ensure, err, Result,
};
use reqwest::{redirect::Policy, Client, Url};
use serde::{de::DeserializeOwned, Serialize};
use std::{
    net::{IpAddr, SocketAddr},
    path::Path,
    sync::Arc,
    time::Duration,
};
use tokio::sync::Semaphore;

pub trait ControlPlane: Send + Sync {
    fn origins(&self) -> &[String];
    fn review<'a>(
        &'a self,
        origin: &'a str,
        id: &'a str,
        code: &'a str,
    ) -> BoxFuture<'a, Result<Review>>;
    fn claim<'a>(
        &'a self,
        origin: &'a str,
        id: &'a str,
        claim: &'a Claim,
    ) -> BoxFuture<'a, Result<CloudBinding>>;
    fn status<'a>(
        &'a self,
        origin: &'a str,
        id: &'a str,
        claim: &'a Claim,
    ) -> BoxFuture<'a, Result<CloudBinding>>;
}
pub struct ControlAccess {
    pub provider: Arc<dyn ControlPlane>,
    pub identity: MachineIdentity,
    pub slots: Arc<Semaphore>,
    pub network: Arc<ControlNetwork>,
}
struct HttpControl {
    network: Arc<ControlNetwork>,
}
pub struct ControlNetwork {
    origins: Vec<String>,
    ca: Option<reqwest::Certificate>,
    pub ca_pem: Option<Vec<u8>>,
}
pub fn configured() -> std::result::Result<Option<Arc<ControlAccess>>, Box<dyn std::error::Error>> {
    let mut origins: Vec<String> = std::env::var("LIMEIOT_CONTROL_ALLOWED_ORIGINS")
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(String::from)
        .collect();
    if origins.is_empty() {
        return Ok(None);
    }
    origins.sort();
    origins.dedup();
    ensure(origins.len() <= 8, "invalid_control_origins")?;
    for origin in &origins {
        validate_origin(origin)?;
    }
    let path =
        std::env::var("LIMEIOT_GATEWAY_KEY_FILE").map_err(|_| err("machine_identity_required"))?;
    let identity = MachineIdentity::load(Path::new(&path))?;
    let ca_pem = std::env::var("LIMEIOT_CONTROL_CA_FILE")
        .ok()
        .filter(|s| !s.is_empty())
        .map(|p| std::fs::read(p).map_err(|_| err("control_ca_unavailable")))
        .transpose()?;
    let ca = ca_pem
        .as_ref()
        .map(|b| reqwest::Certificate::from_pem(b).map_err(|_| err("control_ca_invalid")))
        .transpose()?;
    let network = Arc::new(ControlNetwork {
        origins,
        ca,
        ca_pem,
    });
    Ok(Some(Arc::new(ControlAccess {
        provider: Arc::new(HttpControl {
            network: network.clone(),
        }),
        network,
        identity,
        slots: Arc::new(Semaphore::new(1)),
    })))
}
fn validate_origin(origin: &str) -> Result<Url> {
    let url = Url::parse(origin).map_err(|_| err("invalid_control_origin"))?;
    let literal = url
        .host_str()
        .and_then(|h| h.trim_matches(['[', ']']).parse::<IpAddr>().ok());
    ensure(
        (url.scheme() == "https"
            || (url.scheme() == "http" && literal.is_some_and(|ip| ip.is_loopback())))
            && url.username().is_empty()
            && url.password().is_none()
            && url.path() == "/"
            && url.query().is_none()
            && url.fragment().is_none()
            && url.as_str().strip_suffix('/') == Some(origin),
        "invalid_control_origin",
    )?;
    Ok(url)
}
impl ControlNetwork {
    pub async fn resolve(&self, origin: &str) -> Result<(Url, Vec<SocketAddr>)> {
        ensure(
            self.origins.iter().any(|v| v == origin),
            "control_origin_not_allowed",
        )?;
        let url = validate_origin(origin)?;
        let host = url
            .host_str()
            .ok_or_else(|| err("invalid_control_origin"))?;
        let port = url
            .port_or_known_default()
            .ok_or_else(|| err("invalid_control_origin"))?;
        let addresses: Vec<SocketAddr> =
            if let Ok(ip) = host.trim_matches(['[', ']']).parse::<IpAddr>() {
                vec![SocketAddr::new(ip, port)]
            } else {
                tokio::time::timeout(
                    Duration::from_secs(2),
                    tokio::net::lookup_host((host, port)),
                )
                .await
                .map_err(|_| err("control_unavailable"))?
                .map_err(|_| err("control_unavailable"))?
                .collect()
            };
        ensure(
            !addresses.is_empty()
                && addresses.len() <= 16
                && addresses.iter().all(|a| {
                    let ip = a.ip();
                    !ip.is_unspecified()
                        && !ip.is_multicast()
                        && match ip {
                            IpAddr::V4(v) => !v.is_link_local() && !v.is_broadcast(),
                            IpAddr::V6(v) => (v.segments()[0] & 0xffc0) != 0xfe80,
                        }
                }),
            "invalid_control_address",
        )?;
        Ok((url, addresses))
    }
}
impl HttpControl {
    async fn client(&self, origin: &str) -> Result<(Client, Url)> {
        let (url, addresses) = self.network.resolve(origin).await?;
        let host = url
            .host_str()
            .ok_or_else(|| err("invalid_control_origin"))?;
        let mut builder = Client::builder()
            .no_proxy()
            .retry(reqwest::retry::never())
            .redirect(Policy::none())
            .connect_timeout(Duration::from_secs(2))
            .timeout(Duration::from_secs(8))
            .resolve_to_addrs(host, &addresses);
        if let Some(ca) = &self.network.ca {
            builder = builder.add_root_certificate(ca.clone())
        };
        let client = builder.build().map_err(|_| err("control_unavailable"))?;
        Ok((client, url))
    }
    async fn post<T: DeserializeOwned>(
        &self,
        origin: &str,
        id: &str,
        action: &str,
        input: &impl Serialize,
    ) -> Result<T> {
        let (client, url) = self.client(origin).await?;
        let url = url
            .join(&format!("/api/pairing/v1/{id}/{action}"))
            .map_err(|_| err("invalid_control_origin"))?;
        let mut response = client
            .post(url)
            .json(input)
            .send()
            .await
            .map_err(|_| err("control_unknown"))?;
        let status = response.status().as_u16();
        if status != 200 {
            return Err(err(match status {
                401 | 403 => "control_identity_rejected",
                404 => "control_not_found",
                409 => "control_conflict",
                410 => "control_pairing_expired",
                429 | 500..=599 => "control_unavailable",
                _ => "control_invalid_response",
            }));
        }
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| err("control_unknown"))? {
            ensure(
                body.len() + chunk.len() <= 16384,
                "control_invalid_response",
            )?;
            body.extend_from_slice(&chunk)
        }
        serde_json::from_slice(&body).map_err(|_| err("control_invalid_response"))
    }
}
impl ControlPlane for HttpControl {
    fn origins(&self) -> &[String] {
        &self.network.origins
    }
    fn review<'a>(
        &'a self,
        origin: &'a str,
        id: &'a str,
        code: &'a str,
    ) -> BoxFuture<'a, Result<Review>> {
        Box::pin(async move {
            self.post(origin, id, "review", &serde_json::json!({"code":code}))
                .await
        })
    }
    fn claim<'a>(
        &'a self,
        origin: &'a str,
        id: &'a str,
        claim: &'a Claim,
    ) -> BoxFuture<'a, Result<CloudBinding>> {
        Box::pin(async move { self.post(origin, id, "claim", claim).await })
    }
    fn status<'a>(
        &'a self,
        origin: &'a str,
        id: &'a str,
        claim: &'a Claim,
    ) -> BoxFuture<'a, Result<CloudBinding>> {
        Box::pin(async move { self.post(origin, id, "status", claim).await })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_exact_secure_origins() {
        for value in [
            "http://192.168.1.1",
            "http://localhost:80",
            "https://iot.example/",
            "https://u:p@iot.example",
            "https://iot.example/a",
            "https://iot.example?x=1",
        ] {
            assert!(validate_origin(value).is_err(), "{value}")
        }
        for value in [
            "https://iot.example",
            "http://127.0.0.1:1234",
            "http://[::1]:1234",
        ] {
            assert!(validate_origin(value).is_ok(), "{value}")
        }
    }
}
