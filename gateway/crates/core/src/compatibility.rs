//! 定义向后兼容：旧控制器可继续写入，旧读取者可继续解析输出；不证明硬件能力。
use crate::{
    model::{Model, Schema},
    validation::{at, bounded_document, issue, validate_document, Issue, Report, SAFE_INTEGER},
};
use serde::Serialize;
use serde_json::Value;

pub const CHECKER: &str = "limeiot.model-compatibility/1.1.0";
pub const MAX_DOCUMENT_BYTES: usize = 16_416;

#[derive(Debug, Serialize)]
pub struct Comparison {
    pub version: u8,
    pub checker: &'static str,
    pub valid: bool,
    pub compatible: Option<bool>,
    pub comparison_digest: Option<String>,
    pub baseline: Option<Report>,
    pub candidate: Option<Report>,
    pub issues: Vec<Issue>,
}

// 仅在整个值域最多32项时枚举，用来证明无enum的有限域也被目标enum完整覆盖。
fn finite_values(schema: &Schema) -> Option<Vec<Value>> {
    if let Some(values) = &schema.values {
        return Some(values.clone());
    }
    match schema.kind.as_str() {
        "boolean" => Some(vec![Value::Bool(false), Value::Bool(true)]),
        "integer" => {
            let min = schema.minimum.unwrap_or(-SAFE_INTEGER) as i64;
            let max = schema.maximum.unwrap_or(SAFE_INTEGER) as i64;
            if max - min >= 32 {
                return None;
            }
            Some((min..=max).map(Value::from).collect())
        }
        "number"
            if schema.minimum.unwrap_or(-SAFE_INTEGER)
                == schema.maximum.unwrap_or(SAFE_INTEGER) =>
        {
            Some(vec![Value::from(schema.minimum.unwrap_or(-SAFE_INTEGER))])
        }
        "string" if schema.max_length == Some(0) => Some(vec![Value::String(String::new())]),
        "object" => {
            let mut objects = vec![serde_json::Map::new()];
            for (key, child) in &schema.properties {
                let values = finite_values(child)?;
                let optional = !schema.required.contains(key);
                let count = values.len() + usize::from(optional);
                if objects.len() * count > 32 {
                    return None;
                }
                let mut next = Vec::new();
                for object in objects {
                    if optional {
                        next.push(object.clone());
                    }
                    for value in &values {
                        let mut object = object.clone();
                        object.insert(key.clone(), value.clone());
                        next.push(object);
                    }
                }
                objects = next;
            }
            Some(objects.into_iter().map(Value::Object).collect())
        }
        _ => None,
    }
}

// 对当前有限Schema子集证明 sub ⊆ sup。无法证明时拒绝兼容，绝不按版本号放行。
pub fn schema_subset(sub: &Schema, sup: &Schema) -> bool {
    sub.validate_definition(0).is_ok() && sup.validate_definition(0).is_ok() && subset(sub, sup)
}

fn subset(sub: &Schema, sup: &Schema) -> bool {
    if !same_types(sub, sup) {
        return false;
    }
    if let Some(values) = &sub.values {
        return values.iter().all(|value| sup.validate(value).is_ok());
    }
    if sup.values.is_some() {
        return finite_values(sub)
            .is_some_and(|values| values.iter().all(|value| sup.validate(value).is_ok()));
    }
    match sub.kind.as_str() {
        "integer" | "number" => {
            sub.minimum.unwrap_or(-SAFE_INTEGER) >= sup.minimum.unwrap_or(-SAFE_INTEGER)
                && sub.maximum.unwrap_or(SAFE_INTEGER) <= sup.maximum.unwrap_or(SAFE_INTEGER)
        }
        "string" => {
            sub.min_length.unwrap_or(0) >= sup.min_length.unwrap_or(0)
                && sub.max_length.unwrap_or(4096) <= sup.max_length.unwrap_or(4096)
        }
        "object" => {
            sup.required.iter().all(|key| sub.required.contains(key))
                && sub.properties.iter().all(|(key, child)| {
                    sup.properties
                        .get(key)
                        .is_some_and(|other| subset(child, other))
                })
        }
        "boolean" => true,
        _ => false,
    }
}

fn same_types(a: &Schema, b: &Schema) -> bool {
    a.kind == b.kind
        && a.properties.iter().all(|(key, child)| {
            b.properties
                .get(key)
                .is_none_or(|other| same_types(child, other))
        })
}

pub(crate) fn version(value: &str) -> Vec<u32> {
    // 调用前两个模型都已通过共享定义校验。
    value.split('.').map(|part| part.parse().unwrap()).collect()
}

