mod api;
mod application;
mod auth;
mod control_api;
mod control_client;
mod identity;
mod inference;
mod mqtt;
mod relay;
mod store;

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
