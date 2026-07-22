use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{ChildStderr, ChildStdout, Command, ExitStatus, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

#[cfg(unix)]
use std::os::unix::process::CommandExt;
#[cfg(not(windows))]
use std::process::Child;

#[cfg(windows)]
use process_wrap::std::{JobObject, StdChildWrapper, StdCommandWrap};

const BUNDLE_TIMEOUT_POLL_INTERVAL: Duration = Duration::from_millis(5);
const MAX_BUNDLE_COMMAND_OUTPUT_BYTES: usize = 16 * 1024 * 1024;
const MAX_BUNDLE_SNAPSHOT_ATTEMPTS: usize = 2;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientBundleOptions {
    #[serde(default, skip_serializing_if = "is_false")]
    pub action_bootstrap: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub runtime_props: bool,
}

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Debug, Clone, Copy)]
pub struct ClientBundleRequest<'a> {
    pub page_file: &'a Path,
    pub layouts: &'a [PathBuf],
    pub route_path: &'a str,
    pub params: &'a [(String, Value)],
    pub out_dir: &'a Path,
    pub public_path: &'a str,
    pub options: ClientBundleOptions,
}

#[derive(Debug)]
pub enum ClientBundleError {
    Io(std::io::Error),
    Json(serde_json::Error),
    Protocol(ferrite_protocol::ProtocolError),
    InvalidModuleGraph { reason: String },
    StaleInputSnapshot { path: String },
    NodeFailed { status: Option<i32>, stderr: String },
    Cancelled,
    OutputLimitExceeded { limit: usize },
    TimedOut { timeout: Duration },
}

impl fmt::Display for ClientBundleError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ClientBundleError::Io(error) => write!(f, "{error}"),
            ClientBundleError::Json(error) => write!(f, "{error}"),
            ClientBundleError::Protocol(error) => write!(f, "{error}"),
            ClientBundleError::InvalidModuleGraph { reason } => {
                write!(f, "invalid client module graph: {reason}")
            }
            ClientBundleError::StaleInputSnapshot { path } => {
                write!(
                    f,
                    "client bundle input changed before Rust acceptance: {path}"
                )
            }
            ClientBundleError::NodeFailed { status, stderr } => match status {
                Some(status) => {
                    write!(f, "client bundler failed with exit code {status}: {stderr}")
                }
                None => write!(f, "client bundler was terminated: {stderr}"),
            },
            ClientBundleError::Cancelled => write!(f, "client bundler was cancelled"),
            ClientBundleError::OutputLimitExceeded { limit } => {
                write!(f, "client bundler output exceeded {limit} bytes")
            }
            ClientBundleError::TimedOut { timeout } => {
                write!(
                    f,
                    "client bundler timed out after {} ms",
                    timeout.as_millis()
                )
            }
        }
    }
}

impl std::error::Error for ClientBundleError {}

impl From<std::io::Error> for ClientBundleError {
    fn from(error: std::io::Error) -> Self {
        ClientBundleError::Io(error)
    }
}

impl From<serde_json::Error> for ClientBundleError {
    fn from(error: serde_json::Error) -> Self {
        ClientBundleError::Json(error)
    }
}

impl From<ferrite_protocol::ProtocolError> for ClientBundleError {
    fn from(error: ferrite_protocol::ProtocolError) -> Self {
        ClientBundleError::Protocol(error)
    }
}

pub type Result<T> = std::result::Result<T, ClientBundleError>;

#[derive(Debug, Clone)]
pub struct ClientBundler {
    project: PathBuf,
    script: PathBuf,
    command_timeout: Option<Duration>,
    cancellation_flag: Option<Arc<AtomicBool>>,
}

impl ClientBundler {
    pub fn new(project: PathBuf, script: PathBuf) -> Self {
        Self {
            project,
            script,
            command_timeout: None,
            cancellation_flag: None,
        }
    }

    pub fn with_command_timeout(mut self, timeout: Duration) -> Self {
        self.command_timeout = Some(timeout.max(Duration::from_millis(1)));
        self
    }

    pub fn with_cancellation_flag(mut self, cancellation_flag: Arc<AtomicBool>) -> Self {
        self.cancellation_flag = Some(cancellation_flag);
        self
    }

    pub fn bundle_route(
        &self,
        page_file: &Path,
        layouts: &[PathBuf],
        route_path: &str,
        params: &[(String, Value)],
        out_dir: &Path,
        public_path: &str,
    ) -> Result<ClientBundle> {
        self.bundle_route_request(ClientBundleRequest {
            page_file,
            layouts,
            route_path,
            params,
            out_dir,
            public_path,
            options: ClientBundleOptions::default(),
        })
    }

    pub fn bundle_route_request(&self, request: ClientBundleRequest<'_>) -> Result<ClientBundle> {
        self.bundle_route_request_with_snapshot_files(request, &[])
    }

    pub fn bundle_route_request_with_snapshot_files(
        &self,
        request: ClientBundleRequest<'_>,
        snapshot_files: &[PathBuf],
    ) -> Result<ClientBundle> {
        let props = ClientProps {
            params: request.params.iter().cloned().collect(),
        };
        let props_json = serde_json::to_string(&props)?;
        let layouts_json = serde_json::to_string(request.layouts)?;
        let mut options = serde_json::to_value(request.options)?;
        if !snapshot_files.is_empty() {
            options["snapshotFiles"] = serde_json::to_value(snapshot_files)?;
        }
        let options_json = serde_json::to_string(&options)?;
        let mut stale_error = None;
        for _attempt in 0..MAX_BUNDLE_SNAPSHOT_ATTEMPTS {
            let mut command = Command::new("node");
            command
                .arg(&self.script)
                .arg(request.page_file)
                .arg(request.out_dir)
                .arg(request.public_path)
                .arg(request.route_path)
                .arg(&props_json)
                .arg(&layouts_json)
                .arg(&options_json)
                .current_dir(&self.project);
            let output = self.run_command(command)?;

            if !output.status.success() {
                return Err(ClientBundleError::NodeFailed {
                    status: output.status.code(),
                    stderr: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
                });
            }

            let bundle: ClientBundle = serde_json::from_slice(&output.stdout)?;
            bundle.validate()?;
            match bundle.validate_input_snapshot(&self.project) {
                Ok(()) => return Ok(bundle),
                Err(error @ ClientBundleError::StaleInputSnapshot { .. }) => {
                    stale_error = Some(error);
                }
                Err(error) => return Err(error),
            }
        }

        Err(stale_error.expect("a stale attempt records its validation error"))
    }

    fn run_command(&self, command: Command) -> Result<BundlerOutput> {
        run_command_with_limits(
            command,
            self.command_timeout,
            MAX_BUNDLE_COMMAND_OUTPUT_BYTES,
            self.cancellation_flag.as_deref(),
        )
    }
}

#[derive(Debug)]
struct BundlerOutput {
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

fn run_command_with_limits(
    mut command: Command,
    timeout: Option<Duration>,
    max_output_bytes: usize,
    cancellation_flag: Option<&AtomicBool>,
) -> Result<BundlerOutput> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = OwnedChild::spawn(command)?;
    let stdout = child.take_stdout().expect("bundler stdout was piped");
    let stderr = child.take_stderr().expect("bundler stderr was piped");
    let output_exceeded = Arc::new(AtomicBool::new(false));
    let stdout_reader = spawn_capped_reader(stdout, max_output_bytes, Arc::clone(&output_exceeded));
    let stderr_reader = spawn_capped_reader(stderr, max_output_bytes, Arc::clone(&output_exceeded));
    let started = Instant::now();