fn compare_models(baseline: &Model, candidate: &Model) -> Vec<Issue> {
    let mut out = Vec::new();
    if baseline.model_id != candidate.model_id {
        issue(&mut out, "/candidate/model_id", "model_id_changed");
    }
    if version(&candidate.model_version) <= version(&baseline.model_version) {
        issue(
            &mut out,
            "/candidate/model_version",
            "model_version_not_increased",
        );
    }
    for (old_index, old) in baseline.services.iter().enumerate() {
        let old_path = at("/baseline/services", old_index);
        let Some((index, new)) = candidate
            .services
            .iter()
            .enumerate()
            .find(|(_, s)| s.id == old.id)
        else {
            issue(&mut out, &old_path, "service_removed");
            continue;
        };
        let path = at("/candidate/services", index);
        if old.semantic_id != new.semantic_id {
            issue(&mut out, &at(&path, "semantic_id"), "semantic_id_changed");
        }
        for (old_index, old) in old.properties.iter().enumerate() {
            let old_path = at(&at(&old_path, "properties"), old_index);
            let Some((index, new)) = new
                .properties
                .iter()
                .enumerate()
                .find(|(_, p)| p.id == old.id)
            else {
                issue(&mut out, &old_path, "property_removed");
                continue;
            };
            let path = at(&at(&path, "properties"), index);
            if old.semantic_id != new.semantic_id {
                issue(&mut out, &at(&path, "semantic_id"), "semantic_id_changed");
            }
            if old.unit != new.unit {
                issue(&mut out, &at(&path, "unit"), "unit_changed");
            }
            if old.max_age_ms != new.max_age_ms {
                issue(&mut out, &at(&path, "max_age_ms"), "freshness_changed");
            }
            if old.access.iter().any(|access| !new.access.contains(access)) {
                issue(&mut out, &at(&path, "access"), "access_removed");
            }
            if old.access.iter().any(|access| access == "write")
                && !subset(&old.schema, &new.schema)
            {
                issue(&mut out, &at(&path, "schema"), "write_schema_incompatible");
            }
            if old
                .access
                .iter()
                .any(|access| access == "read" || access == "notify")
                && !subset(&new.schema, &old.schema)
            {
                issue(&mut out, &at(&path, "schema"), "output_schema_incompatible");
            }
        }
        for (old_index, old) in old.actions.iter().enumerate() {
            let old_action_path = at(&at(&old_path, "actions"), old_index);
            let Some((index, new)) = new.actions.iter().enumerate().find(|(_, a)| a.id == old.id)
            else {
                issue(&mut out, &old_action_path, "action_removed");
                continue;
            };
            let action_path = at(&at(&path, "actions"), index);
            if old.semantic_id != new.semantic_id {
                issue(
                    &mut out,
                    &at(&action_path, "semantic_id"),
                    "semantic_id_changed",
                );
            }
            if old.idempotent != new.idempotent {
                issue(
                    &mut out,
                    &at(&action_path, "idempotent"),
                    "action_idempotency_changed",
                );
            }
            if old.risk != new.risk {
                issue(&mut out, &at(&action_path, "risk"), "action_risk_changed");
            }
            if old.completion != new.completion {
                issue(
                    &mut out,
                    &at(&action_path, "completion"),
                    "action_completion_changed",
                );
            }
            if !subset(&old.input, &new.input) {
                issue(
                    &mut out,
                    &at(&action_path, "input"),
                    "action_input_incompatible",
                );
            }
            if !subset(&new.output, &old.output) {
                issue(
                    &mut out,
                    &at(&action_path, "output"),
                    "action_output_incompatible",
                );
            }
        }
        for (old_index, old) in old.events.iter().enumerate() {
            let old_path = at(&at(&old_path, "events"), old_index);
            let Some((index, new)) = new.events.iter().enumerate().find(|(_, e)| e.id == old.id)
            else {
                issue(&mut out, &old_path, "event_removed");
                continue;
            };
            let path = at(&at(&path, "events"), index);
            if old.semantic_id != new.semantic_id {
                issue(&mut out, &at(&path, "semantic_id"), "semantic_id_changed");
            }
            if !subset(&new.schema, &old.schema) {
                issue(&mut out, &at(&path, "schema"), "event_schema_incompatible");
            }
        }
    }
    out
}

pub fn compare_documents(raw: &[u8]) -> Comparison {
    let mut report = Comparison {
        version: 1,
        checker: CHECKER,
        valid: false,
        compatible: None,
        comparison_digest: None,
        baseline: None,
        candidate: None,
        issues: Vec::new(),
    };
    let parsed = bounded_document(raw, MAX_DOCUMENT_BYTES, 17, 4097);
    let Some(value) = parsed.filter(|value| {
        value.as_object().is_some_and(|object| {
            object.len() == 2 && object.contains_key("baseline") && object.contains_key("candidate")
        })
    }) else {
        issue(&mut report.issues, "", "invalid_comparison_document");
        return report;
    };
    report.comparison_digest = crate::digest(&value).ok();
    let baseline = validate_document(&serde_jcs::to_vec(&value["baseline"]).unwrap());
    let candidate = validate_document(&serde_jcs::to_vec(&value["candidate"]).unwrap());
    report.valid = baseline.valid && candidate.valid;
    if !baseline.valid {
        issue(&mut report.issues, "/baseline", "invalid_baseline_model");
    }
    if !candidate.valid {
        issue(&mut report.issues, "/candidate", "invalid_candidate_model");
    }
    if let (Some(old), Some(new)) = (&baseline.normalized_model, &candidate.normalized_model) {
        report.issues = compare_models(old, new);
        report.compatible = Some(report.issues.is_empty());
    }
    report.baseline = Some(baseline);
    report.candidate = Some(candidate);
    report
}
