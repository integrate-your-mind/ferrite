use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;

const BUNDLE_TIMEOUT_POLL_INTERVAL: Duration = Duration::from_millis(5);

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
    NodeFailed { status: Option<i32>, stderr: String },
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
            ClientBundleError::NodeFailed { status, stderr } => match status {
                Some(status) => {
                    write!(f, "client bundler failed with exit code {status}: {stderr}")
                }
                None => write!(f, "client bundler was terminated: {stderr}"),
            },
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
}

impl ClientBundler {
    pub fn new(project: PathBuf, script: PathBuf) -> Self {
        Self {
            project,
            script,
            command_timeout: None,
        }
    }

    pub fn with_command_timeout(mut self, timeout: Duration) -> Self {
        self.command_timeout = Some(timeout.max(Duration::from_millis(1)));
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
        let props = ClientProps {
            params: request.params.iter().cloned().collect(),
        };
        let props_json = serde_json::to_string(&props)?;
        let layouts_json = serde_json::to_string(request.layouts)?;
        let options_json = serde_json::to_string(&request.options)?;
        let mut command = Command::new("node");
        command
            .arg(&self.script)
            .arg(request.page_file)
            .arg(request.out_dir)
            .arg(request.public_path)
            .arg(request.route_path)
            .arg(props_json)
            .arg(layouts_json)
            .arg(options_json)
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
        Ok(bundle)
    }

    fn run_command(&self, mut command: Command) -> Result<BundlerOutput> {
        match self.command_timeout {
            Some(timeout) => run_command_with_timeout(command, timeout),
            None => {
                let output = command.output()?;
                Ok(BundlerOutput {
                    status: output.status,
                    stdout: output.stdout,
                    stderr: output.stderr,
                })
            }
        }
    }
}

#[derive(Debug)]
struct BundlerOutput {
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

fn run_command_with_timeout(mut command: Command, timeout: Duration) -> Result<BundlerOutput> {
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn()?;
    let mut stdout = child.stdout.take().expect("bundler stdout was piped");
    let mut stderr = child.stderr.take().expect("bundler stderr was piped");
    let stdout_reader = thread::spawn(move || {
        let mut output = Vec::new();
        stdout.read_to_end(&mut output).map(|_| output)
    });
    let stderr_reader = thread::spawn(move || {
        let mut output = Vec::new();
        stderr.read_to_end(&mut output).map(|_| output)
    });
    let started = Instant::now();

    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(BundlerOutput {
                status,
                stdout: stdout_reader
                    .join()
                    .expect("bundler stdout reader panicked")?,
                stderr: stderr_reader
                    .join()
                    .expect("bundler stderr reader panicked")?,
            });
        }

        if started.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            return Err(ClientBundleError::TimedOut { timeout });
        }

        thread::sleep(BUNDLE_TIMEOUT_POLL_INTERVAL.min(timeout.saturating_sub(started.elapsed())));
    }
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
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModuleGraphNode {
    pub file: String,
    #[serde(default)]
    pub imports: Vec<String>,
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

        Ok(())
    }
}

fn is_valid_module_graph_path(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && !path
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
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
                },
                ModuleGraphNode {
                    file: "app/page.tsx".to_owned(),
                    imports: vec!["app/Counter.tsx".to_owned()],
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
                },
                ModuleGraphNode {
                    file: "app/a.ts".to_owned(),
                    imports: vec!["../outside.ts".to_owned()],
                },
            ],
        };

        assert_eq!(
            bundle.validate().unwrap_err().to_string(),
            "invalid client module graph: imports must be sorted and unique"
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
            "app/posts/[id]/PostActions.tsx#default"
        );
        assert_eq!(
            bundle.client_references[0].script.as_deref(),
            Some("/_ferrite/static/client-reference-app-posts-id-PostActions-tsx-default.js")
        );
        assert!(bundle.client_references[0].outputs.contains(&PathBuf::from(
            "client-reference-app-posts-id-PostActions-tsx-default.js"
        )));
        assert_eq!(
            bundle.client_references[1].id,
            "app/posts/[id]/PostActions.tsx#ShareButton"
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
        assert!(action_bootstrap.ends_with("route-actions-action-bootstrap.js"));
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
