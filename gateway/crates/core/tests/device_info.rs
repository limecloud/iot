use chrono::{DateTime, Duration, Utc};
use limeiot_core::{
    engine::{Config, Data},
    protocol::Envelope,
};
use serde_json::{json, Value};

fn now() -> DateTime<Utc> {
    "2026-11-02T00:00:00Z".parse().unwrap()
}
fn packet(data: &Data, kind: &str, seq: u64, body: Value) -> Envelope {
    let device = &data.devices["device-lamp"];
    Envelope {
        v: 1,
        kind: kind.into(),
        message_id: format!("info-{seq}"),
        device_id: device.device_id.clone(),
        model_revision: device.model_revision.clone(),
        boot_id: device.boot_id.clone().or(Some("info-boot".into())),
        seq: Some(seq),
        session_id: device.session_id.clone(),
        body,
    }
}
fn initial() -> Data {
    let config: Config =
        serde_json::from_str(include_str!("../../../../deploy/dev/config.json")).unwrap();
    let mut data = Data::new(config).unwrap();
    let hello = packet(&data, "hello", 1, json!({"challenge":"info-challenge"}));
    data.ingest(hello, now()).unwrap();
    data
}
fn snapshot(data: &Data, seq: u64, revision: u64) -> Envelope {
    packet(
        data,
        "state",
        seq,
        json!({"type":"snapshot","revision":revision,"properties":[
            {"path":"light.power","value":false,"observed_at":now(),"quality":"confirmed","source":"fixture"},
            {"path":"light.brightness","value":0,"observed_at":now(),"quality":"confirmed","source":"fixture"}
        ]}),
    )
}
fn ready() -> Data {
    let mut data = initial();
    data.ingest(snapshot(&data, 2, 1), now()).unwrap();
    data
}
fn info(data: &Data, seq: u64) -> Envelope {
    let vector: Value = serde_json::from_str(include_str!(
        "../../../../contracts/examples/ota-firmware.json"
    ))
    .unwrap();
    packet(
        data,
        "device_info",
        seq,
        vector["request"]["device"].clone(),
    )
}

#[test]
fn report_is_current_session_data_and_does_not_enable_control_or_installation() {
    let mut data = initial();
    data.ingest(info(&data, 2), now()).unwrap();
    assert_eq!(
        data.current_device_info("device-lamp", now())
            .unwrap_err()
            .code,
        "device_offline"
    );
    data.ingest(snapshot(&data, 3, 1), now()).unwrap();
    let report = data.current_device_info("device-lamp", now()).unwrap();
    assert_eq!(report.seq, 2);
    assert_eq!(report.device.firmware_version, "0.1.0");
    assert_eq!(report.received_at, now());
    assert!(data.commands.is_empty());
    assert!(data.devices_view(now())[1]["device_info"]["fresh"]
        .as_bool()
        .unwrap());
}

#[test]
fn stale_or_future_report_is_not_refreshed_by_duplicates_or_other_messages() {
    let mut data = ready();
    let report = info(&data, 3);
    data.ingest(report.clone(), now()).unwrap();
    data.ingest(report, now() + Duration::seconds(4)).unwrap();
    assert!(data
        .current_device_info("device-lamp", now() + Duration::milliseconds(4999))
        .is_ok());
    data.ingest(snapshot(&data, 4, 2), now() + Duration::seconds(5))
        .unwrap();
    assert_eq!(
        data.current_device_info("device-lamp", now() + Duration::seconds(5))
            .unwrap_err()
            .code,
        "device_info_stale"
    );
    assert_eq!(
        data.devices_view(now() + Duration::seconds(5))[1]["device_info"]["fresh"],
        false
    );
    assert_eq!(
        data.devices["device-lamp"]
            .device_info
            .as_ref()
            .unwrap()
            .received_at,
        now()
    );
    let mut fresh = ready();
    fresh.ingest(info(&fresh, 3), now()).unwrap();
    assert!(fresh
        .current_device_info("device-lamp", now() + Duration::milliseconds(4999))
        .is_ok());
    assert!(fresh
        .current_device_info("device-lamp", now() - Duration::milliseconds(1))
        .is_err());
}

