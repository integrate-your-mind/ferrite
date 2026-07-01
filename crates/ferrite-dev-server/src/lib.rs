use std::collections::BTreeSet;
use std::fmt;
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use ferrite_client_bundler::{
    ClientBundle, ClientBundleError, ClientBundler, fingerprint_client_bundle,
};
use ferrite_page_renderer::{
    DocumentRenderOptions, PageMetadata, PageRenderError, PageRenderer, RouteConventions,
};
use ferrite_protocol::{SERVER_PAYLOAD_STREAM_FRAME_MARKER, SERVER_PAYLOAD_STREAM_FRAME_VERSION};
use ferrite_router::{Route, find_document_file, scan_app_dir, write_route_types};
use flate2::Compression;
use flate2::write::GzEncoder;
use serde::Serialize;
use serde_json::{Value, json};

const SERVER_PAYLOAD_CONTENT_TYPE: &str =
    "application/vnd.ferrite.server-payload+json; charset=utf-8";
const SERVER_PAYLOAD_STREAM_CONTENT_TYPE: &str =
    "application/vnd.ferrite.server-payload-stream+jsonl; charset=utf-8";
const SERVER_PAYLOAD_QUERY_NAME: &str = "__ferrite_payload";
const SERVER_PAYLOAD_QUERY_VALUE: &str = "server";
const SERVER_PAYLOAD_STREAM_QUERY_VALUE: &str = "stream";

#[derive(Debug)]
pub enum DevServerError {
    Router(ferrite_router::RouterError),
    Io(std::io::Error),
    Json(serde_json::Error),
    InvalidRequestPath(String),
    NoSocketAddress,
}

impl fmt::Display for DevServerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DevServerError::Router(error) => write!(f, "{error}"),
            DevServerError::Io(error) => write!(f, "{error}"),
            DevServerError::Json(error) => write!(f, "{error}"),
            DevServerError::InvalidRequestPath(path) => {
                write!(f, "request path must start with `/`: {path}")
            }
            DevServerError::NoSocketAddress => write!(f, "could not resolve server address"),
        }
    }
}

impl std::error::Error for DevServerError {}

impl From<ferrite_router::RouterError> for DevServerError {
    fn from(error: ferrite_router::RouterError) -> Self {
        DevServerError::Router(error)
    }
}

impl From<std::io::Error> for DevServerError {
    fn from(error: std::io::Error) -> Self {
        DevServerError::Io(error)
    }
}

impl From<serde_json::Error> for DevServerError {
    fn from(error: serde_json::Error) -> Self {
        DevServerError::Json(error)
    }
}

pub type Result<T> = std::result::Result<T, DevServerError>;

#[derive(Debug, Clone)]
pub struct DevServerConfig {
    pub project: PathBuf,
    pub app_dir: PathBuf,
    pub types_out: PathBuf,
    pub page_renderer: PathBuf,
    pub client_bundler: PathBuf,
    pub client_out_dir: PathBuf,
    pub client_public_path: String,
}

