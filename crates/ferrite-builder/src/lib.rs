mod legacy;
mod source_snapshot;

pub use legacy::{
    BuildConfig, BuildError, BuildReport, FERRITE_PRODUCTION_ARTIFACT_FORMAT,
    FERRITE_PRODUCTION_ARTIFACT_MAJOR, FERRITE_PRODUCTION_ARTIFACT_MANIFEST,
    FERRITE_PRODUCTION_ARTIFACT_MINOR, LoadedProductionArtifact, PageMetadataEntry,
    ProductionArtifactError, ProductionArtifactFile, ProductionArtifactFormat,
    ProductionArtifactManifest, ProductionArtifactRoute, Result, artifact_file_record,
    finalize_production_artifact_manifest, load_production_artifact,
};

use std::fs;
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{ChildStderr, ChildStdin, ChildStdout, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use ferrite_core::observability::{
    BuildFields, Component as ObservabilityComponent, CorrelationId, ErrorClass, Event,
    EventEmitter, FailurePhase, Operation as ObservabilityOperation, Outcome,
};
use ferrite_router::{Route, find_document_file, scan_app_dir, validate_route_types_output};
use serde::{Deserialize, Serialize};

use source_snapshot::ProjectSourceSnapshot;

#[cfg(unix)]
use std::os::unix::process::CommandExt;
#[cfg(not(windows))]
use std::process::Child;

#[cfg(windows)]
use process_wrap::std::{JobObject, StdChildWrapper, StdCommandWrap};

const BUILD_INPUT_VERIFIER_TIMEOUT: Duration = Duration::from_secs(120);
const BUILD_INPUT_VERIFIER_MAX_OUTPUT_BYTES: usize = 16 * 1024 * 1024;
const BUILD_INPUT_VERIFIER_POLL_INTERVAL: Duration = Duration::from_millis(5);
static BUILD_CANCELLATION_FLAG: OnceLock<Arc<AtomicBool>> = OnceLock::new();

pub fn build_cancellation_flag() -> Arc<AtomicBool> {
    Arc::clone(BUILD_CANCELLATION_FLAG.get_or_init(|| Arc::new(AtomicBool::new(false))))
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct BuildInputContract {
    routes: Vec<Route>,
    document_file: Option<PathBuf>,
    project_sources: ProjectSourceSnapshot,
    server_inputs: Vec<ServerBuildInput>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServerBuildInput {
    path: String,
    value: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServerBuildInputResponse {
    inputs: Vec<ServerBuildInput>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ServerBuildInputRequest {
    project: PathBuf,
    routes: Vec<ServerBuildInputRoute>,
    document_file: Option<PathBuf>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ServerBuildInputRoute {
    page_file: PathBuf,
    layouts: Vec<PathBuf>,
    loading_file: Option<PathBuf>,
    error_file: Option<PathBuf>,
}

pub fn build_project(config: &BuildConfig) -> Result<BuildReport> {
    build_project_inner(config)
}

pub fn build_project_with_observability(
    config: &BuildConfig,
    emitter: &EventEmitter,
) -> Result<BuildReport> {
    let correlation_id = CorrelationId::generate();
    let started = Instant::now();
    let _ = emitter.emit(
        Event::started(
            correlation_id.clone(),
            0,
            ObservabilityComponent::Builder,
            ObservabilityOperation::BuildProject,
        )
        .with_build(BuildFields::new(None)),
    );

    let result = build_project_inner(config);
    let (outcome, error_class, routes) = match &result {
        Ok(report) => (Outcome::Success, None, Some(report.routes_count)),
        Err(error) => {
            let (outcome, error_class) = classify_build_error(error);
            (outcome, Some(error_class), None)
        }
    };
    let _ = emitter.emit(
        Event::completed(
            correlation_id,
            1,
            ObservabilityComponent::Builder,
            ObservabilityOperation::BuildProject,
            outcome,
            error_class,
            Some(FailurePhase::Build),
            started.elapsed(),
        )
        .with_build(BuildFields::new(routes)),
    );
    result
}

fn build_project_inner(config: &BuildConfig) -> Result<BuildReport> {
    validate_build_output_ownership(config)?;
    let initial_contract = capture_build_input_contract(config)?;
    let out_parent = config.out_dir.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(out_parent)?;

    let candidate_holder = tempfile::Builder::new()
        .prefix(".ferrite-verified-build-")
        .tempdir_in(out_parent)?;
    let candidate_path = candidate_holder.path().join("candidate");
    let mut candidate_config = config.clone();
    candidate_config.out_dir = candidate_path.clone();

    let mut report = legacy::build_project(&candidate_config)?;
    ensure_build_contract_unchanged(&initial_contract, &capture_build_input_contract(config)?)?;

    if let Err(error) = install_verified_build(&candidate_path, &config.out_dir) {
        let _ = fs::remove_dir_all(&candidate_path);
        return Err(error.into());
    }
    rebase_build_report(&mut report, &candidate_path, &config.out_dir)?;
    Ok(report)
}

fn classify_build_error(error: &BuildError) -> (Outcome, ErrorClass) {
    match error {
        BuildError::ClientBundle(error) => match error {
            ferrite_client_bundler::ClientBundleError::Cancelled => {
                (Outcome::Cancelled, ErrorClass::Cancelled)
            }
            ferrite_client_bundler::ClientBundleError::TimedOut { .. } => {
                (Outcome::Timeout, ErrorClass::Timeout)
            }
            ferrite_client_bundler::ClientBundleError::OutputLimitExceeded { .. } => {
                (Outcome::Error, ErrorClass::ResourceExhausted)
            }
            ferrite_client_bundler::ClientBundleError::NodeFailed { .. } => {
                (Outcome::Error, ErrorClass::Dependency)
            }
            ferrite_client_bundler::ClientBundleError::Protocol(_) => {
                (Outcome::Error, ErrorClass::Protocol)
            }
            ferrite_client_bundler::ClientBundleError::StaleInputSnapshot { .. } => {
                (Outcome::Error, ErrorClass::StaleInput)
            }
            ferrite_client_bundler::ClientBundleError::Io(error) => classify_io_error(error),
            ferrite_client_bundler::ClientBundleError::Json(_)
            | ferrite_client_bundler::ClientBundleError::InvalidModuleGraph { .. } => {
                (Outcome::Error, ErrorClass::InvalidInput)
            }
        },
        BuildError::PageRender(error) => match error {
            ferrite_page_renderer::PageRenderError::Cancelled => {
                (Outcome::Cancelled, ErrorClass::Cancelled)
            }
            ferrite_page_renderer::PageRenderError::TimedOut { .. } => {
                (Outcome::Timeout, ErrorClass::Timeout)
            }
            ferrite_page_renderer::PageRenderError::OutputLimitExceeded { .. } => {
                (Outcome::Error, ErrorClass::ResourceExhausted)
            }
            ferrite_page_renderer::PageRenderError::NodeFailed { .. } => {
                (Outcome::Error, ErrorClass::Dependency)
            }
            ferrite_page_renderer::PageRenderError::Protocol(_) => {
                (Outcome::Error, ErrorClass::Protocol)
            }
            ferrite_page_renderer::PageRenderError::Io(error) => classify_io_error(error),
            ferrite_page_renderer::PageRenderError::Json(_)
            | ferrite_page_renderer::PageRenderError::Ssr(_) => {
                (Outcome::Error, ErrorClass::InvalidInput)
            }
        },
        BuildError::DuplicateStaticOutput { .. }
        | BuildError::InvalidStaticParams { .. }
        | BuildError::Router(_)
        | BuildError::Json(_) => (Outcome::Error, ErrorClass::InvalidInput),
        BuildError::Artifact(_) => (Outcome::Error, ErrorClass::Protocol),
        BuildError::Io(error) => classify_io_error(error),
    }
}

fn classify_io_error(error: &std::io::Error) -> (Outcome, ErrorClass) {
    match error.kind() {
        std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock => {
            (Outcome::Timeout, ErrorClass::Timeout)
        }
        std::io::ErrorKind::InvalidInput | std::io::ErrorKind::InvalidData => {
            (Outcome::Error, ErrorClass::InvalidInput)
        }
        _ => (Outcome::Error, ErrorClass::Io),
    }
}

fn validate_build_output_ownership(config: &BuildConfig) -> Result<()> {
    let project = normalized_path(&config.project)?;
    let app_dir = normalized_path(&config.app_dir)?;
    let out_dir = normalized_path(&config.out_dir)?;
    let types_out = normalized_path(&config.types_out)?;

    if out_dir == project || project.starts_with(&out_dir) || paths_overlap(&out_dir, &app_dir) {
        return Err(invalid_output_path(format!(
            "refusing build output `{}` because it overlaps Ferrite project source `{}`",
            config.out_dir.display(),
            config.app_dir.display()
        )));
    }
    if types_out == project
        || project.starts_with(&types_out)
        || paths_overlap(&types_out, &app_dir)
    {
        return Err(invalid_output_path(format!(
            "refusing route types output `{}` because it overlaps Ferrite project source `{}`",
            config.types_out.display(),
            config.app_dir.display()
        )));
    }
    if paths_overlap(&out_dir, &types_out) {
        return Err(invalid_output_path(format!(
            "refusing overlapping build output `{}` and route types output `{}`",
            config.out_dir.display(),
            config.types_out.display()
        )));
    }

    validate_existing_build_destination(&project, &out_dir)?;
    validate_route_types_output(&config.types_out)?;
    Ok(())
}

fn validate_existing_build_destination(project: &Path, out_dir: &Path) -> Result<()> {
    let metadata = match fs::symlink_metadata(out_dir) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(invalid_output_path(format!(
            "refusing to replace non-build output `{}`",
            out_dir.display()
        )));
    }

    let generated_root = normalized_path(&project.join(".ferrite"))?;
    if out_dir.starts_with(&generated_root) || fs::read_dir(out_dir)?.next().is_none() {
        return Ok(());
    }
    if load_production_artifact(out_dir).is_ok() {
        return Ok(());
    }

    Err(invalid_output_path(format!(
        "refusing to replace non-build output `{}`",
        out_dir.display()
    )))
}

fn normalized_path(path: &Path) -> io::Result<PathBuf> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    let mut resolved = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::Prefix(prefix) => resolved.push(prefix.as_os_str()),
            Component::RootDir => resolved.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                if !resolved.pop() {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        format!("path escapes its filesystem root: {}", path.display()),
                    ));
                }
            }
            Component::Normal(part) => {
                let candidate = resolved.join(part);
                match fs::symlink_metadata(&candidate) {
                    Ok(_) => resolved = fs::canonicalize(candidate)?,
                    Err(error) if error.kind() == io::ErrorKind::NotFound => resolved.push(part),
                    Err(error) => return Err(error),
                }
            }
        }
    }
    Ok(resolved)
}