    loop {
        if cancellation_flag.is_some_and(|flag| flag.load(Ordering::Acquire)) {
            terminate_process_tree(&mut child);
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            return Err(ClientBundleError::Cancelled);
        }

        if output_exceeded.load(Ordering::Acquire) {
            terminate_process_tree(&mut child);
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            return Err(ClientBundleError::OutputLimitExceeded {
                limit: max_output_bytes,
            });
        }

        if let Some(status) = child.try_wait()? {
            terminate_process_tree(&mut child);
            let stdout = stdout_reader
                .join()
                .expect("bundler stdout reader panicked")?;
            let stderr = stderr_reader
                .join()
                .expect("bundler stderr reader panicked")?;
            if output_exceeded.load(Ordering::Acquire) {
                return Err(ClientBundleError::OutputLimitExceeded {
                    limit: max_output_bytes,
                });
            }
            return Ok(BundlerOutput {
                status,
                stdout,
                stderr,
            });
        }

        if timeout.is_some_and(|timeout| started.elapsed() >= timeout) {
            let timeout = timeout.expect("timeout was checked as present");
            terminate_process_tree(&mut child);
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            return Err(ClientBundleError::TimedOut { timeout });
        }

        let sleep_for = timeout
            .map(|timeout| {
                BUNDLE_TIMEOUT_POLL_INTERVAL.min(timeout.saturating_sub(started.elapsed()))
            })
            .unwrap_or(BUNDLE_TIMEOUT_POLL_INTERVAL);
        thread::sleep(sleep_for);
    }
}

fn spawn_capped_reader<R: Read + Send + 'static>(
    mut reader: R,
    max_output_bytes: usize,
    output_exceeded: Arc<AtomicBool>,
) -> thread::JoinHandle<std::io::Result<Vec<u8>>> {
    thread::spawn(move || {
        let mut output = Vec::with_capacity(max_output_bytes.min(64 * 1024));
        let mut buffer = [0_u8; 8192];
        loop {
            let bytes_read = reader.read(&mut buffer)?;
            if bytes_read == 0 {
                return Ok(output);
            }
            let remaining = max_output_bytes.saturating_sub(output.len());
            output.extend_from_slice(&buffer[..bytes_read.min(remaining)]);
            if bytes_read > remaining {
                output_exceeded.store(true, Ordering::Release);
            }
        }
    })
}

struct OwnedChild {
    #[cfg(not(windows))]
    inner: Child,
    #[cfg(windows)]
    inner: Box<dyn StdChildWrapper>,
    armed: bool,
}

impl OwnedChild {
    fn spawn(command: Command) -> std::io::Result<Self> {
        #[cfg(unix)]
        let mut command = {
            let mut command = command;
            command.process_group(0);
            command
        };
        #[cfg(all(not(unix), not(windows)))]
        let mut command = command;

        #[cfg(windows)]
        {
            let mut command = StdCommandWrap::from(command);
            command.wrap(JobObject);
            return Ok(Self {
                inner: command.spawn()?,
                armed: true,
            });
        }

        #[cfg(not(windows))]
        Ok(Self {
            inner: command.spawn()?,
            armed: true,
        })
    }

    fn take_stdout(&mut self) -> Option<ChildStdout> {
        #[cfg(windows)]
        return self.inner.stdout().take();

        #[cfg(not(windows))]
        self.inner.stdout.take()
    }

    fn take_stderr(&mut self) -> Option<ChildStderr> {
        #[cfg(windows)]
        return self.inner.stderr().take();

        #[cfg(not(windows))]
        self.inner.stderr.take()
    }

    fn try_wait(&mut self) -> std::io::Result<Option<ExitStatus>> {
        self.inner.try_wait()
    }

    fn terminate(&mut self) {
        if !self.armed {
            return;
        }

        #[cfg(unix)]
        if let Ok(process_group) = i32::try_from(self.inner.id()) {
            // SAFETY: the child was spawned as the leader of a new process group.
            unsafe {
                libc::kill(-process_group, libc::SIGKILL);
            }
        }

        #[cfg(windows)]
        let _ = self.inner.start_kill();
        #[cfg(not(windows))]
        let _ = self.inner.kill();
        let _ = self.inner.wait();
        self.armed = false;
    }
}

impl Drop for OwnedChild {
    fn drop(&mut self) {
        self.terminate();
    }
}

