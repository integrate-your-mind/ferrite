mod artifact;

pub use artifact::{
    FERRITE_PRODUCTION_ARTIFACT_FORMAT, FERRITE_PRODUCTION_ARTIFACT_MAJOR,
    FERRITE_PRODUCTION_ARTIFACT_MANIFEST, FERRITE_PRODUCTION_ARTIFACT_MINOR,
    LoadedProductionArtifact, ProductionArtifactError, ProductionArtifactFile,
    ProductionArtifactFormat, ProductionArtifactManifest, ProductionArtifactRoute,
    artifact_file_record, finalize_production_artifact_manifest, load_production_artifact,
};

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use ferrite_client_bundler::{
    ClientBundle, ClientBundleError, ClientBundleOptions, ClientBundleRequest, ClientBundler,
    fingerprint_client_bundle,
};
use ferrite_page_renderer::{
    DocumentRenderOptions, PageMetadata, PageRenderError, PageRenderer, RouteConventions,
    ServerActionManifest,
};
use ferrite_router::{Route, RouteParamKind, find_document_file, scan_app_dir, write_route_types};
use serde::Serialize;
use serde_json::Value;

#[derive(Debug)]
pub enum BuildError {
    Artifact(ProductionArtifactError),
    ClientBundle(ClientBundleError),
    DuplicateStaticOutput { route_path: String },
    InvalidStaticParams { route: String, reason: String },
    PageRender(PageRenderError),
    Router(ferrite_router::RouterError),
    Io(std::io::Error),
    Json(serde_json::Error),
}

