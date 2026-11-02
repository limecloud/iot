//! 模型校验与网关使用相同定义规则；报告没有发布或安装权限。
use crate::model::{local_id, Model, Schema};
use serde::{de, Deserialize, Deserializer, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;

pub const VALIDATOR: &str = "limeiot.model/1.1.0";
pub(crate) const SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Issue {
    pub path: String,
    pub code: String,
}
#[derive(Debug, Serialize)]
pub struct Report {
    pub version: u8,
    pub validator: &'static str,
    pub valid: bool,
    pub document_digest: Option<String>,
    pub model_revision: Option<String>,
    pub normalized_model: Option<Model>,
    pub issues: Vec<Issue>,
}
pub(crate) fn at(parent: &str, key: impl std::fmt::Display) -> String {
    format!(
        "{parent}/{}",
        key.to_string().replace('~', "~0").replace('/', "~1")
    )
}
pub(crate) fn issue(out: &mut Vec<Issue>, path: &str, code: &str) {
    if out.len() < 32 {
        // 超长输入键只定位到最近的完整祖先，保持合法Pointer及跨语言1024字节预算。
        let path = if path.len() > 1024 {
            let end = path
                .rmatch_indices('/')
                .find(|(index, _)| *index <= 1024)
                .map_or(0, |(index, _)| index);
            &path[..end]
        } else {
            path
        };
        out.push(Issue {
            path: path.into(),
            code: code.into(),
        });
    }
}
pub(crate) fn first_error(issues: Vec<Issue>) -> crate::Result<()> {
    match issues.first() {
        Some(value) => Err(crate::err(&value.code)),
        None => Ok(()),
    }
}
fn urn(value: &str) -> bool {
    let Some((namespace, name)) = value.strip_prefix("urn:").and_then(|v| v.split_once(':')) else {
        return false;
    };
    !namespace.is_empty()
        && namespace.len() <= 32
        && value.len() <= 512
        && namespace
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && namespace
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && namespace
            .as_bytes()
            .last()
            .is_some_and(u8::is_ascii_alphanumeric)
        && !name.is_empty()
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_: .".contains(&b) && b != b' ')
}
pub(crate) fn version(value: &str) -> bool {
    let parts: Vec<_> = value.split('.').collect();
    parts.len() == 3
        && parts.iter().all(|part| {
            !part.is_empty()
                && (part.len() == 1 || !part.starts_with('0'))
                && part.bytes().all(|b| b.is_ascii_digit())
                && part.parse::<u32>().is_ok()
        })
}
pub fn schema_issues(schema: &Schema, path: &str, depth: usize) -> Vec<Issue> {
    let mut out = Vec::new();
    if depth > 4 {
        issue(&mut out, path, "schema_depth_exceeded");
        return out;
    }
    let numeric = matches!(schema.kind.as_str(), "integer" | "number");
    if !matches!(
        schema.kind.as_str(),
        "boolean" | "integer" | "number" | "string" | "object"
    ) {
        issue(&mut out, &at(path, "type"), "unsupported_schema_type");
        return out;
    }
    for (key, value) in [("minimum", schema.minimum), ("maximum", schema.maximum)] {
        if let Some(value) = value {
            if !numeric
                || !value.is_finite()
                || value.abs() > SAFE_INTEGER
                || schema.kind == "integer" && value.fract() != 0.0
            {
                issue(&mut out, &at(path, key), "invalid_numeric_bound");
            }
        }
    }
    if schema
        .minimum
        .zip(schema.maximum)
        .is_some_and(|(min, max)| min > max)
    {
        issue(&mut out, path, "invalid_schema_range");
    }
    if (schema.min_length.is_some() || schema.max_length.is_some()) && schema.kind != "string"
        || schema.min_length.unwrap_or(0) > schema.max_length.unwrap_or(4096)
        || schema.max_length.unwrap_or(4096) > 4096
    {
        issue(&mut out, path, "invalid_string_bounds");
    }
    if schema.kind != "object"
        && (!schema.properties.is_empty()
            || !schema.required.is_empty()
            || schema.additional.is_some())
    {
        issue(&mut out, path, "inapplicable_object_keywords");
    }
    if schema.additional == Some(true) {
        issue(
            &mut out,
            &at(path, "additionalProperties"),
            "unbounded_object_schema",
        );
    }
    if schema.properties.len() > 32 || schema.required.len() > 32 {
        issue(&mut out, path, "schema_field_capacity");
    }
    let mut required = BTreeSet::new();
    for (index, key) in schema.required.iter().take(32).enumerate() {
        if !schema.properties.contains_key(key) || !required.insert(key) {
            issue(
                &mut out,
                &at(&at(path, "required"), index),
                "invalid_required_field",
            );
        }
    }
    for (key, child) in schema.properties.iter().take(32) {
        let child_path = at(&at(path, "properties"), key);
        if !local_id(key) {
            issue(&mut out, &child_path, "invalid_identifier");
        }
        for value in schema_issues(child, &child_path, depth + 1) {
            issue(&mut out, &value.path, &value.code);
        }
    }
    if let Some(values) = &schema.values {
        if values.is_empty() || values.len() > 32 {
            issue(&mut out, &at(path, "enum"), "enum_capacity");
        }
        let mut base = schema.clone();
        base.values = None;
        let mut seen = BTreeSet::new();
        for (index, value) in values.iter().take(32).enumerate() {
            let item = at(&at(path, "enum"), index);
            if base.validate(value).is_err() {
                issue(&mut out, &item, "invalid_enum_value");
            }
            if !crate::digest(value).is_ok_and(|digest| seen.insert(digest)) {
                issue(&mut out, &item, "duplicate_enum_value");
            }
        }
    }
    out
}
pub fn model_issues(model: &Model) -> Vec<Issue> {
    let mut out = Vec::new();
    if !matches!(model.schema_version, 1 | 2) {
        issue(&mut out, "/schema_version", "unsupported_model_schema");
    }
    if !urn(&model.model_id) {
        issue(&mut out, "/model_id", "invalid_urn");
    }
    if !version(&model.model_version) {
        issue(&mut out, "/model_version", "invalid_model_version");
    }
    if model.services.is_empty() || model.services.len() > 16 {
        issue(&mut out, "/services", "service_capacity");
    }
    let mut names = BTreeSet::new();
    for (index, service) in model.services.iter().take(16).enumerate() {
        let path = at("/services", index);
        if !local_id(&service.id) || !names.insert(&service.id) {
            issue(
                &mut out,
                &at(&path, "id"),
                "invalid_or_duplicate_identifier",
            );
        }
        if !urn(&service.semantic_id) {
            issue(&mut out, &at(&path, "semantic_id"), "invalid_urn");
        }
        if model.schema_version == 1 && !service.actions.is_empty() {
            issue(&mut out, &at(&path, "actions"), "unsupported_actions");
        }
        if service.properties.len() > 32
            || service.events.len() > 32
            || service.actions.len() > 32
            || service.properties.is_empty()
                && service.events.is_empty()
                && service.actions.is_empty()
        {
            issue(&mut out, &path, "service_field_capacity");
        }
        let mut fields = BTreeSet::new();
        for (index, property) in service.properties.iter().take(32).enumerate() {
            let path = at(&at(&path, "properties"), index);
            if !local_id(&property.id) || !fields.insert(&property.id) {
                issue(
                    &mut out,
                    &at(&path, "id"),
                    "invalid_or_duplicate_identifier",
                );
            }
            if !urn(&property.semantic_id) {
                issue(&mut out, &at(&path, "semantic_id"), "invalid_urn");
            }
            if property.max_age_ms == 0 || property.max_age_ms > SAFE_INTEGER as u64 {
                issue(&mut out, &at(&path, "max_age_ms"), "invalid_max_age");
            }
            let unique: BTreeSet<_> = property.access.iter().collect();
            if property.access.is_empty()
                || unique.len() != property.access.len()
                || property
                    .access
                    .iter()
                    .any(|v| !matches!(v.as_str(), "read" | "write" | "notify"))
            {
                issue(&mut out, &at(&path, "access"), "invalid_access");
            }
            if property.unit.as_ref().is_some_and(|v| {
                v.is_empty() || v.len() > 32 || !v.bytes().all(|b| b.is_ascii_graphic())
            }) {
                issue(&mut out, &at(&path, "unit"), "invalid_unit_code");
            }
            for value in schema_issues(&property.schema, &at(&path, "schema"), 0) {
                issue(&mut out, &value.path, &value.code);
            }
        }
        for (index, action) in service.actions.iter().take(32).enumerate() {
            let path = at(&at(&path, "actions"), index);
            if !local_id(&action.id) || !fields.insert(&action.id) {
                issue(
                    &mut out,
                    &at(&path, "id"),
                    "invalid_or_duplicate_identifier",
                );
            }
            if !urn(&action.semantic_id) {
                issue(&mut out, &at(&path, "semantic_id"), "invalid_urn");
            }
            if !matches!(action.risk.as_str(), "low" | "medium" | "high") {
                issue(&mut out, &at(&path, "risk"), "invalid_action_risk");
            }
            if !matches!(action.completion.as_str(), "submitted" | "observed") {
                issue(
                    &mut out,
                    &at(&path, "completion"),
                    "invalid_action_completion",
                );
            }
            for (name, schema) in [("input", &action.input), ("output", &action.output)] {
                for value in schema_issues(schema, &at(&path, name), 0) {
                    issue(&mut out, &value.path, &value.code);
                }
            }
        }
        for (index, event) in service.events.iter().take(32).enumerate() {
            let path = at(&at(&path, "events"), index);
            if !local_id(&event.id) || !fields.insert(&event.id) {
                issue(
                    &mut out,
                    &at(&path, "id"),
                    "invalid_or_duplicate_identifier",
                );
            }
            if !urn(&event.semantic_id) {
                issue(&mut out, &at(&path, "semantic_id"), "invalid_urn");
            }
            for value in schema_issues(&event.schema, &at(&path, "schema"), 0) {
                issue(&mut out, &value.path, &value.code);
            }
        }
    }
    out
}

// serde_json 的普通 Value 解析会覆盖重复字段；该访客先拒绝重复及不安全数字。
struct Strict(Value);
impl<'de> Deserialize<'de> for Strict {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Visitor;
        impl<'de> de::Visitor<'de> for Visitor {
            type Value = Strict;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("bounded interoperable JSON")
            }
            fn visit_bool<E: de::Error>(self, v: bool) -> Result<Strict, E> {
                Ok(Strict(Value::Bool(v)))
            }
            fn visit_unit<E: de::Error>(self) -> Result<Strict, E> {
                Ok(Strict(Value::Null))
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<Strict, E> {
                Ok(Strict(Value::String(v.into())))
            }
            fn visit_i64<E: de::Error>(self, v: i64) -> Result<Strict, E> {
                if v.unsigned_abs() > SAFE_INTEGER as u64 {
                    return Err(E::custom("unsafe_integer"));
                }
                Ok(Strict(Value::from(v)))
            }
            fn visit_u64<E: de::Error>(self, v: u64) -> Result<Strict, E> {
                if v > SAFE_INTEGER as u64 {
                    return Err(E::custom("unsafe_integer"));
                }
                Ok(Strict(Value::from(v)))
            }
            fn visit_f64<E: de::Error>(self, v: f64) -> Result<Strict, E> {
                if !v.is_finite() || v.fract() == 0.0 && v.abs() > SAFE_INTEGER {
                    return Err(E::custom("unsafe_number"));
                }
                Ok(Strict(Value::from(v)))
            }
            fn visit_seq<A: de::SeqAccess<'de>>(self, mut seq: A) -> Result<Strict, A::Error> {
                let mut values = Vec::new();
                while let Some(Strict(value)) = seq.next_element()? {
                    values.push(value);
                }
                Ok(Strict(Value::Array(values)))
            }
            fn visit_map<A: de::MapAccess<'de>>(self, mut map: A) -> Result<Strict, A::Error> {
                let mut values = serde_json::Map::new();
                while let Some(key) = map.next_key::<String>()? {
                    if values.contains_key(&key) {
                        return Err(de::Error::custom("duplicate_key"));
                    }
                    let Strict(value) = map.next_value()?;
                    values.insert(key, value);
                }
                Ok(Strict(Value::Object(values)))
            }
        }
        deserializer.deserialize_any(Visitor)
    }
}
fn bounded(
    value: &Value,
    depth: usize,
    nodes: &mut usize,
    max_depth: usize,
    max_nodes: usize,
) -> bool {
    *nodes += 1;
    if depth > max_depth || *nodes > max_nodes {
        return false;
    }
    match value {
        Value::Array(values) => values
            .iter()
            .all(|v| bounded(v, depth + 1, nodes, max_depth, max_nodes)),
        Value::Object(values) => values
            .values()
            .all(|v| bounded(v, depth + 1, nodes, max_depth, max_nodes)),
        _ => true,
    }
}
// 比较封装也复用严格JSON解析；每个内嵌模型仍单独执行8KiB/深度/节点限制。
/// 有界且拒绝重复键的 JSON 读取；调用方仍须验证自己的类型与业务规则。
pub fn bounded_document(
    raw: &[u8],
    max_bytes: usize,
    max_depth: usize,
    max_nodes: usize,
) -> Option<Value> {
    if raw.len() > max_bytes {
        return None;
    }
    let value = serde_json::from_slice::<Strict>(raw).ok()?.0;
    if !value.is_object()
        || !bounded(&value, 0, &mut 0, max_depth, max_nodes)
        || serde_jcs::to_vec(&value).ok()?.len() > max_bytes
    {
        return None;
    }
    Some(value)
}
pub fn validate_document(raw: &[u8]) -> Report {
    let mut report = Report {
        version: 1,
        validator: VALIDATOR,
        valid: false,
        document_digest: None,
        model_revision: None,
        normalized_model: None,
        issues: Vec::new(),
    };
    let Some(value) = bounded_document(raw, 8192, 16, 2048) else {
        issue(&mut report.issues, "", "invalid_model_document");
        return report;
    };
    let Ok(canonical) = serde_jcs::to_vec(&value) else {
        issue(&mut report.issues, "", "invalid_model_document");
        return report;
    };
    if canonical.len() > 8192 {
        issue(&mut report.issues, "", "invalid_model_document");
        return report;
    }
    report.document_digest = crate::digest(&value).ok();
    let mut decoder = serde_json::Deserializer::from_slice(&canonical);
    let model: Model = match serde_path_to_error::deserialize(&mut decoder) {
        Ok(model) => model,
        Err(error) => {
            let path = error
                .path()
                .iter()
                .fold(String::new(), |path, segment| match segment {
                    serde_path_to_error::Segment::Seq { index } => at(&path, index),
                    serde_path_to_error::Segment::Map { key }
                    | serde_path_to_error::Segment::Enum { variant: key } => at(&path, key),
                    _ => path,
                });
            issue(&mut report.issues, &path, "invalid_model_structure");
            return report;
        }
    };
    report.issues = model_issues(&model);
    report.valid = report.issues.is_empty();
    if report.valid {
        report.model_revision = crate::digest(&model).ok();
        report.normalized_model = Some(model);
    }
    report
}
