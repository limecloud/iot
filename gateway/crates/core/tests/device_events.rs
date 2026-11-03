use chrono::{DateTime, Duration, Utc};
use limeiot_core::{
    engine::{Config, Data},
    protocol::Envelope,
};
use serde_json::{json, Value};

fn now() -> DateTime<Utc> {
    "2026-11-03T00:00:00Z".parse().unwrap()
}
fn message(data: &Data, kind: &str, seq: u64, body: Value) -> Envelope {
    serde_json::from_value(
        json!({"v":1,"kind":kind,"message_id":format!("message-{seq}"),
        "device_id":"device-button","model_revision":data.devices["device-button"].model_revision,
        "boot_id":"boot-button","session_id":data.devices["device-button"].session_id,
        "seq":seq,"body":body}),
    )
    .unwrap()
}
fn ready() -> Data {
    let config: Config =
        serde_json::from_str(include_str!("../../../../deploy/dev/config.json")).unwrap();
    let mut data = Data::new(config).unwrap();
    let hello = message(&data, "hello", 1, json!({"challenge":"challenge-events"}));
    let result = data.ingest_with_event_projection(hello, now()).unwrap();
    assert!(result.event.is_none());
    assert_eq!(result.response.unwrap().kind, "welcome");
    let state = message(
        &data,
        "state",
        2,
        json!({"type":"snapshot","revision":1,"properties":[]}),
    );
    assert!(data
        .ingest_with_event_projection(state, now())
        .unwrap()
        .event
        .is_none());
    data
}
fn event(data: &Data, seq: u64, id: &str) -> Envelope {
    message(
        data,
        "event",
        seq,
        json!({"event_id":id,"path":"button.pressed","occurred_at":now(),
        "historical":false,"data":{"count":1},"untrusted_extra":"must-not-be-persisted"}),
    )
}

#[test]
fn accepted_event_has_exact_identity_times_and_model_data_without_transport_extras() {
    let mut data = ready();
    let original = event(&data, 3, "touch-1");
    let accepted = data
        .ingest_with_event_projection(original.clone(), now())
        .unwrap();
    assert!(accepted.response.is_none());
    let projected = serde_json::to_value(accepted.event.unwrap()).unwrap();
    assert_eq!(
        projected,
        json!({
            "device_id":original.device_id,"model_revision":original.model_revision,
            "boot_id":original.boot_id,"session_id":original.session_id,
            "message_id":original.message_id,"seq":3,"event_id":"touch-1",
        "path":"button.pressed","occurred_at":now(),"received_at":now(),
        "body_digest":limeiot_core::digest(&original.body).unwrap(),"data":{"count":1}
        })
    );
    assert!(!projected.to_string().contains("must-not-be-persisted"));
}

#[test]
fn original_fraction_and_timezone_text_survive_projection_without_changing_body_digest() {
    for timestamp in ["2026-11-03T00:00:00.000Z", "2026-11-03T08:00:00+08:00"] {
        let mut data = ready();
        let mut original = event(&data, 3, "lexical-time");
        original.body["occurred_at"] = json!(timestamp);
        let digest = limeiot_core::digest(&original.body).unwrap();
        let projected = data
            .ingest_with_event_projection(original, now())
            .unwrap()
            .event
            .unwrap();
        assert_eq!(projected.occurred_at, timestamp);
        assert_eq!(projected.parsed_occurrence().unwrap(), now());
        assert_eq!(projected.body_digest, digest);
    }
}

#[test]
fn duplicate_envelopes_and_business_events_do_not_reappear_even_after_recovery() {
    let mut data = ready();
    let original = event(&data, 3, "touch-once");
    assert!(data
        .ingest_with_event_projection(original.clone(), now())
        .unwrap()
        .event
        .is_some());
    assert!(data
        .ingest_with_event_projection(original.clone(), now())
        .unwrap()
        .event
        .is_none());
    let duplicate = event(&data, 4, "touch-once");
    assert!(data
        .ingest_with_event_projection(duplicate, now())
        .unwrap()
        .event
        .is_none());
    let mut restored: Data = serde_json::from_value(serde_json::to_value(&data).unwrap()).unwrap();
    restored.recover();
    let state = message(
        &restored,
        "state",
        5,
        json!({"type":"snapshot","revision":2,"properties":[]}),
    );
    restored.ingest_with_event_projection(state, now()).unwrap();
    let duplicate = event(&restored, 6, "touch-once");
    assert!(restored
        .ingest_with_event_projection(duplicate, now())
        .unwrap()
        .event
        .is_none());
}

#[test]
fn historical_and_expired_events_remain_deduplicated_without_live_projection() {
    for (id, historical, occurred) in [
        ("historical", true, now()),
        ("stale", false, now() - Duration::seconds(6)),
    ] {
        let mut data = ready();
        let mut input = event(&data, 3, id);
        input.body["historical"] = json!(historical);
        input.body["occurred_at"] = json!(occurred);
        assert!(data
            .ingest_with_event_projection(input, now())
            .unwrap()
            .event
            .is_none());
        assert!(data.event_ids.contains_key(&format!("device-button:{id}")));
    }
}

#[test]
fn invalid_schema_session_model_sequence_and_future_events_never_return_a_projection() {
    for kind in [
        "schema", "session", "model", "sequence", "future", "conflict",
    ] {
        let mut data = ready();
        let mut input = event(&data, 3, "invalid-event");
        match kind {
            "schema" => input.body["data"] = json!({"count":0,"private":"secret"}),
            "session" => input.session_id = Some("wrong-session".into()),
            "model" => input.model_revision = format!("sha256:{}", "0".repeat(64)),
            "sequence" => input.seq = Some(1),
            "future" => input.body["occurred_at"] = json!(now() + Duration::seconds(3)),
            "conflict" => {
                let original = event(&data, 3, "invalid-event");
                data.ingest_with_event_projection(original, now()).unwrap();
                input.seq = Some(4);
                input.message_id = "different-content".into();
                input.body["data"] = json!({"count":2});
            }
            _ => unreachable!(),
        }
        assert!(
            data.ingest_with_event_projection(input, now()).is_err(),
            "{kind}"
        );
    }
}