fn paths_overlap(left: &Path, right: &Path) -> bool {
    left == right || left.starts_with(right) || right.starts_with(left)
}

fn invalid_output_path(message: String) -> BuildError {
    io::Error::new(io::ErrorKind::InvalidInput, message).into()
}

fn capture_build_input_contract(config: &BuildConfig) -> Result<BuildInputContract> {
    let routes = scan_app_dir(&config.app_dir)?;
    let document_file = find_document_file(&config.app_dir);
    let project_sources = ProjectSourceSnapshot::capture(
        &config.project,
        &[config.out_dir.clone(), config.types_out.clone()],
    )?;
    let server_inputs = capture_server_build_inputs(config, &routes, document_file.clone())?;

    Ok(BuildInputContract {
        routes,
        document_file,
        project_sources,
        server_inputs,
    })
}

fn capture_server_build_inputs(
    config: &BuildConfig,
    routes: &[Route],
    document_file: Option<PathBuf>,
) -> Result<Vec<ServerBuildInput>> {
    capture_server_build_inputs_with_limits(
        config,
        routes,
        document_file,
        BUILD_INPUT_VERIFIER_TIMEOUT,
        BUILD_INPUT_VERIFIER_MAX_OUTPUT_BYTES,
    )
}

fn capture_server_build_inputs_with_limits(
    config: &BuildConfig,
    routes: &[Route],
    document_file: Option<PathBuf>,
    timeout: Duration,
    max_output_bytes: usize,
) -> Result<Vec<ServerBuildInput>> {
    let verifier = config
        .client_bundler
        .parent()
        .ok_or_else(|| {
            BuildError::Io(io::Error::other(format!(
                "Ferrite client bundler has no parent directory: {}",
                config.client_bundler.display()
            )))
        })?
        .join("verify-build-inputs.mjs");
    if !verifier.is_file() {
        return Err(BuildError::Io(io::Error::new(
            io::ErrorKind::NotFound,
            format!(
                "Ferrite build input verifier is missing beside the client bundler: {}",
                verifier.display()
            ),
        )));
    }

    let request = ServerBuildInputRequest {
        project: config.project.clone(),
        routes: routes
            .iter()
            .map(|route| ServerBuildInputRoute {
                page_file: route.file.clone(),
                layouts: route.layouts.clone(),
                loading_file: route.loading.clone(),
                error_file: route.error.clone(),
            })
            .collect(),
        document_file,
    };
    let request_json = serde_json::to_vec(&request)?;
    let mut command = Command::new("node");
    command.arg(&verifier).current_dir(&config.project);
    let cancellation_flag = build_cancellation_flag();
    let output = run_build_input_verifier(
        command,
        request_json,
        timeout,
        max_output_bytes,
        cancellation_flag.as_ref(),
    )?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        return Err(BuildError::Io(io::Error::other(format!(
            "Ferrite build input preflight failed: {}",
            if stderr.is_empty() {
                "verifier exited without diagnostics"
            } else {
                &stderr
            }
        ))));
    }

    let response: ServerBuildInputResponse = serde_json::from_slice(&output.stdout)?;
    validate_server_build_inputs(&response.inputs)?;
    Ok(response.inputs)
}

