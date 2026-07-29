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

use std::collections::BTreeSet;
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
use sha2::{Digest, Sha256};

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

#[derive(Debug, Clone, PartialEq, Eq)]
struct BuildOutputContract {
    build: DestinationIdentity,
    route_types: DestinationIdentity,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum DestinationIdentity {
    Missing,
    File { size: u64, sha256: String },
    Directory(Vec<DestinationEntryIdentity>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DestinationEntryIdentity {
    path: PathBuf,
    kind: DestinationEntryKind,
    size: u64,
    sha256: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DestinationEntryKind {
    Directory,
    File,
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
    run_observed_build(emitter, || build_project_inner(config))
}

fn run_observed_build<F>(emitter: &EventEmitter, build: F) -> Result<BuildReport>
where
    F: FnOnce() -> Result<BuildReport>,
{
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

    let result = build();
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
    let output_contract = validate_build_output_ownership(config)?;
    let initial_contract = capture_build_input_contract(config)?;
    let out_parent = config.out_dir.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(out_parent)?;

    let candidate_holder = tempfile::Builder::new()
        .prefix(".ferrite-verified-build-")
        .tempdir_in(out_parent)?;
    let candidate_path = candidate_holder.path().join("candidate");
    let candidate_types_path = candidate_holder.path().join("types/routes.d.ts");
    let mut candidate_config = config.clone();
    candidate_config.out_dir = candidate_path.clone();
    candidate_config.types_out = candidate_types_path.clone();

    let mut report = legacy::build_project(&candidate_config)?;
    ensure_build_contract_unchanged(&initial_contract, &capture_build_input_contract(config)?)?;
    rebase_build_report(&mut report, &candidate_path, &config.out_dir)?;

    let types_parent = config.types_out.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(types_parent)?;
    let staged_types_holder = tempfile::Builder::new()
        .prefix(".ferrite-verified-types-")
        .tempdir_in(types_parent)?;
    let staged_types_path = staged_types_holder.path().join("routes.d.ts");
    fs::copy(&candidate_types_path, &staged_types_path)?;
    fs::remove_file(&candidate_types_path)?;
    if let Some(candidate_types_parent) = candidate_types_path.parent() {
        fs::remove_dir(candidate_types_parent)?;
    }

    let candidate_root = candidate_holder.keep();
    let staged_types_root = staged_types_holder.keep();
    let cancellation_flag = build_cancellation_flag();
    let activation = install_verified_outputs_unless_cancelled(
        &candidate_path,
        &config.out_dir,
        &staged_types_path,
        &config.types_out,
        cancellation_flag.as_ref(),
        &output_contract,
    );
    let mut scratch_errors = Vec::new();
    for (label, root, retained_path) in [
        ("build", candidate_root.as_path(), candidate_path.as_path()),
        (
            "route types",
            staged_types_root.as_path(),
            staged_types_path.as_path(),
        ),
    ] {
        if retained_path.exists() {
            continue;
        }
        if let Err(error) = fs::remove_dir(root) {
            scratch_errors.push(format!(
                "could not remove empty {label} scratch root `{}`: {error}; the scratch root was preserved",
                root.display()
            ));
        }
    }
    if let Err(error) = activation {
        return Err(activation_error(error, scratch_errors).into());
    }
    if !scratch_errors.is_empty() {
        return Err(BuildError::Io(io::Error::other(format!(
            "verified build outputs were activated, but scratch cleanup was incomplete: {}",
            scratch_errors.join("; ")
        ))));
    }
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

fn validate_build_output_ownership(config: &BuildConfig) -> Result<BuildOutputContract> {
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

    let build = validate_existing_build_destination(&project, &out_dir)?;
    validate_route_types_output(&config.types_out)?;
    let route_types = capture_destination_identity(&types_out)?;
    Ok(BuildOutputContract { build, route_types })
}

fn validate_existing_build_destination(
    project: &Path,
    out_dir: &Path,
) -> Result<DestinationIdentity> {
    let metadata = match fs::symlink_metadata(out_dir) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(DestinationIdentity::Missing);
        }
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
        return Ok(capture_destination_identity(out_dir)?);
    }
    if let Ok(artifact) = load_production_artifact(out_dir) {
        let identity = capture_destination_identity(out_dir)?;
        validate_exact_artifact_ownership(&artifact, &identity)?;
        return Ok(identity);
    }

    Err(invalid_output_path(format!(
        "refusing to replace non-build output `{}`",
        out_dir.display()
    )))
}

fn validate_exact_artifact_ownership(
    artifact: &LoadedProductionArtifact,
    identity: &DestinationIdentity,
) -> Result<()> {
    let DestinationIdentity::Directory(entries) = identity else {
        return Err(invalid_output_path(format!(
            "refusing to replace non-build output `{}`",
            artifact.root.display()
        )));
    };

    let mut allowed_files = artifact
        .manifest
        .files
        .iter()
        .map(|file| PathBuf::from(&file.path))
        .collect::<BTreeSet<_>>();
    allowed_files.insert(PathBuf::from(FERRITE_PRODUCTION_ARTIFACT_MANIFEST));
    allowed_files.insert(PathBuf::from("ferrite-build.json"));

    let mut allowed_directories = [
        PathBuf::from("_ferrite"),
        PathBuf::from("_ferrite/static"),
        PathBuf::from("server"),
    ]
    .into_iter()
    .collect::<BTreeSet<_>>();
    for path in &allowed_files {
        let mut parent = path.parent();
        while let Some(directory) = parent {
            if directory.as_os_str().is_empty() {
                break;
            }
            allowed_directories.insert(directory.to_path_buf());
            parent = directory.parent();
        }
    }

    for entry in entries {
        let declared = match entry.kind {
            DestinationEntryKind::Directory => allowed_directories.contains(&entry.path),
            DestinationEntryKind::File => allowed_files.contains(&entry.path),
        };
        if !declared {
            return Err(invalid_output_path(format!(
                "refusing to replace artifact `{}` because it contains undeclared entry `{}`",
                artifact.root.display(),
                entry.path.display()
            )));
        }
    }
    Ok(())
}

fn capture_destination_identity(path: &Path) -> io::Result<DestinationIdentity> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(DestinationIdentity::Missing);
        }
        Err(error) => return Err(error),
    };
    if metadata.file_type().is_symlink() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("destination `{}` is a symbolic link", path.display()),
        ));
    }
    if metadata.is_file() {
        return Ok(DestinationIdentity::File {
            size: metadata.len(),
            sha256: sha256_file(path)?,
        });
    }
    if !metadata.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "destination `{}` is not a regular file or directory",
                path.display()
            ),
        ));
    }

    let canonical_root = fs::canonicalize(path)?;
    let mut entries = Vec::new();
    capture_directory_entries(path, path, &canonical_root, &mut entries)?;
    entries.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(DestinationIdentity::Directory(entries))
}

