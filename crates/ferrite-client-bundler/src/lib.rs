use std::collections::BTreeMap;
use std::fmt;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug)]
pub enum ClientBundleError {
    Io(std::io::Error),
    Json(serde_json::Error),
    Protocol(ferrite_protocol::ProtocolError),
    NodeFailed { status: Option<i32>, stderr: String },
}

impl fmt::Display for ClientBundleError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ClientBundleError::Io(error) => write!(f, "{error}"),
            ClientBundleError::Json(error) => write!(f, "{error}"),
            ClientBundleError::Protocol(error) => write!(f, "{error}"),
            ClientBundleError::NodeFailed { status, stderr } => match status {
                Some(status) => {
                    write!(f, "client bundler failed with exit code {status}: {stderr}")
                }
                None => write!(f, "client bundler was terminated: {stderr}"),
            },
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
}

impl ClientBundler {
    pub fn new(project: PathBuf, script: PathBuf) -> Self {
        Self { project, script }
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
        let props = ClientProps {
            params: params.iter().cloned().collect(),
        };
        let props_json = serde_json::to_string(&props)?;
        let layouts_json = serde_json::to_string(layouts)?;
        let output = Command::new("node")
            .arg(&self.script)
            .arg(page_file)
            .arg(out_dir)
            .arg(public_path)
            .arg(route_path)
            .arg(props_json)
            .arg(layouts_json)
            .current_dir(&self.project)
            .output()?;

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
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClientBundle {
    pub script: Option<String>,
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

        Ok(())
    }
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
  clientReferences: [{ id: "app/Counter.tsx#default", module: "app/Counter.tsx", exportName: "default" }]
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
import PostActions, { ShareButton } from "./PostActions";
import PostShell from "./PostShell";

export default function Page() {
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