struct BuildInputVerifierOutput {
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

fn run_build_input_verifier(
    mut command: Command,
    stdin: Vec<u8>,
    timeout: Duration,
    max_output_bytes: usize,
    cancellation_flag: &AtomicBool,
) -> io::Result<BuildInputVerifierOutput> {
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = OwnedChild::spawn(command)?;
    let mut child_stdin = child
        .take_stdin()
        .expect("build input verifier stdin was piped");
    let stdin_writer = thread::spawn(move || child_stdin.write_all(&stdin));
    let stdout = child
        .take_stdout()
        .expect("build input verifier stdout was piped");
    let stderr = child
        .take_stderr()
        .expect("build input verifier stderr was piped");
    let output_exceeded = Arc::new(AtomicBool::new(false));
    let stdout_reader = spawn_capped_reader(stdout, max_output_bytes, Arc::clone(&output_exceeded));
    let stderr_reader = spawn_capped_reader(stderr, max_output_bytes, Arc::clone(&output_exceeded));
    let started = Instant::now();

    loop {
        if cancellation_flag.load(Ordering::Acquire) {
            terminate_process_tree(&mut child);
            let _ = stdin_writer.join();
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "Ferrite build input verifier was cancelled",
            ));
        }

        if output_exceeded.load(Ordering::Acquire) {
            terminate_process_tree(&mut child);
            let _ = stdin_writer.join();
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("Ferrite build input verifier output exceeded {max_output_bytes} bytes"),
            ));
        }

        if let Some(status) = child.try_wait()? {
            terminate_process_tree(&mut child);
            let stdin_result = stdin_writer
                .join()
                .expect("build input verifier stdin writer panicked");
            let stdout = stdout_reader
                .join()
                .expect("build input verifier stdout reader panicked")?;
            let stderr = stderr_reader
                .join()
                .expect("build input verifier stderr reader panicked")?;
            if output_exceeded.load(Ordering::Acquire) {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!(
                        "Ferrite build input verifier output exceeded {max_output_bytes} bytes"
                    ),
                ));
            }
            if status.success() {
                stdin_result?;
            }
            return Ok(BuildInputVerifierOutput {
                status,
                stdout,
                stderr,
            });
        }

        if started.elapsed() >= timeout {
            terminate_process_tree(&mut child);
            let _ = stdin_writer.join();
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                format!(
                    "Ferrite build input verifier timed out after {} ms",
                    timeout.as_millis()
                ),
            ));
        }

        thread::sleep(
            BUILD_INPUT_VERIFIER_POLL_INTERVAL.min(timeout.saturating_sub(started.elapsed())),
        );
    }
}