impl fmt::Display for BuildError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            BuildError::Artifact(error) => write!(f, "{error}"),
            BuildError::ClientBundle(error) => write!(f, "{error}"),
            BuildError::DuplicateStaticOutput { route_path } => {
                write!(f, "duplicate static output for route path `{route_path}`")
            }
            BuildError::InvalidStaticParams { route, reason } => {
                write!(f, "invalid static params for route `{route}`: {reason}")
            }
            BuildError::PageRender(error) => write!(f, "{error}"),
            BuildError::Router(error) => write!(f, "{error}"),
            BuildError::Io(error) => write!(f, "{error}"),
            BuildError::Json(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for BuildError {}

impl From<ferrite_router::RouterError> for BuildError {
    fn from(error: ferrite_router::RouterError) -> Self {
        BuildError::Router(error)
    }
}

impl From<PageRenderError> for BuildError {
    fn from(error: PageRenderError) -> Self {
        BuildError::PageRender(error)
    }
}

impl From<ClientBundleError> for BuildError {
    fn from(error: ClientBundleError) -> Self {
        BuildError::ClientBundle(error)
    }
}

impl From<ProductionArtifactError> for BuildError {
    fn from(error: ProductionArtifactError) -> Self {
        BuildError::Artifact(error)
    }
}

impl From<std::io::Error> for BuildError {
    fn from(error: std::io::Error) -> Self {
        BuildError::Io(error)
    }
}

impl From<serde_json::Error> for BuildError {
    fn from(error: serde_json::Error) -> Self {
        BuildError::Json(error)
    }
}

pub type Result<T> = std::result::Result<T, BuildError>;

const CLIENT_PUBLIC_PATH: &str = "/_ferrite/static";

#[derive(Debug, Clone)]
pub struct BuildConfig {
    pub project: PathBuf,
    pub app_dir: PathBuf,
    pub out_dir: PathBuf,
    pub types_out: PathBuf,
    pub page_renderer: PathBuf,
    pub client_bundler: PathBuf,
}

impl BuildConfig {
    pub fn new(
        project: PathBuf,
        app_dir: PathBuf,
        out_dir: PathBuf,
        types_out: PathBuf,
        page_renderer: PathBuf,
        client_bundler: PathBuf,
    ) -> Self {
        Self {
            project,
            app_dir,
            out_dir,
            types_out,
            page_renderer,
            client_bundler,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BuildReport {
    pub out_dir: PathBuf,
    pub routes_count: usize,
    pub html_files: Vec<PathBuf>,
    pub page_metadata: Vec<PageMetadataEntry>,
    pub skipped_dynamic_routes: Vec<String>,
    pub manifest_file: PathBuf,
    pub production_manifest_file: PathBuf,
    pub production_build_id: String,
    pub server_modules: Vec<PathBuf>,
    pub client_bundles: Vec<ClientBundle>,
    pub server_action_manifests: Vec<ServerActionManifest>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PageMetadataEntry {
    pub route_path: String,
    pub metadata: PageMetadata,
}

#[derive(Debug, Serialize)]
struct BuildManifest<'a> {
    routes: &'a [Route],
    html_files: &'a [String],
    page_metadata: &'a [PageMetadataEntry],
    skipped_dynamic_routes: &'a [String],
    client_bundles: &'a [ClientBundle],
    server_action_manifests: &'a [ServerActionManifest],
    production_manifest_file: &'a str,
    production_build_id: &'a str,
    server_modules: &'a [String],
}

pub fn build_project(config: &BuildConfig) -> Result<BuildReport> {
    let out_parent = config.out_dir.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(out_parent)?;
    let staged = tempfile::Builder::new()
        .prefix(".ferrite-build-")
        .tempdir_in(out_parent)?;
    let mut staged_config = config.clone();
    staged_config.out_dir = staged.path().to_path_buf();
    let mut report = build_project_in_place(&staged_config)?;
    let staged_path = staged.keep();

    if let Err(error) = install_staged_build(&staged_path, &config.out_dir) {
        let _ = fs::remove_dir_all(&staged_path);
        return Err(error.into());
    }
    rebase_build_report(&mut report, &staged_path, &config.out_dir)?;
    Ok(report)
}

fn build_project_in_place(config: &BuildConfig) -> Result<BuildReport> {
    let routes = scan_app_dir(&config.app_dir)?;
    fs::create_dir_all(&config.out_dir)?;
    write_route_types(&routes, &config.types_out)?;
    let document_file = find_document_file(&config.app_dir);
    let cancellation_flag = crate::build_cancellation_flag();
    let page_renderer = PageRenderer::new(config.project.clone(), config.page_renderer.clone())
        .with_cancellation_flag(std::sync::Arc::clone(&cancellation_flag));
    let client_bundler = ClientBundler::new(config.project.clone(), config.client_bundler.clone())
        .with_cancellation_flag(cancellation_flag);

    let mut html_files = Vec::new();
    let mut page_metadata = Vec::new();
    let mut skipped_dynamic_routes = Vec::new();
    let mut client_bundles = Vec::new();
    let mut server_action_manifests = Vec::new();
    let mut production_routes = Vec::new();
    let mut server_modules = Vec::new();
    let mut generated_route_paths = BTreeSet::new();
    let client_out_dir = config.out_dir.join("_ferrite/static");
    let server_out_dir = config.out_dir.join("server");
    fs::create_dir_all(&server_out_dir)?;

    for (route_index, route) in routes.iter().enumerate() {
        let (static_param_sets, skipped_dynamic_route) =
            route_static_param_sets(&page_renderer, route)?;
        let artifact_param_set = static_param_sets
            .first()
            .cloned()
            .unwrap_or_else(|| placeholder_route_params(route));
        let artifact_params = ordered_route_params(route, &artifact_param_set)?;
        let conventions = route_conventions(route);
        let snapshot_files =
            production_route_snapshot_files(document_file.as_deref(), &conventions);
        let server_module_relative = format!("server/route-{route_index:04}.mjs");
        let server_module = config.out_dir.join(&server_module_relative);
        let action_bootstrap = !page_renderer
            .collect_server_actions(&route.file, &route.layouts, &artifact_params, &conventions)?
            .actions
            .is_empty();
        let route_client_bundle = bundle_production_route(
            &client_bundler,
            route,
            &snapshot_files,
            &artifact_params,
            &client_out_dir,
            action_bootstrap,
        )?;

        let (refreshed_static_param_sets, refreshed_skipped_dynamic_route) =
            route_static_param_sets(&page_renderer, route)?;
        if static_param_sets != refreshed_static_param_sets
            || skipped_dynamic_route != refreshed_skipped_dynamic_route
        {
            return Err(ClientBundleError::StaleInputSnapshot {
                path: route.file.display().to_string(),
            }
            .into());
        }
        if skipped_dynamic_route {
            skipped_dynamic_routes.push(route.path.clone());
        }

        page_renderer.build_server_module(
            &route.file,
            &route.layouts,
            document_file.as_deref(),
            &conventions,
            &route.path,
            &server_module,
        )?;
        server_modules.push(server_module);

        let artifact_action_manifest = page_renderer.collect_server_actions(
            &route.file,
            &route.layouts,
            &artifact_params,
            &conventions,
        )?;
        if action_bootstrap == artifact_action_manifest.actions.is_empty() {
            return Err(ClientBundleError::StaleInputSnapshot {
                path: route.file.display().to_string(),
            }
            .into());
        }
        let mut prerendered = BTreeMap::new();

        for params in static_param_sets {
            let route_path = concrete_route_path(route, &params)?;
            if !generated_route_paths.insert(route_path.clone()) {
                return Err(BuildError::DuplicateStaticOutput { route_path });
            }
            let ordered_params = ordered_route_params(route, &params)?;
            let html_path = output_html_path(&config.out_dir, &route_path);
            if let Some(parent) = html_path.parent() {
                fs::create_dir_all(parent)?;
            }
            let action_manifest = page_renderer.collect_server_actions(
                &route.file,
                &route.layouts,
                &ordered_params,
                &conventions,
            )?;
            let (document, metadata) = if let Some(document_file) = document_file.as_deref() {
                let metadata =
                    page_renderer.collect_metadata(&route.file, &route.layouts, &ordered_params)?;
                page_renderer
                    .render_document_to_html_with_conventions(
                        &route.file,
                        &route.layouts,
                        document_file,
                        &ordered_params,
                        &DocumentRenderOptions {
                            root_id: "ferrite-root".to_owned(),
                            route_path: route_path.clone(),
                            route_pattern: None,
                            build_id: None,
                            server_action_csrf_token: None,
                            server_action_replay_nonce: None,
                            metadata: metadata.clone(),
                            preload_scripts: client_bundle_scripts(&route_client_bundle),
                            styles: client_bundle_styles(&route_client_bundle),
                            scripts: client_bundle_scripts(&route_client_bundle),
                            default_title: "Ferrite".to_owned(),
                        },
                        &conventions,
                    )
                    .map(|document| (document, metadata))?
            } else {
                let page_html = page_renderer.render_page_to_html_with_conventions(
                    &route.file,
                    &route.layouts,
                    &ordered_params,
                    &conventions,
                )?;
                let metadata =
                    page_renderer.collect_metadata(&route.file, &route.layouts, &ordered_params)?;
                (
                    render_static_document(
                        &route_path,
                        &route.path,
                        &ordered_params,
                        &page_html,
                        &route_client_bundle,
                        &metadata,
                    ),
                    metadata,
                )
            };
            fs::write(&html_path, document)?;
            let html_relative = artifact_relative_path(&config.out_dir, &html_path)?;
            prerendered.insert(route_path.clone(), html_relative);
            html_files.push(html_path);
            page_metadata.push(PageMetadataEntry {
                route_path,
                metadata,
            });
            client_bundles.push(route_client_bundle.clone());
            if !action_manifest.actions.is_empty() {
                server_action_manifests.push(action_manifest);
            }
        }

        route_client_bundle.validate_input_snapshot(&config.project)?;

        production_routes.push(ProductionArtifactRoute {
            path: route.path.clone(),
            params: route.params.clone(),
            server_module: server_module_relative,
            client_bundle: route_client_bundle,
            prerendered,
            observed_actions: artifact_action_manifest
                .actions
                .into_iter()
                .map(|action| action.id)
                .collect(),
        });
    }

    validate_route_input_snapshots(&production_routes, &config.project)?;

    let mut artifact_paths = BTreeSet::new();
    for route in &production_routes {
        artifact_paths.insert(route.server_module.clone());
        for output in route.client_bundle.outputs.iter().chain(
            route
                .client_bundle
                .client_references
                .iter()
                .flat_map(|reference| reference.outputs.iter()),
        ) {
            artifact_paths.insert(format!(
                "_ferrite/static/{}",
                output.to_string_lossy().replace('\\', "/")
            ));
        }
        artifact_paths.extend(route.prerendered.values().cloned());
    }
    let public_root = config.project.join("public");
    let public_tree = collect_public_tree(&public_root)?;
    for directory in &public_tree.directories {
        let relative = directory.to_string_lossy().replace('\\', "/");
        if is_reserved_public_path(&relative) {
            return Err(BuildError::Artifact(ProductionArtifactError::Invalid(
                format!("public directory `{relative}` collides with a reserved artifact path"),
            )));
        }
    }
    for relative in &public_tree.files {
        let relative = relative.to_string_lossy().replace('\\', "/");
        if artifact_paths.iter().any(|generated| {
            generated == &relative
                || generated.starts_with(&format!("{relative}/"))
                || relative.starts_with(&format!("{generated}/"))
        }) {
            return Err(BuildError::Artifact(ProductionArtifactError::Invalid(
                format!("public file `{relative}` collides with a generated artifact path"),
            )));
        }
        if is_reserved_public_path(&relative) {
            return Err(BuildError::Artifact(ProductionArtifactError::Invalid(
                format!("public file `{relative}` collides with a reserved artifact path"),
            )));
        }
        artifact_paths.insert(relative);
    }
    copy_public_tree(&public_root, &config.out_dir, &public_tree)?;
    let artifact_files = artifact_paths
        .iter()
        .map(|path| artifact_file_record(&config.out_dir, path))
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let public_files = public_tree
        .files
        .iter()
        .map(|path| path.to_string_lossy().replace('\\', "/"))
        .collect();
    let production_manifest = ProductionArtifactManifest::new_with_public_files(
        CLIENT_PUBLIC_PATH,
        document_file.is_some(),
        production_routes,
        artifact_files,
        public_files,
    )?;
    let production_manifest_file = config.out_dir.join(FERRITE_PRODUCTION_ARTIFACT_MANIFEST);
    fs::write(
        &production_manifest_file,
        serde_json::to_string_pretty(&production_manifest)?,
    )?;

    let manifest_file = config.out_dir.join("ferrite-build.json");
    let manifest_html_files = html_files
        .iter()
        .map(|path| artifact_relative_path(&config.out_dir, path))
        .collect::<Result<Vec<_>>>()?;
    let manifest_server_modules = server_modules
        .iter()
        .map(|path| artifact_relative_path(&config.out_dir, path))
        .collect::<Result<Vec<_>>>()?;
    let manifest = BuildManifest {
        routes: &routes,
        html_files: &manifest_html_files,
        page_metadata: &page_metadata,
        skipped_dynamic_routes: &skipped_dynamic_routes,
        client_bundles: &client_bundles,
        server_action_manifests: &server_action_manifests,
        production_manifest_file: FERRITE_PRODUCTION_ARTIFACT_MANIFEST,
        production_build_id: &production_manifest.build_id,
        server_modules: &manifest_server_modules,
    };
    fs::write(&manifest_file, serde_json::to_string_pretty(&manifest)?)?;

    validate_route_input_snapshots(&production_manifest.routes, &config.project)?;

    Ok(BuildReport {
        out_dir: config.out_dir.clone(),
        routes_count: routes.len(),
        html_files,
        page_metadata,
        skipped_dynamic_routes,
        manifest_file,
        production_manifest_file,
        production_build_id: production_manifest.build_id,
        server_modules,
        client_bundles,
        server_action_manifests,
    })
}

fn validate_route_input_snapshots(
    routes: &[ProductionArtifactRoute],
    project: &Path,
) -> Result<()> {
    for route in routes {
        route.client_bundle.validate_input_snapshot(project)?;
    }
    Ok(())
}

fn route_static_param_sets(
    page_renderer: &PageRenderer,
    route: &Route,
) -> Result<(Vec<BTreeMap<String, Value>>, bool)> {
    if route.params.is_empty() {
        return Ok((vec![BTreeMap::new()], false));
    }

    let generated = page_renderer.generate_static_params(&route.file)?;
    if generated.has_generate_static_params {
        Ok((generated.params, false))
    } else {
        Ok((Vec::new(), true))
    }
}

fn install_staged_build(staged: &Path, destination: &Path) -> std::io::Result<()> {
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

    if let Err(error) = fs::rename(staged, destination) {
        if let Some(backup_path) = backup.as_ref() {
            if let Err(rollback_error) = fs::rename(backup_path, destination) {
                return Err(std::io::Error::new(
                    error.kind(),
                    format!(
                        "could not activate staged build: {error}; could not restore previous build from `{}`: {rollback_error}",
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
            "staged output `{}` is outside staging root `{}`",
            path.display(),
            from.display()
        )))
    })?;
    Ok(to.join(relative))
}

fn route_conventions(route: &Route) -> RouteConventions {
    RouteConventions {
        loading: route.loading.clone(),
        error: route.error.clone(),
    }
}

fn production_route_snapshot_files(
    document_file: Option<&Path>,
    conventions: &RouteConventions,
) -> Vec<PathBuf> {
    let mut files = document_file
        .into_iter()
        .map(Path::to_path_buf)
        .chain(conventions.loading.iter().cloned())
        .chain(conventions.error.iter().cloned())
        .collect::<Vec<_>>();
    files.sort();
    files.dedup();
    files
}

fn placeholder_route_params(route: &Route) -> BTreeMap<String, Value> {
    route
        .params
        .iter()
        .filter_map(|param| match param.kind {
            RouteParamKind::Dynamic => Some((
                param.name.clone(),
                Value::String("ferrite-build".to_owned()),
            )),
            RouteParamKind::CatchAll => Some((
                param.name.clone(),
                Value::Array(vec![Value::String("ferrite-build".to_owned())]),
            )),
            RouteParamKind::OptionalCatchAll => None,
        })
        .collect()
}

fn artifact_relative_path(root: &Path, path: &Path) -> Result<String> {
    let relative = path.strip_prefix(root).map_err(|_| {
        BuildError::Artifact(ProductionArtifactError::Invalid(format!(
            "generated path `{}` is outside build output `{}`",
            path.display(),
            root.display()
        )))
    })?;
    let relative = relative.to_str().ok_or_else(|| {
        BuildError::Artifact(ProductionArtifactError::Invalid(format!(
            "generated path `{}` is not valid UTF-8",
            path.display()
        )))
    })?;
    Ok(relative.replace('\\', "/"))
}

#[derive(Debug, Default)]
struct PublicTree {
    files: Vec<PathBuf>,
    directories: Vec<PathBuf>,
}

fn collect_public_tree(root: &Path) -> Result<PublicTree> {
    match fs::symlink_metadata(root) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(BuildError::Artifact(ProductionArtifactError::Invalid(
                    "public must be a real directory".to_owned(),
                )));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(PublicTree::default());
        }
        Err(error) => return Err(error.into()),
    }
    let mut tree = PublicTree::default();
    collect_public_tree_inner(root, Path::new(""), &mut tree)?;
    Ok(tree)
}

fn collect_public_tree_inner(root: &Path, relative: &Path, tree: &mut PublicTree) -> Result<()> {
    let directory = root.join(relative);
    let mut entries = fs::read_dir(&directory)?.collect::<std::result::Result<Vec<_>, _>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let name = entry.file_name();
        validate_public_component(&name)?;
        let child_relative = relative.join(&name);
        let metadata = fs::symlink_metadata(entry.path())?;
        if metadata.file_type().is_symlink() {
            return Err(BuildError::Artifact(ProductionArtifactError::Invalid(
                format!("public path `{}` is a symlink", child_relative.display()),
            )));
        }
        if metadata.is_dir() {
            tree.directories.push(child_relative.clone());
            collect_public_tree_inner(root, &child_relative, tree)?;
        } else if metadata.is_file() {
            tree.files.push(child_relative);
        } else {
            return Err(BuildError::Artifact(ProductionArtifactError::Invalid(
                format!(
                    "public path `{}` is not a regular file or directory",
                    child_relative.display()
                ),
            )));
        }
    }
    Ok(())
}

fn copy_public_tree(root: &Path, out_dir: &Path, tree: &PublicTree) -> Result<()> {
    for directory in &tree.directories {
        fs::create_dir_all(out_dir.join(directory))?;
    }
    for relative in &tree.files {
        let source = root.join(relative);
        let destination = out_dir.join(relative);
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }
        let bytes = read_public_file_no_follow(&source).map_err(|error| {
            BuildError::Artifact(ProductionArtifactError::Invalid(format!(
                "public path `{}` changed during build: {error}",
                relative.display()
            )))
        })?;
        fs::write(destination, bytes)?;
    }
    Ok(())
}

fn validate_public_component(component: &std::ffi::OsStr) -> Result<()> {
    let component = component.to_str().ok_or_else(|| {
        BuildError::Artifact(ProductionArtifactError::Invalid(
            "public path contains a non-UTF-8 filename".to_owned(),
        ))
    })?;
    if component.is_empty() || component.contains('\\') {
        return Err(BuildError::Artifact(ProductionArtifactError::Invalid(
            format!("public filename `{component}` is not supported"),
        )));
    }
    Ok(())
}

#[cfg(unix)]
fn read_public_file_no_follow(path: &Path) -> io::Result<Vec<u8>> {
    use std::os::unix::fs::OpenOptionsExt;

    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)?;
    if !file.metadata()?.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "public path is not a regular file",
        ));
    }
    let mut bytes = Vec::new();
    let mut reader = file;
    reader.read_to_end(&mut bytes)?;
    Ok(bytes)
}