fn capture_directory_entries(
    root: &Path,
    directory: &Path,
    canonical_root: &Path,
    entries: &mut Vec<DestinationEntryIdentity>,
) -> io::Result<()> {
    let mut children = fs::read_dir(directory)?.collect::<io::Result<Vec<_>>>()?;
    children.sort_by_key(|entry| entry.file_name());
    for child in children {
        let path = child.path();
        let relative = path.strip_prefix(root).map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("destination entry `{}` escaped its root", path.display()),
            )
        })?;
        let metadata = fs::symlink_metadata(&path)?;
        if metadata.file_type().is_symlink() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "destination entry `{}` is a symbolic link",
                    relative.display()
                ),
            ));
        }
        let canonical = fs::canonicalize(&path)?;
        if !canonical.starts_with(canonical_root) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "destination entry `{}` resolves outside its root",
                    relative.display()
                ),
            ));
        }
        if metadata.is_dir() {
            entries.push(DestinationEntryIdentity {
                path: relative.to_path_buf(),
                kind: DestinationEntryKind::Directory,
                size: 0,
                sha256: None,
            });
            capture_directory_entries(root, &path, canonical_root, entries)?;
        } else if metadata.is_file() {
            entries.push(DestinationEntryIdentity {
                path: relative.to_path_buf(),
                kind: DestinationEntryKind::File,
                size: metadata.len(),
                sha256: Some(sha256_file(&path)?),
            });
        } else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "destination entry `{}` is not a regular file or directory",
                    relative.display()
                ),
            ));
        }
    }
    Ok(())
}

fn sha256_file(path: &Path) -> io::Result<String> {
    let mut file = fs::File::open(path)?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    let digest = digest.finalize();
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[cfg(any(
    target_vendor = "apple",
    target_os = "linux",
    target_os = "android",
    target_os = "redox"
))]
fn rename_noreplace(source: &Path, destination: &Path) -> io::Result<()> {
    use rustix::fs::{CWD, RenameFlags, renameat_with};

    renameat_with(CWD, source, CWD, destination, RenameFlags::NOREPLACE).map_err(io::Error::from)
}

#[cfg(all(
    unix,
    not(any(
        target_vendor = "apple",
        target_os = "linux",
        target_os = "android",
        target_os = "redox"
    ))
))]
fn rename_noreplace(source: &Path, destination: &Path) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        format!(
            "atomic no-clobber rename from `{}` to `{}` is unsupported on this platform",
            source.display(),
            destination.display()
        ),
    ))
}

