use crate::store::Store;
use std::{
    future::{Future, IntoFuture},
    net::SocketAddr,
    sync::{atomic::AtomicBool, Arc},
    time::Duration,
};
use tokio::{
    sync::{broadcast, watch, Mutex, RwLock, Semaphore},
    task::JoinSet,
};

#[derive(Clone)]
pub struct App {
    pub store: Arc<Mutex<Store>>,
    pub token: Arc<String>,
    pub bus: broadcast::Sender<()>,
    pub shutdown: watch::Receiver<bool>,
    pub broker: Arc<AtomicBool>,
    pub auth: Arc<crate::auth::BrowserAuth>,
    pub home_dir: Arc<String>,
    pub inference: Option<Arc<dyn crate::inference::RuleInference>>,
    pub inference_slots: Arc<Semaphore>,
    pub control: Option<Arc<crate::control_client::ControlAccess>>,
    pub connection: Arc<RwLock<crate::relay::ConnectionStatus>>,
    pub integrations: Arc<crate::integrations::Registry>,
    pub media: Option<Arc<crate::media::Media>>,
    pub speech: Option<Arc<crate::speech::Speech>>,
    pub transcription: Option<Arc<crate::transcription::Transcription>>,
    pub vision: Option<Arc<crate::vision::Vision>>,
    pub text: Option<Arc<crate::text::Text>>,
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
    pub async fn wait_for_shutdown(&self) {
        let mut shutdown = self.shutdown.clone();
        let _ = shutdown.wait_for(|stopping| *stopping).await;
    }

    fn spawn_background(
        &self,
        tasks: &mut JoinSet<()>,
        work: impl Future<Output = ()> + Send + 'static,
    ) {
        let app = self.clone();
        tasks.spawn(async move {
            tokio::select! {
                biased;
                _ = app.wait_for_shutdown() => {},
                _ = work => {},
            }
        });
    }

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
    let transcription = crate::transcription::configured(media.is_some())?;
    let vision = crate::vision::configured(media.is_some())?;
    let text = crate::text::configured(media.is_some())?;
    let media_listener = if let Some(media) = &media {
        Some(tokio::net::TcpListener::bind(media.listen).await?)
    } else {
        None
    };
    let integrations = Arc::new(crate::integrations::Registry::configured()?);
    let sources = integrations.observation_sources();
    let bridges = integrations.property_bridges();
    let database = setting("LIMEIOT_DB", ".dev/gateway.sqlite");
    let store = if sources.is_empty() && bridges.is_empty() {
        Store::open(&database, config)?
    } else {
        Store::open_with_adapter_policies(&database, config, &sources, &bridges)?
    };
    let (bus, _) = broadcast::channel(64);
    let (shutdown_signal, shutdown) = watch::channel(false);
    let app = App {
        store: Arc::new(Mutex::new(store)),
        token: Arc::new(required("LIMEIOT_TOKEN")?),
        bus,
        shutdown,
        broker: Arc::new(AtomicBool::new(false)),
        auth: Arc::new(auth),
        home_dir: Arc::new(setting("LIMEIOT_HOME_DIR", "apps/home/dist")),
        inference: crate::inference::configured()?,
        inference_slots: Arc::new(Semaphore::new(1)),
        control: crate::control_client::configured()?,
        connection: Arc::new(RwLock::new(crate::relay::ConnectionStatus::default())),
        integrations: integrations.clone(),
        media,
        speech,
        transcription,
        vision,
        text,
    };
    let relay_tls = crate::relay::configured(app.control.as_deref())?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    // 在启动任务前注册信号；Unix容器的SIGTERM与开发环境SIGINT共用同一关停路径。
    #[cfg(unix)]
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    #[cfg(unix)]
    let mut interrupt = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())?;
    #[cfg(unix)]
    let stop_signal = async move {
        tokio::select! {
            _ = terminate.recv() => "SIGTERM",
            _ = interrupt.recv() => "SIGINT",
        }
    };
    #[cfg(not(unix))]
    let stop_signal = async {
        let _ = tokio::signal::ctrl_c().await;
        "SIGINT"
    };
    let mut tasks = JoinSet::new();
    if let Some(tls) = relay_tls {
        app.spawn_background(&mut tasks, crate::relay::run(app.clone(), tls));
    }
    app.spawn_background(&mut tasks, crate::mqtt::run(app.clone()));
    app.spawn_background(&mut tasks, crate::execution_plan_api::run(app.clone()));
    integrations.start(&app, &mut tasks);
    if let Some(listener) = media_listener {
        app.spawn_background(&mut tasks, crate::media::serve(app.clone(), listener));
    }
    if let Some(media) = &app.media {
        app.spawn_background(&mut tasks, crate::media::maintenance(media.clone()));
    }
    println!(
        "{}",
        serde_json::json!({"event":"gateway.started","listen":addr.to_string(),"mode":"loopback_simulation"})
    );
    let signal = shutdown_signal.clone();
    let mut server = Box::pin(
        axum::serve(listener, crate::api::router(app.clone()))
            .with_graceful_shutdown(async move {
                let name = stop_signal.await;
                println!(
                    "{}",
                    serde_json::json!({"event":"gateway.stopping","signal":name})
                );
                signal.send_replace(true);
            })
            .into_future(),
    );
    let mut http_drained = true;
    let result = tokio::select! {
        result = &mut server => result,
        _ = app.wait_for_shutdown() => {
            // SSE由同一信号结束；未完成请求体等客户端等待不能无限阻止进程退出。
            match tokio::time::timeout(Duration::from_secs(3), &mut server).await {
                Ok(result) => result,
                Err(_) => {
                    http_drained = false;
                    eprintln!("{}", serde_json::json!({"event":"gateway.http_drain_timeout"}));
                    Ok(())
                }
            }
        }
    };
    shutdown_signal.send_replace(true);
    drop(server);
    // 回收顶层任务；集成父任务会先取消并等待其子任务，确保串口RAII已执行。
    while tasks.join_next().await.is_some() {}
    println!(
        "{}",
        serde_json::json!({"event":"gateway.stopped","http_drained":http_drained})
    );
    result?;
    Ok(())
}