#[cfg(not(unix))]
fn read_public_file_no_follow(path: &Path) -> io::Result<Vec<u8>> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;

        // FILE_FLAG_OPEN_REPARSE_POINT prevents the final path component from
        // being followed when it is replaced by a symlink/reparse point.
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        let file = fs::OpenOptions::new()
            .read(true)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)?;
        let metadata = file.metadata()?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "public path is not a regular file",
            ));
        }
        let mut bytes = Vec::new();
        let mut reader = file;
        reader.read_to_end(&mut bytes)?;
        return Ok(bytes);
    }

    #[cfg(not(windows))]
    {
        let metadata = fs::symlink_metadata(path)?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "public path is not a regular file",
            ));
        }
        fs::read(path)
    }
}

fn is_reserved_public_path(path: &str) -> bool {
    path == FERRITE_PRODUCTION_ARTIFACT_MANIFEST
        || path.starts_with(&format!("{FERRITE_PRODUCTION_ARTIFACT_MANIFEST}/"))
        || path == "ferrite-build.json"
        || path.starts_with("ferrite-build.json/")
        || path == "server"
        || path.starts_with("server/")
        || path == "_ferrite"
        || path.starts_with("_ferrite/")
}

fn bundle_production_route(
    client_bundler: &ClientBundler,
    route: &Route,
    snapshot_files: &[PathBuf],
    params: &[(String, Value)],
    client_out_dir: &Path,
    action_bootstrap: bool,
) -> Result<ClientBundle> {
    let mut client_bundle = client_bundler.bundle_route_request_with_snapshot_files(
        ClientBundleRequest {
            page_file: &route.file,
            layouts: &route.layouts,
            route_path: &route.path,
            params,
            out_dir: client_out_dir,
            public_path: CLIENT_PUBLIC_PATH,
            options: ClientBundleOptions {
                action_bootstrap,
                runtime_props: true,
            },
        },
        snapshot_files,
    )?;
    fingerprint_client_bundle(&mut client_bundle, client_out_dir, CLIENT_PUBLIC_PATH)?;
    Ok(client_bundle)
}

fn output_html_path(out_dir: &Path, route_path: &str) -> PathBuf {
    if route_path == "/" {
        return out_dir.join("index.html");
    }

    let mut path = out_dir.to_path_buf();
    for segment in route_path.trim_matches('/').split('/') {
        path.push(segment);
    }
    path.join("index.html")
}

fn concrete_route_path(route: &Route, params: &BTreeMap<String, Value>) -> Result<String> {
    if route.path == "/" {
        return Ok("/".to_owned());
    }

    let mut segments = Vec::new();
    for segment in route.path.trim_matches('/').split('/') {
        if let Some(name) = segment.strip_prefix(':') {
            let value = required_string_param(route, params, name)?;
            validate_static_param_segment(route, name, value)?;
            segments.push(value.to_owned());
        } else if segment.starts_with('*') {
            let optional = segment.ends_with('?');
            let name = segment
                .strip_prefix('*')
                .expect("checked prefix")
                .trim_end_matches('?');
            let values = catch_all_param(route, params, name, optional)?;
            segments.extend(values);
        } else {
            segments.push(segment.to_owned());
        }
    }

    Ok(format!("/{}", segments.join("/")))
}

fn ordered_route_params(
    route: &Route,
    params: &BTreeMap<String, Value>,
) -> Result<Vec<(String, Value)>> {
    let expected = route
        .params
        .iter()
        .map(|param| param.name.as_str())
        .collect::<BTreeSet<_>>();

    for key in params.keys() {
        if !expected.contains(key.as_str()) {
            return Err(invalid_static_params(route, format!("unknown `{key}`")));
        }
    }

    route
        .params
        .iter()
        .filter_map(|param| {
            let value = match param.kind {
                RouteParamKind::Dynamic => {
                    let value = match required_string_param(route, params, &param.name) {
                        Ok(value) => value,
                        Err(error) => return Some(Err(error)),
                    };
                    if let Err(error) = validate_static_param_segment(route, &param.name, value) {
                        return Some(Err(error));
                    }
                    Value::String(value.to_owned())
                }
                RouteParamKind::CatchAll => {
                    let values = match catch_all_param(route, params, &param.name, false) {
                        Ok(values) => values,
                        Err(error) => return Some(Err(error)),
                    };
                    Value::Array(values.into_iter().map(Value::String).collect())
                }
                RouteParamKind::OptionalCatchAll => match params.get(&param.name) {
                    Some(_) => {
                        let values = match catch_all_param(route, params, &param.name, true) {
                            Ok(values) => values,
                            Err(error) => return Some(Err(error)),
                        };
                        Value::Array(values.into_iter().map(Value::String).collect())
                    }
                    None => return None,
                },
            };

            Some(Ok((param.name.clone(), value)))
        })
        .collect()
}

fn required_string_param<'a>(
    route: &Route,
    params: &'a BTreeMap<String, Value>,
    name: &str,
) -> Result<&'a str> {
    let value = params
        .get(name)
        .ok_or_else(|| invalid_static_params(route, format!("missing `{name}`")))?;

    value
        .as_str()
        .ok_or_else(|| invalid_static_params(route, format!("`{name}` must be a string")))
}

fn catch_all_param(
    route: &Route,
    params: &BTreeMap<String, Value>,
    name: &str,
    optional: bool,
) -> Result<Vec<String>> {
    let Some(value) = params.get(name) else {
        if optional {
            return Ok(Vec::new());
        }
        return Err(invalid_static_params(route, format!("missing `{name}`")));
    };

    let values = value
        .as_array()
        .ok_or_else(|| invalid_static_params(route, format!("`{name}` must be a string array")))?;

    if values.is_empty() && !optional {
        return Err(invalid_static_params(
            route,
            format!("`{name}` must include at least one segment"),
        ));
    }

    values
        .iter()
        .enumerate()
        .map(|(index, value)| {
            let value = value.as_str().ok_or_else(|| {
                invalid_static_params(route, format!("`{name}` segment {index} must be a string"))
            })?;
            validate_static_param_segment(route, name, value)?;
            Ok(value.to_owned())
        })
        .collect()
}

fn validate_static_param_segment(route: &Route, name: &str, value: &str) -> Result<()> {
    if value.is_empty() {
        return Err(invalid_static_params(
            route,
            format!("`{name}` cannot be empty"),
        ));
    }

    if value == "." || value == ".." || value.contains('/') || value.contains('\\') {
        return Err(invalid_static_params(
            route,
            format!("`{name}` must be a single safe path segment"),
        ));
    }

    Ok(())
}

fn invalid_static_params(route: &Route, reason: impl Into<String>) -> BuildError {
    BuildError::InvalidStaticParams {
        route: route.path.clone(),
        reason: reason.into(),
    }
}

