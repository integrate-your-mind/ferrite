use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};

use ferrite_client_bundler::{ClientBundle, ClientBundleError, ClientBundler};
use ferrite_page_renderer::{
    DocumentRenderOptions, PageMetadata, PageRenderError, PageRenderer, RouteConventions,
};
use ferrite_router::{Route, RouteParamKind, find_document_file, scan_app_dir, write_route_types};
use serde::Serialize;
use serde_json::Value;

#[derive(Debug)]
pub enum BuildError {
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BuildReport {
    pub out_dir: PathBuf,
    pub routes_count: usize,
    pub html_files: Vec<PathBuf>,
    pub page_metadata: Vec<PageMetadataEntry>,
    pub skipped_dynamic_routes: Vec<String>,
    pub manifest_file: PathBuf,
    pub client_bundles: Vec<ClientBundle>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PageMetadataEntry {
    pub route_path: String,
    pub metadata: PageMetadata,
}

#[derive(Debug, Serialize)]
struct BuildManifest<'a> {
    routes: &'a [Route],
    html_files: &'a [PathBuf],
    page_metadata: &'a [PageMetadataEntry],
    skipped_dynamic_routes: &'a [String],
    client_bundles: &'a [ClientBundle],
}

pub fn build_project(config: &BuildConfig) -> Result<BuildReport> {
    let routes = scan_app_dir(&config.app_dir)?;
    fs::create_dir_all(&config.out_dir)?;
    write_route_types(&routes, &config.types_out)?;
    let document_file = find_document_file(&config.app_dir);
    let page_renderer = PageRenderer::new(config.project.clone(), config.page_renderer.clone());
    let client_bundler = ClientBundler::new(config.project.clone(), config.client_bundler.clone());

    let mut html_files = Vec::new();
    let mut page_metadata = Vec::new();
    let mut skipped_dynamic_routes = Vec::new();
    let mut client_bundles = Vec::new();
    let mut generated_route_paths = BTreeSet::new();
    let client_out_dir = config.out_dir.join("_ferrite/static");
    if client_out_dir.exists() {
        fs::remove_dir_all(&client_out_dir)?;
    }

    for route in &routes {
        let static_param_sets = if route.params.is_empty() {
            vec![BTreeMap::new()]
        } else {
            let generated = page_renderer.generate_static_params(&route.file)?;
            if !generated.has_generate_static_params {
                skipped_dynamic_routes.push(route.path.clone());
                continue;
            }
            generated.params
        };

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
            let conventions = route_conventions(route);
            let (document, metadata, client_bundle) = if let Some(document_file) =
                document_file.as_deref()
            {
                let metadata =
                    page_renderer.collect_metadata(&route.file, &route.layouts, &ordered_params)?;
                let client_bundle = client_bundler.bundle_route(
                    &route.file,
                    &route.layouts,
                    &route_path,
                    &ordered_params,
                    &client_out_dir,
                    "/_ferrite/static",
                )?;
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
                            metadata: metadata.clone(),
                            styles: client_bundle_styles(&client_bundle),
                            scripts: client_bundle_scripts(&client_bundle),
                            default_title: "Ferrite".to_owned(),
                        },
                        &conventions,
                    )
                    .map(|document| (document, metadata, client_bundle))?
            } else {
                let page_html = page_renderer.render_page_to_html_with_conventions(
                    &route.file,
                    &route.layouts,
                    &ordered_params,
                    &conventions,
                )?;
                let metadata =
                    page_renderer.collect_metadata(&route.file, &route.layouts, &ordered_params)?;
                let client_bundle = client_bundler.bundle_route(
                    &route.file,
                    &route.layouts,
                    &route_path,
                    &ordered_params,
                    &client_out_dir,
                    "/_ferrite/static",
                )?;
                (
                    render_static_document(&route_path, &page_html, &client_bundle, &metadata),
                    metadata,
                    client_bundle,
                )
            };
            fs::write(&html_path, document)?;
            html_files.push(html_path);
            page_metadata.push(PageMetadataEntry {
                route_path,
                metadata,
            });
            client_bundles.push(client_bundle);
        }
    }

    let manifest_file = config.out_dir.join("ferrite-build.json");
    let manifest = BuildManifest {
        routes: &routes,
        html_files: &html_files,
        page_metadata: &page_metadata,
        skipped_dynamic_routes: &skipped_dynamic_routes,
        client_bundles: &client_bundles,
    };
    fs::write(&manifest_file, serde_json::to_string_pretty(&manifest)?)?;

    Ok(BuildReport {
        out_dir: config.out_dir.clone(),
        routes_count: routes.len(),
        html_files,
        page_metadata,
        skipped_dynamic_routes,
        manifest_file,
        client_bundles,
    })
}

