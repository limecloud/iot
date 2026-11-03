#![cfg(unix)]
use limeiot_android_tv::{Adapter, ApplicationGrant, Config, LaunchCategory, Stage};
use limeiot_core::protocol::Operation;
use serde_json::{json, Value};
use std::{
    fs,
    io::Write,
    os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    path::PathBuf,
    sync::OnceLock,
    time::Duration,
};
use tokio::time::Instant;

const FINGERPRINT: &str = "Xiaomi/xmen/xmen:6.0.1/MHC19J/2061:user/release-keys";
const FAKE: &str = include_str!("../../../../tests/fixtures/android-tv/adb.py");

fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn python() -> &'static str {
    static PYTHON: OnceLock<String> = OnceLock::new();
    PYTHON.get_or_init(|| {
        let output = std::process::Command::new("python3")
            .args([
                "-c",
                "import json,os,sys; print(json.dumps(os.path.realpath(sys.executable)))",
            ])
            .output()
            .unwrap();
        assert!(output.status.success());
        let executable: String = serde_json::from_slice(&output.stdout).unwrap();
        assert!(std::path::Path::new(&executable).is_absolute());
        assert!(!executable.contains(['\0', '\r', '\n']));
        executable
    })
}

struct Fixture {
    directory: PathBuf,
    config: Config,
}
impl Fixture {
    fn new(scenario: Value) -> Self {
        let directory = std::env::temp_dir().join(format!("limeiot-adb-{}", limeiot_core::id()));
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&directory)
            .unwrap();
        let binary = directory.join("adb-fixture");
        let source = directory.join("adb-fixture.py");
        fs::write(&source, FAKE).unwrap();
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o700)
            .open(&binary)
            .unwrap();
        let launcher = format!(
            "#!/bin/sh\nexec {} {} \"$@\"\n",
            quote(python()),
            quote(source.to_str().unwrap())
        );
        file.write_all(launcher.as_bytes()).unwrap();
        fs::write(directory.join("scenario.json"), scenario.to_string()).unwrap();
        let config = Config {
            schema_version: 1,
            adb_path: binary,
            state_directory: directory.clone(),
            server_port: 5049,
            target: "192.168.31.94:5555".parse().unwrap(),
            fingerprint: FINGERPRINT.into(),
            device_serial: "sample-tv-001".into(),
            timeout_ms: 3000,
            applications: vec![ApplicationGrant {
                application_id: "com.example.player".into(),
                category: LaunchCategory::Leanback,
            }],
        };
        Self { directory, config }
    }
    fn adapter(&self) -> Adapter {
        Adapter::new(self.config.clone()).unwrap()
    }
    fn lines(&self, filename: &str) -> Vec<Value> {
        fs::read_to_string(self.directory.join(filename))
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }
}
fn operation(path: &str, value: Value) -> Operation {
    Operation {
        kind: "action.invoke".into(),
        path: path.into(),
        value,
    }
}
fn deadline() -> Instant {
    Instant::now() + Duration::from_secs(5)
}

#[tokio::test]
async fn fixed_target_all_nine_keys_and_environment_are_bounded() {
    let fixture = Fixture::new(json!({}));
    let adapter = fixture.adapter();
    for (key, code) in [
        ("up", "19"),
        ("down", "20"),
        ("left", "21"),
        ("right", "22"),
        ("select", "23"),
        ("back", "4"),
        ("home", "3"),
        ("menu", "82"),
        ("play_pause", "85"),
    ] {
        let outcome = adapter
            .execute(&operation("remote.press", json!({"key":key})), deadline())
            .await;
        assert_eq!(outcome.stage, Stage::Submitted);
        assert_eq!(outcome.error, None);
        assert_eq!(
            fixture.lines("effects.jsonl").last().unwrap(),
            &json!(["shell", "input", "keyevent", code])
        );
    }
    assert_eq!(fixture.lines("effects.jsonl").len(), 9);
    let calls = fixture.lines("calls.jsonl");
    assert_eq!(calls.len(), 18, "每次按键只进行一次完整身份预检");
    for pair in calls.chunks_exact(2) {
        assert_eq!(
            pair[0]["args"].as_array().unwrap()[6..],
            json!([
                "shell",
                "getprop ro.build.fingerprint && getprop ro.serialno"
            ])
            .as_array()
            .unwrap()[..]
        );
    }
    for call in fixture.lines("calls.jsonl") {
        assert_eq!(
            call["env"]["ANDROID_USER_HOME"],
            fixture.directory.to_str().unwrap()
        );
        assert_eq!(
            call["env"]["ADB_VENDOR_KEYS"],
            fixture.directory.join("adbkey").to_str().unwrap()
        );
        assert!(call["env"]["ADB_SERVER_SOCKET"].is_null());
        assert!(call["env"]["LIMEIOT_TOKEN"].is_null());
    }
}

