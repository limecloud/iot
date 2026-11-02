//! 出站机器连接独立于浏览器会话；受限动作另经当前本地域授权。
use crate::{application::App, control_client::ControlAccess};
use chrono::{DateTime, Utc};
use futures_util::{SinkExt, StreamExt};
use limeiot_core::{
    control::{hexadecimal, CloudBinding, ControlLink, LinkStatus},
    ensure, err, Result,
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{io::Cursor, sync::Arc, time::Duration};
use tokio::{net::TcpStream, sync::broadcast, time::timeout};
use tokio_tungstenite::{
    client_async_tls_with_config,
    tungstenite::{client::IntoClientRequest, protocol::WebSocketConfig, Message},
    Connector, MaybeTlsStream, WebSocketStream,
};

const PROTOCOL: &str = "limeiot.relay.v1";
type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

#[derive(Clone, Serialize)]
pub struct ConnectionStatus {
    pub enabled: bool,
    pub status: String,
    pub link_id: Option<String>,
    pub binding_revision: Option<String>,
    pub connected_at: Option<DateTime<Utc>>,
    pub error: Option<String>,
}
impl Default for ConnectionStatus {
    fn default() -> Self {
        Self {
            enabled: false,
            status: "disabled".into(),
            link_id: None,
            binding_revision: None,
            connected_at: None,
            error: None,
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Challenge {
    r#type: String,
    control_origin: String,
    connection_id: String,
    challenge: String,
    expires_at: DateTime<Utc>,
}
impl Challenge {
    fn proof(&self, origin: &str, binding: &CloudBinding, now: DateTime<Utc>) -> Result<String> {
        ensure(
            self.r#type == "challenge"
                && self.control_origin == origin
                && self
                    .connection_id
                    .strip_prefix("conn-")
                    .is_some_and(hexadecimal)
                && hexadecimal(&self.challenge)
                && self.expires_at > now
                && self.expires_at <= now + chrono::Duration::seconds(20),
            "relay_invalid_challenge",
        )?;
        Ok([
            "LIMEIOT-CONNECT-1",
            origin,
            &self.connection_id,
            &self.challenge,
            &self.expires_at.timestamp().to_string(),
            &binding.space_id,
            &binding.gateway_id,
            &binding.local_space_id,
            &binding.principal_id,
            &binding.revision,
        ]
        .join("\n"))
    }
}
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum Incoming {
    Request(crate::relay_rpc::Request),
    Ready {
        connection_id: String,
        binding_revision: String,
        heartbeat_seconds: u64,
    },
    Heartbeat {
        connection_id: String,
        sequence: u64,
    },
    Error {
        code: String,
    },
}

pub fn configured(access: Option<&ControlAccess>) -> Result<Option<Arc<rustls::ClientConfig>>> {
    match std::env::var("LIMEIOT_CONTROL_RELAY_ENABLED")
        .unwrap_or_default()
        .as_str()
    {
        "" | "0" => return Ok(None),
        "1" => {}
        _ => return Err(err("invalid_relay_configuration")),
    }
    let access = access.ok_or_else(|| err("control_not_configured"))?;
    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    if let Some(pem) = &access.network.ca_pem {
        let certificates = rustls_pemfile::certs(&mut Cursor::new(pem))
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|_| err("control_ca_invalid"))?;
        ensure(!certificates.is_empty(), "control_ca_invalid")?;
        for certificate in certificates {
            roots
                .add(certificate)
                .map_err(|_| err("control_ca_invalid"))?;
        }
    }
    let config = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(|_| err("relay_tls_invalid"))?
    .with_root_certificates(roots)
    .with_no_client_auth();
    Ok(Some(Arc::new(config)))
}

async fn current(app: &App) -> Option<ControlLink> {
    let access = app.control.as_ref()?;
    let store = app.store.lock().await;
    store
        .data
        .control_links
        .values()
        .find(|link| {
            link.status == LinkStatus::Active
                && link.approved_at.is_some()
                && link.binding.as_ref().is_some_and(|binding| {
                    binding.active
                        && binding.gateway_id == access.identity.gateway_id()
                        && binding.public_key == access.identity.public()
                        && binding.local_space_id == store.data.space_id
                })
        })
        .cloned()
}
async fn still_current(app: &App, link: &ControlLink) -> bool {
    current(app)
        .await
        .is_some_and(|v| v.link_id == link.link_id && v.binding == link.binding)
}
async fn mark(app: &App, status: &str, link: Option<&ControlLink>, error: Option<String>) {
    let mut state = app.connection.write().await;
    *state = ConnectionStatus {
        enabled: true,
        status: status.into(),
        link_id: link.map(|v| v.link_id.clone()),
        binding_revision: link.and_then(|v| v.binding.as_ref().map(|b| b.revision.clone())),
        connected_at: if status == "connected" {
            Some(Utc::now())
        } else {
            None
        },
        error,
    };
}

pub async fn run(app: App, tls: Arc<rustls::ClientConfig>) {
    let mut updates = app.bus.subscribe();
    let mut failures = 0u32;
    loop {
        let Some(link) = current(&app).await else {
            mark(&app, "unpaired", None, None).await;
            tokio::select! { _ = updates.recv() => {}, _ = tokio::time::sleep(Duration::from_secs(1)) => {} }
            failures = 0;
            continue;
        };
        mark(&app, "connecting", Some(&link), None).await;
        let result = session(&app, &link, tls.clone(), &mut updates).await;
        if app.connection.read().await.status == "connected" {
            failures = 0;
        }
        mark(
            &app,
            "disconnected",
            Some(&link),
            result.err().map(|v| v.code),
        )
        .await;
        let seconds = (1u64 << failures.min(5)).min(30);
        failures = failures.saturating_add(1);
        let jitter = (uuid::Uuid::new_v4().as_u128() % 500) as u64;
        let wait = tokio::time::sleep(Duration::from_secs(seconds) + Duration::from_millis(jitter));
        tokio::pin!(wait);
        loop {
            tokio::select! {
                _ = &mut wait => break,
                _ = updates.recv() => if !still_current(&app, &link).await { failures = 0; break; },
            }
        }
    }
}

async fn dial(
    access: &ControlAccess,
    origin: &str,
    tls: Arc<rustls::ClientConfig>,
) -> Result<Socket> {
    timeout(Duration::from_secs(8), async {
        let (mut url, addresses) = access.network.resolve(origin).await?;
        let scheme = if url.scheme() == "https" { "wss" } else { "ws" };
        url.set_scheme(scheme)
            .map_err(|_| err("invalid_control_origin"))?;
        url.set_path("/api/gateway/v1/connect");
        let mut request = url
            .as_str()
            .into_client_request()
            .map_err(|_| err("relay_unavailable"))?;
        request.headers_mut().insert(
            "Sec-WebSocket-Protocol",
            PROTOCOL.parse().map_err(|_| err("relay_unavailable"))?,
        );
        let mut stream = None;
        for address in addresses {
            if let Ok(Ok(value)) =
                timeout(Duration::from_secs(2), TcpStream::connect(address)).await
            {
                stream = Some(value);
                break;
            }
        }
        let stream = stream.ok_or_else(|| err("relay_unavailable"))?;
        let config = WebSocketConfig::default()
            .max_message_size(Some(16384))
            .max_frame_size(Some(16384))
            .max_write_buffer_size(65536)
            .write_buffer_size(0);
        let (socket, response) = client_async_tls_with_config(
            request,
            stream,
            Some(config),
            Some(Connector::Rustls(tls)),
        )
        .await
        .map_err(|_| err("relay_unavailable"))?;
        ensure(
            response
                .headers()
                .get("Sec-WebSocket-Protocol")
                .is_some_and(|v| v == PROTOCOL),
            "relay_protocol_rejected",
        )?;
        Ok(socket)
    })
    .await
    .map_err(|_| err("relay_unavailable"))?
}
async fn send(socket: &mut Socket, value: serde_json::Value) -> Result<()> {
    let text = value.to_string();
    ensure(text.len() <= 16384, "relay_result_too_large")?;
    timeout(
        Duration::from_secs(2),
        socket.send(Message::Text(text.into())),
    )
    .await
    .map_err(|_| err("relay_disconnected"))?
    .map_err(|_| err("relay_disconnected"))
}
async fn read<T: DeserializeOwned>(socket: &mut Socket) -> Result<T> {
    loop {
        match socket.next().await {
            Some(Ok(Message::Text(raw))) => {
                return serde_json::from_str(&raw).map_err(|_| err("relay_invalid_response"))
            }
            Some(Ok(Message::Ping(_))) => socket
                .flush()
                .await
                .map_err(|_| err("relay_disconnected"))?,
            Some(Ok(Message::Pong(_))) => {}
            _ => return Err(err("relay_disconnected")),
        }
    }
}
async fn session(
    app: &App,
    link: &ControlLink,
    tls: Arc<rustls::ClientConfig>,
    updates: &mut broadcast::Receiver<()>,
) -> Result<()> {
    let access = app
        .control
        .as_ref()
        .ok_or_else(|| err("control_not_configured"))?;
    let binding = link
        .binding
        .as_ref()
        .ok_or_else(|| err("control_not_configured"))?;
    let mut socket = dial(access, &link.request.control_origin, tls).await?;
    let challenge: Challenge = timeout(Duration::from_secs(5), read(&mut socket))
        .await
        .map_err(|_| err("relay_invalid_challenge"))??;
    let proof = challenge.proof(&link.request.control_origin, binding, Utc::now())?;
    ensure(
        still_current(app, link).await,
        "relay_local_authorization_changed",
    )?;
    send(&mut socket, serde_json::json!({"type":"authenticate","gateway_id":binding.gateway_id,"space_id":binding.space_id,
        "local_space_id":binding.local_space_id,"principal_id":binding.principal_id,"revision":binding.revision,
        "signature":access.identity.sign_connection(&proof)})).await?;
    let ready: Incoming = timeout(Duration::from_secs(5), read(&mut socket))
        .await
        .map_err(|_| err("relay_disconnected"))??;
    match ready {
        Incoming::Ready {
            connection_id,
            binding_revision,
            heartbeat_seconds,
        } => ensure(
            connection_id == challenge.connection_id
                && binding_revision == binding.revision
                && heartbeat_seconds == 5,
            "relay_invalid_response",
        )?,
        Incoming::Error { code } if code == "machine_already_connected" => {
            return Err(err("relay_already_connected"))
        }
        _ => return Err(err("relay_invalid_response")),
    }
    ensure(
        still_current(app, link).await,
        "relay_local_authorization_changed",
    )?;
    mark(app, "connected", Some(link), None).await;
    let mut ticker = tokio::time::interval(Duration::from_secs(5));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut sequence = 0u64;
    let mut awaiting: Option<(u64, tokio::time::Instant)> = None;
    loop {
        tokio::select! {
            _ = updates.recv() => ensure(still_current(app, link).await, "relay_local_authorization_changed")?,
            _ = ticker.tick() => {
                ensure(awaiting.is_none(),"relay_disconnected")?;
                ensure(still_current(app, link).await, "relay_local_authorization_changed")?;
                sequence = sequence.checked_add(1).ok_or_else(|| err("relay_invalid_response"))?;
                send(&mut socket, serde_json::json!({"type":"heartbeat","connection_id":challenge.connection_id,"sequence":sequence})).await?;
                awaiting=Some((sequence,tokio::time::Instant::now()+Duration::from_secs(3)));
            },
            _ = async { if let Some((_,deadline))=awaiting { tokio::time::sleep_until(deadline).await } else { std::future::pending::<()>().await } } => return Err(err("relay_disconnected")),
            message = socket.next() => match message {
                Some(Ok(Message::Text(text))) => {
                    let incoming:Incoming=serde_json::from_str(&text).map_err(|_|err("relay_invalid_response"))?;
                    match incoming {
                        Incoming::Heartbeat { connection_id,sequence:returned } => {
                            ensure(connection_id==challenge.connection_id && awaiting.is_some_and(|(expected,_)|expected==returned),"relay_invalid_response")?;
                            awaiting=None;
                        }
                        Incoming::Request(request) => {
                            let request_id=request.request_id.clone();
                            let result=crate::relay_rpc::execute(app,link,&challenge.connection_id,request).await;
                            let (value,error)=match result {Ok(value)=>(value,None),Err(error)=>(serde_json::Value::Null,Some(error.code))};
                            let mut response=serde_json::json!({"type":"result","connection_id":challenge.connection_id,"request_id":request_id,"binding_revision":binding.revision,"result":value,"error":error});
                            if response.to_string().len()>16384 { response["result"]=serde_json::Value::Null;response["error"]=serde_json::json!("relay_result_too_large"); }
                            send(&mut socket,response).await?;
                        }
                        _=>return Err(err("relay_invalid_response")),
                    }
                }
                Some(Ok(Message::Ping(_))) => socket.flush().await.map_err(|_| err("relay_disconnected"))?,
                Some(Ok(Message::Pong(_))) => {},
                _ => return Err(err("relay_disconnected")),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD, Engine};
    use ring::signature::Ed25519KeyPair;

    #[test]
    fn connection_proof_matches_node_and_go() {
        let v: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../contracts/examples/control-connection-proof.json"
        ))
        .unwrap();
        let ch: Challenge = serde_json::from_value(v["challenge"].clone()).unwrap();
        let binding: CloudBinding = serde_json::from_value(v["binding"].clone()).unwrap();
        let proof = ch
            .proof(
                &ch.control_origin,
                &binding,
                ch.expires_at - chrono::Duration::seconds(10),
            )
            .unwrap();
        assert_eq!(proof, v["proof"]);
        let seed = v["test_seed_hex"].as_str().unwrap();
        let seed: Vec<u8> = (0..seed.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&seed[i..i + 2], 16).unwrap())
            .collect();
        let key = Ed25519KeyPair::from_seed_unchecked(&seed).unwrap();
        assert_eq!(
            STANDARD.encode(key.sign(proof.as_bytes()).as_ref()),
            v["signature"]
        );
        assert!(ch
            .proof(
                "https://other.example",
                &binding,
                ch.expires_at - chrono::Duration::seconds(10)
            )
            .is_err());
        assert!(ch
            .proof(&ch.control_origin, &binding, ch.expires_at)
            .is_err());
        assert!(ch
            .proof(
                &ch.control_origin,
                &binding,
                ch.expires_at - chrono::Duration::seconds(21)
            )
            .is_err());
    }
}