impl DevServerConfig {
    pub fn new(
        project: PathBuf,
        app_dir: PathBuf,
        types_out: PathBuf,
        page_renderer: PathBuf,
        client_bundler: PathBuf,
        client_out_dir: PathBuf,
        client_public_path: String,
    ) -> Self {
        Self {
            project,
            app_dir,
            types_out,
            page_renderer,
            client_bundler,
            client_out_dir,
            client_public_path,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ProductionServerConfig {
    pub project: PathBuf,
    pub app_dir: PathBuf,
    pub types_out: PathBuf,
    pub page_renderer: PathBuf,
    pub client_bundler: PathBuf,
    pub client_out_dir: PathBuf,
    pub client_public_path: String,
}

impl ProductionServerConfig {
    pub fn new(
        project: PathBuf,
        app_dir: PathBuf,
        types_out: PathBuf,
        page_renderer: PathBuf,
        client_bundler: PathBuf,
        client_out_dir: PathBuf,
        client_public_path: String,
    ) -> Self {
        Self {
            project,
            app_dir,
            types_out,
            page_renderer,
            client_bundler,
            client_out_dir,
            client_public_path,
        }
    }
}

#[derive(Debug)]
pub struct DevProject {
    config: DevServerConfig,
    snapshot: Option<RouteSnapshot>,
    build_id: u64,
}

impl DevProject {
    pub fn new(config: DevServerConfig) -> Self {
        Self {
            config,
            snapshot: None,
            build_id: 0,
        }
    }

    pub fn config(&self) -> &DevServerConfig {
        &self.config
    }

    pub fn build_id(&mut self) -> Result<u64> {
        self.ensure_fresh()?;
        Ok(self.build_id)
    }

    pub fn routes(&mut self) -> Result<&[Route]> {
        self.ensure_fresh()?;
        Ok(&self.snapshot.as_ref().expect("snapshot just built").routes)
    }

    pub fn handle_get(&mut self, raw_path: &str) -> Result<DevResponse> {
        if !raw_path.starts_with('/') {
            return Err(DevServerError::InvalidRequestPath(raw_path.to_owned()));
        }

        self.ensure_fresh()?;
        let path = strip_query(raw_path);

        match path {
            "/__ferrite/client.js" => Ok(DevResponse::ok(
                "text/javascript; charset=utf-8",
                client_script(),
            )),
            "/__ferrite/build" => self.build_manifest_response(),
            "/__ferrite/routes" => self.routes_response(),
            _ if path.starts_with(&self.config.client_public_path) => {
                Ok(self.static_asset_response(path))
            }
            _ => match route_response_mode(raw_path) {
                Ok(mode) => Ok(self.route_response(path, mode)),
                Err(message) => Ok(DevResponse::bad_request(message)),
            },
        }
    }

    fn ensure_fresh(&mut self) -> Result<()> {
        let fingerprint = fingerprint_app_dir(&self.config.app_dir)?;
        let changed = self
            .snapshot
            .as_ref()
            .is_none_or(|snapshot| snapshot.fingerprint != fingerprint);

        if changed {
            let routes = scan_app_dir(&self.config.app_dir)?;
            write_route_types(&routes, &self.config.types_out)?;
            self.build_id += 1;
            self.snapshot = Some(RouteSnapshot {
                fingerprint,
                routes,
            });
        }

        Ok(())
    }

    fn build_manifest_response(&self) -> Result<DevResponse> {
        let snapshot = self
            .snapshot
            .as_ref()
            .expect("snapshot built before response");
        let body = serde_json::to_string_pretty(&BuildManifest {
            build_id: self.build_id,
            routes: &snapshot.routes,
        })?;
        Ok(DevResponse::ok("application/json; charset=utf-8", body))
    }

    fn routes_response(&self) -> Result<DevResponse> {
        let snapshot = self
            .snapshot
            .as_ref()
            .expect("snapshot built before response");
        let body = serde_json::to_string_pretty(&RoutesManifest {
            routes: &snapshot.routes,
        })?;
        Ok(DevResponse::ok("application/json; charset=utf-8", body))
    }

    fn route_response(&self, path: &str, mode: RouteResponseMode) -> DevResponse {
        let snapshot = self
            .snapshot
            .as_ref()
            .expect("snapshot built before response");

        if let Some(match_result) = match_route(path, &snapshot.routes) {
            let renderer = PageRenderer::new(
                self.config.project.clone(),
                self.config.page_renderer.clone(),
            );
            let conventions = route_conventions(&match_result.route);
            match mode {
                RouteResponseMode::Html => {
                    self.route_stream_response(path, &match_result, &renderer, &conventions)
                }
                RouteResponseMode::ServerPayloadJson => self.route_server_payload_response(
                    path,
                    &match_result,
                    &renderer,
                    &conventions,
                    ServerPayloadResponseKind::Json,
                ),
                RouteResponseMode::ServerPayloadStream => self.route_server_payload_response(
                    path,
                    &match_result,
                    &renderer,
                    &conventions,
                    ServerPayloadResponseKind::Stream,
                ),
            }
        } else {
            DevResponse::not_found(render_not_found(self.build_id, path, &snapshot.routes))
        }
    }

    fn route_stream_response(
        &self,
        path: &str,
        match_result: &RouteMatch,
        renderer: &PageRenderer,
        conventions: &RouteConventions,
    ) -> DevResponse {
        match find_document_file(&self.config.app_dir) {
            Some(document_file) => match renderer.collect_metadata(
                &match_result.route.file,
                &match_result.route.layouts,
                &match_result.params,
            ) {
                Ok(metadata) => {
                    let bundler = ClientBundler::new(
                        self.config.project.clone(),
                        self.config.client_bundler.clone(),
                    );
                    match bundler.bundle_route(
                        &match_result.route.file,
                        &match_result.route.layouts,
                        &match_result.route.path,
                        &match_result.params,
                        &self.config.client_out_dir,
                        &self.config.client_public_path,
                    ) {
                        Ok(client_bundle) => match renderer
                            .render_document_to_stream_parts_with_conventions(
                                &match_result.route.file,
                                &match_result.route.layouts,
                                &document_file,
                                &match_result.params,
                                &DocumentRenderOptions {
                                    root_id: "ferrite-dev-root".to_owned(),
                                    route_path: path.to_owned(),
                                    route_pattern: Some(match_result.route.path.clone()),
                                    build_id: Some(self.build_id),
                                    metadata: metadata.clone(),
                                    styles: client_bundle_styles(&client_bundle),
                                    scripts: dev_document_scripts(&client_bundle),
                                    default_title: "Ferrite Dev".to_owned(),
                                },
                                conventions,
                            ) {
                            Ok(parts) => DevResponse::streaming_html(
                                parts.shell,
                                parts.chunks.into_iter().map(|chunk| chunk.html).collect(),
                            ),
                            Err(error) => DevResponse::internal_error(render_render_error(
                                self.build_id,
                                path,
                                match_result,
                                &error,
                            )),
                        },
                        Err(error) => DevResponse::internal_error(render_bundle_error(
                            self.build_id,
                            path,
                            match_result,
                            &error,
                        )),
                    }
                }
                Err(error) => DevResponse::internal_error(render_render_error(
                    self.build_id,
                    path,
                    match_result,
                    &error,
                )),
            },
            None => match renderer.render_page_to_stream_parts_with_conventions(
                &match_result.route.file,
                &match_result.route.layouts,
                &match_result.params,
                conventions,
            ) {
                Ok(parts) => match renderer.collect_metadata(
                    &match_result.route.file,
                    &match_result.route.layouts,
                    &match_result.params,
                ) {
                    Ok(metadata) => {
                        let bundler = ClientBundler::new(
                            self.config.project.clone(),
                            self.config.client_bundler.clone(),
                        );
                        match bundler.bundle_route(
                            &match_result.route.file,
                            &match_result.route.layouts,
                            &match_result.route.path,
                            &match_result.params,
                            &self.config.client_out_dir,
                            &self.config.client_public_path,
                        ) {
                            Ok(client_bundle) => {
                                let shell = render_route_document(
                                    self.build_id,
                                    path,
                                    match_result,
                                    &parts.shell,
                                    &client_bundle,
                                    &metadata,
                                );
                                DevResponse::streaming_html(
                                    shell,
                                    parts.chunks.into_iter().map(|chunk| chunk.html).collect(),
                                )
                            }
                            Err(error) => DevResponse::internal_error(render_bundle_error(
                                self.build_id,
                                path,
                                match_result,
                                &error,
                            )),
                        }
                    }
                    Err(error) => DevResponse::internal_error(render_render_error(
                        self.build_id,
                        path,
                        match_result,
                        &error,
                    )),
                },
                Err(error) => DevResponse::internal_error(render_render_error(
                    self.build_id,
                    path,
                    match_result,
                    &error,
                )),
            },
        }
    }

    fn route_server_payload_response(
        &self,
        path: &str,
        match_result: &RouteMatch,
        renderer: &PageRenderer,
        conventions: &RouteConventions,
        response_kind: ServerPayloadResponseKind,
    ) -> DevResponse {
        match find_document_file(&self.config.app_dir) {
            Some(document_file) => match renderer.collect_metadata(
                &match_result.route.file,
                &match_result.route.layouts,
                &match_result.params,
            ) {
                Ok(metadata) => {
                    let bundler = ClientBundler::new(
                        self.config.project.clone(),
                        self.config.client_bundler.clone(),
                    );
                    match bundler.bundle_route(
                        &match_result.route.file,
                        &match_result.route.layouts,
                        &match_result.route.path,
                        &match_result.params,
                        &self.config.client_out_dir,
                        &self.config.client_public_path,
                    ) {
                        Ok(client_bundle) => match renderer
                            .render_document_to_server_payload_json_with_conventions(
                                &match_result.route.file,
                                &match_result.route.layouts,
                                &document_file,
                                &match_result.params,
                                &DocumentRenderOptions {
                                    root_id: "ferrite-dev-root".to_owned(),
                                    route_path: path.to_owned(),
                                    route_pattern: Some(match_result.route.path.clone()),
                                    build_id: Some(self.build_id),
                                    metadata: metadata.clone(),
                                    styles: client_bundle_styles(&client_bundle),
                                    scripts: dev_document_scripts(&client_bundle),
                                    default_title: "Ferrite Dev".to_owned(),
                                },
                                conventions,
                            ) {
                            Ok(payload) => server_payload_response(payload, response_kind),
                            Err(error) => DevResponse::internal_error(render_render_error(
                                self.build_id,
                                path,
                                match_result,
                                &error,
                            )),
                        },
                        Err(error) => DevResponse::internal_error(render_bundle_error(
                            self.build_id,
                            path,
                            match_result,
                            &error,
                        )),
                    }
                }
                Err(error) => DevResponse::internal_error(render_render_error(
                    self.build_id,
                    path,
                    match_result,
                    &error,
                )),
            },
            None => match renderer.render_page_to_server_payload_json_with_conventions(
                &match_result.route.file,
                &match_result.route.layouts,
                &match_result.params,
                conventions,
            ) {
                Ok(payload) => server_payload_response(payload, response_kind),
                Err(error) => DevResponse::internal_error(render_render_error(
                    self.build_id,
                    path,
                    match_result,
                    &error,
                )),
            },
        }
    }

    fn static_asset_response(&self, path: &str) -> DevResponse {
        static_asset_response(
            path,
            &self.config.client_public_path,
            &self.config.client_out_dir,
        )
    }
}

#[derive(Debug)]
pub struct ProductionProject {
    config: ProductionServerConfig,
    snapshot: Option<ProductionRouteSnapshot>,
}

impl ProductionProject {
    pub fn new(config: ProductionServerConfig) -> Self {
        Self {
            config,
            snapshot: None,
        }
    }

    pub fn config(&self) -> &ProductionServerConfig {
        &self.config
    }

    pub fn routes(&mut self) -> Result<&[Route]> {
        self.ensure_ready()?;
        Ok(&self.snapshot.as_ref().expect("snapshot just built").routes)
    }

    pub fn handle_get(&mut self, raw_path: &str) -> Result<DevResponse> {
        if !raw_path.starts_with('/') {
            return Err(DevServerError::InvalidRequestPath(raw_path.to_owned()));
        }

        self.ensure_ready()?;
        let path = strip_query(raw_path);

        if path.starts_with(&self.config.client_public_path) {
            return Ok(static_asset_response(
                path,
                &self.config.client_public_path,
                &self.config.client_out_dir,
            )
            .with_cache_control(static_asset_cache_control(path)));
        }

        match route_response_mode(raw_path) {
            Ok(mode) => Ok(self.route_response(path, mode)),
            Err(message) => Ok(DevResponse::bad_request(message)),
        }
    }

    fn ensure_ready(&mut self) -> Result<()> {
        if self.snapshot.is_some() {
            return Ok(());
        }

        let routes = scan_app_dir(&self.config.app_dir)?;
        write_route_types(&routes, &self.config.types_out)?;
        if self.config.client_out_dir.exists() {
            fs::remove_dir_all(&self.config.client_out_dir)?;
        }
        let document_file = find_document_file(&self.config.app_dir);
        self.snapshot = Some(ProductionRouteSnapshot {
            routes,
            document_file,
        });
        Ok(())
    }

    fn route_response(&self, path: &str, mode: RouteResponseMode) -> DevResponse {
        let snapshot = self
            .snapshot
            .as_ref()
            .expect("snapshot built before response");

        if let Some(match_result) = match_route(path, &snapshot.routes) {
            let renderer = PageRenderer::new(
                self.config.project.clone(),
                self.config.page_renderer.clone(),
            );
            let conventions = route_conventions(&match_result.route);
            match mode {
                RouteResponseMode::Html => self.route_stream_response(
                    path,
                    &match_result,
                    &renderer,
                    snapshot.document_file.as_deref(),
                    &conventions,
                ),
                RouteResponseMode::ServerPayloadJson => self.route_server_payload_response(
                    path,
                    &match_result,
                    &renderer,
                    snapshot.document_file.as_deref(),
                    &conventions,
                    ServerPayloadResponseKind::Json,
                ),
                RouteResponseMode::ServerPayloadStream => self.route_server_payload_response(
                    path,
                    &match_result,
                    &renderer,
                    snapshot.document_file.as_deref(),
                    &conventions,
                    ServerPayloadResponseKind::Stream,
                ),
            }
            .with_cache_control("no-store")
            .with_route_pattern(match_result.route.path)
        } else {
            DevResponse::not_found(render_production_not_found(path, &snapshot.routes))
                .with_cache_control("no-store")
        }
    }

    fn route_stream_response(
        &self,
        path: &str,
        match_result: &RouteMatch,
        renderer: &PageRenderer,
        document_file: Option<&Path>,
        conventions: &RouteConventions,
    ) -> DevResponse {
        match document_file {
            Some(document_file) => {
                match renderer.collect_metadata(
                    &match_result.route.file,
                    &match_result.route.layouts,
                    &match_result.params,
                ) {
                    Ok(metadata) => {
                        let bundler = ClientBundler::new(
                            self.config.project.clone(),
                            self.config.client_bundler.clone(),
                        );
                        match production_client_bundle(
                            &bundler,
                            &match_result.route.file,
                            &match_result.route.layouts,
                            &match_result.route.path,
                            &match_result.params,
                            &self.config.client_out_dir,
                            &self.config.client_public_path,
                        ) {
                            Ok(client_bundle) => match renderer
                                .render_document_to_stream_parts_with_conventions(
                                    &match_result.route.file,
                                    &match_result.route.layouts,
                                    document_file,
                                    &match_result.params,
                                    &DocumentRenderOptions {
                                        root_id: "ferrite-root".to_owned(),
                                        route_path: path.to_owned(),
                                        route_pattern: Some(match_result.route.path.clone()),
                                        build_id: None,
                                        metadata: metadata.clone(),
                                        styles: client_bundle_styles(&client_bundle),
                                        scripts: client_bundle_scripts(&client_bundle),
                                        default_title: "Ferrite".to_owned(),
                                    },
                                    conventions,
                                ) {
                                Ok(parts) => DevResponse::streaming_html(
                                    parts.shell,
                                    parts.chunks.into_iter().map(|chunk| chunk.html).collect(),
                                ),
                                Err(error) => DevResponse::internal_error(
                                    render_production_render_error(path, match_result, &error),
                                ),
                            },
                            Err(error) => DevResponse::internal_error(
                                render_production_bundle_error(path, match_result, &error),
                            ),
                        }
                    }
                    Err(error) => DevResponse::internal_error(render_production_render_error(
                        path,
                        match_result,
                        &error,
                    )),
                }
            }
            None => match renderer.render_page_to_stream_parts_with_conventions(
                &match_result.route.file,
                &match_result.route.layouts,
                &match_result.params,
                conventions,
            ) {
                Ok(parts) => match renderer.collect_metadata(
                    &match_result.route.file,
                    &match_result.route.layouts,
                    &match_result.params,
                ) {
                    Ok(metadata) => {
                        let bundler = ClientBundler::new(
                            self.config.project.clone(),
                            self.config.client_bundler.clone(),
                        );
                        match production_client_bundle(
                            &bundler,
                            &match_result.route.file,
                            &match_result.route.layouts,
                            &match_result.route.path,
                            &match_result.params,
                            &self.config.client_out_dir,
                            &self.config.client_public_path,
                        ) {
                            Ok(client_bundle) => {
                                let shell = render_production_route_document(
                                    path,
                                    match_result,
                                    &parts.shell,
                                    &client_bundle,
                                    &metadata,
                                );
                                DevResponse::streaming_html(
                                    shell,
                                    parts.chunks.into_iter().map(|chunk| chunk.html).collect(),
                                )
                            }
                            Err(error) => DevResponse::internal_error(
                                render_production_bundle_error(path, match_result, &error),
                            ),
                        }
                    }
                    Err(error) => DevResponse::internal_error(render_production_render_error(
                        path,
                        match_result,
                        &error,
                    )),
                },
                Err(error) => DevResponse::internal_error(render_production_render_error(
                    path,
                    match_result,
                    &error,
                )),
            },
        }
    }

    fn route_server_payload_response(
        &self,
        path: &str,
        match_result: &RouteMatch,
        renderer: &PageRenderer,
        document_file: Option<&Path>,
        conventions: &RouteConventions,
        response_kind: ServerPayloadResponseKind,
    ) -> DevResponse {
        match document_file {
            Some(document_file) => {
                match renderer.collect_metadata(
                    &match_result.route.file,
                    &match_result.route.layouts,
                    &match_result.params,
                ) {
                    Ok(metadata) => {
                        let bundler = ClientBundler::new(
                            self.config.project.clone(),
                            self.config.client_bundler.clone(),
                        );
                        match production_client_bundle(
                            &bundler,
                            &match_result.route.file,
                            &match_result.route.layouts,
                            &match_result.route.path,
                            &match_result.params,
                            &self.config.client_out_dir,
                            &self.config.client_public_path,
                        ) {
                            Ok(client_bundle) => match renderer
                                .render_document_to_server_payload_json_with_conventions(
                                    &match_result.route.file,
                                    &match_result.route.layouts,
                                    document_file,
                                    &match_result.params,
                                    &DocumentRenderOptions {
                                        root_id: "ferrite-root".to_owned(),
                                        route_path: path.to_owned(),
                                        route_pattern: Some(match_result.route.path.clone()),
                                        build_id: None,
                                        metadata: metadata.clone(),
                                        styles: client_bundle_styles(&client_bundle),
                                        scripts: client_bundle_scripts(&client_bundle),
                                        default_title: "Ferrite".to_owned(),
                                    },
                                    conventions,
                                ) {
                                Ok(payload) => server_payload_response(payload, response_kind),
                                Err(error) => DevResponse::internal_error(
                                    render_production_render_error(path, match_result, &error),
                                ),
                            },
                            Err(error) => DevResponse::internal_error(
                                render_production_bundle_error(path, match_result, &error),
                            ),
                        }
                    }
                    Err(error) => DevResponse::internal_error(render_production_render_error(
                        path,
                        match_result,
                        &error,
                    )),
                }
            }
            None => match renderer.render_page_to_server_payload_json_with_conventions(
                &match_result.route.file,
                &match_result.route.layouts,
                &match_result.params,
                conventions,
            ) {
                Ok(payload) => server_payload_response(payload, response_kind),
                Err(error) => DevResponse::internal_error(render_production_render_error(
                    path,
                    match_result,
                    &error,
                )),
            },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DevResponse {
    pub status: u16,
    pub reason: &'static str,
    pub content_type: &'static str,
    pub body: Vec<u8>,
    pub stream: Option<DevStreamBody>,
    pub cache_control: Option<&'static str>,
    pub route_pattern_header: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DevStreamBody {
    pub shell: Vec<u8>,
    pub chunks: Vec<Vec<u8>>,
}

impl DevResponse {
    pub fn ok(content_type: &'static str, body: impl Into<Vec<u8>>) -> Self {
        Self {
            status: 200,
            reason: "OK",
            content_type,
            body: body.into(),
            stream: None,
            cache_control: None,
            route_pattern_header: None,
        }
    }

    pub fn streaming_html(shell: String, chunks: Vec<String>) -> Self {
        let chunk_bytes = chunks
            .into_iter()
            .map(String::into_bytes)
            .collect::<Vec<_>>();
        if chunk_bytes.is_empty() {
            return Self::ok("text/html; charset=utf-8", shell);
        }

        let shell_bytes = shell.into_bytes();
        let mut body = shell_bytes.clone();
        for chunk in &chunk_bytes {
            body.extend_from_slice(chunk);
        }

        Self {
            status: 200,
            reason: "OK",
            content_type: "text/html; charset=utf-8",
            body,
            stream: Some(DevStreamBody {
                shell: shell_bytes,
                chunks: chunk_bytes,
            }),
            cache_control: None,
            route_pattern_header: None,
        }
    }

    pub fn server_payload_json(body: String) -> Self {
        Self::ok(SERVER_PAYLOAD_CONTENT_TYPE, body)
    }

    pub fn server_payload_stream(shell: String, chunks: Vec<String>) -> Self {
        let shell_bytes = shell.into_bytes();
        let chunk_bytes = chunks
            .into_iter()
            .map(String::into_bytes)
            .collect::<Vec<_>>();
        let mut body = shell_bytes.clone();
        for chunk in &chunk_bytes {
            body.extend_from_slice(chunk);
        }

        Self {
            status: 200,
            reason: "OK",
            content_type: SERVER_PAYLOAD_STREAM_CONTENT_TYPE,
            body,
            stream: Some(DevStreamBody {
                shell: shell_bytes,
                chunks: chunk_bytes,
            }),
            cache_control: None,
            route_pattern_header: None,
        }
    }

    pub fn not_found(body: String) -> Self {
        Self {
            status: 404,
            reason: "Not Found",
            content_type: "text/html; charset=utf-8",
            body: body.into_bytes(),
            stream: None,
            cache_control: None,
            route_pattern_header: None,
        }
    }

    pub fn method_not_allowed() -> Self {
        Self {
            status: 405,
            reason: "Method Not Allowed",
            content_type: "text/plain; charset=utf-8",
            body: b"Method Not Allowed\n".to_vec(),
            stream: None,
            cache_control: None,
            route_pattern_header: None,
        }
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: 400,
            reason: "Bad Request",
            content_type: "text/plain; charset=utf-8",
            body: format!("Bad Request: {}\n", message.into()).into_bytes(),
            stream: None,
            cache_control: None,
            route_pattern_header: None,
        }
    }

    pub fn internal_error(body: String) -> Self {
        Self {
            status: 500,
            reason: "Internal Server Error",
            content_type: "text/html; charset=utf-8",
            body: body.into_bytes(),
            stream: None,
            cache_control: None,
            route_pattern_header: None,
        }
    }

    pub fn with_cache_control(mut self, value: &'static str) -> Self {
        self.cache_control = Some(value);
        self
    }

    pub fn with_route_pattern(mut self, value: impl Into<String>) -> Self {
        self.route_pattern_header = Some(value.into());
        self
    }

    pub fn body_text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RouteMatch {
    pub route: Route,
    pub params: Vec<(String, Value)>,
}

#[derive(Debug)]
struct RouteSnapshot {
    fingerprint: String,
    routes: Vec<Route>,
}

#[derive(Debug)]
struct ProductionRouteSnapshot {
    routes: Vec<Route>,
    document_file: Option<PathBuf>,
}

#[derive(Debug, Copy, Clone, PartialEq, Eq)]
enum RouteResponseMode {
    Html,
    ServerPayloadJson,
    ServerPayloadStream,
}

#[derive(Debug, Copy, Clone, PartialEq, Eq)]
enum ServerPayloadResponseKind {
    Json,
    Stream,
}

#[derive(Debug, Serialize)]
struct BuildManifest<'a> {
    build_id: u64,
    routes: &'a [Route],
}

#[derive(Debug, Serialize)]
struct RoutesManifest<'a> {
    routes: &'a [Route],
}

fn route_conventions(route: &Route) -> RouteConventions {
    RouteConventions {
        loading: route.loading.clone(),
        error: route.error.clone(),
    }
}

fn production_client_bundle(
    bundler: &ClientBundler,
    page_file: &Path,
    layouts: &[PathBuf],
    route_path: &str,
    params: &[(String, Value)],
    client_out_dir: &Path,
    client_public_path: &str,
) -> std::result::Result<ClientBundle, ClientBundleError> {
    let mut client_bundle = bundler.bundle_route(
        page_file,
        layouts,
        route_path,
        params,
        client_out_dir,
        client_public_path,
    )?;
    fingerprint_client_bundle(&mut client_bundle, client_out_dir, client_public_path)?;
    Ok(client_bundle)
}

fn dev_document_scripts(client_bundle: &ClientBundle) -> Vec<String> {
    let mut scripts = BTreeSet::new();
    scripts.insert("/__ferrite/client.js".to_owned());
    scripts.extend(client_bundle.script.iter().cloned());
    for reference in &client_bundle.client_references {
        scripts.extend(reference.script.iter().cloned());
    }
    scripts.into_iter().collect()
}

fn client_bundle_scripts(client_bundle: &ClientBundle) -> Vec<String> {
    let mut scripts = BTreeSet::new();
    scripts.extend(client_bundle.script.iter().cloned());
    for reference in &client_bundle.client_references {
        scripts.extend(reference.script.iter().cloned());
    }
    scripts.into_iter().collect()
}

fn client_bundle_styles(client_bundle: &ClientBundle) -> Vec<String> {
    let mut styles = BTreeSet::new();
    styles.extend(client_bundle.styles.iter().cloned());
    for reference in &client_bundle.client_references {
        styles.extend(reference.styles.iter().cloned());
    }
    styles.into_iter().collect()
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

fn server_payload_response(payload: String, kind: ServerPayloadResponseKind) -> DevResponse {
    match kind {
        ServerPayloadResponseKind::Json => DevResponse::server_payload_json(payload),
        ServerPayloadResponseKind::Stream => match server_payload_stream_frames(&payload) {
            Ok((shell, chunks)) => DevResponse::server_payload_stream(shell, chunks),
            Err(error) => DevResponse::internal_error(format!(
                "<!doctype html><title>Ferrite Payload Error</title><pre>{}</pre>",
                escape_html(&error.to_string())
            )),
        },
    }
}

fn server_payload_stream_frames(payload: &str) -> Result<(String, Vec<String>)> {
    let mut value: Value = serde_json::from_str(payload)?;
    let object = value.as_object_mut().ok_or_else(|| {
        DevServerError::Json(serde_json::Error::io(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "server payload must be a JSON object",
        )))
    })?;

    let shell = object.remove("shell").ok_or_else(|| {
        DevServerError::Json(serde_json::Error::io(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "server payload stream requires shell",
        )))
    })?;
    let client_references = object
        .remove("clientReferences")
        .unwrap_or_else(|| Value::Array(Vec::new()));
    let chunks = object
        .remove("chunks")
        .unwrap_or_else(|| Value::Array(Vec::new()));
    let chunks = chunks.as_array().ok_or_else(|| {
        DevServerError::Json(serde_json::Error::io(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "server payload chunks must be an array",
        )))
    })?;

    let shell_frame = json!({
        "ferrite": SERVER_PAYLOAD_STREAM_FRAME_MARKER,
        "version": SERVER_PAYLOAD_STREAM_FRAME_VERSION,
        "kind": "shell",
        "shell": shell,
        "clientReferences": client_references,
    });
    let shell_frame = format!("{}\n", serde_json::to_string(&shell_frame)?);
    let chunk_frames = chunks
        .iter()
        .map(|chunk| {
            let frame = json!({
                "ferrite": SERVER_PAYLOAD_STREAM_FRAME_MARKER,
                "version": SERVER_PAYLOAD_STREAM_FRAME_VERSION,
                "kind": "chunk",
                "chunk": chunk,
            });
            serde_json::to_string(&frame).map(|line| format!("{line}\n"))
        })
        .collect::<std::result::Result<Vec<_>, _>>()?;

    Ok((shell_frame, chunk_frames))
}

pub fn serve<A: ToSocketAddrs>(addr: A, mut project: DevProject) -> Result<()> {
    let mut addrs = addr.to_socket_addrs()?;
    let addr = addrs.next().ok_or(DevServerError::NoSocketAddress)?;
    let listener = TcpListener::bind(addr)?;
    serve_listener(listener, &mut project)
}

pub fn serve_production<A: ToSocketAddrs>(addr: A, mut project: ProductionProject) -> Result<()> {
    let mut addrs = addr.to_socket_addrs()?;
    let addr = addrs.next().ok_or(DevServerError::NoSocketAddress)?;
    let listener = TcpListener::bind(addr)?;
    serve_production_listener(listener, &mut project)
}

pub fn serve_listener(listener: TcpListener, project: &mut DevProject) -> Result<()> {
    for stream in listener.incoming() {
        let mut stream = stream?;
        handle_stream(&mut stream, project)?;
    }

    Ok(())
}

pub fn serve_listener_once(listener: TcpListener, project: &mut DevProject) -> Result<()> {
    let (mut stream, _addr) = listener.accept()?;
    handle_stream(&mut stream, project)
}

pub fn serve_production_listener(
    listener: TcpListener,
    project: &mut ProductionProject,
) -> Result<()> {
    for stream in listener.incoming() {
        let mut stream = stream?;
        handle_production_stream(&mut stream, project)?;
    }

    Ok(())
}

pub fn serve_production_listener_once(
    listener: TcpListener,
    project: &mut ProductionProject,
) -> Result<()> {
    let (mut stream, _addr) = listener.accept()?;
    handle_production_stream(&mut stream, project)
}

fn handle_stream(stream: &mut TcpStream, project: &mut DevProject) -> Result<()> {
    let mut buffer = [0_u8; 8192];
    let bytes = stream.read(&mut buffer)?;
    let request = String::from_utf8_lossy(&buffer[..bytes]);
    let response = match parse_request_line(&request) {
        Some(("GET", path)) => project.handle_get(path)?,
        Some((_method, _path)) => DevResponse::method_not_allowed(),
        None => DevResponse::bad_request("invalid HTTP request line"),
    };

    write_response(stream, &response)?;
    Ok(())
}

fn handle_production_stream(stream: &mut TcpStream, project: &mut ProductionProject) -> Result<()> {
    let mut buffer = [0_u8; 8192];
    let bytes = stream.read(&mut buffer)?;
    let request = String::from_utf8_lossy(&buffer[..bytes]);
    let write_options = ResponseWriteOptions {
        gzip: client_accepts_gzip(&request),
    };
    let response = match parse_request_line(&request) {
        Some(("GET", path)) => project.handle_get(path)?,
        Some((_method, _path)) => DevResponse::method_not_allowed(),
        None => DevResponse::bad_request("invalid HTTP request line"),
    };

    write_response_with_options(stream, &response, write_options)?;
    Ok(())
}

fn write_response(stream: &mut TcpStream, response: &DevResponse) -> Result<()> {
    write_response_with_options(stream, response, ResponseWriteOptions::default())
}

#[derive(Debug, Default, Copy, Clone)]
struct ResponseWriteOptions {
    gzip: bool,
}

fn write_response_with_options(
    stream: &mut TcpStream,
    response: &DevResponse,
    options: ResponseWriteOptions,
) -> Result<()> {
    let should_gzip = options.gzip && is_gzip_eligible(response);

    if let Some(body_stream) = response.stream.as_ref() {
        write!(
            stream,
            "HTTP/1.1 {} {}\r\nContent-Type: {}\r\n",
            response.status, response.reason, response.content_type
        )?;
        write_response_compression_headers(stream, should_gzip)?;
        write_response_metadata_headers(stream, response)?;
        stream.write_all(b"Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n")?;
        if should_gzip {
            let compressed = gzip_stream_body(body_stream)?;
            for chunk in &compressed {
                write_chunk(stream, chunk)?;
            }
        } else {
            write_chunk(stream, &body_stream.shell)?;
            for chunk in &body_stream.chunks {
                write_chunk(stream, chunk)?;
            }
        }
        stream.write_all(b"0\r\n\r\n")?;
        return Ok(());
    }

    let compressed_body;
    let bytes = if should_gzip {
        compressed_body = gzip_bytes(&response.body)?;
        &compressed_body
    } else {
        &response.body
    };
    write!(
        stream,
        "HTTP/1.1 {} {}\r\nContent-Type: {}\r\n",
        response.status, response.reason, response.content_type,
    )?;
    write_response_compression_headers(stream, should_gzip)?;
    write_response_metadata_headers(stream, response)?;
    write!(
        stream,
        "Content-Length: {}\r\nConnection: close\r\n\r\n",
        bytes.len()
    )?;
    stream.write_all(bytes)?;
    Ok(())
}

fn write_response_compression_headers(stream: &mut TcpStream, gzip: bool) -> Result<()> {
    if gzip {
        stream.write_all(b"Content-Encoding: gzip\r\nVary: Accept-Encoding\r\n")?;
    }
    Ok(())
}

fn is_gzip_eligible(response: &DevResponse) -> bool {
    if response.status != 200 {
        return false;
    }

    let has_body = response
        .stream
        .as_ref()
        .map_or(!response.body.is_empty(), |stream| {
            !stream.shell.is_empty() || stream.chunks.iter().any(|chunk| !chunk.is_empty())
        });
    if !has_body {
        return false;
    }

    let content_type = response
        .content_type
        .split_once(';')
        .map_or(response.content_type, |(mime, _params)| mime)
        .trim();
    matches!(
        content_type,
        "text/html"
            | "application/json"
            | "application/vnd.ferrite.server-payload+json"
            | "application/vnd.ferrite.server-payload-stream+jsonl"
    )
}

fn gzip_bytes(bytes: &[u8]) -> Result<Vec<u8>> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(bytes)?;
    Ok(encoder.finish()?)
}

fn gzip_stream_body(body: &DevStreamBody) -> Result<Vec<Vec<u8>>> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    let mut offset = 0;
    let mut chunks = Vec::new();

    write_gzip_stream_part(&mut encoder, &mut offset, &mut chunks, &body.shell)?;
    for chunk in &body.chunks {
        write_gzip_stream_part(&mut encoder, &mut offset, &mut chunks, chunk)?;
    }

    let compressed = encoder.finish()?;
    if compressed.len() > offset {
        chunks.push(compressed[offset..].to_vec());
    }

    Ok(chunks)
}

fn write_gzip_stream_part(
    encoder: &mut GzEncoder<Vec<u8>>,
    offset: &mut usize,
    chunks: &mut Vec<Vec<u8>>,
    bytes: &[u8],
) -> Result<()> {
    if bytes.is_empty() {
        return Ok(());
    }

    encoder.write_all(bytes)?;
    encoder.flush()?;
    let compressed = encoder.get_ref();
    if compressed.len() > *offset {
        chunks.push(compressed[*offset..].to_vec());
        *offset = compressed.len();
    }
    Ok(())
}

fn client_accepts_gzip(request: &str) -> bool {
    request
        .lines()
        .skip(1)
        .take_while(|line| !line.trim().is_empty())
        .filter_map(|line| line.split_once(':'))
        .filter(|(name, _value)| name.trim().eq_ignore_ascii_case("accept-encoding"))
        .any(|(_name, value)| accept_encoding_value_allows_gzip(value))
}

fn accept_encoding_value_allows_gzip(value: &str) -> bool {
    let mut gzip_quality = None;
    let mut wildcard_quality = None;

    for item in value.split(',') {
        let mut parts = item.split(';');
        let token = parts.next().unwrap_or("").trim();
        if token.is_empty() {
            continue;
        }

        let mut quality = 1.0_f32;
        for parameter in parts {
            let Some((name, value)) = parameter.trim().split_once('=') else {
                continue;
            };
            if name.trim().eq_ignore_ascii_case("q") {
                quality = value.trim().parse::<f32>().unwrap_or(0.0);
            }
        }

        if token.eq_ignore_ascii_case("gzip") {
            gzip_quality = Some(quality);
        } else if token == "*" {
            wildcard_quality = Some(quality);
        }
    }

    gzip_quality
        .or(wildcard_quality)
        .is_some_and(|quality| quality > 0.0)
}

fn write_response_metadata_headers(stream: &mut TcpStream, response: &DevResponse) -> Result<()> {
    if let Some(cache_control) = response.cache_control {
        write!(stream, "Cache-Control: {cache_control}\r\n")?;
    }

    if let Some(route_pattern) = response.route_pattern_header.as_deref() {
        write!(
            stream,
            "X-Ferrite-Route-Pattern: {}\r\n",
            sanitize_header_value(route_pattern)
        )?;
    }

    Ok(())
}

fn sanitize_header_value(value: &str) -> String {
    value.replace(['\r', '\n'], " ")
}

fn write_chunk(stream: &mut TcpStream, bytes: &[u8]) -> Result<()> {
    if bytes.is_empty() {
        return Ok(());
    }

    write!(stream, "{:X}\r\n", bytes.len())?;
    stream.write_all(bytes)?;
    stream.write_all(b"\r\n")?;
    Ok(())
}

fn parse_request_line(request: &str) -> Option<(&str, &str)> {
    let line = request.lines().next()?;
    let mut parts = line.split_whitespace();
    let method = parts.next()?;
    let path = parts.next()?;
    let version = parts.next()?;
    if !version.starts_with("HTTP/") {
        return None;
    }
    Some((method, path))
}

fn strip_query(path: &str) -> &str {
    path.split_once('?').map_or(path, |(path, _query)| path)
}

fn route_response_mode(raw_path: &str) -> std::result::Result<RouteResponseMode, String> {
    let Some((_, query)) = raw_path.split_once('?') else {
        return Ok(RouteResponseMode::Html);
    };

    let mut mode = RouteResponseMode::Html;
    for pair in query.split('&').filter(|pair| !pair.is_empty()) {
        let (name, value) = pair
            .split_once('=')
            .map_or((pair, ""), |(name, value)| (name, value));
        if name != SERVER_PAYLOAD_QUERY_NAME {
            continue;
        }
        match value {
            SERVER_PAYLOAD_QUERY_VALUE => {
                mode = RouteResponseMode::ServerPayloadJson;
            }
            SERVER_PAYLOAD_STREAM_QUERY_VALUE => {
                mode = RouteResponseMode::ServerPayloadStream;
            }
            _ => {
                return Err(format!(
                    "unsupported {SERVER_PAYLOAD_QUERY_NAME} value `{value}`; expected `{SERVER_PAYLOAD_QUERY_VALUE}` or `{SERVER_PAYLOAD_STREAM_QUERY_VALUE}`"
                ));
            }
        }
    }

    Ok(mode)
}

fn match_route(path: &str, routes: &[Route]) -> Option<RouteMatch> {
    routes.iter().find_map(|route| {
        match_single_route(path, route).map(|params| RouteMatch {
            route: route.clone(),
            params,
        })
    })
}

fn match_single_route(path: &str, route: &Route) -> Option<Vec<(String, Value)>> {
    if path == route.path {
        return Some(Vec::new());
    }

    let path_segments = split_route(path);
    let pattern_segments = split_route(&route.path);
    let mut params = Vec::new();
    let mut path_index = 0;
    let mut pattern_index = 0;

    while pattern_index < pattern_segments.len() {
        let pattern = pattern_segments[pattern_index];

        if let Some(name) = pattern.strip_prefix('*') {
            let optional = name.ends_with('?');
            let name = name.trim_end_matches('?');
            if path_index >= path_segments.len() && !optional {
                return None;
            }
            if path_index < path_segments.len() {
                params.push((
                    name.to_owned(),
                    json!(
                        path_segments[path_index..]
                            .iter()
                            .map(|segment| (*segment).to_owned())
                            .collect::<Vec<_>>()
                    ),
                ));
            }
            path_index = path_segments.len();
            pattern_index += 1;
            break;
        }

        let actual = path_segments.get(path_index)?;
        if let Some(name) = pattern.strip_prefix(':') {
            params.push((name.to_owned(), json!(*actual)));
        } else if pattern != *actual {
            return None;
        }

        path_index += 1;
        pattern_index += 1;
    }

    if path_index == path_segments.len() && pattern_index == pattern_segments.len() {
        Some(params)
    } else {
        None
    }
}

fn split_route(path: &str) -> Vec<&str> {
    path.trim_matches('/')
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect()
}

fn fingerprint_app_dir(app_dir: &Path) -> Result<String> {
    let mut entries = Vec::new();
    collect_app_files(app_dir, app_dir, &mut entries)?;
    entries.sort();
    Ok(entries.join("\n"))
}

fn collect_app_files(root: &Path, current: &Path, entries: &mut Vec<String>) -> Result<()> {
    for entry in fs::read_dir(current)? {
        let entry = entry?;
        let path = entry.path();
        let file_type = entry.file_type()?;

        if file_type.is_dir() {
            collect_app_files(root, &path, entries)?;
        } else if is_source_file(&path) {
            let metadata = entry.metadata()?;
            let modified = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map_or(0, |duration| duration.as_nanos());
            let relative = path.strip_prefix(root).unwrap_or(&path).display();
            entries.push(format!("{relative}|{}|{modified}", metadata.len()));
        }
    }

    Ok(())
}

fn is_source_file(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|extension| extension.to_str()),
        Some(
            "css"
                | "gif"
                | "jpeg"
                | "jpg"
                | "js"
                | "jsx"
                | "png"
                | "svg"
                | "ts"
                | "tsx"
                | "webp"
                | "woff"
                | "woff2",
        )
    )
}