#[tokio::test]
async fn complete_crlf_identity_is_accepted_without_fallback_queries() {
    let fixture = Fixture::new(json!({
        "raw_identity":format!("{FINGERPRINT}\r\nsample-tv-001\r\n")
    }));
    let found = fixture.adapter().discover(deadline()).await.unwrap();
    assert_eq!(found.fingerprint, FINGERPRINT);
    assert!(found.applications.contains("com.example.player"));
    assert_eq!(fixture.lines("calls.jsonl").len(), 2);
    assert!(fixture.lines("effects.jsonl").is_empty());
}

#[tokio::test]
async fn incomplete_extra_or_mismatched_identity_never_authorizes_an_action() {
    for raw in [
        String::new(),
        format!("{FINGERPRINT}\n"),
        format!("{FINGERPRINT}\nsample-tv-001"),
        format!("{FINGERPRINT}\nsample-tv-001\n\n"),
        format!("{FINGERPRINT}\nsample-tv-001\nextra\n"),
        format!("sample-tv-001\n{FINGERPRINT}\n"),
        format!("{FINGERPRINT}\n\n"),
        "\nsample-tv-001\n".into(),
        format!(" {FINGERPRINT}\nsample-tv-001\n"),
        format!("{FINGERPRINT}\nsample-tv-001\r\r\n"),
    ] {
        let fixture = Fixture::new(json!({"raw_identity":raw}));
        let authorized = std::sync::atomic::AtomicBool::new(false);
        let outcome = fixture
            .adapter()
            .execute_authorized(
                &operation("remote.press", json!({"key":"home"})),
                deadline(),
                || async {
                    authorized.store(true, std::sync::atomic::Ordering::SeqCst);
                    Ok(())
                },
            )
            .await;
        assert_eq!(outcome.stage, Stage::Rejected, "{raw:?}");
        assert!(!authorized.load(std::sync::atomic::Ordering::SeqCst));
        assert_eq!(fixture.lines("calls.jsonl").len(), 1);
        assert!(fixture.lines("effects.jsonl").is_empty());
    }
    for fault in ["stderr", "invalid_utf8"] {
        let fixture = Fixture::new(json!({"probe_fault":fault}));
        let outcome = fixture
            .adapter()
            .execute(
                &operation("remote.press", json!({"key":"home"})),
                deadline(),
            )
            .await;
        assert_eq!(outcome.stage, Stage::Rejected);
        assert_eq!(outcome.error, Some("tv_probe_failed"));
        assert_eq!(fixture.lines("calls.jsonl").len(), 1);
        assert!(fixture.lines("effects.jsonl").is_empty());
    }
}

#[tokio::test]
async fn identity_and_inventory_share_the_original_operation_deadline() {
    let fixture = Fixture::new(json!({"probe_delay_ms":1700,"packages_delay_ms":1700}));
    let outcome = fixture
        .adapter()
        .execute(
            &operation(
                "apps.launch",
                json!({"application_id":"com.example.player"}),
            ),
            deadline(),
        )
        .await;
    assert_eq!(outcome.stage, Stage::Rejected);
    assert_eq!(outcome.error, Some("tv_probe_failed"));
    assert_eq!(fixture.lines("calls.jsonl").len(), 2);
    assert!(fixture.lines("effects.jsonl").is_empty());
}

