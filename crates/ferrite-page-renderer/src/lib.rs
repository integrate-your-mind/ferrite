use std::collections::BTreeMap;
use std::fmt;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug)]
pub enum PageRenderError {
    Io(std::io::Error),
    Json(serde_json::Error),
    Ssr(ferrite_ssr::SsrError),
    NodeFailed { status: Option<i32>, stderr: String },
}

impl fmt::Display for PageRenderError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PageRenderError::Io(error) => write!(f, "{error}"),
            PageRenderError::Json(error) => write!(f, "{error}"),
            PageRenderError::Ssr(error) => write!(f, "{error}"),
            PageRenderError::NodeFailed { status, stderr } => match status {
                Some(status) => write!(f, "page renderer failed with exit code {status}: {stderr}"),
                None => write!(f, "page renderer was terminated: {stderr}"),
            },
        }
    }
}

impl std::error::Error for PageRenderError {}

impl From<std::io::Error> for PageRenderError {
    fn from(error: std::io::Error) -> Self {
        PageRenderError::Io(error)
    }
}

impl From<serde_json::Error> for PageRenderError {
    fn from(error: serde_json::Error) -> Self {
        PageRenderError::Json(error)
    }
}

impl From<ferrite_ssr::SsrError> for PageRenderError {
    fn from(error: ferrite_ssr::SsrError) -> Self {
        PageRenderError::Ssr(error)
    }
}

pub type Result<T> = std::result::Result<T, PageRenderError>;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct RouteConventions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub loading: Option<PathBuf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<PathBuf>,
}

#[derive(Debug, Clone)]
pub struct PageRenderer {
    project: PathBuf,
    script: PathBuf,
}

impl PageRenderer {
    pub fn new(project: PathBuf, script: PathBuf) -> Self {
        Self { project, script }
    }

    pub fn render_page_to_html(
        &self,
        page_file: &Path,
        layouts: &[PathBuf],
        params: &[(String, Value)],
    ) -> Result<String> {
        self.render_page_to_html_with_conventions(
            page_file,
            layouts,
            params,
            &RouteConventions::default(),
        )
    }

    pub fn render_page_to_html_with_conventions(
        &self,
        page_file: &Path,
        layouts: &[PathBuf],
        params: &[(String, Value)],
        conventions: &RouteConventions,
    ) -> Result<String> {
        let props = PageProps {
            params: params.iter().cloned().collect(),
        };
        let props_json = serde_json::to_string(&props)?;
        let layouts_json = serde_json::to_string(layouts)?;
        let conventions_json = serde_json::to_string(conventions)?;
        let output = Command::new("node")
            .arg(&self.script)
            .arg(page_file)
            .arg(props_json)
            .arg(layouts_json)
            .arg(conventions_json)
            .current_dir(&self.project)
            .output()?;

        if !output.status.success() {
            return Err(PageRenderError::NodeFailed {
                status: output.status.code(),
                stderr: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
            });
        }

        let json = String::from_utf8_lossy(&output.stdout);
        Ok(ferrite_ssr::render_json_to_html(&json)?)
    }

    pub fn render_page_to_stream_parts(
        &self,
        page_file: &Path,
        layouts: &[PathBuf],
        params: &[(String, Value)],
    ) -> Result<ferrite_ssr::RenderStreamParts> {
        self.render_page_to_stream_parts_with_conventions(
            page_file,
            layouts,
            params,
            &RouteConventions::default(),
        )
    }