fn static_asset_response(path: &str, public_path: &str, out_dir: &Path) -> DevResponse {
    let Some(relative) = path.strip_prefix(public_path) else {
        return DevResponse::not_found("not found\n".to_owned());
    };
    let relative = relative.trim_start_matches('/');
    if relative.contains("..") {
        return DevResponse::bad_request("invalid static asset path");
    }

    let file = out_dir.join(relative);
    match fs::read(&file) {
        Ok(body) => DevResponse::ok(content_type_for(&file), body),
        Err(_) => DevResponse::not_found("not found\n".to_owned()),
    }
}

fn static_asset_cache_control(path: &str) -> &'static str {
    if is_immutable_static_asset_path(path) {
        "public, max-age=31536000, immutable"
    } else {
        "public, max-age=0, must-revalidate"
    }
}

fn is_immutable_static_asset_path(path: &str) -> bool {
    let path = Path::new(path);
    let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    let Some((stem, extension)) = file_name.rsplit_once('.') else {
        return false;
    };
    if !matches!(
        extension,
        "css" | "gif" | "jpeg" | "jpg" | "js" | "png" | "svg" | "webp" | "woff" | "woff2"
    ) {
        return false;
    }

    if stem
        .rsplit_once('.')
        .is_some_and(|(_name, hash)| is_hex_hash(hash))
    {
        return true;
    }

    let is_bundled_asset = path
        .parent()
        .and_then(|parent| parent.file_name())
        .and_then(|name| name.to_str())
        == Some("assets");
    is_bundled_asset
        && stem
            .rsplit_once('-')
            .is_some_and(|(_name, hash)| is_esbuild_hash(hash))
}

