use limeiot_android_tv::supports_model;
use limeiot_core::model::Model;
use serde_json::{json, Value};

fn reference() -> Value {
    serde_json::from_slice(include_bytes!(
        "../../../../contracts/models/android-tv-remote.json"
    ))
    .unwrap()
}

#[test]
fn precise_model_and_narrower_inputs_are_supported() {
    let mut value = reference();
    assert!(supports_model(
        &serde_json::from_value(value.clone()).unwrap()
    ));
    value["services"][0]["actions"][0]["input"]["properties"]["key"]["enum"] = json!(["home"]);
    value["services"][1]["actions"][0]["input"]["properties"]["application_id"] =
        json!({"type":"string","enum":["com.example.player"],"minLength":1,"maxLength":128});
    let model: Model = serde_json::from_value(value).unwrap();
    model.validate().unwrap();
    assert!(supports_model(&model));
}

#[test]
fn model_does_not_grant_unimplemented_inputs_or_change_action_meaning() {
    for variant in 0..10 {
        let mut value = reference();
        let action = &mut value["services"][0]["actions"][0];
        match variant {
            0 => action["input"]["properties"]["key"]["enum"]
                .as_array_mut()
                .unwrap()
                .push(json!("power")),
            1 => action["input"]["properties"]["repeat"] = json!({"type":"boolean"}),
            2 => action["input"]["required"] = json!([]),
            3 => action["semantic_id"] = json!("urn:limeiot:action:other:1"),
            4 => action["risk"] = json!("high"),
            5 => action["idempotent"] = json!(true),
            6 => action["completion"] = json!("observed"),
            7 => {
                action["output"] = json!({"type":"object","properties":{"done":{"type":"boolean"}},"required":[],"additionalProperties":false})
            }
            8 => action["id"] = json!("other"),
            _ => value["services"][0]["semantic_id"] = json!("urn:limeiot:service:other:1"),
        }
        let model: Model = serde_json::from_value(value).unwrap();
        model.validate().unwrap();
        assert!(!supports_model(&model), "variant {variant}");
    }
}