#[tokio::test]
async fn malformed_and_unapproved_operations_produce_no_process_or_effect() {
    let fixture = Fixture::new(json!({}));
    let adapter = fixture.adapter();
    let mut bad = vec![
        operation("remote.press", json!({"key":"power"})),
        operation("remote.press", json!({"key":"home","target":"192.168.1.2"})),
        operation("remote.press", json!({"key":"home;reboot"})),
        operation("remote.press", json!({})),
        operation("remote.press", json!("home")),
        operation("shell.exec", json!({"command":"id"})),
        operation(
            "apps.launch",
            json!({"application_id":"com.android.settings"}),
        ),
        operation(
            "apps.launch",
            json!({"application_id":"com.example.player","intent":"reboot"}),
        ),
        operation(
            "apps.launch",
            json!({"application_id":"com.example.player;reboot"}),
        ),
        operation("apps.launch", json!({"application_id":"com.example.$(id)"})),
        operation("apps.launch", json!({"application_id":"com..player"})),
    ];
    let mut property = operation("remote.press", json!({"key":"home"}));
    property.kind = "property.set".into();
    bad.push(property);
    for input in bad {
        assert_eq!(
            adapter.execute(&input, deadline()).await.stage,
            Stage::Rejected
        );
    }
    assert!(fixture.lines("calls.jsonl").is_empty());
    assert!(fixture.lines("effects.jsonl").is_empty());
}

#[tokio::test]
async fn discovery_and_current_application_grants_are_separate() {
    let fixture = Fixture::new(json!({}));
    let adapter = fixture.adapter();
    let found = adapter.discover(deadline()).await.unwrap();
    assert_eq!(found.fingerprint, FINGERPRINT);
    assert_eq!(found.source, "android-tv-adb");
    assert!(found.applications.contains("com.android.settings"));
    assert!(found.applications.contains("android"));
    assert!(fixture.lines("effects.jsonl").is_empty());
    let denied = adapter
        .execute(
            &operation(
                "apps.launch",
                json!({"application_id":"com.android.settings"}),
            ),
            deadline(),
        )
        .await;
    assert_eq!(denied.error, Some("tv_application_forbidden"));
    let launched = adapter
        .execute(
            &operation(
                "apps.launch",
                json!({"application_id":"com.example.player"}),
            ),
            deadline(),
        )
        .await;
    assert_eq!(launched.stage, Stage::Submitted);
    assert_eq!(
        fixture.lines("effects.jsonl"),
        vec![json!([
            "shell",
            "am",
            "start",
            "-W",
            "-a",
            "android.intent.action.MAIN",
            "-c",
            "android.intent.category.LEANBACK_LAUNCHER",
            "-p",
            "com.example.player"
        ])]
    );
    // 安装/启用状态变化后必须重新发现，不能复用旧清单继续启动。
    fs::write(
        fixture.directory.join("scenario.json"),
        json!({"packages":[]}).to_string(),
    )
    .unwrap();
    let absent = adapter
        .execute(
            &operation(
                "apps.launch",
                json!({"application_id":"com.example.player"}),
            ),
            deadline(),
        )
        .await;
    assert_eq!(absent.error, Some("tv_application_unavailable"));
    assert_eq!(fixture.lines("effects.jsonl").len(), 1);
}

#[tokio::test]
async fn wrong_identity_probe_failure_and_bad_inventory_never_send_actions() {
    for scenario in [
        json!({"device_serial":"another-tv"}),
        json!({"fingerprint":"other/device/build:1.0/key:user/test"}),
        json!({"probe_failure":true}),
        json!({"raw_packages":"package:com.example.player\nmalformed\n"}),
        json!({"raw_packages":"package:com.example.player\npackage:com.example.player\n"}),
    ] {
        let fixture = Fixture::new(scenario);
        let adapter = fixture.adapter();
        assert!(adapter.discover(deadline()).await.is_err());
        let outcome = adapter
            .execute(
                &operation(
                    "apps.launch",
                    json!({"application_id":"com.example.player"}),
                ),
                deadline(),
            )
            .await;
        assert_eq!(outcome.stage, Stage::Rejected);
        assert!(fixture.lines("effects.jsonl").is_empty());
    }
}