fn spawn_capped_reader<R: Read + Send + 'static>(
    mut reader: R,
    max_output_bytes: usize,
    output_exceeded: Arc<AtomicBool>,
) -> thread::JoinHandle<io::Result<Vec<u8>>> {
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
    fn spawn(command: Command) -> io::Result<Self> {
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

    fn take_stdin(&mut self) -> Option<ChildStdin> {
        #[cfg(windows)]
        return self.inner.stdin().take();

        #[cfg(not(windows))]
        self.inner.stdin.take()
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

    fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
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

fn validate_server_build_inputs(inputs: &[ServerBuildInput]) -> Result<()> {
    let mut previous: Option<&str> = None;
    for input in inputs {
        if input.path.is_empty() || !Path::new(&input.path).is_absolute() {
            return Err(BuildError::Io(io::Error::other(
                "Ferrite build input verifier returned a non-absolute path",
            )));
        }
        if !is_sha256_value(&input.value) {
            return Err(BuildError::Io(io::Error::other(format!(
                "Ferrite build input verifier returned an invalid digest for {}",
                input.path
            ))));
        }
        if previous.is_some_and(|previous| previous >= input.path.as_str()) {
            return Err(BuildError::Io(io::Error::other(
                "Ferrite build input verifier returned unsorted or duplicate paths",
            )));
        }
        previous = Some(&input.path);
    }
    Ok(())
}

fn is_sha256_value(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|digest| {
        digest.len() == 64
            && digest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

fn ensure_build_contract_unchanged(
    initial: &BuildInputContract,
    current: &BuildInputContract,
) -> Result<()> {
    if initial == current {
        return Ok(());
    }

    Err(BuildError::Io(io::Error::other(
        "Ferrite project routes or build inputs changed during the production build; retry after the source tree is stable",
    )))
}

fn install_verified_build(candidate: &Path, destination: &Path) -> io::Result<()> {
    let parent = destination.parent().unwrap_or_else(|| Path::new("."));
    let mut backup = None;
    if destination.exists() {
        let backup_holder = tempfile::Builder::new()
            .prefix(".ferrite-previous-")
            .tempdir_in(parent)?;
        let backup_path = backup_holder.keep();
        fs::remove_dir(&backup_path)?;
        fs::rename(destination, &backup_path)?;
        backup = Some(backup_path);
    }

    if let Err(error) = fs::rename(candidate, destination) {
        if let Some(backup_path) = backup.as_ref() {
            if let Err(rollback_error) = fs::rename(backup_path, destination) {
                return Err(io::Error::new(
                    error.kind(),
                    format!(
                        "could not activate verified build: {error}; could not restore previous build from `{}`: {rollback_error}",
                        backup_path.display()
                    ),
                ));
            }
        }
        return Err(error);
    }

    if let Some(backup_path) = backup {
        let _ = fs::remove_dir_all(backup_path);
    }
    Ok(())
}

fn rebase_build_report(report: &mut BuildReport, from: &Path, to: &Path) -> Result<()> {
    for path in &mut report.html_files {
        *path = rebase_build_path(path, from, to)?;
    }
    for path in &mut report.server_modules {
        *path = rebase_build_path(path, from, to)?;
    }
    report.out_dir = to.to_path_buf();
    report.manifest_file = rebase_build_path(&report.manifest_file, from, to)?;
    report.production_manifest_file =
        rebase_build_path(&report.production_manifest_file, from, to)?;
    Ok(())
}

fn rebase_build_path(path: &Path, from: &Path, to: &Path) -> Result<PathBuf> {
    let relative = path.strip_prefix(from).map_err(|_| {
        BuildError::Artifact(ProductionArtifactError::Invalid(format!(
            "verified output `{}` is outside candidate root `{}`",
            path.display(),
            from.display()
        )))
    })?;
    Ok(to.join(relative))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ferrite_router::GENERATED_ROUTE_TYPES_HEADER;

    fn test_config(root: &Path) -> BuildConfig {
        let app_dir = root.join("app");
        fs::create_dir_all(&app_dir).unwrap();
        fs::write(
            app_dir.join("page.tsx"),
            "export default function Page() {}\n",
        )
        .unwrap();
        BuildConfig::new(
            root.to_path_buf(),
            app_dir,
            root.join(".ferrite/build"),
            root.join(".ferrite/types/routes.d.ts"),
            root.join("render-page.mjs"),
            root.join("build-client.mjs"),
        )
    }

    #[test]
    fn rejects_build_output_that_overlaps_app_source() {
        let project = tempfile::tempdir().unwrap();
        let mut config = test_config(project.path());
        let page = config.app_dir.join("page.tsx");
        config.out_dir = config.app_dir.clone();

        let error = validate_build_output_ownership(&config).unwrap_err();

        assert!(
            error
                .to_string()
                .contains("overlaps Ferrite project source")
        );
        assert_eq!(
            fs::read_to_string(page).unwrap(),
            "export default function Page() {}\n"
        );
    }

    #[test]
    fn observed_build_failure_is_correlated_classified_and_message_free() {
        let project = tempfile::tempdir().unwrap();
        let mut config = test_config(project.path());
        config.out_dir = config.app_dir.clone();
        let (emitter, receiver) = ferrite_core::observability::bounded_channel(4);

        let error = build_project_with_observability(&config, &emitter).unwrap_err();
        let events = receiver.try_iter().collect::<Vec<_>>();

        assert!(
            error
                .to_string()
                .contains("overlaps Ferrite project source")
        );
        assert_eq!(events.len(), 2);
        assert_eq!(
            events[0].event,
            ferrite_core::observability::EventName::OperationStarted
        );
        assert_eq!(
            events[1].event,
            ferrite_core::observability::EventName::OperationCompleted
        );
        assert_eq!(events[0].correlation_id, events[1].correlation_id);
        assert_eq!(events[1].outcome, Some(Outcome::Error));
        assert_eq!(events[1].error_class, Some(ErrorClass::InvalidInput));
        assert_eq!(events[1].failure_phase, Some(FailurePhase::Build));
        let encoded = events[1].to_json_line().unwrap();
        assert!(!encoded.contains("overlaps Ferrite project source"));
        assert!(!encoded.contains(project.path().to_string_lossy().as_ref()));
    }

    #[test]
    fn rejects_existing_non_generated_route_types_output() {
        let project = tempfile::tempdir().unwrap();
        let mut config = test_config(project.path());
        config.types_out = project.path().join("notes.txt");
        fs::write(&config.types_out, "keep this source file\n").unwrap();

        let error = validate_build_output_ownership(&config).unwrap_err();

        assert!(
            error
                .to_string()
                .contains("non-generated route types output")
        );
        assert_eq!(
            fs::read_to_string(&config.types_out).unwrap(),
            "keep this source file\n"
        );
    }

    #[test]
    fn rejects_existing_non_build_destination() {
        let project = tempfile::tempdir().unwrap();
        let mut config = test_config(project.path());
        config.out_dir = project.path().join("docs");
        fs::create_dir_all(&config.out_dir).unwrap();
        fs::write(config.out_dir.join("owned.md"), "keep\n").unwrap();

        let error = validate_build_output_ownership(&config).unwrap_err();

        assert!(error.to_string().contains("non-build output"));
        assert_eq!(
            fs::read_to_string(config.out_dir.join("owned.md")).unwrap(),
            "keep\n"
        );
    }

    #[test]
    fn accepts_empty_custom_build_output_and_owned_route_types() {
        let project = tempfile::tempdir().unwrap();
        let mut config = test_config(project.path());
        config.out_dir = project.path().join("dist");
        fs::create_dir_all(&config.out_dir).unwrap();
        fs::create_dir_all(config.types_out.parent().unwrap()).unwrap();
        fs::write(
            &config.types_out,
            format!("{GENERATED_ROUTE_TYPES_HEADER}\nstale\n"),
        )
        .unwrap();

        validate_build_output_ownership(&config).unwrap();
    }

    #[test]
    fn build_input_verifier_output_is_bounded() {
        let project = tempfile::tempdir().unwrap();
        let config = test_config(project.path());
        fs::write(&config.client_bundler, "").unwrap();
        fs::write(
            project.path().join("verify-build-inputs.mjs"),
            "process.stdout.write('x'.repeat(4096));\n",
        )
        .unwrap();

        let error =
            capture_server_build_inputs_with_limits(&config, &[], None, Duration::from_secs(2), 64)
                .unwrap_err();

        assert!(error.to_string().contains("output exceeded 64 bytes"));
    }

    #[cfg(unix)]
    #[test]
    fn build_input_verifier_timeout_terminates_descendants() {
        let project = tempfile::tempdir().unwrap();
        let config = test_config(project.path());
        let descendant_pid = project.path().join("descendant.pid");
        let descendant_pid_json = serde_json::to_string(&descendant_pid).unwrap();
        fs::write(&config.client_bundler, "").unwrap();
        fs::write(
            project.path().join("verify-build-inputs.mjs"),
            format!(
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
        )
        .unwrap();
        let timeout = Duration::from_millis(500);
        let started = Instant::now();

        let error =
            capture_server_build_inputs_with_limits(&config, &[], None, timeout, 1024).unwrap_err();
        let pid = fs::read_to_string(descendant_pid)
            .unwrap()
            .parse::<i32>()
            .unwrap();
        let mut guard = DescendantGuard(Some(pid));

        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(error.to_string().contains("timed out after 500 ms"));
        assert!(wait_for_process_exit(pid, Duration::from_secs(2)));
        guard.0 = None;
    }

    #[cfg(unix)]
    #[test]
    fn successful_build_input_verifier_cleans_descendants() {
        let project = tempfile::tempdir().unwrap();
        let config = test_config(project.path());
        let descendant_pid = project.path().join("descendant.pid");
        let descendant_pid_json = serde_json::to_string(&descendant_pid).unwrap();
        fs::write(&config.client_bundler, "").unwrap();
        fs::write(
            project.path().join("verify-build-inputs.mjs"),
            format!(
                r#"
import {{ spawn }} from "node:child_process";
import {{ writeFileSync }} from "node:fs";
const descendant = spawn(process.execPath, ["-e", "setInterval(() => {{}}, 1000)"], {{
  stdio: ["ignore", "inherit", "inherit"],
}});
writeFileSync({descendant_pid_json}, String(descendant.pid));
descendant.unref();
process.stdout.write(JSON.stringify({{ inputs: [] }}));
"#
            ),
        )
        .unwrap();
        let started = Instant::now();

        let inputs = capture_server_build_inputs_with_limits(
            &config,
            &[],
            None,
            Duration::from_secs(2),
            1024,
        )
        .unwrap();
        let pid = fs::read_to_string(descendant_pid)
            .unwrap()
            .parse::<i32>()
            .unwrap();
        let mut guard = DescendantGuard(Some(pid));

        assert!(inputs.is_empty());
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(wait_for_process_exit(pid, Duration::from_secs(2)));
        guard.0 = None;
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
}
