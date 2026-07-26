#![cfg(unix)]

use std::fs;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};

use tempfile::tempdir;

#[test]
fn json_routes_exits_cleanly_when_consumer_closes_stdout() {
    let temp = tempdir().expect("create fixture directory");
    let app = temp.path().join("app");
    fs::create_dir(&app).expect("create app directory");
    for index in 0..400 {
        let route_dir = app.join(format!("route-{index:03}"));
        fs::create_dir(&route_dir).expect("create route directory");
        fs::write(
            route_dir.join("page.tsx"),
            "export default function Page() { return null; }\n",
        )
        .expect("write route fixture");
    }
    let project = PathBuf::from(temp.path());
    let project_arg = project.to_str().expect("project path is valid UTF-8");
    let full_output = Command::new(env!("CARGO_BIN_EXE_ferrite"))
        .args(["--json", "routes", "--project", project_arg])
        .output()
        .expect("capture complete JSON output");
    assert!(full_output.status.success());
    assert!(
        full_output.stdout.len() > 8 * 1024,
        "fixture must exceed pipe capacity: {} bytes",
        full_output.stdout.len()
    );
    let mut child = Command::new(env!("CARGO_BIN_EXE_ferrite"))
        .args(["--json", "routes", "--project", project_arg])
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