#[cfg(windows)]
fn rename_noreplace(source: &Path, destination: &Path) -> io::Result<()> {
    use std::iter;
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        #[link_name = "MoveFileExW"]
        fn move_file_ex_w(
            existing_file_name: *const u16,
            new_file_name: *const u16,
            flags: u32,
        ) -> i32;
    }

    let source = source
        .as_os_str()
        .encode_wide()
        .chain(iter::once(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(iter::once(0))
        .collect::<Vec<_>>();
    // SAFETY: both buffers are NUL-terminated UTF-16 paths and remain alive for the call.
    let result = unsafe { move_file_ex_w(source.as_ptr(), destination.as_ptr(), 0) };
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
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

fn install_verified_outputs(
    candidate_build: &Path,
    build_destination: &Path,
    candidate_types: &Path,
    types_destination: &Path,
    expected: &BuildOutputContract,
) -> io::Result<()> {
    install_verified_outputs_with_ops(
        candidate_build,
        build_destination,
        candidate_types,
        types_destination,
        expected,
        rename_noreplace,
        remove_owned_path,
    )
}

fn install_verified_outputs_unless_cancelled(
    candidate_build: &Path,
    build_destination: &Path,
    candidate_types: &Path,
    types_destination: &Path,
    cancellation_flag: &AtomicBool,
    expected: &BuildOutputContract,
) -> io::Result<()> {
    if cancellation_flag.load(Ordering::Acquire) {
        let primary = io::Error::new(
            io::ErrorKind::Interrupted,
            "Ferrite build activation was cancelled",
        );
        let lifecycle_errors =
            cleanup_candidates(candidate_build, candidate_types, &mut remove_owned_path);
        return Err(activation_error(primary, lifecycle_errors));
    }
    install_verified_outputs(
        candidate_build,
        build_destination,
        candidate_types,
        types_destination,
        expected,
    )
}

fn install_verified_outputs_with_ops<R, C>(
    candidate_build: &Path,
    build_destination: &Path,
    candidate_types: &Path,
    types_destination: &Path,
    expected: &BuildOutputContract,
    mut move_noreplace: R,
    mut cleanup: C,
) -> io::Result<()>
where
    R: FnMut(&Path, &Path) -> io::Result<()>,
    C: FnMut(&Path) -> io::Result<()>,
{
    let build_backup = match claim_expected_destination(
        build_destination,
        &expected.build,
        ".ferrite-previous-build-",
        &mut move_noreplace,
    ) {
        Ok(backup) => backup,
        Err(error) => {
            let lifecycle_errors =
                cleanup_candidates(candidate_build, candidate_types, &mut cleanup);
            return Err(activation_error(error, lifecycle_errors));
        }
    };
    let types_backup = match claim_expected_destination(
        types_destination,
        &expected.route_types,
        ".ferrite-previous-types-",
        &mut move_noreplace,
    ) {
        Ok(backup) => backup,
        Err(error) => {
            let mut lifecycle_errors = restore_backups(
                build_backup.as_deref(),
                build_destination,
                None,
                types_destination,
                &mut move_noreplace,
            );
            lifecycle_errors.extend(cleanup_candidates(
                candidate_build,
                candidate_types,
                &mut cleanup,
            ));
            return Err(activation_error(error, lifecycle_errors));
        }
    };

    if let Err(error) = move_noreplace(candidate_build, build_destination) {
        let error = candidate_activation_error(error, build_destination);
        let mut lifecycle_errors = restore_backups(
            build_backup.as_deref(),
            build_destination,
            types_backup.as_deref(),
            types_destination,
            &mut move_noreplace,
        );
        lifecycle_errors.extend(cleanup_candidates(
            candidate_build,
            candidate_types,
            &mut cleanup,
        ));
        return Err(activation_error(error, lifecycle_errors));
    }

    if let Err(error) = move_noreplace(candidate_types, types_destination) {
        let error = candidate_activation_error(error, types_destination);
        let mut lifecycle_errors = return_installed_candidate(
            "build",
            build_destination,
            candidate_build,
            &mut move_noreplace,
        );
        lifecycle_errors.extend(restore_backups(
            build_backup.as_deref(),
            build_destination,
            types_backup.as_deref(),
            types_destination,
            &mut move_noreplace,
        ));
        lifecycle_errors.extend(cleanup_candidates(
            candidate_build,
            candidate_types,
            &mut cleanup,
        ));
        return Err(activation_error(error, lifecycle_errors));
    }

    let mut cleanup_errors = Vec::new();
    for (label, backup) in [
        ("previous build", build_backup.as_deref()),
        ("previous route types", types_backup.as_deref()),
    ] {
        if let Some(backup) = backup
            && let Err(error) = cleanup(backup)
        {
            cleanup_errors.push(format!(
                "could not remove {label} recovery path `{}` after activation: {error}; the recovery path was preserved",
                backup.display()
            ));
        }
    }
    if !cleanup_errors.is_empty() {
        return Err(io::Error::other(format!(
            "verified build outputs were activated, but recovery cleanup was incomplete: {}",
            cleanup_errors.join("; ")
        )));
    }
    Ok(())
}

fn claim_expected_destination<R>(
    destination: &Path,
    expected: &DestinationIdentity,
    prefix: &str,
    move_noreplace: &mut R,
) -> io::Result<Option<PathBuf>>
where
    R: FnMut(&Path, &Path) -> io::Result<()>,
{
    if matches!(expected, DestinationIdentity::Missing) {
        // The final no-clobber move is the compare-and-swap for an absent destination.
        // A separate existence check would only reopen a check-to-rename race.
        return Ok(None);
    }
    match fs::symlink_metadata(destination) {
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                format!(
                    "destination `{}` changed after validation; the expected path is missing",
                    destination.display()
                ),
            ));
        }
        Err(error) => return Err(error),
    }

    let parent = destination.parent().unwrap_or_else(|| Path::new("."));
    let backup_holder = tempfile::Builder::new().prefix(prefix).tempdir_in(parent)?;
    let backup_path = backup_holder.keep();
    fs::remove_dir(&backup_path)?;
    move_noreplace(destination, &backup_path)?;

    let claimed = capture_destination_identity(&backup_path);
    if claimed.as_ref().is_ok_and(|claimed| claimed == expected) {
        return Ok(Some(backup_path));
    }

    let primary = match claimed {
        Ok(_) => io::Error::other(format!(
            "destination `{}` changed after validation; refusing to activate over the claimed path",
            destination.display()
        )),
        Err(error) => io::Error::new(
            error.kind(),
            format!(
                "could not verify claimed destination `{}` after validation: {error}",
                backup_path.display()
            ),
        ),
    };
    if let Err(restore_error) = move_noreplace(&backup_path, destination) {
        return Err(activation_error(
            primary,
            vec![format!(
                "could not restore changed destination from recovery path `{}` to `{}`: {restore_error}; the recovery path was preserved",
                backup_path.display(),
                destination.display()
            )],
        ));
    }
    Err(primary)
}

