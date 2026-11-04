mod ai_catalog;
mod api;
mod application;
mod auth;
mod commissioning;
mod control_api;
mod control_client;
mod execution_api;
mod execution_plan_api;
mod identity;
mod inference;
mod integrations;
mod local_provider;
mod media;
mod media_store;
mod model_api;
mod model_bundles;
mod mqtt;
mod observation_api;
mod ota_api;
mod relay;
mod relay_rpc;
mod speech;
mod store;
mod text;
mod text_store;
mod transcription;
mod vision;
mod vision_store;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if !args.is_empty() {
        if args.len() != 2 || args[0] != "identity-init" {
            return Err("usage: limeiot-gateway identity-init <new-private-key-file>".into());
        };
        let identity = identity::MachineIdentity::create(std::path::Path::new(&args[1]))?;
        println!(
            "{}",
            serde_json::json!({"gateway_id":identity.gateway_id(),"public_key":identity.public()})
        );
        return Ok(());
    }
    application::run().await
}