    pub fn render_page_to_stream_parts_with_conventions(
        &self,
        page_file: &Path,
        layouts: &[PathBuf],
        params: &[(String, Value)],
        conventions: &RouteConventions,
    ) -> Result<ferrite_ssr::RenderStreamParts> {
        let props = PageProps {
            params: params.iter().cloned().collect(),
        };
        let props_json = serde_json::to_string(&props)?;
        let layouts_json = serde_json::to_string(layouts)?;
        let conventions_json = serde_json::to_string(conventions)?;
        let output = Command::new("node")
            .arg(&self.script)
            .arg("--stream")
            .arg(page_file)
            .arg(props_json)
            .arg(layouts_json)
            .arg(conventions_json)
            .current_dir(&self.project)
            .output()?;

        if !output.status.success() {
            return Err(PageRenderError::NodeFailed {
                status: output.status.code(),
                stderr: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
            });
        }

        let json = String::from_utf8_lossy(&output.stdout);
        Ok(ferrite_ssr::render_stream_json_to_parts(&json)?)
    }

    pub fn render_page_to_server_payload_parts(
        &self,
        page_file: &Path,
        layouts: &[PathBuf],
        params: &[(String, Value)],
    ) -> Result<ferrite_ssr::RenderStreamParts> {
        self.render_page_to_server_payload_parts_with_conventions(
            page_file,
            layouts,
            params,
            &RouteConventions::default(),
        )
    }

    pub fn render_page_to_server_payload_parts_with_conventions(
        &self,
        page_file: &Path,
        layouts: &[PathBuf],
        params: &[(String, Value)],
        conventions: &RouteConventions,
    ) -> Result<ferrite_ssr::RenderStreamParts> {
        let props = PageProps {
            params: params.iter().cloned().collect(),
        };
        let props_json = serde_json::to_string(&props)?;
        let layouts_json = serde_json::to_string(layouts)?;
        let conventions_json = serde_json::to_string(conventions)?;
        let output = Command::new("node")
            .arg(&self.script)
            .arg("--server-payload")
            .arg(page_file)
            .arg(props_json)
            .arg(layouts_json)
            .arg(conventions_json)
            .current_dir(&self.project)
            .output()?;

        if !output.status.success() {
            return Err(PageRenderError::NodeFailed {
                status: output.status.code(),
                stderr: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
            });
        }

        let json = String::from_utf8_lossy(&output.stdout);
        Ok(ferrite_ssr::render_server_payload_json_to_parts(&json)?)
    }

    pub fn generate_static_params(&self, page_file: &Path) -> Result<StaticParamsResult> {
        let output = Command::new("node")
            .arg(&self.script)
            .arg("--static-params")
            .arg(page_file)
            .current_dir(&self.project)
            .output()?;

        if !output.status.success() {
            return Err(PageRenderError::NodeFailed {
                status: output.status.code(),
                stderr: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
            });
        }

        Ok(serde_json::from_slice(&output.stdout)?)
    }

    pub fn collect_metadata(
        &self,
        page_file: &Path,
        layouts: &[PathBuf],
        params: &[(String, Value)],
    ) -> Result<PageMetadata> {
        let props = PageProps {
            params: params.iter().cloned().collect(),
        };
        let props_json = serde_json::to_string(&props)?;
        let layouts_json = serde_json::to_string(layouts)?;
        let output = Command::new("node")
            .arg(&self.script)
            .arg("--metadata")
            .arg(page_file)
            .arg(props_json)
            .arg(layouts_json)
            .current_dir(&self.project)
            .output()?;

        if !output.status.success() {
            return Err(PageRenderError::NodeFailed {
                status: output.status.code(),
                stderr: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
            });
        }

        Ok(serde_json::from_slice(&output.stdout)?)
    }

    pub fn render_document_to_html(
        &self,
        page_file: &Path,
        layouts: &[PathBuf],
        document_file: &Path,
        params: &[(String, Value)],
        options: &DocumentRenderOptions,
    ) -> Result<String> {
        self.render_document_to_html_with_conventions(
            page_file,
            layouts,
            document_file,
            params,
            options,
            &RouteConventions::default(),
        )
    }

