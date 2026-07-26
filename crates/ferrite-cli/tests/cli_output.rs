#![cfg(unix)]

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};

#[test]
fn json_routes_exits_cleanly_when_consumer_closes_stdout() {
    let project = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../examples/basic");
    let mut child = Command::new(env!("CARGO_BIN_EXE_ferrite"))
        .args([
            "--json",
            "routes",
            "--project",
            project.to_str().expect("project path is valid UTF-8"),
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn ferrite CLI");

    let stdout = child.stdout.take().expect("stdout is piped");
    let mut reader = BufReader::new(stdout);
    let mut first_line = String::new();
    reader.read_line(&mut first_line).expect("read JSON prefix");
    drop(reader);

    let output = child.wait_with_output().expect("wait for ferrite CLI");
    assert!(
        output.status.success(),
        "early stdout close should be clean: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        !String::from_utf8_lossy(&output.stderr).contains("panicked"),
        "broken pipe must not panic"
    );
    assert!(first_line.starts_with('{'), "expected JSON output prefix");
}
