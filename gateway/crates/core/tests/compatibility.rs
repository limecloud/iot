use limeiot_core::{
    compatibility::{compare_documents, CHECKER, MAX_DOCUMENT_BYTES},
    digest,
};
use serde_json::{json, Value};

#[test]
fn shared_compatibility_vectors_bind_both_models_and_direction() {
    let vectors: Value = serde_json::from_str(include_str!(
        "../../../../contracts/model-compatibility-vectors.json"
    ))
    .unwrap();
    for case in vectors["cases"].as_array().unwrap() {
        let raw = case["raw"].as_str().unwrap();
        let report = compare_documents(raw.as_bytes());
        assert_eq!(report.version, 1);
        assert_eq!(report.checker, CHECKER);
        assert_eq!(report.valid, case["valid"], "{}", case["name"]);
        assert_eq!(
            json!(report.compatible),
            case["compatible"],
            "{}: {:?}",
            case["name"],
            report.issues
        );
        assert_eq!(
            report.comparison_digest,
            Some(digest(&serde_json::from_str::<Value>(raw).unwrap()).unwrap())
        );
        assert!(report.issues.len() <= 32);
        if let Some(code) = case["code"].as_str() {
            assert!(
                report.issues.iter().any(|issue| issue.code == code),
                "{}: {:?}",
                case["name"],
                report.issues
            );
        } else {
            assert!(report.issues.is_empty(), "{}", case["name"]);
        }
        for model in [report.baseline.unwrap(), report.candidate.unwrap()] {
            if model.valid {
                assert_eq!(
                    model.model_revision,
                    Some(digest(&model.normalized_model.unwrap()).unwrap())
                );
            }
        }
    }
}

#[test]
fn interval_compatibility_preserves_actual_old_writes_and_new_outputs() {
    let base: Value =
        serde_json::from_str(include_str!("../../../../contracts/models/lamp.json")).unwrap();
    for access in [json!(["write"]), json!(["read"]), json!(["read", "write"])] {
        for old_min in -2..=2 {
            for old_max in old_min..=2 {
                for new_min in -2..=2 {
                    for new_max in new_min..=2 {
                        let mut old = base.clone();
                        let mut new = base.clone();
                        for (model, min, max) in
                            [(&mut old, old_min, old_max), (&mut new, new_min, new_max)]
                        {
                            let p = &mut model["services"][0]["properties"][1];
                            p["schema"] = json!({"type":"integer","minimum":min,"maximum":max});
                            p["access"] = access.clone();
                        }
                        new["model_version"] = json!("1.0.1");
                        let report = compare_documents(
                            &serde_json::to_vec(&json!({"baseline":old,"candidate":new})).unwrap(),
                        );
                        assert!(report.valid);
                        let baseline = report.baseline.unwrap().normalized_model.unwrap();
                        let candidate = report.candidate.unwrap().normalized_model.unwrap();
                        let old = &baseline.property("light.brightness").unwrap().schema;
                        let new = &candidate.property("light.brightness").unwrap().schema;
                        let old_writes_ok = (-3..=3).all(|v| {
                            !access.as_array().unwrap().contains(&json!("write"))
                                || old.validate(&json!(v)).is_err()
                                || new.validate(&json!(v)).is_ok()
                        });
                        let new_outputs_ok = (-3..=3).all(|v| {
                            !access.as_array().unwrap().contains(&json!("read"))
                                || new.validate(&json!(v)).is_err()
                                || old.validate(&json!(v)).is_ok()
                        });
                        assert_eq!(report.compatible, Some(old_writes_ok && new_outputs_ok));
                    }
                }
            }
        }
    }
}

#[test]
fn finite_edge_domains_do_not_hide_nested_type_changes() {
    let base: Value =
        serde_json::from_str(include_str!("../../../../contracts/models/lamp.json")).unwrap();
    for kind in ["integer", "number"] {
        let mut old = base.clone();
        old["services"][0]["properties"][1]["schema"] =
            json!({"type":kind,"minimum":9007199254740991_u64});
        let mut next = old.clone();
        next["model_version"] = json!("1.0.1");
        next["services"][0]["properties"][1]["schema"]["enum"] = json!([9007199254740991_u64]);
        let report = compare_documents(
            &serde_json::to_vec(&json!({"baseline":old,"candidate":next})).unwrap(),
        );
        assert!(report.valid);
        assert_eq!(report.compatible, Some(true));
    }
    let mut old = base;
    old["services"][0]["properties"][1]["schema"] =
        json!({"type":"object","properties":{"n":{"type":"integer"}},"enum":[{"n":1}]});
    let mut next = old.clone();
    next["model_version"] = json!("1.0.1");
    next["services"][0]["properties"][1]["schema"]["properties"]["n"]["type"] = json!("number");
    let report =
        compare_documents(&serde_json::to_vec(&json!({"baseline":old,"candidate":next})).unwrap());
    assert!(report.valid);
    assert_eq!(report.compatible, Some(false));
}

#[test]
fn comparison_rejects_unsafe_envelopes_and_bounds_nested_models_and_issues() {
    let invalid = vec![
        b"{}".to_vec(),
        br#"{"baseline":{},"candidate":{},"extra":true}"#.to_vec(),
        br#"{"baseline":{},"baseline":{},"candidate":{}}"#.to_vec(),
        br#"{"baseline":{"x":1,"x":2},"candidate":{}}"#.to_vec(),
        br#"{"baseline":{"x":"\ud800"},"candidate":{}}"#.to_vec(),
        br#"{"baseline":{"x":9007199254740992},"candidate":{}}"#.to_vec(),
        vec![b' '; MAX_DOCUMENT_BYTES + 1],
    ];
    for raw in invalid {
        let report = compare_documents(&raw);
        assert!(!report.valid);
        assert!(report.compatible.is_none());
        assert!(report.comparison_digest.is_none());
        assert!(report.baseline.is_none() && report.candidate.is_none());
        assert_eq!(report.issues[0].code, "invalid_comparison_document");
    }
    let oversized = json!({"baseline":{"large":"x".repeat(8192)},"candidate":{}});
    let report = compare_documents(&serde_json::to_vec(&oversized).unwrap());
    assert!(report.comparison_digest.is_some());
    assert!(report.baseline.unwrap().document_digest.is_none());
    assert_eq!(report.issues[0].code, "invalid_baseline_model");

    let mut base: Value =
        serde_json::from_str(include_str!("../../../../contracts/models/lamp.json")).unwrap();
    for n in 0..6 {
        let mut service = base["services"][0].clone();
        service["id"] = json!(format!("service_{n}"));
        base["services"].as_array_mut().unwrap().push(service);
    }
    let mut next = base.clone();
    next["model_version"] = json!("1.0.1");
    for service in next["services"].as_array_mut().unwrap() {
        for p in service["properties"].as_array_mut().unwrap() {
            p["semantic_id"] = json!("urn:example:property:changed:1");
            p["unit"] = json!("other");
            p["max_age_ms"] = json!(1);
            p["access"] = json!(["read"]);
        }
    }
    let report =
        compare_documents(&serde_json::to_vec(&json!({"baseline":base,"candidate":next})).unwrap());
    assert!(report.valid);
    assert_eq!(report.compatible, Some(false));
    assert_eq!(report.issues.len(), 32);
}