    pub fn render_document_to_html_with_conventions(
        &self,
        page_file: &Path,
        layouts: &[PathBuf],
        document_file: &Path,
        params: &[(String, Value)],
        options: &DocumentRenderOptions,
        conventions: &RouteConventions,
    ) -> Result<String> {
        let props = PageProps {
            params: params.iter().cloned().collect(),
        };
        let props_json = serde_json::to_string(&props)?;
        let layouts_json = serde_json::to_string(layouts)?;
        let options_json = serde_json::to_string(options)?;
        let conventions_json = serde_json::to_string(conventions)?;
        let output = Command::new("node")
            .arg(&self.script)
            .arg("--document")
            .arg(page_file)
            .arg(props_json)
            .arg(layouts_json)
            .arg(document_file)
            .arg(options_json)
            .arg(conventions_json)
            .current_dir(&self.project)
            .output()?;

        if !output.status.success() {
            return Err(PageRenderError::NodeFailed {
                status: output.status.code(),
                stderr: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
            });
        }

        let json = String::from_utf8_lossy(&output.stdout);
        let html = ferrite_ssr::render_json_to_html(&json)?;
        Ok(format!("<!doctype html>\n{html}"))
    }

    pub fn render_document_to_stream_parts(
        &self,
        page_file: &Path,
        layouts: &[PathBuf],
        document_file: &Path,
        params: &[(String, Value)],
        options: &DocumentRenderOptions,
    ) -> Result<ferrite_ssr::RenderStreamParts> {
        self.render_document_to_stream_parts_with_conventions(
            page_file,
            layouts,
            document_file,
            params,
            options,
            &RouteConventions::default(),
        )
    }

    pub fn render_document_to_stream_parts_with_conventions(
        &self,
        page_file: &Path,
        layouts: &[PathBuf],
        document_file: &Path,
        params: &[(String, Value)],
        options: &DocumentRenderOptions,
        conventions: &RouteConventions,
    ) -> Result<ferrite_ssr::RenderStreamParts> {
        let props = PageProps {
            params: params.iter().cloned().collect(),
        };
        let props_json = serde_json::to_string(&props)?;
        let layouts_json = serde_json::to_string(layouts)?;
        let options_json = serde_json::to_string(options)?;
        let conventions_json = serde_json::to_string(conventions)?;
        let output = Command::new("node")
            .arg(&self.script)
            .arg("--document-stream")
            .arg(page_file)
            .arg(props_json)
            .arg(layouts_json)
            .arg(document_file)
            .arg(options_json)
            .arg(conventions_json)
            .current_dir(&self.project)
            .output()?;

        if !output.status.success() {
            return Err(PageRenderError::NodeFailed {
                status: output.status.code(),
                stderr: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
            });
        }

        let json = String::from_utf8_lossy(&output.stdout);
        let mut parts = ferrite_ssr::render_stream_json_to_parts(&json)?;
        parts.shell = format!("<!doctype html>\n{}", parts.shell);
        Ok(parts)
    }

    pub fn render_document_to_server_payload_parts(
        &self,
        page_file: &Path,
        layouts: &[PathBuf],
        document_file: &Path,
        params: &[(String, Value)],
        options: &DocumentRenderOptions,
    ) -> Result<ferrite_ssr::RenderStreamParts> {
        self.render_document_to_server_payload_parts_with_conventions(
            page_file,
            layouts,
            document_file,
            params,
            options,
            &RouteConventions::default(),
        )
    }