fn is_hex_hash(value: &str) -> bool {
    value.len() >= 8 && value.chars().all(|char| char.is_ascii_hexdigit())
}

fn is_esbuild_hash(value: &str) -> bool {
    value.len() >= 8
        && value
            .chars()
            .all(|char| char.is_ascii_digit() || char.is_ascii_uppercase())
}

fn content_type_for(path: &Path) -> &'static str {
    match path.extension().and_then(|extension| extension.to_str()) {
        Some("css") => "text/css; charset=utf-8",
        Some("js") => "text/javascript; charset=utf-8",
        Some("json" | "map") => "application/json; charset=utf-8",
        Some("gif") => "image/gif",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        _ => "application/octet-stream",
    }
}

fn render_production_route_document(
    path: &str,
    match_result: &RouteMatch,
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
    let route_pattern = if match_result.route.path == path {
        String::new()
    } else {
        format!(
            r#" data-route-pattern="{}""#,
            escape_html(&match_result.route.path)
        )
    };
    format!(
        r#"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
{metadata_tags}{scripts}
{styles}
</head>
<body>
  <div id="ferrite-root" data-route="{path}"{route_pattern}>{page_html}</div>
</body>
</html>"#,
        metadata_tags = metadata_tags,
        path = escape_html(path),
        route_pattern = route_pattern,
        page_html = page_html,
        styles = styles,
        scripts = render_script_tags(&client_bundle_scripts(client_bundle)),
    )
}

fn render_route_document(
    build_id: u64,
    path: &str,
    match_result: &RouteMatch,
    page_html: &str,
    client_bundle: &ClientBundle,
    metadata: &PageMetadata,
) -> String {
    let metadata_tags = render_metadata_head_tags(metadata, "Ferrite Dev");
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
{metadata_tags}{scripts}
{styles}
</head>
<body>
  <div id="ferrite-dev-root" data-ferrite-build-id="{build_id}" data-route="{path}" data-route-pattern="{pattern}">{page_html}</div>
</body>
</html>"#,
        build_id = build_id,
        metadata_tags = metadata_tags,
        path = escape_html(path),
        pattern = escape_html(&match_result.route.path),
        page_html = page_html,
        styles = styles,
        scripts = render_script_tags(&dev_document_scripts(client_bundle)),
    )
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

fn render_production_render_error(
    path: &str,
    match_result: &RouteMatch,
    error: &PageRenderError,
) -> String {
    format!(
        r#"<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Ferrite - Render Error</title></head>
<body>
  <main id="ferrite-root" data-route="{path}" data-route-pattern="{pattern}">
    <h1>500</h1>
    <p>Ferrite could not render <code>{pattern}</code>.</p>
    <pre>{error}</pre>
  </main>
</body>
</html>"#,
        path = escape_html(path),
        pattern = escape_html(&match_result.route.path),
        error = escape_html(&error.to_string()),
    )
}