#[tokio::test]
async fn authorization_is_rechecked_after_discovery_and_before_any_side_effect() {
    let fixture = Fixture::new(json!({}));
    let adapter = fixture.adapter();
    let outcome = adapter
        .execute_authorized(
            &operation(
                "apps.launch",
                json!({"application_id":"com.example.player"}),
            ),
            deadline(),
            || async { Err(limeiot_core::err("revoked")) },
        )
        .await;
    assert_eq!(outcome.stage, Stage::Rejected);
    assert_eq!(outcome.error, Some("tv_authorization_rejected"));
    assert!(!fixture.lines("calls.jsonl").is_empty());
    assert!(fixture.lines("effects.jsonl").is_empty());
}

#[tokio::test]
async fn ambiguous_process_results_are_unknown_with_one_attempt_and_no_diagnostics() {
    for fault in [
        "timeout",
        "output_limit",
        "stderr_limit",
        "stderr",
        "exit",
        "am_error",
        "invalid_utf8",
    ] {
        let fixture = Fixture::new(json!({"fault":fault}));
        let outcome = fixture
            .adapter()
            .execute(
                &operation(
                    "apps.launch",
                    json!({"application_id":"com.example.player"}),
                ),
                deadline(),
            )
            .await;
        assert_eq!(outcome.stage, Stage::Unknown, "{fault}");
        assert_eq!(outcome.error, Some("execution_unknown"));
        assert_eq!(fixture.lines("effects.jsonl").len(), 1, "{fault}");
        assert!(!serde_json::to_string(&outcome)
            .unwrap()
            .contains("private-device-diagnostic"));
        let pid = fs::read_to_string(fixture.directory.join("child.pid")).unwrap();
        let status = std::process::Command::new("/bin/ps")
            .args(["-p", pid.trim(), "-o", "pid="])
            .output()
            .unwrap();
        assert!(!status.status.success(), "child must be reaped: {fault}");
    }
}

#[tokio::test]
async fn expired_and_queued_expired_actions_never_reach_the_device() {
    let fixture = Fixture::new(json!({}));
    let adapter = fixture.adapter();
    let operation = operation("remote.press", json!({"key":"home"}));
    let expired = adapter
        .execute(&operation, Instant::now() - Duration::from_millis(1))
        .await;
    assert_eq!(expired.stage, Stage::Rejected);
    assert!(fixture.lines("effects.jsonl").is_empty());
    // 当前执行占用锁时，后续短期限命令不能等到超时后再执行。
    fs::write(
        fixture.directory.join("scenario.json"),
        json!({"fault":"timeout"}).to_string(),
    )
    .unwrap();
    let (first, second) = tokio::join!(
        adapter.execute(&operation, Instant::now() + Duration::from_secs(4)),
        adapter.execute(&operation, Instant::now() + Duration::from_millis(50))
    );
    assert_eq!(first.stage, Stage::Unknown);
    assert_eq!(second.stage, Stage::Rejected);
    assert_eq!(fixture.lines("effects.jsonl").len(), 1);
}

#[test]
fn configuration_rejects_global_server_public_targets_and_duplicate_grants() {
    let fixture = Fixture::new(json!({}));
    for invalid in [
        {
            let mut c = fixture.config.clone();
            c.server_port = 5037;
            c
        },
        {
            let mut c = fixture.config.clone();
            c.target = "8.8.8.8:5555".parse().unwrap();
            c
        },
        {
            let mut c = fixture.config.clone();
            c.target = "127.0.0.1:5555".parse().unwrap();
            c
        },
        {
            let mut c = fixture.config.clone();
            c.timeout_ms = 5001;
            c
        },
        {
            let mut c = fixture.config.clone();
            c.applications.push(c.applications[0].clone());
            c
        },
        {
            let mut c = fixture.config.clone();
            c.adb_path = "adb".into();
            c
        },
    ] {
        assert!(Adapter::new(invalid).is_err());
    }
    let mut unknown = serde_json::to_value(&fixture.config).unwrap();
    unknown["shell"] = json!("reboot");
    assert!(serde_json::from_value::<Config>(unknown).is_err());
    let link = fixture.directory.join("adb-link");
    std::os::unix::fs::symlink(&fixture.config.adb_path, &link).unwrap();
    let mut symbolic = fixture.config.clone();
    symbolic.adb_path = link;
    assert!(Adapter::new(symbolic).is_err());
}
