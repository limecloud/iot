use chrono::{Duration as TimeDelta, Utc};
use limeiot_core::{err, protocol::Operation};
use limeiot_dlna::{Adapter, Config, MediaGrant, Stage};
use serde_json::json;
use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    task::JoinHandle,
    time::Instant,
};

struct Renderer {
    config: Config,
    calls: Arc<Mutex<Vec<(String, String)>>>,
    task: JoinHandle<()>,
}
impl Drop for Renderer {
    fn drop(&mut self) {
        self.task.abort();
    }
}
async fn renderer(fault: &'static str) -> Renderer {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let config = Config {
        schema_version: 1,
        target: listener.local_addr().unwrap().to_string().parse().unwrap(),
        description_path: "/description.xml".into(),
        av_transport_path: "/av".into(),
        rendering_control_path: "/render".into(),
        udn: "uuid:test-speaker".into(),
        playback_volume: 10,
        volume_limit: 20,
        timeout_ms: 500,
        managed_media: false,
        media: vec![MediaGrant {
            media_id: "chime".into(),
            url: "http://127.0.0.1:19440/chime.wav".into(),
            expires_at: Utc::now() + TimeDelta::minutes(5),
        }],
    };
    let calls = Arc::new(Mutex::new(vec![]));
    let log = calls.clone();
    let task = tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let mut bytes = vec![];
            let header_end = loop {
                let mut buffer = [0; 2048];
                let count = socket.read(&mut buffer).await.unwrap();
                if count == 0 {
                    break None;
                }
                bytes.extend_from_slice(&buffer[..count]);
                if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                    break Some(end + 4);
                }
                assert!(bytes.len() < 65536);
            };
            let Some(end) = header_end else {
                continue;
            };
            let headers = String::from_utf8(bytes[..end].to_vec()).unwrap();
            let length = headers
                .lines()
                .find_map(|l| {
                    l.to_ascii_lowercase()
                        .strip_prefix("content-length:")
                        .map(|v| v.trim().parse::<usize>().unwrap())
                })
                .unwrap_or(0);
            while bytes.len() < end + length {
                let mut b = [0; 2048];
                let n = socket.read(&mut b).await.unwrap();
                if n == 0 {
                    break;
                }
                bytes.extend_from_slice(&b[..n]);
            }
            let body = String::from_utf8(bytes[end..].to_vec()).unwrap();
            let method = headers.lines().find_map(|l| {
                l.to_ascii_lowercase().starts_with("soapaction:").then(|| {
                    l.split('#')
                        .next_back()
                        .unwrap()
                        .trim_matches('"')
                        .to_owned()
                })
            });
            log.lock()
                .unwrap()
                .push((method.clone().unwrap_or("GET".into()), body));
            let response = if let Some(action) = method {
                if fault == "drop-play" && action == "Play" {
                    continue;
                }
                let service = if action == "SetVolume" {
                    "RenderingControl"
                } else {
                    "AVTransport"
                };
                if fault == "fault-play" && action == "Play" {
                    "<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\"><s:Body><s:Fault/></s:Body></s:Envelope>".into()
                } else {
                    format!("<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\"><s:Body><u:{action}Response xmlns:u=\"urn:schemas-upnp-org:service:{service}:1\"/></s:Body></s:Envelope>")
                }
            } else {
                let udn = if fault == "identity" {
                    "uuid:other"
                } else {
                    "uuid:test-speaker"
                };
                let endpoint = if fault == "endpoint" {
                    "http://169.254.169.254/av"
                } else {
                    "/av"
                };
                let services=format!("<service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>{endpoint}</controlURL></service><service><serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType><controlURL>/render</controlURL></service>");
                if fault == "dtd" {
                    "<!DOCTYPE root [<!ENTITY x 'bad'>]><root>&x;</root>".into()
                } else {
                    format!("<root xmlns=\"urn:schemas-upnp-org:device-1-0\"><device><deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType><UDN>{udn}</UDN><serviceList>{services}</serviceList></device></root>")
                }
            };
            let response = if fault == "oversized" {
                "x".repeat(65537)
            } else {
                response
            };
            let status = if fault == "redirect" {
                "302 Found\r\nLocation: http://127.0.0.1:1/private"
            } else {
                "200 OK"
            };
            let _=socket.write_all(format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",response.len()).as_bytes()).await;
        }
    });
    Renderer {
        config,
        calls,
        task,
    }
}
fn operation(path: &str, value: serde_json::Value) -> Operation {
    serde_json::from_value(json!({"type":"action.invoke","path":path,"value":value})).unwrap()
}
fn play() -> Operation {
    operation("playback.play", json!({"media_id":"chime"}))
}
fn deadline() -> Instant {
    Instant::now() + Duration::from_secs(2)
}

