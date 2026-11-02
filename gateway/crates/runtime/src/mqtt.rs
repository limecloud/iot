//! MQTT 5 传输适配器，核心只接收自己的 Envelope。
use crate::application::{setting, App};
use limeiot_core::protocol::{Envelope, MAX_PACKET};
use rumqttc::v5::{
    mqttbytes::{v5::Packet, QoS},
    AsyncClient, Event, MqttOptions,
};
use std::{sync::atomic::Ordering, time::Duration};

pub async fn run(app: App) {
    let space = app.store.lock().await.data.space_id.clone();
    let host = setting("LIMEIOT_MQTT_HOST", "127.0.0.1");
    if host != "127.0.0.1" && host != "localhost" {
        eprintln!("{{\"error\":\"only_loopback_mqtt_supported\"}}");
        return;
    }
    let port = setting("LIMEIOT_MQTT_PORT", "18884")
        .parse()
        .unwrap_or(18884);
    let mut options = MqttOptions::new(
        format!("limeiot-gateway-{}", limeiot_core::id()),
        host,
        port,
    );
    options.set_keep_alive(Duration::from_secs(5));
    options.set_max_packet_size(Some((MAX_PACKET + 512) as u32));
    options.set_credentials("gateway", setting("LIMEIOT_MQTT_PASSWORD", ""));
    let (client, mut eventloop) = AsyncClient::new(options, 32);
    let _dispatcher = tokio::spawn(dispatch(app.clone(), client.clone(), space.clone()));
    loop {
        match eventloop.poll().await {
            Ok(Event::Incoming(Packet::ConnAck(_))) => {
                if client
                    .subscribe(format!("limeiot/v1/{space}/+/up/+"), QoS::AtLeastOnce)
                    .await
                    .is_ok()
                {
                    app.broker.store(true, Ordering::Relaxed);
                }
            }
            Ok(Event::Incoming(Packet::Publish(packet))) => {
                if packet.retain || packet.payload.len() > MAX_PACKET {
                    continue;
                }
                let Ok(topic) = std::str::from_utf8(&packet.topic) else {
                    continue;
                };
                let Ok(message) = Envelope::decode(&packet.payload) else {
                    continue;
                };
                let expected = format!(
                    "limeiot/v1/{space}/{}/up/{}",
                    message.device_id, message.kind
                );
                if topic != expected {
                    continue;
                }
                let kind = format!("device.{}", message.kind);
                match app
                    .update(&kind, |data| data.ingest(message, chrono::Utc::now()))
                    .await
                {
                    Ok(Some(response)) => {
                        let topic = format!(
                            "limeiot/v1/{space}/{}/down/{}",
                            response.device_id, response.kind
                        );
                        if let Ok(bytes) = serde_json::to_vec(&response) {
                            let _ = client.publish(topic, QoS::AtLeastOnce, false, bytes).await;
                        }
                    }
                    Ok(None) => {}
                    Err(error) => eprintln!(
                        "{}",
                        serde_json::json!({"event":"mqtt.rejected","code":error.code})
                    ),
                }
            }
            Err(_) => {
                if app.broker.swap(false, Ordering::Relaxed) {
                    let _ = app
                        .update("broker.disconnected", |data| {
                            data.mqtt_disconnected();
                            Ok(())
                        })
                        .await;
                }
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
            _ => {}
        }
    }
}
async fn dispatch(app: App, client: AsyncClient, space: String) {
    let mut interval = tokio::time::interval(Duration::from_millis(50));
    loop {
        interval.tick().await;
        if !app.broker.load(Ordering::Relaxed) {
            continue;
        }
        // 发送意图先耐久提交。崩溃后只能查询原操作，不能自动重发。
        let messages = app
            .update("commands.transitioned", |data| {
                let now = chrono::Utc::now();
                let mut messages = data.prepare_dispatch(now);
                messages.extend(data.prepare_ota_dispatch(now));
                Ok(messages)
            })
            .await;
        if let Ok(messages) = messages {
            for message in messages {
                let topic = format!(
                    "limeiot/v1/{space}/{}/down/{}",
                    message.device_id, message.kind
                );
                if let Ok(bytes) = serde_json::to_vec(&message) {
                    let _ = client.publish(topic, QoS::AtLeastOnce, false, bytes).await;
                }
            }
        }
    }
}