fn render_production_bundle_error(
    path: &str,
    match_result: &RouteMatch,
    error: &ClientBundleError,
) -> String {
    format!(
        r#"<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Ferrite - Bundle Error</title></head>
<body>
  <main id="ferrite-root" data-route="{path}" data-route-pattern="{pattern}">
    <h1>500</h1>
    <p>Ferrite could not bundle <code>{pattern}</code>.</p>
    <pre>{error}</pre>
  </main>
</body>
</html>"#,
        path = escape_html(path),
        pattern = escape_html(&match_result.route.path),
        error = escape_html(&error.to_string()),
    )
}

fn render_render_error(
    build_id: u64,
    path: &str,
    match_result: &RouteMatch,
    error: &PageRenderError,
) -> String {
    format!(
        r#"<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Ferrite Dev - Render Error</title></head>
<body>
  <main id="ferrite-dev-root" data-ferrite-build-id="{build_id}" data-route="{path}" data-route-pattern="{pattern}">
    <h1>500</h1>
    <p>Ferrite could not render <code>{pattern}</code>.</p>
    <pre>{error}</pre>
  </main>
</body>
</html>"#,
        build_id = build_id,
        path = escape_html(path),
        pattern = escape_html(&match_result.route.path),
        error = escape_html(&error.to_string()),
    )
}

fn render_bundle_error(
    build_id: u64,
    path: &str,
    match_result: &RouteMatch,
    error: &ClientBundleError,
) -> String {
    format!(
        r#"<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Ferrite Dev - Bundle Error</title></head>
<body>
  <main id="ferrite-dev-root" data-ferrite-build-id="{build_id}" data-route="{path}" data-route-pattern="{pattern}">
    <h1>500</h1>
    <p>Ferrite could not bundle <code>{pattern}</code>.</p>
    <pre>{error}</pre>
  </main>
</body>
</html>"#,
        build_id = build_id,
        path = escape_html(path),
        pattern = escape_html(&match_result.route.path),
        error = escape_html(&error.to_string()),
    )
}

fn render_production_not_found(path: &str, routes: &[Route]) -> String {
    let route_list = routes
        .iter()
        .map(|route| format!("<li><code>{}</code></li>", escape_html(&route.path)))
        .collect::<Vec<_>>()
        .join("");

    format!(
        r#"<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Ferrite - Not Found</title></head>
<body>
  <main id="ferrite-root" data-route="{path}">
    <h1>404</h1>
    <p>No Ferrite route matched <code>{path}</code>.</p>
    <ul>{route_list}</ul>
  </main>
</body>
</html>"#,
        path = escape_html(path),
        route_list = route_list
    )
}

fn render_not_found(build_id: u64, path: &str, routes: &[Route]) -> String {
    let route_list = routes
        .iter()
        .map(|route| format!("<li><code>{}</code></li>", escape_html(&route.path)))
        .collect::<Vec<_>>()
        .join("");

    format!(
        r#"<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Ferrite Dev - Not Found</title></head>
<body>
  <main id="ferrite-dev-root" data-ferrite-build-id="{build_id}" data-route="{path}">
    <h1>404</h1>
    <p>No Ferrite route matched <code>{path}</code>.</p>
    <ul>{route_list}</ul>
  </main>
</body>
</html>"#,
        build_id = build_id,
        path = escape_html(path),
        route_list = route_list
    )
}

