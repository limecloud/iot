use crate::{ensure, err, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Schema {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub minimum: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub maximum: Option<f64>,
    #[serde(default, rename = "enum", skip_serializing_if = "Option::is_none")]
    pub values: Option<Vec<Value>>,
    #[serde(default, rename = "minLength", skip_serializing_if = "Option::is_none")]
    pub min_length: Option<usize>,
    #[serde(default, rename = "maxLength", skip_serializing_if = "Option::is_none")]
    pub max_length: Option<usize>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub properties: BTreeMap<String, Schema>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub required: Vec<String>,
    #[serde(
        default,
        rename = "additionalProperties",
        skip_serializing_if = "Option::is_none"
    )]
    pub additional: Option<bool>,
}
impl Schema {
    pub fn validate_definition(&self, depth: usize) -> Result<()> {
        ensure(
            depth <= 4
                && matches!(
                    self.kind.as_str(),
                    "boolean" | "integer" | "number" | "string" | "object"
                ),
            "unsupported_schema",
        )?;
        if let (Some(min), Some(max)) = (self.minimum, self.maximum) {
            ensure(min <= max, "invalid_schema")?;
        }
        ensure(
            self.properties.len() <= 32
                && self
                    .required
                    .iter()
                    .all(|k| self.properties.contains_key(k)),
            "invalid_schema",
        )?;
        for child in self.properties.values() {
            child.validate_definition(depth + 1)?;
        }
        Ok(())
    }
    pub fn validate(&self, value: &Value) -> Result<()> {
        let valid = match self.kind.as_str() {
            "boolean" => value.is_boolean(),
            "integer" => value
                .as_i64()
                .map(|v| v.unsigned_abs() <= 9_007_199_254_740_991)
                .unwrap_or(false),
            "number" => value.as_f64().map(|v| v.is_finite()).unwrap_or(false),
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
                .map(|items| items.contains(value))
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
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
pub struct Service {
    pub id: String,
    pub semantic_id: String,
    pub properties: Vec<Property>,
    pub actions: Vec<Value>,
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
        ensure(
            self.schema_version == 1
                && self.model_id.starts_with("urn:")
                && self.services.len() <= 16
                && !self.services.is_empty(),
            "invalid_model",
        )?;
        let version: Vec<_> = self.model_version.split('.').collect();
        ensure(
            version.len() == 3
                && version
                    .iter()
                    .all(|v| !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit())),
            "invalid_model",
        )?;
        let mut names = BTreeSet::new();
        for service in &self.services {
            ensure(
                local_id(&service.id)
                    && names.insert(&service.id)
                    && service.semantic_id.starts_with("urn:")
                    && service.actions.is_empty(),
                "unsupported_model",
            )?;
            let mut fields = BTreeSet::new();
            for property in &service.properties {
                ensure(
                    local_id(&property.id)
                        && fields.insert(&property.id)
                        && property.max_age_ms > 0
                        && !property.access.is_empty()
                        && property
                            .access
                            .iter()
                            .all(|v| matches!(v.as_str(), "read" | "write" | "notify")),
                    "invalid_model",
                )?;
                property.schema.validate_definition(0)?;
            }
            for event in &service.events {
                ensure(
                    local_id(&event.id) && fields.insert(&event.id),
                    "invalid_model",
                )?;
                event.schema.validate_definition(0)?;
            }
        }
        Ok(())
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
    pub fn write(&self, path: &str, value: &Value) -> Result<()> {
        let property = self.property(path)?;
        ensure(
            property.access.iter().any(|a| a == "write"),
            "property_read_only",
        )?;
        property.schema.validate(value)
    }
}
fn local_id(value: &str) -> bool {
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