fn render_static_document(
    route_path: &str,
    route_pattern: &str,
    params: &[(String, Value)],
    page_html: &str,
    client_bundle: &ClientBundle,
    metadata: &PageMetadata,
) -> String {
    let page_props = serde_json::to_string(&serde_json::json!({
        "params": params.iter().cloned().collect::<BTreeMap<_, _>>()
    }))
    .expect("validated route params serialize to JSON");
    let metadata_tags = render_metadata_head_tags(metadata, "Ferrite");
    let scripts = client_bundle_scripts(client_bundle);
    let preloads = render_modulepreload_tags(&scripts);
    let styles = client_bundle_styles(client_bundle)
        .into_iter()
        .map(|href| format!(r#"  <link rel="stylesheet" href="{}">"#, escape_html(&href)))
        .collect::<Vec<_>>()
        .join("\n");
    let styles = if styles.is_empty() {
        String::new()
    } else {
        format!("{styles}\n")
    };
    format!(
        r#"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
{metadata_tags}{preloads}{styles}{scripts}
</head>
<body>
  <div id="ferrite-root" data-route="{route_path}" data-route-pattern="{route_pattern}" data-ferrite-page-props="{page_props}">{page_html}</div>
</body>
</html>"#,
        route_path = escape_html(route_path),
        route_pattern = escape_html(route_pattern),
        page_props = escape_html(&page_props),
        page_html = page_html,
        metadata_tags = metadata_tags,
        preloads = preloads,
        styles = styles,
        scripts = render_script_tags(&scripts),
    )
}

fn client_bundle_styles(client_bundle: &ClientBundle) -> Vec<String> {
    let mut styles = BTreeSet::new();
    styles.extend(client_bundle.styles.iter().cloned());
    for reference in &client_bundle.client_references {
        styles.extend(reference.styles.iter().cloned());
    }
    styles.into_iter().collect()
}

fn client_bundle_scripts(client_bundle: &ClientBundle) -> Vec<String> {
    let mut scripts = BTreeSet::new();
    scripts.extend(client_bundle.script.iter().cloned());
    scripts.extend(client_bundle.action_bootstrap.iter().cloned());
    for reference in &client_bundle.client_references {
        scripts.extend(reference.script.iter().cloned());
    }
    scripts.into_iter().collect()
}

fn render_script_tags(scripts: &[String]) -> String {
    scripts
        .iter()
        .map(|script| {
            format!(
                r#"  <script type="module" src="{}"></script>"#,
                escape_html(script)
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn render_modulepreload_tags(scripts: &[String]) -> String {
    let tags = scripts
        .iter()
        .map(|script| {
            format!(
                r#"  <link rel="modulepreload" href="{}">"#,
                escape_html(script)
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    if tags.is_empty() {
        String::new()
    } else {
        format!("{tags}\n")
    }
}

fn render_metadata_head_tags(metadata: &PageMetadata, default_title: &str) -> String {
    let mut tags = Vec::new();
    let title = metadata.title.as_deref().unwrap_or(default_title);
    tags.push(format!("  <title>{}</title>", escape_html(title)));

    if let Some(description) = metadata.description.as_deref() {
        tags.push(format!(
            r#"  <meta name="description" content="{}">"#,
            escape_html(description)
        ));
    }

    if let Some(open_graph) = metadata.open_graph.as_ref() {
        push_meta_property(&mut tags, "og:title", open_graph.title.as_deref());
        push_meta_property(
            &mut tags,
            "og:description",
            open_graph.description.as_deref(),
        );
        push_meta_property(&mut tags, "og:url", open_graph.url.as_deref());
        push_meta_property(&mut tags, "og:site_name", open_graph.site_name.as_deref());
        push_meta_property(&mut tags, "og:type", open_graph.kind.as_deref());

        for image in &open_graph.images {
            push_meta_property(&mut tags, "og:image", Some(image.url.as_str()));
            push_meta_property(&mut tags, "og:image:alt", image.alt.as_deref());
            push_meta_property(
                &mut tags,
                "og:image:width",
                image.width.as_ref().map(ToString::to_string).as_deref(),
            );
            push_meta_property(
                &mut tags,
                "og:image:height",
                image.height.as_ref().map(ToString::to_string).as_deref(),
            );
        }
    }

    for icon in &metadata.icons {
        let rel = icon.rel.as_deref().unwrap_or("icon");
        let mut tag = format!(
            r#"  <link rel="{}" href="{}""#,
            escape_html(rel),
            escape_html(&icon.url)
        );
        if let Some(kind) = icon.kind.as_deref() {
            tag.push_str(&format!(r#" type="{}""#, escape_html(kind)));
        }
        if let Some(sizes) = icon.sizes.as_deref() {
            tag.push_str(&format!(r#" sizes="{}""#, escape_html(sizes)));
        }
        tag.push('>');
        tags.push(tag);
    }

    if let Some(alternates) = metadata.alternates.as_ref() {
        if let Some(canonical) = alternates.canonical.as_deref() {
            tags.push(format!(
                r#"  <link rel="canonical" href="{}">"#,
                escape_html(canonical)
            ));
        }

        for (language, href) in &alternates.languages {
            tags.push(format!(
                r#"  <link rel="alternate" hreflang="{}" href="{}">"#,
                escape_html(language),
                escape_html(href)
            ));
        }
    }

    format!("{}\n", tags.join("\n"))
}

fn push_meta_property(tags: &mut Vec<String>, property: &str, content: Option<&str>) {
    if let Some(content) = content {
        tags.push(format!(
            r#"  <meta property="{}" content="{}">"#,
            escape_html(property),
            escape_html(content)
        ));
    }
}

fn escape_html(value: &str) -> String {
    let mut out = String::new();
    for char in value.chars() {
        match char {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(char),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, value: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, value).unwrap();
    }

    fn assert_fingerprinted_public_path(path: &str, extension: &str) {
        let file_name = Path::new(path)
            .file_name()
            .and_then(|name| name.to_str())
            .expect("public path has file name");
        let stem = file_name
            .strip_suffix(extension)
            .expect("public path has expected extension");
        let hash = stem
            .rsplit_once('.')
            .map(|(_name, hash)| hash)
            .expect("public path has fingerprint segment");
        assert_eq!(hash.len(), 16);
        assert!(hash.chars().all(|char| char.is_ascii_hexdigit()));
    }

    #[cfg(unix)]
    fn make_script(path: &Path, body: &str) {
        use std::os::unix::fs::PermissionsExt;

        write(path, &test_script_body(path, body));
        let mut permissions = fs::metadata(path).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(path, permissions).unwrap();
    }

    #[cfg(not(unix))]
    fn make_script(path: &Path, body: &str) {
        write(path, &test_script_body(path, body));
    }

    fn test_script_body(path: &Path, body: &str) -> String {
        if path.file_name().and_then(|name| name.to_str()) != Some("render-page.mjs") {
            return body.to_owned();
        }
        format!(
            r#"
if (process.argv[2] === "--build-artifact") {{
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const output = process.argv[4];
  await fs.mkdir(path.dirname(output), {{ recursive: true }});
  await fs.writeFile(output, "export const pageModule = {{}}; export const layoutModules = []; export const documentModule = null; export const conventionModules = {{}}; export const routePattern = '/';\n");
  process.exit(0);
}}
{body}
"#
        )
    }

    fn build_config(root: &Path) -> BuildConfig {
        let renderer = root.join("render-page.mjs");
        let bundler = root.join("build-client.mjs");
        make_script(
            &renderer,
            r#"
const mode = process.argv[2];
const staticMode = mode === "--static-params";
const metadataMode = mode === "--metadata";
const documentMode = mode === "--document";
const serverActionManifestMode = mode === "--server-action-manifest";
const explicitMode = staticMode || metadataMode || documentMode || serverActionManifestMode;
const page = explicitMode ? process.argv[3] : process.argv[2];
if (staticMode) {
  process.stdout.write(JSON.stringify({ has_generate_static_params: false, params: [] }));
  process.exit(0);
}
const props = explicitMode ? JSON.parse(process.argv[4]) : {};
if (serverActionManifestMode) {
  process.stdout.write(JSON.stringify({ routePath: "/", actions: [] }));
  process.exit(0);
}
const title = page.includes("about") ? "About Page" : page.includes("docs") ? "Docs Page" : "Home Page";
if (metadataMode) {
  const metadataTitle = page.includes("[id]") ? `Post ${props.params.id}` : title;
  process.stdout.write(JSON.stringify({
    title: metadataTitle,
    description: `Metadata for ${metadataTitle}`,
    openGraph: {
      title: `OG ${metadataTitle}`,
      siteName: "Ferrite",
      type: "website",
      images: [{ url: "/og.png", alt: "OG", width: 1200, height: 630 }]
    },
    icons: [{ url: "/favicon.svg", type: "image/svg+xml", sizes: "any" }],
    alternates: {
      canonical: `https://example.com${page.includes("about") ? "/about" : "/"}`,
      languages: { en: `https://example.com${page.includes("about") ? "/about" : "/"}` }
    }
  }));
  process.exit(0);
}
if (documentMode) {
  const options = JSON.parse(process.argv[7]);
  process.stdout.write(JSON.stringify({
    kind: "element",
    tag: "html",
    props: { "data-document": "test" },
    children: [
      {
        kind: "element",
        tag: "head",
        props: {},
        children: [{ kind: "element", tag: "title", props: {}, children: [{ kind: "text", value: options.metadata.title || options.defaultTitle }] }]
      },
      {
        kind: "element",
        tag: "body",
        props: {},
        children: [{
          kind: "element",
          tag: "div",
          props: { id: options.rootId, "data-route": options.routePath },
          children: [{ kind: "element", tag: "h1", props: {}, children: [{ kind: "text", value: title }] }]
        }]
      }
    ]
  }));
  process.exit(0);
}
process.stdout.write(JSON.stringify({
  kind: "element",
  tag: "main",
  props: { "data-rendered": title },
  children: [{ kind: "element", tag: "h1", props: {}, children: [{ kind: "text", value: title }] }]
}));
"#,
        );
        make_script(
            &bundler,
            r#"
const outDir = process.argv[3];
const route = process.argv[5].replaceAll("/", "-").replace(/^-+|-+$/g, "") || "index";
const fs = await import("node:fs/promises");
const path = await import("node:path");
await fs.mkdir(outDir, { recursive: true });
const js = `route-${route || "index"}.js`;
const css = `route-${route || "index"}.css`;
await fs.writeFile(path.join(outDir, js), "console.log('client');\n//# sourceMappingURL=" + js + ".map\n");
await fs.writeFile(path.join(outDir, js + ".map"), "{}");
await fs.writeFile(path.join(outDir, css), ".page{color:red}");
process.stdout.write(JSON.stringify({
  script: `/_ferrite/static/${js}`,
  styles: [`/_ferrite/static/${css}`],
  outputs: [js, `${js}.map`, css],
  sourcemaps: [`${js}.map`],
  assets: []
}));
"#,
        );
        BuildConfig::new(
            root.to_path_buf(),
            root.join("app"),
            root.join(".ferrite/build"),
            root.join(".ferrite/types/routes.d.ts"),
            renderer,
            bundler,
        )
    }

    #[test]
    fn builds_static_route_output_and_manifest() {
        let temp = tempfile::tempdir().unwrap();
        write(
            &temp.path().join("app/page.tsx"),
            "export default function Page() {}",
        );
        write(
            &temp.path().join("app/about/page.tsx"),
            "export default function About() {}",
        );
        write(
            &temp.path().join("public/assets/nested.txt"),
            "public asset",
        );
        fs::create_dir_all(temp.path().join("public/assets/empty")).unwrap();

        let report = build_project(&build_config(temp.path())).unwrap();

        assert_eq!(report.routes_count, 2);
        assert!(temp.path().join(".ferrite/build/index.html").is_file());
        assert!(
            temp.path()
                .join(".ferrite/build/about/index.html")
                .is_file()
        );
        assert!(
            temp.path()
                .join(".ferrite/build/ferrite-build.json")
                .is_file()
        );
        assert_eq!(
            fs::read_to_string(temp.path().join(".ferrite/build/assets/nested.txt")).unwrap(),
            "public asset"
        );
        assert!(temp.path().join(".ferrite/build/assets/empty").is_dir());
        let production_manifest: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(temp.path().join(".ferrite/build/ferrite-server.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            production_manifest["publicFiles"],
            serde_json::json!(["assets/nested.txt"])
        );
        let html = fs::read_to_string(temp.path().join(".ferrite/build/about/index.html")).unwrap();
        assert!(html.contains("<title>About Page</title>"));
        assert!(html.contains(r#"<meta name="description" content="Metadata for About Page">"#));
        assert!(html.contains(r#"<meta property="og:title" content="OG About Page">"#));
        assert!(html.contains(r#"<meta property="og:image" content="/og.png">"#));
        assert!(
            html.contains(
                r#"<link rel="icon" href="/favicon.svg" type="image/svg+xml" sizes="any">"#
            )
        );
        assert!(html.contains(r#"<link rel="canonical" href="https://example.com/about">"#));
        assert!(
            html.contains(
                r#"<link rel="alternate" hreflang="en" href="https://example.com/about">"#
            )
        );
        assert!(html.contains("<h1>About Page</h1>"));
        assert!(html.contains(r#"<link rel="stylesheet" href="/_ferrite/static/"#));
        assert!(html.contains(r#"<script type="module" src="/_ferrite/static/"#));
        let about_script = html
            .split("src=\"")
            .find_map(|part| part.strip_prefix("/_ferrite/static/"))
            .and_then(|part| part.split('"').next())
            .map(|path| format!("/_ferrite/static/{path}"))
            .expect("about script");
        assert!(html.contains(&format!(
            r#"<link rel="modulepreload" href="{about_script}">"#
        )));
        assert!(temp.path().join(".ferrite/types/routes.d.ts").is_file());
        assert_eq!(report.page_metadata.len(), 2);
        assert!(
            report
                .page_metadata
                .iter()
                .any(|entry| entry.route_path == "/about"
                    && entry.metadata.title.as_deref() == Some("About Page"))
        );
        assert_eq!(report.client_bundles.len(), 2);
        assert!(report.client_bundles[0].sourcemaps.len() == 1);
        let static_dir = temp.path().join(".ferrite/build/_ferrite/static");
        for bundle in &report.client_bundles {
            let script = bundle.script.as_deref().expect("route script");
            assert!(script.starts_with("/_ferrite/static/route-"));
            assert_fingerprinted_public_path(script, ".js");
            assert!(
                static_dir
                    .join(script.trim_start_matches("/_ferrite/static/"))
                    .is_file()
            );
            for style in &bundle.styles {
                assert!(style.starts_with("/_ferrite/static/route-"));
                assert_fingerprinted_public_path(style, ".css");
                assert!(
                    static_dir
                        .join(style.trim_start_matches("/_ferrite/static/"))
                        .is_file()
                );
            }
        }
        assert!(!static_dir.join("route-index.js").exists());
        assert!(report.skipped_dynamic_routes.is_empty());
    }

    #[test]
    fn build_rejects_reserved_public_directories_before_install() {
        let temp = tempfile::tempdir().unwrap();
        write(
            &temp.path().join("app/page.tsx"),
            "export default function Page() {}",
        );
        write(
            &temp.path().join("public/server/secret.txt"),
            "must not be published",
        );

        let error = build_project(&build_config(temp.path())).unwrap_err();

        assert!(error.to_string().contains("reserved artifact path"));
        assert!(
            !temp
                .path()
                .join(".ferrite/build/server/secret.txt")
                .exists()
        );
    }

    #[test]
    fn server_only_client_bundle_omits_route_assets_and_cleans_stale_static_output() {
        let temp = tempfile::tempdir().unwrap();
        write(
            &temp.path().join("app/page.tsx"),
            "export default function Page() {}",
        );
        let config = build_config(temp.path());
        let stale_file = temp.path().join(".ferrite/build/_ferrite/static/stale.js");
        write(&stale_file, "console.log('stale');");
        make_script(
            &config.client_bundler,
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

        let report = build_project(&config).unwrap();

        assert_eq!(report.client_bundles.len(), 1);
        assert_eq!(report.client_bundles[0].script, None);
        assert!(!stale_file.exists());
        assert!(!temp.path().join(".ferrite/build/_ferrite/static").exists());
        let html = fs::read_to_string(temp.path().join(".ferrite/build/index.html")).unwrap();
        assert!(!html.contains(r#"<link rel="stylesheet" href="/_ferrite/static/"#));
        assert!(!html.contains(r#"<script type="module" src="/_ferrite/static/"#));
    }

    #[test]
    fn build_manifest_records_client_references() {
        let temp = tempfile::tempdir().unwrap();
        write(
            &temp.path().join("app/page.tsx"),
            "export default function Page() {}",
        );
        let config = build_config(temp.path());
        make_script(
            &config.client_bundler,
            r#"
const outDir = process.argv[3];
const fs = await import("node:fs/promises");
const path = await import("node:path");
await fs.mkdir(outDir, { recursive: true });
await fs.writeFile(path.join(outDir, "client-reference-app-Counter-tsx-default.js"), "console.log('counter');");
await fs.writeFile(path.join(outDir, "client-reference-app-Counter-tsx-default.css"), ".counter{color:blue}");
process.stdout.write(JSON.stringify({
  script: null,
  styles: [],
  outputs: [],
  sourcemaps: [],
  assets: [],
  clientReferences: [
    {
      id: "app/Counter.tsx#default",
      module: "app/Counter.tsx",
      exportName: "default",
      script: "/_ferrite/static/client-reference-app-Counter-tsx-default.js",
      styles: ["/_ferrite/static/client-reference-app-Counter-tsx-default.css"],
      outputs: [
        "client-reference-app-Counter-tsx-default.css",
        "client-reference-app-Counter-tsx-default.js"
      ]
    }
  ],
  moduleGraph: [
    { file: "app/Counter.tsx", imports: [] },
    { file: "app/page.tsx", imports: ["app/Counter.tsx"] }
  ]
}));
"#,
        );

        build_project(&config).unwrap();

        let manifest: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(config.out_dir.join("ferrite-build.json")).unwrap(),
        )
        .unwrap();
        let reference = &manifest["client_bundles"][0]["clientReferences"][0];
        assert_eq!(reference["id"].as_str(), Some("app/Counter.tsx#default"));
        assert_eq!(reference["module"].as_str(), Some("app/Counter.tsx"));
        assert_eq!(reference["exportName"].as_str(), Some("default"));
        assert_eq!(
            manifest["client_bundles"][0]["moduleGraph"],
            serde_json::json!([
                { "file": "app/Counter.tsx", "imports": [] },
                { "file": "app/page.tsx", "imports": ["app/Counter.tsx"] },
            ])
        );
        let script = reference["script"]
            .as_str()
            .expect("client reference script");
        let style = reference["styles"][0]
            .as_str()
            .expect("client reference style");
        assert!(script.starts_with("/_ferrite/static/client-reference-app-Counter-tsx-default."));
        assert_fingerprinted_public_path(script, ".js");
        assert!(style.starts_with("/_ferrite/static/client-reference-app-Counter-tsx-default."));
        assert_fingerprinted_public_path(style, ".css");
        let outputs = reference["outputs"]
            .as_array()
            .expect("client reference outputs")
            .iter()
            .map(|output| output.as_str().expect("output path"))
            .collect::<Vec<_>>();
        let script_output = script.trim_start_matches("/_ferrite/static/");
        let style_output = style.trim_start_matches("/_ferrite/static/");
        assert!(outputs.contains(&script_output));
        assert!(outputs.contains(&style_output));
        assert!(!outputs.contains(&"client-reference-app-Counter-tsx-default.js"));
        assert!(!outputs.contains(&"client-reference-app-Counter-tsx-default.css"));
        assert!(
            config
                .out_dir
                .join("_ferrite/static")
                .join(script_output)
                .is_file()
        );
        assert!(
            config
                .out_dir
                .join("_ferrite/static")
                .join(style_output)
                .is_file()
        );
        let html = fs::read_to_string(config.out_dir.join("index.html")).unwrap();
        assert!(html.contains(&format!(r#"<link rel="modulepreload" href="{script}">"#)));
        assert!(html.contains(&format!(r#"<link rel="stylesheet" href="{style}">"#)));
        assert!(html.contains(&format!(
            r#"<script type="module" src="{script}"></script>"#
        )));
        assert!(!html.contains(r#"<script type="module" src="/_ferrite/static/route-index.js"#));
    }

    #[test]
    fn build_manifest_records_server_action_manifests() {
        let temp = tempfile::tempdir().unwrap();
        write(
            &temp.path().join("app/posts/[id]/page.tsx"),
            "export function generateStaticParams() { return [{ id: 'alpha' }]; } export default function Page() {}",
        );
        let config = build_config(temp.path());
        make_script(
            &config.client_bundler,
            r#"
const outDir = process.argv[3];
const options = JSON.parse(process.argv[8] || "{}");
const fs = await import("node:fs/promises");
const path = await import("node:path");
await fs.mkdir(outDir, { recursive: true });
if (options.actionBootstrap === true) {
  await fs.writeFile(path.join(outDir, "route-posts-alpha-action-bootstrap.js"), "console.log('action-bootstrap');");
  process.stdout.write(JSON.stringify({
    script: null,
    actionBootstrap: "/_ferrite/static/route-posts-alpha-action-bootstrap.js",
    styles: [],
    outputs: ["route-posts-alpha-action-bootstrap.js"],
    sourcemaps: [],
    assets: []
  }));
  process.exit(0);
}
process.stdout.write(JSON.stringify({
  script: null,
  styles: [],
  outputs: [],
  sourcemaps: [],
  assets: []
}));
"#,
        );
        make_script(
            &config.page_renderer,
            r#"
const mode = process.argv[2];
if (mode === "--static-params") {
  process.stdout.write(JSON.stringify({ has_generate_static_params: true, params: [{ id: "alpha" }] }));
  process.exit(0);
}
if (mode === "--metadata") {
  process.stdout.write(JSON.stringify({ title: "Post alpha" }));
  process.exit(0);
}
if (mode === "--server-action-manifest") {
  const props = JSON.parse(process.argv[4]);
  process.stdout.write(JSON.stringify({
    routePath: `/posts/${props.params.id}`,
    routePattern: "/posts/[id]",
    actions: [{
      ferrite: "server-action-reference",
      version: 1,
      id: "app/posts/[id]/page.tsx#savePost",
      routePattern: "/posts/[id]",
      url: "/_ferrite/action",
      bound: {}
    }]
  }));
  process.exit(0);
}
process.stdout.write(JSON.stringify({
  kind: "element",
  tag: "main",
  props: {},
  children: [{ kind: "text", value: "Post alpha" }]
}));
"#,
        );

        let report = build_project(&config).unwrap();

        assert_eq!(report.server_action_manifests.len(), 1);
        assert_eq!(report.server_action_manifests[0].route_path, "/posts/alpha");
        assert_eq!(report.client_bundles.len(), 1);
        assert_eq!(report.client_bundles[0].script, None);
        let action_bootstrap = report.client_bundles[0]
            .action_bootstrap
            .as_deref()
            .expect("server action route emits a standalone action bootstrap asset");
        assert_fingerprinted_public_path(action_bootstrap, ".js");
        let action_bootstrap_file = temp
            .path()
            .join(".ferrite/build/_ferrite/static")
            .join(action_bootstrap.trim_start_matches("/_ferrite/static/"));
        assert!(action_bootstrap_file.is_file());
        let html =
            fs::read_to_string(temp.path().join(".ferrite/build/posts/alpha/index.html")).unwrap();
        assert!(html.contains(&format!(
            r#"<script type="module" src="{action_bootstrap}"></script>"#
        )));
        assert!(!html.contains(r#"src="/_ferrite/static/route-posts-alpha.js"#));
        let manifest: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(config.out_dir.join("ferrite-build.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            manifest["client_bundles"][0]["actionBootstrap"].as_str(),
            Some(action_bootstrap)
        );
        assert_eq!(
            manifest["server_action_manifests"][0]["actions"][0]["id"].as_str(),
            Some("app/posts/[id]/page.tsx#savePost")
        );
        assert_eq!(
            manifest["server_action_manifests"][0]["actions"][0]["routePattern"].as_str(),
            Some("/posts/[id]")
        );
    }

    #[test]
    fn builds_with_custom_document_file() {
        let temp = tempfile::tempdir().unwrap();
        write(
            &temp.path().join("app/document.tsx"),
            "export default function Document() {}",
        );
        write(
            &temp.path().join("app/page.tsx"),
            "export default function Page() {}",
        );

        let report = build_project(&build_config(temp.path())).unwrap();

        assert_eq!(report.routes_count, 1);
        let html = fs::read_to_string(temp.path().join(".ferrite/build/index.html")).unwrap();
        assert!(html.starts_with("<!doctype html>\n<html data-document=\"test\">"));
        assert!(html.contains("<title>Home Page</title>"));
        assert!(html.contains(r#"<div data-route="/" id="ferrite-root">"#));
        assert!(html.contains("<h1>Home Page</h1>"));
    }

    #[test]
    fn passes_route_conventions_to_page_renderer() {
        let temp = tempfile::tempdir().unwrap();
        write(
            &temp.path().join("app/page.tsx"),
            "export default function Page() {}",
        );
        write(
            &temp.path().join("app/loading.tsx"),
            "export default function Loading() {}",
        );
        write(
            &temp.path().join("app/error.tsx"),
            "export default function ErrorFile() {}",
        );
        let config = build_config(temp.path());
        make_script(
            &config.page_renderer,
            r#"
const mode = process.argv[2];
if (mode === "--static-params") {
  process.stdout.write(JSON.stringify({ has_generate_static_params: false, params: [] }));
  process.exit(0);
}
if (mode === "--metadata") {
  process.stdout.write(JSON.stringify({ title: "Home Page", description: "Metadata for Home Page" }));
  process.exit(0);
}
if (mode === "--server-action-manifest") {
  process.stdout.write(JSON.stringify({ routePath: "/", actions: [] }));
  process.exit(0);
}
const conventions = JSON.parse(process.argv[5]);
process.stdout.write(JSON.stringify({
  kind: "element",
  tag: "main",
  props: {},
  children: [{
    kind: "element",
    tag: "p",
    props: {},
    children: [{ kind: "text", value: `${conventions.loading.endsWith("loading.tsx")}:${conventions.error.endsWith("error.tsx")}` }]
  }]
}));
"#,
        );

        let report = build_project(&config).unwrap();

        assert_eq!(report.routes_count, 1);
        let html = fs::read_to_string(temp.path().join(".ferrite/build/index.html")).unwrap();
        assert!(html.contains("<p>true:true</p>"));
    }

    #[test]
    fn skips_dynamic_routes_without_static_params() {
        let temp = tempfile::tempdir().unwrap();
        write(
            &temp.path().join("app/page.tsx"),
            "export default function Page() {}",
        );
        write(
            &temp.path().join("app/posts/[id]/page.tsx"),
            "export default function Post() {}",
        );

        let report = build_project(&build_config(temp.path())).unwrap();

        assert_eq!(report.routes_count, 2);
        assert_eq!(report.skipped_dynamic_routes, vec!["/posts/:id"]);
        assert!(
            !temp
                .path()
                .join(".ferrite/build/posts/:id/index.html")
                .exists()
        );
    }

    #[test]
    fn builds_dynamic_routes_from_static_params() {
        let temp = tempfile::tempdir().unwrap();
        write(
            &temp.path().join("app/page.tsx"),
            "export default function Page() {}",
        );
        write(
            &temp.path().join("app/posts/[id]/page.tsx"),
            "export default function Post() {}",
        );
        let config = build_config(temp.path());
        make_script(
            &config.page_renderer,
            r#"
const mode = process.argv[2];
const staticMode = mode === "--static-params";
const metadataMode = mode === "--metadata";
const serverActionManifestMode = mode === "--server-action-manifest";
const explicitMode = staticMode || metadataMode || serverActionManifestMode;
const page = explicitMode ? process.argv[3] : process.argv[2];
if (staticMode) {
  const result = page.includes("[id]")
    ? { has_generate_static_params: true, params: [{ id: "alpha" }, { id: "beta" }] }
    : { has_generate_static_params: false, params: [] };
  process.stdout.write(JSON.stringify(result));
  process.exit(0);
}
const props = JSON.parse(explicitMode ? process.argv[4] : process.argv[3]);
if (serverActionManifestMode) {
  process.stdout.write(JSON.stringify({ routePath: page.includes("[id]") ? `/posts/${props.params.id}` : "/", actions: [] }));
  process.exit(0);
}
const title = page.includes("[id]") ? `Post ${props.params.id}` : "Home Page";
if (metadataMode) {
  process.stdout.write(JSON.stringify({
    title,
    description: `Metadata for ${title}`
  }));
  process.exit(0);
}
process.stdout.write(JSON.stringify({
  kind: "element",
  tag: "main",
  props: { "data-rendered": title },
  children: [{ kind: "element", tag: "h1", props: {}, children: [{ kind: "text", value: title }] }]
}));
"#,
        );

        let report = build_project(&config).unwrap();

        assert_eq!(report.routes_count, 2);
        assert!(report.skipped_dynamic_routes.is_empty());
        assert!(
            temp.path()
                .join(".ferrite/build/posts/alpha/index.html")
                .is_file()
        );
        assert!(
            temp.path()
                .join(".ferrite/build/posts/beta/index.html")
                .is_file()
        );
        let html =
            fs::read_to_string(temp.path().join(".ferrite/build/posts/alpha/index.html")).unwrap();
        assert!(html.contains("data-route=\"/posts/alpha\""));
        assert!(html.contains("<title>Post alpha</title>"));
        assert!(html.contains("<h1>Post alpha</h1>"));
        assert_eq!(report.page_metadata.len(), 3);
        assert!(
            report
                .page_metadata
                .iter()
                .any(|entry| entry.route_path == "/posts/alpha"
                    && entry.metadata.title.as_deref() == Some("Post alpha"))
        );
        assert_eq!(report.client_bundles.len(), 3);
    }

    #[test]
    fn builds_catch_all_routes_from_static_params() {
        let temp = tempfile::tempdir().unwrap();
        write(
            &temp.path().join("app/docs/[...slug]/page.tsx"),
            "export default function Docs() {}",
        );
        let config = build_config(temp.path());
        make_script(
            &config.page_renderer,
            r#"
const mode = process.argv[2];
const staticMode = mode === "--static-params";
const metadataMode = mode === "--metadata";
const serverActionManifestMode = mode === "--server-action-manifest";
if (staticMode) {
  process.stdout.write(JSON.stringify({
    has_generate_static_params: true,
    params: [{ slug: ["guide", "intro"] }, { slug: ["api"] }]
  }));
  process.exit(0);
}
const props = JSON.parse(metadataMode || serverActionManifestMode ? process.argv[4] : process.argv[3]);
if (serverActionManifestMode) {
  process.stdout.write(JSON.stringify({ routePath: `/docs/${props.params.slug.join("/")}`, actions: [] }));
  process.exit(0);
}
const title = `Docs ${props.params.slug.join("/")}`;
if (metadataMode) {
  process.stdout.write(JSON.stringify({ title, description: `Metadata for ${title}` }));
  process.exit(0);
}
process.stdout.write(JSON.stringify({
  kind: "element",
  tag: "main",
  props: { "data-rendered": title },
  children: [{ kind: "element", tag: "h1", props: {}, children: [{ kind: "text", value: title }] }]
}));
"#,
        );

        let report = build_project(&config).unwrap();

        assert_eq!(report.routes_count, 1);
        assert!(report.skipped_dynamic_routes.is_empty());
        assert!(
            temp.path()
                .join(".ferrite/build/docs/guide/intro/index.html")
                .is_file()
        );
        assert!(
            temp.path()
                .join(".ferrite/build/docs/api/index.html")
                .is_file()
        );
        let html = fs::read_to_string(
            temp.path()
                .join(".ferrite/build/docs/guide/intro/index.html"),
        )
        .unwrap();
        assert!(html.contains("data-route=\"/docs/guide/intro\""));
        assert!(html.contains("<title>Docs guide/intro</title>"));
        assert!(html.contains("<h1>Docs guide/intro</h1>"));
        assert_eq!(report.page_metadata.len(), 2);
        assert!(
            report
                .page_metadata
                .iter()
                .any(|entry| entry.route_path == "/docs/guide/intro"
                    && entry.metadata.title.as_deref() == Some("Docs guide/intro"))
        );
    }

    #[test]
    fn builds_optional_catch_all_routes_without_segments() {
        let temp = tempfile::tempdir().unwrap();
        write(
            &temp.path().join("app/docs/[[...slug]]/page.tsx"),
            "export default function Docs() {}",
        );
        let config = build_config(temp.path());
        make_script(
            &config.page_renderer,
            r#"
const mode = process.argv[2];
const staticMode = mode === "--static-params";
const metadataMode = mode === "--metadata";
const serverActionManifestMode = mode === "--server-action-manifest";
if (staticMode) {
  process.stdout.write(JSON.stringify({
    has_generate_static_params: true,
    params: [{}, { slug: ["guide"] }]
  }));
  process.exit(0);
}
const props = JSON.parse(metadataMode || serverActionManifestMode ? process.argv[4] : process.argv[3]);
const slug = Array.isArray(props.params.slug) ? props.params.slug.join("/") : "index";
if (serverActionManifestMode) {
  process.stdout.write(JSON.stringify({ routePath: slug === "index" ? "/docs" : `/docs/${slug}`, actions: [] }));
  process.exit(0);
}
const title = `Docs ${slug}`;
if (metadataMode) {
  process.stdout.write(JSON.stringify({ title }));
  process.exit(0);
}
process.stdout.write(JSON.stringify({
  kind: "element",
  tag: "main",
  props: { "data-rendered": title },
  children: [{ kind: "element", tag: "h1", props: {}, children: [{ kind: "text", value: title }] }]
}));
"#,
        );

        let report = build_project(&config).unwrap();

        assert_eq!(report.routes_count, 1);
        assert!(temp.path().join(".ferrite/build/docs/index.html").is_file());
        assert!(
            temp.path()
                .join(".ferrite/build/docs/guide/index.html")
                .is_file()
        );
        let index_html =
            fs::read_to_string(temp.path().join(".ferrite/build/docs/index.html")).unwrap();
        assert!(index_html.contains("<h1>Docs index</h1>"));
        let guide_html =
            fs::read_to_string(temp.path().join(".ferrite/build/docs/guide/index.html")).unwrap();
        assert!(guide_html.contains("<h1>Docs guide</h1>"));
        assert_eq!(
            report
                .page_metadata
                .iter()
                .map(|entry| entry.route_path.as_str())
                .collect::<Vec<_>>(),
            vec!["/docs", "/docs/guide"]
        );
    }

    #[test]
    fn rejects_duplicate_dynamic_static_outputs() {
        let temp = tempfile::tempdir().unwrap();
        write(
            &temp.path().join("app/posts/[id]/page.tsx"),
            "export default function Post() {}",
        );
        let config = build_config(temp.path());
        make_script(
            &config.page_renderer,
            r#"
if (process.argv[2] === "--static-params") {
  process.stdout.write(JSON.stringify({
    has_generate_static_params: true,
    params: [{ id: "alpha" }, { id: "alpha" }]
  }));
  process.exit(0);
}
if (process.argv[2] === "--server-action-manifest") {
  process.stdout.write(JSON.stringify({ routePath: "/posts/alpha", actions: [] }));
  process.exit(0);
}
process.stdout.write(JSON.stringify({ kind: "text", value: "ok" }));
"#,
        );

        let error = build_project(&config).unwrap_err();

        assert!(matches!(
            error,
            BuildError::DuplicateStaticOutput { route_path } if route_path == "/posts/alpha"
        ));
    }

    #[test]
    fn rejects_duplicate_optional_catch_all_static_outputs() {
        let temp = tempfile::tempdir().unwrap();
        write(
            &temp.path().join("app/docs/[[...slug]]/page.tsx"),
            "export default function Docs() {}",
        );
        let config = build_config(temp.path());
        make_script(
            &config.page_renderer,
            r#"
if (process.argv[2] === "--static-params") {
  process.stdout.write(JSON.stringify({
    has_generate_static_params: true,
    params: [{}, { slug: [] }]
  }));
  process.exit(0);
}
if (process.argv[2] === "--server-action-manifest") {
  process.stdout.write(JSON.stringify({ routePath: "/docs", actions: [] }));
  process.exit(0);
}
process.stdout.write(JSON.stringify({ kind: "text", value: "ok" }));
"#,
        );

        let error = build_project(&config).unwrap_err();

        assert!(matches!(
            error,
            BuildError::DuplicateStaticOutput { route_path } if route_path == "/docs"
        ));
    }

    #[test]
    fn rejects_overlapping_route_patterns_before_rendering() {
        let temp = tempfile::tempdir().unwrap();
        write(
            &temp.path().join("app/docs/[id]/page.tsx"),
            "export default function DocsPost() {}",
        );
        write(
            &temp.path().join("app/docs/[...slug]/page.tsx"),
            "export default function DocsCatchAll() {}",
        );
        let config = build_config(temp.path());
        make_script(
            &config.page_renderer,
            r#"
process.stderr.write("page renderer must not run for an ambiguous route table");
process.exit(99);
"#,
        );

        let error = build_project(&config).unwrap_err();

        assert!(matches!(
            error,
            BuildError::Router(error) if error.to_string().contains("ambiguous route patterns")
        ));
    }

    #[test]
    fn rejects_unsafe_static_param_segments() {
        let temp = tempfile::tempdir().unwrap();
        write(
            &temp.path().join("app/posts/[id]/page.tsx"),
            "export default function Post() {}",
        );
        let config = build_config(temp.path());
        make_script(
            &config.page_renderer,
            r#"
const staticMode = process.argv[2] === "--static-params";
if (staticMode) {
  process.stdout.write(JSON.stringify({
    has_generate_static_params: true,
    params: [{ id: "../secret" }]
  }));
  process.exit(0);
}
process.stdout.write(JSON.stringify({ kind: "text", value: "ok" }));
"#,
        );

        let error = build_project(&config).unwrap_err();

        assert!(matches!(
            error,
            BuildError::InvalidStaticParams { route, reason }
                if route == "/posts/:id" && reason.contains("single safe path segment")
        ));
    }

    #[test]
    fn rejects_unsafe_catch_all_static_param_segments() {
        let temp = tempfile::tempdir().unwrap();
        write(
            &temp.path().join("app/docs/[...slug]/page.tsx"),
            "export default function Docs() {}",
        );
        let config = build_config(temp.path());
        make_script(
            &config.page_renderer,
            r#"
const staticMode = process.argv[2] === "--static-params";
if (staticMode) {
  process.stdout.write(JSON.stringify({
    has_generate_static_params: true,
    params: [{ slug: ["guide", "../secret"] }]
  }));
  process.exit(0);
}
process.stdout.write(JSON.stringify({ kind: "text", value: "ok" }));
"#,
        );

        let error = build_project(&config).unwrap_err();

        assert!(matches!(
            error,
            BuildError::InvalidStaticParams { route, reason }
                if route == "/docs/*slug" && reason.contains("single safe path segment")
        ));
    }

    #[test]
    fn rejects_missing_app_dir() {
        let temp = tempfile::tempdir().unwrap();

        let error = build_project(&build_config(temp.path())).unwrap_err();

        assert!(matches!(
            error,
            BuildError::Router(ferrite_router::RouterError::AppDirMissing(_))
        ));
    }

    #[test]
    fn escapes_route_metadata_in_html() {
        let temp = tempfile::tempdir().unwrap();
        write(
            &temp.path().join("app/docs/page.tsx"),
            "export default function Docs() {}",
        );

        build_project(&build_config(temp.path())).unwrap();
        let html = fs::read_to_string(temp.path().join(".ferrite/build/docs/index.html")).unwrap();

        assert!(html.contains("data-route=\"/docs\""));
        assert!(html.contains("<title>Docs Page</title>"));
        assert!(html.contains(r#"<meta name="description" content="Metadata for Docs Page">"#));
        assert!(html.contains("<h1>Docs Page</h1>"));
    }

    #[test]
    fn fails_when_metadata_collection_fails() {
        let temp = tempfile::tempdir().unwrap();
        write(
            &temp.path().join("app/page.tsx"),
            "export default function Page() {}",
        );
        let renderer = temp.path().join("render-page.mjs");
        make_script(
            &renderer,
            r#"
if (process.argv[2] === "--metadata") {
  console.error("metadata failed");
  process.exit(1);
}
if (process.argv[2] === "--server-action-manifest") {
  process.stdout.write(JSON.stringify({ routePath: "/", actions: [] }));
  process.exit(0);
}
process.stdout.write(JSON.stringify({ kind: "text", value: "ok" }));
"#,
        );
        let bundler = temp.path().join("build-client.mjs");
        make_script(
            &bundler,
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
        let config = BuildConfig::new(
            temp.path().to_path_buf(),
            temp.path().join("app"),
            temp.path().join(".ferrite/build"),
            temp.path().join(".ferrite/types/routes.d.ts"),
            renderer,
            bundler,
        );

        let error = build_project(&config).unwrap_err();

        assert!(matches!(
            error,
            BuildError::PageRender(PageRenderError::NodeFailed { stderr, .. })
                if stderr == "metadata failed"
        ));
    }

    #[test]
    fn fails_when_document_render_fails() {
        let temp = tempfile::tempdir().unwrap();
        write(
            &temp.path().join("app/document.tsx"),
            "export default function Document() {}",
        );
        write(
            &temp.path().join("app/page.tsx"),
            "export default function Page() {}",
        );
        let renderer = temp.path().join("render-page.mjs");
        make_script(
            &renderer,
            r#"
if (process.argv[2] === "--metadata") {
  process.stdout.write("{}");
  process.exit(0);
}
if (process.argv[2] === "--server-action-manifest") {
  process.stdout.write(JSON.stringify({ routePath: "/", actions: [] }));
  process.exit(0);
}
if (process.argv[2] === "--document") {
  console.error("document failed");
  process.exit(1);
}
process.stdout.write(JSON.stringify({ kind: "text", value: "ok" }));
"#,
        );
        let bundler = temp.path().join("build-client.mjs");
        make_script(
            &bundler,
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
        let config = BuildConfig::new(
            temp.path().to_path_buf(),
            temp.path().join("app"),
            temp.path().join(".ferrite/build"),
            temp.path().join(".ferrite/types/routes.d.ts"),
            renderer,
            bundler,
        );

        let error = build_project(&config).unwrap_err();

        assert!(matches!(
            error,
            BuildError::PageRender(PageRenderError::NodeFailed { stderr, .. })
                if stderr == "document failed"
        ));
    }

    #[test]
    fn fails_when_page_execution_fails() {
        let temp = tempfile::tempdir().unwrap();
        write(
            &temp.path().join("app/page.tsx"),
            "export default function Page() {}",
        );
        let renderer = temp.path().join("render-page.mjs");
        make_script(
            &renderer,
            r#"
console.error("render failed");
process.exit(1);
"#,
        );
        let config = BuildConfig::new(
            temp.path().to_path_buf(),
            temp.path().join("app"),
            temp.path().join(".ferrite/build"),
            temp.path().join(".ferrite/types/routes.d.ts"),
            renderer,
            temp.path().join("build-client.mjs"),
        );

        let error = build_project(&config).unwrap_err();

        assert!(matches!(
            error,
            BuildError::PageRender(PageRenderError::NodeFailed { stderr, .. })
                if stderr == "render failed"
        ));
    }

    #[test]
    fn failed_build_preserves_the_previous_complete_output() {
        let temp = tempfile::tempdir().unwrap();
        write(
            &temp.path().join("app/page.tsx"),
            "export default function Page() {}",
        );
        let config = build_config(temp.path());
        write(&config.out_dir.join("previous.txt"), "previous release");
        make_script(
            &config.page_renderer,
            r#"
console.error("intentional staged build failure");
process.exit(1);
"#,
        );

        assert!(build_project(&config).is_err());
        assert_eq!(
            fs::read_to_string(config.out_dir.join("previous.txt")).unwrap(),
            "previous release"
        );
    }

    #[test]
    fn failed_staged_activation_restores_the_previous_output() {
        let temp = tempfile::tempdir().unwrap();
        let destination = temp.path().join("build");
        write(&destination.join("previous.txt"), "previous release");

        let error = install_staged_build(&temp.path().join("missing-stage"), &destination)
            .expect_err("missing staged directory must fail activation");

        assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
        assert_eq!(
            fs::read_to_string(destination.join("previous.txt")).unwrap(),
            "previous release"
        );
    }

    #[test]
    fn fails_when_client_bundling_fails() {
        let temp = tempfile::tempdir().unwrap();
        write(
            &temp.path().join("app/page.tsx"),
            "export default function Page() {}",
        );
        let renderer = temp.path().join("render-page.mjs");
        make_script(
            &renderer,
            r#"
if (process.argv[2] === "--metadata") {
  process.stdout.write("{}");
  process.exit(0);
}
if (process.argv[2] === "--server-action-manifest") {
  process.stdout.write(JSON.stringify({ routePath: "/", actions: [] }));
  process.exit(0);
}
process.stdout.write(JSON.stringify({ kind: "text", value: "ok" }));
"#,
        );
        let bundler = temp.path().join("build-client.mjs");
        make_script(
            &bundler,
            r#"
console.error("client bundle failed");
process.exit(1);
"#,
        );
        let config = BuildConfig::new(
            temp.path().to_path_buf(),
            temp.path().join("app"),
            temp.path().join(".ferrite/build"),
            temp.path().join(".ferrite/types/routes.d.ts"),
            renderer,
            bundler,
        );

        let error = build_project(&config).unwrap_err();

        assert!(matches!(
            error,
            BuildError::ClientBundle(ClientBundleError::NodeFailed { stderr, .. })
                if stderr == "client bundle failed"
        ));
    }

    #[test]
    fn rejects_a_mixed_server_and_client_source_snapshot() {
        let temp = tempfile::tempdir().unwrap();
        let page = temp.path().join("app/page.tsx");
        write(&page, "export const version = 'A';");
        let renderer = temp.path().join("snapshot-renderer.mjs");
        make_script(
            &renderer,
            r#"
const fs = await import("node:fs/promises");
const path = await import("node:path");
const mode = process.argv[2];
const page = mode.startsWith("--") ? process.argv[3] : process.argv[2];
if (mode === "--build-artifact") {
  const output = process.argv[4];
  const source = await fs.readFile(page, "utf8");
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, `export const capturedSource = ${JSON.stringify(source)};\n`);
  await fs.writeFile(page, "export const version = 'B';");
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
        let bundler = temp.path().join("snapshot-bundler.mjs");
        make_script(
            &bundler,
            r#"
const crypto = await import("node:crypto");
const fs = await import("node:fs/promises");
const page = await fs.realpath(process.argv[2]);
const source = await fs.readFile(page);
const digest = crypto.createHash("sha256").update(source).digest("hex");
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
        let config = BuildConfig::new(
            temp.path().to_path_buf(),
            temp.path().join("app"),
            temp.path().join(".ferrite/build"),
            temp.path().join(".ferrite/types/routes.d.ts"),
            renderer,
            bundler,
        );

        let error = build_project(&config).expect_err(
            "a build must not combine server output from A with a client snapshot of B",
        );

        assert!(matches!(
            error,
            BuildError::ClientBundle(ClientBundleError::StaleInputSnapshot { .. })
        ));
    }

    #[test]
    fn rejects_a_mixed_snapshot_across_multiple_routes() {
        let temp = tempfile::tempdir().unwrap();
        write(
            &temp.path().join("app/page.tsx"),
            "export default function Page() {}",
        );
        write(
            &temp.path().join("app/about/page.tsx"),
            "export default function About() {}",
        );
        let shared_input = temp.path().join("shared.json");
        let invocation_count = temp.path().join("bundle-invocations.txt");
        write(&shared_input, r#"{"version":"A"}"#);
        let config = build_config(temp.path());
        let shared_input_json = serde_json::to_string(&shared_input).unwrap();
        let invocation_count_json = serde_json::to_string(&invocation_count).unwrap();
        make_script(
            &config.client_bundler,
            &format!(
                r#"
const crypto = await import("node:crypto");
const fs = await import("node:fs/promises");
const sharedInput = {shared_input_json};
const invocationCount = {invocation_count_json};
let count = 0;
try {{
  count = Number(await fs.readFile(invocationCount, "utf8"));
}} catch (error) {{
  if (error.code !== "ENOENT") throw error;
}}
if (count === 1) {{
  await fs.writeFile(sharedInput, '{{"version":"B"}}');
}}
await fs.writeFile(invocationCount, String(count + 1));
const resolved = await fs.realpath(sharedInput);
const source = await fs.readFile(resolved);
const digest = crypto.createHash("sha256").update(source).digest("hex");
process.stdout.write(JSON.stringify({{
  script: null,
  styles: [],
  outputs: [],
  sourcemaps: [],
  assets: [],
  inputSnapshot: [{{ path: resolved, kind: "source", value: `sha256:${{digest}}` }}]
}}));
"#
            ),
        );
        write(&config.out_dir.join("previous.txt"), "previous release");

        let error = build_project(&config)
            .expect_err("a build must not combine route snapshots from different source states");

        assert!(matches!(
            error,
            BuildError::ClientBundle(ClientBundleError::StaleInputSnapshot { .. })
        ));
        assert_eq!(
            fs::read_to_string(config.out_dir.join("previous.txt")).unwrap(),
            "previous release"
        );
    }

    fn assert_rejects_mixed_convention_snapshot(file_name: &str) {
        let temp = tempfile::tempdir().unwrap();
        let app_dir = temp.path().join("app");
        let page = app_dir.join("page.tsx");
        let mutation_target = app_dir.join(file_name);
        write(&page, "export default function Page() {}");
        write(&mutation_target, "export const version = 'A';");
        let renderer = temp.path().join("snapshot-renderer.mjs");
        let mutation_target_json = serde_json::to_string(&mutation_target).unwrap();
        make_script(
            &renderer,
            &format!(
                r#"
const fs = await import("node:fs/promises");
const path = await import("node:path");
const mode = process.argv[2];
if (mode === "--build-artifact") {{
  const output = process.argv[4];
  const target = {mutation_target_json};
  const source = await fs.readFile(target, "utf8");
  await fs.mkdir(path.dirname(output), {{ recursive: true }});
  await fs.writeFile(output, `export const capturedSource = ${{JSON.stringify(source)}};\n`);
  await fs.writeFile(target, "export const version = 'B';");
  process.exit(0);
}}
if (mode === "--static-params") {{
  process.stdout.write(JSON.stringify({{ has_generate_static_params: false, params: [] }}));
  process.exit(0);
}}
if (mode === "--server-action-manifest") {{
  process.stdout.write(JSON.stringify({{ routePath: "/", actions: [] }}));
  process.exit(0);
}}
if (mode === "--metadata") {{
  process.stdout.write("{{}}");
  process.exit(0);
}}
process.stdout.write(JSON.stringify({{ kind: "text", value: "ok" }}));
"#
            ),
        );
        let bundler = temp.path().join("snapshot-bundler.mjs");
        make_script(
            &bundler,
            r#"
const crypto = await import("node:crypto");
const fs = await import("node:fs/promises");
const options = JSON.parse(process.argv[8] || "{}");
const inputs = [process.argv[2], ...(options.snapshotFiles || [])];
const inputSnapshot = [];
for (const input of inputs) {
  const resolved = await fs.realpath(input);
  const source = await fs.readFile(resolved);
  const digest = crypto.createHash("sha256").update(source).digest("hex");
  inputSnapshot.push({ path: resolved, kind: "source", value: `sha256:${digest}` });
}
inputSnapshot.sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
process.stdout.write(JSON.stringify({
  script: null,
  styles: [],
  outputs: [],
  sourcemaps: [],
  assets: [],
  inputSnapshot
}));
"#,
        );
        let config = BuildConfig::new(
            temp.path().to_path_buf(),
            app_dir,
            temp.path().join(".ferrite/build"),
            temp.path().join(".ferrite/types/routes.d.ts"),
            renderer,
            bundler,
        );
        write(&config.out_dir.join("previous.txt"), "previous release");

        let error = build_project(&config)
            .expect_err("a convention source change must reject staged mixed output");

        assert!(matches!(
            error,
            BuildError::ClientBundle(ClientBundleError::StaleInputSnapshot { .. })
        ));
        assert_eq!(
            fs::read_to_string(config.out_dir.join("previous.txt")).unwrap(),
            "previous release"
        );
    }

    #[test]
    fn rejects_a_mixed_document_source_snapshot() {
        assert_rejects_mixed_convention_snapshot("document.tsx");
    }

    #[test]
    fn rejects_a_mixed_loading_source_snapshot() {
        assert_rejects_mixed_convention_snapshot("loading.tsx");
    }

    #[test]
    fn rejects_a_mixed_error_source_snapshot() {
        assert_rejects_mixed_convention_snapshot("error.tsx");
    }

    #[test]
    fn public_tree_is_deterministic_and_preserves_empty_directories() {
        let root = tempfile::tempdir().unwrap();
        let public = root.path().join("public");
        fs::create_dir_all(public.join("z/empty")).unwrap();
        write(&public.join("z/nested.txt"), "nested");
        write(&public.join("a.txt"), "a");
        let tree = collect_public_tree(&public).unwrap();
        assert_eq!(
            tree.files,
            vec![PathBuf::from("a.txt"), PathBuf::from("z/nested.txt")]
        );
        assert_eq!(
            tree.directories,
            vec![PathBuf::from("z"), PathBuf::from("z/empty")]
        );
        let out = root.path().join("out");
        copy_public_tree(&public, &out, &tree).unwrap();
        assert_eq!(
            fs::read_to_string(out.join("z/nested.txt")).unwrap(),
            "nested"
        );
        assert!(out.join("z/empty").is_dir());
    }

    #[test]
    fn missing_public_directory_is_backward_compatible() {
        let root = tempfile::tempdir().unwrap();
        assert!(
            collect_public_tree(&root.path().join("public"))
                .unwrap()
                .files
                .is_empty()
        );
    }

    #[cfg(unix)]
    #[test]
    fn public_tree_rejects_symlink_escape_and_reserved_paths() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let public = root.path().join("public");
        fs::create_dir_all(&public).unwrap();
        let outside = tempfile::tempdir().unwrap();
        write(&outside.path().join("secret.txt"), "secret");
        symlink(outside.path().join("secret.txt"), public.join("secret.txt")).unwrap();
        assert!(collect_public_tree(&public).is_err());
        fs::remove_file(public.join("secret.txt")).unwrap();
        fs::create_dir_all(public.join("_ferrite")).unwrap();
        let tree = collect_public_tree(&public).unwrap();
        assert!(is_reserved_public_path("_ferrite"));
        assert!(
            tree.directories
                .iter()
                .any(|path| path == Path::new("_ferrite"))
        );
    }

    #[cfg(unix)]
    #[test]
    fn public_tree_rejects_backslash_and_non_utf8_filenames() {
        use std::ffi::OsString;
        use std::os::unix::ffi::OsStringExt;

        let root = tempfile::tempdir().unwrap();
        let public = root.path().join("public");
        fs::create_dir_all(&public).unwrap();
        write(&public.join("bad\\name.txt"), "bad");
        assert!(collect_public_tree(&public).is_err());
        fs::remove_file(public.join("bad\\name.txt")).unwrap();

        let non_utf8 = OsString::from_vec(vec![b'c', 0x80, b'.', b't', b'x', b't']);
        write(&public.join(non_utf8), "bad");
        let error = collect_public_tree(&public).unwrap_err();
        assert!(error.to_string().contains("non-UTF-8"));
    }

    #[cfg(unix)]
    #[test]
    fn copying_public_tree_does_not_follow_a_source_symlink_swap() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let public = root.path().join("public");
        fs::create_dir_all(&public).unwrap();
        write(&public.join("asset.txt"), "safe");
        let tree = collect_public_tree(&public).unwrap();
        let outside = tempfile::NamedTempFile::new().unwrap();
        fs::remove_file(public.join("asset.txt")).unwrap();
        symlink(outside.path(), public.join("asset.txt")).unwrap();

        assert!(copy_public_tree(&public, &root.path().join("out"), &tree).is_err());
    }
}