fn route_conventions(route: &Route) -> RouteConventions {
    RouteConventions {
        loading: route.loading.clone(),
        error: route.error.clone(),
    }
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
    page_html: &str,
    client_bundle: &ClientBundle,
    metadata: &PageMetadata,
) -> String {
    let metadata_tags = render_metadata_head_tags(metadata, "Ferrite");
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
{metadata_tags}{styles}{scripts}
</head>
<body>
  <div id="ferrite-root" data-route="{route_path}">{page_html}</div>
</body>
</html>"#,
        route_path = escape_html(route_path),
        page_html = page_html,
        metadata_tags = metadata_tags,
        styles = styles,
        scripts = render_script_tags(&client_bundle_scripts(client_bundle)),
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

    #[cfg(unix)]
    fn make_script(path: &Path, body: &str) {
        use std::os::unix::fs::PermissionsExt;

        write(path, body);
        let mut permissions = fs::metadata(path).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(path, permissions).unwrap();
    }

    #[cfg(not(unix))]
    fn make_script(path: &Path, body: &str) {
        write(path, body);
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
const page = staticMode || metadataMode || documentMode ? process.argv[3] : process.argv[2];
if (staticMode) {
  process.stdout.write(JSON.stringify({ has_generate_static_params: false, params: [] }));
  process.exit(0);
}
const props = metadataMode || documentMode ? JSON.parse(process.argv[4]) : {};
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
        assert!(report.skipped_dynamic_routes.is_empty());
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
  ]
}));
"#,
        );

        build_project(&config).unwrap();

        let manifest: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(config.out_dir.join("ferrite-build.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            manifest["client_bundles"][0]["clientReferences"][0],
            serde_json::json!({
                "id": "app/Counter.tsx#default",
                "module": "app/Counter.tsx",
                "exportName": "default",
                "script": "/_ferrite/static/client-reference-app-Counter-tsx-default.js",
                "styles": ["/_ferrite/static/client-reference-app-Counter-tsx-default.css"],
                "outputs": [
                    "client-reference-app-Counter-tsx-default.css",
                    "client-reference-app-Counter-tsx-default.js"
                ]
            })
        );
        let html = fs::read_to_string(config.out_dir.join("index.html")).unwrap();
        assert!(html.contains(
            r#"<link rel="stylesheet" href="/_ferrite/static/client-reference-app-Counter-tsx-default.css">"#
        ));
        assert!(html.contains(
            r#"<script type="module" src="/_ferrite/static/client-reference-app-Counter-tsx-default.js"></script>"#
        ));
        assert!(!html.contains(r#"<script type="module" src="/_ferrite/static/route-index.js"#));
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
const page = staticMode || metadataMode ? process.argv[3] : process.argv[2];
if (staticMode) {
  const result = page.includes("[id]")
    ? { has_generate_static_params: true, params: [{ id: "alpha" }, { id: "beta" }] }
    : { has_generate_static_params: false, params: [] };
  process.stdout.write(JSON.stringify(result));
  process.exit(0);
}
const props = JSON.parse(metadataMode ? process.argv[4] : process.argv[3]);
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
if (staticMode) {
  process.stdout.write(JSON.stringify({
    has_generate_static_params: true,
    params: [{ slug: ["guide", "intro"] }, { slug: ["api"] }]
  }));
  process.exit(0);
}
const props = JSON.parse(metadataMode ? process.argv[4] : process.argv[3]);
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
if (staticMode) {
  process.stdout.write(JSON.stringify({
    has_generate_static_params: true,
    params: [{}, { slug: ["guide"] }]
  }));
  process.exit(0);
}
const props = JSON.parse(metadataMode ? process.argv[4] : process.argv[3]);
const slug = Array.isArray(props.params.slug) ? props.params.slug.join("/") : "index";
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
    fn rejects_duplicate_static_outputs_across_routes() {
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
if (process.argv[2] === "--static-params") {
  const page = process.argv[3];
  const params = page.includes("[...slug]")
    ? [{ slug: ["api"] }]
    : [{ id: "api" }];
  process.stdout.write(JSON.stringify({
    has_generate_static_params: true,
    params
  }));
  process.exit(0);
}
process.stdout.write(JSON.stringify({ kind: "text", value: "ok" }));
"#,
        );

        let error = build_project(&config).unwrap_err();

        assert!(matches!(
            error,
            BuildError::DuplicateStaticOutput { route_path } if route_path == "/docs/api"
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
process.stdout.write(JSON.stringify({ kind: "text", value: "ok" }));
"#,
        );
        let bundler = temp.path().join("build-client.mjs");
        make_script(
            &bundler,
            r#"
process.stdout.write(JSON.stringify({
  script: "/_ferrite/static/app.js",
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
  script: "/_ferrite/static/app.js",
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
}
