#![cfg(unix)]

use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use ferrite_builder::{
    FERRITE_PRODUCTION_ARTIFACT_MANIFEST, ProductionArtifactManifest, ProductionArtifactRoute,
    artifact_file_record,
};
use ferrite_client_bundler::ClientBundle;

struct ChildGuard {
    child: Child,
    process_group: u32,
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = signal_process_group(self.process_group, "-KILL");
        let _ = self.child.wait();
    }
}

fn spawn_guarded(command: &mut Command) -> std::io::Result<ChildGuard> {
    command.process_group(0);
    let child = command.spawn()?;
    let process_group = child.id();
    Ok(ChildGuard {
        child,
        process_group,
    })
}

fn signal_process_group(
    process_group: u32,
    signal: &str,
) -> std::io::Result<std::process::ExitStatus> {
    Command::new("kill")
        .args([signal, "--", &format!("-{process_group}")])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
}

fn process_exists(process_id: u32) -> bool {
    Command::new("kill")
        .args(["-0", &process_id.to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

fn child_stderr(path: &std::path::Path) -> String {
    fs::read_to_string(path).unwrap_or_else(|error| format!("<unreadable stderr: {error}>"))
}

fn assert_production_cli_drains_signal(signal: &str, signal_name: &str) {
    let temp = tempfile::tempdir().unwrap();
    let artifact_root = temp.path().join(".ferrite/build");
    let server_module = artifact_root.join("server/index.mjs");
    fs::create_dir_all(server_module.parent().unwrap()).unwrap();
    fs::write(&server_module, "export const pageModule = {};\n").unwrap();
    let server_file = artifact_file_record(&artifact_root, "server/index.mjs").unwrap();
    let manifest = ProductionArtifactManifest::new(
        "/_ferrite/static",
        false,
        vec![ProductionArtifactRoute {
            path: "/".to_owned(),
            params: Vec::new(),
            server_module: "server/index.mjs".to_owned(),
            client_bundle: ClientBundle {
                script: None,
                action_bootstrap: None,
                styles: Vec::new(),
                outputs: Vec::new(),
                sourcemaps: Vec::new(),
                assets: Vec::new(),
                client_references: Vec::new(),
                module_graph: Vec::new(),
                input_snapshot: Vec::new(),
            },
            prerendered: BTreeMap::new(),
            observed_actions: Vec::new(),
        }],
        vec![server_file],
    )
    .unwrap();
    fs::write(
        artifact_root.join(FERRITE_PRODUCTION_ARTIFACT_MANIFEST),
        serde_json::to_vec_pretty(&manifest).unwrap(),
    )
    .unwrap();
    let request_started = temp.path().join("request-started");
    let release_request = temp.path().join("release-request");
    let runner = temp.path().join("render-artifact.mjs");
    fs::write(
        &runner,
        format!(
            r#"
import {{ access, writeFile }} from "node:fs/promises";
import {{ setTimeout as delay }} from "node:timers/promises";

const requestStarted = {};
const releaseRequest = {};
await writeFile(requestStarted, "started");
for (;;) {{
  try {{
    await access(releaseRequest);
    break;
  }} catch (error) {{
    if (!error || error.code !== "ENOENT") throw error;
    await delay(5);
  }}
}}
process.stdout.write(JSON.stringify({{
  ferrite: "render-stream",
  version: 1,
  shell: [2, "main", {{}}, [[0, "drained request"]]],
  chunks: []
}}));
"#,
            serde_json::to_string(&request_started).unwrap(),
            serde_json::to_string(&release_request).unwrap(),
        ),
    )
    .unwrap();

    let probe = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = probe.local_addr().unwrap().port();
    drop(probe);
    let stderr_path = temp.path().join("ferrite.stderr.log");
    let stderr_file = fs::File::create(&stderr_path).unwrap();
    let mut command = Command::new(env!("CARGO_BIN_EXE_ferrite"));
    command
        .args([
            "serve",
            "--project",
            temp.path().to_str().unwrap(),
            "--artifact",
            ".ferrite/build",
            "--page-renderer",
            runner.to_str().unwrap(),
            "--host",
            "127.0.0.1",
            "--port",
            &port.to_string(),
            "--max-in-flight-requests",
            "2",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(stderr_file));
    let mut child = spawn_guarded(&mut command).unwrap();

    let started_deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match TcpStream::connect(("127.0.0.1", port)) {
            Ok(stream) => {
                drop(stream);
                break;
            }
            Err(_) if Instant::now() < started_deadline => {
                if let Some(status) = child.child.try_wait().unwrap() {
                    panic!(
                        "Ferrite production CLI exited before listening with {status}: {}",
                        child_stderr(&stderr_path)
                    );
                }
                thread::sleep(Duration::from_millis(10));
            }
            Err(error) => {
                panic!(
                    "Ferrite production CLI did not start: {error}; child state {:?}: {}",
                    child.child.try_wait().unwrap(),
                    child_stderr(&stderr_path)
                );
            }
        }
    }

    let mut request = TcpStream::connect(("127.0.0.1", port)).unwrap();
    request
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    request
        .write_all(b"GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
        .unwrap();
    let request_deadline = Instant::now() + Duration::from_secs(10);
    while !request_started.is_file() {
        if let Some(status) = child.child.try_wait().unwrap() {
            panic!(
                "Ferrite production CLI exited before accepting work with {status}: {}",
                child_stderr(&stderr_path)
            );
        }
        assert!(
            Instant::now() < request_deadline,
            "Ferrite production request did not reach the artifact runner: {}",
            child_stderr(&stderr_path)
        );
        thread::sleep(Duration::from_millis(5));
    }

    let kill_status = Command::new("kill")
        .args([signal, &child.child.id().to_string()])
        .status()
        .unwrap();
    assert!(kill_status.success());
    thread::sleep(Duration::from_millis(50));
    assert!(
        child.child.try_wait().unwrap().is_none(),
        "{signal_name} must wait for accepted work to drain: {}",
        child_stderr(&stderr_path)
    );

    fs::write(&release_request, "release").unwrap();
    let mut response = String::new();
    request.read_to_string(&mut response).unwrap();
    assert!(response.starts_with("HTTP/1.1 200 OK\r\n"), "{response}");
    assert!(response.contains("drained request"), "{response}");

    let exit_deadline = Instant::now() + Duration::from_secs(10);
    let status = loop {
        if let Some(status) = child.child.try_wait().unwrap() {
            break status;
        }
        if Instant::now() >= exit_deadline {
            panic!(
                "Ferrite production CLI did not drain after {signal_name}: {}",
                child_stderr(&stderr_path)
            );
        }
        thread::sleep(Duration::from_millis(10));
    };
    let stderr = child_stderr(&stderr_path);

    assert!(
        status.success(),
        "{signal_name} exit was {status}: {stderr}"
    );
    assert!(stderr.contains("Ferrite production server listening"));
}

#[test]
fn production_cli_drains_accepted_work_on_sigterm() {
    assert_production_cli_drains_signal("-TERM", "SIGTERM");
}

#[test]
fn production_cli_drains_accepted_work_on_sigint() {
    assert_production_cli_drains_signal("-INT", "SIGINT");
}

#[test]
fn child_guard_kills_unreleased_descendant_process_group() {
    let temp = tempfile::tempdir().unwrap();
    let grandchild_pid_path = temp.path().join("grandchild.pid");
    let grandchild_pid_staging_path = temp.path().join("grandchild.pid.staging");
    let child_script = temp.path().join("cleanup-child.mjs");
    let parent_script = temp.path().join("cleanup-parent.mjs");
    fs::write(&child_script, "setInterval(() => {}, 1_000);\n").unwrap();
    fs::write(
        &parent_script,
        format!(
            r#"
import {{ spawn }} from "node:child_process";
import {{ rename, writeFile }} from "node:fs/promises";

const child = spawn(process.execPath, [{}], {{ stdio: "ignore" }});
await writeFile({}, String(child.pid));
await rename({}, {});
setInterval(() => {{}}, 1_000);
"#,
            serde_json::to_string(&child_script).unwrap(),
            serde_json::to_string(&grandchild_pid_staging_path).unwrap(),
            serde_json::to_string(&grandchild_pid_staging_path).unwrap(),
            serde_json::to_string(&grandchild_pid_path).unwrap(),
        ),
    )
    .unwrap();

    let mut command = Command::new("node");
    command
        .arg(&parent_script)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let guard = spawn_guarded(&mut command).unwrap();

    let pid_deadline = Instant::now() + Duration::from_secs(5);
    while !grandchild_pid_path.is_file() {
        assert!(
            Instant::now() < pid_deadline,
            "fixture did not report its grandchild process"
        );
        thread::sleep(Duration::from_millis(10));
    }
    let grandchild_pid = fs::read_to_string(&grandchild_pid_path)
        .unwrap()
        .trim()
        .parse::<u32>()
        .unwrap();
    assert!(process_exists(grandchild_pid));

    drop(guard);

    let cleanup_deadline = Instant::now() + Duration::from_secs(5);
    while process_exists(grandchild_pid) {
        assert!(
            Instant::now() < cleanup_deadline,
            "child guard left grandchild process {grandchild_pid} alive"
        );
        thread::sleep(Duration::from_millis(10));
    }
}
