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
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use ferrite_router::{Route, find_document_file, scan_app_dir};
use serde::{Deserialize, Serialize};

use source_snapshot::ProjectSourceSnapshot;

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
    let mut child = Command::new("node")
        .arg(&verifier)
        .current_dir(&config.project)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    child
        .stdin
        .take()
        .expect("build input verifier stdin was piped")
        .write_all(&request_json)?;
    let output = child.wait_with_output()?;
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
