use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{
    fs,
    path::PathBuf,
    process::{Command, Output},
};

struct Files(PathBuf);
impl Files {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("limeiot-ota-{}", limeiot_core::id()));
        fs::create_dir(&path).unwrap();
        let f: Value = serde_json::from_str(include_str!(
            "../../../contracts/examples/ota-firmware.json"
        ))
        .unwrap();
        fs::write(
            path.join("request.json"),
            serde_json::to_vec(&f["request"]).unwrap(),
        )
        .unwrap();
        fs::write(
            path.join("image.bin"),
            STANDARD
                .decode(f["image_base64"].as_str().unwrap())
                .unwrap(),
        )
        .unwrap();
        Self(path)
    }
    fn run(&self) -> Output {
        Command::new(env!("CARGO_BIN_EXE_limeiot-ota"))
            .args(["verify", "--input"])
            .arg(self.0.join("request.json"))
            .arg("--image")
            .arg(self.0.join("image.bin"))
            .output()
            .unwrap()
    }
}
impl Drop for Files {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn offline_file_verification_returns_bounded_json_and_does_not_modify_input() {
    let files = Files::new();
    let before = fs::read(files.0.join("request.json")).unwrap();
    let output = files.run();
    assert_eq!(output.status.code(), Some(0), "{:?}", output);
    assert!(output.stderr.is_empty());
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["valid"], true);
    assert_eq!(report["verifier"], "limeiot.ota/1.0.0");
    assert_eq!(fs::read(files.0.join("request.json")).unwrap(), before);
    assert_eq!(fs::read_dir(&files.0).unwrap().count(), 2);
    fs::write(files.0.join("image.bin"), b"corrupt").unwrap();
    let output = files.run();
    assert_eq!(output.status.code(), Some(2));
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["issues"][0]["code"], "ota_image_size_mismatch");
    fs::write(
        files.0.join("request.json"),
        b"{\"manifest\":{},\"manifest\":{}}",
    )
    .unwrap();
    let output = files.run();
    assert_eq!(output.status.code(), Some(2));
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stdout).unwrap()["request_digest"],
        Value::Null
    );
}

#[test]
fn discovery_is_self_contained_and_argument_and_io_failures_do_not_disclose_paths() {
    let binary = env!("CARGO_BIN_EXE_limeiot-ota");
    let output = Command::new(binary).arg("schema").output().unwrap();
    assert!(output.status.success());
    let catalog: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(catalog["operations"][0]["operation_id"], "ota.verify");
    assert_eq!(
        catalog["schemas"]["verification"]["$defs"]["trust"]["properties"]["purpose"],
        json!({"const":"device-firmware"})
    );
    for args in [
        vec![],
        vec!["verify"],
        vec!["install"],
        vec!["schema", "extra"],
        vec!["verify", "--input", "secret-name", "--input", "secret-name"],
    ] {
        let output = Command::new(binary).args(args).output().unwrap();
        assert_eq!(output.status.code(), Some(2));
        assert!(output.stdout.is_empty());
        assert_eq!(
            serde_json::from_slice::<Value>(&output.stderr).unwrap()["error"]["code"],
            "ota_arguments_required"
        );
        assert!(!String::from_utf8(output.stderr)
            .unwrap()
            .contains("secret-name"));
    }
    let files = Files::new();
    fs::remove_file(files.0.join("image.bin")).unwrap();
    let output = files.run();
    assert_eq!(output.status.code(), Some(5));
    assert!(output.stdout.is_empty());
    assert_eq!(
        serde_json::from_slice::<Value>(&output.stderr).unwrap()["error"]["code"],
        "ota_image_io"
    );
}

#[cfg(unix)]
#[test]
fn symlinks_directories_and_fifos_are_rejected_without_following_or_blocking() {
    use std::os::unix::fs::symlink;
    let files = Files::new();
    let image = files.0.join("image.bin");
    fs::rename(&image, files.0.join("original.bin")).unwrap();
    symlink(files.0.join("original.bin"), &image).unwrap();
    assert_eq!(files.run().status.code(), Some(5));
    fs::remove_file(&image).unwrap();
    assert!(Command::new("mkfifo")
        .arg(&image)
        .status()
        .unwrap()
        .success());
    assert_eq!(files.run().status.code(), Some(5));
    fs::remove_file(&image).unwrap();
    fs::create_dir(&image).unwrap();
    assert_eq!(files.run().status.code(), Some(5));
}
