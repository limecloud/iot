//! 本地模型HTTP出口：逐次验证并固定全部地址，不代理、不跳转、不重试。
use limeiot_core::{ensure, err, Result};
use reqwest::{Client, Url};
use std::{
    net::{IpAddr, SocketAddr},
    time::Duration,
};
fn private(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => ip.is_loopback() || ip.is_private(),
        IpAddr::V6(ip) => {
            ip.is_loopback()
                || ip
                    .to_ipv4_mapped()
                    .is_some_and(|ip| ip.is_loopback() || ip.is_private())
                || ip.segments()[0] & 0xfe00 == 0xfc00
        }
    }
}
pub async fn client(origin: &Url, ca: Option<&reqwest::Certificate>, kind: &str) -> Result<Client> {
    let unavailable = || err(&format!("{kind}_provider_unavailable"));
    let host = origin.host_str().ok_or_else(unavailable)?;
    let port = origin.port_or_known_default().ok_or_else(unavailable)?;
    let addresses: Vec<SocketAddr> = if let Ok(ip) = host.trim_matches(['[', ']']).parse::<IpAddr>()
    {
        vec![SocketAddr::new(ip, port)]
    } else {
        tokio::time::timeout(
            Duration::from_secs(2),
            tokio::net::lookup_host((host, port)),
        )
        .await
        .map_err(|_| unavailable())?
        .map_err(|_| unavailable())?
        .collect()
    };
    ensure(
        !addresses.is_empty() && addresses.iter().all(|address| private(address.ip())),
        &format!("{kind}_origin_not_local"),
    )?;
    let mut builder = Client::builder()
        .no_proxy()
        .retry(reqwest::retry::never())
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(90))
        .resolve_to_addrs(host, &addresses);
    if let Some(ca) = ca {
        builder = builder.add_root_certificate(ca.clone());
    }
    builder.build().map_err(|_| unavailable())
}