#[test]
fn wrong_identity_session_boot_and_sequence_do_not_replace_the_report() {
    let mut data = ready();
    let good = info(&data, 3);
    for field in ["device_id", "model_revision"] {
        let mut bad = good.clone();
        bad.body[field] = if field == "device_id" {
            json!("other")
        } else {
            json!(format!("sha256:{}", "a".repeat(64)))
        };
        assert_eq!(
            data.ingest(bad, now()).unwrap_err().code,
            "device_info_mismatch"
        );
    }
    for field in ["session", "boot"] {
        let mut bad = good.clone();
        if field == "session" {
            bad.session_id = Some("old-session".into());
        } else {
            bad.boot_id = Some("old-boot".into());
        }
        assert_eq!(
            data.ingest(bad, now()).unwrap_err().code,
            "session_mismatch"
        );
    }
    assert!(data.devices["device-lamp"].device_info.is_none());
    data.ingest(good.clone(), now()).unwrap();
    let mut changed = good;
    changed.body["firmware_version"] = json!("0.2.0");
    assert_eq!(
        data.ingest(changed, now()).unwrap_err().code,
        "duplicate_conflict"
    );
    assert_eq!(
        data.current_device_info("device-lamp", now())
            .unwrap()
            .device
            .firmware_version,
        "0.1.0"
    );
}

#[test]
fn missing_null_unknown_fields_and_invalid_device_values_are_rejected_atomically() {
    for (field, value) in [
        ("extra", json!(true)),
        ("battery_percent", json!(101)),
        ("firmware_version", json!("01.0.0")),
        ("bootloader_version", json!("0.0.4294967296")),
        ("protocol_version", json!(2)),
        ("ota_capacity_bytes", json!(0)),
    ] {
        let mut data = ready();
        let mut report = info(&data, 3);
        report.body[field] = value;
        assert!(data.ingest(report, now()).is_err(), "{field}");
        assert_eq!(data.devices["device-lamp"].last_seq, 2);
        assert!(data.devices["device-lamp"].device_info.is_none());
    }
    let mut data = ready();
    let mut report = info(&data, 3);
    report
        .body
        .as_object_mut()
        .unwrap()
        .remove("battery_percent");
    assert_eq!(
        data.ingest(report, now()).unwrap_err().code,
        "invalid_device_info"
    );
}

#[test]
fn reconnect_offline_recovery_and_serialization_discard_old_reports() {
    let mut data = ready();
    data.ingest(info(&data, 3), now()).unwrap();
    let saved = serde_json::to_value(&data).unwrap();
    assert!(saved["devices"]["device-lamp"].get("device_info").is_none());
    let restored: Data = serde_json::from_value(saved).unwrap();
    assert!(restored.current_device_info("device-lamp", now()).is_err());
    let old = info(&data, 4);
    let hello = packet(&data, "hello", 4, json!({"challenge":"new-challenge"}));
    data.ingest(hello, now()).unwrap();
    assert!(data.devices["device-lamp"].device_info.is_none());
    assert_eq!(
        data.ingest(old, now()).unwrap_err().code,
        "session_mismatch"
    );
    data.ingest(snapshot(&data, 5, 1), now()).unwrap();
    data.ingest(info(&data, 6), now()).unwrap();
    data.ingest(
        packet(&data, "availability", 7, json!({"online":false})),
        now(),
    )
    .unwrap();
    assert!(data.devices["device-lamp"].device_info.is_none());
    let mut data = ready();
    data.ingest(info(&data, 3), now()).unwrap();
    data.recover();
    assert!(data.devices["device-lamp"].device_info.is_none());
}

#[test]
fn strict_wire_decoder_rejects_duplicate_keys_oversize_depth_and_unsafe_numbers() {
    let data = ready();
    let report = info(&data, 3);
    let raw = serde_json::to_string(&report).unwrap();
    assert!(Envelope::decode(raw.as_bytes()).is_ok());
    for raw in [
        raw.replacen("\"v\":1", "\"v\":1,\"v\":1", 1),
        raw.replacen(
            "\"battery_percent\":null",
            "\"battery_percent\":null,\"battery_percent\":100",
            1,
        ),
        raw.replace("\"seq\":3", "\"seq\":9007199254740992"),
        raw.replace(
            "\"body\":{",
            &format!("\"body\":{{\"deep\":{}0{},", "[".repeat(17), "]".repeat(17)),
        ),
        " ".repeat(16385),
    ] {
        assert!(Envelope::decode(raw.as_bytes()).is_err());
    }
}
