use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::fs;
use std::path::{Component, Path, PathBuf};

use ferrite_client_bundler::ClientBundle;
use ferrite_router::{Route, RouteParam, validate_route_table};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const FERRITE_PRODUCTION_ARTIFACT_MANIFEST: &str = "ferrite-server.json";
pub const FERRITE_PRODUCTION_ARTIFACT_FORMAT: &str = "ferrite-server";
pub const FERRITE_PRODUCTION_ARTIFACT_MAJOR: u16 = 1;
pub const FERRITE_PRODUCTION_ARTIFACT_MINOR: u16 = 0;

#[derive(Debug)]
pub enum ProductionArtifactError {
    Io(std::io::Error),
    Json(serde_json::Error),
    Invalid(String),
}

impl fmt::Display for ProductionArtifactError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(f, "{error}"),
            Self::Json(error) => write!(f, "{error}"),
            Self::Invalid(message) => write!(f, "invalid Ferrite production artifact: {message}"),
        }
    }
}

impl std::error::Error for ProductionArtifactError {}

impl From<std::io::Error> for ProductionArtifactError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<serde_json::Error> for ProductionArtifactError {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProductionArtifactFormat {
    pub name: String,
    pub major: u16,
    pub minor: u16,
}

impl Default for ProductionArtifactFormat {
    fn default() -> Self {
        Self {
            name: FERRITE_PRODUCTION_ARTIFACT_FORMAT.to_owned(),
            major: FERRITE_PRODUCTION_ARTIFACT_MAJOR,
            minor: FERRITE_PRODUCTION_ARTIFACT_MINOR,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProductionArtifactFile {
    pub path: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProductionArtifactRoute {
    pub path: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub params: Vec<RouteParam>,
    pub server_module: String,
    pub client_bundle: ClientBundle,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub prerendered: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub observed_actions: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProductionArtifactManifest {
    pub format: ProductionArtifactFormat,
    pub build_id: String,
    pub client_public_path: String,
    pub has_document: bool,
    pub routes: Vec<ProductionArtifactRoute>,
    pub files: Vec<ProductionArtifactFile>,
}

impl ProductionArtifactManifest {
    pub fn new(
        client_public_path: impl Into<String>,
        has_document: bool,
        routes: Vec<ProductionArtifactRoute>,
        files: Vec<ProductionArtifactFile>,
    ) -> Result<Self, ProductionArtifactError> {
        let mut manifest = Self {
            format: ProductionArtifactFormat::default(),
            build_id: String::new(),
            client_public_path: client_public_path.into(),
            has_document,
            routes,
            files,
        };
        finalize_production_artifact_manifest(&mut manifest)?;
        Ok(manifest)
    }
}

#[derive(Debug, Clone)]
pub struct LoadedProductionArtifact {
    pub root: PathBuf,
    pub manifest: ProductionArtifactManifest,
    pub verified_files: BTreeMap<String, Vec<u8>>,
}

impl LoadedProductionArtifact {
    pub fn resolve_file(&self, relative_path: &str) -> PathBuf {
        self.root.join(relative_path)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProductionArtifactIdentity<'a> {
    format: &'a ProductionArtifactFormat,
    client_public_path: &'a str,
    has_document: bool,
    routes: &'a [ProductionArtifactRoute],
    files: &'a [ProductionArtifactFile],
}

pub fn artifact_file_record(
    artifact_root: &Path,
    relative_path: &str,
) -> Result<ProductionArtifactFile, ProductionArtifactError> {
    validate_relative_path(relative_path)?;
    let path = artifact_root.join(relative_path);
    let bytes = fs::read(&path).map_err(|error| {
        ProductionArtifactError::Invalid(format!(
            "could not read `{relative_path}` while recording artifact contents: {error}"
        ))
    })?;
    Ok(ProductionArtifactFile {
        path: relative_path.to_owned(),
        size: bytes.len() as u64,
        sha256: sha256_hex(&bytes),
    })
}

pub fn finalize_production_artifact_manifest(
    manifest: &mut ProductionArtifactManifest,
) -> Result<(), ProductionArtifactError> {
    manifest
        .routes
        .sort_by(|left, right| left.path.cmp(&right.path));
    manifest
        .files
        .sort_by(|left, right| left.path.cmp(&right.path));
    validate_manifest_fields(manifest, false)?;
    manifest.build_id = manifest_build_id(manifest)?;
    Ok(())
}

pub fn load_production_artifact(
    root: impl AsRef<Path>,
) -> Result<LoadedProductionArtifact, ProductionArtifactError> {
    let requested_root = root.as_ref();
    let root = fs::canonicalize(requested_root).map_err(|error| {
        ProductionArtifactError::Invalid(format!(
            "artifact directory `{}` is unavailable: {error}",
            requested_root.display()
        ))
    })?;
    if !root.is_dir() {
        return Err(ProductionArtifactError::Invalid(format!(
            "artifact root `{}` is not a directory",
            root.display()
        )));
    }

    let manifest_path = root.join(FERRITE_PRODUCTION_ARTIFACT_MANIFEST);
    let manifest_bytes = fs::read(&manifest_path).map_err(|error| {
        ProductionArtifactError::Invalid(format!(
            "manifest `{}` is unavailable: {error}",
            manifest_path.display()
        ))
    })?;
    let manifest: ProductionArtifactManifest = serde_json::from_slice(&manifest_bytes)?;
    validate_manifest_fields(&manifest, true)?;

    let expected_build_id = manifest_build_id(&manifest)?;
    if manifest.build_id != expected_build_id {
        return Err(ProductionArtifactError::Invalid(format!(
            "buildId mismatch: expected `{expected_build_id}`, found `{}`",
            manifest.build_id
        )));
    }

    let mut verified_files = BTreeMap::new();
    for file in &manifest.files {
        let path = resolve_verified_file(&root, &file.path)?;
        let metadata = fs::metadata(&path)?;
        if metadata.len() != file.size {
            return Err(ProductionArtifactError::Invalid(format!(
                "size mismatch for `{}`: expected {}, found {}",
                file.path,
                file.size,
                metadata.len()
            )));
        }
        let bytes = fs::read(&path)?;
        let digest = sha256_hex(&bytes);
        if digest != file.sha256 {
            return Err(ProductionArtifactError::Invalid(format!(
                "SHA-256 mismatch for `{}`",
                file.path
            )));
        }
        verified_files.insert(file.path.clone(), bytes);
    }

    Ok(LoadedProductionArtifact {
        root,
        manifest,
        verified_files,
    })
}

fn validate_manifest_fields(
    manifest: &ProductionArtifactManifest,
    require_build_id: bool,
) -> Result<(), ProductionArtifactError> {
    if manifest.format.name != FERRITE_PRODUCTION_ARTIFACT_FORMAT {
        return Err(ProductionArtifactError::Invalid(format!(
            "unsupported format `{}`",
            manifest.format.name
        )));
    }
    if manifest.format.major != FERRITE_PRODUCTION_ARTIFACT_MAJOR {
        return Err(ProductionArtifactError::Invalid(format!(
            "unsupported format major {}; expected {}",
            manifest.format.major, FERRITE_PRODUCTION_ARTIFACT_MAJOR
        )));
    }
    if manifest.format.minor > FERRITE_PRODUCTION_ARTIFACT_MINOR {
        return Err(ProductionArtifactError::Invalid(format!(
            "unsupported format minor {}; maximum supported is {}",
            manifest.format.minor, FERRITE_PRODUCTION_ARTIFACT_MINOR
        )));
    }
    if require_build_id && !is_sha256_build_id(&manifest.build_id) {
        return Err(ProductionArtifactError::Invalid(
            "buildId must be `sha256:` followed by 64 lowercase hex characters".to_owned(),
        ));
    }
    if !manifest.client_public_path.starts_with('/')
        || manifest.client_public_path.ends_with('/')
        || manifest.client_public_path.contains('?')
        || manifest.client_public_path.contains('#')
    {
        return Err(ProductionArtifactError::Invalid(
            "clientPublicPath must be a non-root absolute URL path without a trailing slash, query, or fragment"
                .to_owned(),
        ));
    }

    let mut file_paths = BTreeSet::new();
    for file in &manifest.files {
        validate_relative_path(&file.path)?;
        if !file_paths.insert(file.path.as_str()) {
            return Err(ProductionArtifactError::Invalid(format!(
                "duplicate file `{}`",
                file.path
            )));
        }
        if !is_sha256_hex(&file.sha256) {
            return Err(ProductionArtifactError::Invalid(format!(
                "file `{}` has an invalid SHA-256 digest",
                file.path
            )));
        }
    }

    let route_table = manifest
        .routes
        .iter()
        .map(|route| Route {
            path: route.path.clone(),
            file: PathBuf::from(&route.server_module),
            layouts: Vec::new(),
            loading: None,
            error: None,
            params: route.params.clone(),
        })
        .collect::<Vec<_>>();
    validate_route_table(&route_table).map_err(|error| {
        ProductionArtifactError::Invalid(format!("route table validation failed: {error}"))
    })?;

    for route in &manifest.routes {
        validate_relative_path(&route.server_module)?;
        require_file(&file_paths, &route.server_module, "server module")?;
        validate_client_bundle_paths(route, &manifest.client_public_path, &file_paths)?;
        let mut action_ids = BTreeSet::new();
        for action in &route.observed_actions {
            if action.trim().is_empty() || !action_ids.insert(action.as_str()) {
                return Err(ProductionArtifactError::Invalid(format!(
                    "route `{}` contains an empty or duplicate observed server action id",
                    route.path
                )));
            }
        }
        for (route_path, html_file) in &route.prerendered {
            if !route_path.starts_with('/') || route_path.contains('?') || route_path.contains('#')
            {
                return Err(ProductionArtifactError::Invalid(format!(
                    "prerendered route `{route_path}` must be an absolute URL path"
                )));
            }
            validate_relative_path(html_file)?;
            require_file(&file_paths, html_file, "prerendered HTML")?;
        }
    }

    Ok(())
}

fn validate_client_bundle_paths(
    route: &ProductionArtifactRoute,
    client_public_path: &str,
    file_paths: &BTreeSet<&str>,
) -> Result<(), ProductionArtifactError> {
    let mut outputs = BTreeSet::new();
    for path in route.client_bundle.outputs.iter().chain(
        route
            .client_bundle
            .client_references
            .iter()
            .flat_map(|reference| reference.outputs.iter()),
    ) {
        let relative = client_output_artifact_path(path)?;
        if outputs.insert(relative.clone()) {
            require_file(file_paths, &relative, "client output")?;
        }
    }
    for public_url in route
        .client_bundle
        .script
        .iter()
        .chain(route.client_bundle.action_bootstrap.iter())
        .chain(route.client_bundle.styles.iter())
        .chain(
            route
                .client_bundle
                .client_references
                .iter()
                .flat_map(|reference| reference.script.iter().chain(reference.styles.iter())),
        )
    {
        let relative = public_url
            .strip_prefix(client_public_path)
            .and_then(|path| path.strip_prefix('/'))
            .ok_or_else(|| {
                ProductionArtifactError::Invalid(format!(
                    "route `{}` client URL `{public_url}` is outside clientPublicPath `{client_public_path}`",
                    route.path
                ))
            })?;
        validate_relative_path(relative)?;
        let artifact_path = format!("_ferrite/static/{relative}");
        require_file(file_paths, &artifact_path, "client URL target")?;
    }
    Ok(())
}

fn client_output_artifact_path(path: &Path) -> Result<String, ProductionArtifactError> {
    let output = path.to_str().ok_or_else(|| {
        ProductionArtifactError::Invalid("client output path is not valid UTF-8".to_owned())
    })?;
    validate_relative_path(output)?;
    Ok(format!("_ferrite/static/{output}"))
}

fn require_file(
    files: &BTreeSet<&str>,
    path: &str,
    kind: &str,
) -> Result<(), ProductionArtifactError> {
    if files.contains(path) {
        Ok(())
    } else {
        Err(ProductionArtifactError::Invalid(format!(
            "{kind} `{path}` is not declared in files"
        )))
    }
}

fn validate_relative_path(path: &str) -> Result<(), ProductionArtifactError> {
    if path.is_empty()
        || path.contains('\\')
        || path.split('/').any(|segment| segment.is_empty())
        || path
            .split('/')
            .next()
            .is_some_and(|segment| segment.ends_with(':'))
    {
        return Err(ProductionArtifactError::Invalid(format!(
            "artifact path `{path}` is not a normalized relative path"
        )));
    }
    let candidate = Path::new(path);
    if candidate.is_absolute()
        || candidate
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(ProductionArtifactError::Invalid(format!(
            "artifact path `{path}` is not a normalized relative path"
        )));
    }
    Ok(())
}

fn resolve_verified_file(
    root: &Path,
    relative_path: &str,
) -> Result<PathBuf, ProductionArtifactError> {
    validate_relative_path(relative_path)?;
    let requested = root.join(relative_path);
    let resolved = fs::canonicalize(&requested).map_err(|error| {
        ProductionArtifactError::Invalid(format!(
            "artifact file `{relative_path}` is unavailable: {error}"
        ))
    })?;
    if !resolved.starts_with(root) {
        return Err(ProductionArtifactError::Invalid(format!(
            "artifact file `{relative_path}` resolves outside the artifact root"
        )));
    }
    if !resolved.is_file() {
        return Err(ProductionArtifactError::Invalid(format!(
            "artifact file `{relative_path}` is not a regular file"
        )));
    }
    Ok(resolved)
}

fn manifest_build_id(
    manifest: &ProductionArtifactManifest,
) -> Result<String, ProductionArtifactError> {
    let identity = ProductionArtifactIdentity {
        format: &manifest.format,
        client_public_path: &manifest.client_public_path,
        has_document: manifest.has_document,
        routes: &manifest.routes,
        files: &manifest.files,
    };
    let encoded = serde_json::to_vec(&identity)?;
    Ok(format!("sha256:{}", sha256_hex(&encoded)))
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut encoded = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        write!(&mut encoded, "{byte:02x}").expect("writing to a String cannot fail");
    }
    encoded
}

fn is_sha256_build_id(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(is_sha256_hex)
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    fn symlink_file(original: &Path, link: &Path) {
        std::os::unix::fs::symlink(original, link).unwrap();
    }

    #[cfg(windows)]
    fn symlink_file(original: &Path, link: &Path) {
        std::os::windows::fs::symlink_file(original, link).unwrap();
    }

    fn write_file(root: &Path, path: &str, contents: &[u8]) -> ProductionArtifactFile {
        let full_path = root.join(path);
        fs::create_dir_all(full_path.parent().unwrap()).unwrap();
        fs::write(&full_path, contents).unwrap();
        artifact_file_record(root, path).unwrap()
    }

    fn valid_manifest(root: &Path) -> ProductionArtifactManifest {
        let server_file = write_file(root, "server/index.mjs", b"export default 1;\n");
        let client_file = write_file(root, "_ferrite/static/route.js", b"console.log(1);\n");
        ProductionArtifactManifest::new(
            "/_ferrite/static",
            false,
            vec![ProductionArtifactRoute {
                path: "/".to_owned(),
                params: Vec::new(),
                server_module: "server/index.mjs".to_owned(),
                client_bundle: ClientBundle {
                    script: Some("/_ferrite/static/route.js".to_owned()),
                    action_bootstrap: None,
                    styles: Vec::new(),
                    outputs: vec![PathBuf::from("route.js")],
                    sourcemaps: Vec::new(),
                    assets: Vec::new(),
                    client_references: Vec::new(),
                    module_graph: Vec::new(),
                    input_snapshot: Vec::new(),
                },
                prerendered: BTreeMap::new(),
                observed_actions: Vec::new(),
            }],
            vec![server_file, client_file],
        )
        .unwrap()
    }

    fn write_manifest(root: &Path, manifest: &ProductionArtifactManifest) {
        fs::write(
            root.join(FERRITE_PRODUCTION_ARTIFACT_MANIFEST),
            serde_json::to_vec_pretty(manifest).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn loads_and_verifies_a_complete_artifact() {
        let root = tempfile::tempdir().unwrap();
        let manifest = valid_manifest(root.path());
        write_manifest(root.path(), &manifest);

        let loaded = load_production_artifact(root.path()).unwrap();

        assert_eq!(loaded.manifest, manifest);
        assert!(loaded.root.is_absolute());
        assert_eq!(
            loaded.verified_files["server/index.mjs"],
            b"export default 1;\n"
        );
        assert_eq!(
            loaded.verified_files["_ferrite/static/route.js"],
            b"console.log(1);\n"
        );
    }

    #[test]
    fn rejects_unknown_fields_and_incompatible_versions() {
        let root = tempfile::tempdir().unwrap();
        let manifest = valid_manifest(root.path());
        let mut value = serde_json::to_value(&manifest).unwrap();
        value["unexpected"] = serde_json::json!(true);
        fs::write(
            root.path().join(FERRITE_PRODUCTION_ARTIFACT_MANIFEST),
            serde_json::to_vec(&value).unwrap(),
        )
        .unwrap();
        assert!(load_production_artifact(root.path()).is_err());

        let mut manifest = valid_manifest(root.path());
        manifest.format.major += 1;
        finalize_production_artifact_manifest(&mut manifest).unwrap_err();
    }

    #[test]
    fn rejects_manifest_and_file_tampering() {
        let root = tempfile::tempdir().unwrap();
        let mut manifest = valid_manifest(root.path());
        write_manifest(root.path(), &manifest);
        fs::write(root.path().join("server/index.mjs"), b"tampered\n").unwrap();
        assert!(
            load_production_artifact(root.path())
                .unwrap_err()
                .to_string()
                .contains("size mismatch")
        );

        fs::write(root.path().join("server/index.mjs"), b"export default 1;\n").unwrap();
        manifest.has_document = true;
        write_manifest(root.path(), &manifest);
        assert!(
            load_production_artifact(root.path())
                .unwrap_err()
                .to_string()
                .contains("buildId mismatch")
        );
    }

    #[test]
    fn rejects_missing_declared_files_and_traversal_paths() {
        let root = tempfile::tempdir().unwrap();
        let mut manifest = valid_manifest(root.path());
        manifest
            .files
            .retain(|file| file.path != "server/index.mjs");
        assert!(finalize_production_artifact_manifest(&mut manifest).is_err());

        let mut manifest = valid_manifest(root.path());
        manifest.routes[0].server_module = "../outside.mjs".to_owned();
        assert!(finalize_production_artifact_manifest(&mut manifest).is_err());
    }

    #[test]
    fn rejects_ambiguous_and_malformed_route_tables() {
        let root = tempfile::tempdir().unwrap();
        let mut manifest = valid_manifest(root.path());
        manifest.routes[0].path = "/docs/:id".to_owned();
        manifest.routes[0].params = vec![RouteParam {
            name: "id".to_owned(),
            kind: ferrite_router::RouteParamKind::Dynamic,
        }];
        let mut static_route = manifest.routes[0].clone();
        static_route.path = "/docs/about".to_owned();
        static_route.params.clear();
        manifest.routes.push(static_route);

        let error = finalize_production_artifact_manifest(&mut manifest).unwrap_err();
        assert!(error.to_string().contains("ambiguous route patterns"));

        let mut manifest = valid_manifest(root.path());
        manifest.routes[0].path = "/*slug??".to_owned();
        manifest.routes[0].params = vec![RouteParam {
            name: "slug?".to_owned(),
            kind: ferrite_router::RouteParamKind::OptionalCatchAll,
        }];
        let error = finalize_production_artifact_manifest(&mut manifest).unwrap_err();
        assert!(error.to_string().contains("invalid parameter"));
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn rejects_symlinks_that_escape_the_artifact_root() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::NamedTempFile::new().unwrap();
        let mut manifest = valid_manifest(root.path());
        fs::remove_file(root.path().join("server/index.mjs")).unwrap();
        symlink_file(outside.path(), &root.path().join("server/index.mjs"));
        manifest.files[1] = ProductionArtifactFile {
            path: "server/index.mjs".to_owned(),
            size: 0,
            sha256: sha256_hex(&[]),
        };
        finalize_production_artifact_manifest(&mut manifest).unwrap();
        write_manifest(root.path(), &manifest);

        assert!(
            load_production_artifact(root.path())
                .unwrap_err()
                .to_string()
                .contains("outside the artifact root")
        );
    }
}
