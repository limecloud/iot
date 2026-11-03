use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::{DateTime, Duration, Utc};
use limeiot_core::media::*;

fn now() -> DateTime<Utc> {
    "2026-11-03T00:00:00Z".parse().unwrap()
}
fn audio() -> Vec<u8> {
    let mut data = vec![];
    data.extend(b"RIFF");
    data.extend(38u32.to_le_bytes());
    data.extend(b"WAVEfmt ");
    data.extend(16u32.to_le_bytes());
    data.extend(1u16.to_le_bytes());
    data.extend(1u16.to_le_bytes());
    data.extend(8000u32.to_le_bytes());
    data.extend(16000u32.to_le_bytes());
    data.extend(2u16.to_le_bytes());
    data.extend(16u16.to_le_bytes());
    data.extend(b"data");
    data.extend(2u32.to_le_bytes());
    data.extend(0i16.to_le_bytes());
    data
}
fn request(key: &str, change: Change) -> Request {
    Request {
        space_id: "home".into(),
        idempotency_key: key.into(),
        change,
    }
}
fn upload() -> Change {
    Change::Upload {
        content_base64: STANDARD.encode(audio()),
        retain_seconds: 60,
    }
}
fn uploaded(state: &mut State) -> String {
    match state
        .apply(request("upload", upload()), None, "process", now())
        .unwrap()
        .result
    {
        Receipt::Uploaded { media } => media.media_id,
        _ => panic!(),
    }
}
fn grant(state: &mut State, id: &str, key: &str) -> Grant {
    match state
        .apply(
            request(
                key,
                Change::Grant {
                    media_id: id.into(),
                    device_id: "speaker".into(),
                    expected_binding_revision: format!("sha256:{}", "a".repeat(64)),
                    valid_for_seconds: 10,
                },
            ),
            Some(GrantTarget {
                device_id: "speaker".into(),
                binding_revision: format!("sha256:{}", "a".repeat(64)),
                source_ip: "127.0.0.1".parse().unwrap(),
            }),
            "process",
            now(),
        )
        .unwrap()
        .result
    {
        Receipt::Granted { grant } => grant,
        _ => panic!(),
    }
}
#[test]
fn wav_validates_complete_finite_pcm_without_decoders() {
    let bytes = audio();
    let format = wav(&bytes).unwrap();
    assert_eq!(format.frames, 1);
    assert_eq!(format.sample_rate, 8000);
    for (index, value) in [(0, b'X'), (4, 0), (20, 3), (22, 0), (34, 8), (40, 0)] {
        let mut bad = bytes.clone();
        bad[index] = value;
        assert!(wav(&bad).is_err(), "{index}");
    }
    for length in 0..bytes.len() {
        assert!(wav(&bytes[..length]).is_err());
    }
    let mut extra = bytes.clone();
    extra.extend(b"private");
    assert!(wav(&extra).is_err());
}
#[test]
fn original_upload_and_conflict_never_create_duplicate_objects() {
    let mut state = State::new("home".into(), now());
    let first = state
        .apply(request("upload", upload()), None, "process", now())
        .unwrap();
    let restored = state
        .apply(
            request("upload", upload()),
            None,
            "new-process",
            now() + Duration::seconds(1),
        )
        .unwrap();
    assert_eq!(first.operation_id, restored.operation_id);
    assert_eq!(state.objects.len(), 1);
    let mut different = upload();
    if let Change::Upload { retain_seconds, .. } = &mut different {
        *retain_seconds = 90;
    }
    assert_eq!(
        state
            .apply(request("upload", different), None, "process", now())
            .unwrap_err()
            .code,
        "idempotency_conflict"
    );
    state.validate().unwrap();
}
#[test]
fn malformed_upload_does_not_admit_object_or_operation() {
    for change in [
        Change::Upload {
            content_base64: "invalid".into(),
            retain_seconds: 60,
        },
        Change::Upload {
            content_base64: STANDARD.encode(audio()),
            retain_seconds: 1,
        },
        Change::Upload {
            content_base64: STANDARD.encode(b"not wav"),
            retain_seconds: 60,
        },
    ] {
        let mut state = State::new("home".into(), now());
        assert!(state
            .apply(request("bad", change), None, "process", now())
            .is_err());
        assert!(state.objects.is_empty());
        assert!(state.operations.is_empty());
    }
}
#[test]
fn grant_expiry_epoch_and_original_recovery_never_resurrect_permission() {
    let mut state = State::new("home".into(), now());
    let id = uploaded(&mut state);
    let grant = grant(&mut state, &id, "grant");
    assert!(state.grant(&grant.grant_id, "process", now()).is_ok());
    assert!(state.grant(&grant.grant_id, "new-process", now()).is_err());
    assert!(state
        .grant(&grant.grant_id, "process", now() + Duration::seconds(10))
        .is_err());
    state
        .apply(
            request(
                "revoke",
                Change::Revoke {
                    grant_id: grant.grant_id.clone(),
                },
            ),
            None,
            "process",
            now() + Duration::seconds(1),
        )
        .unwrap();
    let original = state.operations["grant"].clone();
    assert!(matches!(original.result, Receipt::Granted { .. }));
    assert!(state
        .grant(&grant.grant_id, "process", now() + Duration::seconds(2))
        .is_err());
    state.validate().unwrap();
}
#[test]
fn deletion_removes_body_and_all_grants_but_keeps_original_decisions() {
    let mut state = State::new("home".into(), now());
    let id = uploaded(&mut state);
    let grant = grant(&mut state, &id, "grant");
    state
        .apply(
            request(
                "delete",
                Change::Delete {
                    media_id: id.clone(),
                },
            ),
            None,
            "process",
            now() + Duration::seconds(1),
        )
        .unwrap();
    assert!(state.objects[&id].content_base64.is_none());
    assert!(state
        .grant(&grant.grant_id, "process", now() + Duration::seconds(2))
        .is_err());
    state
        .apply(
            request("upload", upload()),
            None,
            "process",
            now() + Duration::seconds(2),
        )
        .unwrap();
    assert!(state.objects[&id].content_base64.is_none());
    assert_eq!(state.objects.len(), 1);
    state.validate().unwrap();
}
#[test]
fn retention_purge_releases_content_and_old_key_cannot_restore_it() {
    let mut state = State::new("home".into(), now());
    let id = uploaded(&mut state);
    assert!(!state.prune(now() + Duration::seconds(59)));
    let later = now() + Duration::seconds(60);
    assert!(state.prune(later));
    state.saved_at = later;
    state.validate().unwrap();
    state
        .apply(request("upload", upload()), None, "process", later)
        .unwrap();
    assert!(state.objects[&id].content_base64.is_none());
    assert!(state.active_object(&id, later).is_err());
}
#[test]
fn invalid_target_scope_and_clock_are_rejected() {
    let mut state = State::new("home".into(), now());
    let id = uploaded(&mut state);
    let request = request(
        "grant",
        Change::Grant {
            media_id: id,
            device_id: "speaker".into(),
            expected_binding_revision: format!("sha256:{}", "a".repeat(64)),
            valid_for_seconds: 10,
        },
    );
    assert!(state.apply(request, None, "process", now()).is_err());
    assert!(state
        .apply(
            Request {
                space_id: "other".into(),
                ..super_request()
            },
            None,
            "process",
            now()
        )
        .is_err());
    assert_eq!(
        state
            .apply(
                super_request(),
                None,
                "process",
                now() - Duration::seconds(1)
            )
            .unwrap_err()
            .code,
        "media_clock_invalid"
    );
}
fn super_request() -> Request {
    request("new", upload())
}
#[test]
fn corrupt_snapshot_never_accepts_changed_payload_metadata_or_result() {
    let mut state = State::new("home".into(), now());
    let id = uploaded(&mut state);
    let grant = grant(&mut state, &id, "grant");
    for mutation in 0..7 {
        let mut bad = state.clone();
        match mutation {
            0 => bad.objects.get_mut(&id).unwrap().metadata.byte_length += 1,
            1 => {
                bad.objects.get_mut(&id).unwrap().content_base64 = Some(STANDARD.encode(b"corrupt"))
            }
            2 => {
                bad.grants.get_mut(&grant.grant_id).unwrap().grant.source_ip =
                    "8.8.8.8".parse().unwrap()
            }
            3 => {
                bad.grants
                    .get_mut(&grant.grant_id)
                    .unwrap()
                    .grant
                    .expires_at = now() + Duration::days(2)
            }
            4 => bad.operations.get_mut("grant").unwrap().kind = "media.upload".into(),
            5 => bad.schema_version = 2,
            _ => bad.objects.get_mut(&id).unwrap().content_base64 = None,
        }
        assert!(bad.validate().is_err(), "{mutation}");
    }
}
