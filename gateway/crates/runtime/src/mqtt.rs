//! MQTT 5 传输适配器，核心只接收自己的 Envelope。
use crate::{
    application::{setting, App},
    store::Store,
};
use chrono::{DateTime, Utc};
use limeiot_core::protocol::{Envelope, MAX_PACKET};
use rumqttc::v5::{
    mqttbytes::{v5::Packet, QoS},
    AsyncClient, Event, EventLoop, MqttOptions,
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
    let (client, eventloop) = AsyncClient::new(options, 32);
    // 接收和派发由同一父future拥有；取消父任务时两者一起释放，不留下游离派发器。
    tokio::select! {
        _ = dispatch(app.clone(), client.clone(), space.clone()) => {},
        _ = receive(app, client, space, eventloop) => {},
    }
}

async fn receive(app: App, client: AsyncClient, space: String, mut eventloop: EventLoop) {
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
                let is_event = message.kind == "event";
                let mut response = None;
                let accepted = app
                    .update(&kind, |data| {
                        let ingested =
                            data.ingest_with_event_projection(message, chrono::Utc::now())?;
                        let output = if is_event {
                            serde_json::to_value(ingested.event)
                        } else {
                            // 非事件仍保留原有输出形状；响应只在数据库提交成功后发送。
                            serde_json::to_value(&ingested.response)
                        }
                        .map_err(|_| limeiot_core::err("invalid_json"))?;
                        response = ingested.response;
                        Ok(output)
                    })
                    .await
                    .map(|_| response);
                match accepted {
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
        let messages = pending_messages(&mut *app.store.lock().await, Utc::now());
        if let Ok(messages) = messages {
            let _ = app.bus.send(());
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

pub(crate) fn pending_messages(
    store: &mut Store,
    now: DateTime<Utc>,
) -> limeiot_core::Result<Vec<Envelope>> {
    // 定时受理失败不能阻塞已有命令；每个事务仍须先耐久提交才公布结果。
    if let Err(error) = store.update("rules.scheduled", |data| data.poll_schedules(now)) {
        eprintln!(
            "{}",
            serde_json::json!({"event":"rules.schedule_failed","error":error.code})
        );
    }
    store.update("commands.transitioned", |data| {
        let mut messages = data.prepare_dispatch(now);
        messages.extend(data.prepare_ota_dispatch(now));
        Ok(messages)
    })
}