#[tokio::test]
async fn play_is_three_ordered_posts_and_uses_only_the_granted_media() {
    let fake = renderer("").await;
    let adapter = Adapter::new(fake.config.clone()).unwrap();
    assert_eq!(
        adapter.discover(deadline()).await.unwrap().udn,
        fake.config.udn
    );
    assert_eq!(
        adapter
            .execute_authorized(&play(), deadline(), || async { Ok(()) })
            .await
            .stage,
        Stage::Submitted
    );
    let log = fake.calls.lock().unwrap();
    assert_eq!(
        log.iter().map(|v| v.0.as_str()).collect::<Vec<_>>(),
        ["GET", "GET", "SetVolume", "SetAVTransportURI", "Play"]
    );
    assert!(log[2].1.contains("<DesiredVolume>10</DesiredVolume>"));
    assert!(log[3]
        .1
        .contains("<CurrentURI>http://127.0.0.1:19440/chime.wav</CurrentURI>"));
}
#[tokio::test]
async fn volume_and_stop_are_explicit_and_do_not_start_media() {
    let fake = renderer("").await;
    let adapter = Adapter::new(fake.config.clone()).unwrap();
    for op in [
        operation("playback.set_volume", json!({"volume":8})),
        operation("playback.stop", json!({})),
    ] {
        assert_eq!(
            adapter
                .execute_authorized(&op, deadline(), || async { Ok(()) })
                .await
                .stage,
            Stage::Submitted
        );
    }
    assert_eq!(
        fake.calls
            .lock()
            .unwrap()
            .iter()
            .map(|v| v.0.as_str())
            .collect::<Vec<_>>(),
        ["GET", "SetVolume", "GET", "Stop"]
    );
}
#[tokio::test]
async fn invalid_media_expired_grants_and_excess_volume_make_zero_requests() {
    let fake = renderer("").await;
    let mut config = fake.config.clone();
    config.media[0].expires_at = Utc::now() - TimeDelta::seconds(1);
    let adapter = Adapter::new(config).unwrap();
    for (op, code) in [
        (play(), "audio_media_expired"),
        (
            operation("playback.play", json!({"media_id":"other"})),
            "audio_media_forbidden",
        ),
        (
            operation("playback.set_volume", json!({"volume":21})),
            "audio_volume_limit",
        ),
        (
            operation(
                "playback.play",
                json!({"media_id":"chime","url":"http://example.org"}),
            ),
            "invalid_audio_action",
        ),
    ] {
        let result = adapter
            .execute_authorized(&op, deadline(), || async { Ok(()) })
            .await;
        assert_eq!(result.stage, Stage::Rejected);
        assert_eq!(result.error.as_deref(), Some(code));
    }
    assert!(fake.calls.lock().unwrap().is_empty());
}
#[tokio::test]
async fn identity_url_dtd_size_and_redirect_fail_closed_without_posts() {
    for fault in ["identity", "endpoint", "dtd", "oversized", "redirect"] {
        let fake = renderer(fault).await;
        let adapter = Adapter::new(fake.config.clone()).unwrap();
        let result = adapter
            .execute_authorized(&play(), deadline(), || async { Ok(()) })
            .await;
        assert_eq!(result.stage, Stage::Rejected, "{fault}");
        assert_eq!(
            fake.calls
                .lock()
                .unwrap()
                .iter()
                .map(|c| c.0.as_str())
                .collect::<Vec<_>>(),
            ["GET"]
        );
    }
}
#[tokio::test]
async fn failed_authorization_is_zero_posts_and_mid_play_revocation_is_unknown() {
    let fake = renderer("").await;
    let adapter = Adapter::new(fake.config.clone()).unwrap();
    let rejected = adapter
        .execute_authorized(&play(), deadline(), || async { Err(err("forbidden")) })
        .await;
    assert_eq!(rejected.stage, Stage::Rejected);
    assert_eq!(fake.calls.lock().unwrap().len(), 1);
    let count = AtomicUsize::new(0);
    let interrupted = adapter
        .execute_authorized(&play(), deadline(), || async {
            if count.fetch_add(1, Ordering::SeqCst) == 0 {
                Ok(())
            } else {
                Err(err("forbidden"))
            }
        })
        .await;
    assert_eq!(interrupted.stage, Stage::Unknown);
    assert_eq!(
        fake.calls
            .lock()
            .unwrap()
            .iter()
            .map(|v| v.0.as_str())
            .collect::<Vec<_>>(),
        ["GET", "GET", "SetVolume"]
    );
}
#[tokio::test]
async fn lost_or_faulted_play_response_is_unknown_without_retry_or_stop() {
    for fault in ["drop-play", "fault-play"] {
        let fake = renderer(fault).await;
        let adapter = Adapter::new(fake.config.clone()).unwrap();
        assert_eq!(
            adapter
                .execute_authorized(&play(), deadline(), || async { Ok(()) })
                .await
                .stage,
            Stage::Unknown
        );
        assert_eq!(
            fake.calls
                .lock()
                .unwrap()
                .iter()
                .map(|v| v.0.as_str())
                .collect::<Vec<_>>(),
            ["GET", "SetVolume", "SetAVTransportURI", "Play"]
        );
    }
}
#[tokio::test]
async fn already_expired_command_never_probes_or_sends() {
    let fake = renderer("").await;
    let adapter = Adapter::new(fake.config.clone()).unwrap();
    assert_eq!(
        adapter
            .execute_authorized(&play(), Instant::now() - Duration::from_secs(1), || async {
                Ok(())
            })
            .await
            .stage,
        Stage::Rejected
    );
    assert!(fake.calls.lock().unwrap().is_empty());
}
#[tokio::test]
async fn configuration_and_model_cannot_expand_the_adapter_scope() {
    let fake = renderer("").await;
    for address in [
        "http://example.org/media.wav",
        "http://169.254.169.254/media.wav",
        "http://127.0.0.1/media.wav?token=secret",
        "http://127.0.0.1/../private",
        "http://127.0.0.1/%61.wav",
        "https://127.0.0.1/media.wav",
    ] {
        let mut config = fake.config.clone();
        config.media[0].url = address.into();
        assert!(Adapter::new(config).is_err(), "{address}");
    }
    let mut source: serde_json::Value = serde_json::from_slice(include_bytes!(
        "../../../../contracts/models/dlna-speaker.json"
    ))
    .unwrap();
    assert!(limeiot_dlna::supports_model(
        &serde_json::from_value(source.clone()).unwrap()
    ));
    source["services"][0]["actions"][0]["completion"] = json!("observed");
    assert!(!limeiot_dlna::supports_model(
        &serde_json::from_value(source).unwrap()
    ));
}
