use crate::store::Store;
use std::{
    net::SocketAddr,
    sync::{atomic::AtomicBool, Arc},
};
use tokio::sync::{broadcast, Mutex, RwLock, Semaphore};

#[derive(Clone)]
pub struct App {
    pub store: Arc<Mutex<Store>>,
    pub token: Arc<String>,
    pub bus: broadcast::Sender<()>,
    pub broker: Arc<AtomicBool>,
    pub auth: Arc<crate::auth::BrowserAuth>,
    pub home_dir: Arc<String>,
    pub inference: Option<Arc<dyn crate::inference::RuleInference>>,
    pub inference_slots: Arc<Semaphore>,
    pub control: Option<Arc<crate::control_client::ControlAccess>>,
    pub connection: Arc<RwLock<crate::relay::ConnectionStatus>>,
    pub tv: Arc<crate::tv::Adapters>,
    pub audio: Arc<crate::audio::Adapters>,
    pub media: Option<Arc<crate::media::Media>>,
    pub speech: Option<Arc<crate::speech::Speech>>,
}
pub fn setting(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.into())
}
pub fn required(key: &str) -> Result<String, Box<dyn std::error::Error>> {
    let value = match (std::env::var(key), std::env::var(format!("{key}_FILE"))) {
        (Ok(_), Ok(_)) => return Err(format!("configure only {key} or {key}_FILE").into()),
        (Ok(value), Err(_)) => value,
        (Err(_), Ok(path)) => std::fs::read_to_string(path)?.trim().to_owned(),
        _ => return Err(format!("missing configuration: {key}").into()),
    };
    if value.len() < 24 {
        return Err(format!("{key} must contain at least 24 characters").into());
    }
    Ok(value)
}
impl App {
    pub async fn update<T: serde::Serialize>(
        &self,
        kind: &str,
        f: impl FnOnce(&mut limeiot_core::engine::Data) -> limeiot_core::Result<T>,
    ) -> limeiot_core::Result<T> {
        let result = self.store.lock().await.update(kind, f)?;
        let _ = self.bus.send(());
        Ok(result)
    }
}
pub async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let addr: SocketAddr = setting("LIMEIOT_LISTEN", "127.0.0.1:17880").parse()?;
    let auth = crate::auth::BrowserAuth::new(
        &setting("LIMEIOT_PUBLIC_ORIGIN", &format!("http://{addr}")),
        addr.ip().is_loopback(),
    )?;
    let config: limeiot_core::engine::Config = serde_json::from_slice(&std::fs::read(setting(
        "LIMEIOT_CONFIG",
        "deploy/dev/config.json",
    ))?)?;
    let media = crate::media::configured(&config.space_id)?;
    let speech = crate::speech::configured(media.is_some())?;
    let media_listener = if let Some(media) = &media {
        Some(tokio::net::TcpListener::bind(media.listen).await?)
    } else {
        None
    };
    let tv_adapters = crate::tv::configured()?;
    let audio_adapters = crate::audio::configured()?;
    audio_adapters.validate_with_tv(&tv_adapters)?;
    let store = Store::open(&setting("LIMEIOT_DB", ".dev/gateway.sqlite"), config)?;
    let (bus, _) = broadcast::channel(64);
    let app = App {
        store: Arc::new(Mutex::new(store)),
        token: Arc::new(required("LIMEIOT_TOKEN")?),
        bus,
        broker: Arc::new(AtomicBool::new(false)),
        auth: Arc::new(auth),
        home_dir: Arc::new(setting("LIMEIOT_HOME_DIR", "apps/home/dist")),
        inference: crate::inference::configured()?,
        inference_slots: Arc::new(Semaphore::new(1)),
        control: crate::control_client::configured()?,
        connection: Arc::new(RwLock::new(crate::relay::ConnectionStatus::default())),
        tv: Arc::new(tv_adapters.clone()),
        audio: Arc::new(audio_adapters.clone()),
        media,
        speech,
    };
    let relay_tls = crate::relay::configured(app.control.as_deref())?;
    let relay = relay_tls.map(|tls| tokio::spawn(crate::relay::run(app.clone(), tls)));
    let mqtt = tokio::spawn(crate::mqtt::run(app.clone()));
    let execution_plans = tokio::spawn(crate::execution_plan_api::run(app.clone()));
    let tv = tokio::spawn(crate::tv::run(app.clone(), tv_adapters));
    let audio = tokio::spawn(crate::audio::run(app.clone(), audio_adapters));
    let media_server =
        media_listener.map(|listener| tokio::spawn(crate::media::serve(app.clone(), listener)));
    let media_maintenance = app
        .media
        .clone()
        .map(|media| tokio::spawn(crate::media::maintenance(media)));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    println!(
        "{}",
        serde_json::json!({"event":"gateway.started","listen":addr.to_string(),"mode":"loopback_simulation"})
    );
    axum::serve(listener, crate::api::router(app))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    mqtt.abort();
    execution_plans.abort();
    tv.abort();
    audio.abort();
    if let Some(task) = media_server {
        task.abort();
    }
    if let Some(task) = media_maintenance {
        task.abort();
    }
    if let Some(task) = relay {
        task.abort();
    }
    Ok(())
}
