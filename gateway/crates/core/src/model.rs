use crate::{ensure, err, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

// 可选关键字允许省略，但显式 null 不是受支持的 Schema 定义。
fn present<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> std::result::Result<Option<T>, D::Error> {
    T::deserialize(deserializer).map(Some)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Schema {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub minimum: Option<f64>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub maximum: Option<f64>,
    #[serde(
        default,
        deserialize_with = "present",
        rename = "enum",
        skip_serializing_if = "Option::is_none"
    )]
    pub values: Option<Vec<Value>>,
    #[serde(
        default,
        deserialize_with = "present",
        rename = "minLength",
        skip_serializing_if = "Option::is_none"
    )]
    pub min_length: Option<usize>,
    #[serde(
        default,
        deserialize_with = "present",
        rename = "maxLength",
        skip_serializing_if = "Option::is_none"
    )]
    pub max_length: Option<usize>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub properties: BTreeMap<String, Schema>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub required: Vec<String>,
    #[serde(
        default,
        deserialize_with = "present",
        rename = "additionalProperties",
        skip_serializing_if = "Option::is_none"
    )]
    pub additional: Option<bool>,
}
impl Schema {
    pub fn validate_definition(&self, depth: usize) -> Result<()> {
        crate::validation::first_error(crate::validation::schema_issues(self, "", depth))
    }
    pub fn validate(&self, value: &Value) -> Result<()> {
        let valid = match self.kind.as_str() {
            "boolean" => value.is_boolean(),
            "integer" => value
                .as_f64()
                .map(|v| v.is_finite() && v.fract() == 0.0 && v.abs() <= 9_007_199_254_740_991.0)
                .unwrap_or(false),
            "number" => value
                .as_f64()
                .map(|v| v.is_finite() && (v.fract() != 0.0 || v.abs() <= 9_007_199_254_740_991.0))
                .unwrap_or(false),
            "string" => value
                .as_str()
                .map(|v| {
                    v.chars().count() <= self.max_length.unwrap_or(4096)
                        && v.chars().count() >= self.min_length.unwrap_or(0)
                })
                .unwrap_or(false),
            "object" => value
                .as_object()
                .map(|obj| {
                    self.required.iter().all(|k| obj.contains_key(k))
                        && obj.iter().all(|(k, v)| {
                            self.properties
                                .get(k)
                                .map(|s| s.validate(v).is_ok())
                                .unwrap_or(self.additional == Some(true))
                        })
                })
                .unwrap_or(false),
            _ => false,
        };
        ensure(valid, "invalid_value")?;
        if let Some(number) = value.as_f64() {
            ensure(
                self.minimum.map(|min| number >= min).unwrap_or(true)
                    && self.maximum.map(|max| number <= max).unwrap_or(true),
                "invalid_value",
            )?;
        }
        ensure(
            self.values
                .as_ref()
                .map(|items| {
                    crate::digest(value).is_ok_and(|digest| {
                        items
                            .iter()
                            .any(|item| crate::digest(item).is_ok_and(|other| other == digest))
                    })
                })
                .unwrap_or(true),
            "invalid_value",
        )
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Property {
    pub id: String,
    pub semantic_id: String,
    pub schema: Schema,
    pub access: Vec<String>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub unit: Option<String>,
    pub max_age_ms: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Event {
    pub id: String,
    pub semantic_id: String,
    pub schema: Schema,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActionDefinition {
    pub id: String,
    pub semantic_id: String,
    pub input: Schema,
    pub output: Schema,
    pub idempotent: bool,
    pub risk: String,
    // submitted 只确认输入已交给执行系统；observed 才确认定义要求的实际效果。
    pub completion: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Service {
    pub id: String,
    pub semantic_id: String,
    pub properties: Vec<Property>,
    pub actions: Vec<ActionDefinition>,
    pub events: Vec<Event>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Model {
    pub schema_version: u8,
    pub model_id: String,
    pub model_version: String,
    pub services: Vec<Service>,
}
impl Model {
    pub fn validate(&self) -> Result<()> {
        crate::validation::first_error(crate::validation::model_issues(self))
    }
    pub fn property(&self, path: &str) -> Result<&Property> {
        let (service, property) = path
            .split_once('.')
            .ok_or_else(|| err("unsupported_capability"))?;
        self.services
            .iter()
            .find(|s| s.id == service)
            .and_then(|s| s.properties.iter().find(|p| p.id == property))
            .ok_or_else(|| err("unsupported_capability"))
    }
    pub fn event(&self, path: &str) -> Result<&Event> {
        let (service, event) = path
            .split_once('.')
            .ok_or_else(|| err("unsupported_capability"))?;
        self.services
            .iter()
            .find(|s| s.id == service)
            .and_then(|s| s.events.iter().find(|p| p.id == event))
            .ok_or_else(|| err("unsupported_capability"))
    }
    pub fn action(&self, path: &str) -> Result<&ActionDefinition> {
        let (service, action) = path
            .split_once('.')
            .ok_or_else(|| err("unsupported_capability"))?;
        self.services
            .iter()
            .find(|s| s.id == service)
            .and_then(|s| s.actions.iter().find(|a| a.id == action))
            .ok_or_else(|| err("unsupported_capability"))
    }
    pub fn operation(&self, operation: &crate::protocol::Operation) -> Result<()> {
        match operation.kind.as_str() {
            "property.set" => self.write(&operation.path, &operation.value),
            "action.invoke" => self
                .action(&operation.path)?
                .input
                .validate(&operation.value),
            _ => Err(err("unsupported_capability")),
        }
    }
    pub fn write(&self, path: &str, value: &Value) -> Result<()> {
        let property = self.property(path)?;
        ensure(
            property.access.iter().any(|a| a == "write"),
            "property_read_only",
        )?;
        property.schema.validate(value)
    }
}
pub(crate) fn local_id(value: &str) -> bool {
    value.len() <= 64
        && value
            .as_bytes()
            .first()
            .map(|b| b.is_ascii_lowercase())
            .unwrap_or(false)
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
}