fn client_script() -> String {
    r#"const root = document.querySelector("[data-ferrite-build-id]");
let buildId = root?.getAttribute("data-ferrite-build-id");
async function checkBuild() {
  try {
    const response = await fetch("/__ferrite/build", { cache: "no-store" });
    if (!response.ok) return;
    const next = await response.json();
    if (buildId && String(next.build_id) !== String(buildId)) {
      location.reload();
    }
  } catch (_error) {
  }
}
setInterval(checkBuild, 1000);
"#
    .to_owned()
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
    use flate2::read::GzDecoder;
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::thread;

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

    fn project_for(app: &Path) -> DevProject {
        let project = app.parent().unwrap().to_path_buf();
        let renderer = project.join("render-page.mjs");
        make_script(
            &renderer,
            r#"
const mode = process.argv[2];
const metadataMode = mode === "--metadata";
const streamMode = mode === "--stream";
const serverPayloadMode = mode === "--server-payload";
const documentMode = mode === "--document";
const documentStreamMode = mode === "--document-stream";
const documentServerPayloadMode = mode === "--document-server-payload";
const explicitMode = metadataMode || streamMode || serverPayloadMode || documentMode || documentStreamMode || documentServerPayloadMode;
const page = explicitMode ? process.argv[3] : process.argv[2];
const props = JSON.parse(explicitMode ? process.argv[4] : process.argv[3]);
const slug = Array.isArray(props.params.slug) ? props.params.slug.join("/") : "index";
const title = page.includes("[id]") ? `Post ${props.params.id}` : page.includes("docs") ? `Docs ${slug}` : "Home Page";
if (metadataMode) {
  process.stdout.write(JSON.stringify({
    title,
    description: `Metadata for ${title}`,
    openGraph: {
      title: `OG ${title}`,
      siteName: "Ferrite",
      type: "website",
      images: [{ url: "/og.png", alt: "OG", width: 1200, height: 630 }]
    },
    icons: [{ url: "/favicon.svg", type: "image/svg+xml", sizes: "any" }],
    alternates: {
      canonical: `https://example.com${page.includes("[id]") ? `/posts/${props.params.id}` : "/"}`,
      languages: { en: `https://example.com${page.includes("[id]") ? `/posts/${props.params.id}` : "/"}` }
    }
  }));
  process.exit(0);
}
if (streamMode) {
  process.stdout.write(JSON.stringify({
    ferrite: "render-stream",
    version: 1,
    shell: [2, "main", { "data-rendered": title }, [[2, "h1", {}, [[0, title]]]]],
    chunks: []
  }));
  process.exit(0);
}
if (serverPayloadMode) {
  process.stdout.write(JSON.stringify({
    ferrite: "server-payload",
    version: 1,
    shell: [2, "main", { "data-rendered": title }, [[2, "h1", {}, [[0, title]]]]],
    clientReferences: [],
    chunks: []
  }));
  process.exit(0);
}
if (documentMode) {
  const options = JSON.parse(process.argv[7]);
  process.stdout.write(JSON.stringify({
    kind: "element",
    tag: "html",
    props: { "data-document": "dev-test" },
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
          props: { id: options.rootId, "data-route": options.routePath, "data-route-pattern": options.routePattern, "data-ferrite-build-id": options.buildId },
          children: [{ kind: "element", tag: "h1", props: {}, children: [{ kind: "text", value: title }] }]
        }]
      }
    ]
  }));
  process.exit(0);
}
if (documentStreamMode) {
  const options = JSON.parse(process.argv[7]);
  process.stdout.write(JSON.stringify({
    ferrite: "render-stream",
    version: 1,
    shell: [2, "html", { "data-document": "dev-test" }, [
      [2, "head", {}, [[2, "title", {}, [[0, options.metadata.title || options.defaultTitle]]]]],
      [2, "body", {}, [[2, "div", { id: options.rootId, "data-route": options.routePath, "data-route-pattern": options.routePattern, "data-ferrite-build-id": options.buildId }, [[2, "h1", {}, [[0, title]]]]]]]
    ]],
    chunks: []
  }));
  process.exit(0);
}
if (documentServerPayloadMode) {
  const options = JSON.parse(process.argv[7]);
  process.stdout.write(JSON.stringify({
    ferrite: "server-payload",
    version: 1,
    shell: [2, "html", { "data-document": "dev-test" }, [
      [2, "head", {}, [[2, "title", {}, [[0, options.metadata.title || options.defaultTitle]]]]],
      [2, "body", {}, [[2, "div", { id: options.rootId, "data-route": options.routePath, "data-route-pattern": options.routePattern, "data-ferrite-build-id": options.buildId }, [[2, "h1", {}, [[0, title]]]]]]]
    ]],
    clientReferences: [],
    chunks: []
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
        let bundler = project.join("build-client.mjs");
        make_script(
            &bundler,
            r#"
const outDir = process.argv[3];
const route = process.argv[5].replaceAll("/", "-").replace(/^-$/, "index") || "index";
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
        DevProject::new(DevServerConfig::new(
            project.clone(),
            app.to_path_buf(),
            project.join(".ferrite/types/routes.d.ts"),
            renderer,
            bundler,
            project.join(".ferrite/dev/static"),
            "/_ferrite/static".to_owned(),
        ))
    }

    fn production_project_for(app: &Path) -> ProductionProject {
        let dev_project = project_for(app);
        let config = dev_project.config();
        ProductionProject::new(ProductionServerConfig::new(
            config.project.clone(),
            config.app_dir.clone(),
            config.types_out.clone(),
            config.page_renderer.clone(),
            config.client_bundler.clone(),
            config.project.join(".ferrite/server/static"),
            config.client_public_path.clone(),
        ))
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

    fn production_http_request(project: ProductionProject, request: &[u8]) -> Vec<u8> {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();

        let server = thread::spawn(move || {
            let mut project = project;
            serve_production_listener_once(listener, &mut project).unwrap();
        });

        let mut stream = TcpStream::connect(addr).unwrap();
        stream.write_all(request).unwrap();
        let mut response = Vec::new();
        stream.read_to_end(&mut response).unwrap();
        server.join().unwrap();
        response
    }

    fn response_headers(response: &[u8]) -> String {
        let Some(index) = find_header_end(response) else {
            panic!("response did not contain HTTP header terminator");
        };
        String::from_utf8_lossy(&response[..index]).into_owned()
    }

    fn response_body(response: &[u8]) -> &[u8] {
        let Some(index) = find_header_end(response) else {
            panic!("response did not contain HTTP header terminator");
        };
        &response[index + 4..]
    }

    fn find_header_end(response: &[u8]) -> Option<usize> {
        response.windows(4).position(|window| window == b"\r\n\r\n")
    }

    fn decode_chunked_body(bytes: &[u8]) -> Vec<u8> {
        let mut output = Vec::new();
        let mut cursor = 0;

        loop {
            let line_end = bytes[cursor..]
                .windows(2)
                .position(|window| window == b"\r\n")
                .map(|offset| cursor + offset)
                .expect("chunk size line");
            let size_text = std::str::from_utf8(&bytes[cursor..line_end]).expect("chunk size utf8");
            let size = usize::from_str_radix(size_text.trim(), 16).expect("chunk size hex");
            cursor = line_end + 2;
            if size == 0 {
                break;
            }
            output.extend_from_slice(&bytes[cursor..cursor + size]);
            cursor += size + 2;
        }

        output
    }

    fn gunzip_to_string(bytes: &[u8]) -> String {
        let mut decoder = GzDecoder::new(bytes);
        let mut output = String::new();
        decoder.read_to_string(&mut output).unwrap();
        output
    }

    #[test]
    fn accept_encoding_parser_respects_gzip_quality() {
        assert!(client_accepts_gzip(
            "GET / HTTP/1.1\r\nAccept-Encoding: br, gzip;q=0.8\r\n\r\n"
        ));
        assert!(client_accepts_gzip(
            "GET / HTTP/1.1\r\nAccept-Encoding: *;q=0.5\r\n\r\n"
        ));
        assert!(!client_accepts_gzip(
            "GET / HTTP/1.1\r\nAccept-Encoding: gzip;q=0, *;q=1\r\n\r\n"
        ));
        assert!(!client_accepts_gzip(
            "GET / HTTP/1.1\r\nAccept-Encoding: br, identity\r\n\r\n"
        ));
    }

    #[test]
    fn serves_static_dynamic_and_manifest_routes() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        write(&app.join("page.tsx"), "export default function Page() {}");
        write(
            &app.join("posts/[id]/page.tsx"),
            "export default function Post() {}",
        );
        let mut project = project_for(&app);

        let home = project.handle_get("/").unwrap();
        assert_eq!(home.status, 200);
        assert!(home.body_text().contains("<h1>Home Page</h1>"));

        let post = project.handle_get("/posts/abc").unwrap();
        assert_eq!(post.status, 200);
        let post_body = post.body_text();
        assert!(post_body.contains("data-route-pattern=\"/posts/:id\""));
        assert!(post_body.contains("<title>Post abc</title>"));
        assert!(post_body.contains(r#"<meta name="description" content="Metadata for Post abc">"#));
        assert!(post_body.contains(r#"<meta property="og:title" content="OG Post abc">"#));
        assert!(post_body.contains(r#"<meta property="og:image" content="/og.png">"#));
        assert!(
            post_body.contains(
                r#"<link rel="icon" href="/favicon.svg" type="image/svg+xml" sizes="any">"#
            )
        );
        assert!(
            post_body.contains(r#"<link rel="canonical" href="https://example.com/posts/abc">"#)
        );
        assert!(post_body.contains(
            r#"<link rel="alternate" hreflang="en" href="https://example.com/posts/abc">"#
        ));
        assert!(post_body.contains("<h1>Post abc</h1>"));
        assert!(post_body.contains(r#"<link rel="stylesheet" href="/_ferrite/static/"#));
        assert!(post_body.contains(r#"<script type="module" src="/_ferrite/static/"#));

        let routes = project.handle_get("/__ferrite/routes").unwrap();
        assert_eq!(routes.status, 200);
        assert!(routes.body_text().contains("\"/posts/:id\""));
    }

    #[test]
    fn dev_adapter_returns_server_payload_for_route_query() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        write(&app.join("page.tsx"), "export default function Page() {}");
        write(
            &app.join("posts/[id]/page.tsx"),
            "export default function Post() {}",
        );
        let mut project = project_for(&app);

        let response = project
            .handle_get("/posts/abc?__ferrite_payload=server")
            .unwrap();

        assert_eq!(response.status, 200);
        assert_eq!(response.content_type, SERVER_PAYLOAD_CONTENT_TYPE);
        assert_eq!(response.stream, None);
        let body = response.body_text();
        assert!(body.contains(r#""ferrite":"server-payload""#));
        assert!(body.contains("Post abc"));
        assert!(!body.contains("<!doctype html>"));
    }

    #[test]
    fn dev_adapter_returns_document_server_payload_for_custom_document() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        write(
            &app.join("document.tsx"),
            "export default function Document() {}",
        );
        write(&app.join("page.tsx"), "export default function Page() {}");
        let mut project = project_for(&app);

        let response = project.handle_get("/?__ferrite_payload=server").unwrap();

        assert_eq!(response.status, 200);
        assert_eq!(response.content_type, SERVER_PAYLOAD_CONTENT_TYPE);
        let body = response.body_text();
        assert!(body.contains(r#""ferrite":"server-payload""#));
        assert!(body.contains(r#""data-document":"dev-test""#));
        assert!(body.contains("ferrite-dev-root"));
        assert!(body.contains("Home Page"));
        assert!(!body.contains("<!doctype html>"));
    }

    #[test]
    fn dev_adapter_returns_server_payload_stream_for_route_query() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        write(&app.join("page.tsx"), "export default function Page() {}");
        write(
            &app.join("posts/[id]/page.tsx"),
            "export default function Post() {}",
        );
        let mut project = project_for(&app);

        let response = project
            .handle_get("/posts/abc?__ferrite_payload=stream")
            .unwrap();

        assert_eq!(response.status, 200);
        assert_eq!(response.content_type, SERVER_PAYLOAD_STREAM_CONTENT_TYPE);
        assert!(response.stream.is_some());
        let body = response.body_text();
        assert!(body.contains(r#""ferrite":"server-payload-frame""#));
        assert!(body.contains(r#""kind":"shell""#));
        assert!(body.contains("Post abc"));
        assert!(!body.contains("<!doctype html>"));
    }

    #[test]
    fn dev_adapter_returns_document_server_payload_stream_for_custom_document() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        write(
            &app.join("document.tsx"),
            "export default function Document() {}",
        );
        write(&app.join("page.tsx"), "export default function Page() {}");
        let mut project = project_for(&app);

        let response = project.handle_get("/?__ferrite_payload=stream").unwrap();

        assert_eq!(response.status, 200);
        assert_eq!(response.content_type, SERVER_PAYLOAD_STREAM_CONTENT_TYPE);
        let body = response.body_text();
        assert!(body.contains(r#""ferrite":"server-payload-frame""#));
        assert!(body.contains(r#""kind":"shell""#));
        assert!(body.contains(r#""data-document":"dev-test""#));
        assert!(body.contains("ferrite-dev-root"));
        assert!(body.contains("Home Page"));
        assert!(!body.contains("<!doctype html>"));
    }

    #[test]
    fn production_adapter_returns_server_payload_for_route_query() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        write(&app.join("page.tsx"), "export default function Page() {}");
        write(
            &app.join("posts/[id]/page.tsx"),
            "export default function Post() {}",
        );
        let mut project = production_project_for(&app);

        let response = project
            .handle_get("/posts/abc?__ferrite_payload=server")
            .unwrap();

        assert_eq!(response.status, 200);
        assert_eq!(response.content_type, SERVER_PAYLOAD_CONTENT_TYPE);
        assert_eq!(response.cache_control, Some("no-store"));
        assert_eq!(response.route_pattern_header.as_deref(), Some("/posts/:id"));
        let body = response.body_text();
        assert!(body.contains(r#""ferrite":"server-payload""#));
        assert!(body.contains("Post abc"));
        assert!(!body.contains("/__ferrite/client.js"));
    }

    #[test]
    fn production_adapter_returns_server_payload_stream_for_route_query() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        write(&app.join("page.tsx"), "export default function Page() {}");
        write(
            &app.join("posts/[id]/page.tsx"),
            "export default function Post() {}",
        );
        let mut project = production_project_for(&app);

        let response = project
            .handle_get("/posts/abc?__ferrite_payload=stream")
            .unwrap();

        assert_eq!(response.status, 200);
        assert_eq!(response.content_type, SERVER_PAYLOAD_STREAM_CONTENT_TYPE);
        assert!(response.stream.is_some());
        assert_eq!(response.cache_control, Some("no-store"));
        assert_eq!(response.route_pattern_header.as_deref(), Some("/posts/:id"));
        let body = response.body_text();
        assert!(body.contains(r#""ferrite":"server-payload-frame""#));
        assert!(body.contains(r#""kind":"shell""#));
        assert!(body.contains("Post abc"));
        assert!(!body.contains("/__ferrite/client.js"));
    }

    #[test]
    fn server_payload_query_reports_missing_routes() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        write(&app.join("page.tsx"), "export default function Page() {}");
        let mut project = project_for(&app);

        let response = project
            .handle_get("/missing?__ferrite_payload=server")
            .unwrap();

        assert_eq!(response.status, 404);
        assert!(response.body_text().contains("No Ferrite route matched"));
    }

    #[test]
    fn server_payload_query_rejects_unsupported_values() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        write(&app.join("page.tsx"), "export default function Page() {}");
        let mut project = project_for(&app);

        let response = project.handle_get("/?__ferrite_payload=flight").unwrap();

        assert_eq!(response.status, 400);
        assert!(
            response
                .body_text()
                .contains("unsupported __ferrite_payload")
        );
    }

    #[test]
    fn server_payload_query_reports_render_failures_as_500() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        write(&app.join("page.tsx"), "export default function Page() {}");
        let project = temp.path().to_path_buf();
        let renderer = project.join("render-page.mjs");
        make_script(
            &renderer,
            r#"
if (process.argv[2] === "--server-payload") {
  console.error("payload exploded");
  process.exit(1);
}
process.stdout.write("{}");
"#,
        );
        let mut project = DevProject::new(DevServerConfig::new(
            project.clone(),
            app,
            project.join(".ferrite/types/routes.d.ts"),
            renderer,
            project.join("build-client.mjs"),
            project.join(".ferrite/dev/static"),
            "/_ferrite/static".to_owned(),
        ));

        let response = project.handle_get("/?__ferrite_payload=server").unwrap();

        assert_eq!(response.status, 500);
        assert!(response.body_text().contains("payload exploded"));
    }

    #[test]
    fn serves_server_payload_query_over_real_http() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        write(&app.join("page.tsx"), "export default function Page() {}");
        let project = project_for(&app);
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();

        let server = thread::spawn(move || {
            let mut project = project;
            serve_listener_once(listener, &mut project).unwrap();
        });

        let mut stream = TcpStream::connect(addr).unwrap();
        stream
            .write_all(b"GET /?__ferrite_payload=server HTTP/1.1\r\nHost: localhost\r\n\r\n")
            .unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        server.join().unwrap();

        assert!(response.starts_with("HTTP/1.1 200 OK"));
        assert!(response.contains(&format!("Content-Type: {SERVER_PAYLOAD_CONTENT_TYPE}")));
        assert!(response.contains("Content-Length:"));
        assert!(!response.contains("Transfer-Encoding: chunked"));
        assert!(response.contains(r#""ferrite":"server-payload""#));
    }

    #[test]
    fn serves_server_payload_stream_query_over_real_http() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        write(&app.join("page.tsx"), "export default function Page() {}");
        let project = project_for(&app);
        make_script(
            &temp.path().join("render-page.mjs"),
            r#"
const mode = process.argv[2];
if (mode === "--server-payload") {
  process.stdout.write(JSON.stringify({
    ferrite: "server-payload",
    version: 1,
    shell: [2, "main", {}, [
      [2, "h1", {}, [[0, "Stream shell"]]],
      [2, "div", { "data-ferrite-suspense-boundary": "s0" }, [[0, "Loading"]]]
    ]],
    clientReferences: [],
    chunks: [{ id: "s0", root: [2, "strong", {}, [[0, "Stream chunk"]]], clientReferences: [] }]
  }));
  process.exit(0);
}
process.stdout.write(JSON.stringify({ kind: "text", value: "unexpected" }));
"#,
        );
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();

        let server = thread::spawn(move || {
            let mut project = project;
            serve_listener_once(listener, &mut project).unwrap();
        });

        let mut stream = TcpStream::connect(addr).unwrap();
        stream
            .write_all(b"GET /?__ferrite_payload=stream HTTP/1.1\r\nHost: localhost\r\n\r\n")
            .unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        server.join().unwrap();

        assert!(response.starts_with("HTTP/1.1 200 OK"));
        assert!(response.contains(&format!(
            "Content-Type: {SERVER_PAYLOAD_STREAM_CONTENT_TYPE}"
        )));
        assert!(response.contains("Transfer-Encoding: chunked"));
        assert!(!response.contains("Content-Length:"));
        assert!(response.contains(r#""ferrite":"server-payload-frame""#));
        assert!(response.contains(r#""kind":"shell""#));
        assert!(response.contains(r#""kind":"chunk""#));
        assert!(response.contains("Stream shell"));
        assert!(response.contains("Stream chunk"));
    }

    #[test]
    fn server_only_client_bundle_keeps_reload_script_but_omits_route_script() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        write(&app.join("page.tsx"), "export default function Page() {}");
        let mut project = project_for(&app);
        make_script(
            &temp.path().join("build-client.mjs"),
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

        let response = project.handle_get("/").unwrap();

        assert_eq!(response.status, 200);
        let body = response.body_text();
        assert!(body.contains(r#"<script type="module" src="/__ferrite/client.js"></script>"#));
        assert!(!body.contains(r#"<link rel="stylesheet" href="/_ferrite/static/"#));
        assert!(!body.contains(r#"<script type="module" src="/_ferrite/static/"#));
    }

    #[test]
    fn document_script_options_include_reload_client_and_optional_route_script() {
        let server_only = ClientBundle {
            script: None,
            styles: Vec::new(),
            outputs: Vec::new(),
            sourcemaps: Vec::new(),
            assets: Vec::new(),
            client_references: Vec::new(),
        };
        assert_eq!(
            dev_document_scripts(&server_only),
            vec!["/__ferrite/client.js"]
        );

        let client_route = ClientBundle {
            script: Some("/_ferrite/static/route-index.js".to_owned()),
            styles: Vec::new(),
            outputs: Vec::new(),
            sourcemaps: Vec::new(),
            assets: Vec::new(),
            client_references: Vec::new(),
        };
        assert_eq!(
            dev_document_scripts(&client_route),
            vec!["/__ferrite/client.js", "/_ferrite/static/route-index.js"]
        );

        let island_route = ClientBundle {
            script: None,
            styles: Vec::new(),
            outputs: Vec::new(),
            sourcemaps: Vec::new(),
            assets: Vec::new(),
            client_references: vec![ferrite_client_bundler::ClientReference {
                id: "app/Counter.tsx#default".to_owned(),
                module: "app/Counter.tsx".to_owned(),
                export_name: "default".to_owned(),
                script: Some(
                    "/_ferrite/static/client-reference-app-Counter-tsx-default.js".to_owned(),
                ),
                styles: vec![
                    "/_ferrite/static/client-reference-app-Counter-tsx-default.css".to_owned(),
                ],
                outputs: Vec::new(),
                sourcemaps: Vec::new(),
                assets: Vec::new(),
            }],
        };
        assert_eq!(
            dev_document_scripts(&island_route),
            vec![
                "/__ferrite/client.js",
                "/_ferrite/static/client-reference-app-Counter-tsx-default.js"
            ]
        );
        assert_eq!(
            client_bundle_styles(&island_route),
            vec!["/_ferrite/static/client-reference-app-Counter-tsx-default.css"]
        );
    }

    #[test]
    fn production_adapter_renders_dynamic_routes_without_dev_reload() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        write(&app.join("page.tsx"), "export default function Page() {}");
        write(
            &app.join("posts/[id]/page.tsx"),
            "export default function Post() {}",
        );
        let mut project = production_project_for(&app);

        let response = project.handle_get("/posts/abc").unwrap();

        assert_eq!(response.status, 200);
        assert_eq!(response.cache_control, Some("no-store"));
        assert_eq!(response.route_pattern_header.as_deref(), Some("/posts/:id"));
        let body = response.body_text();
        assert!(body.contains(r#"id="ferrite-root""#));
        assert!(body.contains(r#"data-route="/posts/abc""#));
        assert!(body.contains(r#"data-route-pattern="/posts/:id""#));
        assert!(body.contains("<title>Post abc</title>"));
        assert!(body.contains("<h1>Post abc</h1>"));
        assert!(body.contains(r#"<script type="module" src="/_ferrite/static/"#));
        let script = body
            .split("src=\"")
            .find_map(|part| part.strip_prefix("/_ferrite/static/"))
            .and_then(|part| part.split('"').next())
            .map(|path| format!("/_ferrite/static/{path}"))
            .expect("client script");
        assert_fingerprinted_public_path(&script, ".js");
        assert!(!body.contains("/__ferrite/client.js"));
        assert!(!body.contains("data-ferrite-build-id"));
        assert!(!body.contains("ferrite-dev-root"));
        assert!(temp.path().join(".ferrite/types/routes.d.ts").is_file());
    }

    #[test]
    fn production_adapter_cleans_stale_static_assets_before_build() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        write(&app.join("page.tsx"), "export default function Page() {}");
        let mut project = production_project_for(&app);
        let stale_file = project
            .config()
            .client_out_dir
            .join("route-index.deadbeefdeadbeef.js");
        write(&stale_file, "console.log('stale');");

        let response = project.handle_get("/").unwrap();

        assert_eq!(response.status, 200);
        assert!(!stale_file.exists());
    }

    #[test]
    fn static_asset_cache_control_is_hash_aware() {
        assert_eq!(
            static_asset_cache_control("/_ferrite/static/route-index.0123456789abcdef.js"),
            "public, max-age=31536000, immutable"
        );
        assert_eq!(
            static_asset_cache_control("/_ferrite/static/assets/logo-2WMCNJ6H.png"),
            "public, max-age=31536000, immutable"
        );
        assert_eq!(
            static_asset_cache_control("/_ferrite/static/route-index.js"),
            "public, max-age=0, must-revalidate"
        );
        assert_eq!(
            static_asset_cache_control("/_ferrite/static/admin-bundle.js"),
            "public, max-age=0, must-revalidate"
        );
    }

    #[test]
    fn production_adapter_serves_generated_client_assets() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        write(&app.join("page.tsx"), "export default function Page() {}");
        let mut project = production_project_for(&app);

        let html = project.handle_get("/").unwrap();
        let html_body = html.body_text();
        let script = html_body
            .split("src=\"")
            .find_map(|part| part.strip_prefix("/_ferrite/static/"))
            .and_then(|part| part.split('"').next())
            .map(|path| format!("/_ferrite/static/{path}"))
            .expect("client script");
        assert_fingerprinted_public_path(&script, ".js");
        let response = project.handle_get(&script).unwrap();

        assert_eq!(response.status, 200);
        assert_eq!(response.content_type, "text/javascript; charset=utf-8");
        assert_eq!(
            response.cache_control,
            Some("public, max-age=31536000, immutable")
        );
        assert_eq!(response.route_pattern_header, None);
        assert!(response.body_text().contains("console.log('client')"));

        let unhashed = project.config().client_out_dir.join("manual.js");
        write(&unhashed, "console.log('manual');");
        let unhashed_response = project.handle_get("/_ferrite/static/manual.js").unwrap();
        assert_eq!(unhashed_response.status, 200);
        assert_eq!(
            unhashed_response.cache_control,
            Some("public, max-age=0, must-revalidate")
        );
    }

    #[test]
    fn production_adapter_streams_suspense_chunks_over_chunked_http() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        write(&app.join("page.tsx"), "export default function Page() {}");
        let project = production_project_for(&app);
        make_script(
            &temp.path().join("render-page.mjs"),
            r#"
const mode = process.argv[2];
if (mode === "--metadata") {
  process.stdout.write(JSON.stringify({ title: "Home Page", description: "Metadata for Home Page" }));
  process.exit(0);
}
if (mode === "--stream") {
  process.stdout.write(JSON.stringify({
    ferrite: "render-stream",
    version: 1,
    shell: [2, "main", { "data-shell": "production" }, [[0, "Production shell"]]],
    chunks: [{ id: "s0", root: [2, "strong", {}, [[0, "Production chunk"]]] }]
  }));
  process.exit(0);
}
process.stdout.write(JSON.stringify({ kind: "text", value: "unexpected non-stream render" }));
"#,
        );
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();

        let server = thread::spawn(move || {
            let mut project = project;
            serve_production_listener_once(listener, &mut project).unwrap();
        });

        let mut stream = TcpStream::connect(addr).unwrap();
        stream
            .write_all(b"GET / HTTP/1.1\r\nHost: localhost\r\n\r\n")
            .unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        server.join().unwrap();

        assert!(response.starts_with("HTTP/1.1 200 OK"));
        assert!(response.contains("Transfer-Encoding: chunked"));
        assert!(response.contains("Cache-Control: no-store"));
        assert!(response.contains("X-Ferrite-Route-Pattern: /"));
        assert!(!response.contains("Content-Length:"));
        assert!(response.contains("Production shell"));
        assert!(response.contains("Production chunk"));
        assert!(!response.contains("/__ferrite/client.js"));
        assert!(response.ends_with("0\r\n\r\n"));
    }

    #[test]
    fn production_adapter_compresses_html_when_gzip_is_accepted() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        write(&app.join("page.tsx"), "export default function Page() {}");
        let project = production_project_for(&app);

        let response = production_http_request(
            project,
            b"GET / HTTP/1.1\r\nHost: localhost\r\nAccept-Encoding: gzip\r\n\r\n",
        );
        let headers = response_headers(&response);
        let body = gunzip_to_string(response_body(&response));

        assert!(headers.starts_with("HTTP/1.1 200 OK"));
        assert!(headers.contains("Content-Type: text/html; charset=utf-8"));
        assert!(headers.contains("Content-Encoding: gzip"));
        assert!(headers.contains("Vary: Accept-Encoding"));
        assert!(headers.contains("Content-Length:"));
        assert!(!headers.contains("Transfer-Encoding: chunked"));
        assert!(body.contains("<h1>Home Page</h1>"));
        assert!(!body.contains("/__ferrite/client.js"));
    }

    #[test]
    fn production_adapter_keeps_html_uncompressed_without_gzip_support() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        write(&app.join("page.tsx"), "export default function Page() {}");
        let project = production_project_for(&app);

        let response = production_http_request(
            project,
            b"GET / HTTP/1.1\r\nHost: localhost\r\nAccept-Encoding: br, identity\r\n\r\n",
        );
        let headers = response_headers(&response);
        let body = String::from_utf8_lossy(response_body(&response));

        assert!(headers.starts_with("HTTP/1.1 200 OK"));
        assert!(!headers.contains("Content-Encoding: gzip"));
        assert!(!headers.contains("Vary: Accept-Encoding"));
        assert!(headers.contains("Content-Length:"));
        assert!(!headers.contains("Transfer-Encoding: chunked"));
        assert!(body.contains("<h1>Home Page</h1>"));
    }

    #[test]
    fn production_adapter_compresses_server_payload_json() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        write(&app.join("page.tsx"), "export default function Page() {}");
        let project = production_project_for(&app);

        let response = production_http_request(
            project,
            b"GET /?__ferrite_payload=server HTTP/1.1\r\nHost: localhost\r\nAccept-Encoding: gzip;q=1\r\n\r\n",
        );
        let headers = response_headers(&response);
        let body = gunzip_to_string(response_body(&response));

        assert!(headers.starts_with("HTTP/1.1 200 OK"));
        assert!(headers.contains(&format!("Content-Type: {SERVER_PAYLOAD_CONTENT_TYPE}")));
        assert!(headers.contains("Content-Encoding: gzip"));
        assert!(headers.contains("Vary: Accept-Encoding"));
        assert!(headers.contains("Content-Length:"));
        assert!(!headers.contains("Transfer-Encoding: chunked"));
        assert!(body.contains(r#""ferrite":"server-payload""#));
        assert!(body.contains("Home Page"));
    }

    #[test]
    fn production_adapter_compresses_server_payload_frame_streams() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        write(&app.join("page.tsx"), "export default function Page() {}");
        let project = production_project_for(&app);
        make_script(
            &temp.path().join("render-page.mjs"),
            r#"
const mode = process.argv[2];
if (mode === "--server-payload") {
  process.stdout.write(JSON.stringify({
    ferrite: "server-payload",
    version: 1,
    shell: [2, "main", {}, [
      [2, "h1", {}, [[0, "Compressed shell"]]],
      [2, "div", { "data-ferrite-suspense-boundary": "s0" }, [[0, "Loading"]]]
    ]],
    clientReferences: [],
    chunks: [{ id: "s0", root: [2, "strong", {}, [[0, "Compressed chunk"]]], clientReferences: [] }]
  }));
  process.exit(0);
}
process.stdout.write(JSON.stringify({ kind: "text", value: "unexpected" }));
"#,
        );

        let response = production_http_request(
            project,
            b"GET /?__ferrite_payload=stream HTTP/1.1\r\nHost: localhost\r\nAccept-Encoding: gzip, br\r\n\r\n",
        );
        let headers = response_headers(&response);
        let compressed_body = decode_chunked_body(response_body(&response));
        let body = gunzip_to_string(&compressed_body);

        assert!(headers.starts_with("HTTP/1.1 200 OK"));
        assert!(headers.contains(&format!(
            "Content-Type: {SERVER_PAYLOAD_STREAM_CONTENT_TYPE}"
        )));
        assert!(headers.contains("Content-Encoding: gzip"));
        assert!(headers.contains("Vary: Accept-Encoding"));
        assert!(headers.contains("Transfer-Encoding: chunked"));
        assert!(!headers.contains("Content-Length:"));
        assert!(body.contains(r#""ferrite":"server-payload-frame""#));
        assert!(body.contains(r#""kind":"shell""#));
        assert!(body.contains(r#""kind":"chunk""#));
        assert!(body.contains("Compressed shell"));
        assert!(body.contains("Compressed chunk"));
    }

    #[test]
    fn production_adapter_reports_page_render_failures_as_500() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        write(&app.join("page.tsx"), "export default function Page() {}");
        let project = temp.path().to_path_buf();
        let renderer = project.join("render-page.mjs");
        make_script(
            &renderer,
            r#"
console.error("render exploded");
process.exit(1);
"#,
        );
        let mut project = ProductionProject::new(ProductionServerConfig::new(
            project.clone(),
            app,
            project.join(".ferrite/types/routes.d.ts"),
            renderer,
            project.join("build-client.mjs"),
            project.join(".ferrite/server/static"),
            "/_ferrite/static".to_owned(),
        ));

        let response = project.handle_get("/").unwrap();

        assert_eq!(response.status, 500);
        assert_eq!(response.cache_control, Some("no-store"));
        assert_eq!(response.route_pattern_header.as_deref(), Some("/"));
        let body = response.body_text();
        assert!(body.contains("render exploded"));
        assert!(body.contains(r#"id="ferrite-root""#));
        assert!(!body.contains("data-ferrite-build-id"));
    }

    #[test]
    fn rebuilds_when_app_routes_change() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        write(&app.join("page.tsx"), "export default function Page() {}");
        let mut project = project_for(&app);

        let missing = project.handle_get("/about").unwrap();
        assert_eq!(missing.status, 404);
        let first_build = project.build_id().unwrap();

        write(
            &app.join("about/page.tsx"),
            "export default function About() {}",
        );

        let about = project.handle_get("/about").unwrap();
        assert_eq!(about.status, 200);
        assert!(about.body_text().contains("<h1>Home Page</h1>"));
        assert!(project.build_id().unwrap() > first_build);
        assert!(temp.path().join(".ferrite/types/routes.d.ts").is_file());
    }

    #[test]
    fn serves_custom_document_file() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        write(
            &app.join("document.tsx"),
            "export default function Document() {}",
        );
        write(&app.join("page.tsx"), "export default function Page() {}");
        let mut project = project_for(&app);

        let response = project.handle_get("/").unwrap();

        assert_eq!(response.status, 200);
        let body = response.body_text();
        assert!(body.starts_with("<!doctype html>\n<html data-document=\"dev-test\">"));
        assert!(body.contains("<title>Home Page</title>"));
        assert!(body.contains(r#"data-ferrite-build-id="1""#));
        assert!(body.contains(r#"data-route="/""#));
        assert!(body.contains(r#"id="ferrite-dev-root""#));
        assert!(body.contains("<h1>Home Page</h1>"));
    }

    #[test]
    fn passes_route_conventions_to_page_renderer() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        write(&app.join("page.tsx"), "export default function Page() {}");
        write(
            &app.join("loading.tsx"),
            "export default function Loading() {}",
        );
        write(
            &app.join("error.tsx"),
            "export default function ErrorFile() {}",
        );
        let mut project = project_for(&app);
        make_script(
            &temp.path().join("render-page.mjs"),
            r#"
const mode = process.argv[2];
if (mode === "--metadata") {
  process.stdout.write(JSON.stringify({ title: "Home Page", description: "Metadata for Home Page" }));
  process.exit(0);
}
if (mode === "--stream") {
  const conventions = JSON.parse(process.argv[6]);
  process.stdout.write(JSON.stringify({
    ferrite: "render-stream",
    version: 1,
    shell: [2, "main", {}, [[2, "p", {}, [[0, `${conventions.loading.endsWith("loading.tsx")}:${conventions.error.endsWith("error.tsx")}`]]]]],
    chunks: []
  }));
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

        let response = project.handle_get("/").unwrap();

        assert_eq!(response.status, 200);
        assert!(response.body_text().contains("<p>true:true</p>"));
    }

    #[test]
    fn streams_loading_routes_over_chunked_http() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        write(&app.join("page.tsx"), "export default function Page() {}");
        write(
            &app.join("loading.tsx"),
            "export default function Loading() {}",
        );
        let project = project_for(&app);
        make_script(
            &temp.path().join("render-page.mjs"),
            r#"
const mode = process.argv[2];
if (mode === "--metadata") {
  process.stdout.write(JSON.stringify({ title: "Home Page", description: "Metadata for Home Page" }));
  process.exit(0);
}
if (mode === "--stream") {
  process.stdout.write(JSON.stringify({
    ferrite: "render-stream",
    version: 1,
    shell: [2, "main", { "data-shell": "loading" }, [[0, "Loading shell"]]],
    chunks: [{ id: "s0", root: [2, "strong", {}, [[0, "Loaded chunk"]]] }]
  }));
  process.exit(0);
}
process.stdout.write(JSON.stringify({ kind: "text", value: "unexpected non-stream render" }));
"#,
        );
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();

        let server = thread::spawn(move || {
            let mut project = project;
            serve_listener_once(listener, &mut project).unwrap();
        });

        let mut stream = TcpStream::connect(addr).unwrap();
        stream
            .write_all(b"GET / HTTP/1.1\r\nHost: localhost\r\n\r\n")
            .unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        server.join().unwrap();

        assert!(response.starts_with("HTTP/1.1 200 OK"));
        assert!(response.contains("Transfer-Encoding: chunked"));
        assert!(!response.contains("Content-Length:"));
        assert!(response.contains("Loading shell"));
        assert!(response.contains("Loaded chunk"));
        assert!(response.ends_with("0\r\n\r\n"));
    }

    #[test]
    fn streams_inline_suspense_routes_without_loading_file_over_chunked_http() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        write(&app.join("page.tsx"), "export default function Page() {}");
        let project = project_for(&app);
        make_script(
            &temp.path().join("render-page.mjs"),
            r#"
const mode = process.argv[2];
if (mode === "--metadata") {
  process.stdout.write(JSON.stringify({ title: "Home Page", description: "Metadata for Home Page" }));
  process.exit(0);
}
if (mode === "--stream") {
  process.stdout.write(JSON.stringify({
    ferrite: "render-stream",
    version: 1,
    shell: [2, "main", { "data-shell": "inline-suspense" }, [[0, "Inline shell"]]],
    chunks: [{ id: "s0", root: [2, "strong", {}, [[0, "Inline loaded"]]] }]
  }));
  process.exit(0);
}
process.stdout.write(JSON.stringify({ kind: "text", value: "unexpected non-stream render" }));
"#,
        );
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();

        let server = thread::spawn(move || {
            let mut project = project;
            serve_listener_once(listener, &mut project).unwrap();
        });

        let mut stream = TcpStream::connect(addr).unwrap();
        stream
            .write_all(b"GET / HTTP/1.1\r\nHost: localhost\r\n\r\n")
            .unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        server.join().unwrap();

        assert!(response.starts_with("HTTP/1.1 200 OK"));
        assert!(response.contains("Transfer-Encoding: chunked"));
        assert!(response.contains("Inline shell"));
        assert!(response.contains("Inline loaded"));
    }

    #[test]
    fn returns_not_found_for_unknown_route() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        write(&app.join("page.tsx"), "export default function Page() {}");
        let mut project = project_for(&app);

        let response = project.handle_get("/missing").unwrap();

        assert_eq!(response.status, 404);
        assert!(response.body_text().contains("No Ferrite route matched"));
    }

    #[test]
    fn rejects_invalid_request_path() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        write(&app.join("page.tsx"), "export default function Page() {}");
        let mut project = project_for(&app);

        let error = project.handle_get("missing-leading-slash").unwrap_err();

        assert!(matches!(error, DevServerError::InvalidRequestPath(_)));
    }

    #[test]
    fn supports_catch_all_routes() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        write(
            &app.join("docs/[...slug]/page.tsx"),
            "export default function Docs() {}",
        );
        let mut project = project_for(&app);

        let response = project.handle_get("/docs/a/b/c").unwrap();

        assert_eq!(response.status, 200);
        assert!(response.body_text().contains("<h1>Docs a/b/c</h1>"));
    }

    #[test]
    fn supports_optional_catch_all_routes_without_segments() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        write(
            &app.join("docs/[[...slug]]/page.tsx"),
            "export default function Docs() {}",
        );
        let mut project = project_for(&app);

        let response = project.handle_get("/docs").unwrap();

        assert_eq!(response.status, 200);
        assert!(response.body_text().contains("<h1>Docs index</h1>"));
    }

    #[test]
    fn exposes_client_script() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        write(&app.join("page.tsx"), "export default function Page() {}");
        let mut project = project_for(&app);

        let response = project.handle_get("/__ferrite/client.js").unwrap();

        assert_eq!(response.status, 200);
        assert_eq!(response.content_type, "text/javascript; charset=utf-8");
        assert!(response.body_text().contains("/__ferrite/build"));
    }

    #[test]
    fn serves_generated_client_assets() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        write(&app.join("page.tsx"), "export default function Page() {}");
        let mut project = project_for(&app);

        let html = project.handle_get("/").unwrap();
        let html_body = html.body_text();
        let script = html_body
            .split("src=\"")
            .find_map(|part| part.strip_prefix("/_ferrite/static/"))
            .and_then(|part| part.split('"').next())
            .map(|path| format!("/_ferrite/static/{path}"))
            .expect("client script");
        let response = project.handle_get(&script).unwrap();

        assert_eq!(response.status, 200);
        assert_eq!(response.content_type, "text/javascript; charset=utf-8");
        assert!(response.body_text().contains("console.log('client')"));
    }

    #[test]
    fn serves_generated_binary_assets_without_utf8_conversion() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        write(&app.join("page.tsx"), "export default function Page() {}");
        let mut project = project_for(&app);
        let asset = project.config().client_out_dir.join("assets/logo.png");
        fs::create_dir_all(asset.parent().unwrap()).unwrap();
        fs::write(&asset, [0, 159, 255, 10]).unwrap();

        let response = project
            .handle_get("/_ferrite/static/assets/logo.png")
            .unwrap();

        assert_eq!(response.status, 200);
        assert_eq!(response.content_type, "image/png");
        assert_eq!(response.body, vec![0, 159, 255, 10]);
    }

    #[test]
    fn rejects_parent_segments_in_static_asset_paths() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        write(&app.join("page.tsx"), "export default function Page() {}");
        let mut project = project_for(&app);

        let response = project.handle_get("/_ferrite/static/../secret").unwrap();

        assert_eq!(response.status, 400);
        assert!(response.body_text().contains("invalid static asset path"));
    }

    #[test]
    fn reports_page_render_failures_as_500() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        write(&app.join("page.tsx"), "export default function Page() {}");
        let project = temp.path().to_path_buf();
        let renderer = project.join("render-page.mjs");
        make_script(
            &renderer,
            r#"
console.error("render exploded");
process.exit(1);
"#,
        );
        let mut project = DevProject::new(DevServerConfig::new(
            project.clone(),
            app,
            project.join(".ferrite/types/routes.d.ts"),
            renderer,
            project.join("build-client.mjs"),
            project.join(".ferrite/dev/static"),
            "/_ferrite/static".to_owned(),
        ));

        let response = project.handle_get("/").unwrap();

        assert_eq!(response.status, 500);
        assert!(response.body_text().contains("render exploded"));
    }

    #[test]
    fn reports_client_bundle_failures_as_500() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        write(&app.join("page.tsx"), "export default function Page() {}");
        let project = temp.path().to_path_buf();
        let renderer = project.join("render-page.mjs");
        make_script(
            &renderer,
            r#"
if (process.argv[2] === "--metadata") {
  process.stdout.write("{}");
  process.exit(0);
}
if (process.argv[2] === "--stream") {
  process.stdout.write(JSON.stringify({
    ferrite: "render-stream",
    version: 1,
    shell: [0, "ok"],
    chunks: []
  }));
  process.exit(0);
}
process.stdout.write(JSON.stringify({ kind: "text", value: "ok" }));
"#,
        );
        let bundler = project.join("build-client.mjs");
        make_script(
            &bundler,
            r#"
console.error("bundle exploded");
process.exit(1);
"#,
        );
        let mut project = DevProject::new(DevServerConfig::new(
            project.clone(),
            app,
            project.join(".ferrite/types/routes.d.ts"),
            renderer,
            bundler,
            project.join(".ferrite/dev/static"),
            "/_ferrite/static".to_owned(),
        ));

        let response = project.handle_get("/").unwrap();

        assert_eq!(response.status, 500);
        assert!(response.body_text().contains("bundle exploded"));
    }

    #[test]
    fn reports_metadata_failures_as_500() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        write(&app.join("page.tsx"), "export default function Page() {}");
        let project = temp.path().to_path_buf();
        let renderer = project.join("render-page.mjs");
        make_script(
            &renderer,
            r#"
if (process.argv[2] === "--metadata") {
  console.error("metadata exploded");
  process.exit(1);
}
if (process.argv[2] === "--stream") {
  process.stdout.write(JSON.stringify({
    ferrite: "render-stream",
    version: 1,
    shell: [0, "ok"],
    chunks: []
  }));
  process.exit(0);
}
process.stdout.write(JSON.stringify({ kind: "text", value: "ok" }));
"#,
        );
        let bundler = project.join("build-client.mjs");
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
        let mut project = DevProject::new(DevServerConfig::new(
            project.clone(),
            app,
            project.join(".ferrite/types/routes.d.ts"),
            renderer,
            bundler,
            project.join(".ferrite/dev/static"),
            "/_ferrite/static".to_owned(),
        ));

        let response = project.handle_get("/").unwrap();

        assert_eq!(response.status, 500);
        assert!(response.body_text().contains("metadata exploded"));
    }

    #[test]
    fn serves_one_real_http_request() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("app");
        write(&app.join("page.tsx"), "export default function Page() {}");
        let project = project_for(&app);
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();

        let server = thread::spawn(move || {
            let mut project = project;
            serve_listener_once(listener, &mut project).unwrap();
        });

        let mut stream = TcpStream::connect(addr).unwrap();
        stream
            .write_all(b"GET / HTTP/1.1\r\nHost: localhost\r\n\r\n")
            .unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        server.join().unwrap();

        assert!(response.starts_with("HTTP/1.1 200 OK"));
        assert!(response.contains("Content-Length:"));
        assert!(!response.contains("Transfer-Encoding: chunked"));
        assert!(response.contains("<h1>Home Page</h1>"));
    }
}