fn terminate_process_tree(child: &mut OwnedChild) {
    child.terminate();
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClientBundle {
    pub script: Option<String>,
    #[serde(
        default,
        rename = "actionBootstrap",
        skip_serializing_if = "Option::is_none"
    )]
    pub action_bootstrap: Option<String>,
    pub styles: Vec<String>,
    pub outputs: Vec<PathBuf>,
    pub sourcemaps: Vec<PathBuf>,
    pub assets: Vec<PathBuf>,
    #[serde(
        default,
        rename = "clientReferences",
        skip_serializing_if = "Vec::is_empty"
    )]
    pub client_references: Vec<ClientReference>,
    #[serde(default, rename = "moduleGraph", skip_serializing_if = "Vec::is_empty")]
    pub module_graph: Vec<ModuleGraphNode>,
    #[serde(default, rename = "inputSnapshot", skip_serializing)]
    pub input_snapshot: Vec<ClientBundleInputSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientBundleInputSnapshot {
    pub path: String,
    pub kind: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModuleGraphNode {
    pub file: String,
    #[serde(default)]
    pub imports: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub watch_files: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientReference {
    pub id: String,
    pub module: String,
    pub export_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub script: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub styles: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub outputs: Vec<PathBuf>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sourcemaps: Vec<PathBuf>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub assets: Vec<PathBuf>,
}

impl ClientBundle {
    pub fn validate(&self) -> Result<()> {
        for reference in &self.client_references {
            ferrite_protocol::validate_client_reference_parts(
                &reference.id,
                &reference.module,
                &reference.export_name,
            )?;
        }

        for node in &self.module_graph {
            if !is_valid_module_graph_path(&node.file) {
                return Err(ClientBundleError::InvalidModuleGraph {
                    reason: "contains an invalid file path".to_owned(),
                });
            }
            if node
                .imports
                .iter()
                .any(|import| !is_valid_module_graph_path(import))
            {
                return Err(ClientBundleError::InvalidModuleGraph {
                    reason: "contains an invalid import path".to_owned(),
                });
            }
            if node.imports.windows(2).any(|pair| pair[0] >= pair[1]) {
                return Err(ClientBundleError::InvalidModuleGraph {
                    reason: "imports must be sorted and unique".to_owned(),
                });
            }
            if node
                .watch_files
                .iter()
                .any(|watch_file| !is_valid_module_graph_path(watch_file))
            {
                return Err(ClientBundleError::InvalidModuleGraph {
                    reason: "contains an invalid watch path".to_owned(),
                });
            }
            if node.watch_files.windows(2).any(|pair| pair[0] >= pair[1]) {
                return Err(ClientBundleError::InvalidModuleGraph {
                    reason: "watch paths must be sorted and unique".to_owned(),
                });
            }
        }
        if self
            .module_graph
            .windows(2)
            .any(|pair| pair[0].file >= pair[1].file)
        {
            return Err(ClientBundleError::InvalidModuleGraph {
                reason: "nodes must be sorted and unique".to_owned(),
            });
        }
        let module_files = self
            .module_graph
            .iter()
            .map(|node| node.file.as_str())
            .collect::<BTreeSet<_>>();
        if !module_files.is_empty()
            && self
                .client_references
                .iter()
                .any(|reference| !module_files.contains(reference.module.as_str()))
        {
            return Err(ClientBundleError::InvalidModuleGraph {
                reason: "contains a client reference that is not a graph node".to_owned(),
            });
        }
        if self
            .module_graph
            .iter()
            .flat_map(|node| node.imports.iter())
            .any(|import| !module_files.contains(import.as_str()))
        {
            return Err(ClientBundleError::InvalidModuleGraph {
                reason: "contains an import that is not a graph node".to_owned(),
            });
        }
        let graph = self
            .module_graph
            .iter()
            .map(|node| {
                (
                    node.file.as_str(),
                    node.imports.iter().map(String::as_str).collect(),
                )
            })
            .collect::<BTreeMap<_, Vec<_>>>();
        let mut active = BTreeSet::new();
        let mut visited = BTreeSet::new();
        if graph
            .keys()
            .any(|file| module_graph_has_cycle(file, &graph, &mut active, &mut visited))
        {
            return Err(ClientBundleError::InvalidModuleGraph {
                reason: "contains a cycle".to_owned(),
            });
        }

        for input in &self.input_snapshot {
            if input.path.is_empty() || !Path::new(&input.path).is_absolute() {
                return Err(ClientBundleError::InvalidModuleGraph {
                    reason: "contains a non-absolute input snapshot path".to_owned(),
                });
            }
            if !matches!(input.kind.as_str(), "source" | "resolution")
                || !is_valid_input_snapshot_value(input)
            {
                return Err(ClientBundleError::InvalidModuleGraph {
                    reason: "contains an invalid input snapshot entry".to_owned(),
                });
            }
        }
        if self
            .input_snapshot
            .windows(2)
            .any(|pair| (&pair[0].path, &pair[0].kind) >= (&pair[1].path, &pair[1].kind))
        {
            return Err(ClientBundleError::InvalidModuleGraph {
                reason: "input snapshot entries must be sorted and unique".to_owned(),
            });
        }

        Ok(())
    }

    pub fn validate_input_snapshot(&self, project: &Path) -> Result<()> {
        let project = fs::canonicalize(project)?;
        for input in &self.input_snapshot {
            let current = current_input_snapshot_value(&project, input)?;
            if current != input.value {
                return Err(ClientBundleError::StaleInputSnapshot {
                    path: input.path.clone(),
                });
            }
        }
        Ok(())
    }
}

pub fn fingerprint_client_bundle_inputs(
    project: &Path,
    inputs: &[ClientBundleInputSnapshot],
) -> std::io::Result<String> {
    let project = fs::canonicalize(project)?;
    let current = inputs
        .iter()
        .map(|input| {
            current_input_snapshot_value(&project, input)
                .map(|value| ClientBundleInputSnapshot {
                    path: input.path.clone(),
                    kind: input.kind.clone(),
                    value,
                })
                .map_err(|error| match error {
                    ClientBundleError::Io(error) => error,
                    other => std::io::Error::other(other.to_string()),
                })
        })
        .collect::<std::io::Result<Vec<_>>>()?;
    let encoded = serde_json::to_vec(&current).map_err(std::io::Error::other)?;
    Ok(format!("sha256:{}", sha256_hex(&encoded)))
}

fn current_input_snapshot_value(
    project: &Path,
    input: &ClientBundleInputSnapshot,
) -> Result<String> {
    let path = Path::new(&input.path);
    match input.kind.as_str() {
        "source" => match fs::read(path) {
            Ok(bytes) => Ok(format!("sha256:{}", sha256_hex(&bytes))),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok("missing".to_owned()),
            Err(_error) => Ok("error".to_owned()),
        },
        "resolution" => match fs::canonicalize(path) {
            Ok(resolved) if resolved.starts_with(project) => {
                let relative = resolved
                    .strip_prefix(project)
                    .expect("contained path has a project-relative suffix")
                    .to_string_lossy()
                    .replace('\\', "/");
                Ok(format!("resolved:{relative}"))
            }
            Ok(_resolved) if input.value == "outside-project" => Ok("outside-project".to_owned()),
            Ok(resolved) => Ok(outside_project_resolution_value(&resolved)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok("missing".to_owned()),
            Err(_error) => Ok("error".to_owned()),
        },
        _ => Err(ClientBundleError::InvalidModuleGraph {
            reason: "contains an invalid input snapshot kind".to_owned(),
        }),
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn outside_project_resolution_value(path: &Path) -> String {
    let portable = portable_canonical_path(path);
    format!("outside-project:sha256:{}", sha256_hex(portable.as_bytes()))
}

fn portable_canonical_path(path: &Path) -> String {
    let portable = path.to_string_lossy().replace('\\', "/");
    const EXTENDED_UNC_PREFIX: &str = "//?/UNC/";
    if portable
        .get(..EXTENDED_UNC_PREFIX.len())
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case(EXTENDED_UNC_PREFIX))
    {
        return format!("//{}", &portable[EXTENDED_UNC_PREFIX.len()..]);
    }
    if let Some(path) = portable.strip_prefix("//?/") {
        return path.to_owned();
    }
    portable
}

fn module_graph_has_cycle<'a>(
    file: &'a str,
    graph: &BTreeMap<&'a str, Vec<&'a str>>,
    active: &mut BTreeSet<&'a str>,
    visited: &mut BTreeSet<&'a str>,
) -> bool {
    if active.contains(file) {
        return true;
    }
    if visited.contains(file) {
        return false;
    }

    active.insert(file);
    let has_cycle = graph[file]
        .iter()
        .any(|import| module_graph_has_cycle(import, graph, active, visited));
    active.remove(file);
    visited.insert(file);
    has_cycle
}

fn is_valid_module_graph_path(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && !path.contains(['\\', ':'])
        && !path.chars().any(char::is_control)
        && !path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
}

fn is_valid_input_snapshot_value(input: &ClientBundleInputSnapshot) -> bool {
    match input.kind.as_str() {
        "source" => {
            matches!(input.value.as_str(), "missing" | "error")
                || input.value.strip_prefix("sha256:").is_some_and(|digest| {
                    digest.len() == 64
                        && digest
                            .bytes()
                            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                })
        }
        "resolution" => match input.value.as_str() {
            "missing" | "error" | "outside-project" => true,
            value => {
                value
                    .strip_prefix("resolved:")
                    .is_some_and(is_valid_module_graph_path)
                    || value
                        .strip_prefix("outside-project:sha256:")
                        .is_some_and(is_valid_sha256_digest)
            }
        },
        _ => false,
    }
}

fn is_valid_sha256_digest(digest: &str) -> bool {
    digest.len() == 64
        && digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub fn fingerprint_client_bundle(
    bundle: &mut ClientBundle,
    out_dir: &Path,
    public_path: &str,
) -> Result<()> {
    let mut replacements = BTreeMap::new();

    if let Some(script) = bundle.script.as_mut() {
        fingerprint_public_url(script, out_dir, public_path, &mut replacements)?;
    }
    if let Some(script) = bundle.action_bootstrap.as_mut() {
        fingerprint_public_url(script, out_dir, public_path, &mut replacements)?;
    }
    for style in &mut bundle.styles {
        fingerprint_public_url(style, out_dir, public_path, &mut replacements)?;
    }
    for reference in &mut bundle.client_references {
        if let Some(script) = reference.script.as_mut() {
            fingerprint_public_url(script, out_dir, public_path, &mut replacements)?;
        }
        for style in &mut reference.styles {
            fingerprint_public_url(style, out_dir, public_path, &mut replacements)?;
        }
        rewrite_output_paths(&mut reference.outputs, &replacements);
    }

    rewrite_output_paths(&mut bundle.outputs, &replacements);
    Ok(())
}

fn fingerprint_public_url(
    url: &mut String,
    out_dir: &Path,
    public_path: &str,
    replacements: &mut BTreeMap<PathBuf, PathBuf>,
) -> Result<()> {
    let Some(relative) = public_url_relative_path(url, public_path) else {
        return Ok(());
    };
    if !is_fingerprint_candidate(&relative) {
        return Ok(());
    }

    let replacement = match replacements.get(&relative) {
        Some(replacement) => replacement.clone(),
        None => {
            let replacement = fingerprint_output_file(out_dir, &relative)?;
            replacements.insert(relative.clone(), replacement.clone());
            replacement
        }
    };
    *url = public_url(public_path, &replacement);
    Ok(())
}

fn public_url_relative_path(url: &str, public_path: &str) -> Option<PathBuf> {
    let public_path = public_path.trim_end_matches('/');
    let prefix = format!("{public_path}/");
    let relative = url.strip_prefix(&prefix)?;
    if relative.is_empty() || relative.contains("..") {
        return None;
    }
    Some(PathBuf::from(relative))
}

fn is_fingerprint_candidate(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|extension| extension.to_str()),
        Some("js" | "css")
    )
}

fn fingerprint_output_file(out_dir: &Path, relative: &Path) -> Result<PathBuf> {
    let source = out_dir.join(relative);
    let bytes = fs::read(&source)?;
    let hash = content_hash(&bytes);
    let extension = relative
        .extension()
        .and_then(|extension| extension.to_str())
        .expect("fingerprint candidate has extension");
    let stem = relative
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("asset");
    let fingerprinted_name = format!("{stem}.{hash}.{extension}");
    let replacement = relative.with_file_name(fingerprinted_name);
    if replacement == relative {
        return Ok(replacement);
    }

    let target = out_dir.join(&replacement);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    if target.exists() {
        fs::remove_file(&target)?;
    }
    fs::rename(source, &target)?;
    Ok(replacement)
}

fn rewrite_output_paths(outputs: &mut Vec<PathBuf>, replacements: &BTreeMap<PathBuf, PathBuf>) {
    let mut seen = BTreeSet::new();
    let mut rewritten = Vec::new();
    for output in outputs.drain(..) {
        let next = replacements.get(&output).cloned().unwrap_or(output);
        if seen.insert(next.clone()) {
            rewritten.push(next);
        }
    }
    *outputs = rewritten;
}

fn public_url(public_path: &str, relative: &Path) -> String {
    let public_path = public_path.trim_end_matches('/');
    let relative = relative.to_string_lossy().replace('\\', "/");
    format!("{public_path}/{relative}")
}

fn content_hash(bytes: &[u8]) -> String {
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

#[derive(Debug, Serialize)]
struct ClientProps {
    params: BTreeMap<String, Value>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;

    #[cfg(unix)]
    fn make_script(path: &Path, body: &str) {
        use std::os::unix::fs::PermissionsExt;

        fs::write(path, body).unwrap();
        let mut permissions = fs::metadata(path).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(path, permissions).unwrap();
    }

    #[cfg(not(unix))]
    fn make_script(path: &Path, body: &str) {
        fs::write(path, body).unwrap();
    }

    #[test]
    fn parses_bundle_output() {
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("build-client.mjs");
        make_script(
            &script,
            r#"
process.stdout.write(JSON.stringify({
  script: "/_ferrite/static/app.js",
  styles: ["/_ferrite/static/app.css"],
  outputs: ["app.js", "app.css"],
  sourcemaps: ["app.js.map"],
  assets: ["assets/logo.svg"],
  clientReferences: [{ id: "app/Counter.tsx#default", module: "app/Counter.tsx", exportName: "default" }],
  moduleGraph: [
    { file: "app/Counter.tsx", imports: [] },
    { file: "app/page.tsx", imports: ["app/Counter.tsx"] }
  ]
}));
"#,
        );
        let page = temp.path().join("page.tsx");
        fs::write(&page, "").unwrap();
        let bundler = ClientBundler::new(temp.path().to_path_buf(), script);

        let bundle = bundler
            .bundle_route(
                &page,
                &[],
                "/",
                &[],
                &temp.path().join("out"),
                "/_ferrite/static",
            )
            .unwrap();

        assert_eq!(bundle.script.as_deref(), Some("/_ferrite/static/app.js"));
        assert_eq!(bundle.styles, vec!["/_ferrite/static/app.css"]);
        assert_eq!(bundle.sourcemaps, vec![PathBuf::from("app.js.map")]);
        assert_eq!(
            bundle.module_graph,
            vec![
                ModuleGraphNode {
                    file: "app/Counter.tsx".to_owned(),
                    imports: Vec::new(),
                    watch_files: Vec::new(),
                },
                ModuleGraphNode {
                    file: "app/page.tsx".to_owned(),
                    imports: vec!["app/Counter.tsx".to_owned()],
                    watch_files: Vec::new(),
                },
            ]
        );
        assert_eq!(
            bundle.client_references,
            vec![ClientReference {
                id: "app/Counter.tsx#default".to_owned(),
                module: "app/Counter.tsx".to_owned(),
                export_name: "default".to_owned(),
                script: None,
                styles: Vec::new(),
                outputs: Vec::new(),
                sourcemaps: Vec::new(),
                assets: Vec::new(),
            }]
        );
    }

    #[test]
    fn rejects_a_bundle_when_its_declared_input_snapshot_is_stale() {
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("build-client.mjs");
        let page = temp.path().join("page.tsx");
        fs::write(&page, "new source").unwrap();
        let page_json = serde_json::to_string(page.to_str().unwrap()).unwrap();
        make_script(
            &script,
            &format!(
                r#"
process.stdout.write(JSON.stringify({{
  script: null,
  styles: [],
  outputs: [],
  sourcemaps: [],
  assets: [],
  clientReferences: [],
  moduleGraph: [],
  inputSnapshot: [{{ path: {page_json}, kind: "source", value: "sha256:0000000000000000000000000000000000000000000000000000000000000000" }}]
}}));
"#
            ),
        );
        let bundler = ClientBundler::new(temp.path().to_path_buf(), script);

        let result = bundler.bundle_route(
            &page,
            &[],
            "/",
            &[],
            &temp.path().join("out"),
            "/_ferrite/static",
        );

        assert!(result.is_err(), "stale input snapshots must be rejected");
    }

    #[cfg(unix)]
    #[test]
    fn detects_outside_project_resolution_retargeting() {
        use std::os::unix::fs::symlink;

        let project = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        let first = external.path().join("first.json");
        let second = external.path().join("second.json");
        let link = project.path().join("data.json");
        fs::write(&first, "first").unwrap();
        fs::write(&second, "second").unwrap();
        symlink(&first, &link).unwrap();
        let expected = outside_project_resolution_value(&fs::canonicalize(&first).unwrap());
        let bundle = ClientBundle {
            script: None,
            action_bootstrap: None,
            styles: Vec::new(),
            outputs: Vec::new(),
            sourcemaps: Vec::new(),
            assets: Vec::new(),
            client_references: Vec::new(),
            module_graph: Vec::new(),
            input_snapshot: vec![ClientBundleInputSnapshot {
                path: link.display().to_string(),
                kind: "resolution".to_owned(),
                value: expected,
            }],
        };

        bundle.validate().unwrap();
        bundle.validate_input_snapshot(project.path()).unwrap();
        fs::remove_file(&link).unwrap();
        symlink(&second, &link).unwrap();

        assert!(matches!(
            bundle.validate_input_snapshot(project.path()),
            Err(ClientBundleError::StaleInputSnapshot { .. })
        ));
    }

    #[test]
    fn canonical_path_normalization_aligns_windows_drive_and_unc_forms() {
        assert_eq!(
            portable_canonical_path(Path::new(r"C:\workspace\asset.json")),
            "C:/workspace/asset.json"
        );
        assert_eq!(
            portable_canonical_path(Path::new(r"\\?\C:\workspace\asset.json")),
            "C:/workspace/asset.json"
        );
        assert_eq!(
            portable_canonical_path(Path::new(r"\\server\share\asset.json")),
            "//server/share/asset.json"
        );
        assert_eq!(
            portable_canonical_path(Path::new(r"\\?\UNC\server\share\asset.json")),
            "//server/share/asset.json"
        );
        assert_eq!(
            portable_canonical_path(Path::new(r"\\?\unc\server\share\asset.json")),
            "//server/share/asset.json"
        );
    }

    #[test]
    fn retries_one_stale_rust_acceptance_snapshot() {
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("build-client.mjs");
        let page = temp.path().join("page.tsx");
        fs::write(&page, "stable source").unwrap();
        make_script(
            &script,
            r#"
const crypto = await import("node:crypto");
const fs = await import("node:fs/promises");
const path = await import("node:path");
const page = await fs.realpath(process.argv[2]);
const state = path.join(path.dirname(new URL(import.meta.url).pathname), "attempts");
let attempt = 0;
try { attempt = Number(await fs.readFile(state, "utf8")); } catch {}
attempt += 1;
await fs.writeFile(state, String(attempt));
const source = await fs.readFile(page);
const digest = attempt === 1
  ? "0".repeat(64)
  : crypto.createHash("sha256").update(source).digest("hex");
process.stdout.write(JSON.stringify({
  script: null,
  styles: [],
  outputs: [],
  sourcemaps: [],
  assets: [],
  inputSnapshot: [{ path: page, kind: "source", value: `sha256:${digest}` }]
}));
"#,
        );
        let bundler = ClientBundler::new(temp.path().to_path_buf(), script);

        let bundle = bundler
            .bundle_route(
                &page,
                &[],
                "/",
                &[],
                &temp.path().join("out"),
                "/_ferrite/static",
            )
            .unwrap();

        assert_eq!(bundle.input_snapshot.len(), 1);
        assert_eq!(
            fs::read_to_string(temp.path().join("attempts")).unwrap(),
            "2"
        );
    }

    #[test]
    fn rejects_noncanonical_module_graphs() {
        let bundle = ClientBundle {
            script: None,
            action_bootstrap: None,
            styles: Vec::new(),
            outputs: Vec::new(),
            sourcemaps: Vec::new(),
            assets: Vec::new(),
            client_references: Vec::new(),
            module_graph: vec![
                ModuleGraphNode {
                    file: "app/z.ts".to_owned(),
                    imports: vec!["app/b.ts".to_owned(), "app/a.ts".to_owned()],
                    watch_files: Vec::new(),
                },
                ModuleGraphNode {
                    file: "app/a.ts".to_owned(),
                    imports: vec!["../outside.ts".to_owned()],
                    watch_files: Vec::new(),
                },
            ],
            input_snapshot: Vec::new(),
        };

        assert_eq!(
            bundle.validate().unwrap_err().to_string(),
            "invalid client module graph: imports must be sorted and unique"
        );
    }

    #[test]
    fn rejects_invalid_input_snapshot_contracts() {
        let absolute = std::env::current_dir()
            .unwrap()
            .join("page.tsx")
            .display()
            .to_string();
        let mut bundle = ClientBundle {
            script: None,
            action_bootstrap: None,
            styles: Vec::new(),
            outputs: Vec::new(),
            sourcemaps: Vec::new(),
            assets: Vec::new(),
            client_references: Vec::new(),
            module_graph: Vec::new(),
            input_snapshot: vec![ClientBundleInputSnapshot {
                path: absolute.clone(),
                kind: "source".to_owned(),
                value: "sha256:not-a-digest".to_owned(),
            }],
        };

        assert_eq!(
            bundle.validate().unwrap_err().to_string(),
            "invalid client module graph: contains an invalid input snapshot entry"
        );

        bundle.input_snapshot = vec![ClientBundleInputSnapshot {
            path: absolute.clone(),
            kind: "resolution".to_owned(),
            value: "resolved:../outside.ts".to_owned(),
        }];
        assert_eq!(
            bundle.validate().unwrap_err().to_string(),
            "invalid client module graph: contains an invalid input snapshot entry"
        );

        bundle.input_snapshot = vec![ClientBundleInputSnapshot {
            path: absolute,
            kind: "resolution".to_owned(),
            value: "outside-project:sha256:not-a-digest".to_owned(),
        }];
        assert_eq!(
            bundle.validate().unwrap_err().to_string(),
            "invalid client module graph: contains an invalid input snapshot entry"
        );
    }

    #[test]
    fn rejects_noncanonical_module_graph_watch_paths() {
        let mut bundle = ClientBundle {
            script: None,
            action_bootstrap: None,
            styles: Vec::new(),
            outputs: Vec::new(),
            sourcemaps: Vec::new(),
            assets: Vec::new(),
            client_references: Vec::new(),
            module_graph: vec![ModuleGraphNode {
                file: "app/page.tsx".to_owned(),
                imports: Vec::new(),
                watch_files: vec!["app/z.ts".to_owned(), "app/a.ts".to_owned()],
            }],
            input_snapshot: Vec::new(),
        };

        assert_eq!(
            bundle.validate().unwrap_err().to_string(),
            "invalid client module graph: watch paths must be sorted and unique"
        );

        bundle.module_graph[0].watch_files = vec!["../outside.ts".to_owned()];
        assert_eq!(
            bundle.validate().unwrap_err().to_string(),
            "invalid client module graph: contains an invalid watch path"
        );
    }

    #[test]
    fn rejects_module_graphs_with_missing_edges_or_cycles() {
        let mut bundle = ClientBundle {
            script: None,
            action_bootstrap: None,
            styles: Vec::new(),
            outputs: Vec::new(),
            sourcemaps: Vec::new(),
            assets: Vec::new(),
            client_references: Vec::new(),
            module_graph: vec![ModuleGraphNode {
                file: "app/page.tsx".to_owned(),
                imports: vec!["app/missing.ts".to_owned()],
                watch_files: Vec::new(),
            }],
            input_snapshot: Vec::new(),
        };

        assert_eq!(
            bundle.validate().unwrap_err().to_string(),
            "invalid client module graph: contains an import that is not a graph node"
        );

        bundle.module_graph = vec![
            ModuleGraphNode {
                file: "app/a.ts".to_owned(),
                imports: vec!["app/b.ts".to_owned()],
                watch_files: Vec::new(),
            },
            ModuleGraphNode {
                file: "app/b.ts".to_owned(),
                imports: vec!["app/a.ts".to_owned()],
                watch_files: Vec::new(),
            },
        ];
        assert_eq!(
            bundle.validate().unwrap_err().to_string(),
            "invalid client module graph: contains a cycle"
        );
    }

    #[test]
    fn rejects_nonportable_module_graph_paths() {
        let bundle = ClientBundle {
            script: None,
            action_bootstrap: None,
            styles: Vec::new(),
            outputs: Vec::new(),
            sourcemaps: Vec::new(),
            assets: Vec::new(),
            client_references: Vec::new(),
            module_graph: vec![ModuleGraphNode {
                file: "C:\\app\\page.tsx".to_owned(),
                imports: Vec::new(),
                watch_files: Vec::new(),
            }],
            input_snapshot: Vec::new(),
        };

        assert_eq!(
            bundle.validate().unwrap_err().to_string(),
            "invalid client module graph: contains an invalid file path"
        );
    }

    #[test]
    fn rejects_client_references_missing_from_a_nonempty_module_graph() {
        let bundle = ClientBundle {
            script: None,
            action_bootstrap: None,
            styles: Vec::new(),
            outputs: Vec::new(),
            sourcemaps: Vec::new(),
            assets: Vec::new(),
            client_references: vec![ClientReference {
                id: "app/Counter.tsx#default".to_owned(),
                module: "app/Counter.tsx".to_owned(),
                export_name: "default".to_owned(),
                script: None,
                styles: Vec::new(),
                outputs: Vec::new(),
                sourcemaps: Vec::new(),
                assets: Vec::new(),
            }],
            module_graph: vec![ModuleGraphNode {
                file: "app/page.tsx".to_owned(),
                imports: Vec::new(),
                watch_files: Vec::new(),
            }],
            input_snapshot: Vec::new(),
        };

        assert_eq!(
            bundle.validate().unwrap_err().to_string(),
            "invalid client module graph: contains a client reference that is not a graph node"
        );
    }

    #[test]
    fn fingerprints_client_bundle_scripts_and_styles() {
        let temp = tempfile::tempdir().unwrap();
        let out_dir = temp.path().join("out");
        fs::create_dir_all(&out_dir).unwrap();
        fs::write(out_dir.join("route-index.js"), "console.log('route');").unwrap();
        fs::write(
            out_dir.join("route-index-action-bootstrap.js"),
            "console.log('action-bootstrap');",
        )
        .unwrap();
        fs::write(out_dir.join("route-index.css"), ".page{color:red}").unwrap();
        fs::write(
            out_dir.join("client-reference-app-Counter-tsx-default.js"),
            "console.log('counter');",
        )
        .unwrap();
        fs::write(
            out_dir.join("client-reference-app-Counter-tsx-default.css"),
            ".counter{color:blue}",
        )
        .unwrap();
        fs::write(out_dir.join("route-index.js.map"), "{}").unwrap();
        let route_js_hash = content_hash("console.log('route');".as_bytes());
        let action_bootstrap_hash = content_hash("console.log('action-bootstrap');".as_bytes());
        let route_css_hash = content_hash(".page{color:red}".as_bytes());
        let reference_js_hash = content_hash("console.log('counter');".as_bytes());
        let reference_css_hash = content_hash(".counter{color:blue}".as_bytes());
        let mut bundle = ClientBundle {
            script: Some("/_ferrite/static/route-index.js".to_owned()),
            action_bootstrap: Some("/_ferrite/static/route-index-action-bootstrap.js".to_owned()),
            styles: vec!["/_ferrite/static/route-index.css".to_owned()],
            outputs: vec![
                PathBuf::from("route-index.js"),
                PathBuf::from("route-index-action-bootstrap.js"),
                PathBuf::from("route-index.css"),
                PathBuf::from("route-index.js.map"),
                PathBuf::from("client-reference-app-Counter-tsx-default.js"),
                PathBuf::from("client-reference-app-Counter-tsx-default.css"),
            ],
            sourcemaps: vec![PathBuf::from("route-index.js.map")],
            assets: Vec::new(),
            client_references: vec![ClientReference {
                id: "app/Counter.tsx#default".to_owned(),
                module: "app/Counter.tsx".to_owned(),
                export_name: "default".to_owned(),
                script: Some(
                    "/_ferrite/static/client-reference-app-Counter-tsx-default.js".to_owned(),
                ),
                styles: vec![
                    "/_ferrite/static/client-reference-app-Counter-tsx-default.css".to_owned(),
                ],
                outputs: vec![
                    PathBuf::from("client-reference-app-Counter-tsx-default.js"),
                    PathBuf::from("client-reference-app-Counter-tsx-default.css"),
                ],
                sourcemaps: Vec::new(),
                assets: Vec::new(),
            }],
            module_graph: Vec::new(),
            input_snapshot: Vec::new(),
        };

        fingerprint_client_bundle(&mut bundle, &out_dir, "/_ferrite/static").unwrap();

        let route_script = format!("/_ferrite/static/route-index.{route_js_hash}.js");
        let reference_script = format!(
            "/_ferrite/static/client-reference-app-Counter-tsx-default.{reference_js_hash}.js"
        );
        assert_eq!(bundle.script.as_deref(), Some(route_script.as_str()));
        assert_eq!(
            bundle.action_bootstrap,
            Some(format!(
                "/_ferrite/static/route-index-action-bootstrap.{action_bootstrap_hash}.js"
            ))
        );
        assert_eq!(
            bundle.styles,
            vec![format!("/_ferrite/static/route-index.{route_css_hash}.css")]
        );
        assert_eq!(
            bundle.client_references[0].script.as_deref(),
            Some(reference_script.as_str())
        );
        assert_eq!(
            bundle.client_references[0].styles,
            vec![format!(
                "/_ferrite/static/client-reference-app-Counter-tsx-default.{reference_css_hash}.css"
            )]
        );
        assert!(
            out_dir
                .join(format!("route-index.{route_js_hash}.js"))
                .is_file()
        );
        assert!(!out_dir.join("route-index.js").exists());
        assert!(
            out_dir
                .join(format!(
                    "route-index-action-bootstrap.{action_bootstrap_hash}.js"
                ))
                .is_file()
        );
        assert!(!out_dir.join("route-index-action-bootstrap.js").exists());
        assert!(
            out_dir
                .join(format!(
                    "client-reference-app-Counter-tsx-default.{reference_js_hash}.js"
                ))
                .is_file()
        );
        assert!(
            bundle
                .outputs
                .contains(&PathBuf::from(format!("route-index.{route_js_hash}.js")))
        );
        assert!(bundle.outputs.contains(&PathBuf::from(format!(
            "route-index-action-bootstrap.{action_bootstrap_hash}.js"
        ))));
        assert!(bundle.outputs.contains(&PathBuf::from(format!(
            "client-reference-app-Counter-tsx-default.{reference_css_hash}.css"
        ))));
        assert!(
            bundle
                .outputs
                .contains(&PathBuf::from("route-index.js.map"))
        );
    }

    #[test]
    fn rejects_invalid_client_reference_output() {
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("build-client.mjs");
        make_script(
            &script,
            r#"
process.stdout.write(JSON.stringify({
  script: null,
  styles: [],
  outputs: [],
  sourcemaps: [],
  assets: [],
  clientReferences: [{ id: "app/Counter.tsx#Other", module: "app/Counter.tsx", exportName: "default" }]
}));
"#,
        );
        let page = temp.path().join("page.tsx");
        fs::write(&page, "").unwrap();
        let bundler = ClientBundler::new(temp.path().to_path_buf(), script);

        let error = bundler
            .bundle_route(
                &page,
                &[],
                "/",
                &[],
                &temp.path().join("out"),
                "/_ferrite/static",
            )
            .unwrap_err();

        assert_eq!(
            error.to_string(),
            "client reference id must equal \"app/Counter.tsx#default\""
        );
    }

    #[test]
    fn parses_server_only_bundle_output() {
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("build-client.mjs");
        make_script(
            &script,
            r#"
process.stdout.write(JSON.stringify({
  script: null,
  styles: [],
  outputs: [],
  sourcemaps: [],
  assets: []
}));
"#,
        );
        let page = temp.path().join("page.tsx");
        fs::write(&page, "").unwrap();
        let bundler = ClientBundler::new(temp.path().to_path_buf(), script);

        let bundle = bundler
            .bundle_route(
                &page,
                &[],
                "/",
                &[],
                &temp.path().join("out"),
                "/_ferrite/static",
            )
            .unwrap();

        assert_eq!(bundle.script, None);
        assert!(bundle.outputs.is_empty());
        assert!(bundle.client_references.is_empty());
    }

    #[test]
    fn real_runner_collects_client_references_for_server_routes() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("package.json"), "{}").unwrap();
        let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .canonicalize()
            .unwrap();
        fs::create_dir_all(temp.path().join("node_modules/@ferrite")).unwrap();
        symlink_dir(
            &repo_root.join("packages/runtime"),
            &temp.path().join("node_modules/@ferrite/runtime"),
        );
        fs::create_dir_all(temp.path().join("app/posts/[id]")).unwrap();
        fs::write(
            temp.path().join("app/posts/[id]/page.tsx"),
            r#"
import { createServerAction } from "@ferrite/runtime/server";
import PostActions, { ShareButton } from "./PostActions";
import PostShell from "./PostShell";

export default function Page() {
  const savePost = createServerAction({
    id: "app/posts/[id]/page.tsx#savePost",
    async run() {
      return null;
    }
  });
  return <PostShell><PostActions id="alpha" /><ShareButton id="alpha" /></PostShell>;
}
"#,
        )
        .unwrap();
        fs::write(
            temp.path().join("app/posts/[id]/PostShell.tsx"),
            r#"
export default function PostShell({ children }) {
  return <article>{children}</article>;
}
"#,
        )
        .unwrap();
        fs::write(
            temp.path().join("app/posts/[id]/PostActions.tsx"),
            r#"
"use client";

export default function PostActions({ id }) {
  return <button type="button">Like {id}</button>;
}

export function ShareButton({ id }) {
  return <button type="button">Share {id}</button>;
}
"#,
        )
        .unwrap();
        let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/runtime/bin/build-client.mjs");
        let bundler = ClientBundler::new(temp.path().to_path_buf(), script);

        let bundle = bundler
            .bundle_route(
                &temp.path().join("app/posts/[id]/page.tsx"),
                &[],
                "/posts/alpha",
                &[],
                &temp.path().join(".ferrite/build/_ferrite/static"),
                "/_ferrite/static",
            )
            .unwrap();

        assert_eq!(bundle.script, None);
        assert_eq!(bundle.client_references.len(), 2);
        assert_eq!(
            bundle.client_references[0].id,
            "app/posts/[id]/PostActions.tsx#ShareButton"
        );
        assert_eq!(
            bundle.client_references[1].script.as_deref(),
            Some("/_ferrite/static/client-reference-app-posts-id-PostActions-tsx-default.js")
        );
        assert!(bundle.client_references[1].outputs.contains(&PathBuf::from(
            "client-reference-app-posts-id-PostActions-tsx-default.js"
        )));
        assert_eq!(
            bundle.client_references[1].id,
            "app/posts/[id]/PostActions.tsx#default"
        );
        assert!(bundle.outputs.contains(&PathBuf::from(
            "client-reference-app-posts-id-PostActions-tsx-default.js"
        )));
        assert!(bundle.outputs.contains(&PathBuf::from(
            "client-reference-app-posts-id-PostActions-tsx-ShareButton.js"
        )));
    }

    #[test]
    fn real_runner_bootstraps_server_action_form_enhancement() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("package.json"), "{}").unwrap();
        let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .canonicalize()
            .unwrap();
        fs::create_dir_all(temp.path().join("node_modules/@ferrite")).unwrap();
        symlink_dir(
            &repo_root.join("packages/runtime"),
            &temp.path().join("node_modules/@ferrite/runtime"),
        );
        fs::create_dir_all(temp.path().join("app/actions")).unwrap();
        fs::write(
            temp.path().join("app/actions/page.tsx"),
            r#"
"use client";

export default function Page() {
  return <form method="post" action="/_ferrite/action"><button>Save</button></form>;
}
"#,
        )
        .unwrap();
        fs::write(
            temp.path().join("app/actions/ActionButton.tsx"),
            r#"
"use client";

export default function ActionButton() {
  return <button type="button">Client action</button>;
}
"#,
        )
        .unwrap();
        let script = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/runtime/bin/build-client.mjs");
        let bundler = ClientBundler::new(temp.path().to_path_buf(), script);

        let route_bundle = bundler
            .bundle_route(
                &temp.path().join("app/actions/page.tsx"),
                &[],
                "/actions",
                &[],
                &temp.path().join(".ferrite/build/_ferrite/static"),
                "/_ferrite/static",
            )
            .unwrap();

        let route_script = route_bundle
            .script
            .as_deref()
            .expect("client route emits a script")
            .trim_start_matches("/_ferrite/static/");
        let route_js = fs::read_to_string(
            temp.path()
                .join(".ferrite/build/_ferrite/static")
                .join(route_script),
        )
        .unwrap();
        assert!(route_js.contains("bootstrapServerActionForms"));

        fs::write(
            temp.path().join("app/actions/page.tsx"),
            r#"
import ActionButton from "./ActionButton";

export default function Page() {
  return <ActionButton />;
}
"#,
        )
        .unwrap();

        let server_bundle = bundler
            .bundle_route_request(ClientBundleRequest {
                page_file: &temp.path().join("app/actions/page.tsx"),
                layouts: &[],
                route_path: "/actions",
                params: &[],
                out_dir: &temp.path().join(".ferrite/build/_ferrite/static"),
                public_path: "/_ferrite/static",
                options: ClientBundleOptions {
                    action_bootstrap: true,
                    runtime_props: false,
                },
            })
            .unwrap();

        assert_eq!(server_bundle.action_bootstrap, None);
        let reference_script = server_bundle.client_references[0]
            .script
            .as_deref()
            .expect("client reference emits a script")
            .trim_start_matches("/_ferrite/static/");
        let reference_js = fs::read_to_string(
            temp.path()
                .join(".ferrite/build/_ferrite/static")
                .join(reference_script),
        )
        .unwrap();
        assert!(reference_js.contains("bootstrapServerActionForms"));

        fs::write(
            temp.path().join("app/actions/page.tsx"),
            r#"
export default function Page() {
  return <form method="post" action="/_ferrite/action"><button>Save</button></form>;
}
"#,
        )
        .unwrap();

        let action_bundle = bundler
            .bundle_route_request(ClientBundleRequest {
                page_file: &temp.path().join("app/actions/page.tsx"),
                layouts: &[],
                route_path: "/actions",
                params: &[],
                out_dir: &temp.path().join(".ferrite/build/_ferrite/static"),
                public_path: "/_ferrite/static",
                options: ClientBundleOptions {
                    action_bootstrap: true,
                    runtime_props: false,
                },
            })
            .unwrap();

        assert_eq!(action_bundle.script, None);
        assert!(action_bundle.client_references.is_empty());
        let action_bootstrap = action_bundle
            .action_bootstrap
            .as_deref()
            .expect("server-only action routes emit a standalone enhancer");
        let route_identity = &sha256_hex(b"/actions")[..16];
        assert!(action_bootstrap.ends_with(&format!(
            "route-actions-{route_identity}-action-bootstrap.js"
        )));
        let action_js = fs::read_to_string(
            temp.path()
                .join(".ferrite/build/_ferrite/static")
                .join(action_bootstrap.trim_start_matches("/_ferrite/static/")),
        )
        .unwrap();
        assert!(action_js.contains("bootstrapServerActionForms"));
    }

    #[test]
    fn real_runner_builds_parameter_independent_production_hydration() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("package.json"), "{}").unwrap();
        let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .canonicalize()
            .unwrap();
        fs::create_dir_all(temp.path().join("node_modules/@ferrite")).unwrap();
        symlink_dir(
            &repo_root.join("packages/runtime"),
            &temp.path().join("node_modules/@ferrite/runtime"),
        );
        fs::create_dir_all(temp.path().join("app/posts/[id]")).unwrap();
        fs::write(
            temp.path().join("app/posts/[id]/page.tsx"),
            r#"
"use client";
export default function Page({ params }) {
  return <h1>{params.id}</h1>;
}
"#,
        )
        .unwrap();
        let bundler = ClientBundler::new(
            temp.path().to_path_buf(),
            repo_root.join("packages/runtime/bin/build-client.mjs"),
        );
        let params = vec![(
            "id".to_owned(),
            Value::String("build-placeholder".to_owned()),
        )];
        let out_dir = temp.path().join(".ferrite/build/_ferrite/static");

        let bundle = bundler
            .bundle_route_request(ClientBundleRequest {
                page_file: &temp.path().join("app/posts/[id]/page.tsx"),
                layouts: &[],
                route_path: "/posts/:id",
                params: &params,
                out_dir: &out_dir,
                public_path: "/_ferrite/static",
                options: ClientBundleOptions {
                    action_bootstrap: false,
                    runtime_props: true,
                },
            })
            .unwrap();
        let script = bundle
            .script
            .as_deref()
            .unwrap()
            .trim_start_matches("/_ferrite/static/");
        let javascript = fs::read_to_string(out_dir.join(script)).unwrap();

        assert!(javascript.contains("data-ferrite-page-props"));
        assert!(!javascript.contains("build-placeholder"));
    }

    #[cfg(unix)]
    fn symlink_dir(original: &Path, link: &Path) {
        std::os::unix::fs::symlink(original, link).unwrap();
    }

    #[cfg(windows)]
    fn symlink_dir(original: &Path, link: &Path) {
        std::os::windows::fs::symlink_dir(original, link).unwrap();
    }

    #[test]
    fn reports_bundler_failures() {
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("build-client.mjs");
        make_script(
            &script,
            r#"
console.error("bundle failed");
process.exit(1);
"#,
        );
        let page = temp.path().join("page.tsx");
        fs::write(&page, "").unwrap();
        let bundler = ClientBundler::new(temp.path().to_path_buf(), script);

        let error = bundler
            .bundle_route(
                &page,
                &[],
                "/",
                &[],
                &temp.path().join("out"),
                "/_ferrite/static",
            )
            .unwrap_err();

        assert!(matches!(
            error,
            ClientBundleError::NodeFailed { stderr, .. } if stderr == "bundle failed"
        ));
    }

    #[test]
    fn times_out_hanging_bundlers() {
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("build-client.mjs");
        make_script(&script, "setInterval(() => {}, 1000);");
        let page = temp.path().join("page.tsx");
        fs::write(&page, "").unwrap();
        let bundler = ClientBundler::new(temp.path().to_path_buf(), script)
            .with_command_timeout(Duration::from_millis(20));

        let error = bundler
            .bundle_route(
                &page,
                &[],
                "/",
                &[],
                &temp.path().join("out"),
                "/_ferrite/static",
            )
            .unwrap_err();

        assert!(matches!(
            error,
            ClientBundleError::TimedOut { timeout } if timeout == Duration::from_millis(20)
        ));
    }

    #[cfg(unix)]
    #[test]
    fn timeout_terminates_bundler_descendants_with_inherited_output() {
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("build-client.mjs");
        let descendant_pid = temp.path().join("descendant.pid");
        let descendant_pid_json = serde_json::to_string(&descendant_pid).unwrap();
        make_script(
            &script,
            &format!(
                r#"
import {{ spawn }} from "node:child_process";
import {{ writeFileSync }} from "node:fs";
const descendant = spawn(process.execPath, ["-e", "setInterval(() => {{}}, 1000)"], {{
  stdio: ["ignore", "inherit", "inherit"],
}});
writeFileSync({descendant_pid_json}, String(descendant.pid));
setInterval(() => {{}}, 1000);
"#
            ),
        );
        let page = temp.path().join("page.tsx");
        fs::write(&page, "").unwrap();
        let timeout = Duration::from_millis(500);
        let bundler =
            ClientBundler::new(temp.path().to_path_buf(), script).with_command_timeout(timeout);
        let started = Instant::now();

        let error = bundler
            .bundle_route(
                &page,
                &[],
                "/",
                &[],
                &temp.path().join("out"),
                "/_ferrite/static",
            )
            .unwrap_err();
        let pid = fs::read_to_string(descendant_pid)
            .unwrap()
            .parse::<i32>()
            .unwrap();
        let mut guard = DescendantGuard(Some(pid));

        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(
            matches!(error, ClientBundleError::TimedOut { timeout: actual } if actual == timeout)
        );
        assert!(wait_for_process_exit(pid, Duration::from_secs(2)));
        guard.0 = None;
    }

    #[cfg(unix)]
    #[test]
    fn successful_bundler_cleans_descendants_before_collecting_output() {
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("build-client.mjs");
        let descendant_pid = temp.path().join("descendant.pid");
        let descendant_pid_json = serde_json::to_string(&descendant_pid).unwrap();
        make_script(
            &script,
            &format!(
                r#"
import {{ spawn }} from "node:child_process";
import {{ writeFileSync }} from "node:fs";
const descendant = spawn(process.execPath, ["-e", "setInterval(() => {{}}, 1000)"], {{
  stdio: ["ignore", "inherit", "inherit"],
}});
writeFileSync({descendant_pid_json}, String(descendant.pid));
descendant.unref();
process.stdout.write(JSON.stringify({{
  script: null,
  styles: [],
  outputs: [],
  sourcemaps: [],
  assets: [],
  clientReferences: [],
  moduleGraph: [],
  inputSnapshot: [],
}}));
"#
            ),
        );
        let page = temp.path().join("page.tsx");
        fs::write(&page, "").unwrap();
        let bundler = ClientBundler::new(temp.path().to_path_buf(), script);
        let started = Instant::now();

        let bundle = bundler
            .bundle_route(
                &page,
                &[],
                "/",
                &[],
                &temp.path().join("out"),
                "/_ferrite/static",
            )
            .unwrap();
        let pid = fs::read_to_string(descendant_pid)
            .unwrap()
            .parse::<i32>()
            .unwrap();
        let mut guard = DescendantGuard(Some(pid));

        assert!(bundle.outputs.is_empty());
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(wait_for_process_exit(pid, Duration::from_secs(2)));
        guard.0 = None;
    }

    #[cfg(unix)]
    #[test]
    fn cancellation_terminates_bundler_descendants() {
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("build-client.mjs");
        let descendant_pid = temp.path().join("descendant.pid");
        let descendant_pid_json = serde_json::to_string(&descendant_pid).unwrap();
        make_script(
            &script,
            &format!(
                r#"
import {{ spawn }} from "node:child_process";
import {{ writeFileSync }} from "node:fs";
const descendant = spawn(process.execPath, ["-e", "setInterval(() => {{}}, 1000)"], {{
  stdio: ["ignore", "inherit", "inherit"],
}});
writeFileSync({descendant_pid_json}, String(descendant.pid));
setInterval(() => {{}}, 1000);
"#
            ),
        );
        let cancellation_flag = Arc::new(AtomicBool::new(false));
        let cancellation_writer = Arc::clone(&cancellation_flag);
        let pid_path = descendant_pid.clone();
        let cancellation_thread = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(2);
            while !pid_path.is_file() {
                assert!(
                    Instant::now() < deadline,
                    "bundler descendant did not start"
                );
                thread::sleep(Duration::from_millis(5));
            }
            cancellation_writer.store(true, Ordering::Release);
        });
        let mut command = Command::new("node");
        command.arg(script).current_dir(temp.path());
        let started = Instant::now();

        let error = run_command_with_limits(command, None, 1024, Some(cancellation_flag.as_ref()))
            .unwrap_err();
        cancellation_thread.join().unwrap();
        let pid = fs::read_to_string(descendant_pid)
            .unwrap()
            .parse::<i32>()
            .unwrap();
        let mut guard = DescendantGuard(Some(pid));

        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(matches!(error, ClientBundleError::Cancelled));
        assert!(wait_for_process_exit(pid, Duration::from_secs(2)));
        guard.0 = None;
    }

    #[test]
    fn bundler_output_is_bounded() {
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("build-client.mjs");
        make_script(&script, "process.stdout.write('x'.repeat(65));\n");
        let mut command = Command::new("node");
        command.arg(script).current_dir(temp.path());

        let error = run_command_with_limits(command, None, 64, None).unwrap_err();

        assert!(matches!(
            error,
            ClientBundleError::OutputLimitExceeded { limit: 64 }
        ));
    }

    #[cfg(unix)]
    struct DescendantGuard(Option<i32>);

    #[cfg(unix)]
    impl Drop for DescendantGuard {
        fn drop(&mut self) {
            if let Some(pid) = self.0 {
                // SAFETY: this test records the PID of the child process it spawned.
                unsafe {
                    libc::kill(pid, libc::SIGKILL);
                }
            }
        }
    }

    #[cfg(unix)]
    fn wait_for_process_exit(pid: i32, timeout: Duration) -> bool {
        let started = Instant::now();
        while started.elapsed() < timeout {
            // SAFETY: signal 0 checks the recorded child PID without modifying it.
            if unsafe { libc::kill(pid, 0) } != 0 {
                return true;
            }
            thread::sleep(Duration::from_millis(10));
        }
        false
    }

    #[test]
    fn passes_layouts_to_runner() {
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("build-client.mjs");
        make_script(
            &script,
            r#"
const layouts = JSON.parse(process.argv[7]);
process.stdout.write(JSON.stringify({
  script: `/_ferrite/static/layouts-${layouts.length}.js`,
  styles: [],
  outputs: [`layouts-${layouts.length}.js`],
  sourcemaps: [],
  assets: []
}));
"#,
        );
        let page = temp.path().join("page.tsx");
        let layout = temp.path().join("layout.tsx");
        fs::write(&page, "").unwrap();
        fs::write(&layout, "").unwrap();
        let bundler = ClientBundler::new(temp.path().to_path_buf(), script);

        let bundle = bundler
            .bundle_route(
                &page,
                &[layout],
                "/",
                &[],
                &temp.path().join("out"),
                "/_ferrite/static",
            )
            .unwrap();

        assert_eq!(
            bundle.script.as_deref(),
            Some("/_ferrite/static/layouts-1.js")
        );
    }

    #[test]
    fn passes_array_params_to_runner() {
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("build-client.mjs");
        make_script(
            &script,
            r#"
const props = JSON.parse(process.argv[6]);
const slug = props.params.slug.join("-");
process.stdout.write(JSON.stringify({
  script: `/_ferrite/static/docs-${slug}.js`,
  styles: [],
  outputs: [`docs-${slug}.js`],
  sourcemaps: [],
  assets: []
}));
"#,
        );
        let page = temp.path().join("page.tsx");
        fs::write(&page, "").unwrap();
        let bundler = ClientBundler::new(temp.path().to_path_buf(), script);

        let bundle = bundler
            .bundle_route(
                &page,
                &[],
                "/docs/a/b",
                &[("slug".to_owned(), json!(["a", "b"]))],
                &temp.path().join("out"),
                "/_ferrite/static",
            )
            .unwrap();

        assert_eq!(
            bundle.script.as_deref(),
            Some("/_ferrite/static/docs-a-b.js")
        );
    }
}