fn candidate_activation_error(error: io::Error, destination: &Path) -> io::Error {
    if error.kind() == io::ErrorKind::AlreadyExists {
        io::Error::new(
            error.kind(),
            format!(
                "destination `{}` changed after validation; atomic activation refused to replace it: {error}",
                destination.display()
            ),
        )
    } else {
        error
    }
}

fn return_installed_candidate<R>(
    label: &str,
    destination: &Path,
    candidate: &Path,
    move_noreplace: &mut R,
) -> Vec<String>
where
    R: FnMut(&Path, &Path) -> io::Result<()>,
{
    match move_noreplace(destination, candidate) {
        Ok(()) => Vec::new(),
        Err(error) => vec![format!(
            "could not return candidate {label} from `{}` to `{}`: {error}; the active candidate path was preserved",
            destination.display(),
            candidate.display()
        )],
    }
}

fn restore_backups<R>(
    build_backup: Option<&Path>,
    build_destination: &Path,
    types_backup: Option<&Path>,
    types_destination: &Path,
    move_noreplace: &mut R,
) -> Vec<String>
where
    R: FnMut(&Path, &Path) -> io::Result<()>,
{
    let mut errors = Vec::new();
    for (label, backup, destination) in [
        ("route types", types_backup, types_destination),
        ("build", build_backup, build_destination),
    ] {
        if let Some(backup) = backup
            && let Err(error) = move_noreplace(backup, destination)
        {
            errors.push(format!(
                "could not restore previous {label} from `{}` to `{}`: {error}",
                backup.display(),
                destination.display()
            ));
        }
    }
    errors
}

fn cleanup_candidates<C>(
    candidate_build: &Path,
    candidate_types: &Path,
    cleanup: &mut C,
) -> Vec<String>
where
    C: FnMut(&Path) -> io::Result<()>,
{
    let mut errors = Vec::new();
    for (label, path) in [("build", candidate_build), ("route types", candidate_types)] {
        match fs::symlink_metadata(path) {
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => {
                errors.push(format!(
                    "could not inspect candidate {label} at `{}` before cleanup: {error}; the candidate path was preserved",
                    path.display()
                ));
                continue;
            }
        }
        if let Err(error) = cleanup(path) {
            errors.push(format!(
                "could not remove candidate {label} at `{}`: {error}; the candidate path was preserved",
                path.display()
            ));
        }
    }
    errors
}

fn remove_owned_path(path: &Path) -> io::Result<()> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    if metadata.file_type().is_symlink() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("refusing to remove symbolic link `{}`", path.display()),
        ));
    }
    if metadata.is_dir() {
        fs::remove_dir_all(path)
    } else if metadata.is_file() {
        fs::remove_file(path)
    } else {
        Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "refusing to remove non-file, non-directory path `{}`",
                path.display()
            ),
        ))
    }
}

