use std::io::{Read, Write};

fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let mode = match args.as_slice() {
        [] => "validate",
        [mode] if mode == "--compare" => "compare",
        [mode] if mode == "--verify-release" => "verify",
        _ => std::process::exit(5),
    };
    let limit = match mode {
        "compare" => limeiot_core::compatibility::MAX_DOCUMENT_BYTES,
        "verify" => limeiot_core::release::MAX_REQUEST_BYTES,
        _ => 8192,
    };
    let mut input = Vec::new();
    if std::io::stdin()
        .take((limit + 1) as u64)
        .read_to_end(&mut input)
        .is_err()
    {
        std::process::exit(5);
    }
    let (output, valid) = if mode == "compare" {
        let report = limeiot_core::compatibility::compare_documents(&input);
        (serde_json::to_vec(&report), report.compatible == Some(true))
    } else if mode == "verify" {
        let report = limeiot_core::release::verify_document(&input, chrono::Utc::now());
        (serde_json::to_vec(&report), report.valid)
    } else {
        let report = limeiot_core::validation::validate_document(&input);
        (serde_json::to_vec(&report), report.valid)
    };
    let output = output.expect("bounded report serializes");
    if std::io::stdout().write_all(&output).is_err() {
        std::process::exit(5);
    }
    if !valid {
        std::process::exit(2);
    }
}
