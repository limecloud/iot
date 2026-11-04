//! 从已装配服务投影只读 AI 目录；发现不会连接提供方或产生推理任务。
use crate::{api::ApiError, application::App};
use axum::{
    extract::{Path, State},
    routing::get,
    Json, Router,
};
use limeiot_core::ensure;
use serde_json::{json, Value};

pub fn routes() -> Router<App> {
    Router::new().route("/api/v1/spaces/:space/ai-catalog", get(list))
}

pub(crate) fn services(app: &App) -> Value {
    json!({
        "inference": {"configured":app.inference.is_some(),"provider":"ollama","model":app.inference.as_ref().map(|p|p.model()),"data_location":"local","concurrency":1,"max_output_tokens":1024},
        "text":app.text.as_ref().map(|s|s.capabilities()).unwrap_or_else(||json!({"configured":false,"capability":"text.generate"})),
        "vision":app.vision.as_ref().map(|s|s.capabilities()).unwrap_or_else(||json!({"configured":false,"capability":"vision.understand"})),
        "transcription":app.transcription.as_ref().map(|s|s.capabilities()).unwrap_or_else(||json!({"configured":false,"capability":"audio.transcribe"})),
        "speech":app.speech.as_ref().map(|s|s.capabilities()).unwrap_or_else(||json!({"configured":false,"capability":"audio.synthesize"}))
    })
}

fn project(space: &str, services: &Value) -> Value {
    let contract: Value =
        serde_json::from_str(include_str!("../../../../contracts/tools/catalog.json"))
            .expect("tool catalog");
    let definitions =
        contract["schemas"]["ai-catalog"]["properties"]["definitions"]["const"].clone();
    let mut deployments = Vec::new();
    let mut health = Vec::new();
    for (capability, source) in [
        ("automation.rule_draft", "inference"),
        ("text.generate", "text"),
        ("vision.understand", "vision"),
        ("audio.transcribe", "transcription"),
        ("audio.synthesize", "speech"),
    ] {
        let service = &services[source];
        let configured = service["configured"] == true;
        health.push(json!({"capability_id":capability,"status":if configured {"unknown"} else {"not_configured"},"checked_at":null}));
        if !configured {
            continue;
        }
        let identity = if source == "inference" {
            // 旧草案接口没有部署修订，不能伪造模型版本或权重身份。
            json!({"adapter":service["provider"],"revision":null,"model":service["model"],"data_location":service["data_location"]})
        } else {
            service["deployment"].clone()
        };
        let configuration = service
            .as_object()
            .expect("service capabilities")
            .iter()
            .filter(|(key, _)| {
                ![
                    "configured",
                    "capability",
                    "deployment",
                    "provider",
                    "model",
                    "data_location",
                ]
                .contains(&key.as_str())
            })
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect::<serde_json::Map<_, _>>();
        deployments.push(
            json!({"capability_id":capability,"identity":identity,"configuration":configuration,
            "license":null,"cost_policy":null,"resource_requirements":null,"quality":null}),
        );
    }
    json!({"schema_version":1,"space_id":space,"definitions":definitions,"deployments":deployments,"health":health,
        "routing":{"selection":"fixed_configuration","automatic_fallback":false}})
}

async fn list(
    State(app): State<App>,
    Path(space): Path<String>,
) -> std::result::Result<Json<Value>, ApiError> {
    ensure(app.store.lock().await.data.space_id == space, "forbidden")?;
    Ok(Json(project(&space, &services(&app))))
}