fn activation_error(primary: io::Error, lifecycle_errors: Vec<String>) -> io::Error {
    if lifecycle_errors.is_empty() {
        primary
    } else {
        io::Error::new(
            primary.kind(),
            format!(
                "could not activate verified build outputs: {primary}; {}",
                lifecycle_errors.join("; ")
            ),
        )
    }
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

    fn write_test_file(path: &Path, value: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, value).unwrap();
    }

    fn successful_public_build_config(root: &Path) -> BuildConfig {
        let config = test_config(root);
        write_test_file(
            &config.page_renderer,
            r#"
const fs = await import("node:fs/promises");
const path = await import("node:path");
const mode = process.argv[2];
if (mode === "--build-artifact") {
  const output = process.argv[4];
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(
    output,
    "export const pageModule = {}; export const layoutModules = []; export const documentModule = null; export const conventionModules = {}; export const routePattern = '/';\n",
  );
  process.exit(0);
}
if (mode === "--static-params") {
  process.stdout.write(JSON.stringify({ has_generate_static_params: false, params: [] }));
  process.exit(0);
}
if (mode === "--server-action-manifest") {
  process.stdout.write(JSON.stringify({ routePath: "/", actions: [] }));
  process.exit(0);
}
if (mode === "--metadata") {
  process.stdout.write("{}");
  process.exit(0);
}
process.stdout.write(JSON.stringify({ kind: "text", value: "ok" }));
"#,
        );
        write_test_file(
            &config.client_bundler,
            r#"
process.stdout.write(JSON.stringify({
  script: null,
  styles: [],
  outputs: [],
  sourcemaps: [],
  assets: [],
  inputSnapshot: []
}));
"#,
        );
        write_test_file(
            &root.join("verify-build-inputs.mjs"),
            r#"
for await (const _chunk of process.stdin) {}
process.stdout.write(JSON.stringify({ inputs: [] }));
"#,
        );
        config
    }

    fn seed_previous_outputs(config: &BuildConfig) {
        write_test_file(
            &config.out_dir.join("previous.txt"),
            "previous build output\n",
        );
        write_test_file(
            &config.types_out,
            &format!("{GENERATED_ROUTE_TYPES_HEADER}\nprevious route types\n"),
        );
    }

    fn assert_previous_outputs(config: &BuildConfig) {
        assert_eq!(
            fs::read_to_string(config.out_dir.join("previous.txt")).unwrap(),
            "previous build output\n"
        );
        assert_eq!(
            fs::read_to_string(&config.types_out).unwrap(),
            format!("{GENERATED_ROUTE_TYPES_HEADER}\nprevious route types\n")
        );
    }

    fn output_contract_for(
        build_destination: &Path,
        types_destination: &Path,
    ) -> BuildOutputContract {
        BuildOutputContract {
            build: capture_destination_identity(build_destination).unwrap(),
            route_types: capture_destination_identity(types_destination).unwrap(),
        }
    }

    fn seed_empty_owned_artifact(out_dir: &Path) {
        fs::create_dir_all(out_dir).unwrap();
        let manifest =
            ProductionArtifactManifest::new("/_ferrite/static", false, Vec::new(), Vec::new())
                .unwrap();
        fs::write(
            out_dir.join(FERRITE_PRODUCTION_ARTIFACT_MANIFEST),
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();
        fs::write(out_dir.join("ferrite-build.json"), "{}\n").unwrap();
    }

    #[test]
    fn activates_build_and_route_types_as_one_verified_output_set() {
        let root = tempfile::tempdir().unwrap();
        let candidate_build = root.path().join("candidate-build");
        let build_destination = root.path().join("build");
        let candidate_types = root.path().join("candidate-types.d.ts");
        let types_destination = root.path().join("types/routes.d.ts");
        write_test_file(&candidate_build.join("new.txt"), "new build\n");
        write_test_file(&build_destination.join("old.txt"), "old build\n");
        write_test_file(&candidate_types, "new types\n");
        write_test_file(&types_destination, "old types\n");
        let expected = output_contract_for(&build_destination, &types_destination);

        install_verified_outputs(
            &candidate_build,
            &build_destination,
            &candidate_types,
            &types_destination,
            &expected,
        )
        .unwrap();

        assert_eq!(
            fs::read_to_string(build_destination.join("new.txt")).unwrap(),
            "new build\n"
        );
        assert_eq!(
            fs::read_to_string(&types_destination).unwrap(),
            "new types\n"
        );
        assert!(!build_destination.join("old.txt").exists());
        assert!(!candidate_build.exists());
        assert!(!candidate_types.exists());
    }

    #[test]
    fn route_types_activation_failure_restores_both_previous_outputs() {
        let root = tempfile::tempdir().unwrap();
        let candidate_build = root.path().join("candidate-build");
        let build_destination = root.path().join("build");
        let candidate_types = root.path().join("candidate-types.d.ts");
        let types_destination = root.path().join("types/routes.d.ts");
        write_test_file(&candidate_build.join("new.txt"), "new build\n");
        write_test_file(&build_destination.join("old.txt"), "old build\n");
        write_test_file(&candidate_types, "new types\n");
        write_test_file(&types_destination, "old types\n");
        let expected = output_contract_for(&build_destination, &types_destination);

        let error = install_verified_outputs_with_ops(
            &candidate_build,
            &build_destination,
            &candidate_types,
            &types_destination,
            &expected,
            |from, to| {
                if from == candidate_types {
                    return Err(io::Error::new(
                        io::ErrorKind::PermissionDenied,
                        "synthetic route types activation failure",
                    ));
                }
                rename_noreplace(from, to)
            },
            remove_owned_path,
        )
        .unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert_eq!(
            fs::read_to_string(build_destination.join("old.txt")).unwrap(),
            "old build\n"
        );
        assert_eq!(
            fs::read_to_string(&types_destination).unwrap(),
            "old types\n"
        );
        assert!(!candidate_build.exists());
        assert!(!candidate_types.exists());
    }

    #[test]
    fn changed_destination_is_restored_without_activating_candidate() {
        let root = tempfile::tempdir().unwrap();
        let candidate_build = root.path().join("candidate-build");
        let build_destination = root.path().join("build");
        let candidate_types = root.path().join("candidate-types.d.ts");
        let types_destination = root.path().join("types/routes.d.ts");
        write_test_file(&candidate_build.join("new.txt"), "new build\n");
        write_test_file(&build_destination.join("old.txt"), "old build\n");
        write_test_file(&candidate_types, "new types\n");
        write_test_file(&types_destination, "old types\n");
        let expected = output_contract_for(&build_destination, &types_destination);
        write_test_file(
            &build_destination.join("external-sentinel.txt"),
            "preserve me\n",
        );

        let error = install_verified_outputs(
            &candidate_build,
            &build_destination,
            &candidate_types,
            &types_destination,
            &expected,
        )
        .unwrap_err();

        assert!(error.to_string().contains("changed after validation"));
        assert_eq!(
            fs::read_to_string(build_destination.join("external-sentinel.txt")).unwrap(),
            "preserve me\n"
        );
        assert!(!build_destination.join("new.txt").exists());
        assert!(!candidate_build.exists());
        assert!(!candidate_types.exists());
    }

    #[test]
    fn cleanup_failure_after_activation_preserves_recovery_path() {
        let root = tempfile::tempdir().unwrap();
        let candidate_build = root.path().join("candidate-build");
        let build_destination = root.path().join("build");
        let candidate_types = root.path().join("candidate-types.d.ts");
        let types_destination = root.path().join("types/routes.d.ts");
        write_test_file(&candidate_build.join("new.txt"), "new build\n");
        write_test_file(&build_destination.join("old.txt"), "old build\n");
        write_test_file(&candidate_types, "new types\n");
        write_test_file(&types_destination, "old types\n");
        let expected = output_contract_for(&build_destination, &types_destination);

        let error = install_verified_outputs_with_ops(
            &candidate_build,
            &build_destination,
            &candidate_types,
            &types_destination,
            &expected,
            rename_noreplace,
            |path| {
                if path.file_name().is_some_and(|name| {
                    name.to_string_lossy()
                        .starts_with(".ferrite-previous-build-")
                }) {
                    return Err(io::Error::new(
                        io::ErrorKind::PermissionDenied,
                        "synthetic build backup cleanup failure",
                    ));
                }
                remove_owned_path(path)
            },
        )
        .unwrap_err();

        assert!(
            error
                .to_string()
                .contains("recovery cleanup was incomplete")
        );
        assert_eq!(
            fs::read_to_string(build_destination.join("new.txt")).unwrap(),
            "new build\n"
        );
        let recovery = fs::read_dir(root.path())
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| {
                path.file_name().is_some_and(|name| {
                    name.to_string_lossy()
                        .starts_with(".ferrite-previous-build-")
                })
            })
            .expect("build recovery path");
        assert_eq!(
            fs::read_to_string(recovery.join("old.txt")).unwrap(),
            "old build\n"
        );
    }

    #[test]
    fn activation_and_rollback_failures_preserve_previous_build() {
        let root = tempfile::tempdir().unwrap();
        let candidate_build = root.path().join("candidate-build");
        let build_destination = root.path().join("build");
        let candidate_types = root.path().join("candidate-types.d.ts");
        let types_destination = root.path().join("types/routes.d.ts");
        write_test_file(&candidate_build.join("new.txt"), "new build\n");
        write_test_file(&build_destination.join("old.txt"), "old build\n");
        write_test_file(&candidate_types, "new types\n");
        write_test_file(&types_destination, "old types\n");
        let expected = output_contract_for(&build_destination, &types_destination);

        let error = install_verified_outputs_with_ops(
            &candidate_build,
            &build_destination,
            &candidate_types,
            &types_destination,
            &expected,
            |from, to| {
                if from == candidate_types {
                    return Err(io::Error::new(
                        io::ErrorKind::PermissionDenied,
                        "synthetic route types activation failure",
                    ));
                }
                if from == build_destination && to == candidate_build {
                    return Err(io::Error::new(
                        io::ErrorKind::PermissionDenied,
                        "synthetic build rollback failure",
                    ));
                }
                rename_noreplace(from, to)
            },
            remove_owned_path,
        )
        .unwrap_err();

        let message = error.to_string();
        assert!(message.contains("synthetic route types activation failure"));
        assert!(message.contains("synthetic build rollback failure"));
        assert!(message.contains("could not restore previous build"));
        assert_eq!(
            fs::read_to_string(&types_destination).unwrap(),
            "old types\n"
        );
        assert_eq!(
            fs::read_to_string(build_destination.join("new.txt")).unwrap(),
            "new build\n"
        );
        let recovery = fs::read_dir(root.path())
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| {
                path.file_name().is_some_and(|name| {
                    name.to_string_lossy()
                        .starts_with(".ferrite-previous-build-")
                })
            })
            .expect("preserved previous build");
        assert_eq!(
            fs::read_to_string(recovery.join("old.txt")).unwrap(),
            "old build\n"
        );
    }

    #[test]
    fn candidate_cleanup_failure_is_reported_and_preserved() {
        let root = tempfile::tempdir().unwrap();
        let candidate_build = root.path().join("candidate-build");
        let build_destination = root.path().join("build");
        let candidate_types = root.path().join("candidate-types.d.ts");
        let types_destination = root.path().join("types/routes.d.ts");
        write_test_file(&candidate_build.join("new.txt"), "new build\n");
        write_test_file(&candidate_types, "new types\n");
        let expected = output_contract_for(&build_destination, &types_destination);
        write_test_file(&build_destination.join("external.txt"), "preserve me\n");

        let error = install_verified_outputs_with_ops(
            &candidate_build,
            &build_destination,
            &candidate_types,
            &types_destination,
            &expected,
            rename_noreplace,
            |path| {
                if path == candidate_build {
                    return Err(io::Error::new(
                        io::ErrorKind::PermissionDenied,
                        "synthetic candidate cleanup failure",
                    ));
                }
                remove_owned_path(path)
            },
        )
        .unwrap_err();

        let message = error.to_string();
        assert!(message.contains("changed after validation"));
        assert!(message.contains("synthetic candidate cleanup failure"));
        assert!(message.contains(&candidate_build.display().to_string()));
        assert_eq!(
            fs::read_to_string(build_destination.join("external.txt")).unwrap(),
            "preserve me\n"
        );
        assert_eq!(
            fs::read_to_string(candidate_build.join("new.txt")).unwrap(),
            "new build\n"
        );
        assert!(!candidate_types.exists());
    }

    #[test]
    fn cancelled_activation_preserves_both_previous_outputs() {
        let root = tempfile::tempdir().unwrap();
        let candidate_build = root.path().join("candidate-build");
        let build_destination = root.path().join("build");
        let candidate_types = root.path().join("candidate-types.d.ts");
        let types_destination = root.path().join("types/routes.d.ts");
        write_test_file(&candidate_build.join("new.txt"), "new build\n");
        write_test_file(&build_destination.join("old.txt"), "old build\n");
        write_test_file(&candidate_types, "new types\n");
        write_test_file(&types_destination, "old types\n");
        let cancellation_flag = AtomicBool::new(true);
        let expected = output_contract_for(&build_destination, &types_destination);

        let error = install_verified_outputs_unless_cancelled(
            &candidate_build,
            &build_destination,
            &candidate_types,
            &types_destination,
            &cancellation_flag,
            &expected,
        )
        .unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::Interrupted);
        assert_eq!(
            fs::read_to_string(build_destination.join("old.txt")).unwrap(),
            "old build\n"
        );
        assert_eq!(
            fs::read_to_string(&types_destination).unwrap(),
            "old types\n"
        );
        assert!(!candidate_build.exists());
        assert!(!candidate_types.exists());
    }

    #[test]
    fn successful_public_build_replaces_output_and_route_types_together() {
        let root = tempfile::tempdir().unwrap();
        let config = successful_public_build_config(root.path());
        seed_previous_outputs(&config);

        build_project(&config).unwrap();

        assert!(!config.out_dir.join("previous.txt").exists());
        let route_types = fs::read_to_string(&config.types_out).unwrap();
        assert!(route_types.starts_with(GENERATED_ROUTE_TYPES_HEADER));
        assert!(!route_types.contains("previous route types"));
    }

    #[test]
    fn renderer_failure_preserves_previous_output_and_route_types() {
        let root = tempfile::tempdir().unwrap();
        let config = successful_public_build_config(root.path());
        seed_previous_outputs(&config);
        write_test_file(
            &config.page_renderer,
            "console.error('synthetic renderer failure'); process.exit(1);\n",
        );

        assert!(build_project(&config).is_err());

        assert_previous_outputs(&config);
    }

    #[test]
    fn bundler_failure_preserves_previous_output_and_route_types() {
        let root = tempfile::tempdir().unwrap();
        let config = successful_public_build_config(root.path());
        seed_previous_outputs(&config);
        write_test_file(
            &config.client_bundler,
            "console.error('synthetic bundler failure'); process.exit(1);\n",
        );

        assert!(build_project(&config).is_err());

        assert_previous_outputs(&config);
    }

    #[test]
    fn source_drift_preserves_previous_output_and_route_types() {
        let root = tempfile::tempdir().unwrap();
        let counter = tempfile::NamedTempFile::new().unwrap();
        let config = successful_public_build_config(root.path());
        seed_previous_outputs(&config);
        let counter_json = serde_json::to_string(counter.path()).unwrap();
        let input_json = serde_json::to_string(&config.app_dir.join("page.tsx")).unwrap();
        write_test_file(
            &root.path().join("verify-build-inputs.mjs"),
            &format!(
                r#"
const fs = await import("node:fs/promises");
for await (const _chunk of process.stdin) {{}}
const counter = {counter_json};
const count = Number((await fs.readFile(counter, "utf8")) || "0");
await fs.writeFile(counter, String(count + 1));
process.stdout.write(JSON.stringify({{
  inputs: [{{
    path: {input_json},
    value: `sha256:${{(count === 0 ? "a" : "b").repeat(64)}}`
  }}]
}}));
"#
            ),
        );

        let error = build_project(&config).unwrap_err();

        assert!(
            error
                .to_string()
                .contains("changed during the production build")
        );
        assert_previous_outputs(&config);
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
    fn observed_build_success_is_correlated_and_reports_bounded_route_count() {
        let project = tempfile::tempdir().unwrap();
        let expected = BuildReport {
            out_dir: project.path().join(".ferrite/build"),
            routes_count: 3,
            html_files: Vec::new(),
            page_metadata: Vec::new(),
            skipped_dynamic_routes: Vec::new(),
            manifest_file: project.path().join(".ferrite/build/manifest.json"),
            production_manifest_file: project.path().join(".ferrite/build/ferrite-build.json"),
            production_build_id: "observed-build-test".to_owned(),
            server_modules: Vec::new(),
            client_bundles: Vec::new(),
            server_action_manifests: Vec::new(),
        };
        let (emitter, receiver) = ferrite_core::observability::bounded_channel(4);

        let report = run_observed_build(&emitter, || Ok(expected.clone())).unwrap();
        let events = receiver.try_iter().collect::<Vec<_>>();

        assert_eq!(report, expected);
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
        assert_eq!(events[0].sequence, 0);
        assert_eq!(events[1].sequence, 1);
        assert_eq!(events[0].build.as_ref().unwrap().routes, None);
        assert_eq!(events[1].outcome, Some(Outcome::Success));
        assert_eq!(events[1].error_class, None);
        assert_eq!(events[1].failure_phase, None);
        assert_eq!(events[1].build.as_ref().unwrap().routes, Some(3));
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
    fn rejects_valid_artifact_with_undeclared_sibling_without_mutation() {
        let project = tempfile::tempdir().unwrap();
        let mut config = test_config(project.path());
        config.out_dir = project.path().join("dist");
        seed_empty_owned_artifact(&config.out_dir);
        fs::write(config.out_dir.join("sentinel.txt"), "preserve me\n").unwrap();

        let error = validate_build_output_ownership(&config).unwrap_err();

        assert!(error.to_string().contains("undeclared"));
        assert_eq!(
            fs::read_to_string(config.out_dir.join("sentinel.txt")).unwrap(),
            "preserve me\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_owned_artifact_with_nested_symlink_without_mutation() {
        let project = tempfile::tempdir().unwrap();
        let mut config = test_config(project.path());
        config.out_dir = project.path().join("dist");
        seed_empty_owned_artifact(&config.out_dir);
        fs::create_dir_all(config.out_dir.join("nested")).unwrap();
        std::os::unix::fs::symlink(
            project.path().join("app/page.tsx"),
            config.out_dir.join("nested/escape"),
        )
        .unwrap();

        let error = validate_build_output_ownership(&config).unwrap_err();

        assert!(error.to_string().contains("symbolic link"));
        assert!(config.out_dir.join("nested/escape").exists());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_owned_artifact_with_special_file_without_mutation() {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;

        let project = tempfile::tempdir().unwrap();
        let mut config = test_config(project.path());
        config.out_dir = project.path().join("dist");
        seed_empty_owned_artifact(&config.out_dir);
        let fifo = config.out_dir.join("unexpected.fifo");
        let fifo_c = CString::new(fifo.as_os_str().as_bytes()).unwrap();
        // SAFETY: fifo_c is a valid, NUL-terminated path owned by this temporary test directory.
        assert_eq!(unsafe { libc::mkfifo(fifo_c.as_ptr(), 0o600) }, 0);

        let error = validate_build_output_ownership(&config).unwrap_err();

        assert!(
            error
                .to_string()
                .contains("not a regular file or directory")
        );
        assert!(fifo.exists());
    }

    #[test]
    fn atomic_activation_rejects_destination_created_between_validation_and_move() {
        let root = tempfile::tempdir().unwrap();
        let candidate_build = root.path().join("candidate-build");
        let build_destination = root.path().join("build");
        let candidate_types = root.path().join("candidate-types.d.ts");
        let types_destination = root.path().join("types/routes.d.ts");
        write_test_file(&candidate_build.join("new.txt"), "new build\n");
        write_test_file(&candidate_types, "new types\n");

        assert!(!build_destination.exists());
        let expected = output_contract_for(&build_destination, &types_destination);
        let mut injected_race = false;

        let error = install_verified_outputs_with_ops(
            &candidate_build,
            &build_destination,
            &candidate_types,
            &types_destination,
            &expected,
            |from, to| {
                if !injected_race && from == candidate_build && to == build_destination {
                    injected_race = true;
                    write_test_file(
                        &build_destination.join("external-sentinel.txt"),
                        "preserve me\n",
                    );
                }
                rename_noreplace(from, to)
            },
            remove_owned_path,
        )
        .unwrap_err();

        assert!(injected_race);
        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        assert!(error.to_string().contains("changed after validation"));
        assert_eq!(
            fs::read_to_string(build_destination.join("external-sentinel.txt")).unwrap(),
            "preserve me\n"
        );
        assert!(!candidate_build.exists());
        assert!(!candidate_types.exists());
    }

    #[test]
    fn claimed_destination_recreation_preserves_external_path_and_old_backup() {
        let root = tempfile::tempdir().unwrap();
        let candidate_build = root.path().join("candidate-build");
        let build_destination = root.path().join("build");
        let candidate_types = root.path().join("candidate-types.d.ts");
        let types_destination = root.path().join("types/routes.d.ts");
        write_test_file(&candidate_build.join("new.txt"), "new build\n");
        write_test_file(&build_destination.join("old.txt"), "old build\n");
        write_test_file(&candidate_types, "new types\n");
        let expected = output_contract_for(&build_destination, &types_destination);
        let mut injected_race = false;

        let error = install_verified_outputs_with_ops(
            &candidate_build,
            &build_destination,
            &candidate_types,
            &types_destination,
            &expected,
            |from, to| {
                let result = rename_noreplace(from, to);
                if result.is_ok()
                    && !injected_race
                    && from == build_destination
                    && to.file_name().is_some_and(|name| {
                        name.to_string_lossy()
                            .starts_with(".ferrite-previous-build-")
                    })
                {
                    injected_race = true;
                    write_test_file(
                        &build_destination.join("external-sentinel.txt"),
                        "preserve me\n",
                    );
                }
                result
            },
            remove_owned_path,
        )
        .unwrap_err();

        assert!(injected_race);
        let message = error.to_string();
        assert!(message.contains("changed after validation"));
        assert!(message.contains("could not restore previous build"));
        assert_eq!(
            fs::read_to_string(build_destination.join("external-sentinel.txt")).unwrap(),
            "preserve me\n"
        );
        assert!(!build_destination.join("new.txt").exists());
        let recovery = fs::read_dir(root.path())
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| {
                path.file_name().is_some_and(|name| {
                    name.to_string_lossy()
                        .starts_with(".ferrite-previous-build-")
                })
            })
            .expect("preserved previous build");
        assert_eq!(
            fs::read_to_string(recovery.join("old.txt")).unwrap(),
            "old build\n"
        );
        assert!(!candidate_build.exists());
        assert!(!candidate_types.exists());
    }

    #[test]
    fn route_types_race_rolls_back_new_build_without_clobbering_external_file() {
        let root = tempfile::tempdir().unwrap();
        let candidate_build = root.path().join("candidate-build");
        let build_destination = root.path().join("build");
        let candidate_types = root.path().join("candidate-types.d.ts");
        let types_destination = root.path().join("types/routes.d.ts");
        write_test_file(&candidate_build.join("new.txt"), "new build\n");
        write_test_file(&candidate_types, "new types\n");
        let expected = output_contract_for(&build_destination, &types_destination);
        let mut injected_race = false;

        let error = install_verified_outputs_with_ops(
            &candidate_build,
            &build_destination,
            &candidate_types,
            &types_destination,
            &expected,
            |from, to| {
                if !injected_race && from == candidate_types && to == types_destination {
                    injected_race = true;
                    write_test_file(&types_destination, "external types\n");
                }
                rename_noreplace(from, to)
            },
            remove_owned_path,
        )
        .unwrap_err();

        assert!(injected_race);
        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        assert!(error.to_string().contains("changed after validation"));
        assert_eq!(
            fs::read_to_string(&types_destination).unwrap(),
            "external types\n"
        );
        assert!(!build_destination.exists());
        assert!(!candidate_build.exists());
        assert!(!candidate_types.exists());
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
