use limeiot_core::{
    digest,
    engine::{Config, Data},
    model::Model,
    protocol::Rule,
};
use serde_json::json;

fn data() -> Data {
    let lamp: Model =
        serde_json::from_str(include_str!("../../../../contracts/models/lamp.json")).unwrap();
    let tv: Model =
        serde_json::from_str(include_str!("../../../../contracts/models/android-tv.json")).unwrap();
    Data::new(
        serde_json::from_value::<Config>(json!({"space_id":"home","models":[lamp,tv],
        "devices":[{"device_id":"a","model_revision":digest(&lamp).unwrap()},
        {"device_id":"b","model_revision":digest(&lamp).unwrap()},
        {"device_id":"c","model_revision":digest(&lamp).unwrap()},
        {"device_id":"tv","model_revision":digest(&tv).unwrap()}]}))
        .unwrap(),
    )
    .unwrap()
}
fn rule(id: &str, source: &str, target: &str) -> Rule {
    serde_json::from_value(json!({"version":1,"id":id,"trigger":{"device":source,
        "property":{"path":"light.brightness","unit":"percent","edge":"rising","threshold":50,"hysteresis":5}},
        "conditions":[],"actions":[{"device":target,"set":{"path":"light.brightness","value":20}}],"cooldown_ms":10000})).unwrap()
}
fn assert_rejected(data: &mut Data, rule: Rule) {
    let before = serde_json::to_value(&data).unwrap();
    assert_eq!(data.validate_rule(&rule).unwrap_err().code, "rule_cycle");
    assert_eq!(data.deploy(rule).unwrap_err().code, "rule_cycle");
    assert_eq!(serde_json::to_value(&data).unwrap(), before);
}

#[test]
fn direct_self_write_is_rejected_despite_hysteresis_and_cooldown() {
    let mut data = data();
    assert_rejected(&mut data, rule("self", "a", "a"));
}
#[test]
fn multiple_devices_cannot_close_a_cycle_and_rejection_preserves_deployments() {
    let mut data = data();
    data.deploy(rule("ab", "a", "b")).unwrap();
    data.deploy(rule("bc", "b", "c")).unwrap();
    assert_rejected(&mut data, rule("ca", "c", "a"));
    assert_rejected(&mut data, rule("ba", "b", "a"));
    assert!(data.validate_rule_graph().is_ok());
}
#[test]
fn replacement_excludes_old_edges_and_stop_removes_dependencies() {
    let mut data = data();
    let ab = data.deploy(rule("ab", "a", "b")).unwrap();
    assert_rejected(&mut data, rule("ba", "b", "a"));
    data.deploy(rule("ab", "b", "a")).unwrap();
    // 替换后不是把旧边和新边合并。
    assert_eq!(data.deployments.len(), 1);
    let replacement = data.deployments["ab"].revision.clone();
    assert_ne!(replacement, ab.revision);
    data.stop_rule("ab", &replacement).unwrap();
    data.deploy(rule("new", "a", "b")).unwrap();
}
#[test]
fn paths_are_distinct_and_diamond_dependencies_are_not_cycles() {
    let mut data = data();
    data.deploy(rule("ab", "a", "b")).unwrap();
    data.deploy(rule("ac", "a", "c")).unwrap();
    data.deploy(rule("bc", "b", "c")).unwrap();
    let mut power = serde_json::to_value(rule("power", "c", "a")).unwrap();
    power["actions"][0]["set"] = json!({"path":"light.power","value":true});
    data.deploy(serde_json::from_value(power).unwrap()).unwrap();
    assert!(data.validate_rule_graph().is_ok());
}
#[test]
fn unknown_action_effects_conservatively_connect_target_thresholds() {
    let mut data = data();
    let mut tv_rule = serde_json::to_value(rule("tv-a", "a", "a")).unwrap();
    tv_rule["trigger"] = json!({"device":"tv","property":{"path":"audio.volume",
        "unit":"percent","edge":"rising","threshold":50,"hysteresis":5}});
    data.deploy(serde_json::from_value(tv_rule).unwrap())
        .unwrap();
    let mut invoke = serde_json::to_value(rule("a-tv", "a", "a")).unwrap();
    invoke["actions"] =
        json!([{"device":"tv","invoke":{"path":"remote.press","input":{"key":"home"}}}]);
    assert_rejected(&mut data, serde_json::from_value(invoke.clone()).unwrap());
    // 移除回边后，同一动作规则可以部署。
    let revision = data.deployments["tv-a"].revision.clone();
    data.stop_rule("tv-a", &revision).unwrap();
    data.deploy(serde_json::from_value(invoke).unwrap())
        .unwrap();
}
#[test]
fn existing_graph_recovery_detects_a_cycle_without_mutation() {
    let mut data = data();
    data.deploy(rule("ab", "a", "b")).unwrap();
    let ba = rule("ba", "b", "a");
    let mut saved = serde_json::to_value(data).unwrap();
    saved["deployments"]["ba"] = json!({"rule":ba,"revision":digest(&ba).unwrap(),"last_run":null});
    let restored: Data = serde_json::from_value(saved.clone()).unwrap();
    assert_eq!(
        restored.validate_rule_graph().unwrap_err().code,
        "rule_cycle"
    );
    assert_eq!(serde_json::to_value(restored).unwrap(), saved);
}

#[test]
fn restored_graph_is_bounded_before_recursive_traversal() {
    let mut data = data();
    for index in 0..64 {
        data.deploy(rule(&format!("rule-{index}"), "a", "b"))
            .unwrap();
    }
    let before = serde_json::to_value(&data).unwrap();
    assert_eq!(
        data.deploy(rule("overflow", "b", "c")).unwrap_err().code,
        "capacity_exceeded"
    );
    assert_eq!(serde_json::to_value(&data).unwrap(), before);
    let mut saved = before;
    let mut extra = saved["deployments"]["rule-0"].clone();
    extra["rule"]["id"] = json!("overflow");
    saved["deployments"]["overflow"] = extra;
    let restored: Data = serde_json::from_value(saved).unwrap();
    assert_eq!(
        restored.validate_rule_graph().unwrap_err().code,
        "capacity_exceeded"
    );
}
