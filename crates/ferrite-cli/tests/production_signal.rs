#![cfg(unix)]

use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::net::{TcpListener, TcpStream};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use ferrite_builder::{
    FERRITE_PRODUCTION_ARTIFACT_MANIFEST, ProductionArtifactManifest, ProductionArtifactRoute,
    artifact_file_record,
};
use ferrite_client_bundler::ClientBundle;

#[test]
fn production_cli_turns_sigterm_into_a_clean_shutdown() {
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
    let runner = temp.path().join("render-artifact.mjs");
    fs::write(&runner, "process.exit(2);\n").unwrap();

    let probe = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = probe.local_addr().unwrap().port();
    drop(probe);
    let mut child = Command::new(env!("CARGO_BIN_EXE_ferrite"))
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
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();

    let started_deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match TcpStream::connect(("127.0.0.1", port)) {
            Ok(stream) => {
                drop(stream);
                break;
            }
            Err(_) if Instant::now() < started_deadline => {
                thread::sleep(Duration::from_millis(10));
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                panic!("Ferrite production CLI did not start: {error}");
            }
        }
    }

    let kill_status = Command::new("kill")
        .args(["-TERM", &child.id().to_string()])
        .status()
        .unwrap();
    assert!(kill_status.success());

    let exit_deadline = Instant::now() + Duration::from_secs(5);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if Instant::now() >= exit_deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("Ferrite production CLI did not drain after SIGTERM");
        }
        thread::sleep(Duration::from_millis(10));
    };
    let mut stderr = String::new();
    child
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut stderr)
        .unwrap();

    assert!(status.success(), "SIGTERM exit was {status}: {stderr}");
    assert!(stderr.contains("Ferrite production server listening"));
}
