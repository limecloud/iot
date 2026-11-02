use std::{
    io::Write,
    process::{Command, Stdio},
};

fn run(raw: &[u8]) -> std::process::Output {
    run_args(raw, &[])
}
fn run_args(raw: &[u8], args: &[&str]) -> std::process::Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_limeiot-model-validator"))
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(raw).unwrap();
    child.wait_with_output().unwrap()
}

#[test]
fn comparison_process_uses_fixed_mode_and_distinguishes_incompatible_from_invalid() {
    let vectors: serde_json::Value = serde_json::from_str(include_str!(
        "../../../contracts/model-compatibility-vectors.json"
    ))
    .unwrap();
    for case in vectors["cases"].as_array().unwrap() {
        let output = run_args(case["raw"].as_str().unwrap().as_bytes(), &["--compare"]);
        assert_eq!(
            output.status.code(),
            Some(if case["compatible"] == true { 0 } else { 2 }),
            "{}",
            case["name"]
        );
        assert!(output.stderr.is_empty());
        assert!(output.stdout.len() < 65536);
        let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(report["valid"], case["valid"]);
        assert_eq!(report["compatible"], case["compatible"]);
    }
    for args in [vec!["--unknown"], vec!["--compare", "user-argument"]] {
        let output = run_args(b"", &args);
        assert_eq!(output.status.code(), Some(5));
        assert!(output.stdout.is_empty() && output.stderr.is_empty());
    }
}

#[test]
fn release_process_requires_explicit_trust_and_checks_signed_model() {
    let f: serde_json::Value = serde_json::from_str(include_str!(
        "../../../contracts/examples/model-release.json"
    ))
    .unwrap();
    for key in ["artifact", "upgrade"] {
        let source = serde_json::json!({"artifact":f[key],"trust":f["trust"]});
        let output = run_args(&serde_json::to_vec(&source).unwrap(), &["--verify-release"]);
        assert_eq!(output.status.code(), Some(0));
        assert!(output.stderr.is_empty());
        let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(report["valid"], true);
        // 浮点边界100.0与源100按JCS等价；核对完整制品身份而非serde内部数值分型。
        assert_eq!(
            limeiot_core::digest(&report["release"]).unwrap(),
            limeiot_core::digest(&source["artifact"]).unwrap()
        );
        assert_eq!(
            report["artifact_digest"],
            limeiot_core::digest(&source["artifact"]).unwrap()
        );
    }
    for source in [
        serde_json::json!({"artifact":f["artifact"]}),
        serde_json::json!({"artifact":f["artifact"],"trust":{}}),
    ] {
        let output = run_args(&serde_json::to_vec(&source).unwrap(), &["--verify-release"]);
        assert_eq!(output.status.code(), Some(2));
        assert!(output.stderr.is_empty());
        let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(report["valid"], false);
        assert!(report["release"].is_null());
    }
}

#[test]
fn process_contract_is_bounded_and_machine_readable() {
    for (raw, code) in [
        (
            include_bytes!("../../../contracts/models/lamp.json").as_slice(),
            0,
        ),
        (b"{}".as_slice(), 2),
        (b"{\"a\":1,\"a\":2}".as_slice(), 2),
        (vec![b' '; 8193].as_slice(), 2),
    ] {
        let output = run(raw);
        assert_eq!(output.status.code(), Some(code));
        assert!(output.stderr.is_empty());
        assert!(output.stdout.len() < 65536);
        let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(report["valid"], code == 0);
        assert_eq!(report["version"], 1);
    }
}