    pub fn render_document_to_server_payload_parts_with_conventions(
        &self,
        page_file: &Path,
        layouts: &[PathBuf],
        document_file: &Path,
        params: &[(String, Value)],
        options: &DocumentRenderOptions,
        conventions: &RouteConventions,
    ) -> Result<ferrite_ssr::RenderStreamParts> {
        let props = PageProps {
            params: params.iter().cloned().collect(),
        };
        let props_json = serde_json::to_string(&props)?;
        let layouts_json = serde_json::to_string(layouts)?;
        let options_json = serde_json::to_string(options)?;
        let conventions_json = serde_json::to_string(conventions)?;
        let output = Command::new("node")
            .arg(&self.script)
            .arg("--document-server-payload")
            .arg(page_file)
            .arg(props_json)
            .arg(layouts_json)
            .arg(document_file)
            .arg(options_json)
            .arg(conventions_json)
            .current_dir(&self.project)
            .output()?;

        if !output.status.success() {
            return Err(PageRenderError::NodeFailed {
                status: output.status.code(),
                stderr: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
            });
        }

        let json = String::from_utf8_lossy(&output.stdout);
        let mut parts = ferrite_ssr::render_server_payload_json_to_parts(&json)?;
        parts.shell = format!("<!doctype html>\n{}", parts.shell);
        Ok(parts)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct StaticParamsResult {
    pub has_generate_static_params: bool,
    pub params: Vec<BTreeMap<String, Value>>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PageMetadata {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(rename = "openGraph", skip_serializing_if = "Option::is_none")]
    pub open_graph: Option<OpenGraphMetadata>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub icons: Vec<IconMetadata>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alternates: Option<AlternateMetadata>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenGraphMetadata {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub site_name: Option<String>,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<OpenGraphImage>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenGraphImage {
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IconMetadata {
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rel: Option<String>,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sizes: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlternateMetadata {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub canonical: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub languages: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentRenderOptions {
    pub root_id: String,
    pub route_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub route_pattern: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub build_id: Option<u64>,
    pub metadata: PageMetadata,
    pub styles: Vec<String>,
    pub scripts: Vec<String>,
    pub default_title: String,
}

#[derive(Debug, Serialize)]
struct PageProps {
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
    fn renders_page_json_to_html() {
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("render-page.mjs");
        make_script(
            &script,
            r#"
const props = JSON.parse(process.argv[3]);
process.stdout.write(JSON.stringify({
  kind: "element",
  tag: "h1",
  props: {},
  children: [{ kind: "text", value: `Post ${props.params.id}` }]
}));
"#,
        );
        let page = temp.path().join("page.tsx");
        fs::write(&page, "").unwrap();
        let renderer = PageRenderer::new(temp.path().to_path_buf(), script);

        let html = renderer
            .render_page_to_html(&page, &[], &[("id".to_owned(), json!("abc"))])
            .unwrap();

        assert_eq!(html, "<h1>Post abc</h1>");
    }

    #[test]
    fn renders_page_packet_to_html() {
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("render-page.mjs");
        make_script(
            &script,
            r#"
const props = JSON.parse(process.argv[3]);
process.stdout.write(JSON.stringify({
  ferrite: "render-packet",
  version: 1,
  root: [2, "h1", {}, [[0, `Post ${props.params.id}`]]]
}));
"#,
        );
        let page = temp.path().join("page.tsx");
        fs::write(&page, "").unwrap();
        let renderer = PageRenderer::new(temp.path().to_path_buf(), script);

        let html = renderer
            .render_page_to_html(&page, &[], &[("id".to_owned(), json!("packet"))])
            .unwrap();

        assert_eq!(html, "<h1>Post packet</h1>");
    }

    #[test]
    fn renders_page_stream_packet_to_parts() {
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("render-page.mjs");
        make_script(
            &script,
            r#"
const props = JSON.parse(process.argv[4]);
process.stdout.write(JSON.stringify({
  ferrite: "render-stream",
  version: 1,
  shell: [2, "div", { "data-ferrite-suspense-boundary": "s0" }, [[0, `Loading ${props.params.id}`]]],
  chunks: [{ id: "s0", root: [2, "strong", {}, [[0, `Post ${props.params.id}`]]] }]
}));
"#,
        );
        let page = temp.path().join("page.tsx");
        fs::write(&page, "").unwrap();
        let renderer = PageRenderer::new(temp.path().to_path_buf(), script);

        let parts = renderer
            .render_page_to_stream_parts(&page, &[], &[("id".to_owned(), json!("stream"))])
            .unwrap();

        assert_eq!(
            parts.shell,
            "<div data-ferrite-suspense-boundary=\"s0\">Loading stream</div>"
        );
        assert_eq!(parts.chunks.len(), 1);
        assert!(
            parts.chunks[0]
                .html
                .contains("<strong>Post stream</strong>")
        );
    }

    #[test]
    fn renders_page_server_payload_to_parts() {
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("render-page.mjs");
        make_script(
            &script,
            r#"
const props = JSON.parse(process.argv[4]);
process.stdout.write(JSON.stringify({
  ferrite: "server-payload",
  version: 1,
  shell: [2, "span", { "data-ferrite-client-reference": "app/Button.tsx#default" }, [[0, `Like ${props.params.id}: 0`]]],
  clientReferences: [{
    ferrite: "client-reference",
    version: 1,
    id: "app/Button.tsx#default",
    module: "app/Button.tsx",
    exportName: "default",
    props: { id: props.params.id }
  }],
  chunks: []
}));
"#,
        );
        let page = temp.path().join("page.tsx");
        fs::write(&page, "").unwrap();
        let renderer = PageRenderer::new(temp.path().to_path_buf(), script);

        let parts = renderer
            .render_page_to_server_payload_parts(&page, &[], &[("id".to_owned(), json!("payload"))])
            .unwrap();

        assert_eq!(
            parts.shell,
            "<span data-ferrite-client-reference=\"app/Button.tsx#default\">Like payload: 0</span>"
        );
        assert!(parts.chunks.is_empty());
    }

    #[test]
    fn passes_route_conventions_to_stream_runner() {
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("render-page.mjs");
        make_script(
            &script,
            r#"
const conventions = JSON.parse(process.argv[6]);
process.stdout.write(JSON.stringify({
  ferrite: "render-stream",
  version: 1,
  shell: [2, "div", { "data-ferrite-suspense-boundary": "s0" }, [[0, conventions.loading.endsWith("loading.tsx") ? "Loading file" : "Missing loading"]]],
  chunks: [{ id: "s0", root: [2, "strong", {}, [[0, conventions.error.endsWith("error.tsx") ? "Error file" : "Missing error"]]] }]
}));
"#,
        );
        let page = temp.path().join("page.tsx");
        let loading = temp.path().join("loading.tsx");
        let error = temp.path().join("error.tsx");
        fs::write(&page, "").unwrap();
        fs::write(&loading, "").unwrap();
        fs::write(&error, "").unwrap();
        let renderer = PageRenderer::new(temp.path().to_path_buf(), script);

        let parts = renderer
            .render_page_to_stream_parts_with_conventions(
                &page,
                &[],
                &[],
                &RouteConventions {
                    loading: Some(loading),
                    error: Some(error),
                },
            )
            .unwrap();

        assert!(parts.shell.contains("Loading file"));
        assert!(parts.chunks[0].html.contains("Error file"));
    }

    #[test]
    fn reports_node_failures() {
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("render-page.mjs");
        make_script(
            &script,
            r#"
console.error("page exploded");
process.exit(1);
"#,
        );
        let page = temp.path().join("page.tsx");
        fs::write(&page, "").unwrap();
        let renderer = PageRenderer::new(temp.path().to_path_buf(), script);

        let error = renderer.render_page_to_html(&page, &[], &[]).unwrap_err();

        assert!(matches!(
            error,
            PageRenderError::NodeFailed { stderr, .. } if stderr == "page exploded"
        ));
    }

    #[test]
    fn passes_layouts_to_runner() {
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("render-page.mjs");
        make_script(
            &script,
            r#"
const layouts = JSON.parse(process.argv[4]);
process.stdout.write(JSON.stringify({
  kind: "element",
  tag: "h1",
  props: {},
  children: [{ kind: "text", value: `Layouts ${layouts.length}` }]
}));
"#,
        );
        let page = temp.path().join("page.tsx");
        let layout = temp.path().join("layout.tsx");
        fs::write(&page, "").unwrap();
        fs::write(&layout, "").unwrap();
        let renderer = PageRenderer::new(temp.path().to_path_buf(), script);

        let html = renderer.render_page_to_html(&page, &[layout], &[]).unwrap();

        assert_eq!(html, "<h1>Layouts 1</h1>");
    }

    #[test]
    fn passes_array_params_to_runner() {
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("render-page.mjs");
        make_script(
            &script,
            r#"
const props = JSON.parse(process.argv[3]);
process.stdout.write(JSON.stringify({
  kind: "element",
  tag: "h1",
  props: {},
  children: [{ kind: "text", value: `Docs ${props.params.slug.join("/")}` }]
}));
"#,
        );
        let page = temp.path().join("page.tsx");
        fs::write(&page, "").unwrap();
        let renderer = PageRenderer::new(temp.path().to_path_buf(), script);

        let html = renderer
            .render_page_to_html(&page, &[], &[("slug".to_owned(), json!(["a", "b"]))])
            .unwrap();

        assert_eq!(html, "<h1>Docs a/b</h1>");
    }

    #[test]
    fn generates_static_params() {
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("render-page.mjs");
        make_script(
            &script,
            r#"
process.stdout.write(JSON.stringify({
  has_generate_static_params: true,
  params: [{ id: "alpha" }, { id: "beta" }]
}));
"#,
        );
        let page = temp.path().join("page.tsx");
        fs::write(&page, "").unwrap();
        let renderer = PageRenderer::new(temp.path().to_path_buf(), script);

        let result = renderer.generate_static_params(&page).unwrap();

        assert!(result.has_generate_static_params);
        assert_eq!(result.params.len(), 2);
        assert_eq!(result.params[0].get("id"), Some(&json!("alpha")));
    }

    #[test]
    fn generates_array_static_params() {
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("render-page.mjs");
        make_script(
            &script,
            r#"
process.stdout.write(JSON.stringify({
  has_generate_static_params: true,
  params: [{ slug: ["guide", "intro"] }]
}));
"#,
        );
        let page = temp.path().join("page.tsx");
        fs::write(&page, "").unwrap();
        let renderer = PageRenderer::new(temp.path().to_path_buf(), script);

        let result = renderer.generate_static_params(&page).unwrap();

        assert_eq!(
            result.params[0].get("slug"),
            Some(&json!(["guide", "intro"]))
        );
    }

    #[test]
    fn reports_static_param_node_failures() {
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("render-page.mjs");
        make_script(
            &script,
            r#"
console.error("params exploded");
process.exit(1);
"#,
        );
        let page = temp.path().join("page.tsx");
        fs::write(&page, "").unwrap();
        let renderer = PageRenderer::new(temp.path().to_path_buf(), script);

        let error = renderer.generate_static_params(&page).unwrap_err();

        assert!(matches!(
            error,
            PageRenderError::NodeFailed { stderr, .. } if stderr == "params exploded"
        ));
    }

    #[test]
    fn collects_metadata() {
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("render-page.mjs");
        make_script(
            &script,
            r#"
const props = JSON.parse(process.argv[4]);
const layouts = JSON.parse(process.argv[5]);
process.stdout.write(JSON.stringify({
  title: `Post ${props.params.id}`,
  description: `layouts ${layouts.length}`,
  openGraph: {
    title: `OG ${props.params.id}`,
    siteName: "Ferrite",
    type: "article",
    images: [{ url: "/og.png", alt: "OG", width: 1200, height: 630 }]
  },
  icons: [{ url: "/favicon.svg", type: "image/svg+xml", sizes: "any" }],
  alternates: {
    canonical: `https://example.com/posts/${props.params.id}`,
    languages: { en: `https://example.com/posts/${props.params.id}` }
  }
}));
"#,
        );
        let page = temp.path().join("page.tsx");
        let layout = temp.path().join("layout.tsx");
        fs::write(&page, "").unwrap();
        fs::write(&layout, "").unwrap();
        let renderer = PageRenderer::new(temp.path().to_path_buf(), script);

        let metadata = renderer
            .collect_metadata(&page, &[layout], &[("id".to_owned(), json!("abc"))])
            .unwrap();

        assert_eq!(
            metadata,
            PageMetadata {
                title: Some("Post abc".to_owned()),
                description: Some("layouts 1".to_owned()),
                open_graph: Some(OpenGraphMetadata {
                    title: Some("OG abc".to_owned()),
                    description: None,
                    url: None,
                    site_name: Some("Ferrite".to_owned()),
                    kind: Some("article".to_owned()),
                    images: vec![OpenGraphImage {
                        url: "/og.png".to_owned(),
                        alt: Some("OG".to_owned()),
                        width: Some(1200),
                        height: Some(630),
                    }],
                }),
                icons: vec![IconMetadata {
                    url: "/favicon.svg".to_owned(),
                    rel: None,
                    kind: Some("image/svg+xml".to_owned()),
                    sizes: Some("any".to_owned()),
                }],
                alternates: Some(AlternateMetadata {
                    canonical: Some("https://example.com/posts/abc".to_owned()),
                    languages: BTreeMap::from([(
                        "en".to_owned(),
                        "https://example.com/posts/abc".to_owned(),
                    )]),
                }),
            }
        );
    }

    #[test]
    fn renders_document_json_to_html() {
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("render-page.mjs");
        make_script(
            &script,
            r#"
const props = JSON.parse(process.argv[4]);
const options = JSON.parse(process.argv[7]);
process.stdout.write(JSON.stringify({
  kind: "element",
  tag: "html",
  props: { "data-route": options.routePath },
  children: [
    {
      kind: "element",
      tag: "head",
      props: {},
      children: [{ kind: "element", tag: "title", props: {}, children: [{ kind: "text", value: options.metadata.title }] }]
    },
    {
      kind: "element",
      tag: "body",
      props: {},
      children: [{
        kind: "element",
        tag: "div",
        props: { id: options.rootId },
        children: [{ kind: "text", value: props.params.slug.join("/") }]
      }]
    }
  ]
}));
"#,
        );
        let page = temp.path().join("page.tsx");
        let document = temp.path().join("document.tsx");
        fs::write(&page, "").unwrap();
        fs::write(&document, "").unwrap();
        let renderer = PageRenderer::new(temp.path().to_path_buf(), script);

        let html = renderer
            .render_document_to_html(
                &page,
                &[],
                &document,
                &[("slug".to_owned(), json!(["guide", "intro"]))],
                &DocumentRenderOptions {
                    root_id: "ferrite-root".to_owned(),
                    route_path: "/docs/guide/intro".to_owned(),
                    route_pattern: None,
                    build_id: None,
                    metadata: PageMetadata {
                        title: Some("Docs".to_owned()),
                        description: None,
                        ..PageMetadata::default()
                    },
                    styles: vec![],
                    scripts: vec![],
                    default_title: "Ferrite".to_owned(),
                },
            )
            .unwrap();

        assert_eq!(
            html,
            "<!doctype html>\n<html data-route=\"/docs/guide/intro\"><head><title>Docs</title></head><body><div id=\"ferrite-root\">guide/intro</div></body></html>"
        );
    }

    #[test]
    fn renders_document_stream_packet_to_parts() {
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("render-page.mjs");
        make_script(
            &script,
            r#"
const props = JSON.parse(process.argv[4]);
const options = JSON.parse(process.argv[7]);
process.stdout.write(JSON.stringify({
  ferrite: "render-stream",
  version: 1,
  shell: [
    2,
    "html",
    { "data-route": options.routePath },
    [[2, "body", {}, [[2, "div", { "data-ferrite-suspense-boundary": "s0" }, [[0, props.params.slug.join("/")]]]]]]
  ],
  chunks: [{ id: "s0", root: [2, "strong", {}, [[0, options.metadata.title]]] }]
}));
"#,
        );
        let page = temp.path().join("page.tsx");
        let document = temp.path().join("document.tsx");
        fs::write(&page, "").unwrap();
        fs::write(&document, "").unwrap();
        let renderer = PageRenderer::new(temp.path().to_path_buf(), script);

        let parts = renderer
            .render_document_to_stream_parts(
                &page,
                &[],
                &document,
                &[("slug".to_owned(), json!(["guide", "intro"]))],
                &DocumentRenderOptions {
                    root_id: "ferrite-root".to_owned(),
                    route_path: "/docs/guide/intro".to_owned(),
                    route_pattern: None,
                    build_id: None,
                    metadata: PageMetadata {
                        title: Some("Docs".to_owned()),
                        description: None,
                        ..PageMetadata::default()
                    },
                    styles: vec![],
                    scripts: vec![],
                    default_title: "Ferrite".to_owned(),
                },
            )
            .unwrap();

        assert!(parts.shell.starts_with("<!doctype html>\n<html"));
        assert!(parts.shell.contains("guide/intro"));
        assert_eq!(parts.chunks.len(), 1);
        assert!(parts.chunks[0].html.contains("<strong>Docs</strong>"));
    }

    #[test]
    fn renders_document_server_payload_to_parts() {
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("render-page.mjs");
        make_script(
            &script,
            r#"
const options = JSON.parse(process.argv[7]);
process.stdout.write(JSON.stringify({
  ferrite: "server-payload",
  version: 1,
  shell: [
    2,
    "html",
    {},
    [[2, "body", {}, [[2, "div", { id: options.rootId }, [[0, "Document payload"]]]]]]
  ],
  clientReferences: [],
  chunks: []
}));
"#,
        );
        let page = temp.path().join("page.tsx");
        let document = temp.path().join("document.tsx");
        fs::write(&page, "").unwrap();
        fs::write(&document, "").unwrap();
        let renderer = PageRenderer::new(temp.path().to_path_buf(), script);

        let parts = renderer
            .render_document_to_server_payload_parts(
                &page,
                &[],
                &document,
                &[],
                &DocumentRenderOptions {
                    root_id: "ferrite-root".to_owned(),
                    route_path: "/".to_owned(),
                    route_pattern: None,
                    build_id: None,
                    metadata: PageMetadata::default(),
                    styles: vec![],
                    scripts: vec![],
                    default_title: "Ferrite".to_owned(),
                },
            )
            .unwrap();

        assert!(parts.shell.starts_with("<!doctype html>\n<html"));
        assert!(parts.shell.contains("Document payload"));
    }

    #[test]
    fn reports_document_node_failures() {
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("render-page.mjs");
        make_script(
            &script,
            r#"
console.error("document exploded");
process.exit(1);
"#,
        );
        let page = temp.path().join("page.tsx");
        let document = temp.path().join("document.tsx");
        fs::write(&page, "").unwrap();
        fs::write(&document, "").unwrap();
        let renderer = PageRenderer::new(temp.path().to_path_buf(), script);

        let error = renderer
            .render_document_to_html(
                &page,
                &[],
                &document,
                &[],
                &DocumentRenderOptions {
                    root_id: "ferrite-root".to_owned(),
                    route_path: "/".to_owned(),
                    route_pattern: None,
                    build_id: None,
                    metadata: PageMetadata::default(),
                    styles: vec![],
                    scripts: vec![],
                    default_title: "Ferrite".to_owned(),
                },
            )
            .unwrap_err();

        assert!(matches!(
            error,
            PageRenderError::NodeFailed { stderr, .. } if stderr == "document exploded"
        ));
    }

    #[test]
    fn reports_metadata_node_failures() {
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("render-page.mjs");
        make_script(
            &script,
            r#"
console.error("metadata exploded");
process.exit(1);
"#,
        );
        let page = temp.path().join("page.tsx");
        fs::write(&page, "").unwrap();
        let renderer = PageRenderer::new(temp.path().to_path_buf(), script);

        let error = renderer.collect_metadata(&page, &[], &[]).unwrap_err();

        assert!(matches!(
            error,
            PageRenderError::NodeFailed { stderr, .. } if stderr == "metadata exploded"
        ));
    }
}
