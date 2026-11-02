use limeiot_core::{
    digest,
    engine::{Config, Data},
    validation::{validate_document, VALIDATOR},
};
use serde_json::{json, Value};

#[test]
fn shared_document_vectors_and_runtime_share_one_definition() {
    let vectors: Value = serde_json::from_str(include_str!(
        "../../../../contracts/model-validation-vectors.json"
    ))
    .unwrap();
    for case in vectors["cases"].as_array().unwrap() {
        let report = validate_document(case["raw"].as_str().unwrap().as_bytes());
        assert_eq!(
            report.valid,
            case["valid"].as_bool().unwrap(),
            "{}: {:?}",
            case["name"],
            report.issues
        );
        assert_eq!(report.version, 1);
        assert_eq!(report.validator, VALIDATOR);
        assert!(report.issues.len() <= 32);
        if report.valid {
            let model = report.normalized_model.as_ref().unwrap();
            model.validate().unwrap();
            assert_eq!(
                report.model_revision.as_ref().unwrap(),
                &digest(model).unwrap()
            );
            assert!(report.issues.is_empty());
        } else {
            assert!(report.normalized_model.is_none());
            assert!(report.model_revision.is_none());
            assert!(
                report
                    .issues
                    .iter()
                    .any(|issue| Some(issue.code.as_str()) == case["code"].as_str()),
                "{}: {:?}",
                case["name"],
                report.issues
            );
        }
    }
}

#[test]
fn report_binds_source_and_gateway_projection_without_publishing() {
    let raw = include_bytes!("../../../../contracts/models/lamp.json");
    let report = validate_document(raw);
    let config: Config =
        serde_json::from_str(include_str!("../../../../deploy/dev/config.json")).unwrap();
    let data = Data::new(config).unwrap();
    assert_eq!(
        report.model_revision.as_ref().unwrap(),
        &data.devices["device-lamp"].model_revision
    );
    let mut source: Value = serde_json::from_slice(raw).unwrap();
    source["services"][0]["properties"][0]["schema"]["properties"] = json!({});
    let projected = validate_document(&serde_json::to_vec(&source).unwrap());
    assert!(projected.valid);
    assert_ne!(projected.document_digest, projected.model_revision);
    assert_eq!(projected.document_digest.unwrap(), digest(&source).unwrap());
    assert_eq!(projected.model_revision, report.model_revision);
    assert_eq!(data.models.len(), 2);
}

#[test]
fn oversized_field_names_keep_bounded_ancestor_pointers() {
    let mut model: Value =
        serde_json::from_slice(include_bytes!("../../../../contracts/models/lamp.json")).unwrap();
    model["services"][0]["properties"][0]["schema"] =
        json!({"type":"object","properties":{"界/~".repeat(400):{"type":"boolean"}}});
    let report = validate_document(&serde_json::to_vec(&model).unwrap());
    assert!(!report.valid);
    let issue = report
        .issues
        .iter()
        .find(|issue| issue.code == "invalid_identifier")
        .unwrap();
    assert_eq!(issue.path, "/services/0/properties/0/schema/properties");
    for issue in &report.issues {
        assert!(issue.path.len() <= 1024);
    }
}

#[test]
fn integer_enum_uses_json_number_semantics() {
    let schema: limeiot_core::model::Schema =
        serde_json::from_value(json!({"type":"integer","enum":[1]})).unwrap();
    schema.validate_definition(0).unwrap();
    assert!(schema.validate(&json!(1.0)).is_ok());
    assert!(schema.validate(&json!(1.1)).is_err());
    assert!(schema.validate(&json!(9007199254740992_u64)).is_err());
    let number: limeiot_core::model::Schema =
        serde_json::from_value(json!({"type":"number","enum":[9007199254740992_u64]})).unwrap();
    assert!(number.validate_definition(0).is_err());
}
