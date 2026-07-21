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
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};

use ferrite_router::{Route, find_document_file, scan_app_dir, validate_route_types_output};
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
}
